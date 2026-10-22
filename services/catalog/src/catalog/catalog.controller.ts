import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ProblemError, problem } from '@sagamart/node-common';
import { z } from 'zod';
import { parse } from '../validation.js';
import { CatalogQueries } from './catalog.queries.js';
import type { Category, ProductDetail, ProductSummary, SkuLookupItem } from './catalog.queries.js';
import { CursorError, cursorProblem, decodeCursor, encodeCursor } from './cursor.js';
import type { CursorPosition } from './cursor.js';
import { SLUG, skuCode } from './fields.js';
import { parseListingQuery } from './listing-query.js';

const lookupBody = z.strictObject({
  skus: z
    .array(skuCode)
    .min(1)
    .max(100)
    .refine((skus) => new Set(skus).size === skus.length, 'must not repeat a SKU'),
});

const notFound = (): ProblemError =>
  new ProblemError(problem({ status: 404, code: 'NOT_FOUND', detail: 'No such product.' }));

/** Browsing and price lookups: contracts/openapi/catalog-internal-v1.yaml, tag Catalog. Any valid identity. */
@Controller('internal/v1')
export class CatalogController {
  constructor(private readonly queries: CatalogQueries) {}

  @Get('categories')
  async categories(): Promise<{ items: Category[] }> {
    return { items: await this.queries.categories() };
  }

  @Get('products')
  async products(@Query() raw: unknown): Promise<{ items: ProductSummary[]; nextCursor: string | null }> {
    const q = parseListingQuery(raw);
    // Everything that selects or orders rows; not the page size, so a client may change it between pages.
    const fingerprinted = { sort: q.sort, category: q.category, minPrice: q.minPrice, maxPrice: q.maxPrice };
    let after: CursorPosition | null = null;
    if (q.cursor !== null) {
      try {
        after = decodeCursor(q.cursor, fingerprinted, q.sort === 'newest' ? 'time' : 'price');
      } catch (err) {
        if (err instanceof CursorError) throw cursorProblem(err);
        throw err;
      }
    }

    const rows = await this.queries.listProducts({ ...q, after });
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => r.product),
      nextCursor: rows.length > q.limit && last ? encodeCursor(fingerprinted, last.position) : null,
    };
  }

  @Get('products/:slug')
  async product(@Param('slug') slug: string): Promise<ProductDetail> {
    // A string that can't be a slug can't name a product: 404, as for any other unknown slug.
    if (slug.length > 120 || !SLUG.test(slug)) throw notFound();
    const product = await this.queries.productBySlug(slug);
    if (!product) throw notFound();
    return product;
  }

  // Google-style custom method; the colon is escaped so the router doesn't read it as a parameter.
  @Post('skus\\:lookup')
  @HttpCode(200)
  async lookup(@Body() body: unknown): Promise<{ items: SkuLookupItem[] }> {
    const { skus } = parse(lookupBody, body ?? {});
    return { items: await this.queries.lookupSkus(skus) };
  }
}
