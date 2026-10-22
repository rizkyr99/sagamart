import { Module } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import type {
  DynamicModule,
  INestApplication,
  MiddlewareConsumer,
  NestModule,
  OnApplicationShutdown,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { createLogger } from '@sagamart/node-common';
import { LoggerModule } from 'nestjs-pino';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CatalogConfig } from './config.js';
import { DynamoLifecycle, createDynamoClient } from './dynamo.js';
import { HealthController } from './health.controller.js';
import { IdentityMiddleware, RolesGuard } from './identity.js';
import { InitialSchema1761100000000 } from './migrations/1761100000000-InitialSchema.js';
import { ProblemFilter } from './problem.filter.js';
import { CATALOG_CONFIG, DYNAMODB, METRICS_HANDLER } from './tokens.js';

export interface AppOptions {
  config: CatalogConfig;
  /** Serves /metrics; from the telemetry started in instrument.ts. */
  metricsHandler?: (request: IncomingMessage, response: ServerResponse) => void;
  /** Where logs go; stdout by default. */
  logDestination?: NodeJS.WritableStream;
  /** Runs last on shutdown, after Nest has closed the server and connections (flushes telemetry). */
  onShutdown?: () => Promise<void>;
}

/** Calls AppOptions.onShutdown from Nest's own shutdown sequence, so SIGTERM drains, closes, then flushes. */
class ShutdownHook implements OnApplicationShutdown {
  constructor(private readonly hook: (() => Promise<void>) | undefined) {}

  async onApplicationShutdown(signal?: string): Promise<void> {
    await this.hook?.();
    new Logger('Shutdown').log({ signal }, 'shutdown complete');
  }
}

const QUIET_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

@Module({})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(IdentityMiddleware).forRoutes('internal/*path');
  }

  static forRoot(options: AppOptions): DynamicModule {
    const { config } = options;
    const logger = createLogger({
      service: 'catalog',
      env: config.env,
      version: config.version,
      level: config.logLevel,
      ...(options.logDestination ? { destination: options.logDestination } : {}),
    });

    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: { logger, autoLogging: { ignore: (req) => QUIET_PATHS.has(req.url ?? '') } },
        }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: config.dbUrl,
          entities: [],
          migrations: [InitialSchema1761100000000],
          migrationsRun: config.migrateOnStart,
          synchronize: false,
          // RFC-0005 §4.4: no statement runs longer than the gateway would wait.
          extra: { statement_timeout: 2000, max: 20 },
        }),
      ],
      controllers: [HealthController],
      providers: [
        { provide: CATALOG_CONFIG, useValue: config },
        {
          provide: METRICS_HANDLER,
          useValue:
            options.metricsHandler ??
            ((_req: IncomingMessage, res: ServerResponse) => {
              res.statusCode = 503;
              res.end('# telemetry not started\n');
            }),
        },
        { provide: DYNAMODB, useFactory: () => createDynamoClient(config) },
        DynamoLifecycle,
        { provide: ShutdownHook, useFactory: () => new ShutdownHook(options.onShutdown) },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    };
  }
}

/** App-wide setup shared by main.ts and tests: error format, shutdown hooks. */
export function configureApp(app: INestApplication): void {
  app.useGlobalFilters(new ProblemFilter());
  app.enableShutdownHooks();
}
