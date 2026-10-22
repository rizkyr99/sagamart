import { Injectable } from '@nestjs/common';
import { ProblemError, problem, uuidv7 } from '@sagamart/node-common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { pgError } from '../idempotency.js';
import type {
  CategoryCreate,
  CategoryPatch,
  ProductCreate,
  ProductPatch,
  SkuCreate,
  SkuPatch,
} from './admin.schemas.js';
import { CREATED_KEY } from './catalog.queries.js';
import type { Category, CategoryRef, Money } from './catalog.queries.js';
import type { CursorPosition } from './cursor.js';

export interface AdminSku {
  sku: string;
  productId: string;
  name: string;
  price: Money;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminProduct {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: CategoryRef;
  imageUrls: string[];
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  skus: AdminSku[];
}

/** A resource and its version, which the controller sends as the ETag. */
export interface Versioned<T> {
  value: T;
  version: number;
}

/** A transaction, or the DataSource for a read outside one. */
type Db = Pick<EntityManager, 'query'>;

/** RFC-0005 §4.3: one product's stock must fit in one GetStockLevels call. */
export const MAX_SKUS_PER_PRODUCT = 100;

const fail = (
  status: number,
  code: string,
  detail: string,
  extensions?: Record<string, unknown>,
): ProblemError => new ProblemError(problem({ status, code, detail, ...(extensions ? { extensions } : {}) }));

const notFound = (what: string): ProblemError => fail(404, 'NOT_FOUND', `No such ${what}.`);
const needsActiveSku = (): ProblemError =>
  fail(422, 'PRODUCT_NEEDS_ACTIVE_SKU', 'An active product needs at least one active SKU.');
const versionConflict = (currentVersion: number): ProblemError =>
  fail(412, 'VERSION_CONFLICT', 'It changed since you read it. Read it again, then retry.', {
    currentVersion,
  });

/** Constraint violations that are the caller's to fix, as the contract names them. */
const CONSTRAINTS: Readonly<Record<string, () => ProblemError>> = {
  categories_slug_key: () => fail(409, 'SLUG_TAKEN', 'Another category has this slug.'),
  products_slug_key: () => fail(409, 'SLUG_TAKEN', 'Another product has this slug.'),
  skus_pkey: () => fail(409, 'SKU_TAKEN', 'A SKU with this code already exists.'),
  products_category_id_fkey: () => fail(422, 'CATEGORY_NOT_FOUND', 'No category has this id.'),
  categories_parent_id_fkey: () => fail(422, 'CATEGORY_NOT_FOUND', 'No category has this parent id.'),
  // Backstop for the explicit checks below (RFC-0005 §4.3).
  active_has_price: needsActiveSku,
};

async function translated<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    const { constraint } = pgError(err);
    const known = constraint === undefined ? undefined : CONSTRAINTS[constraint];
    throw known ? known() : err;
  }
}

const iso = (value: Date | string): string => new Date(value).toISOString();
const money = (amount: string | number): Money => ({ amount: Number(amount), currency: 'IDR' });

interface SkuRow {
  sku: string;
  product_id: string;
  name: string;
  price_amount: string | number;
  status: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

const toSku = (r: SkuRow): AdminSku => ({
  sku: r.sku,
  productId: r.product_id,
  name: r.name,
  price: money(r.price_amount),
  status: r.status,
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

const ADMIN_PRODUCT = `
  SELECT p.id, p.slug, p.name, p.description, p.image_urls, p.status, p.version, p.created_at, p.updated_at,
         ${CREATED_KEY} AS created_key, c.id AS category_id, c.slug AS category_slug, c.name AS category_name,
         COALESCE((SELECT json_agg(json_build_object(
                     'sku', s.sku, 'product_id', s.product_id, 'name', s.name, 'price_amount', s.price_amount,
                     'status', s.status, 'version', s.version, 'created_at', s.created_at, 'updated_at', s.updated_at)
                   ORDER BY s.created_at, s.sku)
                     FROM skus s WHERE s.product_id = p.id), '[]') AS skus
    FROM products p JOIN categories c ON c.id = p.category_id`;

interface ProductRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  image_urls: string[];
  status: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  created_key: string;
  category_id: string;
  category_slug: string;
  category_name: string;
  skus: SkuRow[];
}

interface CategoryRow {
  id: string;
  slug: string;
  name: string;
  parent_id: string | null;
  position: number;
  version: number;
}

const toProduct = (r: ProductRow): AdminProduct => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  description: r.description,
  category: { id: r.category_id, slug: r.category_slug, name: r.category_name },
  imageUrls: r.image_urls,
  status: r.status,
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  skus: r.skus.map(toSku),
});

/**
 * Catalog's write side (FR-11). Every SKU change locks its product row first, which serialises the SKU limit and
 * the `min_price` recompute per product and keeps one lock order (product, then SKU), so writes can't deadlock.
 */
@Injectable()
export class CatalogAdmin {
  constructor(private readonly db: DataSource) {}

  // ---- Reads ----

