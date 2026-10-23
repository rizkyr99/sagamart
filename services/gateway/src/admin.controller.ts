import {
  Body,
  Controller,
  Get,
  Headers,
  Logger,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ProblemError } from '@sagamart/node-common';
import type { Response } from 'express';
import { z } from 'zod';
import { Roles } from './auth.js';
import { CatalogClient } from './catalog-client.js';
import { DEADLINES } from './deadline.js';
import type { InternalRequest } from './internal-client.js';
import { InventoryClient } from './inventory-client.js';
import { callerOf, deadlineOf } from './request-context.js';
import { classifyStockError, conflictProblem } from './stock-admin.js';
import { parse } from './validation.js';

const setStock = z.strictObject({
  onHand: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  expectedVersion: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
});
const sku = z.string().min(1).max(64).regex(/^\S+$/, 'must not contain whitespace');

/** Headers an admin write carries through to Catalog, which enforces them (RFC-0005 §4.4). */
interface Forwarded {
  ifMatch?: string | undefined;
  idempotencyKey?: string | undefined;
}

/**
 * Admin (FR-11): product, SKU and category writes go to Catalog, which owns them and enforces If-Match and
 * Idempotency-Key; stock goes to Inventory. The admin role is checked here and again by each service.
 */
@Controller('v1/admin')
@Roles('admin')
export class AdminController {
  private readonly log = new Logger('AdminController');

  constructor(
    private readonly catalog: CatalogClient,
    private readonly inventory: InventoryClient,
  ) {}

  /** Sends the request to Catalog's admin API and relays its status, ETag and body. */
  private async forward(
    req: unknown,
    res: Response,
    call: Pick<InternalRequest, 'method' | 'path' | 'query' | 'body'>,
    headers: Forwarded = {},
  ): Promise<unknown> {
    const response = await this.catalog.call({
      ...call,
      path: `/internal/v1/admin${call.path}`,
      headers: { 'if-match': headers.ifMatch, 'idempotency-key': headers.idempotencyKey },
      caller: callerOf(req),
      deadline: deadlineOf(req).cap(call.method === 'GET' ? DEADLINES.catalogRead : DEADLINES.catalogWrite),
    });
    res.status(response.status);
    const etag = response.headers.get('etag');
    if (etag !== null) res.setHeader('ETag', etag);
    return response.body;
  }

  @Post('categories')
  createCategory(
    @Req() req: unknown,
    @Res({ passthrough: true }) res: Response,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.forward(
      req,
      res,
      { method: 'POST', path: '/categories', body: body ?? {} },
      { idempotencyKey },
    );
  }

  @Patch('categories/:id')
  updateCategory(
    @Req() req: unknown,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    const path = `/categories/${encodeURIComponent(id)}`;
    return this.forward(req, res, { method: 'PATCH', path, body: body ?? {} }, { ifMatch });
  }

  @Get('products')
  listProducts(
    @Req() req: unknown,
    @Res({ passthrough: true }) res: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<unknown> {
    const forwarded = Object.fromEntries(
      ['status', 'limit', 'cursor'].flatMap((name) =>
        typeof query[name] === 'string' ? [[name, query[name]]] : [],
      ),
    );
    return this.forward(req, res, { method: 'GET', path: '/products', query: forwarded });
  }

  @Post('products')
  createProduct(
    @Req() req: unknown,
    @Res({ passthrough: true }) res: Response,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.forward(
      req,
      res,
      { method: 'POST', path: '/products', body: body ?? {} },
      { idempotencyKey },
    );
  }

  @Get('products/:id')
  getProduct(
    @Req() req: unknown,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
  ): Promise<unknown> {
    return this.forward(req, res, { method: 'GET', path: `/products/${encodeURIComponent(id)}` });
  }

  @Patch('products/:id')
  updateProduct(
    @Req() req: unknown,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    const path = `/products/${encodeURIComponent(id)}`;
    return this.forward(req, res, { method: 'PATCH', path, body: body ?? {} }, { ifMatch });
  }

  @Post('products/:id/skus')
  addSku(
    @Req() req: unknown,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    const path = `/products/${encodeURIComponent(id)}/skus`;
    return this.forward(req, res, { method: 'POST', path, body: body ?? {} }, { idempotencyKey });
  }

  @Patch('skus/:sku')
  updateSku(
    @Req() req: unknown,
    @Res({ passthrough: true }) res: Response,
    @Param('sku') code: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    const path = `/skus/${encodeURIComponent(code)}`;
    return this.forward(req, res, { method: 'PATCH', path, body: body ?? {} }, { ifMatch });
  }

  /** FR-11 stock: Inventory's SetStockLevel; its two precondition failures become 409 with the current level. */
  @Put('skus/:sku/stock')
  async setStock(@Req() req: unknown, @Param('sku') code: string, @Body() body: unknown): Promise<unknown> {
    const { sku: valid } = parse(z.object({ sku }), { sku: code });
    const { onHand, expectedVersion } = parse(setStock, body ?? {});
    const caller = callerOf(req);
    const deadline = deadlineOf(req).cap(DEADLINES.inventorySetStock);
    try {
      return await this.inventory.setStockLevel({ sku: valid, onHand, expectedVersion }, caller, deadline);
    } catch (err) {
      const failure = classifyStockError(err);
      if (failure.kind === 'problem') {
        if (failure.problem.status >= 500) this.log.error({ err, sku: valid }, 'SetStockLevel failed');
        throw new ProblemError(failure.problem);
      }
      // Read the level the admin lost to, so they can retry with the right version and quantity.
      let level = null;
      try {
        level = await this.inventory.level(valid, caller, deadline);
      } catch (readErr) {
        this.log.warn({ err: readErr, sku: valid }, 'could not read the current level for a stock conflict');
      }
      throw new ProblemError(conflictProblem(failure.code, valid, level));
    }
  }
}
