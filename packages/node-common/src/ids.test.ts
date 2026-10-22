import { describe, expect, it } from 'vitest';
import { uuidv7 } from './ids';

describe('uuidv7', () => {
  it('is an RFC 9562 version 7, variant 10 UUID', () => {
    expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('starts with the Unix time in milliseconds, big-endian', () => {
    const ms = Date.UTC(2026, 9, 22, 3, 0, 0, 123);
    const id = uuidv7(ms);
    expect(Number.parseInt(id.replace('-', '').slice(0, 12), 16)).toBe(ms);
  });

  it('sorts by creation time across milliseconds', () => {
    const ids = [3, 1, 2].map((offset) => uuidv7(1_761_100_000_000 + offset));
    expect([...ids].sort()).toEqual([ids[1], ids[2], ids[0]]);
  });

  it('is random within a millisecond', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv7(1_761_100_000_000)));
    expect(ids.size).toBe(1000);
  });

  it('refuses a time that does not fit in 48 bits', () => {
    expect(() => uuidv7(-1)).toThrow(RangeError);
    expect(() => uuidv7(2 ** 48)).toThrow(RangeError);
  });
});
