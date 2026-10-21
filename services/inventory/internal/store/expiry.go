package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"

	"github.com/rizkyr99/sagamart/services/inventory/internal/domain"
	"github.com/rizkyr99/sagamart/services/inventory/internal/events"
)

var tracer = otel.Tracer("github.com/rizkyr99/sagamart/services/inventory/internal/store")

// ExpireDue expires up to max active reservations whose TTL has passed, oldest first, returning how many it
// expired. Each one is its own transaction: lock the reservation (skipping any another worker or command holds),
// release its stock in SKU order, mark it EXPIRED and write inventory.reservation.expired to the outbox.
// One transaction per reservation keeps the lock order identical to Commit and Release, so the worker can't
// deadlock with them.
func (s *Store) ExpireDue(ctx context.Context, max int) (int, error) {
	expired := 0
	for expired < max {
		var found bool
		var lagSeconds float64
		// The worker has no incoming request, so each expiry starts its own trace; the event carries it onward.
		ctx, span := tracer.Start(ctx, "inventory.ExpireReservation")
		err := s.inTx(ctx, func(tx pgx.Tx) error {
			found = false // the callback may run again after a deadlock or serialisation failure

			var orderID string
			err := tx.QueryRow(ctx, `
				SELECT order_id::text FROM reservations
				WHERE status = 'ACTIVE' AND expires_at <= now()
				ORDER BY expires_at
				LIMIT 1
				FOR UPDATE SKIP LOCKED`).Scan(&orderID)
			if errors.Is(err, pgx.ErrNoRows) {
				return nil
			}
			if err != nil {
				return fmt.Errorf("find due reservation: %w", err)
			}

			row, err := loadReservation(ctx, tx, orderID, true)
			if err != nil {
				return err
			}
			out, err := domain.Decide(row.Reservation, domain.CommandExpire, row.dbNow)
			if err != nil {
				return err
			}
			if !out.Changed {
				return fmt.Errorf("%w: due reservation %s was not active", domain.ErrInvariant, row.ID)
			}
			expiredAt, err := s.settle(ctx, tx, row.Reservation, out)
			if err != nil {
				return err
			}

			lines := make([]events.ExpiredLine, len(row.Lines))
			for i, l := range row.Lines {
				lines[i] = events.ExpiredLine{SKU: l.SKU, Quantity: l.Quantity}
			}
			if err := writeEvent(ctx, tx, "reservation", orderID, events.TypeReservationExpired, events.ReservationExpired{
				OrderID: orderID, ReservationID: row.ID, Lines: lines, ExpiredAt: events.FormatTime(expiredAt),
			}); err != nil {
				return err
			}
			lagSeconds = row.dbNow.Sub(row.ExpiresAt).Seconds()
			span.SetAttributes(attribute.String("order_id", orderID), attribute.String("reservation_id", row.ID))
			found = true
			return nil
		})
		if err != nil {
			span.RecordError(err)
		}
		span.End()
		if err != nil {
			return expired, s.metrics.observe(ctx, err)
		}
		if !found {
			break
		}
		expired++
		s.metrics.transitioned(ctx, domain.StatusExpired)
		s.metrics.expiryLag.Record(ctx, lagSeconds)
	}
	return expired, nil
}
