import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer as createHttp2Server } from 'node:http2';
import type { Http2Server } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { ConnectError, Code } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { InventoryService } from '@sagamart/contracts/inventory/v1';
import { verifyIdentity } from '@sagamart/node-common';
import { RedisContainer } from '@testcontainers/redis';
import type { StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule, configureApp } from './app.module.js';
import { loadGatewayConfig } from './config.js';
import { issueDevToken } from './dev-auth.js';
import { Contract } from './testing/contract.js';

const keys = generateKeyPairSync('ed25519');
const privateKey = keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const secret = 'integration-dev-secret-32-chars!!';
const buyer = '0199f2e0-0000-7000-8000-000000000001';
const verify = (token: unknown, audience: string) =>
  verifyIdentity(String(token), { publicKeys: { 'gw-test': publicKey }, audience });

let publicContract: Contract;
let internalContract: Contract;

// ---- Catalog stub: canned internal responses, each checked against the internal contract ----

const category = { id: '0199f2d0-1a2b-7c3d-8e4f-5a6b7c8d9e01', slug: 'kaos', name: 'Kaos' };
const summary = (n: number, skus: string[]) => ({
  id: `0199f2d1-2b3c-7d4e-9f50-${String(n).padStart(12, '0')}`,
  slug: `kaos-${String(n)}`,
  name: `Kaos ${String(n)}`,
  category,
  imageUrl: null,
  fromPrice: { amount: 79_000, currency: 'IDR' },
  skus,
});

interface CatalogState {
  /** Products on the listing page. */
  page: ReturnType<typeof summary>[];
  /** Cart lines Catalog returns, whatever the request. */
  cartLines: { sku: string; quantity: number }[];
  /** 'ok', or every response a 500. */
  mode: 'ok' | 'error';
  calls: { method: string; path: string; query: string; identity: { sub: string | null; roles: string[] } }[];
}
const catalog: CatalogState = { page: [], cartLines: [], mode: 'ok', calls: [] };

