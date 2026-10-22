import { Logger, Module } from '@nestjs/common';
import type {
  DynamicModule,
  INestApplication,
  MiddlewareConsumer,
  NestModule,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createLogger } from '@sagamart/node-common';
import { Redis } from 'ioredis';
import { LoggerModule } from 'nestjs-pino';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AuthMiddleware, RateLimitMiddleware, RolesGuard } from './auth.js';
import type { GatewayConfig } from './config.js';
import { DEADLINES } from './deadline.js';
import { BrowseController } from './browse.controller.js';
import { CartController } from './cart.controller.js';
import { CatalogClient } from './catalog-client.js';
import { DevController } from './dev.controller.js';
import { HealthController } from './health.controller.js';
import { InternalClient } from './internal-client.js';
import { InventoryClient } from './inventory-client.js';
import { ProblemFilter } from './problem.filter.js';
import { RateLimiter, bucketClient } from './rate-limit.js';
import { GATEWAY_CONFIG, METRICS_HANDLER, RATE_LIMITER, REDIS } from './tokens.js';

export interface AppOptions {
  config: GatewayConfig;
  /** Serves /metrics; from the telemetry started in instrument.ts. */
  metricsHandler?: (request: IncomingMessage, response: ServerResponse) => void;
  /** Where logs go; stdout by default. */
  logDestination?: NodeJS.WritableStream;
  /** Runs last on shutdown, after Nest has closed the server and connections (flushes telemetry). */
  onShutdown?: () => Promise<void>;
}

/** Closes Redis, then calls AppOptions.onShutdown, from Nest's own shutdown sequence. */
class ShutdownHook implements OnApplicationShutdown {
  constructor(
    private readonly redis: Redis,
    private readonly hook: (() => Promise<void>) | undefined,
  ) {}

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.redis.disconnect();
    await this.hook?.();
    new Logger('Shutdown').log({ signal }, 'shutdown complete');
  }
}

const PROBES = ['/healthz', '/readyz', '/metrics'];

/** Redis for rate limiting only. Fast failure is the point: 50 ms per command, no queueing while disconnected. */
function createRedis(config: GatewayConfig): Redis {
  const redis = new Redis(config.redisUrl, {
    commandTimeout: DEADLINES.redis,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    lazyConnect: false,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2000), // keep reconnecting in the background
  });
  // Errors surface per command (and fail open); an unhandled 'error' event would crash the process.
  redis.on('error', (err) => {
    new Logger('Redis').warn({ err: err.message }, 'redis connection error');
  });
  return redis;
}

/** Waits briefly for Redis at startup, so a fresh gateway doesn't start out unlimited. Never blocks startup. */
class RedisReady implements OnApplicationBootstrap {
  constructor(private readonly redis: Redis) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.redis.status === 'ready') return;
    const ready = await Promise.race([
      new Promise<boolean>((resolve) =>
        this.redis.once('ready', () => {
          resolve(true);
        }),
      ),
      new Promise<boolean>((resolve) =>
        setTimeout(() => {
          resolve(false);
        }, 1000).unref(),
      ),
    ]);
    if (!ready) new Logger('Redis').warn('redis not ready at startup; rate limiting fails open until it is');
  }
}

@Module({})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(AuthMiddleware, RateLimitMiddleware)
      .exclude(...PROBES.map((p) => p.slice(1)))
      .forRoutes('*path');
  }

  static forRoot(options: AppOptions): DynamicModule {
    const { config } = options;
    const logger = createLogger({
      service: 'gateway',
      env: config.env,
      version: config.version,
      level: config.logLevel,
      ...(options.logDestination ? { destination: options.logDestination } : {}),
    });
    const redis = createRedis(config);

    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: { logger, autoLogging: { ignore: (req) => PROBES.includes(req.url ?? '') } },
        }),
      ],
      // The dev token route exists only when dev auth is on (RFC-0005 §8).
      controllers: [
        HealthController,
        BrowseController,
        CartController,
        ...(config.devAuth.enabled ? [DevController] : []),
      ],
      providers: [
        { provide: GATEWAY_CONFIG, useValue: config },
        {
          provide: METRICS_HANDLER,
          useValue:
            options.metricsHandler ??
            ((_req: IncomingMessage, res: ServerResponse) => {
              res.statusCode = 503;
              res.end('# telemetry not started\n');
            }),
        },
        { provide: REDIS, useValue: redis },
        { provide: RATE_LIMITER, useValue: new RateLimiter(bucketClient(redis), config.rateLimit) },
        InternalClient,
        CatalogClient,
        InventoryClient,
        AuthMiddleware,
        RateLimitMiddleware,
        { provide: RedisReady, useFactory: () => new RedisReady(redis) },
        { provide: ShutdownHook, useFactory: () => new ShutdownHook(redis, options.onShutdown) },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
      exports: [GATEWAY_CONFIG, InternalClient, CatalogClient, InventoryClient],
    };
  }
}

/** App-wide setup shared by main.ts and tests: client IPs, error format, shutdown hooks. */
export function configureApp(app: INestApplication, config: GatewayConfig): void {
  (app as NestExpressApplication).set('trust proxy', config.trustProxy);
  app.useGlobalFilters(new ProblemFilter());
  app.enableShutdownHooks();
}
