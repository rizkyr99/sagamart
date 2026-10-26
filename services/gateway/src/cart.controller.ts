import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import { cartKeyFor, newGuestToken } from './cart-key.js';
import { CatalogClient } from './catalog-client.js';
import { DEADLINES } from './deadline.js';
import { InventoryClient } from './inventory-client.js';
import type { InternalRequest } from './internal-client.js';
import { callerOf, deadlineOf } from './request-context.js';
import { skuStockStatus } from './stock.js';

interface InternalCart {
  lines: { sku: string; quantity: number; [field: string]: unknown }[];
  [field: string]: unknown;
}

/**
 * Carts (FR-04). Signed-in buyers get their own cart; guests send X-Cart-Token. Catalog owns the cart; the gateway
 * adds availability, so a buyer sees when a line asks for more than is in stock. Nothing is reserved until checkout.
 */
@Controller('v1/cart')
export class CartController {
  constructor(
    private readonly catalog: CatalogClient,
    private readonly inventory: InventoryClient,
  ) {}

  /** Writes nothing: the cart is created by the first PUT with the token, so a lost response costs nothing. */
  @Post('guest-token')
  @HttpCode(201)
  guestToken(): { token: string } {
    return { token: newGuestToken() };
  }

  @Get()
  async get(@Req() req: unknown, @Headers('x-cart-token') token: string | undefined): Promise<unknown> {
    return this.cart(req, token, { method: 'GET', path: '' });
  }

  @Put('lines/:sku')
  async setLine(
    @Req() req: unknown,
    @Headers('x-cart-token') token: string | undefined,
    @Param('sku') sku: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.cart(req, token, {
      method: 'PUT',
      path: `/lines/${encodeURIComponent(sku)}`,
      body: body ?? {},
    });
  }

  @Delete('lines/:sku')
  async removeLine(
    @Req() req: unknown,
    @Headers('x-cart-token') token: string | undefined,
    @Param('sku') sku: string,
  ): Promise<unknown> {
    return this.cart(req, token, { method: 'DELETE', path: `/lines/${encodeURIComponent(sku)}` });
  }

  private async cart(
    req: unknown,
    token: string | undefined,
    call: { method: InternalRequest['method']; path: string; body?: unknown },
  ): Promise<unknown> {
    const caller = callerOf(req);
    const key = cartKeyFor(caller, token);
    const { body } = (await this.catalog.call({
      method: call.method,
      path: `/internal/v1/carts/${key}${call.path}`,
      ...(call.body === undefined ? {} : { body: call.body }),
      caller,
      deadline: deadlineOf(req).cap(call.method === 'GET' ? DEADLINES.catalogRead : DEADLINES.catalogWrite),
    })) as { body: InternalCart };
    const stock = await this.inventory.availability(
      body.lines.map((l) => l.sku),
      caller,
      deadlineOf(req),
    );
    return {
      ...body,
      lines: body.lines.map((line) => {
        const available = stock.get(line.sku) ?? null;
        return {
          ...line,
          available,
          exceedsAvailable: available === null ? null : line.quantity > available,
          stockStatus: skuStockStatus(available),
        };
      }),
    };
  }
}
