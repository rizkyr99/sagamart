import type { DynamicModule, INestApplication } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CatalogConfig } from './config.js';

export interface AppOptions {
  config: CatalogConfig;
  /** Serves /metrics; from the telemetry started in instrument.ts. */
  metricsHandler?: (request: IncomingMessage, response: ServerResponse) => void;
  /** Where logs go; stdout by default. */
  logDestination?: NodeJS.WritableStream;
}

export class AppModule {
  static forRoot(_options: AppOptions): DynamicModule {
    throw new Error('not implemented');
  }
}

/** App-wide setup shared by main.ts and tests: error format, shutdown hooks. */
export function configureApp(_app: INestApplication): void {
  throw new Error('not implemented');
}
