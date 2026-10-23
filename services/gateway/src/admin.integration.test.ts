import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer as createHttp2Server } from 'node:http2';
import type { Http2Server } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { BinaryWriter } from '@bufbuild/protobuf/wire';
import { Code, ConnectError } from '@connectrpc/connect';
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
const adminId = '0199f2e0-0000-7000-8000-00000000a001';
const verify = (token: unknown, audience: string) =>
  verifyIdentity(String(token), { publicKeys: { 'gw-test': publicKey }, audience });

let publicContract: Contract;
let internalContract: Contract;

// ---- Catalog stub: records what arrives, answers as the internal contract says ----

const productId = '0199f2d1-2b3c-7d4e-9f50-6a7b8c9d0e12';
const now = '2026-10-22T03:00:00.000Z';
const adminProduct = {
  id: productId,
  slug: 'kaos-polos',
  name: 'Kaos Polos',
  description: '',
  category: { id: '0199f2d0-1a2b-7c3d-8e4f-5a6b7c8d9e01', slug: 'kaos', name: 'Kaos' },
  imageUrls: [],
  status: 'ACTIVE',
  version: 1,
  createdAt: now,
  updatedAt: now,
  skus: [
    {
      sku: 'KAOS-M',
      productId,
      name: 'M',
      price: { amount: 79_000, currency: 'IDR' },
      status: 'ACTIVE',
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
  ],
};

interface CatalogCall {
  method: string;
  path: string;
  query: string;
  body: unknown;
  ifMatch: string | undefined;
  idempotencyKey: string | undefined;
  sub: string | null;
  roles: string[];
}
const catalogCalls: CatalogCall[] = [];

function catalogHandler(req: IncomingMessage, res: ServerResponse): void {
  let raw = '';
  req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://stub');
    const claims = verify(req.headers['x-sagamart-identity'], 'catalog');
    catalogCalls.push({
      method: req.method ?? '',
      path: url.pathname,
      query: url.search,
      body: raw ? JSON.parse(raw) : undefined,
      ifMatch: req.headers['if-match'],
      idempotencyKey: req.headers['idempotency-key'] as string | undefined,
      sub: claims.sub ?? null,
      roles: claims.roles,
    });
    const send = (status: number, body: unknown, template: string, headers: Record<string, string> = {}) => {
      expect(internalContract.errors(req.method ?? 'GET', template, status, body)).toEqual([]);
      res
        .writeHead(status, {
          'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
          ...headers,
        })
        .end(JSON.stringify(body));
    };
    const p = url.pathname;
    if (req.method === 'POST' && p === '/internal/v1/admin/products') {
      send(201, adminProduct, '/internal/v1/admin/products', { etag: '"1"' });
    } else if (req.method === 'GET' && p === '/internal/v1/admin/products') {
      send(200, { items: [adminProduct], nextCursor: null }, '/internal/v1/admin/products');
    } else if (req.method === 'PATCH' && p === `/internal/v1/admin/products/${productId}`) {
      if (req.headers['if-match'] !== '"1"') {
        send(
          412,
          {
            type: 'https://sagamart.dev/errors/version-conflict',
            title: 'Precondition Failed',
            status: 412,
            code: 'VERSION_CONFLICT',
            currentVersion: 2,
            instance: p,
          },
          '/internal/v1/admin/products/{id}',
        );
        return;
      }
      send(200, { ...adminProduct, version: 2 }, '/internal/v1/admin/products/{id}', { etag: '"2"' });
    } else {
      send(
        404,
        { type: 'https://sagamart.dev/errors/not-found', title: 'Not Found', status: 404, code: 'NOT_FOUND' },
        '/internal/v1/admin/products/{id}',
      );
    }
  });
}

// ---- Inventory stub: a real gRPC server answering as Inventory's Go code does ----

const errorInfo = (reason: string) => ({
  type: 'google.rpc.ErrorInfo',
  value: new BinaryWriter().uint32(10).string(reason).uint32(18).string('inventory.sagamart.dev').finish(),
});
const badRequest = (field: string, description: string) => ({
  type: 'google.rpc.BadRequest',
  value: new BinaryWriter()
    .uint32(10)
    .bytes(new BinaryWriter().uint32(10).string(field).uint32(18).string(description).finish())
    .finish(),
});

interface InventoryState {
  /** What SetStockLevel does next: succeed, or fail like Inventory does. */
  next: 'ok' | 'VERSION_CONFLICT' | 'STOCK_BELOW_RESERVED' | 'INVALID' | 'DOWN';
  level: { version: bigint; onHand: bigint; reserved: bigint } | null;
  calls: { method: string; roles: string[]; timeoutMs: number | undefined }[];
}
const inventory: InventoryState = { next: 'ok', level: null, calls: [] };

function withDetails(err: ConnectError, details: { type: string; value: Uint8Array }[]): ConnectError {
  err.details.push(...details);
  return err;
}

