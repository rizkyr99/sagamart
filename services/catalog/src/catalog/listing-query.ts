import { z } from 'zod';
import { parse } from '../validation.js';
import { slug } from './fields.js';

export const SORTS = ['newest', 'price_asc', 'price_desc'] as const;
export type Sort = (typeof SORTS)[number];

export interface ListingQuery {
  sort: Sort;
  limit: number;
  category: string | null;
  minPrice: number | null;
  maxPrice: number | null;
  cursor: string | null;
}

/** A query-string integer: digits only, so '', '1e5' and '-1' are refused rather than coerced. */
const digits = (min: number, max: number) =>
  z.string().regex(/^\d+$/, 'must be a whole number').transform(Number).pipe(z.number().min(min).max(max));

const schema = z
  .object({
    sort: z.enum(SORTS).default('newest'),
    limit: digits(1, 50).default(20),
    category: slug.nullable().default(null),
    minPrice: digits(0, Number.MAX_SAFE_INTEGER).nullable().default(null),
    maxPrice: digits(0, Number.MAX_SAFE_INTEGER).nullable().default(null),
    cursor: z.string().max(512).nullable().default(null),
  })
  .superRefine((q, ctx) => {
    if (q.minPrice !== null && q.maxPrice !== null && q.minPrice > q.maxPrice) {
      ctx.addIssue({ code: 'custom', path: ['maxPrice'], message: 'must be at least minPrice' });
    }
  });

/** Parses GET /products' query string (contracts: components/common-v1.yaml parameters). */
export function parseListingQuery(raw: unknown): ListingQuery {
  return parse(schema, raw);
}
