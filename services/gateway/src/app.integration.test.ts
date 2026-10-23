import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { verifyIdentity } from '@sagamart/node-common';
import { RedisContainer } from '@testcontainers/redis';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule, configureApp } from './app.module.js';
import { Roles } from './auth.js';
import { loadGatewayConfig } from './config.js';
import { issueDevToken } from './dev-auth.js';
import { InternalClient } from './internal-client.js';
import { callerOf, deadlineOf } from './request-context.js';
import { Contract } from '@sagamart/contract-testing';

// ---- A stand-in internal service that checks the identity exactly as Catalog does ----

const keys = generateKeyPairSync('ed25519');
const privateKey = keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const secret = 'integration-dev-secret-32-chars!!';
const admin = '0199f2e0-0000-7000-8000-00000000a001';
const buyer = '0199f2e0-0000-7000-8000-000000000001';

let stub: Server;
let stubUrl: string;

function stubHandler(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://stub');
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };
  if (url.pathname === '/slow') {
    setTimeout(() => {
      reply(200, { late: true });
    }, 500);
    return;
  }
  try {
    const claims = verifyIdentity(String(req.headers['x-sagamart-identity']), {
      publicKeys: { 'gw-test': publicKey },
      audience: 'catalog',
    });
    reply(200, { sub: claims.sub ?? null, roles: claims.roles, ifMatch: req.headers['if-match'] ?? null });
  } catch (err) {
    reply(401, { error: String(err) });
  }
}

@Controller('v1/test')
class ProbeController {
  constructor(@Inject(InternalClient) private readonly client: InternalClient) {}

  @Get('whoami')
  async whoami(@Req() req: unknown): Promise<unknown> {
    const res = await this.client.request('catalog', {
      method: 'GET',
      path: '/whoami',
      headers: { 'if-match': '"3"' },
      caller: callerOf(req),
      deadline: deadlineOf(req).cap(1000),
    });
    return res.body;
  }

  @Get('slow')
  async slow(@Req() req: unknown, @Query('ms') ms: string): Promise<unknown> {
    return (
      await this.client.request('catalog', {
        method: 'GET',
        path: '/slow',
        caller: callerOf(req),
        deadline: deadlineOf(req).cap(Number(ms)),
      })
    ).body;
  }

  @Roles('admin')
  @Get('admin')
  admin(): { ok: boolean } {
    return { ok: true };
  }
}

// ---- Gateway instances ----

let redis: StartedRedisContainer;
let contract: Contract;
const apps: INestApplication[] = [];

async function start(env: Record<string, string> = {}): Promise<Server> {
  const config = loadGatewayConfig({
    GATEWAY_ENV: 'test',
    GATEWAY_DEV_AUTH: 'true',
    GATEWAY_DEV_JWT_SECRET: secret,
    GATEWAY_IDENTITY_KEY_ID: 'gw-test',
    GATEWAY_IDENTITY_PRIVATE_KEY: privateKey,
    GATEWAY_CATALOG_URL: stubUrl,
    GATEWAY_REDIS_URL: redis.getConnectionUrl(),
    GATEWAY_RATE_LIMIT_PER_SECOND: '1000',
    GATEWAY_RATE_LIMIT_BURST: '1000',
    ...env,
  });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot({ config, logDestination: new PassThrough() })],
    controllers: [ProbeController],
  }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app, config);
  await app.init();
  apps.push(app);
  return app.getHttpServer() as Server;
}

let gw: Server;

beforeAll(async () => {
  stub = createServer(stubHandler);
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  stubUrl = `http://127.0.0.1:${String((stub.address() as AddressInfo).port)}`;
  [redis, contract] = await Promise.all([
    new RedisContainer('redis:7.4.1-alpine').start(),
    Contract.load('public-v1.yaml'),
  ]);
  gw = await start();
});

afterAll(async () => {
  for (const app of apps) await app.close();
  await redis.stop();
  await new Promise((resolve) => stub.close(resolve));
});

