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
func (w *Worker) Run(ctx context.Context) {
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()
	for {
		n, err := w.RunOnce(ctx)
		switch {
		case err != nil && ctx.Err() == nil:
			w.log.ErrorContext(ctx, "expiry run failed", "error", err, "expired", n)
		case n > 0:
			w.log.InfoContext(ctx, "reservations expired", "count", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// RunOnce expires batches until one comes back short, so a backlog drains in one tick. It returns the total.
func (w *Worker) RunOnce(ctx context.Context) (int, error) {
	total := 0
	for {
		n, err := w.expirer.ExpireDue(ctx, w.batch)
		total += n
		if err != nil || n < w.batch {
			return total, err
		}
	}
}
