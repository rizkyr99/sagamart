import { generateKeyPairSync, randomUUID, sign as edSign, createPrivateKey } from 'node:crypto';
import { SignJWT, jwtVerify, importSPKI } from 'jose';
import { describe, expect, it } from 'vitest';
import { IdentityError, hasRole, signIdentity, verifyIdentity } from './identity';
import type { IdentityFailure } from './identity';

function keyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

const gateway = keyPair();
const other = keyPair();
const kid = 'gw-test';
const at = new Date('2026-10-22T03:00:00.000Z');
const iat = at.getTime() / 1000;
const userId = '0199f2e0-0000-7000-8000-000000000001';
const verifyOpts = { publicKeys: { [kid]: gateway.publicKey }, audience: 'inventory', now: at };

const b64url = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');

/** Builds a token by hand, so tests can produce what a buggy or hostile issuer would. */
function craft(header: Record<string, unknown>, claims: Record<string, unknown>, privateKey = gateway.privateKey): string {
  const input = `${b64url(header)}.${b64url(claims)}`;
  const key = createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  return `${input}.${edSign(null, Buffer.from(input), key).toString('base64url')}`;
}

const goodHeader = { alg: 'EdDSA', typ: 'sagamart-identity+jwt', kid };
const goodClaims = { iss: 'gateway', aud: 'inventory', sub: userId, roles: ['admin'], iat, exp: iat + 60, jti: randomUUID() };

function failure(fn: () => unknown): IdentityFailure | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof IdentityError) return err.reason;
    throw err;
  }
  return undefined;
}

describe('signIdentity and verifyIdentity', () => {
  it('round-trips an admin identity with the contract claims', () => {
    const token = signIdentity({ privateKey: gateway.privateKey, keyId: kid, audience: 'inventory', subject: userId, roles: ['admin'], now: at });
    const claims = verifyIdentity(token, verifyOpts);
    expect(claims).toMatchObject({ iss: 'gateway', aud: 'inventory', sub: userId, roles: ['admin'], iat, exp: iat + 60 });
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(hasRole(claims, 'admin')).toBe(true);
    expect(hasRole(claims, 'buyer')).toBe(false);
  });

  it('writes the protected header the contract requires', () => {
    const token = signIdentity({ privateKey: gateway.privateKey, keyId: kid, audience: 'catalog', roles: [], now: at });
    const header: unknown = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString());
    expect(header).toEqual({ alg: 'EdDSA', typ: 'sagamart-identity+jwt', kid });
  });

  it('omits sub for guests', () => {
    const token = signIdentity({ privateKey: gateway.privateKey, keyId: kid, audience: 'inventory', roles: [], now: at });
    const claims = verifyIdentity(token, verifyOpts);
    expect(claims.sub).toBeUndefined();
    expect(claims.roles).toEqual([]);
  });

  it('gives every token its own jti', () => {
    const sign = (): string => signIdentity({ privateKey: gateway.privateKey, keyId: kid, audience: 'inventory', roles: [], now: at });
    expect(verifyIdentity(sign(), verifyOpts).jti).not.toBe(verifyIdentity(sign(), verifyOpts).jti);
  });

  it('refuses to sign a non-UUID subject or an empty audience', () => {
    expect(() => signIdentity({ privateKey: gateway.privateKey, keyId: kid, audience: 'inventory', subject: 'bob', roles: [] })).toThrow();
    expect(() => signIdentity({ privateKey: gateway.privateKey, keyId: kid, audience: '', roles: [] })).toThrow();
  });
});

