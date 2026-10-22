import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Idempotency } from '../idempotency.js';
import { Contract } from '../testing/contract.js';
import { startHarness } from '../testing/harness.js';
import type { Harness } from '../testing/harness.js';

let h: Harness;
let contract: Contract;

beforeAll(async () => {
  [h, contract] = await Promise.all([startHarness(), Contract.load('catalog-internal-v1.yaml')]);
});

afterAll(async () => {
  await h.close();
});

const adminId = '0199f2e0-0000-7000-8000-00000000a001';
let n = 0;
const unique = (prefix: string): string => `${prefix}-${String(++n)}-${randomUUID().slice(0, 8)}`;
const key = (): string => `key-${randomUUID()}`;

type Method = 'get' | 'post' | 'patch';

function call(method: Method, path: string, opts: { roles?: string[]; subject?: string } = {}) {
  const agent = request(h.http());
  return agent[method](path).set(
    'x-sagamart-identity',
    h.token({ roles: opts.roles ?? ['admin'], subject: opts.subject ?? adminId }),
  );
}

/** Asserts the response matches the contract for `template` (the spec's path with {params}). */
function conforms(method: Method, template: string, res: { status: number; body: unknown }): void {
  expect(contract.errors(method.toUpperCase(), template, res.status, res.body)).toEqual([]);
}

async function createCategory(body: Record<string, unknown> = {}) {
  const res = await call('post', '/internal/v1/admin/categories')
    .set('Idempotency-Key', key())
    .send({ slug: unique('cat'), name: 'Kaos', ...body })
    .expect(201);
  return res.body as { id: string; slug: string };
}

interface AdminSku {
  sku: string;
  price: { amount: number };
  status: string;
  version: number;
}
interface AdminProduct {
  id: string;
  slug: string;
  status: string;
  version: number;
  skus: AdminSku[];
}

const productBody = (categoryId: string, overrides: Record<string, unknown> = {}) => {
  const slug = unique('p');
  return {
    slug,
    name: 'Kaos Polos',
    description: 'Katun',
    categoryId,
    imageUrls: ['https://images.sagamart.dev/kaos.jpg'],
    status: 'ACTIVE',
    skus: [
      { sku: `${slug}-S`.toUpperCase(), name: 'S', price: { amount: 79_000, currency: 'IDR' } },
      { sku: `${slug}-M`.toUpperCase(), name: 'M', price: { amount: 69_000, currency: 'IDR' } },
      { sku: `${slug}-L`.toUpperCase(), name: 'L', price: { amount: 89_000, currency: 'IDR' } },
    ],
    ...overrides,
  };
};

async function createProduct(
  categoryId: string,
  overrides: Record<string, unknown> = {},
): Promise<AdminProduct> {
  const res = await call('post', '/internal/v1/admin/products')
    .set('Idempotency-Key', key())
    .send(productBody(categoryId, overrides))
    .expect(201);
  return res.body as AdminProduct;
}

/** The public view: fromPrice in the listing, or null when the product isn't listed. */
async function listedPrice(product: { slug: string }): Promise<number | null> {
  const res = await call('get', `/internal/v1/products/${product.slug}`, { roles: ['buyer'] });
  return res.status === 200 ? (res.body as { fromPrice: { amount: number } }).fromPrice.amount : null;
}

const minPrice = async (id: string): Promise<string | null> =>
  (await h.sql.query<{ min_price: string | null }>(`SELECT min_price FROM products WHERE id = $1`, [id]))
    .rows[0]!.min_price;

describe('admin routes', () => {
  it('require the admin role', async () => {
    const res = await call('get', '/internal/v1/admin/products', { roles: ['buyer'] }).expect(403);
    expect(res.body).toMatchObject({ code: 'FORBIDDEN' });
    await call('post', '/internal/v1/admin/products', { roles: ['buyer'] })
      .set('Idempotency-Key', key())
      .send({})
      .expect(403);
  });
});

