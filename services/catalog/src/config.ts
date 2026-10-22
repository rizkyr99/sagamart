import { z } from 'zod';

export const configSchema = z.object({});
export type CatalogConfig = z.output<typeof configSchema> & Record<string, never>;

/** Loads Catalog's configuration from the environment, failing fast with every problem at once. */
export function loadCatalogConfig(_env: NodeJS.ProcessEnv = process.env): CatalogConfig {
  throw new Error('not implemented');
}
