import { z } from 'zod';

// Field rules shared by queries and writes (contracts: components/common-v1.yaml).

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const slug = z.string().max(120).regex(SLUG, 'must be a lowercase slug');

/** The SKU code Inventory uses too: 1–64 characters, no whitespace. */
export const skuCode = z.string().min(1).max(64).regex(/^\S+$/, 'must not contain whitespace');
