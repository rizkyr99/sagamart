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
  // allSettled, so a container that did start is stopped when the other fails.
  const [startedPg, startedDynamo] = await Promise.allSettled([
    new PostgreSqlContainer('postgres:17.2-alpine').withDatabase('catalog').start(),
    new GenericContainer('amazon/dynamodb-local:2.5.2')
      .withCommand(['-jar', 'DynamoDBLocal.jar', '-inMemory', '-sharedDb'])
      .withExposedPorts(8000)
      .withWaitStrategy(Wait.forListeningPorts())
      .start(),
  ]);
  if (startedPg.status === 'rejected' || startedDynamo.status === 'rejected') {
    const results = [startedPg, startedDynamo];
    await Promise.all(results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.stop()] : [])));
    const reasons = results.flatMap((r): unknown[] => (r.status === 'rejected' ? [r.reason] : []));
    throw new AggregateError(reasons, 'test containers failed to start');
  }
  const postgres = startedPg.value;
  const dynamo = startedDynamo.value;
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

  // The caller only gets close() once this returns, so a failure from here on cleans up itself.
  let app: INestApplication | undefined;
  try {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot({ config: config(), logDestination: new PassThrough(), ...options.app })],
      controllers: options.controllers ?? [],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  } catch (err) {
    await app?.close().catch(() => undefined);
    await Promise.all([postgres.stop(), dynamo.stop()]);
    throw err;
  }
  const started = app;
  const sql = new pg.Pool({ connectionString: dbUrl, max: 4 });

  return {
    app: started,
    http: () => started.getHttpServer() as Server,
    dbUrl,
    dynamoEndpoint,
    sql,
    config,
    token,
    close: async () => {
      await started.close();
      await sql.end();
      await Promise.all([postgres.stop(), dynamo.stop()]);
    },
  };
}