describe('verifyIdentity rejects', () => {
  const at = (seconds: number): Date => new Date((iat + seconds) * 1000);
  const cases: [string, () => unknown, IdentityFailure][] = [
    ['an empty token', () => verifyIdentity('', verifyOpts), 'MALFORMED'],
    ['two segments', () => verifyIdentity('a.b', verifyOpts), 'MALFORMED'],
    ['four segments', () => verifyIdentity('a.b.c.d', verifyOpts), 'MALFORMED'],
    ['a header that is not JSON', () => verifyIdentity(`${Buffer.from('nope').toString('base64url')}.e30.sig`, verifyOpts), 'MALFORMED'],
    ['alg none', () => verifyIdentity(`${b64url({ alg: 'none', typ: 'sagamart-identity+jwt', kid })}.${b64url(goodClaims)}.`, verifyOpts), 'UNSUPPORTED_ALGORITHM'],
    ['alg HS256', () => verifyIdentity(craft({ ...goodHeader, alg: 'HS256' }, goodClaims), verifyOpts), 'UNSUPPORTED_ALGORITHM'],
    ['another token type', () => verifyIdentity(craft({ ...goodHeader, typ: 'JWT' }, goodClaims), verifyOpts), 'WRONG_TYPE'],
    ['an unknown key id', () => verifyIdentity(craft({ ...goodHeader, kid: 'old' }, goodClaims), verifyOpts), 'UNKNOWN_KEY'],
    ['a signature from another key', () => verifyIdentity(craft(goodHeader, goodClaims, other.privateKey), verifyOpts), 'BAD_SIGNATURE'],
    ['a payload changed after signing', () => {
      const [h, , s] = craft(goodHeader, goodClaims).split('.');
      return verifyIdentity(`${h!}.${b64url({ ...goodClaims, roles: ['admin', 'superuser'] })}.${s!}`, verifyOpts);
    }, 'BAD_SIGNATURE'],
    ['another issuer', () => verifyIdentity(craft(goodHeader, { ...goodClaims, iss: 'catalog' }), verifyOpts), 'WRONG_ISSUER'],
    ['another audience', () => verifyIdentity(craft(goodHeader, { ...goodClaims, aud: 'catalog' }), verifyOpts), 'WRONG_AUDIENCE'],
    ['an audience list', () => verifyIdentity(craft(goodHeader, { ...goodClaims, aud: ['inventory'] }), verifyOpts), 'BAD_CLAIMS'],
    ['expiry beyond the 5 s skew', () => verifyIdentity(craft(goodHeader, goodClaims), { ...verifyOpts, now: at(66) }), 'EXPIRED'],
    ['issue time beyond the 5 s skew', () => verifyIdentity(craft(goodHeader, goodClaims), { ...verifyOpts, now: at(-6) }), 'NOT_YET_VALID'],
    ['a non-UUID subject', () => verifyIdentity(craft(goodHeader, { ...goodClaims, sub: 'bob' }), verifyOpts), 'BAD_CLAIMS'],
    ['roles that are not an array of strings', () => verifyIdentity(craft(goodHeader, { ...goodClaims, roles: 'admin' }), verifyOpts), 'BAD_CLAIMS'],
    ['a missing expiry', () => verifyIdentity(craft(goodHeader, { ...goodClaims, exp: undefined }), verifyOpts), 'BAD_CLAIMS'],
  ];
  it.each(cases)('%s', (_name, fn, reason) => {
    expect(failure(fn)).toBe(reason);
  });

  it('accepts tokens within the 5 s clock skew', () => {
    const token = craft(goodHeader, goodClaims);
    expect(failure(() => verifyIdentity(token, { ...verifyOpts, now: at(64) }))).toBeUndefined();
    expect(failure(() => verifyIdentity(token, { ...verifyOpts, now: at(-4) }))).toBeUndefined();
  });

  it('ignores claims it does not know (contract versioning)', () => {
    const claims = verifyIdentity(craft(goodHeader, { ...goodClaims, tenant: 'x' }), verifyOpts);
    expect(claims.sub).toBe(userId);
  });
});

describe('interoperability with jose', () => {
  it('produces tokens a standard JOSE library verifies', async () => {
    const token = signIdentity({ privateKey: gateway.privateKey, keyId: kid, audience: 'catalog', subject: userId, roles: ['buyer'] });
    const pem = `-----BEGIN PUBLIC KEY-----\n${gateway.publicKey}\n-----END PUBLIC KEY-----`;
    const { payload, protectedHeader } = await jwtVerify(token, await importSPKI(pem, 'EdDSA'), {
      issuer: 'gateway', audience: 'catalog', typ: 'sagamart-identity+jwt',
    });
    expect(protectedHeader.kid).toBe(kid);
    expect(payload.sub).toBe(userId);
  });

  it('verifies tokens a standard JOSE library signs', async () => {
    const key = createPrivateKey({ key: Buffer.from(gateway.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
    const token = await new SignJWT({ roles: ['admin'] })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'sagamart-identity+jwt', kid })
      .setIssuer('gateway').setAudience('inventory').setSubject(userId)
      .setIssuedAt().setExpirationTime('60s').setJti(randomUUID())
      .sign(key);
    expect(verifyIdentity(token, { ...verifyOpts, now: new Date() }).roles).toEqual(['admin']);
  });
});