const bearer = async (role: 'buyer' | 'admin', userId: string) =>
  `Bearer ${(await issueDevToken({ secret, userId, role })).token}`;

// ---- Tests ----

describe('probes', () => {
  it('answer without credentials, and ignore a bad token', async () => {
    await request(gw).get('/healthz').set('authorization', 'Bearer nonsense').expect(200, { status: 'ok' });
    await request(gw).get('/readyz').expect(200, { status: 'ok' });
    await request(gw).get('/metrics').expect(503); // no telemetry in tests; the route exists
  });
});

describe('POST /v1/dev/token', () => {
  it('issues a token that the gateway then accepts', async () => {
    const res = await request(gw).post('/v1/dev/token').send({ role: 'admin', userId: admin }).expect(200);
    expect(contract.errors('POST', '/v1/dev/token', 200, res.body)).toEqual([]);
    const who = await request(gw)
      .get('/v1/test/whoami')
      .set('authorization', `Bearer ${(res.body as { token: string }).token}`)
      .expect(200);
    expect(who.body).toMatchObject({ sub: admin, roles: ['admin'] });
  });

  it('validates the request', async () => {
    const res = await request(gw).post('/v1/dev/token').send({ role: 'root', userId: 'me' }).expect(400);
    expect(contract.errors('POST', '/v1/dev/token', 400, res.body)).toEqual([]);
    expect((res.body as { errors: unknown[] }).errors).toHaveLength(2);
  });

  it('does not exist when dev auth is off, and then no bearer token is accepted', async () => {
    const off = await start({ GATEWAY_DEV_AUTH: 'false' });
    await request(off).post('/v1/dev/token').send({ role: 'admin', userId: admin }).expect(404);
    const res = await request(off)
      .get('/v1/test/whoami')
      .set('authorization', await bearer('admin', admin))
      .expect(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('authentication and roles', () => {
  it('treats a request without Authorization as anonymous', async () => {
    const res = await request(gw).get('/v1/test/whoami').expect(200);
    expect(res.body).toMatchObject({ sub: null, roles: [] });
  });

  it.each([
    ['not a bearer token', 'Basic dXNlcjpwYXNz'],
    ['a garbage token', 'Bearer abc.def.ghi'],
    ['a token signed with another secret', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl'],
  ])('rejects %s with 401 and WWW-Authenticate', async (_name, authorization) => {
    const res = await request(gw).get('/v1/test/whoami').set('authorization', authorization).expect(401);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
    expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects an expired token', async () => {
    const old = await issueDevToken({
      secret,
      userId: buyer,
      role: 'buyer',
      now: new Date(Date.now() - 2 * 3600_000),
    });
    const res = await request(gw)
      .get('/v1/test/whoami')
      .set('authorization', `Bearer ${old.token}`)
      .expect(401);
    expect(res.body).toMatchObject({ detail: 'The token has expired.' });
  });

  it('enforces roles: anonymous 401, buyer 403, admin 200', async () => {
    await request(gw).get('/v1/test/admin').expect(401);
    const denied = await request(gw)
      .get('/v1/test/admin')
      .set('authorization', await bearer('buyer', buyer))
      .expect(403);
    expect(denied.body).toMatchObject({ code: 'FORBIDDEN' });
    await request(gw)
      .get('/v1/test/admin')
      .set('authorization', await bearer('admin', admin))
      .expect(200, { ok: true });
  });
});

describe('internal calls', () => {
  it('carry an identity signed for the target service, with the caller and forwarded headers', async () => {
    const res = await request(gw)
      .get('/v1/test/whoami')
      .set('authorization', await bearer('buyer', buyer))
      .expect(200);
    expect(res.body).toEqual({ sub: buyer, roles: ['buyer'], ifMatch: '"3"' });
  });

  it('give up at their deadline with 503 and Retry-After', async () => {
    const started = Date.now();
    const res = await request(gw).get('/v1/test/slow').query({ ms: 100 }).expect(503);
    expect(Date.now() - started).toBeLessThan(450);
    expect(res.body).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    expect(res.headers['retry-after']).toBe('1');
  });

  it('turn an unreachable service into 503', async () => {
    const down = await start({ GATEWAY_CATALOG_URL: 'http://127.0.0.1:1' });
    const res = await request(down).get('/v1/test/whoami').expect(503);
    expect(res.body).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
  });
});

describe('rate limiting', () => {
  it('allows a burst, then 429 with Retry-After, then refills', async () => {
    const limited = await start({ GATEWAY_RATE_LIMIT_PER_SECOND: '2', GATEWAY_RATE_LIMIT_BURST: '3' });
    for (let i = 0; i < 3; i++)
      await request(limited)
        .get('/v1/test/admin')
        .set('authorization', await bearer('admin', admin))
        .expect(200);
    const res = await request(limited)
      .get('/v1/test/admin')
      .set('authorization', await bearer('admin', admin))
      .expect(429);
    expect(contract.errors('GET', '/v1/products', 429, res.body)).toEqual([]);
    expect(res.body).toMatchObject({ code: 'RATE_LIMITED' });
    expect(res.headers['retry-after']).toBe('1');
    await new Promise((resolve) => setTimeout(resolve, 600)); // 2 tokens/s: one is back after 500 ms
    await request(limited)
      .get('/v1/test/admin')
      .set('authorization', await bearer('admin', admin))
      .expect(200);
  });

  it('keeps separate buckets per user and per IP', async () => {
    const limited = await start({ GATEWAY_RATE_LIMIT_PER_SECOND: '1', GATEWAY_RATE_LIMIT_BURST: '1' });
    const other = '0199f2e0-0000-7000-8000-000000000777';
    await request(limited)
      .get('/v1/test/whoami')
      .set('authorization', await bearer('buyer', other))
      .expect(200);
    await request(limited)
      .get('/v1/test/whoami')
      .set('authorization', await bearer('buyer', other))
      .expect(429);
    // Anonymous requests from the same IP use the IP's own bucket.
    await request(limited).get('/v1/test/whoami').expect(200);
    await request(limited).get('/v1/test/whoami').expect(429);
  });

  it('fails open, quickly, when Redis is down', async () => {
    const open = await start({
      GATEWAY_REDIS_URL: 'redis://127.0.0.1:1',
      GATEWAY_RATE_LIMIT_PER_SECOND: '1',
      GATEWAY_RATE_LIMIT_BURST: '1',
    });
    for (let i = 0; i < 3; i++) {
      const started = Date.now();
      await request(open).get('/v1/test/whoami').expect(200);
      expect(Date.now() - started).toBeLessThan(200);
    }
  });

  it('fails open within the 50 ms deadline when Redis is slow', async () => {
    const slowRedis = await start({ GATEWAY_RATE_LIMIT_PER_SECOND: '1', GATEWAY_RATE_LIMIT_BURST: '1' });
    await request(slowRedis)
      .get('/v1/test/admin')
      .set('authorization', await bearer('admin', '0199f2e0-0000-7000-8000-000000000888'))
      .expect(200);
    const admin2 = new Redis(redis.getConnectionUrl());
    try {
      await admin2.call('CLIENT', 'PAUSE', '1000', 'ALL'); // Redis stops answering other clients for a second
      const started = Date.now();
      // The bucket is empty, but Redis can't say so in time: the request goes through.
      await request(slowRedis)
        .get('/v1/test/admin')
        .set('authorization', await bearer('admin', '0199f2e0-0000-7000-8000-000000000888'))
        .expect(200);
      expect(Date.now() - started).toBeLessThan(300);
    } finally {
      await admin2.call('CLIENT', 'UNPAUSE');
      admin2.disconnect();
    }
    // With Redis answering again, the empty bucket is enforced: the limit was real all along.
    await request(slowRedis)
      .get('/v1/test/admin')
      .set('authorization', await bearer('admin', '0199f2e0-0000-7000-8000-000000000888'))
      .expect(429);
  });
});
