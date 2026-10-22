import { Body, Controller, Delete, Get, Param, Put, Req } from '@nestjs/common';
import { ProblemError, problem } from '@sagamart/node-common';
import { z } from 'zod';
import { CatalogQueries } from '../catalog/catalog.queries.js';
import { skuCode } from '../catalog/fields.js';
import { identityOf } from '../identity.js';
import { parse } from '../validation.js';
import { authorizeCartKey, removeLine, setLine, view } from './cart.js';
import type { CartState, CartView, SkuInfo } from './cart.js';
import { CartStore } from './cart.store.js';

const cartKey = z
  .string()
  .regex(
    /^(user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|guest:[0-9a-f]{64})$/,
    'must be user:<uuid> or guest:<sha256 hex>',
  );
const lineBody = z.strictObject({ quantity: z.int().min(0).max(100) });

/** Carts by key: contracts/openapi/catalog-internal-v1.yaml, tag Cart. The gateway maps tokens and users to keys. */
@Controller('internal/v1/carts')
export class CartController {
  constructor(
    private readonly store: CartStore,
    private readonly catalog: CatalogQueries,
  ) {}

  @Get(':cartKey')
  async get(@Param('cartKey') key: string, @Req() req: unknown): Promise<CartView> {
    const k = this.authorized(key, req);
    const now = new Date();
    return this.render((await this.store.load(k, now)).state, now);
  }

  @Put(':cartKey/lines/:sku')
  async setLine(
    @Param('cartKey') key: string,
    @Param('sku') sku: string,
    @Body() body: unknown,
    @Req() req: unknown,
  ): Promise<CartView> {
    const k = this.authorized(key, req);
    const code = parse(z.object({ sku: skuCode }), { sku }).sku;
    const { quantity } = parse(lineBody, body ?? {});
    // The snapshot is Catalog's current price; removing a line needs no price.
    const price = quantity === 0 ? 0 : await this.activePrice(code);
    const cart = await this.store.update(k, (current, now) => setLine(current, code, quantity, price, now));
    return this.render(cart, new Date());
  }

  @Delete(':cartKey/lines/:sku')
  async removeLine(
    @Param('cartKey') key: string,
    @Param('sku') sku: string,
    @Req() req: unknown,
  ): Promise<CartView> {
    const k = this.authorized(key, req);
    const code = parse(z.object({ sku: skuCode }), { sku }).sku;
    const cart = await this.store.update(k, (current, now) => removeLine(current, code, now));
    return this.render(cart, new Date());
  }

  private authorized(key: string, req: unknown): string {
    const k = parse(z.object({ cartKey }), { cartKey: key }).cartKey;
    authorizeCartKey(k, identityOf(req).sub);
    return k;
  }

  private async activePrice(sku: string): Promise<number> {
    const [found] = await this.catalog.lookupSkus([sku]);
    if (found?.status !== 'ACTIVE' || found.productStatus !== 'ACTIVE') {
      throw new ProblemError(
        problem({ status: 404, code: 'SKU_NOT_FOUND', detail: 'This SKU is not for sale.' }),
      );
    }
    return found.price.amount;
  }

  /** The cart with Catalog's current names and prices, read in process (RFC-0005 §4.1). */
  private async render(cart: CartState, now: Date): Promise<CartView> {
    const skus = Object.keys(cart.lines);
    const found = skus.length === 0 ? [] : await this.catalog.lookupSkus(skus);
    const info = new Map<string, SkuInfo>(
      found.map((s) => [
        s.sku,
        {
          productSlug: s.productSlug,
          productName: s.productName,
          skuName: s.name,
          price: s.status === 'ACTIVE' && s.productStatus === 'ACTIVE' ? s.price.amount : null,
        },
      ]),
    );
    return view(cart, info, now);
  }
}
