import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { CursorPosition } from './cursor.js';
import type { Sort } from './listing-query.js';

export interface Money {
  amount: number;
  currency: 'IDR';
}

export interface CategoryRef {
  id: string;
  slug: string;
  name: string;
}

export interface Category extends CategoryRef {
  parentId: string | null;
  position: number;
}

export interface ProductSummary {
  id: string;
  slug: string;
  name: string;
  category: CategoryRef;
  imageUrl: string | null;
  fromPrice: Money;
  skus: string[];
}

export interface ProductDetail {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: CategoryRef;
  imageUrls: string[];
  fromPrice: Money;
  skus: { sku: string; name: string; price: Money }[];
}

export interface SkuLookupItem {
  sku: string;
  name: string;
  price: Money;
  status: string;
  productId: string;
  productSlug: string;
  productName: string;
  productStatus: string;
}

/** A listing row with its keyset position, so the caller can build the next cursor. */
export interface ListedProduct {
  product: ProductSummary;
  position: CursorPosition;
}

export interface ListingFilter {
  sort: Sort;
  category: string | null;
  minPrice: number | null;
  maxPrice: number | null;
  after: CursorPosition | null;
  limit: number;
}

/** pg returns BIGINT as text; Catalog's amounts are far below 2^53. */
const money = (amount: string | number): Money => ({ amount: Number(amount), currency: 'IDR' });

