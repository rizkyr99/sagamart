import { SignJWT, errors, jwtVerify } from 'jose';
import { z } from 'zod';

// Development JWTs (RFC-0005 §8): HS256 with GATEWAY_DEV_JWT_SECRET, one hour, role buyer or admin. Only issued and
// accepted when GATEWAY_DEV_AUTH is on, never in prod. Replaced by OIDC at Core complete; the internal identity
// the gateway signs for services does not change.

export const ROLES = ['buyer', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/** Who is calling: a user with roles, or nobody (`sub` absent, no roles) for guests and anonymous browsing. */
export interface Caller {
  sub?: string;
  roles: Role[];
}

export const ANONYMOUS: Caller = { roles: [] };

export class AuthError extends Error {
  constructor(readonly reason: 'INVALID' | 'EXPIRED') {
    super(reason === 'EXPIRED' ? 'token expired' : 'token invalid');
    this.name = 'AuthError';
  }
}

const ISSUER = 'sagamart-gateway-dev';
const AUDIENCE = 'sagamart';
const LIFETIME_SECONDS = 3600;
const SKEW_SECONDS = 5;

const key = (secret: string): Uint8Array => new TextEncoder().encode(secret);
const claims = z.object({ sub: z.uuid(), roles: z.array(z.enum(ROLES)).min(1) });

export async function issueDevToken(opts: {
  secret: string;
  userId: string;
  role: Role;
  now?: Date;
}): Promise<{ token: string; expiresAt: string }> {
  const iat = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const exp = iat + LIFETIME_SECONDS;
  const token = await new SignJWT({ roles: [opts.role] })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(opts.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key(opts.secret));
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

/** Verifies a dev token: HS256 only (never the token's own choice), our issuer and audience, unexpired. */
export async function verifyDevToken(token: string, secret: string, now: Date = new Date()): Promise<Caller> {
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
      currentDate: now,
      clockTolerance: SKEW_SECONDS,
      requiredClaims: ['sub', 'iat', 'exp'],
    });
    const parsed = claims.safeParse(payload);
    if (!parsed.success) throw new AuthError('INVALID');
    return { sub: parsed.data.sub, roles: parsed.data.roles };
  } catch (err) {
    if (err instanceof AuthError) throw err;
    if (err instanceof errors.JWTExpired) throw new AuthError('EXPIRED');
    throw new AuthError('INVALID');
  }
}
