import { ProblemError } from '@sagamart/node-common';
import { describe, expect, it } from 'vitest';
import { parseListingQuery } from './listing-query.js';

/** The Problem a failed parse throws. */
function problemOf(raw: Record<string, unknown>): ProblemError['problem'] {
  try {
    parseListingQuery(raw);
  } catch (err) {
    if (err instanceof ProblemError) return err.problem;
    throw err;
  }
  throw new Error('expected a validation failure');
}

describe('parseListingQuery', () => {
  it('defaults to the newest 20, unfiltered', () => {
    expect(parseListingQuery({})).toEqual({
      sort: 'newest',
      limit: 20,
      category: null,
      minPrice: null,
      maxPrice: null,
      cursor: null,
    });
  });

  it('reads every parameter from query-string text', () => {
    expect(
      parseListingQuery({
        sort: 'price_desc',
        limit: '50',
        category: 'kaos-pria',
        minPrice: '0',
        maxPrice: '150000',
        cursor: 'abc',
      }),
    ).toEqual({
      sort: 'price_desc',
      limit: 50,
      category: 'kaos-pria',
      minPrice: 0,
      maxPrice: 150_000,
      cursor: 'abc',
    });
  });

  it('ignores parameters it does not know', () => {
    expect(parseListingQuery({ utm_source: 'x' })).toMatchObject({ sort: 'newest' });
  });

  it.each([
    ['limit', { limit: '0' }],
    ['limit', { limit: '51' }],
    ['limit', { limit: '2.5' }],
    ['sort', { sort: 'popular' }],
    ['category', { category: 'Kaos Pria' }],
    ['minPrice', { minPrice: '' }],
    ['minPrice', { minPrice: '-1' }],
    ['minPrice', { minPrice: '1e5' }],
    ['maxPrice', { maxPrice: '9007199254740992' }],
    ['cursor', { cursor: 'x'.repeat(513) }],
    ['category', { category: ['kaos', 'topi'] }],
  ])('rejects a bad %s as 400 VALIDATION_FAILED naming the field', (field, raw) => {
    const p = problemOf(raw);
    expect(p).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(p.errors).toEqual([expect.objectContaining({ field })]);
  });

  it('rejects minPrice above maxPrice, blaming maxPrice', () => {
    const p = problemOf({ minPrice: '200000', maxPrice: '100000' });
    expect(p).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(p.errors).toEqual([{ field: 'maxPrice', message: 'must be at least minPrice' }]);
  });

  it('reports every bad field at once', () => {
    expect(problemOf({ limit: '0', sort: 'popular' }).errors).toHaveLength(2);
  });
});
