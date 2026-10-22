import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller.js';
import { CatalogQueries } from './catalog.queries.js';

/** The Catalog context: categories, products, SKUs and prices (RFC-0005). Cart is a separate module. */
@Module({
  controllers: [CatalogController],
  providers: [CatalogQueries],
  exports: [CatalogQueries],
})
export class CatalogModule {}
