package store

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/metric"

	"github.com/rizkyr99/sagamart/services/inventory/internal/domain"
	"github.com/rizkyr99/sagamart/services/inventory/internal/events"
)

// Store runs Inventory's commands against Postgres. Each command is one transaction; correctness under
// concurrency comes from atomic conditional updates and row locks taken in a fixed order (RFC-0001 §4.6):
// the reservation row first, then stock rows in ascending SKU order.
type Store struct {
	pool    *pgxpool.Pool
	metrics storeMetrics
}

// Option configures a Store.
type Option func(*options)

type options struct{ meterProvider metric.MeterProvider }

// WithMeterProvider records the store's metrics with mp instead of the global provider.
func WithMeterProvider(mp metric.MeterProvider) Option {
	return func(o *options) { o.meterProvider = mp }
}

// New returns a Store using pool.
func New(pool *pgxpool.Pool, opts ...Option) *Store {
	o := options{meterProvider: otel.GetMeterProvider()}
	for _, opt := range opts {
		opt(&o)
	}
	return &Store{pool: pool, metrics: newStoreMetrics(o.meterProvider, pool)}
}

// lineDidNotFit aborts a reservation transaction at the first line without enough available stock.
type lineDidNotFit struct{ line domain.Line }

func (e lineDidNotFit) Error() string { return "line did not fit: " + e.line.SKU }

// Reserve holds stock for every line of req or none. req must be normalized by domain.Limits.NormalizeReserve.
// A repeat for the same order returns the original reservation, or domain.ErrReservationConflict when the
// lines differ. Lines that don't fit return a *domain.InsufficientStockError.
func (s *Store) Reserve(ctx context.Context, req domain.ReserveRequest) (domain.Reservation, error) {
	// The lock order must not depend on the caller, so sort here as well.
	lines := slices.Clone(req.Lines)
	slices.SortFunc(lines, func(a, b domain.Line) int { return cmp.Compare(a.SKU, b.SKU) })

	var res domain.Reservation
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		id, err := uuid.NewV7()
		if err != nil {
			return err
		}

		// Claim the order first. A concurrent attempt for the same order waits here on the unique index
		// and, once this one commits, takes the retry path below.
		var expiresAt time.Time
		err = tx.QueryRow(ctx, `
			INSERT INTO reservations (id, order_id, status, expires_at)
			VALUES ($1, $2, 'ACTIVE', now() + $3::bigint * interval '1 microsecond')
			ON CONFLICT (order_id) DO NOTHING
			RETURNING expires_at`,
			id, req.OrderID, req.TTL.Microseconds()).Scan(&expiresAt)
		if errors.Is(err, pgx.ErrNoRows) {
			existing, err := loadReservation(ctx, tx, req.OrderID, false)
			if err != nil {
				return err
			}
			if err := domain.CheckRetry(existing.Reservation, domain.ReserveRequest{OrderID: req.OrderID, Lines: lines}); err != nil {
				return err
			}
			res = existing.Reservation
			return nil
		}
		if err != nil {
			return fmt.Errorf("insert reservation: %w", err)
		}

		for _, line := range lines {
			// Atomic check-and-reserve: Postgres re-evaluates the WHERE clause against the latest committed
			// row after waiting for any concurrent writer, so two buyers can't both take the last unit.
			tag, err := tx.Exec(ctx, `
				UPDATE stock_levels
				SET reserved = reserved + $2, version = version + 1, updated_at = now()
				WHERE sku = $1 AND on_hand - reserved >= $2`,
				line.SKU, line.Quantity)
			if err != nil {
				return fmt.Errorf("reserve %s: %w", line.SKU, err)
			}
			if tag.RowsAffected() == 0 {
				return lineDidNotFit{line}
			}
		}

		skus, quantities := splitLines(lines)
		if _, err := tx.Exec(ctx, `
			INSERT INTO reservation_lines (reservation_id, sku, quantity)
			SELECT $1, unnest($2::text[]), unnest($3::bigint[])`,
			id, skus, quantities); err != nil {
			return fmt.Errorf("insert reservation lines: %w", err)
		}

		res = domain.Reservation{
			ID: id.String(), OrderID: req.OrderID, Status: domain.StatusActive, Lines: lines, ExpiresAt: expiresAt,
		}
		return nil
	})
	err = s.metrics.observe(ctx, err)

	var notFit lineDidNotFit
	if errors.As(err, &notFit) {
		return domain.Reservation{}, s.shortfalls(ctx, lines, notFit.line)
	}
	if err != nil {
		return domain.Reservation{}, err
	}
	return res, nil
}

