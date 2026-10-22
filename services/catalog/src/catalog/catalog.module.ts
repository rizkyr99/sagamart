import { Module } from '@nestjs/common';
import { Idempotency } from '../idempotency.js';
import { AdminController } from './admin.controller.js';
import { CatalogAdmin } from './catalog.admin.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogQueries } from './catalog.queries.js';

/** The Catalog context: categories, products, SKUs and prices (RFC-0005). Cart is a separate module. */
@Module({
  controllers: [CatalogController, AdminController],
  providers: [CatalogQueries, CatalogAdmin, Idempotency],
  exports: [CatalogQueries],
})
export class CatalogModule {}
