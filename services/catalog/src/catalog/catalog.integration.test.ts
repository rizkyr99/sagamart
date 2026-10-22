import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

// ---- Seeding: straight into Postgres, as the admin API (#28's second half) would leave it ----

let n = 0;
const unique = (prefix: string): string => `${prefix}-${String(++n)}-${randomUUID().slice(0, 8)}`;

async function category(opts: { parentId?: string; position?: number; name?: string } = {}) {
  const id = randomUUID();
  const slug = unique('cat');
  await h.sql.query(
    `INSERT INTO categories (id, slug, name, parent_id, position) VALUES ($1, $2, $3, $4, $5)`,
    [id, slug, opts.name ?? slug, opts.parentId ?? null, opts.position ?? 0],
  );
  return { id, slug };
}

interface SeedSku {
  price: number;
  status?: 'ACTIVE' | 'ARCHIVED';
  name?: string;
}

async function product(opts: {
  categoryId: string;
  status?: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  createdAt?: string;
  id?: string;
  images?: string[];
  skus: SeedSku[];
}) {
  const id = opts.id ?? randomUUID();
  const slug = unique('p');
  const active = opts.skus.filter((s) => (s.status ?? 'ACTIVE') === 'ACTIVE').map((s) => s.price);
  const minPrice = active.length > 0 ? Math.min(...active) : null;
  await h.sql.query(
    `INSERT INTO products (id, slug, name, description, category_id, image_urls, status, min_price, created_at)
     VALUES ($1, $2, $3, 'desc', $4, $5, $6, $7, COALESCE($8::timestamptz, now()))`,
    [
      id,
      slug,
      `Product ${slug}`,
      opts.categoryId,
      opts.images ?? [],
      opts.status ?? 'ACTIVE',
      minPrice,
      opts.createdAt ?? null,
    ],
  );
  const skus: string[] = [];
  for (const [i, s] of opts.skus.entries()) {
    const sku = `${slug.toUpperCase()}-${String(i)}`;
    skus.push(sku);
    await h.sql.query(
      `INSERT INTO skus (sku, product_id, name, price_amount, status) VALUES ($1, $2, $3, $4, $5)`,
      [sku, id, s.name ?? `Variant ${String(i)}`, s.price, s.status ?? 'ACTIVE'],
    );
  }
  return { id, slug, skus };
}

// ---- HTTP helpers ----

const get = (path: string, query: Record<string, string | number> = {}) =>
  request(h.http()).get(path).query(query).set('x-sagamart-identity', h.token());

function expectContract(path: string, method: string, res: { status: number; body: unknown }): void {
  expect(contract.errors(method, path, res.status, res.body)).toEqual([]);
}

interface Summary {
  id: string;
  slug: string;
  fromPrice: { amount: number };
  skus: string[];
}

async function listPage(query: Record<string, string | number>) {
  const res = await get('/internal/v1/products', query).expect(200);
  expectContract('/internal/v1/products', 'GET', res);
  return res.body as { items: Summary[]; nextCursor: string | null };
}

/** Follows nextCursor to the end, returning every item in order. */
async function listAll(query: Record<string, string | number>): Promise<Summary[]> {
  const items: Summary[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 100; pages++) {
    const page = await listPage(cursor === null ? query : { ...query, cursor });
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor === null) return items;
  }
  throw new Error('pagination did not end');
}

// ---- Tests ----

