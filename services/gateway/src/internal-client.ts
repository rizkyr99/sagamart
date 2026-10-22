import { Inject, Injectable, Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { IDENTITY_HEADER, ProblemError, problem, signIdentity } from '@sagamart/node-common';
import type { GatewayConfig } from './config.js';
import type { Deadline } from './deadline.js';
import type { Caller } from './dev-auth.js';
import { GATEWAY_CONFIG } from './tokens.js';

/** Services the gateway calls over HTTP. Each is also the identity's audience (contracts/identity.md). */
export type HttpService = 'catalog';

export interface InternalRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Forwarded headers, such as If-Match and Idempotency-Key. */
  headers?: Record<string, string | undefined>;
  caller: Caller;
  /** Already capped to the call's own deadline (Deadline.cap). */
  deadline: Deadline;
}

export interface InternalResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

const failures = metrics.getMeter('@sagamart/gateway').createCounter('sagamart.gateway.dependency_failures', {
  description: 'Internal calls that failed or missed their deadline, by service and reason.',
});

/**
 * Calls internal services as the gateway (RFC-0005 §4.2): every request carries a fresh `x-sagamart-identity` for
 * that one service and is aborted at its deadline. A service's own answers, errors included, are returned as they
 * are for the caller to relay; only an unreachable or late service becomes 503.
 */
@Injectable()
export class InternalClient {
  private readonly log = new Logger('InternalClient');
  private readonly baseUrls: Record<HttpService, string>;

  constructor(@Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig) {
    this.baseUrls = { catalog: config.catalogUrl };
  }

  /** The identity token for `caller`, signed for `audience` alone (60 s). */
  identityFor(caller: Caller, audience: string): string {
    return signIdentity({
      privateKey: this.config.identity.privateKey,
      keyId: this.config.identity.keyId,
      audience,
      roles: caller.roles,
      ...(caller.sub === undefined ? {} : { subject: caller.sub }),
    });
  }

  async request(service: HttpService, req: InternalRequest): Promise<InternalResponse> {
    const url = new URL(req.path, this.baseUrls[service]);
    for (const [key, value] of Object.entries(req.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { [IDENTITY_HEADER]: this.identityFor(req.caller, service) };
    for (const [key, value] of Object.entries(req.headers ?? {}))
      if (value !== undefined) headers[key] = value;
    if (req.body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        method: req.method,
        headers,
        ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
        signal: req.deadline.signal(),
      });
      text = await response.text();
    } catch (err) {
      const reason =
        err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')
          ? 'deadline'
          : 'unreachable';
      failures.add(1, { service, reason });
      this.log.warn({ service, path: req.path, reason, err }, 'internal call failed');
      throw new ProblemError(
        problem({
          status: 503,
          code: 'DEPENDENCY_UNAVAILABLE',
          detail: `The ${service} service is unavailable.`,
        }),
      );
    }
    const json = (response.headers.get('content-type') ?? '').includes('json') && text !== '';
    return {
      status: response.status,
      headers: response.headers,
      body: json ? (JSON.parse(text) as unknown) : text,
    };
  }
}
