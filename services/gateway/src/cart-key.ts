import { createHash, randomBytes } from 'node:crypto';
import { ProblemError, problem } from '@sagamart/node-common';
import type { Caller } from './dev-auth.js';

/** A guest cart token: 128 random bits, base64url (RFC-0005 §8). Issued without writing anything. */
export const newGuestToken = (): string => randomBytes(16).toString('base64url');

const TOKEN = /^[A-Za-z0-9_-]{22}$/;

/**
 * The cart a request is about: a signed-in buyer's own (`user:<id>`), else the guest cart whose token was sent,
 * keyed by the token's SHA-256 so Catalog never stores the capability itself.
 */
export function cartKeyFor(caller: Caller, token: string | undefined): string {
  if (caller.sub !== undefined) return `user:${caller.sub}`;
  if (token === undefined) {
    throw new ProblemError(
      problem({
        status: 401,
        code: 'UNAUTHENTICATED',
        detail: 'Sign in, or send X-Cart-Token from POST /v1/cart/guest-token.',
      }),
    );
  }
  if (!TOKEN.test(token)) {
    throw new ProblemError(
      problem({
        status: 400,
        code: 'VALIDATION_FAILED',
        detail: 'The request is invalid.',
        errors: [{ field: 'X-Cart-Token', message: 'is not a guest cart token' }],
      }),
    );
  }
  return `guest:${createHash('sha256').update(token).digest('hex')}`;
}
