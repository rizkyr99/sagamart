package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5/pgconn"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"github.com/rizkyr99/sagamart/services/inventory/internal/domain"
)

const (
	meterName         = "github.com/rizkyr99/sagamart/services/inventory/internal/store"
	codeCheckViolated = "23514"
)

// storeMetrics are exported as sagamart_inventory_reservation_transitions_total and
// sagamart_inventory_constraint_violations_total (RFC-0001 §6).
type storeMetrics struct {
	transitions metric.Int64Counter
	violations  metric.Int64Counter
}

func newStoreMetrics() storeMetrics {
	meter := otel.Meter(meterName)
	transitions, err := meter.Int64Counter("sagamart.inventory.reservation.transitions",
		metric.WithDescription("Reservations that changed status, by new status. Idempotent repeats are not counted."))
	if err != nil {
		otel.Handle(err)
	}
	violations, err := meter.Int64Counter("sagamart.inventory.constraint_violations",
		metric.WithDescription("Writes refused by a database check constraint. Anything above zero is a bug; alert on it."))
	if err != nil {
		otel.Handle(err)
	}
	return storeMetrics{transitions: transitions, violations: violations}
}

func (m storeMetrics) transitioned(ctx context.Context, to domain.Status) {
	m.transitions.Add(ctx, 1, metric.WithAttributes(attribute.String("to", string(to))))
}

// observe counts err if it is a check-constraint violation, and returns it unchanged.
func (m storeMetrics) observe(ctx context.Context, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == codeCheckViolated {
		m.violations.Add(ctx, 1, metric.WithAttributes(attribute.String("constraint", pgErr.ConstraintName)))
	}
	return err
}