function inventoryRoutes(
  router: Parameters<NonNullable<Parameters<typeof connectNodeAdapter>[0]['routes']>>[0],
): void {
  router.service(InventoryService, {
    setStockLevel(req, ctx) {
      const claims = verify(ctx.requestHeader.get('x-sagamart-identity'), 'inventory');
      inventory.calls.push({ method: 'SetStockLevel', roles: claims.roles, timeoutMs: ctx.timeoutMs() });
      switch (inventory.next) {
        case 'VERSION_CONFLICT':
          throw withDetails(new ConnectError('version conflict', Code.Aborted), [
            errorInfo('VERSION_CONFLICT'),
          ]);
        case 'STOCK_BELOW_RESERVED':
          throw withDetails(new ConnectError('below reserved', Code.FailedPrecondition), [
            errorInfo('STOCK_BELOW_RESERVED'),
          ]);
        case 'INVALID':
          throw withDetails(new ConnectError('invalid', Code.InvalidArgument), [
            badRequest('sku', 'is not a valid SKU'),
          ]);
        case 'DOWN':
          throw new ConnectError('unavailable', Code.Unavailable);
        default:
          return {
            level: {
              sku: req.sku,
              onHand: req.onHand,
              reserved: 0n,
              available: req.onHand,
              version: req.expectedVersion + 1n,
            },
          };
      }
    },
    getStockLevels(req, ctx) {
      const claims = verify(ctx.requestHeader.get('x-sagamart-identity'), 'inventory');
      inventory.calls.push({ method: 'GetStockLevels', roles: claims.roles, timeoutMs: ctx.timeoutMs() });
      const level = inventory.level;
      return {
        levels:
          level && req.skus[0]
            ? [{ sku: req.skus[0], ...level, available: level.onHand - level.reserved }]
            : [],
      };
    },
  });
}

// ---- Setup ----

let catalogServer: Server;
let inventoryServer: Http2Server;
let redis: StartedRedisContainer;
let app: INestApplication;
let gw: Server;

beforeAll(async () => {
  catalogServer = createServer(catalogHandler);
  inventoryServer = createHttp2Server(connectNodeAdapter({ routes: inventoryRoutes }));
  await Promise.all([
    new Promise<void>((resolve) => catalogServer.listen(0, '127.0.0.1', resolve)),
    new Promise<void>((resolve) => inventoryServer.listen(0, '127.0.0.1', resolve)),
  ]);
  [redis, publicContract, internalContract] = await Promise.all([
    new RedisContainer('redis:7.4.1-alpine').start(),
    Contract.load('public-v1.yaml'),
    Contract.load('catalog-internal-v1.yaml'),
  ]);
  const config = loadGatewayConfig({
    GATEWAY_ENV: 'test',
    GATEWAY_DEV_AUTH: 'true',
    GATEWAY_DEV_JWT_SECRET: secret,
    GATEWAY_IDENTITY_KEY_ID: 'gw-test',
    GATEWAY_IDENTITY_PRIVATE_KEY: privateKey,
    GATEWAY_CATALOG_URL: `http://127.0.0.1:${String((catalogServer.address() as AddressInfo).port)}`,
    GATEWAY_INVENTORY_URL: `http://127.0.0.1:${String((inventoryServer.address() as AddressInfo).port)}`,
    GATEWAY_REDIS_URL: redis.getConnectionUrl(),
    GATEWAY_RATE_LIMIT_PER_SECOND: '10000',
    GATEWAY_RATE_LIMIT_BURST: '10000',
  });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot({ config, logDestination: new PassThrough() })],
  }).compile();
  app = moduleRef.createNestApplication();
  configureApp(app, config);
  await app.init();
  gw = app.getHttpServer() as Server;
});

afterAll(async () => {
  await app.close();
  await redis.stop();
  await new Promise((resolve) => catalogServer.close(resolve));
  await new Promise((resolve) => inventoryServer.close(resolve));
});

beforeEach(() => {
  catalogCalls.length = 0;
  Object.assign(inventory, { next: 'ok', level: null, calls: [] });
});

const conforms = (method: string, template: string, res: { status: number; body: unknown }) => {
  expect(publicContract.errors(method, template, res.status, res.body)).toEqual([]);
};
const as = async (role: 'admin' | 'buyer') =>
  `Bearer ${(await issueDevToken({ secret, userId: adminId, role })).token}`;

// ---- Tests ----

describe('the admin role', () => {
  it('is required: anonymous 401, buyer 403, and neither reaches a service', async () => {
    await request(gw).get('/v1/admin/products').expect(401);
    const res = await request(gw)
      .post('/v1/admin/products')
      .set('authorization', await as('buyer'))
      .send({})
      .expect(403);
    conforms('POST', '/v1/admin/products', res);
    await request(gw)
      .put('/v1/admin/skus/KAOS-M/stock')
      .set('authorization', await as('buyer'))
      .send({ onHand: 1, expectedVersion: 0 })
      .expect(403);
    expect(catalogCalls).toHaveLength(0);
    expect(inventory.calls).toHaveLength(0);
  });
});

