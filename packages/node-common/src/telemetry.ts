// OpenTelemetry for Sagamart's Node services (conventions §8). Import and start this before anything else in a
// service's entry point, so auto-instrumentation can patch http, pg, ioredis, the AWS SDK and gRPC as they load.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor, NoopSpanProcessor } from '@opentelemetry/sdk-trace';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export interface TelemetryOptions {
  service: string;
  version: string;
  env: string;
  /** OTLP gRPC endpoint for traces, e.g. http://otel-collector:4317. When absent, spans are still created
   *  (logs carry trace IDs, traceparent propagates) but not exported. */
  otlpEndpoint?: string;
}

export interface Telemetry {
  /** Serves Prometheus metrics; mount it on GET /metrics. */
  metricsHandler(request: IncomingMessage, response: ServerResponse): void;
  shutdown(): Promise<void>;
}

export function startTelemetry(options: TelemetryOptions): Telemetry {
  const prometheus = new PrometheusExporter({ preventServerStart: true });
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.service,
      [ATTR_SERVICE_VERSION]: options.version,
      'deployment.environment.name': options.env,
    }),
    // Always at least one processor: with none, the SDK registers no tracer provider and spans aren't real.
    // Without an endpoint, a no-op processor keeps spans real but exports nothing.
    spanProcessors: [
      options.otlpEndpoint
        ? new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: options.otlpEndpoint }) })
        : new NoopSpanProcessor(),
    ],
    metricReaders: [prometheus],
    // Logs go to stdout only (conventions §7). Without an explicit list the SDK falls back to OTEL_LOGS_EXPORTER,
    // which defaults to OTLP, and the pino instrumentation would forward every log line there.
    logRecordProcessors: [],
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-pino': { disableLogSending: true },
      }),
    ],
  });
  sdk.start();

  return {
    metricsHandler: (request, response) => {
      prometheus.getMetricsRequestHandler(request, response);
    },
    shutdown: () => sdk.shutdown(),
  };
}