function catalogHandler(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://stub');
  const claims = verify(req.headers['x-sagamart-identity'], 'catalog');
  catalog.calls.push({
    method: req.method ?? '',
    path: url.pathname,
    query: url.search,
    identity: { sub: claims.sub ?? null, roles: claims.roles },
  });
  const send = (status: number, body: unknown, template?: string) => {
    if (template) expect(internalContract.errors(req.method ?? 'GET', template, status, body)).toEqual([]);
    res
      .writeHead(status, { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' })
      .end(JSON.stringify(body));
  };
  if (catalog.mode === 'error') {
    send(500, {
      type: 'https://sagamart.dev/errors/internal-error',
      title: 'Internal Server Error',
      status: 500,
      code: 'INTERNAL_ERROR',
    });
    return;
  }
  const path = url.pathname;
  if (path === '/internal/v1/categories') {
    send(200, { items: [{ ...category, parentId: null, position: 0 }] }, '/internal/v1/categories');
  } else if (path === '/internal/v1/products') {
    if (url.searchParams.get('cursor') === 'stale') {
      send(
        400,
        {
          type: 'https://sagamart.dev/errors/cursor-mismatch',
          title: 'Bad Request',
          status: 400,
          code: 'CURSOR_MISMATCH',
          instance: '/internal/v1/products',
          traceId: 'a'.repeat(32),
        },
        '/internal/v1/products',
      );
      return;
    }
    send(200, { items: catalog.page, nextCursor: null }, '/internal/v1/products');
  } else if (path === '/internal/v1/products/kaos-1') {
    const base: Partial<ReturnType<typeof summary>> = summary(1, []);
    delete base.skus;
    delete base.imageUrl;
    send(
      200,
      {
        ...base,
        description: 'Katun',
        imageUrls: [],
        skus: ['K-S', 'K-M', 'K-L'].map((sku) => ({
          sku,
          name: sku,
          price: { amount: 79_000, currency: 'IDR' },
        })),
      },
      '/internal/v1/products/{slug}',
    );
  } else if (path.startsWith('/internal/v1/products/')) {
    send(
      404,
      {
        type: 'https://sagamart.dev/errors/not-found',
        title: 'Not Found',
        status: 404,
        code: 'NOT_FOUND',
        detail: 'No such product.',
      },
      '/internal/v1/products/{slug}',
    );
  } else if (path.startsWith('/internal/v1/carts/')) {
    const lines = catalog.cartLines.map((l) => ({
      ...l,
      productSlug: 'kaos-1',
      productName: 'Kaos 1',
      skuName: 'M',
      priceSnapshot: { amount: 79_000, currency: 'IDR' },
      price: { amount: 79_000, currency: 'IDR' },
      priceChanged: false,
    }));
    send(
      200,
      {
        lines,
        lineCount: lines.length,
        total: { amount: 79_000 * lines.reduce((n, l) => n + l.quantity, 0), currency: 'IDR' },
        expiresAt: lines.length ? '2026-10-29T03:00:00.000Z' : null,
      },
      req.method === 'GET' ? '/internal/v1/carts/{cartKey}' : '/internal/v1/carts/{cartKey}/lines/{sku}',
    );
  } else {
    send(404, {
      type: 'https://sagamart.dev/errors/not-found',
      title: 'Not Found',
      status: 404,
      code: 'NOT_FOUND',
    });
  }
}

// ---- Inventory stub: a real gRPC server ----

interface InventoryState {
  available: Record<string, number>;
  /** Delay every call by this much. */
  delayMs: number;
  /** Fail any batch containing a SKU with this prefix. */
  failPrefix: string | null;
  calls: { skus: string[]; timeoutMs: number | undefined; roles: string[] }[];
}
const inventory: InventoryState = { available: {}, delayMs: 0, failPrefix: null, calls: [] };

function inventoryRoutes(
  router: Parameters<NonNullable<Parameters<typeof connectNodeAdapter>[0]['routes']>>[0],
): void {
  router.service(InventoryService, {
    async getStockLevels(req, ctx) {
      const claims = verify(ctx.requestHeader.get('x-sagamart-identity'), 'inventory');
      inventory.calls.push({ skus: req.skus, timeoutMs: ctx.timeoutMs(), roles: claims.roles });
      if (inventory.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, inventory.delayMs));
      if (inventory.failPrefix !== null && req.skus.some((s) => s.startsWith(inventory.failPrefix ?? ''))) {
        throw new ConnectError('injected failure', Code.Unavailable);
      }
      return {
        levels: req.skus
          .filter((sku) => sku in inventory.available)
          .map((sku) => ({
            sku,
            onHand: BigInt(inventory.available[sku] ?? 0),
            reserved: 0n,
            available: BigInt(inventory.available[sku] ?? 0),
            version: 1n,
          })),
      };
    },
  });
}

// ---- Setup ----

let catalogServer: Server;
let inventoryServer: Http2Server;
let redis: StartedRedisContainer;
const apps: INestApplication[] = [];
let gw: Server;
let catalogUrl: string;
let inventoryUrl: string;

async function start(env: Record<string, string> = {}): Promise<Server> {
  const config = loadGatewayConfig({
    GATEWAY_ENV: 'test',
    GATEWAY_DEV_AUTH: 'true',
    GATEWAY_DEV_JWT_SECRET: secret,
    GATEWAY_IDENTITY_KEY_ID: 'gw-test',
    GATEWAY_IDENTITY_PRIVATE_KEY: privateKey,
    GATEWAY_CATALOG_URL: catalogUrl,
    GATEWAY_INVENTORY_URL: inventoryUrl,
    GATEWAY_REDIS_URL: redis.getConnectionUrl(),
    GATEWAY_RATE_LIMIT_PER_SECOND: '10000',
    GATEWAY_RATE_LIMIT_BURST: '10000',
    ...env,
  });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot({ config, logDestination: new PassThrough() })],
  }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app, config);
  await app.init();
  apps.push(app);
  return app.getHttpServer() as Server;
}

beforeAll(async () => {
  catalogServer = createServer(catalogHandler);
  inventoryServer = createHttp2Server(connectNodeAdapter({ routes: inventoryRoutes }));
  await Promise.all([
    new Promise<void>((resolve) => catalogServer.listen(0, '127.0.0.1', resolve)),
    new Promise<void>((resolve) => inventoryServer.listen(0, '127.0.0.1', resolve)),
  ]);
  catalogUrl = `http://127.0.0.1:${String((catalogServer.address() as AddressInfo).port)}`;
  inventoryUrl = `http://127.0.0.1:${String((inventoryServer.address() as AddressInfo).port)}`;
  [redis, publicContract, internalContract] = await Promise.all([
    new RedisContainer('redis:7.4.1-alpine').start(),
    Contract.load('public-v1.yaml'),
    Contract.load('catalog-internal-v1.yaml'),
  ]);
  gw = await start();
});

afterAll(async () => {
  for (const app of apps) await app.close();
  await redis.stop();
  await new Promise((resolve) => catalogServer.close(resolve));
  await new Promise((resolve) => inventoryServer.close(resolve));
});

