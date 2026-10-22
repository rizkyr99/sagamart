import { describe, expect, it } from 'vitest';
import {
  CartRuleError,
  MAX_LINES,
  TTL_SECONDS,
  authorizeCartKey,
  emptyCart,
  removeLine,
  setLine,
  view,
} from './cart.js';
import type { CartState } from './cart.js';

const now = new Date('2026-10-22T03:00:00.000Z');
const later = new Date('2026-10-23T03:00:00.000Z');
const epoch = (d: Date): number => Math.floor(d.getTime() / 1000);

const withLines = (n: number): CartState => {
  let cart = emptyCart();
  for (let i = 0; i < n; i++) cart = setLine(cart, `SKU-${String(i)}`, 1, 1_000, now);
  return cart;
};

describe('setLine', () => {
  it('adds a line with the current price as its snapshot, and starts the 7-day TTL', () => {
    const cart = setLine(emptyCart(), 'KAOS-M', 2, 79_000, now);
    expect(cart.lines).toEqual({
      'KAOS-M': { quantity: 2, priceSnapshot: 79_000, addedAt: now.toISOString() },
    });
    expect(cart.ttl).toBe(epoch(now) + TTL_SECONDS);
    expect(TTL_SECONDS).toBe(7 * 24 * 3600);
  });

  it('changes a quantity, re-snapshotting the price but keeping when the line was added', () => {
    const first = setLine(emptyCart(), 'KAOS-M', 2, 79_000, now);
    const changed = setLine(first, 'KAOS-M', 5, 85_000, later);
    expect(changed.lines['KAOS-M']).toEqual({
      quantity: 5,
      priceSnapshot: 85_000,
      addedAt: now.toISOString(),
    });
  });

  it('refreshes the TTL of the whole cart on every write', () => {
    const cart = setLine(setLine(emptyCart(), 'A', 1, 1_000, now), 'B', 1, 1_000, later);
    expect(cart.ttl).toBe(epoch(later) + TTL_SECONDS);
  });

  it('removes a line when the quantity is 0', () => {
    const cart = setLine(setLine(emptyCart(), 'A', 1, 1_000, now), 'A', 0, 1_000, later);
    expect(cart.lines).toEqual({});
    expect(cart.ttl).toBe(epoch(later) + TTL_SECONDS);
  });

  it(`allows ${String(MAX_LINES)} lines and refuses a new one beyond that`, () => {
    const full = withLines(MAX_LINES);
    expect(Object.keys(full.lines)).toHaveLength(50);
    expect(() => setLine(full, 'ONE-MORE', 1, 1_000, now)).toThrow(
      expect.objectContaining({ code: 'CART_LINE_LIMIT' }),
    );
    // A full cart can still change or remove its existing lines.
    expect(setLine(full, 'SKU-0', 3, 1_000, now).lines['SKU-0']?.quantity).toBe(3);
    expect(Object.keys(setLine(full, 'SKU-0', 0, 1_000, now).lines)).toHaveLength(49);
  });

  it.each([-1, 101, 1.5, Number.NaN])('refuses quantity %s', (q) => {
    expect(() => setLine(emptyCart(), 'A', q, 1_000, now)).toThrow(CartRuleError);
  });

  it('does not change the cart it was given', () => {
    const cart = setLine(emptyCart(), 'A', 1, 1_000, now);
    setLine(cart, 'B', 1, 1_000, now);
    expect(Object.keys(cart.lines)).toEqual(['A']);
  });
});

describe('removeLine', () => {
  it('removes a line and refreshes the TTL; removing a missing line is fine', () => {
    const cart = removeLine(setLine(emptyCart(), 'A', 1, 1_000, now), 'A', later);
    expect(cart.lines).toEqual({});
    expect(cart.ttl).toBe(epoch(later) + TTL_SECONDS);
    expect(removeLine(cart, 'NOPE', later).lines).toEqual({});
  });
});

describe('view', () => {
  const cart = setLine(
    setLine(setLine(emptyCart(), 'A', 2, 10_000, now), 'B', 1, 5_000, later),
    'C',
    3,
    7_000,
    later,
  );
  const info = (price: number | null) => ({ productSlug: 'p', productName: 'P', skuName: 'S', price });

  it('shows current prices, flags changed ones and totals at current prices', () => {
    const v = view(
      cart,
      new Map([
        ['A', info(10_000)],
        ['B', info(6_000)],
        ['C', info(7_000)],
      ]),
      now,
    );
    expect(v.lines.map((l) => [l.sku, l.priceChanged])).toEqual([
      ['A', false],
      ['B', true],
      ['C', false],
    ]);
    expect(v.lines[1]).toMatchObject({
      quantity: 1,
      priceSnapshot: { amount: 5_000, currency: 'IDR' },
      price: { amount: 6_000, currency: 'IDR' },
    });
    expect(v.total).toEqual({ amount: 2 * 10_000 + 6_000 + 3 * 7_000, currency: 'IDR' });
    expect(v.lineCount).toBe(3);
    expect(v.expiresAt).toBe(new Date(cart.ttl * 1000).toISOString());
  });

  it('shows a line that is no longer for sale with a null price, out of the total', () => {
    const v = view(
      cart,
      new Map([
        ['A', info(10_000)],
        ['B', info(null)],
      ]),
      now,
    );
    const b = v.lines.find((l) => l.sku === 'B');
    expect(b).toMatchObject({ price: null, priceChanged: false });
    // C is unknown to Catalog altogether. SKUs are archived, never deleted, so this can't really happen; skip it.
    expect(v.lines.map((l) => l.sku)).toEqual(['A', 'B']);
    expect(v.total.amount).toBe(20_000);
  });

  it('shows an empty cart with no expiry', () => {
    expect(view(emptyCart(), new Map(), now)).toEqual({
      lines: [],
      lineCount: 0,
      total: { amount: 0, currency: 'IDR' },
      expiresAt: null,
    });
  });

  it('treats an expired cart as empty, because DynamoDB deletes expired items lazily', () => {
    const expired = new Date((cart.ttl + 1) * 1000);
    expect(view(cart, new Map(), expired)).toMatchObject({ lines: [], lineCount: 0, expiresAt: null });
  });

  it('lists lines in the order they were added', () => {
    const v = view(
      cart,
      new Map([
        ['C', info(1)],
        ['B', info(1)],
        ['A', info(1)],
      ]),
      now,
    );
    expect(v.lines.map((l) => l.sku)).toEqual(['A', 'B', 'C']);
  });
});

describe('authorizeCartKey', () => {
  const user = '0199f2e0-0000-7000-8000-000000000001';

  it("lets a buyer use their own user cart and anyone use a guest cart (the token's hash is the capability)", () => {
    expect(() => {
      authorizeCartKey(`user:${user}`, user);
    }).not.toThrow();
    expect(() => {
      authorizeCartKey(`guest:${'a'.repeat(64)}`, undefined);
    }).not.toThrow();
  });

  it.each([
    ['another user', '0199f2e0-0000-7000-8000-000000000002'],
    ['a guest', undefined],
  ])("refuses %s on someone's user cart", (_name, sub) => {
    expect(() => {
      authorizeCartKey(`user:${user}`, sub);
    }).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  });
});
