import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { Controller, Get, Inject, Logger, Req, Res } from '@nestjs/common';
import { ProblemError, problem } from '@sagamart/node-common';
import type { Request, Response } from 'express';
import { DataSource } from 'typeorm';
import type { AppOptions } from './app.module.js';
import type { CatalogConfig } from './config.js';
import { CATALOG_CONFIG, DYNAMODB, METRICS_HANDLER } from './tokens.js';

const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    work,
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`timed out after ${String(ms)} ms`));
      }, ms);
    }),
  ]);

/** Liveness, readiness and metrics (conventions §8). Not under /internal, so no identity is needed. */
@Controller()
export class HealthController {
  private readonly log = new Logger('HealthController');

  constructor(
    private readonly db: DataSource,
    @Inject(DYNAMODB) private readonly dynamo: DynamoDBClient,
    @Inject(CATALOG_CONFIG) private readonly config: CatalogConfig,
    @Inject(METRICS_HANDLER) private readonly metricsHandler: NonNullable<AppOptions['metricsHandler']>,
  ) {}

  @Get('healthz')
  healthz(): { status: string } {
    return { status: 'ok' };
  }

  @Get('readyz')
  async readyz(): Promise<{ status: string }> {
    const checks: [name: string, check: () => Promise<unknown>][] = [
      ['postgres', () => this.db.query('SELECT 1')],
      [
        'dynamodb',
        () => this.dynamo.send(new DescribeTableCommand({ TableName: this.config.dynamo.cartsTable })),
      ],
    ];
    for (const [name, check] of checks) {
      try {
        await withTimeout(check(), 1000);
      } catch (err) {
        // /readyz needs no identity, so the cause (hosts, ports, table names) stays in the log.
        this.log.warn({ dependency: name, err }, 'not ready');
        throw new ProblemError(
          problem({
            status: 503,
            code: 'DEPENDENCY_UNAVAILABLE',
            detail: `Not ready: ${name} is unavailable.`,
          }),
        );
      }
    }
    return { status: 'ok' };
  }

  @Get('metrics')
  metrics(@Req() request: Request, @Res() response: Response): void {
    this.metricsHandler(request, response);
  }
}
