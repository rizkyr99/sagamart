import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { CatalogClient } from './catalog-client.js';
import { DEADLINES } from './deadline.js';
import { InventoryClient } from './inventory-client.js';
import { callerOf, deadlineOf } from './request-context.js';
import { productStockStatus, skuStockStatus } from './stock.js';
import type { StockStatus } from './stock.js';

interface Money {
  amount: number;
  currency: 'IDR';
}

/** Catalog's internal shapes (contracts/openapi/catalog-internal-v1.yaml). */
interface InternalSummary {
  skus: string[];
  [field: string]: unknown;
}
interface InternalDetail {
  skus: { sku: string; name: string; price: Money }[];
  [field: string]: unknown;
}

const LIST_PARAMS = ['category', 'minPrice', 'maxPrice', 'sort', 'limit', 'cursor'] as const;

/**
 * Browsing (FR-01, FR-03): Catalog's data plus Inventory's stock, one call per screen for the browser. Stock is a
 * snapshot with a 150 ms budget; without it the page still renders, with UNKNOWN (RFC-0005 §4.4).
 */
@Controller('v1')
export class BrowseController {
  constructor(
    private readonly catalog: CatalogClient,
    private readonly inventory: InventoryClient,
  ) {}

  @Get('categories')
  async categories(@Req() req: unknown): Promise<unknown> {
    return (
      await this.catalog.call({
        method: 'GET',
        path: '/internal/v1/categories',
        caller: callerOf(req),
        deadline: deadlineOf(req).cap(DEADLINES.catalogRead),
      })
    ).body;
  }

  @Get('products')
  async products(@Req() req: unknown, @Query() query: Record<string, unknown>): Promise<unknown> {
    // Catalog validates the values; only known parameters, as single strings, are passed on.
    const forwarded = Object.fromEntries(
      LIST_PARAMS.flatMap((name) => (typeof query[name] === 'string' ? [[name, query[name]]] : [])),
    );
    const caller = callerOf(req);
    const { body } = (await this.catalog.call({
      method: 'GET',
      path: '/internal/v1/products',
      query: forwarded,
      caller,
      deadline: deadlineOf(req).cap(DEADLINES.catalogRead),
    })) as { body: { items: InternalSummary[]; nextCursor: string | null } };
    const stock = await this.inventory.availability(
      body.items.flatMap((p) => p.skus),
      caller,
      deadlineOf(req),
    );
    return {
      items: body.items.map(({ skus, ...product }) => ({
        ...product,
        stockStatus: productStockStatus(skus.map((sku) => skuStockStatus(stock.get(sku) ?? null))),
      })),
      nextCursor: body.nextCursor,
    };
  }

  @Get('products/:slug')
  async product(@Req() req: unknown, @Param('slug') slug: string): Promise<unknown> {
    const caller = callerOf(req);
    const { body } = (await this.catalog.call({
      method: 'GET',
      path: `/internal/v1/products/${encodeURIComponent(slug)}`,
      caller,
      deadline: deadlineOf(req).cap(DEADLINES.catalogRead),
    })) as { body: InternalDetail };
    const stock = await this.inventory.availability(
      body.skus.map((s) => s.sku),
      caller,
      deadlineOf(req),
    );
    const skus = body.skus.map((s) => {
      const available = stock.get(s.sku) ?? null;
      return { ...s, available, stockStatus: skuStockStatus(available) };
    });
    const status: StockStatus = productStockStatus(skus.map((s) => s.stockStatus));
    return { ...body, stockStatus: status, skus };
  }
}