describe('categories', () => {
  it('creates a category with an ETag, and rejects a taken slug or unknown parent', async () => {
    const slug = unique('cat');
    const res = await call('post', '/internal/v1/admin/categories')
      .set('Idempotency-Key', key())
      .send({ slug, name: 'Pakaian' })
      .expect(201);
    conforms('post', '/internal/v1/admin/categories', res);
    expect(res.headers.etag).toBe('"1"');
    expect(res.body).toMatchObject({ slug, name: 'Pakaian', parentId: null, position: 0 });
    expect((res.body as { id: string }).id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/); // UUIDv7

    const taken = await call('post', '/internal/v1/admin/categories')
      .set('Idempotency-Key', key())
      .send({ slug, name: 'x' })
      .expect(409);
    conforms('post', '/internal/v1/admin/categories', taken);
    expect(taken.body).toMatchObject({ code: 'SLUG_TAKEN' });

    const orphan = await call('post', '/internal/v1/admin/categories')
      .set('Idempotency-Key', key())
      .send({ slug: unique('cat'), name: 'x', parentId: randomUUID() })
      .expect(422);
    expect(orphan.body).toMatchObject({ code: 'CATEGORY_NOT_FOUND' });
  });

  it('edits with If-Match: 428 without it, 412 with a stale version', async () => {
    const cat = await createCategory();
    const path = `/internal/v1/admin/categories/${cat.id}`;
    const missing = await call('patch', path).send({ name: 'Baru' }).expect(428);
    conforms('patch', '/internal/v1/admin/categories/{id}', missing);
    const ok = await call('patch', path)
      .set('If-Match', '"1"')
      .send({ name: 'Baru', position: 3 })
      .expect(200);
    conforms('patch', '/internal/v1/admin/categories/{id}', ok);
    expect(ok.headers.etag).toBe('"2"');
    expect(ok.body).toMatchObject({ name: 'Baru', position: 3 });
    const stale = await call('patch', path).set('If-Match', '"1"').send({ name: 'Lagi' }).expect(412);
    conforms('patch', '/internal/v1/admin/categories/{id}', stale);
    expect(stale.body).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: 2 });
    await call('patch', `/internal/v1/admin/categories/${randomUUID()}`)
      .set('If-Match', '"1"')
      .send({ name: 'x' })
      .expect(404);
  });

  it('refuses to make a category its own ancestor', async () => {
    const top = await createCategory();
    const mid = await createCategory({ parentId: top.id });
    const leaf = await createCategory({ parentId: mid.id });
    const cycle = await call('patch', `/internal/v1/admin/categories/${top.id}`)
      .set('If-Match', '"1"')
      .send({ parentId: leaf.id })
      .expect(422);
    conforms('patch', '/internal/v1/admin/categories/{id}', cycle);
    expect(cycle.body).toMatchObject({ code: 'CATEGORY_CYCLE' });
    await call('patch', `/internal/v1/admin/categories/${top.id}`)
      .set('If-Match', '"1"')
      .send({ parentId: top.id })
      .expect(422);
    // Moving a leaf elsewhere is fine.
    await call('patch', `/internal/v1/admin/categories/${leaf.id}`)
      .set('If-Match', '"1"')
      .send({ parentId: null })
      .expect(200);
  });
});

