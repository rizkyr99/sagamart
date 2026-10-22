import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from './circuit-breaker.js';

const make = () => {
  let now = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 3, openMs: 10_000, now: () => now });
  return { breaker, advance: (ms: number) => (now += ms) };
};

describe('CircuitBreaker', () => {
  it('stays closed through failures below the threshold, and a success resets the count', () => {
    const { breaker } = make();
    breaker.failure();
    breaker.failure();
    breaker.success();
    breaker.failure();
    breaker.failure();
    expect(breaker.state()).toBe('closed');
    expect(breaker.allow()).toEqual({ allowed: true });
  });

  it('opens after consecutive failures and refuses calls, saying when to retry', () => {
    const { breaker, advance } = make();
    for (let i = 0; i < 3; i++) breaker.failure();
    expect(breaker.state()).toBe('open');
    expect(breaker.allow()).toEqual({ allowed: false, retryAfterMs: 10_000 });
    advance(4_000);
    expect(breaker.allow()).toEqual({ allowed: false, retryAfterMs: 6_000 });
  });

  it('half-opens after the open period and lets exactly one trial call through', () => {
    const { breaker, advance } = make();
    for (let i = 0; i < 3; i++) breaker.failure();
    advance(10_000);
    expect(breaker.allow()).toEqual({ allowed: true });
    expect(breaker.state()).toBe('half-open');
    expect(breaker.allow()).toMatchObject({ allowed: false });
  });

  it('closes when the trial succeeds', () => {
    const { breaker, advance } = make();
    for (let i = 0; i < 3; i++) breaker.failure();
    advance(10_000);
    breaker.allow();
    breaker.success();
    expect(breaker.state()).toBe('closed');
    expect(breaker.allow()).toEqual({ allowed: true });
  });

  it('re-opens for a full period when the trial fails', () => {
    const { breaker, advance } = make();
    for (let i = 0; i < 3; i++) breaker.failure();
    advance(10_000);
    breaker.allow();
    breaker.failure();
    expect(breaker.state()).toBe('open');
    expect(breaker.allow()).toEqual({ allowed: false, retryAfterMs: 10_000 });
  });
});
