import { ProblemError } from '@sagamart/node-common';
import { describe, expect, it } from 'vitest';
import { parseIdempotencyKey, parseIfMatch, requestHash } from './preconditions.js';

const problemOf = (work: () => unknown): ProblemError['problem'] => {
  try {
    work();
  } catch (err) {
    if (err instanceof ProblemError) return err.problem;
    throw err;
  }
  throw new Error('expected a ProblemError');
};

describe('parseIfMatch', () => {
  it('reads the version from a strong ETag', () => {
    expect(parseIfMatch('"3"')).toBe(3);
  });

  it('is 428 IF_MATCH_REQUIRED when absent', () => {
    expect(problemOf(() => parseIfMatch(undefined))).toMatchObject({
      status: 428,
      code: 'IF_MATCH_REQUIRED',
    });
  });

  it.each(['3', 'W/"3"', '"0"', '"-1"', '"3", "4"', '*', '"99999999999"'])(
    'rejects %s as 400 VALIDATION_FAILED on If-Match',
    (header) => {
      expect(problemOf(() => parseIfMatch(header))).toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
        errors: [{ field: 'If-Match' }],
      });
    },
  );
});

describe('parseIdempotencyKey', () => {
  it('accepts the contract pattern', () => {
    expect(parseIdempotencyKey('create-kaos:2026-10-22.1')).toBe('create-kaos:2026-10-22.1');
  });

  it.each([
    ['missing', undefined],
    ['too short', 'abc'],
    ['too long', 'k'.repeat(129)],
    ['with spaces', 'not a key!'],
  ])('rejects a key that is %s as 400 VALIDATION_FAILED', (_name, header) => {
    expect(problemOf(() => parseIdempotencyKey(header))).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      errors: [{ field: 'Idempotency-Key' }],
    });
  });
});

describe('requestHash', () => {
  const body = { slug: 'kaos', skus: [{ sku: 'A', price: { amount: 1, currency: 'IDR' } }] };

  it('ignores key order at every depth', () => {
    const reordered = { skus: [{ price: { currency: 'IDR', amount: 1 }, sku: 'A' }], slug: 'kaos' };
    expect(requestHash('POST', '/p', reordered)).toBe(requestHash('POST', '/p', body));
  });

  it.each([
    ['the method', 'PUT', '/p', body],
    ['the path', 'POST', '/q', body],
    ['array order', 'POST', '/p', { ...body, skus: [...body.skus, { sku: 'B' }] }],
    ['a value', 'POST', '/p', { ...body, slug: 'topi' }],
    ['a number versus a string', 'POST', '/p', { ...body, slug: 1 }],
  ])('changes with %s', (_name, method, path, other) => {
    expect(requestHash(method, path, other)).not.toBe(requestHash('POST', '/p', body));
  });

  it('is SHA-256 hex', () => {
    expect(requestHash('POST', '/p', body)).toMatch(/^[0-9a-f]{64}$/);
  });
});
