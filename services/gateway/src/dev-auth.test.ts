import { SignJWT, UnsecuredJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { AuthError, issueDevToken, verifyDevToken } from './dev-auth.js';

const secret = 'a-development-secret-of-32-chars!';
const other = 'another-development-secret-32-chr';
const userId = '0199f2e0-0000-7000-8000-000000000001';
const now = new Date('2026-10-22T03:00:00.000Z');

const reason = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (err) {
    if (err instanceof AuthError) return err.reason;
    throw err;
  }
  throw new Error('expected an AuthError');
};

/** A token like ours but with chosen parts, to check each verification rule. */
const forge = (opts: {
  alg?: string;
  key?: string;
  claims?: Record<string, unknown>;
  iss?: string;
  aud?: string;
}) =>
  new SignJWT({ roles: ['admin'], ...opts.claims })
    .setProtectedHeader({ alg: opts.alg ?? 'HS256' })
    .setSubject(userId)
    .setIssuer(opts.iss ?? 'sagamart-gateway-dev')
    .setAudience(opts.aud ?? 'sagamart')
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor(now.getTime() / 1000) + 3600)
    .sign(new TextEncoder().encode(opts.key ?? secret));

describe('dev tokens', () => {
  it('round-trips the user and role, valid for one hour', async () => {
    const { token, expiresAt } = await issueDevToken({ secret, userId, role: 'admin', now });
    expect(expiresAt).toBe('2026-10-22T04:00:00.000Z');
    expect(await verifyDevToken(token, secret, now)).toEqual({ sub: userId, roles: ['admin'] });
  });

  it('accepts a token until it expires, allowing 5 s of clock skew', async () => {
    const { token } = await issueDevToken({ secret, userId, role: 'buyer', now });
    const at = (s: number) => new Date(now.getTime() + s * 1000);
    expect(await verifyDevToken(token, secret, at(3604))).toEqual({ sub: userId, roles: ['buyer'] });
    expect(await reason(verifyDevToken(token, secret, at(3606)))).toBe('EXPIRED');
  });

  it.each([
    [
      'another secret',
      () => issueDevToken({ secret: other, userId, role: 'admin', now }).then((t) => t.token),
    ],
    ['HS512, even with our secret', () => forge({ alg: 'HS512' })],
    ['another issuer', () => forge({ iss: 'someone-else' })],
    ['another audience', () => forge({ aud: 'other-app' })],
    ['an unknown role', () => forge({ claims: { roles: ['superuser'] } })],
    ['roles that are not a list', () => forge({ claims: { roles: 'admin' } })],
    [
      'no signature (alg none)',
      () => Promise.resolve(new UnsecuredJWT({ roles: ['admin'] }).setSubject(userId).encode()),
    ],
    ['garbage', () => Promise.resolve('not.a.jwt')],
  ])('rejects a token with %s as INVALID', async (_name, make) => {
    expect(await reason(verifyDevToken(await make(), secret, now))).toBe('INVALID');
  });

  it('rejects a token whose subject is not a UUID', async () => {
    const token = await new SignJWT({ roles: ['buyer'] })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('admin')
      .setIssuer('sagamart-gateway-dev')
      .setAudience('sagamart')
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(now.getTime() / 1000) + 3600)
      .sign(new TextEncoder().encode(secret));
    expect(await reason(verifyDevToken(token, secret, now))).toBe('INVALID');
  });
});
