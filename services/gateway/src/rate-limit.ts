import { metrics } from '@opentelemetry/api';
import type { Redis } from 'ioredis';
import type { Caller } from './dev-auth.js';

/**
 * Token bucket, atomic in Redis and on Redis's clock (so every gateway instance agrees). The bucket holds up to
 * `burst` tokens and refills `rate` per second; each request takes one. Returns {allowed, ms until a token}.
 */
export const TAKE_TOKEN_LUA = `
local now_parts = redis.call('TIME')
local now = tonumber(now_parts[1]) * 1000 + math.floor(tonumber(now_parts[2]) / 1000)
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(bucket[1]) or burst
local ts = tonumber(bucket[2]) or now
tokens = math.min(burst, tokens + math.max(0, now - ts) * rate / 1000)
local allowed = 0
local wait = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  wait = math.ceil((1 - tokens) * 1000 / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(burst * 1000 / rate) + 1000)
return {allowed, wait}
`;

/** The one Redis command the limiter needs, so tests can stand in for Redis. */
export interface BucketClient {
  takeToken(key: string, perSecond: number, burst: number): Promise<[number, number]>;
}

/** Wraps ioredis: registers the script once; ioredis runs it by SHA and reloads it if Redis restarted. */
export function bucketClient(redis: Redis): BucketClient {
  redis.defineCommand('sagamartTakeToken', { numberOfKeys: 1, lua: TAKE_TOKEN_LUA });
  const run = (redis as unknown as Record<string, (...args: unknown[]) => Promise<[number, number]>>)
    .sagamartTakeToken;
  if (!run) throw new Error('ioredis did not register the token-bucket command');
  return { takeToken: (key, perSecond, burst) => run.call(redis, key, perSecond, burst) };
}

export type Decision = { allowed: true; failedOpen?: true } | { allowed: false; retryAfterSeconds: number };

/** Signed-in callers are limited per user, everyone else per IP (RFC-0005 §8). */
export const bucketKey = (caller: Caller, ip: string): string =>
  caller.sub === undefined ? `rl:ip:${ip}` : `rl:user:${caller.sub}`;

const meter = metrics.getMeter('@sagamart/gateway');
const limited = meter.createCounter('sagamart.gateway.rate_limited', {
  description: 'Requests refused with 429.',
});
const failedOpen = meter.createCounter('sagamart.gateway.rate_limit_fail_open', {
  description: 'Requests allowed without a rate-limit decision because Redis failed or was too slow.',
});

export class RateLimiter {
  constructor(
    private readonly client: BucketClient,
    private readonly limits: { perSecond: number; burst: number },
  ) {}

  /** Takes a token from `key`'s bucket. Fails open: Redis trouble must never take the API down (RFC-0005 §4.5). */
  async take(key: string): Promise<Decision> {
    let reply: [number, number];
    try {
      reply = await this.client.takeToken(key, this.limits.perSecond, this.limits.burst);
    } catch {
      failedOpen.add(1);
      return { allowed: true, failedOpen: true };
    }
    const [allowed, waitMs] = reply;
    if (typeof allowed !== 'number' || typeof waitMs !== 'number') {
      failedOpen.add(1);
      return { allowed: true, failedOpen: true };
    }
    if (allowed === 1) return { allowed: true };
    limited.add(1);
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
  }
}
