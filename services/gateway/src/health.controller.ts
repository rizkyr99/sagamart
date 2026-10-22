import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AppOptions } from './app.module.js';
import { METRICS_HANDLER } from './tokens.js';

/**
 * Liveness, readiness and metrics (conventions §8). Readiness depends on nothing downstream: the gateway degrades
 * per dependency (RFC-0005 §4.5), so taking it out of rotation when one service is down would only make it worse.
 */
@Controller()
export class HealthController {
  constructor(
    @Inject(METRICS_HANDLER) private readonly metricsHandler: NonNullable<AppOptions['metricsHandler']>,
  ) {}

  @Get('healthz')
  healthz(): { status: string } {
    return { status: 'ok' };
  }

  @Get('readyz')
  readyz(): { status: string } {
    return { status: 'ok' };
  }

  @Get('metrics')
  metrics(@Req() request: Request, @Res() response: Response): void {
    this.metricsHandler(request, response);
  }
}
