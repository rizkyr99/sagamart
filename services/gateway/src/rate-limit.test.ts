import { describe, expect, it, vi } from 'vitest';
import { RateLimiter, bucketKey } from './rate-limit.js';
import type { BucketClient } from './rate-limit.js';

const limits = { perSecond: 20, burst: 40 };
const client = (take: BucketClient['takeToken']): BucketClient => ({ takeToken: take });

describe('bucketKey', () => {
  it('limits signed-in callers per user and everyone else per IP', () => {
    expect(bucketKey({ sub: 'u-1', roles: ['buyer'] }, '10.0.0.1')).toBe('rl:user:u-1');
    expect(bucketKey({ roles: [] }, '10.0.0.1')).toBe('rl:ip:10.0.0.1');
  });
});

describe('RateLimiter', () => {
  it('passes the bucket parameters to Redis and allows when a token was taken', async () => {
    const take = vi.fn<BucketClient['takeToken']>().mockResolvedValue([1, 0]);
    const decision = await new RateLimiter(client(take), limits).take('rl:ip:1');
    expect(decision).toEqual({ allowed: true });
    expect(take).toHaveBeenCalledWith('rl:ip:1', 20, 40);
  });

  it('refuses with Retry-After in whole seconds, at least 1', async () => {
    const limiter = new RateLimiter(
      client(() => Promise.resolve([0, 49])),
      limits,
    );
    expect(await limiter.take('k')).toEqual({ allowed: false, retryAfterSeconds: 1 });
    const slow = new RateLimiter(
      client(() => Promise.resolve([0, 2_300])),
      limits,
    );
    expect(await slow.take('k')).toEqual({ allowed: false, retryAfterSeconds: 3 });
  });

  it('fails open when Redis errors or times out: rate limiting must never take the API down', async () => {
    const down = new RateLimiter(
      client(() => Promise.reject(new Error('Command timed out'))),
      limits,
    );
    expect(await down.take('k')).toEqual({ allowed: true, failedOpen: true });
  });

  it('fails open on a reply it does not understand', async () => {
    const odd = new RateLimiter(
      client(() => Promise.resolve(['x'] as unknown as [number, number])),
      limits,
    );
    expect(await odd.take('k')).toEqual({ allowed: true, failedOpen: true });
  });
});