describe('GET /internal/v1/categories', () => {
  it('lists every category, flat, ordered by position', async () => {
    const parent = await category({ position: 1 });
    const child = await category({ parentId: parent.id, position: 0 });
    const res = await get('/internal/v1/categories').expect(200);
    expectContract('/internal/v1/categories', 'GET', res);
    const items = (res.body as { items: { id: string; parentId: string | null; position: number }[] }).items;
    expect(items).toContainEqual(expect.objectContaining({ id: child.id, parentId: parent.id, position: 0 }));
    const positions = items.map((c) => c.position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('needs an identity like every internal route', async () => {
    await request(h.http()).get('/internal/v1/categories').expect(401);
  });
});

describe('GET /internal/v1/products', () => {
  it('lists active products newest first with the contract shape; drafts, archived products and archived SKUs stay out', async () => {
    const cat = await category();
    const older = await product({
      categoryId: cat.id,
      createdAt: '2026-10-01T00:00:00Z',
      images: ['https://images.sagamart.dev/a.jpg', 'https://images.sagamart.dev/b.jpg'],
      skus: [{ price: 90_000 }, { price: 50_000, status: 'ARCHIVED' }, { price: 70_000 }],
    });
    const newer = await product({
      categoryId: cat.id,
      createdAt: '2026-10-02T00:00:00Z',
      skus: [{ price: 10_000 }],
    });
    await product({ categoryId: cat.id, status: 'DRAFT', skus: [{ price: 1_000 }] });
    await product({ categoryId: cat.id, status: 'ARCHIVED', skus: [{ price: 1_000 }] });

    const page = await listPage({ category: cat.slug });
    expect(page.items.map((p) => p.id)).toEqual([newer.id, older.id]);
    expect(page.nextCursor).toBeNull();
    expect(page.items[1]).toMatchObject({
      slug: older.slug,
      category: { id: cat.id, slug: cat.slug },
      imageUrl: 'https://images.sagamart.dev/a.jpg',
      fromPrice: { amount: 70_000, currency: 'IDR' },
      skus: [older.skus[0], older.skus[2]],
    });
    expect(page.items[0]).toMatchObject({ imageUrl: null });
  });

  it('pages through every product exactly once, even with equal and same-millisecond timestamps', async () => {
    const cat = await category();
    const created: string[] = [];
    // Microseconds apart (a JavaScript Date would round these to one value), plus exact ties broken by id.
    for (const t of ['00.000001', '00.000002', '00.000002', '00.000002', '00.000003', '01.000000']) {
      created.push(
        (await product({ categoryId: cat.id, createdAt: `2026-10-03T00:00:${t}Z`, skus: [{ price: 5_000 }] }))
          .id,
      );
    }
    const all = await listAll({ category: cat.slug, limit: 1 });
    expect(all.map((p) => p.id).sort()).toEqual([...created].sort());
    expect(all[0]!.id).toBe(created[5]);
    expect(all[5]!.id).toBe(created[0]);
  });

  it('keeps later pages stable while newer products are added', async () => {
    const cat = await category();
    for (let i = 0; i < 4; i++)
      await product({
        categoryId: cat.id,
        createdAt: `2026-10-04T00:00:0${String(i)}Z`,
        skus: [{ price: 1_000 }],
      });
    const first = await listPage({ category: cat.slug, limit: 2 });
    await product({ categoryId: cat.id, skus: [{ price: 1_000 }] }); // newest of all: belongs on page one, not page two
    const second = await listPage({ category: cat.slug, limit: 2, cursor: first.nextCursor! });
    const seen = [...first.items, ...second.items].map((p) => p.id);
    expect(new Set(seen).size).toBe(4);
    expect(second.nextCursor).toBeNull();
  });

  it('returns a null nextCursor when the last page is exactly full', async () => {
    const cat = await category();
    for (let i = 0; i < 2; i++) await product({ categoryId: cat.id, skus: [{ price: 1_000 }] });
    expect((await listPage({ category: cat.slug, limit: 2 })).nextCursor).toBeNull();
  });

  it.each([
    ['price_asc', [1, 2, 3, 4, 5]],
    ['price_desc', [5, 4, 3, 2, 1]],
  ] as const)('sorts by %s across pages, ties broken by id', async (sort, ranks) => {
    const cat = await category();
    // Prices 1 000 to 3 000, with two pairs of equal prices.
    const prices = [3_000, 1_000, 2_000, 2_000, 1_000];
    const ids: string[] = [];
    for (const price of prices) ids.push((await product({ categoryId: cat.id, skus: [{ price }] })).id);
    const all = await listAll({ category: cat.slug, sort, limit: 2 });
    expect(all.map((p) => p.fromPrice.amount)).toEqual(
      ranks.map((r) => [...prices].sort((a, b) => a - b)[r - 1]),
    );
    expect(new Set(all.map((p) => p.id)).size).toBe(5);
    // Equal prices come in id order, ascending or descending with the sort.
    const equal = all.filter((p) => p.fromPrice.amount === 2_000).map((p) => p.id);
    expect(equal).toEqual(
      [...equal].sort((a, b) => (sort === 'price_asc' ? a.localeCompare(b) : b.localeCompare(a))),
    );
  });

  it('filters by price on the lowest active SKU price, inclusive', async () => {
    const cat = await category();
    const cheap = await product({ categoryId: cat.id, skus: [{ price: 10_000 }, { price: 99_000 }] });
    const mid = await product({ categoryId: cat.id, skus: [{ price: 50_000 }] });
    await product({ categoryId: cat.id, skus: [{ price: 100_000 }] });
    const all = await listAll({ category: cat.slug, minPrice: 10_000, maxPrice: 50_000, sort: 'price_asc' });
    expect(all.map((p) => p.id)).toEqual([cheap.id, mid.id]);
  });

  it('includes products in child categories when filtering by a parent', async () => {
    const parent = await category();
    const child = await category({ parentId: parent.id });
    const grandchild = await category({ parentId: child.id });
    const sibling = await category();
    const inParent = await product({ categoryId: parent.id, skus: [{ price: 1_000 }] });
    const inGrandchild = await product({ categoryId: grandchild.id, skus: [{ price: 1_000 }] });
    await product({ categoryId: sibling.id, skus: [{ price: 1_000 }] });
    const ids = (await listAll({ category: parent.slug })).map((p) => p.id);
    expect(ids.sort()).toEqual([inParent.id, inGrandchild.id].sort());
    expect((await listAll({ category: child.slug })).map((p) => p.id)).toEqual([inGrandchild.id]);
  });

  it('returns an empty page for a category that does not exist', async () => {
    expect(await listPage({ category: 'no-such-category' })).toEqual({ items: [], nextCursor: null });
  });

  it('lists across all categories without a filter, in order and without repeats', async () => {
    const all = await listAll({ limit: 7 });
    expect(new Set(all.map((p) => p.id)).size).toBe(all.length);
    expect(all.length).toBeGreaterThan(10);
  });

  it('rejects a cursor reused with different filters as 400 CURSOR_MISMATCH', async () => {
    const cat = await category();
    for (let i = 0; i < 2; i++) await product({ categoryId: cat.id, skus: [{ price: 1_000 }] });
    const { nextCursor } = await listPage({ category: cat.slug, limit: 1 });
    const res = await get('/internal/v1/products', {
      category: cat.slug,
      limit: 1,
      sort: 'price_asc',
      cursor: nextCursor!,
    }).expect(400);
    expectContract('/internal/v1/products', 'GET', res);
    expect(res.body).toMatchObject({ code: 'CURSOR_MISMATCH' });
    // A different page size is the same query: the cursor still works.
    await get('/internal/v1/products', { category: cat.slug, limit: 5, cursor: nextCursor! }).expect(200);
  });

  it('rejects a malformed cursor or bad parameters as 400 VALIDATION_FAILED', async () => {
    const bad = await get('/internal/v1/products', { cursor: 'eyJub3QiOiJhIGN1cnNvciJ9' }).expect(400);
    expectContract('/internal/v1/products', 'GET', bad);
    expect(bad.body).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ field: 'cursor' }] });
    const limit = await get('/internal/v1/products', { limit: 51 }).expect(400);
    expect(limit.body).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ field: 'limit' }] });
  });
});

