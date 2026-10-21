package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/rizkyr99/sagamart/services/inventory/internal/domain"
)

// Store runs Inventory's commands against Postgres. Each command is one transaction; correctness under
// concurrency comes from atomic conditional updates and row locks taken in a fixed order (RFC-0001 §4.6):
// the reservation row first, then stock rows in ascending SKU order.
type Store struct {
	pool *pgxpool.Pool
}

// New returns a Store using pool.
func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// Reserve holds stock for every line of req or none. req must be normalized by domain.Limits.NormalizeReserve.
// A repeat for the same order returns the original reservation, or domain.ErrReservationConflict when the
// lines differ. Lines that don't fit return a *domain.InsufficientStockError.
func (s *Store) Reserve(ctx context.Context, req domain.ReserveRequest) (domain.Reservation, error) {
	panic("not implemented")
}

// Commit sells the order's reserved units and returns when it was committed (the original time on a repeat).
func (s *Store) Commit(ctx context.Context, orderID string) (time.Time, error) {
	panic("not implemented")
}

// Release returns the order's reserved units and reports the final status: RELEASED, or EXPIRED when the
// reservation had already expired.
func (s *Store) Release(ctx context.Context, orderID string) (domain.Status, error) {
	panic("not implemented")
}

// StockLevels returns the levels of the known SKUs among skus, ordered by SKU.
func (s *Store) StockLevels(ctx context.Context, skus []string) ([]domain.StockLevel, error) {
	panic("not implemented")
}

// SetStock sets a SKU's on-hand quantity (admin, PRD FR-11) and writes inventory.stock.adjusted to the
// outbox in the same transaction. expectedVersion 0 creates the SKU.
func (s *Store) SetStock(ctx context.Context, sku string, onHand, expectedVersion int64) (domain.StockLevel, error) {
	panic("not implemented")
}
