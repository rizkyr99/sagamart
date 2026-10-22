import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// OpenTelemetry's auto-instrumentation patches pino through require hooks, which don't apply to modules Vitest
// loads. So this runs the built package in a plain node process, as a service does (`pnpm test` builds first).
describe('startTelemetry and logs', () => {
  it('never exports logs over OTLP, even with a platform-wide OTLP endpoint (conventions §7: stdout only)', () => {
    const fixture = join(__dirname, '..', 'test-fixtures', 'otlp-log-leak.cjs');
    const dist = join(__dirname, '..', 'dist');
    const output = execFileSync(process.execPath, [fixture, dist], { encoding: 'utf8', timeout: 30_000 });
    const received = JSON.parse(output.trim().split('\n').pop() ?? '[]') as string[];
    expect(received.filter((r) => r.includes('/v1/logs'))).toEqual([]);
  });
});
