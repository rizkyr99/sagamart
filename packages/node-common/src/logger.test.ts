import { PassThrough } from 'node:stream';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from './logger';

function capture(level = 'info'): {
  lines: () => Record<string, unknown>[];
  log: ReturnType<typeof createLogger>;
} {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c.toString()));
  const log = createLogger({ service: 'catalog', env: 'test', version: '1.2.3', level, destination: stream });
  return {
    log,
    lines: () =>
      chunks
        .join('')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});

describe('createLogger', () => {
  it('writes the convention fields', () => {
    const { log, lines } = capture();
    log.info({ sku: 'KAOS-001-M' }, 'product created');
    const [line] = lines();
    expect(line).toMatchObject({
      level: 'info',
      service: 'catalog',
      env: 'test',
      version: '1.2.3',
      msg: 'product created',
      sku: 'KAOS-001-M',
    });
    expect(line!.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(line).not.toHaveProperty('time');
    expect(line).not.toHaveProperty('pid');
    expect(line).not.toHaveProperty('hostname');
  });

  it('adds trace and span IDs inside an active span', () => {
    const { log, lines } = capture();
    const span = trace.wrapSpanContext({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      traceFlags: 1,
    });
    context.with(trace.setSpan(context.active(), span), () => {
      log.info('inside');
    });
    log.info('outside');
    const [inside, outside] = lines();
    expect(inside).toMatchObject({
      trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
      span_id: '00f067aa0ba902b7',
    });
    expect(outside).not.toHaveProperty('trace_id');
  });

  it('redacts credentials in request headers', () => {
    const { log, lines } = capture();
    log.info(
      {
        req: {
          headers: {
            authorization: 'Bearer secret',
            'x-sagamart-identity': 'tok',
            'x-cart-token': 'cart',
            accept: 'json',
          },
        },
      },
      'request',
    );
    const headers = (lines()[0]!.req as { headers: Record<string, string> }).headers;
    expect(headers).toEqual({
      authorization: '[REDACTED]',
      'x-sagamart-identity': '[REDACTED]',
      'x-cart-token': '[REDACTED]',
      accept: 'json',
    });
  });

  it('respects the level', () => {
    const { log, lines } = capture('warn');
    log.info('hidden');
    log.warn('shown');
    expect(lines().map((l) => l.msg)).toEqual(['shown']);
  });
});
