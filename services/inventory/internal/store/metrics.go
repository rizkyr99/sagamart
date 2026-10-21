package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
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
// sagamart_inventory_expiry_lag_seconds and sagamart_inventory_active_reservations are the expiry worker's.
type storeMetrics struct {
	transitions metric.Int64Counter
	violations  metric.Int64Counter
	expiryLag   metric.Float64Histogram
}

func newStoreMetrics(mp metric.MeterProvider, pool *pgxpool.Pool) storeMetrics {
	meter := mp.Meter(meterName)
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
	expiryLag, err := meter.Float64Histogram("sagamart.inventory.expiry.lag",
		metric.WithDescription("Time between a reservation's expires_at and the worker expiring it. FR-06 allows 30 s."),
		metric.WithUnit("s"), metric.WithExplicitBucketBoundaries(.1, .5, 1, 2.5, 5, 7.5, 10, 15, 30, 60))
	if err != nil {
		otel.Handle(err)
	}
	if _, err := meter.Int64ObservableGauge("sagamart.inventory.active_reservations",
		metric.WithDescription("Reservations holding stock right now."),
		metric.WithInt64Callback(func(ctx context.Context, o metric.Int64Observer) error {
			ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
			defer cancel()
			var n int64
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM reservations WHERE status = 'ACTIVE'`).Scan(&n); err != nil {
				return err
			}
			o.Observe(n)
			return nil
		})); err != nil {
		otel.Handle(err)
	}
	if _, err := meter.Int64ObservableGauge("sagamart.inventory.outbox.pending",
		metric.WithDescription("Events written but not yet published. Grows while the broker is down; alert if it stays high."),
		metric.WithInt64Callback(func(ctx context.Context, o metric.Int64Observer) error {
			ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
			defer cancel()
			var n int64
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM outbox WHERE published_at IS NULL`).Scan(&n); err != nil {
				return err
			}
			o.Observe(n)
			return nil
		})); err != nil {
		otel.Handle(err)
	}
	return storeMetrics{transitions: transitions, violations: violations, expiryLag: expiryLag}
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