  async product(id: string, db: Db = this.db): Promise<Versioned<AdminProduct> | null> {
    const rows: ProductRow[] = await db.query(`${ADMIN_PRODUCT} WHERE p.id = $1`, [id]);
    const row = rows[0];
    return row ? { value: toProduct(row), version: row.version } : null;
  }

  /** Newest first, `limit` + 1 rows (the extra one only signals a next page). */
  async products(filter: {
    status: string | null;
    after: CursorPosition | null;
    limit: number;
  }): Promise<{ product: AdminProduct; position: CursorPosition }[]> {
    const params: unknown[] = [];
    const param = (value: unknown): string => {
      params.push(value);
      return `$${String(params.length)}`;
    };
    const where: string[] = [];
    if (filter.status !== null) where.push(`p.status = ${param(filter.status)}`);
    if (filter.after !== null && 't' in filter.after) {
      where.push(
        `(p.created_at, p.id) < (${param(filter.after.t)}::timestamptz, ${param(filter.after.id)}::uuid)`,
      );
    }
    const rows: ProductRow[] = await this.db.query(
      `${ADMIN_PRODUCT} ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY p.created_at DESC, p.id DESC LIMIT ${param(filter.limit + 1)}`,
      params,
    );
    return rows.map((r) => ({ product: toProduct(r), position: { t: r.created_key, id: r.id } }));
  }

  // ---- Products ----

