import type { MigrationInterface, QueryRunner } from 'typeorm';

/** RFC-0005 §4.3: categories, products, SKUs and Catalog-enforced idempotency records. Forward-only (conventions §9). */
export class InitialSchema1761100000000 implements MigrationInterface {
  name = 'InitialSchema1761100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE categories (
        id        UUID PRIMARY KEY,
        slug      TEXT NOT NULL UNIQUE,
        name      TEXT NOT NULL,
        parent_id UUID REFERENCES categories (id),
        position  INT NOT NULL DEFAULT 0,
        version   INT NOT NULL DEFAULT 1
      )`);
    await queryRunner.query(`
      CREATE TABLE products (
        id          UUID PRIMARY KEY,
        slug        TEXT NOT NULL UNIQUE,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        category_id UUID NOT NULL REFERENCES categories (id),
        image_urls  TEXT[] NOT NULL DEFAULT '{}',
        status      TEXT NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
        -- lowest active SKU price, maintained with SKU writes; drives price filter and sort
        min_price   BIGINT,
        version     INT NOT NULL DEFAULT 1,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT active_has_price CHECK (status <> 'ACTIVE' OR min_price IS NOT NULL)
      )`);
    await queryRunner.query(
      `CREATE INDEX products_listing_newest ON products (category_id, created_at DESC, id DESC) WHERE status = 'ACTIVE'`,
    );
    await queryRunner.query(
      `CREATE INDEX products_listing_price ON products (category_id, min_price, id) WHERE status = 'ACTIVE'`,
    );
    await queryRunner.query(`
      CREATE TABLE skus (
        sku          TEXT PRIMARY KEY,
        product_id   UUID NOT NULL REFERENCES products (id),
        name         TEXT NOT NULL,
        price_amount BIGINT NOT NULL CHECK (price_amount > 0),
        currency     CHAR(3) NOT NULL DEFAULT 'IDR' CHECK (currency = 'IDR'),
        status       TEXT NOT NULL CHECK (status IN ('ACTIVE', 'ARCHIVED')),
        version      INT NOT NULL DEFAULT 1,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`CREATE INDEX skus_by_product ON skus (product_id)`);
    await queryRunner.query(`
      CREATE TABLE idempotency_keys (
        owner        TEXT NOT NULL,
        key          TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status       INT,
        response     JSONB,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (owner, key)
      )`);
    await queryRunner.query(`CREATE INDEX idempotency_keys_created ON idempotency_keys (created_at)`);
  }

  down(): Promise<void> {
    return Promise.reject(
      new Error('migrations are forward-only (conventions §9); fix forward with a new migration'),
    );
  }
}
