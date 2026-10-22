import { loadConfig } from '@sagamart/node-common';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const publicKeys = z.string().transform((text, ctx): Record<string, string> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'must be JSON: {"<kid>": "<SPKI DER, base64>"}' });
    return z.NEVER;
  }
  const entries =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? Object.entries(parsed) : [];
  if (entries.length === 0 || !entries.every(([, v]) => typeof v === 'string' && v.length > 0)) {
    ctx.addIssue({ code: 'custom', message: 'must map at least one key id to a base64 public key' });
    return z.NEVER;
  }
  return Object.fromEntries(entries);
});

const envSchema = z.object({
  CATALOG_ENV: z.enum(['local', 'test', 'prod']).default('local'),
  CATALOG_VERSION: z.string().default('dev'),
  CATALOG_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  CATALOG_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8120),
  CATALOG_DB_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
  CATALOG_MIGRATE_ON_START: bool.optional(),
  CATALOG_DYNAMODB_ENDPOINT: z.url().optional(),
  CATALOG_DYNAMODB_REGION: z.string().min(1).default('ap-southeast-3'),
  CATALOG_CARTS_TABLE: z.string().min(3).default('carts'),
  CATALOG_DYNAMODB_CREATE_TABLE: bool.optional(),
  CATALOG_IDENTITY_PUBLIC_KEYS: publicKeys,
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
});

export interface CatalogConfig {
  env: 'local' | 'test' | 'prod';
  version: string;
  logLevel: string;
  httpPort: number;
  dbUrl: string;
  /** Migrations run on start in local and test; deployments run them as a separate step (conventions §9). */
  migrateOnStart: boolean;
  dynamo: { endpoint: string | undefined; region: string; cartsTable: string; createTable: boolean };
  /** Trusted gateway keys for x-sagamart-identity: kid → SPKI DER, base64 (contracts/identity.md). */
  identityPublicKeys: Record<string, string>;
  otlpEndpoint: string | undefined;
}

/** Loads Catalog's configuration from the environment, failing fast with every problem at once. */
export function loadCatalogConfig(env: NodeJS.ProcessEnv = process.env): CatalogConfig {
  const e = loadConfig(envSchema, env);
  const devLike = e.CATALOG_ENV !== 'prod';
  return {
    env: e.CATALOG_ENV,
    version: e.CATALOG_VERSION,
    logLevel: e.CATALOG_LOG_LEVEL,
    httpPort: e.CATALOG_HTTP_PORT,
    dbUrl: e.CATALOG_DB_URL,
    migrateOnStart: e.CATALOG_MIGRATE_ON_START ?? devLike,
    dynamo: {
      endpoint: e.CATALOG_DYNAMODB_ENDPOINT,
      region: e.CATALOG_DYNAMODB_REGION,
      cartsTable: e.CATALOG_CARTS_TABLE,
      createTable: e.CATALOG_DYNAMODB_CREATE_TABLE ?? devLike,
    },
    identityPublicKeys: e.CATALOG_IDENTITY_PUBLIC_KEYS,
    otlpEndpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT,
  };
}