describe('products', () => {
  it('creates an active product with its SKUs in the order given, visible to buyers at its lowest price', async () => {
    const cat = await createCategory();
    const body = productBody(cat.id);
    const res = await call('post', '/internal/v1/admin/products')
      .set('Idempotency-Key', key())
      .send(body)
      .expect(201);
    conforms('post', '/internal/v1/admin/products', res);
    expect(res.headers.etag).toBe('"1"');
    const p = res.body as AdminProduct;
    expect(p).toMatchObject({ slug: body.slug, status: 'ACTIVE', version: 1, category: { id: cat.id } });
    expect(p.skus.map((s) => s.sku)).toEqual(body.skus.map((s) => s.sku));
    expect(p.skus.every((s) => s.status === 'ACTIVE' && s.version === 1)).toBe(true);
    expect(await listedPrice(p)).toBe(69_000);
    const detail = await call('get', `/internal/v1/products/${p.slug}`, { roles: ['buyer'] }).expect(200);
    expect((detail.body as { skus: { sku: string }[] }).skus.map((s) => s.sku)).toEqual(
      body.skus.map((s) => s.sku),
    );
  });

  it('keeps a draft hidden until it is activated', async () => {
    const cat = await createCategory();
    const p = await createProduct(cat.id, { status: 'DRAFT' });
    expect(await listedPrice(p)).toBeNull();
    const res = await call('patch', `/internal/v1/admin/products/${p.id}`)
      .set('If-Match', '"1"')
      .send({ status: 'ACTIVE' })
      .expect(200);
    conforms('patch', '/internal/v1/admin/products/{id}', res);
    expect(res.headers.etag).toBe('"2"');
    expect(await listedPrice(p)).toBe(69_000);
  });

  it.each([
    [
      '101 SKUs',
      (b: ReturnType<typeof productBody>) => ({
        ...b,
        skus: Array.from({ length: 101 }, (_, i) => ({ ...b.skus[0], sku: `X-${String(i)}` })),
      }),
    ],
    ['a repeated SKU', (b: ReturnType<typeof productBody>) => ({ ...b, skus: [b.skus[0], b.skus[0]] })],
    [
      'a non-HTTP image URL',
      (b: ReturnType<typeof productBody>) => ({ ...b, imageUrls: ['javascript:alert(1)'] }),
    ],
    [
      'a zero price',
      (b: ReturnType<typeof productBody>) => ({
        ...b,
        skus: [{ ...b.skus[0], price: { amount: 0, currency: 'IDR' } }],
      }),
    ],
    ['an unknown member', (b: ReturnType<typeof productBody>) => ({ ...b, featured: true })],
    ['status ARCHIVED', (b: ReturnType<typeof productBody>) => ({ ...b, status: 'ARCHIVED' })],
  ])('rejects %s as 400 VALIDATION_FAILED', async (_name, mutate) => {
    const cat = await createCategory();
    const res = await call('post', '/internal/v1/admin/products')
      .set('Idempotency-Key', key())
      .send(mutate(productBody(cat.id)))
      .expect(400);
    conforms('post', '/internal/v1/admin/products', res);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects a taken slug, a taken SKU and an unknown category', async () => {
    const cat = await createCategory();
    const first = await createProduct(cat.id);
    const post = (body: unknown) =>
      call('post', '/internal/v1/admin/products')
        .set('Idempotency-Key', key())
        .send(body as object);
    expect((await post({ ...productBody(cat.id), slug: first.slug }).expect(409)).body).toMatchObject({
      code: 'SLUG_TAKEN',
    });
    const b = productBody(cat.id);
    expect(
      (await post({ ...b, skus: [{ ...b.skus[0], sku: first.skus[0]!.sku }] }).expect(409)).body,
    ).toMatchObject({ code: 'SKU_TAKEN' });
    expect((await post(productBody(randomUUID())).expect(422)).body).toMatchObject({
      code: 'CATEGORY_NOT_FOUND',
    });
  });

  it('reads one product in any status with its ETag', async () => {
    const cat = await createCategory();
    const p = await createProduct(cat.id, { status: 'DRAFT' });
    const res = await call('get', `/internal/v1/admin/products/${p.id}`).expect(200);
    conforms('get', '/internal/v1/admin/products/{id}', res);
    expect(res.headers.etag).toBe('"1"');
    expect(res.body).toEqual(p);
    await call('get', `/internal/v1/admin/products/${randomUUID()}`).expect(404);
  });

  it('lists products in every status, newest first, filtered by status and paged', async () => {
    const cat = await createCategory();
    const drafts = [
      await createProduct(cat.id, { status: 'DRAFT' }),
      await createProduct(cat.id, { status: 'DRAFT' }),
    ];
    const all: AdminProduct[] = [];
    let cursor: string | null = null;
    do {
      const res = await call('get', '/internal/v1/admin/products')
        .query({ status: 'DRAFT', limit: 1, ...(cursor ? { cursor } : {}) })
        .expect(200);
      conforms('get', '/internal/v1/admin/products', res);
      const page = res.body as { items: AdminProduct[]; nextCursor: string | null };
      all.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(all.every((p) => p.status === 'DRAFT')).toBe(true);
    expect(all.map((p) => p.id).slice(0, 2)).toEqual([drafts[1]!.id, drafts[0]!.id]);
    const first = (
      await call('get', '/internal/v1/admin/products').query({ status: 'DRAFT', limit: 1 }).expect(200)
    ).body as { nextCursor: string };
    const mismatch = await call('get', '/internal/v1/admin/products')
      .query({ status: 'ACTIVE', cursor: first.nextCursor })
      .expect(400);
    expect(mismatch.body).toMatchObject({ code: 'CURSOR_MISMATCH' });
  });

  it('lets exactly one of two edits with the same version win', async () => {
    const cat = await createCategory();
    const p = await createProduct(cat.id);
    const edit = (name: string) =>
      call('patch', `/internal/v1/admin/products/${p.id}`).set('If-Match', '"1"').send({ name });
    const statuses = (await Promise.all([edit('A'), edit('B')])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 412]);
  });
});