describe('product admin, through Catalog', () => {
  it('forwards a create with its Idempotency-Key and relays 201, the ETag and the body', async () => {
    const key = `key-${randomUUID()}`;
    const body = {
      slug: 'kaos-polos',
      name: 'Kaos Polos',
      categoryId: adminProduct.category.id,
      skus: [{ sku: 'KAOS-M', name: 'M', price: { amount: 79_000, currency: 'IDR' } }],
    };
    const res = await request(gw)
      .post('/v1/admin/products')
      .set('authorization', await as('admin'))
      .set('idempotency-key', key)
      .send(body)
      .expect(201);
    conforms('POST', '/v1/admin/products', res);
    expect(res.headers.etag).toBe('"1"');
    expect(catalogCalls[0]).toMatchObject({
      method: 'POST',
      path: '/internal/v1/admin/products',
      body,
      idempotencyKey: key,
      sub: adminId,
      roles: ['admin'],
    });
  });

  it("forwards If-Match, and relays Catalog's 412 with the current version", async () => {
    const ok = await request(gw)
      .patch(`/v1/admin/products/${productId}`)
      .set('authorization', await as('admin'))
      .set('if-match', '"1"')
      .send({ name: 'Baru' })
      .expect(200);
    conforms('PATCH', '/v1/admin/products/{id}', ok);
    expect(ok.headers.etag).toBe('"2"');
    const stale = await request(gw)
      .patch(`/v1/admin/products/${productId}`)
      .set('authorization', await as('admin'))
      .set('if-match', '"0"')
      .send({ name: 'Lagi' })
      .expect(412);
    conforms('PATCH', '/v1/admin/products/{id}', stale);
    expect(stale.body).toMatchObject({
      code: 'VERSION_CONFLICT',
      currentVersion: 2,
      instance: `/v1/admin/products/${productId}`,
    });
  });

  it('forwards only the listing parameters it knows', async () => {
    const res = await request(gw)
      .get('/v1/admin/products')
      .query({ status: 'DRAFT', limit: 5, other: 'x' })
      .set('authorization', await as('admin'))
      .expect(200);
    conforms('GET', '/v1/admin/products', res);
    expect(catalogCalls[0]?.query).toBe('?status=DRAFT&limit=5');
  });
});

describe('PUT /v1/admin/skus/{sku}/stock', () => {
  const put = async (body: unknown, sku = 'KAOS-M') =>
    request(gw)
      .put(`/v1/admin/skus/${sku}/stock`)
      .set('authorization', await as('admin'))
      .send(body as object);

  it("sets stock through Inventory as the admin, within Inventory's 2 s deadline", async () => {
    const res = await put({ onHand: 100, expectedVersion: 0 });
    expect(res.status).toBe(200);
    conforms('PUT', '/v1/admin/skus/{sku}/stock', res);
    expect(res.body).toEqual({ sku: 'KAOS-M', onHand: 100, reserved: 0, available: 100, version: 1 });
    expect(inventory.calls[0]).toMatchObject({ method: 'SetStockLevel', roles: ['admin'] });
    expect(inventory.calls[0]?.timeoutMs).toBeLessThanOrEqual(2000);
  });

  it.each(['VERSION_CONFLICT', 'STOCK_BELOW_RESERVED'] as const)(
    'turns %s into 409 with the current version, on-hand and reserved units',
    async (reason) => {
      inventory.next = reason;
      inventory.level = { version: 7n, onHand: 10n, reserved: 4n };
      const res = await put({ onHand: 2, expectedVersion: 6 });
      expect(res.status).toBe(409);
      conforms('PUT', '/v1/admin/skus/{sku}/stock', res);
      expect(res.body).toMatchObject({ code: reason, currentVersion: 7, onHand: 10, reserved: 4 });
    },
  );

  it('reports version 0 for a SKU Inventory has no record of', async () => {
    inventory.next = 'VERSION_CONFLICT';
    const res = await put({ onHand: 5, expectedVersion: 3 });
    expect(res.body).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: 0, onHand: 0, reserved: 0 });
  });

  it.each([
    ['a negative onHand', { onHand: -1, expectedVersion: 0 }],
    ['a missing expectedVersion', { onHand: 1 }],
    ['an unknown member', { onHand: 1, expectedVersion: 0, force: true }],
    ['a fractional onHand', { onHand: 1.5, expectedVersion: 0 }],
  ])('rejects %s with 400 without calling Inventory', async (_name, body) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    conforms('PUT', '/v1/admin/skus/{sku}/stock', res);
    expect(inventory.calls).toHaveLength(0);
  });

  it("relays Inventory's own validation as 400 with its field", async () => {
    inventory.next = 'INVALID';
    const res = await put({ onHand: 1, expectedVersion: 0 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [{ field: 'sku', message: 'is not a valid SKU' }],
    });
  });

  it('is 503 with Retry-After when Inventory is unavailable', async () => {
    inventory.next = 'DOWN';
    const res = await put({ onHand: 1, expectedVersion: 0 });
    expect(res.status).toBe(503);
    conforms('PUT', '/v1/admin/skus/{sku}/stock', res);
    expect(res.headers['retry-after']).toBe('1');
  });
});