// Created-at as text with Postgres's full microseconds: a JavaScript Date would round to milliseconds and
// skip or repeat rows created in the same millisecond at a page boundary.
const CREATED_KEY = `to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** ORDER BY and the keyset predicate for each sort; `$a` and `$b` are the cursor's value and id. */
const ORDERS: Record<Sort, { orderBy: string; after: string }> = {
  newest: {
    orderBy: 'p.created_at DESC, p.id DESC',
    after: '(p.created_at, p.id) < ($a::timestamptz, $b::uuid)',
  },
  price_asc: { orderBy: 'p.min_price ASC, p.id ASC', after: '(p.min_price, p.id) > ($a::bigint, $b::uuid)' },
  price_desc: {
    orderBy: 'p.min_price DESC, p.id DESC',
    after: '(p.min_price, p.id) < ($a::bigint, $b::uuid)',
  },
};

interface SummaryRow {
  id: string;
  slug: string;
  name: string;
  image_url: string | null;
  min_price: string;
  created_key: string;
  category_id: string;
  category_slug: string;
  category_name: string;
  skus: string[];
}

/** Catalog's read side: what browsing and Order's price lookup need, active products only (RFC-0005 §4.2). */
@Injectable()
export class CatalogQueries {
  constructor(private readonly db: DataSource) {}

  async categories(): Promise<Category[]> {
    const rows: { id: string; slug: string; name: string; parent_id: string | null; position: number }[] =
      await this.db.query(
        `SELECT id, slug, name, parent_id, position FROM categories ORDER BY position, name, id`,
      );
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      parentId: r.parent_id,
      position: r.position,
    }));
  }

  /** Up to `limit` + 1 rows after the cursor; the extra row only tells the caller there is a next page. */
  async listProducts(filter: ListingFilter): Promise<ListedProduct[]> {
    const params: unknown[] = [];
    const param = (value: unknown): string => {
      params.push(value);
      return `$${String(params.length)}`;
    };
    const where = [`p.status = 'ACTIVE'`];
    let tree = '';
    if (filter.category !== null) {
      // The category and everything below it; UNION (not UNION ALL) stops at a cycle.
      tree = `WITH RECURSIVE tree AS (
          SELECT id FROM categories WHERE slug = ${param(filter.category)}
          UNION SELECT c.id FROM categories c JOIN tree ON c.parent_id = tree.id
        ) `;
      where.push('p.category_id IN (SELECT id FROM tree)');
    }
    if (filter.minPrice !== null) where.push(`p.min_price >= ${param(filter.minPrice)}`);
    if (filter.maxPrice !== null) where.push(`p.min_price <= ${param(filter.maxPrice)}`);
    const order = ORDERS[filter.sort];
    if (filter.after !== null) {
      const value = 't' in filter.after ? filter.after.t : filter.after.p;
      where.push(order.after.replace('$a', param(value)).replace('$b', param(filter.after.id)));
    }

    const rows: SummaryRow[] = await this.db.query(
      `${tree}SELECT p.id, p.slug, p.name, p.image_urls[1] AS image_url, p.min_price, ${CREATED_KEY} AS created_key,
              c.id AS category_id, c.slug AS category_slug, c.name AS category_name,
              ARRAY(SELECT s.sku FROM skus s WHERE s.product_id = p.id AND s.status = 'ACTIVE'
                    ORDER BY s.created_at, s.sku) AS skus
         FROM products p JOIN categories c ON c.id = p.category_id
        WHERE ${where.join(' AND ')}
        ORDER BY ${order.orderBy}
        LIMIT ${param(filter.limit + 1)}`,
      params,
    );
    return rows.map((r) => ({
      product: {
        id: r.id,
        slug: r.slug,
        name: r.name,
        category: { id: r.category_id, slug: r.category_slug, name: r.category_name },
        imageUrl: r.image_url,
        fromPrice: money(r.min_price),
        skus: r.skus,
      },
      position:
        filter.sort === 'newest' ? { t: r.created_key, id: r.id } : { p: Number(r.min_price), id: r.id },
    }));
  }

  async productBySlug(slug: string): Promise<ProductDetail | null> {
    const rows: {
      id: string;
      slug: string;
      name: string;
      description: string;
      image_urls: string[];
      min_price: string;
      category_id: string;
      category_slug: string;
      category_name: string;
      skus: { sku: string; name: string; price: number }[];
    }[] = await this.db.query(
      `SELECT p.id, p.slug, p.name, p.description, p.image_urls, p.min_price,
              c.id AS category_id, c.slug AS category_slug, c.name AS category_name,
              COALESCE((SELECT json_agg(json_build_object('sku', s.sku, 'name', s.name, 'price', s.price_amount)
                                        ORDER BY s.created_at, s.sku)
                          FROM skus s WHERE s.product_id = p.id AND s.status = 'ACTIVE'), '[]') AS skus
         FROM products p JOIN categories c ON c.id = p.category_id
        WHERE p.slug = $1 AND p.status = 'ACTIVE'`,
      [slug],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      description: r.description,
      category: { id: r.category_id, slug: r.category_slug, name: r.category_name },
      imageUrls: r.image_urls,
      fromPrice: money(r.min_price),
      skus: r.skus.map((s) => ({ sku: s.sku, name: s.name, price: money(s.price) })),
    };
  }

  /** Every known SKU among `skus`, in the order asked, whatever its status: Order decides what it accepts. */
  async lookupSkus(skus: string[]): Promise<SkuLookupItem[]> {
    const rows: {
      sku: string;
      name: string;
      price_amount: string;
      status: string;
      product_id: string;
      product_slug: string;
      product_name: string;
      product_status: string;
    }[] = await this.db.query(
      `SELECT s.sku, s.name, s.price_amount, s.status,
              p.id AS product_id, p.slug AS product_slug, p.name AS product_name, p.status AS product_status
         FROM skus s JOIN products p ON p.id = s.product_id
        WHERE s.sku = ANY($1::text[])`,
      [skus],
    );
    const found = new Map(rows.map((r) => [r.sku, r]));
    return skus.flatMap((sku) => {
      const r = found.get(sku);
      return r
        ? [
            {
              sku: r.sku,
              name: r.name,
              price: money(r.price_amount),
              status: r.status,
              productId: r.product_id,
              productSlug: r.product_slug,
              productName: r.product_name,
              productStatus: r.product_status,
            },
          ]
        : [];
    });
  }
}
