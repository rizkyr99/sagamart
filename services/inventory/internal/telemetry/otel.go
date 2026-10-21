package telemetry

import (
	"context"
	"errors"
	"fmt"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	otelprom "go.opentelemetry.io/otel/exporters/prometheus"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// Options configures OpenTelemetry for one service.
type Options struct {
	Service string
	Env     string
	Version string
	// OTLPEndpoint receives traces, e.g. http://otel-collector:4317. When empty, spans are still created
	// (so logs carry trace IDs and traceparent propagates) but not exported.
	OTLPEndpoint string
}

// Setup installs the global tracer and meter providers and the W3C propagator.
// Metrics are exposed for Prometheus to scrape on /metrics. The returned function flushes and shuts down both.
func Setup(ctx context.Context, opts Options) (shutdown func(context.Context) error, err error) {
	res := resource.NewSchemaless(
		attribute.String("service.name", opts.Service),
		attribute.String("service.version", opts.Version),
		attribute.String("deployment.environment.name", opts.Env),
	)

	tpOpts := []sdktrace.TracerProviderOption{sdktrace.WithResource(res)}
	if opts.OTLPEndpoint != "" {
		exp, err := otlptracegrpc.New(ctx, otlptracegrpc.WithEndpointURL(opts.OTLPEndpoint))
		if err != nil {
			return nil, fmt.Errorf("create OTLP trace exporter: %w", err)
		}
		tpOpts = append(tpOpts, sdktrace.WithBatcher(exp))
	}
	tp := sdktrace.NewTracerProvider(tpOpts...)

	promExp, err := otelprom.New()
	if err != nil {
		return nil, fmt.Errorf("create Prometheus exporter: %w", err)
	}
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithReader(promExp), sdkmetric.WithResource(res))

	otel.SetTracerProvider(tp)
	otel.SetMeterProvider(mp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))

	return func(ctx context.Context) error {
		return errors.Join(tp.Shutdown(ctx), mp.Shutdown(ctx))
	}, nil
}