describe('GET /internal/v1/products/{slug}', () => {
  it('returns an active product with its active SKUs and prices', async () => {
    const cat = await category();
    const p = await product({
      categoryId: cat.id,
      images: ['https://images.sagamart.dev/x.jpg'],
      skus: [
        { price: 79_000, name: 'M / Hitam' },
        { price: 10_000, status: 'ARCHIVED' },
        { price: 89_000, name: 'XL / Hitam' },
      ],
    });
    const res = await get(`/internal/v1/products/${p.slug}`).expect(200);
    expectContract('/internal/v1/products/{slug}', 'GET', res);
    expect(res.body).toEqual({
      id: p.id,
      slug: p.slug,
      name: `Product ${p.slug}`,
      description: 'desc',
      category: { id: cat.id, slug: cat.slug, name: cat.slug },
      imageUrls: ['https://images.sagamart.dev/x.jpg'],
      fromPrice: { amount: 79_000, currency: 'IDR' },
      skus: [
        { sku: p.skus[0], name: 'M / Hitam', price: { amount: 79_000, currency: 'IDR' } },
        { sku: p.skus[2], name: 'XL / Hitam', price: { amount: 89_000, currency: 'IDR' } },
      ],
    });
  });

  it.each([
    ['a draft product', 'DRAFT'],
    ['an archived product', 'ARCHIVED'],
  ] as const)('hides %s as 404', async (_name, status) => {
    const cat = await category();
    const p = await product({ categoryId: cat.id, status, skus: [{ price: 1_000 }] });
    const res = await get(`/internal/v1/products/${p.slug}`).expect(404);
    expectContract('/internal/v1/products/{slug}', 'GET', res);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('is 404 for an unknown slug or one that could never exist', async () => {
    await get('/internal/v1/products/no-such-product').expect(404);
    await get('/internal/v1/products/Not%20A%20Slug').expect(404);
  });
});

describe('POST /internal/v1/skus:lookup', () => {
  const lookup = (body: unknown) =>
    request(h.http())
      .post('/internal/v1/skus:lookup')
      .set('x-sagamart-identity', h.token())
      .send(body as object);

  it('returns known SKUs in request order with product and SKU status, omitting unknown ones', async () => {
    const cat = await category();
    const active = await product({
      categoryId: cat.id,
      skus: [
        { price: 79_000, name: 'M' },
        { price: 5_000, status: 'ARCHIVED' },
      ],
    });
    const draft = await product({ categoryId: cat.id, status: 'DRAFT', skus: [{ price: 3_000 }] });
    const res = await lookup({ skus: [draft.skus[0], 'NOPE-404', active.skus[1], active.skus[0]] }).expect(
      200,
    );
    expectContract('/internal/v1/skus:lookup', 'POST', res);
    expect(res.body).toEqual({
      items: [
        {
          sku: draft.skus[0],
          name: 'Variant 0',
          price: { amount: 3_000, currency: 'IDR' },
          status: 'ACTIVE',
          productId: draft.id,
          productSlug: draft.slug,
          productName: `Product ${draft.slug}`,
          productStatus: 'DRAFT',
        },
        expect.objectContaining({ sku: active.skus[1], status: 'ARCHIVED', productStatus: 'ACTIVE' }),
        expect.objectContaining({
          sku: active.skus[0],
          name: 'M',
          price: { amount: 79_000, currency: 'IDR' },
        }),
      ],
    });
  });

  it.each([
    ['no body', undefined],
    ['an empty list', { skus: [] }],
    ['101 SKUs', { skus: Array.from({ length: 101 }, (_, i) => `SKU-${String(i)}`) }],
    ['duplicates', { skus: ['A-1', 'A-1'] }],
    ['a SKU with whitespace', { skus: ['A 1'] }],
    ['an unknown member', { skus: ['A-1'], extra: true }],
  ])('rejects %s as 400 VALIDATION_FAILED', async (_name, body) => {
    const res = await lookup(body).expect(400);
    expectContract('/internal/v1/skus:lookup', 'POST', res);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
