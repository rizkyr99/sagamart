import { generateKeyPairSync } from 'node:crypto';
import { ConfigError } from '@sagamart/node-common';
import { describe, expect, it } from 'vitest';
import { loadGatewayConfig } from './config.js';

const privateKey = generateKeyPairSync('ed25519')
  .privateKey.export({ format: 'der', type: 'pkcs8' })
  .toString('base64');
const minimal = { GATEWAY_IDENTITY_KEY_ID: 'gw-1', GATEWAY_IDENTITY_PRIVATE_KEY: privateKey };
const secret = 's'.repeat(32);

const problems = (env: Record<string, string>): readonly string[] => {
  try {
    loadGatewayConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  throw new Error('expected a ConfigError');
};

describe('loadGatewayConfig', () => {
  it('applies defaults for local development: dev auth off, local Catalog and Redis', () => {
    expect(loadGatewayConfig(minimal)).toEqual({
      env: 'local',
      version: 'dev',
      logLevel: 'info',
      httpPort: 8100,
      trustProxy: false,
      requestDeadlineMs: 5000,
      devAuth: { enabled: false, secret: undefined },
      identity: { keyId: 'gw-1', privateKey },
      catalogUrl: 'http://localhost:8120',
      redisUrl: 'redis://localhost:6380',
      rateLimit: { perSecond: 20, burst: 40 },
      otlpEndpoint: undefined,
    });
  });

  it('enables dev auth with a secret of at least 32 characters', () => {
    const cfg = loadGatewayConfig({ ...minimal, GATEWAY_DEV_AUTH: 'true', GATEWAY_DEV_JWT_SECRET: secret });
    expect(cfg.devAuth).toEqual({ enabled: true, secret });
    expect(problems({ ...minimal, GATEWAY_DEV_AUTH: 'true' })).toEqual([
      expect.stringContaining('GATEWAY_DEV_JWT_SECRET'),
    ]);
    expect(problems({ ...minimal, GATEWAY_DEV_AUTH: 'true', GATEWAY_DEV_JWT_SECRET: 'short' })).toEqual([
      expect.stringContaining('GATEWAY_DEV_JWT_SECRET'),
    ]);
  });

  it('refuses to start with dev auth in prod (RFC-0005 §8)', () => {
    expect(
      problems({ ...minimal, GATEWAY_ENV: 'prod', GATEWAY_DEV_AUTH: 'true', GATEWAY_DEV_JWT_SECRET: secret }),
    ).toEqual([expect.stringMatching(/GATEWAY_DEV_AUTH.*prod/)]);
    expect(loadGatewayConfig({ ...minimal, GATEWAY_ENV: 'prod' }).devAuth.enabled).toBe(false);
  });

  it('requires an Ed25519 private key to sign identities', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ format: 'der', type: 'pkcs8' })
      .toString('base64');
    expect(problems({ ...minimal, GATEWAY_IDENTITY_PRIVATE_KEY: rsa })).toEqual([
      expect.stringContaining('GATEWAY_IDENTITY_PRIVATE_KEY'),
    ]);
    expect(problems({ GATEWAY_IDENTITY_KEY_ID: 'gw-1' })).toEqual([
      expect.stringContaining('GATEWAY_IDENTITY_PRIVATE_KEY'),
    ]);
  });

  it('reads overrides and reports every problem at once', () => {
    const cfg = loadGatewayConfig({
      ...minimal,
      GATEWAY_TRUST_PROXY: 'true',
      GATEWAY_RATE_LIMIT_PER_SECOND: '5',
      GATEWAY_RATE_LIMIT_BURST: '10',
      GATEWAY_CATALOG_URL: 'http://catalog:8120',
      GATEWAY_REDIS_URL: 'redis://redis:6379',
    });
    expect(cfg).toMatchObject({
      trustProxy: true,
      rateLimit: { perSecond: 5, burst: 10 },
      catalogUrl: 'http://catalog:8120',
      redisUrl: 'redis://redis:6379',
    });
    expect(problems({ ...minimal, GATEWAY_HTTP_PORT: '0', GATEWAY_REDIS_URL: 'http://nope' })).toHaveLength(
      2,
    );
  });
});
