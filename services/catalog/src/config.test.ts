import { ConfigError } from '@sagamart/node-common';
import { describe, expect, it } from 'vitest';
import { loadCatalogConfig } from './config.js';

const keys = JSON.stringify({ 'gw-1': 'MCowBQYDK2VwAyEAEZsYDunQ2v5N1vB2MmXsfISRzGR51GbiQCeC7AoQooA=' });
const minimal = { CATALOG_DB_URL: 'postgres://catalog:catalog@localhost:5433/catalog', CATALOG_IDENTITY_PUBLIC_KEYS: keys };

describe('loadCatalogConfig', () => {
  it('applies defaults for local development', () => {
    expect(loadCatalogConfig(minimal)).toEqual({
      env: 'local',
      version: 'dev',
      logLevel: 'info',
      httpPort: 8120,
      dbUrl: minimal.CATALOG_DB_URL,
      migrateOnStart: true,
      dynamo: { endpoint: undefined, region: 'ap-southeast-3', cartsTable: 'carts', createTable: true },
      identityPublicKeys: { 'gw-1': 'MCowBQYDK2VwAyEAEZsYDunQ2v5N1vB2MmXsfISRzGR51GbiQCeC7AoQooA=' },
      otlpEndpoint: undefined,
    });
  });

  it('does not migrate or create tables on start in prod unless told to', () => {
    const cfg = loadCatalogConfig({ ...minimal, CATALOG_ENV: 'prod' });
    expect(cfg.migrateOnStart).toBe(false);
    expect(cfg.dynamo.createTable).toBe(false);
    expect(loadCatalogConfig({ ...minimal, CATALOG_ENV: 'prod', CATALOG_MIGRATE_ON_START: 'true' }).migrateOnStart).toBe(true);
  });

  it('reads overrides', () => {
    const cfg = loadCatalogConfig({
      ...minimal,
      CATALOG_ENV: 'test',
      CATALOG_VERSION: 'abc123',
      CATALOG_LOG_LEVEL: 'debug',
      CATALOG_HTTP_PORT: '18120',
      CATALOG_DYNAMODB_ENDPOINT: 'http://localhost:8001',
      CATALOG_DYNAMODB_REGION: 'us-east-1',
      CATALOG_CARTS_TABLE: 'carts-test',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4317',
    });
    expect(cfg).toMatchObject({
      env: 'test', version: 'abc123', logLevel: 'debug', httpPort: 18120, otlpEndpoint: 'http://otel-collector:4317',
      dynamo: { endpoint: 'http://localhost:8001', region: 'us-east-1', cartsTable: 'carts-test', createTable: true },
    });
  });

  it('reports every problem at once', () => {
    let error: unknown;
    try {
      loadCatalogConfig({ CATALOG_ENV: 'staging', CATALOG_HTTP_PORT: 'eighty', CATALOG_IDENTITY_PUBLIC_KEYS: 'not json' });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const text = (error as ConfigError).problems.join('\n');
    for (const key of ['CATALOG_ENV', 'CATALOG_HTTP_PORT', 'CATALOG_DB_URL', 'CATALOG_IDENTITY_PUBLIC_KEYS']) {
      expect(text).toContain(key);
    }
  });

  it('requires at least one trusted identity key', () => {
    expect(() => loadCatalogConfig({ ...minimal, CATALOG_IDENTITY_PUBLIC_KEYS: '{}' })).toThrow(ConfigError);
  });
});
