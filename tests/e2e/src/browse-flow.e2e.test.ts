import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Contract } from '@sagamart/contract-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// RFC-0005 §9: the browse-and-cart journey through the public API on the Compose stack, then the same with
// Inventory stopped (the browsing half of chaos experiment C6). Needs `make demo`; run with `make e2e`.

const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8100';
const INVENTORY_CONTAINER = process.env.E2E_INVENTORY_CONTAINER ?? 'sagamart-inventory-1';

let contract: Contract;

interface Reply<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
  ms: number;
}

/** Calls the gateway and checks the answer against public-v1.yaml for `template` (the spec's path). */
async function api<T = Record<string, unknown>>(
  method: string,
  path: string,
  template: string,
  opts: { token?: string; cartToken?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Reply<T>> {
  const started = performance.now();
  const res = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: {
      ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.cartToken ? { 'x-cart-token': opts.cartToken } : {}),
      ...opts.headers,
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  const reply = {
    status: res.status,
    body: (text ? JSON.parse(text) : {}) as T,
    headers: res.headers,
    ms: performance.now() - started,
  };
  expect(
    contract.errors(method, template, reply.status, reply.body),
    `${method} ${path} → ${String(res.status)}`,
  ).toEqual([]);
  return reply;
}

async function devToken(role: 'admin' | 'buyer', userId: string): Promise<string> {
  const res = await api<{ token: string }>('POST', '/v1/dev/token', '/v1/dev/token', {
    body: { role, userId },
  });
  expect(res.status).toBe(200);
  return res.body.token;
}

const docker = (...args: string[]): string => execFileSync('docker', args, { encoding: 'utf8' }).trim();

/** Polls until `check` passes or `ms` elapse. */
async function eventually(check: () => Promise<boolean>, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`condition not met within ${String(ms)} ms`);
}

// One run's data, unique so the suite can run again on the same stack.
const run = randomUUID().slice(0, 8);
const slug = `e2e-kaos-${run}`;
const categorySlug = `e2e-${run}`;
const skuM = `E2E-${run}-M`.toUpperCase();
const skuL = `E2E-${run}-L`.toUpperCase();
let adminToken: string;
let buyerToken: string;

interface StockedSku {
  sku: string;
  available: number | null;
  stockStatus: string;
}

beforeAll(async () => {
  contract = await Contract.load('public-v1.yaml');
  const ready = await fetch(`${GATEWAY}/readyz`).catch(() => null);
  if (!ready?.ok) throw new Error(`no gateway at ${GATEWAY}: start the stack with make demo`);
  adminToken = await devToken('admin', randomUUID());
  buyerToken = await devToken('buyer', randomUUID());
});

afterAll(() => {
  // Never leave the stack without Inventory, whatever failed.
  docker('start', INVENTORY_CONTAINER);
});

describe('admin sets up a product', () => {
  it('creates a category and an active product with two SKUs', async () => {
    const category = await api<{ id: string }>('POST', '/v1/admin/categories', '/v1/admin/categories', {
      token: adminToken,
      headers: { 'idempotency-key': `e2e-cat-${run}` },
      body: { slug: categorySlug, name: 'E2E' },
    });
    expect(category.status).toBe(201);

    const product = await api('POST', '/v1/admin/products', '/v1/admin/products', {
      token: adminToken,
      headers: { 'idempotency-key': `e2e-product-${run}` },
      body: {
        slug,
        name: 'Kaos E2E',
        categoryId: category.body.id,
        status: 'ACTIVE',
        skus: [
          { sku: skuM, name: 'M', price: { amount: 79_000, currency: 'IDR' } },
          { sku: skuL, name: 'L', price: { amount: 89_000, currency: 'IDR' } },
        ],
      },
    });
    expect(product.status).toBe(201);
    expect(product.headers.get('etag')).toBe('"1"');
  });

  it('sets stock: 3 of M (low), 50 of L', async () => {
    for (const [sku, onHand] of [
      [skuM, 3],
      [skuL, 50],
    ] as const) {
      const res = await api('PUT', `/v1/admin/skus/${sku}/stock`, '/v1/admin/skus/{sku}/stock', {
        token: adminToken,
        body: { onHand, expectedVersion: 0 },
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ sku, onHand, available: onHand, version: 1 });
    }
  });
});

describe('a buyer browses and fills a cart', () => {
  it('finds the product in its category, in stock', async () => {
    const res = await api<{ items: { slug: string; stockStatus: string; fromPrice: { amount: number } }[] }>(
      'GET',
      `/v1/products?category=${categorySlug}`,
      '/v1/products',
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      expect.objectContaining({
        slug,
        stockStatus: 'IN_STOCK',
        fromPrice: { amount: 79_000, currency: 'IDR' },
      }),
    ]);
  });

  it('opens it and sees stock per size', async () => {
    const res = await api<{ stockStatus: string; skus: StockedSku[] }>(
      'GET',
      `/v1/products/${slug}`,
      '/v1/products/{slug}',
    );
    expect(res.status).toBe(200);
    expect(res.body.stockStatus).toBe('IN_STOCK');
    expect(res.body.skus).toEqual([
      expect.objectContaining({ sku: skuM, available: 3, stockStatus: 'LOW_STOCK' }),
      expect.objectContaining({ sku: skuL, available: 50, stockStatus: 'IN_STOCK' }),
    ]);
  });

  let guestToken: string;

  it('as a guest, adds more than is in stock and is told so', async () => {
    const issued = await api<{ token: string }>('POST', '/v1/cart/guest-token', '/v1/cart/guest-token');
    expect(issued.status).toBe(201);
    guestToken = issued.body.token;

    const res = await api('PUT', `/v1/cart/lines/${skuM}`, '/v1/cart/lines/{sku}', {
      cartToken: guestToken,
      body: { quantity: 5 },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      lineCount: 1,
      total: { amount: 5 * 79_000, currency: 'IDR' },
      lines: [
        {
          sku: skuM,
          quantity: 5,
          price: { amount: 79_000 },
          available: 3,
          exceedsAvailable: true,
          stockStatus: 'LOW_STOCK',
        },
      ],
    });
    // The cart is there on the next visit with the same token.
    const again = await api('GET', '/v1/cart', '/v1/cart', { cartToken: guestToken });
    expect(again.body).toMatchObject({ lineCount: 1 });
  });

  it('as a signed-in buyer, uses their own cart', async () => {
    const res = await api('PUT', `/v1/cart/lines/${skuL}`, '/v1/cart/lines/{sku}', {
      token: buyerToken,
      body: { quantity: 2 },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      lines: [{ sku: skuL, quantity: 2, available: 50, exceedsAvailable: false, stockStatus: 'IN_STOCK' }],
      total: { amount: 178_000 },
    });
  });

  describe('with Inventory stopped (chaos C6, browsing half)', () => {
    beforeAll(() => {
      docker('stop', INVENTORY_CONTAINER);
    });

    it('still lists the product, with stock UNKNOWN, fast', async () => {
      const res = await api<{ items: { slug: string; stockStatus: string }[] }>(
        'GET',
        `/v1/products?category=${categorySlug}`,
        '/v1/products',
      );
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([expect.objectContaining({ slug, stockStatus: 'UNKNOWN' })]);
      expect(res.ms).toBeLessThan(1000);
    });

    it('still opens the product page, every size UNKNOWN', async () => {
      const res = await api<{ stockStatus: string; skus: StockedSku[] }>(
        'GET',
        `/v1/products/${slug}`,
        '/v1/products/{slug}',
      );
      expect(res.status).toBe(200);
      expect(res.body.stockStatus).toBe('UNKNOWN');
      expect(res.body.skus.map((s) => [s.available, s.stockStatus])).toEqual([
        [null, 'UNKNOWN'],
        [null, 'UNKNOWN'],
      ]);
    });

    it('still shows the cart, with availability unknown rather than wrong', async () => {
      const res = await api('GET', '/v1/cart', '/v1/cart', { cartToken: guestToken });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        lines: [{ sku: skuM, available: null, exceedsAvailable: null, stockStatus: 'UNKNOWN' }],
      });
    });

    it('refuses stock changes with 503 rather than pretending', async () => {
      const res = await api('PUT', `/v1/admin/skus/${skuM}/stock`, '/v1/admin/skus/{sku}/stock', {
        token: adminToken,
        body: { onHand: 10, expectedVersion: 1 },
      });
      expect(res.status).toBe(503);
    });

    it('shows stock again once Inventory is back', async () => {
      docker('start', INVENTORY_CONTAINER);
      await eventually(async () => {
        const res = await fetch(`${GATEWAY}/v1/products/${slug}`);
        const body = (await res.json()) as { skus: StockedSku[] };
        return body.skus[0]?.stockStatus === 'LOW_STOCK';
      }, 60_000);
    });
  });
});
