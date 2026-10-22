import { Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { ProblemError, problem } from '@sagamart/node-common';
import type { Problem } from '@sagamart/node-common';
import { CircuitBreaker } from './circuit-breaker.js';
import { InternalClient } from './internal-client.js';
import type { InternalRequest } from './internal-client.js';

const breakerOpen = metrics
  .getMeter('@sagamart/gateway')
  .createCounter('sagamart.gateway.breaker_rejections', {
    description: 'Calls refused without trying because the breaker for the service was open.',
  });

const unavailable = (retryAfterSeconds: number): ProblemError =>
  new ProblemError(
    problem({
      status: 503,
      code: 'DEPENDENCY_UNAVAILABLE',
      detail: 'The catalog service is unavailable.',
      extensions: { retryAfter: retryAfterSeconds },
    }),
  );

/**
 * Catalog's internal API behind a circuit breaker (RFC-0005 §4.5: open after 5 failures, half-open after 10 s).
 * Returns successful bodies; relays Catalog's own errors as Problem Details without its internal paths.
 */
@Injectable()
export class CatalogClient {
  readonly breaker = new CircuitBreaker({ failureThreshold: 5, openMs: 10_000 });

  constructor(private readonly internal: InternalClient) {}

  /** The response on success; callers narrow `body` to the internal contract's shape. */
  async call(req: InternalRequest): Promise<{ status: number; body: unknown }> {
    const permit = this.breaker.allow();
    if (!permit.allowed) {
      breakerOpen.add(1, { service: 'catalog' });
      throw unavailable(Math.max(1, Math.ceil(permit.retryAfterMs / 1000)));
    }
    let response;
    try {
      response = await this.internal.request('catalog', req);
    } catch (err) {
      // Unreachable or late: InternalClient already made it a 503.
      this.breaker.failure();
      throw err;
    }
    // Catalog's own 503 means one of *its* dependencies is down (DynamoDB for carts) while Catalog answers fine,
    // so it doesn't count against the breaker; a 500, 502 or 504 does.
    if (response.status >= 500 && response.status !== 503) this.breaker.failure();
    else this.breaker.success();

    if (response.status >= 400) {
      const body = response.body as Partial<Problem>;
      if (typeof body.code !== 'string' || typeof body.status !== 'number') {
        throw new ProblemError(
          problem({
            status: 502,
            code: 'BAD_GATEWAY',
            detail: 'The catalog service gave an unexpected answer.',
          }),
        );
      }
      // The gateway renders its own instance and traceId; Catalog's would name internal routes.
      const relayed = { ...body } as Problem;
      delete relayed.instance;
      delete relayed.traceId;
      throw new ProblemError(relayed);
    }
    return { status: response.status, body: response.body };
  }
}
