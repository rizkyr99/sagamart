import { createPrivateKey } from 'node:crypto';
import { loadConfig } from '@sagamart/node-common';
import { z } from 'zod';
import { DEADLINES } from './deadline.js';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const ed25519PrivateKey = z.string().refine((text) => {
  try {
    const key = createPrivateKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'pkcs8' });
    return key.asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}, 'must be an Ed25519 private key, PKCS#8 DER, base64 (make identity-keys)');

const envSchema = z
  .object({
    GATEWAY_ENV: z.enum(['local', 'test', 'prod']).default('local'),
    GATEWAY_VERSION: z.string().default('dev'),
    GATEWAY_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    GATEWAY_HTTP_PORT: int(1, 65535).default(8100),
    GATEWAY_TRUST_PROXY: bool.default(false),
    GATEWAY_REQUEST_DEADLINE_MS: int(100, 60_000).default(5000),
    GATEWAY_STOCK_DEADLINE_MS: int(10, 5000).default(DEADLINES.inventoryStockLevels),
    GATEWAY_DEV_AUTH: bool.default(false),
    GATEWAY_DEV_JWT_SECRET: z.string().optional(),
    GATEWAY_IDENTITY_KEY_ID: z.string().min(1),
    GATEWAY_IDENTITY_PRIVATE_KEY: ed25519PrivateKey,
    GATEWAY_CATALOG_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:8120'),
    GATEWAY_INVENTORY_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:9110'),
    GATEWAY_REDIS_URL: z.url({ protocol: /^rediss?$/ }).default('redis://localhost:6380'),
    GATEWAY_RATE_LIMIT_PER_SECOND: int(1, 100_000).default(20),
    GATEWAY_RATE_LIMIT_BURST: int(1, 100_000).default(40),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  })
  .superRefine((e, ctx) => {
    if (!e.GATEWAY_DEV_AUTH) return;
    // RFC-0005 §8: development tokens can mint any identity, admin included. Never in production.
    if (e.GATEWAY_ENV === 'prod') {
      ctx.addIssue({ code: 'custom', path: ['GATEWAY_DEV_AUTH'], message: 'must not be true in prod' });
    }
    if ((e.GATEWAY_DEV_JWT_SECRET ?? '').length < 32) {
      ctx.addIssue({
        code: 'custom',
        path: ['GATEWAY_DEV_JWT_SECRET'],
        message: 'must be at least 32 characters when GATEWAY_DEV_AUTH is true',
      });
    }
  });

export interface GatewayConfig {
  env: 'local' | 'test' | 'prod';
  version: string;
  logLevel: string;
  httpPort: number;
  /** Take the client IP from X-Forwarded-For; only behind a proxy we run. */
  trustProxy: boolean;
  /** Budget for one incoming request; outbound calls never outlive it. */
  requestDeadlineMs: number;
  /** How long a page waits for Inventory's stock before showing UNKNOWN (RFC-0005 §4.4: 150 ms). */
  stockDeadlineMs: number;
  devAuth: { enabled: boolean; secret: string | undefined };
  /** The key that signs x-sagamart-identity (contracts/identity.md); services hold the public half. */
  identity: { keyId: string; privateKey: string };
  catalogUrl: string;
  /** Inventory's gRPC endpoint (h2c in Compose). */
  inventoryUrl: string;
  redisUrl: string;
  /** Token bucket per IP (anonymous) or per user: `perSecond` refill, `burst` capacity (RFC-0005 §8). */
  rateLimit: { perSecond: number; burst: number };
  otlpEndpoint: string | undefined;
}

/** Loads the gateway's configuration from the environment, failing fast with every problem at once. */
export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const e = loadConfig(envSchema, env);
  return {
    env: e.GATEWAY_ENV,
    version: e.GATEWAY_VERSION,
    logLevel: e.GATEWAY_LOG_LEVEL,
    httpPort: e.GATEWAY_HTTP_PORT,
    trustProxy: e.GATEWAY_TRUST_PROXY,
    requestDeadlineMs: e.GATEWAY_REQUEST_DEADLINE_MS,
    stockDeadlineMs: e.GATEWAY_STOCK_DEADLINE_MS,
    devAuth: {
      enabled: e.GATEWAY_DEV_AUTH,
      secret: e.GATEWAY_DEV_AUTH ? e.GATEWAY_DEV_JWT_SECRET : undefined,
    },
    identity: { keyId: e.GATEWAY_IDENTITY_KEY_ID, privateKey: e.GATEWAY_IDENTITY_PRIVATE_KEY },
    catalogUrl: e.GATEWAY_CATALOG_URL,
    inventoryUrl: e.GATEWAY_INVENTORY_URL,
    redisUrl: e.GATEWAY_REDIS_URL,
    rateLimit: { perSecond: e.GATEWAY_RATE_LIMIT_PER_SECOND, burst: e.GATEWAY_RATE_LIMIT_BURST },
    otlpEndpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT,
  };
}
