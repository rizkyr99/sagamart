import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigError, loadConfig } from './config';

const schema = z.object({
  CATALOG_ENV: z.enum(['local', 'test', 'prod']).default('local'),
  CATALOG_DB_URL: z.url(),
  CATALOG_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8120),
});

describe('loadConfig', () => {
  it('parses, coerces and applies defaults', () => {
    expect(
      loadConfig(schema, { CATALOG_DB_URL: 'postgres://db/catalog', CATALOG_HTTP_PORT: '9000' }),
    ).toEqual({
      CATALOG_ENV: 'local',
      CATALOG_DB_URL: 'postgres://db/catalog',
      CATALOG_HTTP_PORT: 9000,
    });
  });

  it('reports every problem at once, naming each variable', () => {
    let error: unknown;
    try {
      loadConfig(schema, { CATALOG_ENV: 'staging', CATALOG_HTTP_PORT: 'eighty' });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const problems = (error as ConfigError).problems;
    expect(problems).toHaveLength(3);
    for (const key of ['CATALOG_ENV', 'CATALOG_DB_URL', 'CATALOG_HTTP_PORT']) {
      expect(problems.some((p) => p.startsWith(`${key}:`))).toBe(true);
    }
    expect((error as Error).message).toContain('CATALOG_DB_URL');
  });

  it('treats empty strings as unset, so defaults apply', () => {
    expect(loadConfig(schema, { CATALOG_DB_URL: 'postgres://db/catalog', CATALOG_ENV: '' }).CATALOG_ENV).toBe(
      'local',
    );
  });
});