describe('SKUs and min_price', () => {
  it('keeps the listed price at the lowest active SKU through adds, price changes and archiving', async () => {
    const cat = await createCategory();
    const p = await createProduct(cat.id); // S 79 000, M 69 000, L 89 000
    const added = await call('post', `/internal/v1/admin/products/${p.id}/skus`)
      .set('Idempotency-Key', key())
      .send({ sku: `${p.slug}-XS`.toUpperCase(), name: 'XS', price: { amount: 59_000, currency: 'IDR' } })
      .expect(201);
    conforms('post', '/internal/v1/admin/products/{id}/skus', added);
    expect(added.headers.etag).toBe('"1"');
    expect(await listedPrice(p)).toBe(59_000);

    const xs = (added.body as AdminSku).sku;
    const raised = await call('patch', `/internal/v1/admin/skus/${xs}`)
      .set('If-Match', '"1"')
      .send({ price: { amount: 99_000, currency: 'IDR' } })
      .expect(200);
    conforms('patch', '/internal/v1/admin/skus/{sku}', raised);
    expect(raised.headers.etag).toBe('"2"');
    expect(await listedPrice(p)).toBe(69_000);

    await call('patch', `/internal/v1/admin/skus/${p.skus[1]!.sku}`)
      .set('If-Match', '"1"')
      .send({ status: 'ARCHIVED' })
      .expect(200);
    expect(await listedPrice(p)).toBe(79_000);
  });

  it('refuses to archive the last active SKU of an active product, but allows it on a draft', async () => {
    const cat = await createCategory();
    const p = await createProduct(cat.id, {
      skus: [{ sku: unique('ONE').toUpperCase(), name: 'One', price: { amount: 1_000, currency: 'IDR' } }],
    });
    const res = await call('patch', `/internal/v1/admin/skus/${p.skus[0]!.sku}`)
      .set('If-Match', '"1"')
      .send({ status: 'ARCHIVED' })
      .expect(422);
    conforms('patch', '/internal/v1/admin/skus/{sku}', res);
    expect(res.body).toMatchObject({ code: 'PRODUCT_NEEDS_ACTIVE_SKU' });

    await call('patch', `/internal/v1/admin/products/${p.id}`)
      .set('If-Match', '"1"')
      .send({ status: 'DRAFT' })
      .expect(200);
    await call('patch', `/internal/v1/admin/skus/${p.skus[0]!.sku}`)
      .set('If-Match', '"1"')
      .send({ status: 'ARCHIVED' })
      .expect(200);
    expect(await minPrice(p.id)).toBeNull();
    const activate = await call('patch', `/internal/v1/admin/products/${p.id}`)
      .set('If-Match', '"2"')
      .send({ status: 'ACTIVE' })
      .expect(422);
    expect(activate.body).toMatchObject({ code: 'PRODUCT_NEEDS_ACTIVE_SKU' });
  });

  it('rejects a stale SKU edit with the current version, and an unknown SKU with 404', async () => {
    const cat = await createCategory();
    const p = await createProduct(cat.id);
    const path = `/internal/v1/admin/skus/${p.skus[0]!.sku}`;
    await call('patch', path).set('If-Match', '"1"').send({ name: 'Small' }).expect(200);
    const stale = await call('patch', path).set('If-Match', '"1"').send({ name: 'Smaller' }).expect(412);
    expect(stale.body).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: 2 });
    await call('patch', '/internal/v1/admin/skus/NO-SUCH-SKU')
      .set('If-Match', '"1"')
      .send({ name: 'x' })
      .expect(404);
  });

  it('holds a product to 100 SKUs even when adds race', async () => {
    const cat = await createCategory();
    const slug = unique('p');
    const skus = Array.from({ length: 98 }, (_, i) => ({
      sku: `${slug}-${String(i)}`.toUpperCase(),
      name: String(i),
      price: { amount: 1_000, currency: 'IDR' },
    }));
    const p = await createProduct(cat.id, { slug, skus });
    const add = (i: number) =>
      call('post', `/internal/v1/admin/products/${p.id}/skus`)
        .set('Idempotency-Key', key())
        .send({
          sku: `${slug}-EXTRA-${String(i)}`.toUpperCase(),
          name: 'Extra',
          price: { amount: 1_000, currency: 'IDR' },
        });
    const results = await Promise.all([0, 1, 2, 3, 4].map(add));
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 422, 422, 422]);
    expect(results.find((r) => r.status === 422)!.body).toMatchObject({ code: 'SKU_LIMIT' });
    const count = await h.sql.query<{ n: string }>(`SELECT count(*) AS n FROM skus WHERE product_id = $1`, [
      p.id,
    ]);
    expect(count.rows[0]!.n).toBe('100');
  });
});

