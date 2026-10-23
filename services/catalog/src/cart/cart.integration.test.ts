import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { PassThrough } from 'node:stream';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule, configureApp } from '../app.module.js';
import { Contract } from '@sagamart/contract-testing';
import { startHarness, userId } from '../testing/harness.js';
import type { Harness } from '../testing/harness.js';

let h: Harness;
let contract: Contract;
let ddb: DynamoDBClient;

beforeAll(async () => {
  [h, contract] = await Promise.all([startHarness(), Contract.load('catalog-internal-v1.yaml')]);
  ddb = new DynamoDBClient({
    endpoint: h.dynamoEndpoint,
    region: 'ap-southeast-3',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
});

afterAll(async () => {
  ddb.destroy();
  await h.close();
});

// ---- Catalog data, through the admin API ----

const admin = { roles: ['admin'], subject: '0199f2e0-0000-7000-8000-00000000a001' };
let n = 0;
const unique = (prefix: string): string => `${prefix}-${String(++n)}-${randomUUID().slice(0, 8)}`;
let categoryId: string;

/** An active product with `count` SKUs priced 10 000, 11 000, ...; returns the SKU codes. */
async function product(count = 1, status: 'ACTIVE' | 'DRAFT' = 'ACTIVE'): Promise<string[]> {
  if (!categoryId) {
    const res = await request(h.http())
      .post('/internal/v1/admin/categories')
      .set('x-sagamart-identity', h.token(admin))
      .set('Idempotency-Key', `key-${randomUUID()}`)
      .send({ slug: unique('cat'), name: 'Kaos' })
      .expect(201);
    categoryId = (res.body as { id: string }).id;
  }
  const slug = unique('p');
  const skus = Array.from({ length: count }, (_, i) => ({
    sku: `${slug}-${String(i)}`.toUpperCase(),
    name: `Variant ${String(i)}`,
    price: { amount: 10_000 + i * 1_000, currency: 'IDR' },
  }));
  await request(h.http())
    .post('/internal/v1/admin/products')
    .set('x-sagamart-identity', h.token(admin))
    .set('Idempotency-Key', `key-${randomUUID()}`)
    .send({ slug, name: `Product ${slug}`, categoryId, status, skus })
    .expect(201);
  return skus.map((s) => s.sku);
}

async function patchSku(sku: string, body: object): Promise<void> {
  // Versions start at 1 and each test patches a SKU at most once.
  await request(h.http())
    .patch(`/internal/v1/admin/skus/${sku}`)
    .set('x-sagamart-identity', h.token(admin))
    .set('If-Match', '"1"')
    .send(body)
    .expect(200);
}

// ---- Cart helpers ----

const guestKey = (): string => `guest:${createHash('sha256').update(randomBytes(16)).digest('hex')}`;
const guest = { roles: [] as string[], subject: null };

interface CartBody {
  lines: { sku: string; quantity: number; price: { amount: number } | null; priceChanged: boolean }[];
  lineCount: number;
  total: { amount: number };
  expiresAt: string | null;
}

const CART = '/internal/v1/carts/{cartKey}';
const LINE = '/internal/v1/carts/{cartKey}/lines/{sku}';

function conforms(method: string, template: string, res: { status: number; body: unknown }): void {
  expect(contract.errors(method, template, res.status, res.body)).toEqual([]);
}

async function getCart(key: string, who: object = guest) {
  const res = await request(h.http())
    .get(`/internal/v1/carts/${key}`)
    .set('x-sagamart-identity', h.token(who));
  if (res.status === 200) conforms('GET', CART, res);
  return res;
}

async function put(key: string, sku: string, quantity: unknown, who: object = guest) {
  const res = await request(h.http())
    .put(`/internal/v1/carts/${key}/lines/${sku}`)
    .set('x-sagamart-identity', h.token(who))
    .send({ quantity });
  conforms('PUT', LINE, res);
  return res;
}

async function rawItem(key: string) {
  const out = await ddb.send(
    new GetItemCommand({ TableName: 'carts', Key: { pk: { S: `CART#${key}` } }, ConsistentRead: true }),
  );
  return out.Item;
}

// ---- Tests ----

describe('reading a cart', () => {
  it('returns an unknown cart as empty, with no expiry', async () => {
    const res = await getCart(guestKey());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      lines: [],
      lineCount: 0,
      total: { amount: 0, currency: 'IDR' },
      expiresAt: null,
    });
  });
});