  /** Inside the caller's (idempotency) transaction. */
  async createProduct(tx: EntityManager, body: ProductCreate): Promise<Versioned<AdminProduct>> {
    return translated(async () => {
      const id = uuidv7();
      await tx.query(
        `INSERT INTO products (id, slug, name, description, category_id, image_urls, status, min_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          body.slug,
          body.name,
          body.description,
          body.categoryId,
          body.imageUrls,
          body.status,
          Math.min(...body.skus.map((s) => s.price.amount)),
        ],
      );
      // One statement for all SKUs, a microsecond apart, so they keep the order the admin gave them.
      await tx.query(
        `INSERT INTO skus (sku, product_id, name, price_amount, status, created_at)
         SELECT t.sku, $1, t.name, t.price, 'ACTIVE', now() + t.ord * interval '1 microsecond'
           FROM unnest($2::text[], $3::text[], $4::bigint[]) WITH ORDINALITY AS t (sku, name, price, ord)`,
        [id, body.skus.map((s) => s.sku), body.skus.map((s) => s.name), body.skus.map((s) => s.price.amount)],
      );
      return (await this.product(id, tx)) ?? Promise.reject(new Error('created product vanished'));
    });
  }

  async updateProduct(id: string, version: number, patch: ProductPatch): Promise<Versioned<AdminProduct>> {
    return translated(() =>
      this.db.transaction(async (tx) => {
        const rows: { version: number; min_price: string | null }[] = await tx.query(
          `SELECT version, min_price FROM products WHERE id = $1 FOR UPDATE`,
          [id],
        );
        const current = rows[0];
        if (!current) throw notFound('product');
        if (current.version !== version) throw versionConflict(current.version);
        if (patch.status === 'ACTIVE' && current.min_price === null) throw needsActiveSku();
        await tx.query(
          `UPDATE products
              SET name = COALESCE($2, name), description = COALESCE($3, description),
                  category_id = COALESCE($4::uuid, category_id), image_urls = COALESCE($5::text[], image_urls),
                  status = COALESCE($6, status), version = version + 1, updated_at = now()
            WHERE id = $1`,
          [
            id,
            patch.name ?? null,
            patch.description ?? null,
            patch.categoryId ?? null,
            patch.imageUrls ?? null,
            patch.status ?? null,
          ],
        );
        return (await this.product(id, tx)) ?? Promise.reject(new Error('updated product vanished'));
      }),
    );
  }

  // ---- SKUs ----

  private async sku(db: Db, sku: string): Promise<AdminSku> {
    const rows: SkuRow[] = await db.query(
      `SELECT sku, product_id, name, price_amount, status, version, created_at, updated_at FROM skus WHERE sku = $1`,
      [sku],
    );
    const row = rows[0];
    if (!row) throw new Error(`SKU ${sku} vanished inside its transaction`);
    return toSku(row);
  }

  /** `min_price` follows every SKU price or status change in the same transaction (RFC-0005 §4.6). */
  private async refreshMinPrice(tx: Db, productId: string): Promise<void> {
    await tx.query(
      `UPDATE products
          SET min_price = (SELECT min(price_amount) FROM skus WHERE product_id = $1 AND status = 'ACTIVE')
        WHERE id = $1`,
      [productId],
    );
  }

  /** Inside the caller's (idempotency) transaction. */
  async addSku(tx: EntityManager, productId: string, body: SkuCreate): Promise<Versioned<AdminSku>> {
    return translated(async () => {
      const locked: unknown[] = await tx.query(`SELECT 1 FROM products WHERE id = $1 FOR UPDATE`, [
        productId,
      ]);
      if (locked.length === 0) throw notFound('product');
      const [{ n }] = await tx.query<[{ n: number }]>(
        `SELECT count(*)::int AS n FROM skus WHERE product_id = $1`,
        [productId],
      );
      if (n >= MAX_SKUS_PER_PRODUCT) {
        throw fail(422, 'SKU_LIMIT', `A product has at most ${String(MAX_SKUS_PER_PRODUCT)} SKUs.`);
      }
      await tx.query(
        `INSERT INTO skus (sku, product_id, name, price_amount, status, created_at)
         VALUES ($1, $2, $3, $4, 'ACTIVE', clock_timestamp())`,
        [body.sku, productId, body.name, body.price.amount],
      );
      await this.refreshMinPrice(tx, productId);
      return { value: await this.sku(tx, body.sku), version: 1 };
    });
  }

  async updateSku(code: string, version: number, patch: SkuPatch): Promise<Versioned<AdminSku>> {
    return translated(() =>
      this.db.transaction(async (tx) => {
        const owner: { product_id: string }[] = await tx.query(`SELECT product_id FROM skus WHERE sku = $1`, [
          code,
        ]);
        const productId = owner[0]?.product_id;
        if (!productId) throw notFound('SKU');
        // Product first, then the SKU: the lock order every SKU write uses.
        const [product] = await tx.query<[{ status: string }]>(
          `SELECT status FROM products WHERE id = $1 FOR UPDATE`,
          [productId],
        );
        const [current] = await tx.query<[{ version: number; status: string }]>(
          `SELECT version, status FROM skus WHERE sku = $1 FOR UPDATE`,
          [code],
        );
        if (current.version !== version) throw versionConflict(current.version);
        if (patch.status === 'ARCHIVED' && current.status === 'ACTIVE' && product.status === 'ACTIVE') {
          const others: unknown[] = await tx.query(
            `SELECT 1 FROM skus WHERE product_id = $1 AND status = 'ACTIVE' AND sku <> $2 LIMIT 1`,
            [productId, code],
          );
          if (others.length === 0) throw needsActiveSku();
        }
        await tx.query(
          `UPDATE skus
              SET name = COALESCE($2, name), price_amount = COALESCE($3::bigint, price_amount),
                  status = COALESCE($4, status), version = version + 1, updated_at = now()
            WHERE sku = $1`,
          [code, patch.name ?? null, patch.price?.amount ?? null, patch.status ?? null],
        );
        await this.refreshMinPrice(tx, productId);
        const sku = await this.sku(tx, code);
        return { value: sku, version: sku.version };
      }),
    );
  }

  // ---- Categories ----

  /** Inside the caller's (idempotency) transaction. */
  async createCategory(tx: EntityManager, body: CategoryCreate): Promise<Versioned<Category>> {
    return translated(async () => {
      const id = uuidv7();
      await tx.query(
        `INSERT INTO categories (id, slug, name, parent_id, position) VALUES ($1, $2, $3, $4, $5)`,
        [id, body.slug, body.name, body.parentId, body.position],
      );
      return {
        value: { id, slug: body.slug, name: body.name, parentId: body.parentId, position: body.position },
        version: 1,
      };
    });
  }

  async updateCategory(id: string, version: number, patch: CategoryPatch): Promise<Versioned<Category>> {
    return translated(() =>
      this.db.transaction(async (tx) => {
        const moving = patch.parentId !== undefined;
        // Re-parenting is serialised, so two concurrent moves can't form a cycle that neither saw alone.
        if (moving) await tx.query(`SELECT pg_advisory_xact_lock(hashtext('catalog:category-tree'))`);
        const rows: { version: number }[] = await tx.query(
          `SELECT version FROM categories WHERE id = $1 FOR UPDATE`,
          [id],
        );
        const current = rows[0];
        if (!current) throw notFound('category');
        if (current.version !== version) throw versionConflict(current.version);
        if (moving && patch.parentId !== null) {
          const cycle: unknown[] = await tx.query(
            `WITH RECURSIVE up AS (
               SELECT id, parent_id FROM categories WHERE id = $1
               UNION SELECT c.id, c.parent_id FROM categories c JOIN up ON c.id = up.parent_id
             ) SELECT 1 FROM up WHERE id = $2`,
            [patch.parentId, id],
          );
          if (cycle.length > 0) {
            throw fail(
              422,
              'CATEGORY_CYCLE',
              'A category cannot be moved under itself or its own subcategory.',
            );
          }
        }
        // Wrapped in a SELECT: TypeORM returns [rows, rowCount] for a bare UPDATE but plain rows for a SELECT.
        const updated: CategoryRow[] = await tx.query(
          `WITH updated AS (
             UPDATE categories
                SET name = COALESCE($2, name), position = COALESCE($3, position),
                    parent_id = CASE WHEN $4 THEN $5::uuid ELSE parent_id END, version = version + 1
              WHERE id = $1
          RETURNING id, slug, name, parent_id, position, version
           ) SELECT * FROM updated`,
          [id, patch.name ?? null, patch.position ?? null, moving, patch.parentId ?? null],
        );
        const [r] = updated as [CategoryRow];
        return {
          value: { id: r.id, slug: r.slug, name: r.name, parentId: r.parent_id, position: r.position },
          version: r.version,
        };
      }),
    );
  }
}
