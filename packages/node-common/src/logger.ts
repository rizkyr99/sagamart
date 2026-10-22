import type { Logger } from 'pino';

export interface LoggerOptions {
  service: string;
  env: string;
  version: string;
  level?: string;
  /** Where to write; defaults to stdout. */
  destination?: NodeJS.WritableStream;
}

/**
 * A pino logger with the shared field names (conventions §7): ts, level, service, env, version, msg, and
 * trace_id / span_id from the active OpenTelemetry span. Credentials in request headers are redacted.
 */
export function createLogger(_options: LoggerOptions): Logger {
  throw new Error('not implemented');
}
