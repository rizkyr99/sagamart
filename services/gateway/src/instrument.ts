// Loaded with `node --import ./dist/instrument.js` before the app: registers OpenTelemetry's ESM loader hook so
// auto-instrumentation can patch http, express and ioredis as they load, then starts telemetry.
import { register } from 'node:module';

// OpenTelemetry's ESM hook is an asynchronous loader that runs off-thread, which only module.register can install;
// module.registerHooks takes synchronous in-thread hooks. Revisit when import-in-the-middle supports registerHooks.
// eslint-disable-next-line @typescript-eslint/no-deprecated
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

const { startTelemetry } = await import('@sagamart/node-common/telemetry');

export const telemetry = startTelemetry({
  service: 'gateway',
  version: process.env.GATEWAY_VERSION ?? 'dev',
  env: process.env.GATEWAY_ENV ?? 'local',
  ...(process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? { otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT }
    : {}),
});
