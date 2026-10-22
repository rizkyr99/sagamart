import { request } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isSpanContextValid, metrics, trace } from '@opentelemetry/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTelemetry } from './telemetry';
import type { Telemetry } from './telemetry';

let telemetry: Telemetry;

beforeAll(() => {
  telemetry = startTelemetry({ service: 'node-common-test', version: '0.0.0', env: 'test' });
});

afterAll(async () => {
  await telemetry.shutdown();
});

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    request(url, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => {
        body += c.toString();
      });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body });
      });
    })
      .on('error', reject)
      .end();
  });
}

describe('startTelemetry', () => {
  it('creates real spans without an exporter, so logs get trace IDs', () => {
    const span = trace.getTracer('test').startSpan('work');
    expect(isSpanContextValid(span.spanContext())).toBe(true);
    span.end();
  });

  it('serves metrics in Prometheus format', async () => {
    metrics.getMeter('test').createCounter('sagamart.test.things').add(3);
    const server = createServer((req, res) => {
      telemetry.metricsHandler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const { status, body } = await get(`http://127.0.0.1:${String(port)}/metrics`);
      expect(status).toBe(200);
      expect(body).toMatch(/sagamart_test_things_total\{[^}]*\} 3/);
    } finally {
      server.close();
    }
  });
});