describe('setting and removing lines', () => {
  it('creates the cart on the first write and shows the line at its current price', async () => {
    const [sku] = (await product(1)) as [string];
    const key = guestKey();
    const res = await put(key, sku, 2);
    expect(res.status).toBe(200);
    const cart = res.body as CartBody;
    expect(cart.lines).toEqual([
      expect.objectContaining({
        sku,
        quantity: 2,
        priceSnapshot: { amount: 10_000, currency: 'IDR' },
        price: { amount: 10_000, currency: 'IDR' },
        priceChanged: false,
        skuName: 'Variant 0',
      }),
    ]);
    expect(cart.total).toEqual({ amount: 20_000, currency: 'IDR' });
    expect((await getCart(key)).body).toEqual(cart);
  });

  it('changes a quantity, removes with 0 and with DELETE, and removing from a missing cart is fine', async () => {
    const [a, b] = (await product(2)) as [string, string];
    const key = guestKey();
    await put(key, a, 1);
    await put(key, b, 1);
    expect(((await put(key, a, 4)).body as CartBody).lines.find((l) => l.sku === a)?.quantity).toBe(4);
    expect(((await put(key, a, 0)).body as CartBody).lines.map((l) => l.sku)).toEqual([b]);
    const del = await request(h.http())
      .delete(`/internal/v1/carts/${key}/lines/${b}`)
      .set('x-sagamart-identity', h.token(guest))
      .expect(200);
    conforms('DELETE', LINE, del);
    expect((del.body as CartBody).lineCount).toBe(0);
    await request(h.http())
      .delete(`/internal/v1/carts/${guestKey()}/lines/${b}`)
      .set('x-sagamart-identity', h.token(guest))
      .expect(200);
  });

  it('flags a price that changed since the line was added, and totals at the current price', async () => {
    const [sku] = (await product(1)) as [string];
    const key = guestKey();
    await put(key, sku, 3);
    await patchSku(sku, { price: { amount: 12_500, currency: 'IDR' } });
    const cart = (await getCart(key)).body as CartBody;
    expect(cart.lines[0]).toMatchObject({ priceChanged: true, price: { amount: 12_500 } });
    expect(cart.total.amount).toBe(37_500);
    // Changing the quantity takes a new snapshot.
    expect(((await put(key, sku, 1)).body as CartBody).lines[0]?.priceChanged).toBe(false);
  });

  it('shows a line whose SKU was archived with a null price, outside the total', async () => {
    const [keep, gone] = (await product(2)) as [string, string];
    const key = guestKey();
    await put(key, keep, 1);
    await put(key, gone, 1);
    await patchSku(gone, { status: 'ARCHIVED' });
    const cart = (await getCart(key)).body as CartBody;
    expect(cart.lines.find((l) => l.sku === gone)).toMatchObject({ price: null, priceChanged: false });
    expect(cart.total.amount).toBe(10_000);
  });

  it.each([
    ['an unknown SKU', () => Promise.resolve('NO-SUCH-SKU')],
    [
      'an archived SKU',
      async () => {
        const [, archived] = (await product(2)) as [string, string];
        await patchSku(archived, { status: 'ARCHIVED' });
        return archived;
      },
    ],
    ['a SKU of a draft product', async () => ((await product(1, 'DRAFT')) as [string])[0]],
  ])('refuses to add %s with 404 SKU_NOT_FOUND', async (_name, sku) => {
    const res = await put(guestKey(), await sku(), 1);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'SKU_NOT_FOUND' });
  });

  it.each([
    ['quantity 101', 101],
    ['a negative quantity', -1],
    ['a fractional quantity', 1.5],
    ['a string', '2'],
  ])('rejects %s as 400', async (_name, quantity) => {
    const [sku] = (await product(1)) as [string];
    const res = await put(guestKey(), sku, quantity);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('the 50-line limit and concurrent writes', () => {
  it('refuses a 51st line with 422 CART_LINE_LIMIT', async () => {
    const skus = await product(51);
    const key = guestKey();
    for (const sku of skus.slice(0, 50)) expect((await put(key, sku, 1)).status).toBe(200);
    const res = await put(key, skus[50]!, 1);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'CART_LINE_LIMIT' });
  });

  it('lands every concurrent add of different SKUs, as from several tabs', async () => {
    const skus = await product(5);
    const key = guestKey();
    const results = await Promise.all(skus.map((sku) => put(key, sku, 1)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(((await getCart(key)).body as CartBody).lineCount).toBe(5);
  });

  it('checks the limit against the cart as it really is when adds race', async () => {
    const skus = await product(53);
    const key = guestKey();
    for (const sku of skus.slice(0, 48)) await put(key, sku, 1);
    const results = await Promise.all(skus.slice(48).map((sku) => put(key, sku, 1)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 422, 422, 422]);
    expect(((await getCart(key)).body as CartBody).lineCount).toBe(50);
  });
});

describe('expiry', () => {
  it('sets one TTL on the cart item, 7 days out, and refreshes it on every write', async () => {
    const [a, b] = (await product(2)) as [string, string];
    const key = guestKey();
    await put(key, a, 1);
    const first = Number((await rawItem(key))?.ttl?.N);
    const week = 7 * 24 * 3600;
    expect(Math.abs(first - (Math.floor(Date.now() / 1000) + week))).toBeLessThan(10);
    // Backdate the item, as if the line had been added days ago, then touch another line.
    await ddb.send(
      new UpdateItemCommand({
        TableName: 'carts',
        Key: { pk: { S: `CART#${key}` } },
        UpdateExpression: 'SET #t = :t',
        ExpressionAttributeNames: { '#t': 'ttl' },
        ExpressionAttributeValues: { ':t': { N: String(first - 6 * 24 * 3600) } },
      }),
    );
    await put(key, b, 1);
    const item = await rawItem(key);
    expect(Number(item?.ttl?.N)).toBeGreaterThanOrEqual(first);
    expect(Object.keys(item?.lines?.M ?? {}).sort()).toEqual([a, b].sort()); // one item, every line in it
  });

  it('reads an expired cart as empty, and the next write starts a fresh cart', async () => {
    const [a, b] = (await product(2)) as [string, string];
    const key = guestKey();
    await put(key, a, 1);
    await ddb.send(
      new UpdateItemCommand({
        TableName: 'carts',
        Key: { pk: { S: `CART#${key}` } },
        UpdateExpression: 'SET #t = :t',
        ExpressionAttributeNames: { '#t': 'ttl' },
        ExpressionAttributeValues: { ':t': { N: String(Math.floor(Date.now() / 1000) - 60) } },
      }),
    );
    expect(((await getCart(key)).body as CartBody).lineCount).toBe(0);
    const res = await put(key, b, 1);
    expect(res.status).toBe(200);
    expect((res.body as CartBody).lines.map((l) => l.sku)).toEqual([b]);
  });
});

describe('who may use a cart', () => {
  it('lets a buyer use their own user cart, and nobody else', async () => {
    const [sku] = (await product(1)) as [string];
    const mine = `user:${userId}`;
    expect((await put(mine, sku, 1, { roles: ['buyer'] })).status).toBe(200);
    const other = await getCart(mine, { roles: ['buyer'], subject: '0199f2e0-0000-7000-8000-000000000999' });
    expect(other.status).toBe(403);
    conforms('GET', CART, other);
    expect((await getCart(mine, guest)).status).toBe(403);
  });

  it('rejects a malformed cart key or SKU with 400', async () => {
    const bad = await getCart('guest:not-a-hash');
    expect(bad.status).toBe(400);
    conforms('GET', CART, bad);
    expect((await put(guestKey(), 'HAS%20SPACE', 1)).status).toBe(400);
  });
});

describe('when DynamoDB is down', () => {
  it('answers 503 with Retry-After, and browsing still works', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.forRoot({
          config: h.config({
            CATALOG_DYNAMODB_ENDPOINT: 'http://127.0.0.1:1',
            CATALOG_DYNAMODB_CREATE_TABLE: 'false',
          }),
          logDestination: new PassThrough(),
        }),
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    try {
      const server = app.getHttpServer() as Server;
      const res = await request(server)
        .get(`/internal/v1/carts/${guestKey()}`)
        .set('x-sagamart-identity', h.token(guest))
        .expect(503);
      conforms('GET', CART, res);
      expect(res.body).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
      expect(res.headers['retry-after']).toBe('1');
      await request(server)
        .get('/internal/v1/categories')
        .set('x-sagamart-identity', h.token(guest))
        .expect(200);
    } finally {
      await app.close();
    }
  });
});
