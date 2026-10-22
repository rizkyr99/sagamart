import { ProblemError, problem } from '@sagamart/node-common';

// Cart rules (RFC-0005 §4.3, ADR-0009), pure: the store loads and saves, these decide.

export const MAX_LINES = 50;
export const MAX_QUANTITY = 100;
/** Carts expire 7 days after their last change (FR-04). */
export const TTL_SECONDS = 7 * 24 * 60 * 60;

export interface CartLine {
  quantity: number;
  /** The price when the line was added or its quantity last changed. Checkout re-reads the real one. */
  priceSnapshot: number;
  addedAt: string;
}

/** One DynamoDB item per cart: every line, one version, one TTL (epoch seconds). */
export interface CartState {
  lines: Readonly<Record<string, CartLine>>;
  ttl: number;
}

/** A rule a cart request broke, as the Problem Details the API returns. */
export class CartRuleError extends ProblemError {
  constructor(
    status: number,
    readonly code: string,
    detail: string,
  ) {
    super(problem({ status, code, detail }));
    this.name = 'CartRuleError';
  }
}

export const emptyCart = (): CartState => ({ lines: {}, ttl: 0 });

const expiry = (now: Date): number => Math.floor(now.getTime() / 1000) + TTL_SECONDS;

/** Sets a line's quantity, adding it if needed; 0 removes it. Every write refreshes the whole cart's TTL. */
export function setLine(cart: CartState, sku: string, quantity: number, price: number, now: Date): CartState {
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_QUANTITY) {
    throw new CartRuleError(
      400,
      'VALIDATION_FAILED',
      `Quantity must be a whole number from 0 to ${String(MAX_QUANTITY)}.`,
    );
  }
  if (quantity === 0) return removeLine(cart, sku, now);
  const existing = cart.lines[sku];
  if (!existing && Object.keys(cart.lines).length >= MAX_LINES) {
    throw new CartRuleError(422, 'CART_LINE_LIMIT', `A cart holds at most ${String(MAX_LINES)} lines.`);
  }
  return {
    lines: {
      ...cart.lines,
      [sku]: { quantity, priceSnapshot: price, addedAt: existing?.addedAt ?? now.toISOString() },
    },
    ttl: expiry(now),
  };
}

export function removeLine(cart: CartState, sku: string, now: Date): CartState {
  const lines = Object.fromEntries(Object.entries(cart.lines).filter(([key]) => key !== sku));
  return { lines, ttl: expiry(now) };
}

export const isExpired = (cart: CartState, now: Date): boolean =>
  cart.ttl <= Math.floor(now.getTime() / 1000);

/** What Catalog says about a SKU now; `price` is null when the SKU or its product is no longer active. */
export interface SkuInfo {
  productSlug: string;
  productName: string;
  skuName: string;
  price: number | null;
}

interface Money {
  amount: number;
  currency: 'IDR';
}
const idr = (amount: number): Money => ({ amount, currency: 'IDR' });

export interface CartView {
  lines: {
    sku: string;
    productSlug: string;
    productName: string;
    skuName: string;
    quantity: number;
    priceSnapshot: Money;
    price: Money | null;
    priceChanged: boolean;
  }[];
  lineCount: number;
  total: Money;
  expiresAt: string | null;
}

/** The cart as the contract shows it: current prices, changed-price flags and a total at current prices. */
export function view(cart: CartState, skus: ReadonlyMap<string, SkuInfo>, now: Date): CartView {
  // DynamoDB deletes expired items lazily, so an expired cart can still be read: it is empty.
  const live = isExpired(cart, now) ? emptyCart() : cart;
  const lines = Object.entries(live.lines)
    .sort(([a, x], [b, y]) => x.addedAt.localeCompare(y.addedAt) || a.localeCompare(b))
    .flatMap(([sku, line]) => {
      const info = skus.get(sku);
      // Lines are only added for SKUs Catalog knows, and SKUs are archived, never deleted.
      if (!info) return [];
      return [
        {
          sku,
          productSlug: info.productSlug,
          productName: info.productName,
          skuName: info.skuName,
          quantity: line.quantity,
          priceSnapshot: idr(line.priceSnapshot),
          price: info.price === null ? null : idr(info.price),
          priceChanged: info.price !== null && info.price !== line.priceSnapshot,
        },
      ];
    });
  return {
    lines,
    lineCount: lines.length,
    total: idr(lines.reduce((sum, l) => sum + (l.price ? l.price.amount * l.quantity : 0), 0)),
    expiresAt:
      lines.length > 0 || Object.keys(live.lines).length > 0 ? new Date(live.ttl * 1000).toISOString() : null,
  };
}

/** `user:<id>` carts belong to that user; a `guest:<hash>` key is itself the capability (RFC-0005 §8). */
export function authorizeCartKey(cartKey: string, sub: string | undefined): void {
  if (cartKey.startsWith('user:') && cartKey !== `user:${sub ?? ''}`) {
    throw new CartRuleError(403, 'FORBIDDEN', "This is another user's cart.");
  }
}
