import { z } from 'zod';
import { skuCode, slug } from './fields.js';

// Request bodies for the admin writes, mirroring contracts/openapi/components/catalog-v1.yaml.

const name = z.string().min(1).max(200);
const description = z.string().max(5000);
// http(s) only: these URLs end up in <img src> on the storefront.
const imageUrls = z.array(z.url({ protocol: /^https?$/ }).max(2048)).max(10);
const position = z.int().min(0).max(2_147_483_647);

export const positiveMoney = z.strictObject({
  amount: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  currency: z.literal('IDR'),
});

const atLeastOneField = (value: object): boolean => Object.keys(value).length > 0;

export const skuCreate = z.strictObject({ sku: skuCode, name, price: positiveMoney });
export type SkuCreate = z.output<typeof skuCreate>;

export const productCreate = z.strictObject({
  slug,
  name,
  description: description.default(''),
  categoryId: z.uuid(),
  imageUrls: imageUrls.default([]),
  status: z.enum(['DRAFT', 'ACTIVE']).default('DRAFT'),
  skus: z
    .array(skuCreate)
    .min(1)
    .max(100)
    .refine((skus) => new Set(skus.map((s) => s.sku)).size === skus.length, 'must not repeat a SKU'),
});
export type ProductCreate = z.output<typeof productCreate>;

export const productPatch = z
  .strictObject({
    name,
    description,
    categoryId: z.uuid(),
    imageUrls,
    status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']),
  })
  .partial()
  .refine(atLeastOneField, 'must change at least one field');
export type ProductPatch = z.output<typeof productPatch>;

export const skuPatch = z
  .strictObject({ name, price: positiveMoney, status: z.enum(['ACTIVE', 'ARCHIVED']) })
  .partial()
  .refine(atLeastOneField, 'must change at least one field');
export type SkuPatch = z.output<typeof skuPatch>;

export const categoryCreate = z.strictObject({
  slug,
  name,
  parentId: z.uuid().nullable().default(null),
  position: position.default(0),
});
export type CategoryCreate = z.output<typeof categoryCreate>;

export const categoryPatch = z
  .strictObject({ name, parentId: z.uuid().nullable(), position })
  .partial()
  .refine(atLeastOneField, 'must change at least one field');
export type CategoryPatch = z.output<typeof categoryPatch>;
