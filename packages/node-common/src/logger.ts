import { context, isSpanContextValid, trace } from '@opentelemetry/api';
import pino from 'pino';
import type { Logger } from 'pino';

export type { Logger } from 'pino';

export interface LoggerOptions {
  service: string;
  env: string;
  version: string;
  level?: string;
  /** Where to write; defaults to stdout. */
  destination?: NodeJS.WritableStream;
}

/** Request headers that carry credentials; never logged. */
const REDACTED_HEADERS = ['authorization', 'cookie', '"x-sagamart-identity"', '"x-cart-token"'];

/**
 * A pino logger with the shared field names (conventions §7): ts, level, service, env, version, msg, and
 * trace_id / span_id from the active OpenTelemetry span. Credentials in request headers are redacted.
 */
export function createLogger(options: LoggerOptions): Logger {
  return pino(
    {
      level: options.level ?? 'info',
      base: { service: options.service, env: options.env, version: options.version },
      messageKey: 'msg',
      timestamp: () => `,"ts":"${new Date().toISOString()}"`,
      formatters: { level: (label) => ({ level: label }) },
      mixin() {
        const span = trace.getSpanContext(context.active());
        return span && isSpanContextValid(span) ? { trace_id: span.traceId, span_id: span.spanId } : {};
      },
      redact: {
        paths: REDACTED_HEADERS.map((h) => `req.headers.${h.startsWith('"') ? `[${h}]` : h}`),
        censor: '[REDACTED]',
      },
    },
    options.destination ?? process.stdout,
  );
}
