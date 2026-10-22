import { describe, expect, it } from 'vitest';
import { Deadline } from './deadline.js';

describe('Deadline', () => {
  const t0 = 1_000_000;

  it('counts down and never goes below zero', () => {
    const d = Deadline.in(500, t0);
    expect(d.remaining(t0 + 200)).toBe(300);
    expect(d.remaining(t0 + 900)).toBe(0);
    expect(d.expired(t0 + 499)).toBe(false);
    expect(d.expired(t0 + 500)).toBe(true);
  });

  it('caps a call at its own deadline or what the caller has left, whichever is sooner', () => {
    const request = Deadline.in(5_000, t0);
    expect(request.cap(1_000, t0).remaining(t0)).toBe(1_000);
    // Late in the request, the call gets only what is left.
    expect(request.cap(1_000, t0 + 4_800).remaining(t0 + 4_800)).toBe(200);
  });

  it('gives an AbortSignal that fires when the deadline passes', async () => {
    const signal = Deadline.in(20).signal();
    expect(signal.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(signal.aborted).toBe(true);
  });

  it('gives an already-aborted signal once expired, so no call starts', () => {
    expect(Deadline.in(10, t0).signal(t0 + 20).aborted).toBe(true);
  });
});