// shortfalls builds the INSUFFICIENT_STOCK detail after a failed reservation, from a fresh read of every line.
// Stock may have been released in the meantime; the line that failed is always reported.
func (s *Store) shortfalls(ctx context.Context, lines []domain.Line, failed domain.Line) error {
	skus, _ := splitLines(lines)
	levels, err := s.StockLevels(ctx, skus)
	if err != nil {
		return fmt.Errorf("read stock after failed reservation: %w", err)
	}
	bySKU := make(map[string]domain.StockLevel, len(levels))
	for _, l := range levels {
		bySKU[l.SKU] = l
	}
	if _, err := domain.ReserveLines(bySKU, lines); err != nil {
		return err
	}
	return &domain.InsufficientStockError{Shortfalls: []domain.Shortfall{{
		SKU: failed.SKU, Requested: failed.Quantity, Available: max(bySKU[failed.SKU].Available(), 0),
	}}}
}

// Commit sells the order's reserved units and returns when it was committed (the original time on a repeat).
func (s *Store) Commit(ctx context.Context, orderID string) (time.Time, error) {
	var committedAt time.Time
	var changed bool
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		changed = false // the callback may run again after a deadlock or serialisation failure
		row, err := loadReservation(ctx, tx, orderID, true)
		if err != nil {
			return err
		}
		out, err := domain.Decide(row.Reservation, domain.CommandCommit, row.dbNow)
		if err != nil {
			return err
		}
		if !out.Changed {
			if row.finalizedAt == nil {
				return fmt.Errorf("%w: committed reservation %s has no finalized_at", domain.ErrInvariant, row.ID)
			}
			committedAt = *row.finalizedAt
			return nil
		}
		committedAt, err = s.settle(ctx, tx, row.Reservation, out)
		changed = err == nil
		return err
	})
	if err != nil {
		return time.Time{}, s.metrics.observe(ctx, err)
	}
	if changed {
		s.metrics.transitioned(ctx, domain.StatusCommitted)
	}
	return committedAt, nil
}

// Release returns the order's reserved units and reports the final status: RELEASED, or EXPIRED when the
// reservation had already expired.
func (s *Store) Release(ctx context.Context, orderID string) (domain.Status, error) {
	var status domain.Status
	var changed bool
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		changed = false // the callback may run again after a deadlock or serialisation failure
		row, err := loadReservation(ctx, tx, orderID, true)
		if err != nil {
			return err
		}
		out, err := domain.Decide(row.Reservation, domain.CommandRelease, row.dbNow)
		if err != nil {
			return err
		}
		status = out.Status
		if out.Changed {
			_, err = s.settle(ctx, tx, row.Reservation, out)
			changed = err == nil
		}
		return err
	})
	if err != nil {
		return "", s.metrics.observe(ctx, err)
	}
	if changed {
		s.metrics.transitioned(ctx, status)
	}
	return status, nil
}

// settle applies a transition: each line's stock operation in SKU order, then the reservation's new status.
func (s *Store) settle(ctx context.Context, tx pgx.Tx, res domain.Reservation, out domain.Outcome) (time.Time, error) {
	var query string
	switch out.StockOp {
	case domain.StockOpCommit:
		query = `UPDATE stock_levels
			SET on_hand = on_hand - $2, reserved = reserved - $2, version = version + 1, updated_at = now()
			WHERE sku = $1 AND reserved >= $2`
	case domain.StockOpRelease:
		query = `UPDATE stock_levels
			SET reserved = reserved - $2, version = version + 1, updated_at = now()
			WHERE sku = $1 AND reserved >= $2`
	default:
		return time.Time{}, fmt.Errorf("%w: transition to %s without a stock operation", domain.ErrInvariant, out.Status)
	}
	for _, line := range res.Lines {
		tag, err := tx.Exec(ctx, query, line.SKU, line.Quantity)
		if err != nil {
			return time.Time{}, fmt.Errorf("settle %s: %w", line.SKU, err)
		}
		if tag.RowsAffected() == 0 {
			return time.Time{}, fmt.Errorf("%w: %s has less than %d reserved for reservation %s",
				domain.ErrInvariant, line.SKU, line.Quantity, res.ID)
		}
	}

	var finalizedAt time.Time
	if err := tx.QueryRow(ctx, `
		UPDATE reservations SET status = $2, finalized_at = now() WHERE id = $1 RETURNING finalized_at`,
		res.ID, string(out.Status)).Scan(&finalizedAt); err != nil {
		return time.Time{}, fmt.Errorf("finalize reservation: %w", err)
	}
	return finalizedAt, nil
}

// reservationRow is a reservation as stored, with the database clock read in the same statement.
type reservationRow struct {
	domain.Reservation
	finalizedAt *time.Time
	dbNow       time.Time // Postgres now(): the one clock expiry is judged by (RFC-0001 decision log)
}

