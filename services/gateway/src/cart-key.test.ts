import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cartKeyFor, newGuestToken } from './cart-key.js';

const problemCode = (work: () => unknown): string => {
  try {
    work();
  } catch (err) {
    return (err as { problem: { code: string; status: number } }).problem.code;
  }
  throw new Error('expected a ProblemError');
};

describe('newGuestToken', () => {
  it('is 128 random bits, base64url without padding (contracts: GuestCartToken)', () => {
    const tokens = new Set(Array.from({ length: 1000 }, newGuestToken));
    expect(tokens.size).toBe(1000);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe('cartKeyFor', () => {
  const user = '0199f2e0-0000-7000-8000-000000000001';
  const token = newGuestToken();

  it("uses a signed-in buyer's own cart, whatever token is sent", () => {
    expect(cartKeyFor({ sub: user, roles: ['buyer'] }, token)).toBe(`user:${user}`);
  });

  it('keys a guest cart by the SHA-256 of the token, so the token itself is never stored', () => {
    const hash = createHash('sha256').update(token).digest('hex');
    expect(cartKeyFor({ roles: [] }, token)).toBe(`guest:${hash}`);
  });

  it('needs a token or a signed-in user (401)', () => {
    expect(problemCode(() => cartKeyFor({ roles: [] }, undefined))).toBe('UNAUTHENTICATED');
  });

  it('rejects a token that is not one of ours (400)', () => {
    expect(problemCode(() => cartKeyFor({ roles: [] }, 'short'))).toBe('VALIDATION_FAILED');
  });
});
