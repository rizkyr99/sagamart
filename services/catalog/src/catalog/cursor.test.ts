import { describe, expect, it } from 'vitest';
import { CursorError, decodeCursor, encodeCursor, fingerprint } from './cursor.js';

const query = { sort: 'newest', category: 'kaos', minPrice: 10_000, maxPrice: null };
const id = '0199f2d1-2b3c-7d4e-9f50-6a7b8c9d0e12';
const time = { t: '2026-10-22T03:00:00.123456Z', id };
const price = { p: 79_000, id };

describe('fingerprint', () => {
  it('is a 16-hex-digit SHA-256 prefix', () => {
    expect(fingerprint(query)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('ignores key order', () => {
    expect(fingerprint({ maxPrice: null, minPrice: 10_000, category: 'kaos', sort: 'newest' })).toBe(
      fingerprint(query),
    );
  });

  it.each([
    ['sort', { ...query, sort: 'price_asc' }],
    ['category', { ...query, category: 'topi' }],
    ['a filter added', { ...query, maxPrice: 50_000 }],
    ['a filter removed', { ...query, minPrice: null }],
  ])('changes with %s', (_name, other) => {
    expect(fingerprint(other)).not.toBe(fingerprint(query));
  });

  it('tells a number from the same digits as a string', () => {
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: '1' }));
  });
});

describe('encodeCursor and decodeCursor', () => {
  it('round-trips a time position', () => {
    expect(decodeCursor(encodeCursor(query, time), query, 'time')).toEqual(time);
  });

  it('round-trips a price position', () => {
    const q = { ...query, sort: 'price_desc' };
    expect(decodeCursor(encodeCursor(q, price), q, 'price')).toEqual(price);
  });

  it('is opaque base64url, safe in a query string', () => {
    expect(encodeCursor(query, time)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('keeps microseconds, so rows created in the same millisecond page correctly', () => {
    const decoded = decodeCursor(encodeCursor(query, time), query, 'time');
    expect('t' in decoded && decoded.t).toBe('2026-10-22T03:00:00.123456Z');
  });

  it('rejects a cursor from a different query as MISMATCH', () => {
    const cursor = encodeCursor(query, time);
    expect(() => decodeCursor(cursor, { ...query, category: 'topi' }, 'time')).toThrow(
      expect.objectContaining({ reason: 'MISMATCH' }),
    );
  });

  it('calls a cursor reused with another sort a MISMATCH, though its position has the other shape', () => {
    const cursor = encodeCursor(query, time);
    expect(() => decodeCursor(cursor, { ...query, sort: 'price_asc' }, 'price')).toThrow(
      expect.objectContaining({ reason: 'MISMATCH' }),
    );
  });

  it.each([
    ['not base64url JSON', '!!!'],
    ['JSON that is not an object', Buffer.from('[1,2]').toString('base64url')],
    ['an empty string', ''],
  ])('rejects %s as MALFORMED', (_name, cursor) => {
    expect(() => decodeCursor(cursor, query, 'time')).toThrow(CursorError);
    expect(() => decodeCursor(cursor, query, 'time')).toThrow(
      expect.objectContaining({ reason: 'MALFORMED' }),
    );
  });

  // Hand-made cursors: right fingerprint, wrong position. They must never reach SQL.
  const forge = (body: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify({ q: fingerprint(query), ...body })).toString('base64url');

  it.each([
    ['a price position where a time is expected', { p: 79_000, id }, 'time'],
    ['a time position where a price is expected', { t: time.t, id }, 'price'],
    ['a timestamp without microseconds', { t: '2026-10-22T03:00:00Z', id }, 'time'],
    ['an id that is not a UUID', { t: time.t, id: "x' OR 1=1" }, 'time'],
    ['a fractional price', { p: 1.5, id }, 'price'],
    ['a price beyond safe integers', { p: 2 ** 53, id }, 'price'],
    ['extra members', { t: time.t, id, extra: 1 }, 'time'],
  ] as const)('rejects %s as MALFORMED', (_name, body, kind) => {
    expect(() => decodeCursor(forge(body), query, kind)).toThrow(
      expect.objectContaining({ reason: 'MALFORMED' }),
    );
  });
});
