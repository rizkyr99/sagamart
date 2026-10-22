import { Inject, Injectable, Logger, SetMetadata } from '@nestjs/common';
import type { CanActivate, ExecutionContext, NestMiddleware } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { metrics } from '@opentelemetry/api';
import {
  IDENTITY_HEADER,
  IdentityError,
  ProblemError,
  hasRole,
  problem,
  verifyIdentity,
} from '@sagamart/node-common';
import type { IdentityClaims } from '@sagamart/node-common';
import type { Request, Response } from 'express';
import type { CatalogConfig } from './config.js';
import { CATALOG_CONFIG } from './tokens.js';

export const ROLES_KEY = 'sagamart:roles';
const IDENTITY = Symbol('sagamart:identity');

/** Requires one of `roles` in the caller's verified identity (contracts/identity.md). */
export const Roles = (...roles: string[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);

/** The verified identity of the request; set by IdentityGuard on /internal routes. */
export function identityOf(request: unknown): IdentityClaims {
  const claims = (request as { [IDENTITY]?: IdentityClaims })[IDENTITY];
  if (!claims) throw new Error('no verified identity on this request; is the route under /internal?');
  return claims;
}

const rejections = metrics
  .getMeter('@sagamart/catalog')
  .createCounter('sagamart.catalog.identity_rejections', {
    description: 'Internal requests refused by identity verification, by reason.',
  });

/**
 * Verifies x-sagamart-identity on every /internal request before routing, so an unknown internal path is a 401
 * like any other, never a 404 that reveals which routes exist. Probes and metrics are outside /internal.
 */
@Injectable()
export class IdentityMiddleware implements NestMiddleware {
  private readonly log = new Logger('IdentityMiddleware');

  constructor(@Inject(CATALOG_CONFIG) private readonly config: CatalogConfig) {}

  use(request: Request & { [IDENTITY]?: IdentityClaims }, _response: Response, next: () => void): void {
    const header = request.headers[IDENTITY_HEADER];
    if (typeof header !== 'string' || header === '') throw this.unauthenticated('MISSING');
    try {
      request[IDENTITY] = verifyIdentity(header, {
        publicKeys: this.config.identityPublicKeys,
        audience: 'catalog',
      });
    } catch (err) {
      if (err instanceof IdentityError) throw this.unauthenticated(err.reason);
      throw err; // a misconfigured key: fail loudly, not as the caller's fault
    }
    next();
  }

  private unauthenticated(reason: string): ProblemError {
    rejections.add(1, { reason });
    this.log.warn({ reason }, 'identity rejected');
    return new ProblemError(
      problem({ status: 401, code: 'UNAUTHENTICATED', detail: 'A valid gateway identity is required.' }),
    );
  }
}

/** Enforces @Roles on routes, using the identity IdentityMiddleware verified. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles?.length) return true;
    const claims = identityOf(context.switchToHttp().getRequest());
    if (!roles.some((role) => hasRole(claims, role))) {
      throw new ProblemError(
        problem({ status: 403, code: 'FORBIDDEN', detail: `Requires the ${roles.join(' or ')} role.` }),
      );
    }
    return true;
  }
}
