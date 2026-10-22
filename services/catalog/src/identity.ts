import { SetMetadata } from '@nestjs/common';
import type { IdentityClaims } from '@sagamart/node-common';

export const ROLES_KEY = 'sagamart:roles';

/** Requires one of `roles` in the caller's verified identity (contracts/identity.md). */
export const Roles = (...roles: string[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);

/** The verified identity of the request; set by the identity guard on /internal routes. */
export function identityOf(_request: unknown): IdentityClaims {
  throw new Error('not implemented');
}
