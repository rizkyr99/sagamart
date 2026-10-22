// The x-sagamart-identity token (contracts/identity.md): an EdDSA (Ed25519) JWS the gateway signs and every
// service verifies. Implemented on node:crypto so every rule in the contract is explicit here.
import { createPrivateKey, createPublicKey, randomUUID, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

export const IDENTITY_HEADER = 'x-sagamart-identity';
export const IDENTITY_TYPE = 'sagamart-identity+jwt';

/** Token lifetime and allowed clock skew, in seconds (contracts/identity.md). */
const TTL_SECONDS = 60;
const SKEW_SECONDS = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IdentityClaims {
  iss: 'gateway';
  aud: string;
  sub?: string;
  roles: string[];
  iat: number;
  exp: number;
  jti: string;
}

export type IdentityFailure =
  | 'MALFORMED'
  | 'UNSUPPORTED_ALGORITHM'
  | 'WRONG_TYPE'
  | 'UNKNOWN_KEY'
  | 'BAD_SIGNATURE'
  | 'WRONG_ISSUER'
  | 'WRONG_AUDIENCE'
  | 'EXPIRED'
  | 'NOT_YET_VALID'
  | 'BAD_CLAIMS';

export class IdentityError extends Error {
  constructor(readonly reason: IdentityFailure) {
    super(`invalid identity: ${reason}`);
    this.name = 'IdentityError';
  }
}

export interface SignOptions {
  /** PKCS#8 DER, base64. */
  privateKey: string;
  keyId: string;
  audience: string;
  subject?: string;
  roles: string[];
  now?: Date;
}

export interface VerifyOptions {
  /** Trusted gateway keys: kid → SPKI DER, base64. */
  publicKeys: Record<string, string>;
  /** This service's own name. */
  audience: string;
  now?: Date;
}

const keys = new Map<string, KeyObject>();

function privateKeyFrom(base64Der: string): KeyObject {
  let key = keys.get(`private:${base64Der}`);
  if (!key) {
    key = createPrivateKey({ key: Buffer.from(base64Der, 'base64'), format: 'der', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('identity private key must be Ed25519');
    keys.set(`private:${base64Der}`, key);
  }
  return key;
}

function publicKeyFrom(base64Der: string): KeyObject {
  let key = keys.get(`public:${base64Der}`);
  if (!key) {
    key = createPublicKey({ key: Buffer.from(base64Der, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('identity public key must be Ed25519');
    keys.set(`public:${base64Der}`, key);
  }
  return key;
}

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

function decodeObject(segment: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new IdentityError('MALFORMED');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new IdentityError('MALFORMED');
  return value as Record<string, unknown>;
}

const seconds = (date: Date): number => Math.floor(date.getTime() / 1000);

/** Signs an identity valid for 60 seconds. Gateway only. */
export function signIdentity(options: SignOptions): string {
  if (!options.audience) throw new Error('identity audience is required');
  if (options.subject !== undefined && !UUID.test(options.subject))
    throw new Error('identity subject must be a UUID');

  const iat = seconds(options.now ?? new Date());
  const claims: IdentityClaims = {
    iss: 'gateway',
    aud: options.audience,
    ...(options.subject === undefined ? {} : { sub: options.subject }),
    roles: [...options.roles],
    iat,
    exp: iat + TTL_SECONDS,
    jti: randomUUID(),
  };
  const input = `${encode({ alg: 'EdDSA', typ: IDENTITY_TYPE, kid: options.keyId })}.${encode(claims)}`;
  const signature = sign(null, Buffer.from(input), privateKeyFrom(options.privateKey));
  return `${input}.${signature.toString('base64url')}`;
}

/** Verifies a token per contracts/identity.md; throws IdentityError with the reason. */
export function verifyIdentity(token: string, options: VerifyOptions): IdentityClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new IdentityError('MALFORMED');
  const [headerPart = '', claimsPart = '', signaturePart = ''] = parts;

  // The algorithm is fixed by the contract, never taken from the token.
  const header = decodeObject(headerPart);
  if (header.alg !== 'EdDSA') throw new IdentityError('UNSUPPORTED_ALGORITHM');
  if (header.typ !== IDENTITY_TYPE) throw new IdentityError('WRONG_TYPE');
  const kid = header.kid;
  if (typeof kid !== 'string' || !Object.hasOwn(options.publicKeys, kid))
    throw new IdentityError('UNKNOWN_KEY');

  // A key that can't be loaded is a configuration error: let it throw loudly rather than look like a bad token.
  const key = publicKeyFrom(options.publicKeys[kid] ?? '');
  let valid: boolean;
  try {
    valid = verify(
      null,
      Buffer.from(`${headerPart}.${claimsPart}`),
      key,
      Buffer.from(signaturePart, 'base64url'),
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new IdentityError('BAD_SIGNATURE');

  const c = decodeObject(claimsPart);
  const { iss, aud, sub, roles, iat, exp, jti } = c;
  if (
    typeof iss !== 'string' ||
    typeof aud !== 'string' ||
    (sub !== undefined && (typeof sub !== 'string' || !UUID.test(sub))) ||
    !Array.isArray(roles) ||
    !roles.every((r): r is string => typeof r === 'string') ||
    typeof iat !== 'number' ||
    typeof exp !== 'number' ||
    typeof jti !== 'string'
  ) {
    throw new IdentityError('BAD_CLAIMS');
  }
  if (iss !== 'gateway') throw new IdentityError('WRONG_ISSUER');
  if (aud !== options.audience) throw new IdentityError('WRONG_AUDIENCE');

  const now = seconds(options.now ?? new Date());
  if (now > exp + SKEW_SECONDS) throw new IdentityError('EXPIRED');
  if (iat > now + SKEW_SECONDS) throw new IdentityError('NOT_YET_VALID');

  return { iss, aud, ...(sub === undefined ? {} : { sub }), roles, iat, exp, jti };
}

/** True when the identity carries `role`. */
export function hasRole(claims: IdentityClaims, role: string): boolean {
  return claims.roles.includes(role);
}