beforeEach(() => {
  Object.assign(catalog, { page: [], cartLines: [], mode: 'ok', calls: [] });
  Object.assign(inventory, { available: {}, delayMs: 0, failPrefix: null, calls: [] });
});

const conforms = (method: string, template: string, res: { status: number; body: unknown }) => {
  expect(publicContract.errors(method, template, res.status, res.body)).toEqual([]);
};
const bearer = async () => `Bearer ${(await issueDevToken({ secret, userId: buyer, role: 'buyer' })).token}`;

// ---- Tests ----

describe('GET /v1/categories', () => {
  it("relays Catalog's categories", async () => {
    const res = await request(gw).get('/v1/categories').expect(200);
    conforms('GET', '/v1/categories', res);
    expect(catalog.calls[0]?.identity).toEqual({ sub: null, roles: [] });
  });
});

describe('GET /v1/products', () => {
  it('adds each product its best stock status, in one Inventory call, without exposing SKU codes', async () => {
    catalog.page = [summary(1, ['A-1', 'A-2']), summary(2, ['B-1']), summary(3, ['C-1', 'C-2'])];
    inventory.available = { 'A-1': 0, 'A-2': 3, 'B-1': 50, 'C-1': 0, 'C-2': 0 };
    const res = await request(gw)
      .get('/v1/products')
      .query({ category: 'kaos', sort: 'price_asc', limit: 3, utm: 'x' })
      .expect(200);
    conforms('GET', '/v1/products', res);
    const items = (res.body as { items: { stockStatus: string; skus?: unknown }[] }).items;
    expect(items.map((p) => p.stockStatus)).toEqual(['LOW_STOCK', 'IN_STOCK', 'OUT_OF_STOCK']);
    expect(items.every((p) => p.skus === undefined)).toBe(true);
    expect(inventory.calls).toHaveLength(1);
    expect(catalog.calls[0]?.query).toBe('?category=kaos&sort=price_asc&limit=3'); // unknown parameters dropped
  });

  it('sends Inventory the identity and a deadline of at most 150 ms', async () => {
    catalog.page = [summary(1, ['A-1'])];
    await request(gw)
      .get('/v1/products')
      .set('authorization', await bearer())
      .expect(200);
    const call = inventory.calls[0];
    expect(call?.roles).toEqual(['buyer']);
    expect(call?.timeoutMs).toBeLessThanOrEqual(150);
    expect(call?.timeoutMs).toBeGreaterThan(0);
  });

  it('renders with UNKNOWN stock when Inventory misses its 150 ms deadline', async () => {
    catalog.page = [summary(1, ['A-1'])];
    inventory.available = { 'A-1': 10 };
    inventory.delayMs = 400;
    const started = Date.now();
    const res = await request(gw).get('/v1/products').expect(200);
    expect(Date.now() - started).toBeLessThan(380);
    conforms('GET', '/v1/products', res);
    expect((res.body as { items: { stockStatus: string }[] }).items[0]?.stockStatus).toBe('UNKNOWN');
  });

  it('asks in batches of 100 in parallel, and a failed batch marks only its own SKUs UNKNOWN', async () => {
    const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${String(i)}`);
    // 3 products of 50 SKUs: 150 SKUs, two batches; the second contains every FAIL SKU.
    catalog.page = [summary(1, many('OK1', 50)), summary(2, many('OK2', 50)), summary(3, many('FAIL', 50))];
    for (const sku of [...many('OK1', 50), ...many('OK2', 50), ...many('FAIL', 50)])
      inventory.available[sku] = 9;
    inventory.failPrefix = 'FAIL';
    const res = await request(gw).get('/v1/products').expect(200);
    expect(inventory.calls.map((c) => c.skus.length).sort()).toEqual([100, 50].sort());
    expect((res.body as { items: { stockStatus: string }[] }).items.map((p) => p.stockStatus)).toEqual([
      'IN_STOCK',
      'IN_STOCK',
      'UNKNOWN',
    ]);
  });

  it("relays Catalog's errors with the public path, not the internal one", async () => {
    const res = await request(gw).get('/v1/products').query({ cursor: 'stale' }).expect(400);
    conforms('GET', '/v1/products', res);
    expect(res.body).toMatchObject({ code: 'CURSOR_MISMATCH', instance: '/v1/products?cursor=stale' });
    expect(JSON.stringify(res.body)).not.toContain('/internal/');
  });
});

describe('GET /v1/products/{slug}', () => {
  it('shows each SKU with its available units and status; unknown to Inventory is UNKNOWN', async () => {
    inventory.available = { 'K-S': 0, 'K-M': 4 };
    const res = await request(gw).get('/v1/products/kaos-1').expect(200);
    conforms('GET', '/v1/products/{slug}', res);
    expect(res.body).toMatchObject({
      stockStatus: 'LOW_STOCK',
      skus: [
        { sku: 'K-S', available: 0, stockStatus: 'OUT_OF_STOCK' },
        { sku: 'K-M', available: 4, stockStatus: 'LOW_STOCK' },
        { sku: 'K-L', available: null, stockStatus: 'UNKNOWN' },
      ],
    });
  });

  it('relays 404', async () => {
    const res = await request(gw).get('/v1/products/nope').expect(404);
    conforms('GET', '/v1/products/{slug}', res);
  });
});

describe('cart', () => {
  it('issues guest tokens without calling anything', async () => {
    const res = await request(gw).post('/v1/cart/guest-token').expect(201);
    conforms('POST', '/v1/cart/guest-token', res);
    expect(catalog.calls).toHaveLength(0);
  });

  it("uses the guest token's hash as the cart key, and adds availability to each line", async () => {
    const token = ((await request(gw).post('/v1/cart/guest-token')).body as { token: string }).token;
    catalog.cartLines = [
      { sku: 'K-M', quantity: 3 },
      { sku: 'K-L', quantity: 1 },
      { sku: 'K-X', quantity: 1 },
    ];
    inventory.available = { 'K-M': 2, 'K-L': 8 };
    const res = await request(gw)
      .put('/v1/cart/lines/K-M')
      .set('x-cart-token', token)
      .send({ quantity: 3 })
      .expect(200);
    conforms('PUT', '/v1/cart/lines/{sku}', res);
    const hash = createHash('sha256').update(token).digest('hex');
    expect(catalog.calls[0]).toMatchObject({
      method: 'PUT',
      path: `/internal/v1/carts/guest:${hash}/lines/K-M`,
    });
    expect((res.body as { lines: unknown[] }).lines).toEqual([
      expect.objectContaining({ sku: 'K-M', available: 2, exceedsAvailable: true, stockStatus: 'LOW_STOCK' }),
      expect.objectContaining({ sku: 'K-L', available: 8, exceedsAvailable: false, stockStatus: 'IN_STOCK' }),
      expect.objectContaining({
        sku: 'K-X',
        available: null,
        exceedsAvailable: null,
        stockStatus: 'UNKNOWN',
      }),
    ]);
  });

  it("uses a signed-in buyer's own cart", async () => {
    const res = await request(gw)
      .get('/v1/cart')
      .set('authorization', await bearer())
      .expect(200);
    conforms('GET', '/v1/cart', res);
    expect(catalog.calls[0]).toMatchObject({
      path: `/internal/v1/carts/user:${buyer}`,
      identity: { sub: buyer },
    });
    const del = await request(gw)
      .delete('/v1/cart/lines/K-M')
      .set('authorization', await bearer())
      .expect(200);
    conforms('DELETE', '/v1/cart/lines/{sku}', del);
  });

  it('needs a token or a sign-in (401), and rejects a malformed token (400)', async () => {
    const none = await request(gw).get('/v1/cart').expect(401);
    conforms('GET', '/v1/cart', none);
    const bad = await request(gw).get('/v1/cart').set('x-cart-token', 'nope').expect(400);
    conforms('GET', '/v1/cart', bad);
    expect(catalog.calls).toHaveLength(0);
  });
});

describe('when Catalog fails', () => {
  it('opens the breaker after 5 failures: then 503 at once with Retry-After, and Catalog gets no traffic', async () => {
    const fresh = await start();
    catalog.mode = 'error';
    for (let i = 0; i < 5; i++) await request(fresh).get('/v1/categories').expect(500);
    const callsBefore = catalog.calls.length;
    const res = await request(fresh).get('/v1/categories').expect(503);
    conforms('GET', '/v1/categories', res);
    expect(res.body).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(9);
    expect(catalog.calls.length).toBe(callsBefore);
  });

  it('is 503 with Retry-After when Catalog is unreachable', async () => {
    const down = await start({ GATEWAY_CATALOG_URL: 'http://127.0.0.1:1' });
    const res = await request(down).get('/v1/products').expect(503);
    conforms('GET', '/v1/products', res);
    expect(res.headers['retry-after']).toBe('1');
  });
});
