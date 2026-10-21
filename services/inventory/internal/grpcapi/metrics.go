package grpcapi

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

const meterName = "github.com/rizkyr99/sagamart/services/inventory/internal/grpcapi"

// Reservation outcomes, the `result` label on reservation metrics (RFC-0001 §6).
const (
	resultReserved          = "reserved"
	resultInsufficientStock = "insufficient_stock"
	resultConflict          = "conflict"
	resultInvalid           = "invalid"
	resultError             = "error"
)

// metrics are exported to Prometheus as sagamart_inventory_reservations_total and
// sagamart_inventory_reservation_duration_seconds.
type metrics struct {
	reservations metric.Int64Counter
	duration     metric.Float64Histogram
}

func newMetrics() metrics {
	meter := otel.Meter(meterName)
	reservations, err := meter.Int64Counter("sagamart.inventory.reservations",
		metric.WithDescription("ReserveStock calls by outcome."))
	if err != nil {
		otel.Handle(err)
	}
	duration, err := meter.Float64Histogram("sagamart.inventory.reservation.duration",
		metric.WithDescription("ReserveStock latency by outcome."), metric.WithUnit("s"),
		metric.WithExplicitBucketBoundaries(.001, .0025, .005, .01, .025, .05, .1, .25, .5, 1, 2.5))
	if err != nil {
		otel.Handle(err)
	}
	return metrics{reservations: reservations, duration: duration}
}

func (m metrics) recordReservation(ctx context.Context, result string, seconds float64) {
	attrs := metric.WithAttributes(attribute.String("result", result))
	m.reservations.Add(ctx, 1, attrs)
	m.duration.Record(ctx, seconds, attrs)
}
