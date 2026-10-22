import { Inject, Injectable, Logger, SetMetadata } from '@nestjs/common';
import type { CanActivate, ExecutionContext, NestMiddleware } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { metrics } from '@opentelemetry/api';
import { ProblemError, problem } from '@sagamart/node-common';
import type { Request, Response } from 'express';
import type { GatewayConfig } from './config.js';
import { Deadline } from './deadline.js';
import { ANONYMOUS, AuthError, verifyDevToken } from './dev-auth.js';
import type { Role } from './dev-auth.js';
import { RateLimiter, bucketKey } from './rate-limit.js';
import { callerOf, setCaller, setDeadline } from './request-context.js';
import { GATEWAY_CONFIG, RATE_LIMITER } from './tokens.js';

const rejections = metrics.getMeter('@sagamart/gateway').createCounter('sagamart.gateway.auth_rejections', {
  description: 'Requests refused with 401, by reason.',
});

const unauthenticated = (detail: string): ProblemError =>
  new ProblemError(problem({ status: 401, code: 'UNAUTHENTICATED', detail }));

/**
 * Starts the request's deadline and works out who is calling: anonymous without an Authorization header, else the
 * user in a valid bearer token. A present but bad token is 401, never silently anonymous.
 */
@Injectable()
export class AuthMiddleware implements NestMiddleware {
  private readonly log = new Logger('AuthMiddleware');

  constructor(@Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig) {}

  async use(request: Request, response: Response, next: () => void): Promise<void> {
    setDeadline(request, Deadline.in(this.config.requestDeadlineMs));
    const header = request.headers.authorization;
    if (header === undefined) {
      setCaller(request, ANONYMOUS);
      next();
      return;
    }
    const match = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header);
    response.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
    if (!match?.[1]) throw this.reject('MALFORMED', 'Send Authorization: Bearer <token>.');
    // Until OIDC (Core complete), development tokens are the only kind; without them, no token can be valid.
    const secret = this.config.devAuth.secret;
    if (!this.config.devAuth.enabled || secret === undefined) {
      throw this.reject('NO_VERIFIER', 'This gateway accepts no bearer tokens yet.');
    }
    try {
      setCaller(request, await verifyDevToken(match[1], secret));
    } catch (err) {
      if (!(err instanceof AuthError)) throw err;
      throw this.reject(
        err.reason,
        err.reason === 'EXPIRED' ? 'The token has expired.' : 'The token is invalid.',
      );
    }
    response.removeHeader('WWW-Authenticate');
    next();
  }

  private reject(reason: string, detail: string): ProblemError {
    rejections.add(1, { reason });
    this.log.warn({ reason }, 'bearer token rejected');
    return unauthenticated(detail);
  }
}

/** Token bucket per user or IP (RFC-0005 §8); 429 with Retry-After when empty, and open if Redis fails. */
@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  constructor(@Inject(RATE_LIMITER) private readonly limiter: RateLimiter) {}

  async use(request: Request, response: Response, next: () => void): Promise<void> {
    const decision = await this.limiter.take(bucketKey(callerOf(request), request.ip ?? 'unknown'));
    if (!decision.allowed) {
      response.setHeader('Retry-After', String(decision.retryAfterSeconds));
      throw new ProblemError(
        problem({
          status: 429,
          code: 'RATE_LIMITED',
          detail: 'Too many requests. Retry after the given delay.',
        }),
      );
    }
    next();
  }
}

export const ROLES_KEY = 'sagamart:roles';

/** Requires one of `roles` (RFC-0005 §8: checked here, and again by the service from the signed identity). */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles?.length) return true;
    const caller = callerOf(context.switchToHttp().getRequest());
    if (caller.sub === undefined) throw unauthenticated('Sign in first.');
    if (!roles.some((role) => caller.roles.includes(role))) {
      throw new ProblemError(
        problem({ status: 403, code: 'FORBIDDEN', detail: `Requires the ${roles.join(' or ')} role.` }),
      );
    }
    return true;
  }
}
