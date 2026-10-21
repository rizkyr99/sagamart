package outbox

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// metrics are exported as sagamart_inventory_outbox_published_total, sagamart_inventory_outbox_lag_seconds
// (outbox write to broker acknowledgement) and sagamart_inventory_outbox_failures_total.
type metrics struct {
	publishedTotal metric.Int64Counter
	lag            metric.Float64Histogram
	failures       metric.Int64Counter
}

func newMetrics() metrics {
	meter := otel.Meter("github.com/rizkyr99/sagamart/services/inventory/internal/outbox")
	publishedTotal, err := meter.Int64Counter("sagamart.inventory.outbox.published",
		metric.WithDescription("Events published to the broker, by type."))
	if err != nil {
		otel.Handle(err)
	}
	lag, err := meter.Float64Histogram("sagamart.inventory.outbox.lag",
		metric.WithDescription("Time from the outbox write to the broker acknowledging the event (ADR-0006 follow-up)."),
		metric.WithUnit("s"), metric.WithExplicitBucketBoundaries(.01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10, 30))
	if err != nil {
		otel.Handle(err)
	}
	failures, err := meter.Int64Counter("sagamart.inventory.outbox.failures",
		metric.WithDescription("Relay runs that failed to publish; the batch is retried with backoff."))
	if err != nil {
		otel.Handle(err)
	}
	return metrics{publishedTotal: publishedTotal, lag: lag, failures: failures}
}

func (m metrics) published(ctx context.Context, eventType string, lagSeconds float64) {
	m.publishedTotal.Add(ctx, 1, metric.WithAttributes(attribute.String("type", eventType)))
	m.lag.Record(ctx, lagSeconds)
}
