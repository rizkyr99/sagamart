package store

import "context"

// ExpireDue expires up to max active reservations whose TTL has passed, oldest first, returning how many it
// expired. Each one is its own transaction: lock the reservation (skipping any another worker or command holds),
// release its stock in SKU order, mark it EXPIRED and write inventory.reservation.expired to the outbox.
// One transaction per reservation keeps the lock order identical to Commit and Release, so the worker can't
// deadlock with them.
func (s *Store) ExpireDue(ctx context.Context, max int) (int, error) {
	panic("not implemented")
}
