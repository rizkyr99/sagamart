import { generateKeyPairSync } from 'node:crypto';
import type { Server } from 'node:http';
import { PassThrough } from 'node:stream';
import type { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { signIdentity } from '@sagamart/node-common';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { GenericContainer, Wait } from 'testcontainers';
import type { AppOptions } from '../app.module.js';
import { AppModule, configureApp } from '../app.module.js';
import { loadCatalogConfig } from '../config.js';

export const userId = '0199f2e0-0000-7000-8000-000000000001';

export interface TokenOptions {
  roles?: string[];
  audience?: string;
  now?: Date;
  subject?: string;
}

/** A running Catalog against real Postgres and DynamoDB Local, with a gateway key to sign identities. */
export interface Harness {
  app: INestApplication;
  http: () => Server;
  dbUrl: string;
  dynamoEndpoint: string;
  /** Direct database access, for seeding and checking what the app wrote. */
  sql: pg.Pool;
  /** Builds a config for another app instance against the same containers; `overrides` win. */
  config: (overrides?: Record<string, string>) => ReturnType<typeof loadCatalogConfig>;
  token: (options?: TokenOptions) => string;
  close: () => Promise<void>;
}

const keys = generateKeyPairSync('ed25519');
const privateKey = keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const kid = 'gw-test';

export function token(opts: TokenOptions = {}): string {
  return signIdentity({
    privateKey,
    keyId: kid,
    audience: opts.audience ?? 'catalog',
    roles: opts.roles ?? ['buyer'],
    subject: opts.subject ?? userId,
    ...(opts.now ? { now: opts.now } : {}),
  });
}

export async function startHarness(
  options: { controllers?: Type[]; app?: Partial<AppOptions> } = {},
): Promise<Harness> {
  const [postgres, dynamo] = await Promise.all([
    new PostgreSqlContainer('postgres:17.2-alpine').withDatabase('catalog').start(),
    new GenericContainer('amazon/dynamodb-local:2.5.2')
      .withCommand(['-jar', 'DynamoDBLocal.jar', '-inMemory', '-sharedDb'])
      .withExposedPorts(8000)
      .withWaitStrategy(Wait.forListeningPorts())
      .start(),
  ]);
  const dbUrl = postgres.getConnectionUri();
  const dynamoEndpoint = `http://${dynamo.getHost()}:${String(dynamo.getMappedPort(8000))}`;
  const config = (overrides: Record<string, string> = {}) =>
    loadCatalogConfig({
      CATALOG_ENV: 'test',
      CATALOG_DB_URL: dbUrl,
      CATALOG_DYNAMODB_ENDPOINT: dynamoEndpoint,
      CATALOG_IDENTITY_PUBLIC_KEYS: JSON.stringify({ [kid]: publicKey }),
      ...overrides,
    });

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot({ config: config(), logDestination: new PassThrough(), ...options.app })],
    controllers: options.controllers ?? [],
  }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  const sql = new pg.Pool({ connectionString: dbUrl, max: 4 });

  return {
    app,
    http: () => app.getHttpServer() as Server,
    dbUrl,
    dynamoEndpoint,
    sql,
    config,
    token,
    close: async () => {
      await app.close();
      await sql.end();
      await Promise.all([postgres.stop(), dynamo.stop()]);
    },
  };
}
