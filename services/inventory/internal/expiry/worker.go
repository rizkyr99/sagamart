// Package expiry runs the reservation expiry worker: stock held by abandoned checkouts is released when the
// TTL passes, even if the Order service is down (PRD FR-06, RFC-0001 §4.4).
package expiry

import (
	"context"
	"log/slog"
	"time"
)

// Expirer expires due reservations; *store.Store implements it.
type Expirer interface {
	ExpireDue(ctx context.Context, max int) (int, error)
}

// Worker polls for due reservations every interval and expires them in batches.
type Worker struct {
	expirer  Expirer
	interval time.Duration
	batch    int
	log      *slog.Logger
}

// New returns a Worker. With the default 5 s interval, a reservation is released well within the 30 s FR-06 allows.
func New(expirer Expirer, interval time.Duration, batch int, log *slog.Logger) *Worker {
	return &Worker{expirer: expirer, interval: interval, batch: batch, log: log}
}

// Run expires due reservations every interval until ctx is done. Errors are logged and retried on the next tick.
func (w *Worker) Run(ctx context.Context) { panic("not implemented") }

// RunOnce expires batches until one comes back short, so a backlog drains in one tick. It returns the total.
func (w *Worker) RunOnce(ctx context.Context) (int, error) { panic("not implemented") }