// loadReservation reads an order's reservation and its lines, optionally locking the reservation row.
func loadReservation(ctx context.Context, tx pgx.Tx, orderID string, forUpdate bool) (reservationRow, error) {
	query := `SELECT id::text, status, expires_at, finalized_at, now() FROM reservations WHERE order_id = $1`
	if forUpdate {
		query += ` FOR UPDATE`
	}
	var row reservationRow
	var status string
	err := tx.QueryRow(ctx, query, orderID).Scan(&row.ID, &status, &row.ExpiresAt, &row.finalizedAt, &row.dbNow)
	if errors.Is(err, pgx.ErrNoRows) {
		return reservationRow{}, domain.ErrReservationNotFound
	}
	if err != nil {
		return reservationRow{}, fmt.Errorf("load reservation: %w", err)
	}
	row.OrderID, row.Status = orderID, domain.Status(status)

	rows, err := tx.Query(ctx, `SELECT sku, quantity FROM reservation_lines WHERE reservation_id = $1 ORDER BY sku`, row.ID)
	if err != nil {
		return reservationRow{}, fmt.Errorf("load reservation lines: %w", err)
	}
	row.Lines, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.Line, error) {
		var l domain.Line
		err := r.Scan(&l.SKU, &l.Quantity)
		return l, err
	})
	if err != nil {
		return reservationRow{}, fmt.Errorf("load reservation lines: %w", err)
	}
	return row, nil
}

// StockLevels returns the levels of the known SKUs among skus, ordered by SKU.
func (s *Store) StockLevels(ctx context.Context, skus []string) ([]domain.StockLevel, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT sku, on_hand, reserved, version FROM stock_levels WHERE sku = ANY($1) ORDER BY sku`, skus)
	if err != nil {
		return nil, fmt.Errorf("query stock levels: %w", err)
	}
	return pgx.CollectRows(rows, scanStockLevel)
}

func scanStockLevel(r pgx.CollectableRow) (domain.StockLevel, error) {
	var l domain.StockLevel
	err := r.Scan(&l.SKU, &l.OnHand, &l.Reserved, &l.Version)
	return l, err
}

// SetStock sets a SKU's on-hand quantity (admin, PRD FR-11) and writes inventory.stock.adjusted to the
// outbox in the same transaction. expectedVersion 0 creates the SKU.
func (s *Store) SetStock(ctx context.Context, sku string, onHand, expectedVersion int64) (domain.StockLevel, error) {
	var next domain.StockLevel
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		var current *domain.StockLevel
		rows, err := tx.Query(ctx, `SELECT sku, on_hand, reserved, version FROM stock_levels WHERE sku = $1 FOR UPDATE`, sku)
		if err != nil {
			return fmt.Errorf("lock stock level: %w", err)
		}
		found, err := pgx.CollectRows(rows, scanStockLevel)
		if err != nil {
			return fmt.Errorf("lock stock level: %w", err)
		}
		if len(found) == 1 {
			current = &found[0]
		}

		next, err = domain.SetStock(current, sku, onHand, expectedVersion)
		if err != nil {
			return err
		}

		if current == nil {
			_, err = tx.Exec(ctx, `INSERT INTO stock_levels (sku, on_hand, version) VALUES ($1, $2, $3)`, sku, next.OnHand, next.Version)
			if hasCode(err, codeUniqueViolation) {
				return fmt.Errorf("%w: %s was created concurrently", domain.ErrVersionConflict, sku)
			}
		} else {
			_, err = tx.Exec(ctx, `UPDATE stock_levels SET on_hand = $2, version = $3, updated_at = now() WHERE sku = $1`,
				sku, next.OnHand, next.Version)
		}
		if err != nil {
			return fmt.Errorf("write stock level: %w", err)
		}

		return writeEvent(ctx, tx, "stock_level", sku, events.TypeStockAdjusted, events.StockAdjusted{
			SKU: sku, OnHand: next.OnHand, Available: next.Available(), Version: next.Version,
		})
	})
	if err != nil {
		return domain.StockLevel{}, s.metrics.observe(ctx, err)
	}
	return next, nil
}

// writeEvent adds an event to the outbox inside tx (ADR-0006). The relay publishes it later.
func writeEvent(ctx context.Context, tx pgx.Tx, aggregateType, aggregateID, eventType string, data any) error {
	env, err := events.New(ctx, eventType, aggregateID, data, time.Now())
	if err != nil {
		return err
	}
	payload, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("encode %s: %w", eventType, err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO outbox (id, aggregate_type, aggregate_id, event_type, payload)
		VALUES ($1, $2, $3, $4, $5)`,
		env.ID, aggregateType, aggregateID, eventType, payload); err != nil {
		return fmt.Errorf("write %s to outbox: %w", eventType, err)
	}
	return nil
}

func splitLines(lines []domain.Line) ([]string, []int64) {
	skus := make([]string, len(lines))
	quantities := make([]int64, len(lines))
	for i, l := range lines {
		skus[i], quantities[i] = l.SKU, l.Quantity
	}
	return skus, quantities
}
