import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { DescribeTableCommand, DescribeTimeToLiveCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { Controller, Get, Req } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ProblemError, problem, signIdentity } from '@sagamart/node-common';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import request from 'supertest';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule, configureApp } from './app.module.js';
import { loadCatalogConfig } from './config.js';
import { Roles, identityOf } from './identity.js';

@Controller('internal/v1/test')
class TestController {
  @Get('whoami')
  whoami(@Req() req: unknown): { sub: string | null; roles: string[] } {
    const id = identityOf(req);
    return { sub: id.sub ?? null, roles: id.roles };
  }

  @Roles('admin')
  @Get('admin')
  admin(): { ok: boolean } {
    return { ok: true };
  }

  @Get('boom')
  boom(): never {
    throw new Error('connection to db at 10.0.0.5 failed: password=hunter2');
  }

  @Get('conflict')
  conflict(): never {
    throw new ProblemError(problem({ status: 409, code: 'SLUG_TAKEN', detail: 'kaos-polos is taken.' }));
  }
}

const keys = generateKeyPairSync('ed25519');
const privateKey = keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const kid = 'gw-test';
const userId = '0199f2e0-0000-7000-8000-000000000001';

function token(opts: { roles?: string[]; audience?: string; now?: Date; subject?: string } = {}): string {
  return signIdentity({
    privateKey, keyId: kid, audience: opts.audience ?? 'catalog', roles: opts.roles ?? ['buyer'],
    subject: opts.subject ?? userId, ...(opts.now ? { now: opts.now } : {}),
  });
}

let pgContainer: StartedPostgreSqlContainer;
let dynamo: StartedTestContainer;
let app: INestApplication;
let dbUrl: string;
let dynamoEndpoint: string;

beforeAll(async () => {
  [pgContainer, dynamo] = await Promise.all([
    new PostgreSqlContainer('postgres:17.2-alpine').withDatabase('catalog').start(),
    new GenericContainer('amazon/dynamodb-local:2.5.2')
      .withCommand(['-jar', 'DynamoDBLocal.jar', '-inMemory', '-sharedDb'])
      .withExposedPorts(8000)
      .withWaitStrategy(Wait.forListeningPorts())
      .start(),
  ]);
  dbUrl = pgContainer.getConnectionUri();
  dynamoEndpoint = `http://${dynamo.getHost()}:${String(dynamo.getMappedPort(8000))}`;

  const config = loadCatalogConfig({
    CATALOG_ENV: 'test',
    CATALOG_DB_URL: dbUrl,
    CATALOG_DYNAMODB_ENDPOINT: dynamoEndpoint,
    CATALOG_IDENTITY_PUBLIC_KEYS: JSON.stringify({ [kid]: publicKey }),
  });
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        config,
        logDestination: new PassThrough(),
        metricsHandler: (_req, res) => {
          res.setHeader('content-type', 'text/plain; version=0.0.4');
          res.end('sagamart_catalog_test_total 1\n');
        },
      }),
    ],
    controllers: [TestController],
  }).compile();
  app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
});

afterAll(async () => {
  await app?.close();
  await Promise.all([pgContainer?.stop(), dynamo?.stop()]);
});

describe('startup', () => {
  it('runs the migrations: RFC-0005 tables and constraints', async () => {
    const client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
      );
      const tables = rows.map((r) => r.table_name);
      for (const t of ['categories', 'products', 'skus', 'idempotency_keys']) expect(tables).toContain(t);

      const category = randomUUID();
      await client.query(`INSERT INTO categories (id, slug, name) VALUES ($1, 'kaos', 'Kaos')`, [category]);
      await expect(
        client.query(`INSERT INTO products (id, slug, name, category_id, status) VALUES ($1, 'p', 'P', $2, 'ACTIVE')`, [randomUUID(), category]),
      ).rejects.toMatchObject({ constraint: 'active_has_price' });
    } finally {
      await client.end();
    }
  });

  it('creates the carts table with TTL on the ttl attribute (ADR-0009)', async () => {
    const ddb = new DynamoDBClient({ endpoint: dynamoEndpoint, region: 'ap-southeast-3', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
    const table = await ddb.send(new DescribeTableCommand({ TableName: 'carts' }));
    expect(table.Table?.TableStatus).toBe('ACTIVE');
    expect(table.Table?.KeySchema).toEqual([{ AttributeName: 'pk', KeyType: 'HASH' }]);
    const ttl = await ddb.send(new DescribeTimeToLiveCommand({ TableName: 'carts' }));
    expect(ttl.TimeToLiveDescription).toMatchObject({ TimeToLiveStatus: 'ENABLED', AttributeName: 'ttl' });
    ddb.destroy();
  });
});

describe('probes and metrics', () => {
  it('serves /healthz and /readyz without an identity', async () => {
    await request(app.getHttpServer()).get('/healthz').expect(200, { status: 'ok' });
    await request(app.getHttpServer()).get('/readyz').expect(200, { status: 'ok' });
  });

  it('serves /metrics from the telemetry handler', async () => {
    const res = await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(res.text).toContain('sagamart_catalog_test_total 1');
  });
});

describe('identity on /internal routes (contracts/identity.md)', () => {
  const get = (path: string, identity?: string) => {
    const r = request(app.getHttpServer()).get(path);
    return identity === undefined ? r : r.set('x-sagamart-identity', identity);
  };

  it('accepts a valid identity and exposes its claims', async () => {
    const res = await get('/internal/v1/test/whoami', token()).expect(200);
    expect(res.body).toEqual({ sub: userId, roles: ['buyer'] });
  });

  it.each([
    ['missing', undefined],
    ['garbage', 'not-a-token'],
    ['for another service', token({ audience: 'inventory' })],
    ['expired', token({ now: new Date(Date.now() - 120_000) })],
  ])('rejects an identity that is %s with 401 Problem Details', async (_name, identity) => {
    const res = await get('/internal/v1/test/whoami', identity).expect(401);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });

  it('enforces roles: buyer gets 403, admin gets through', async () => {
    const denied = await get('/internal/v1/test/admin', token({ roles: ['buyer'] })).expect(403);
    expect(denied.body).toMatchObject({ code: 'FORBIDDEN' });
    await get('/internal/v1/test/admin', token({ roles: ['admin'] })).expect(200, { ok: true });
  });
});

describe('errors are Problem Details', () => {
  it('renders a ProblemError as is', async () => {
    const res = await request(app.getHttpServer()).get('/internal/v1/test/conflict').set('x-sagamart-identity', token()).expect(409);
    expect(res.body).toMatchObject({ type: 'https://sagamart.dev/errors/slug-taken', status: 409, code: 'SLUG_TAKEN', detail: 'kaos-polos is taken.', instance: '/internal/v1/test/conflict' });
  });

  it('renders an unknown route as 404 NOT_FOUND', async () => {
    const res = await request(app.getHttpServer()).get('/nowhere').expect(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('hides internal error details behind 500 INTERNAL_ERROR', async () => {
    const res = await request(app.getHttpServer()).get('/internal/v1/test/boom').set('x-sagamart-identity', token()).expect(500);
    expect(res.body).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });
});
