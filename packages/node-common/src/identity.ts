// The x-sagamart-identity token (contracts/identity.md): an EdDSA (Ed25519) JWS the gateway signs and every
// service verifies. Implemented on node:crypto so every rule in the contract is explicit here.

export const IDENTITY_HEADER = 'x-sagamart-identity';
export const IDENTITY_TYPE = 'sagamart-identity+jwt';

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

/** Signs an identity valid for 60 seconds. Gateway only. */
export function signIdentity(_options: SignOptions): string {
  throw new Error('not implemented');
}

/** Verifies a token per contracts/identity.md; throws IdentityError with the reason. */
export function verifyIdentity(_token: string, _options: VerifyOptions): IdentityClaims {
  throw new Error('not implemented');
}

/** True when the identity carries `role`. */
export function hasRole(claims: IdentityClaims, role: string): boolean {
  return claims.roles.includes(role);
}