describe('Idempotency-Key on admin POSTs', () => {
  const post = (k: string, body: unknown, subject = adminId) =>
    call('post', '/internal/v1/admin/products', { subject })
      .set('Idempotency-Key', k)
      .send(body as object);
  const records = async (k: string) =>
    Number(
      (await h.sql.query<{ n: string }>(`SELECT count(*) AS n FROM idempotency_keys WHERE key = $1`, [k]))
        .rows[0]!.n,
    );
  const products = async (slug: string) =>
    Number(
      (await h.sql.query<{ n: string }>(`SELECT count(*) AS n FROM products WHERE slug = $1`, [slug]))
        .rows[0]!.n,
    );

  it('is required', async () => {
    const cat = await createCategory();
    const res = await call('post', '/internal/v1/admin/products').send(productBody(cat.id)).expect(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ field: 'Idempotency-Key' }] });
  });

  it('replays the stored response, status and ETag for a retry with the same body', async () => {
    const cat = await createCategory();
    const k = key();
    const body = productBody(cat.id);
    const first = await post(k, body).expect(201);
    const retry = await post(k, { ...body }).expect(201);
    expect(retry.body).toEqual(first.body);
    expect(retry.headers.etag).toBe(first.headers.etag);
    expect(await products(body.slug)).toBe(1);
  });

  it('rejects the same key with a different body as 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const cat = await createCategory();
    const k = key();
    await post(k, productBody(cat.id)).expect(201);
    const res = await post(k, productBody(cat.id)).expect(422);
    conforms('post', '/internal/v1/admin/products', res);
    expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('keeps keys per user', async () => {
    const cat = await createCategory();
    const k = key();
    await post(k, productBody(cat.id)).expect(201);
    await post(k, productBody(cat.id), '0199f2e0-0000-7000-8000-00000000a002').expect(201);
  });

  it('runs concurrent duplicates once and gives them all the same response', async () => {
    const cat = await createCategory();
    const k = key();
    const body = productBody(cat.id);
    const results = await Promise.all(Array.from({ length: 5 }, () => post(k, body)));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(results.map((r) => (r.body as AdminProduct).id)).size).toBe(1);
    expect(await products(body.slug)).toBe(1);
  });

  it('leaves no record when the write fails, so the key can be used again', async () => {
    const cat = await createCategory();
    const taken = await createProduct(cat.id);
    const k = key();
    await post(k, { ...productBody(cat.id), slug: taken.slug }).expect(409);
    expect(await records(k)).toBe(0);
    await post(k, productBody(cat.id)).expect(201);
  });

  it('answers 409 REQUEST_IN_PROGRESS while the first request with the key is still running', async () => {
    const cat = await createCategory();
    const k = key();
    const holder = new pg.Client({ connectionString: h.dbUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`INSERT INTO idempotency_keys (owner, key, request_hash) VALUES ($1, $2, 'x')`, [
        adminId,
        k,
      ]);
      const res = await post(k, productBody(cat.id)).expect(409);
      conforms('post', '/internal/v1/admin/products', res);
      expect(res.body).toMatchObject({ code: 'REQUEST_IN_PROGRESS' });
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
  });

  it('forgets keys after 24 hours: the sweep deletes them, and an expired key runs the request again', async () => {
    const cat = await createCategory();
    const k = key();
    await post(k, productBody(cat.id)).expect(201);
    await h.sql.query(`UPDATE idempotency_keys SET created_at = now() - interval '25 hours' WHERE key = $1`, [
      k,
    ]);
    await post(k, productBody(cat.id)).expect(201); // a different body, yet not "reused": the old record expired

    const old = key();
    await post(old, productBody(cat.id)).expect(201);
    await h.sql.query(`UPDATE idempotency_keys SET created_at = now() - interval '25 hours' WHERE key = $1`, [
      old,
    ]);
    expect(await h.app.get(Idempotency).sweep()).toBe(1);
    expect(await records(old)).toBe(0);
    expect(await records(k)).toBe(1);
  });

  it('protects adding a SKU and creating a category too', async () => {
    const cat = await createCategory();
    const p = await createProduct(cat.id);
    const k = key();
    const sku = { sku: `${p.slug}-XL`.toUpperCase(), name: 'XL', price: { amount: 99_000, currency: 'IDR' } };
    const first = await call('post', `/internal/v1/admin/products/${p.id}/skus`)
      .set('Idempotency-Key', k)
      .send(sku)
      .expect(201);
    const again = await call('post', `/internal/v1/admin/products/${p.id}/skus`)
      .set('Idempotency-Key', k)
      .send(sku)
      .expect(201);
    expect(again.body).toEqual(first.body);

    const ck = key();
    const body = { slug: unique('cat'), name: 'Topi' };
    const c1 = await call('post', '/internal/v1/admin/categories')
      .set('Idempotency-Key', ck)
      .send(body)
      .expect(201);
    const c2 = await call('post', '/internal/v1/admin/categories')
      .set('Idempotency-Key', ck)
      .send(body)
      .expect(201);
    expect(c2.body).toEqual(c1.body);
    expect(c2.headers.etag).toBe('"1"');
  });
});
