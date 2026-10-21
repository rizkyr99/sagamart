package expiry_test

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/rizkyr99/sagamart/services/inventory/internal/expiry"
)

// fakeExpirer returns scripted batch sizes, then 0.
type fakeExpirer struct {
	mu      sync.Mutex
	results []result
	calls   []int
}

type result struct {
	n   int
	err error
}

func (f *fakeExpirer) ExpireDue(_ context.Context, max int) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, max)
	if len(f.results) == 0 {
		return 0, nil
	}
	r := f.results[0]
	f.results = f.results[1:]
	return r.n, r.err
}

func (f *fakeExpirer) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func discard() *slog.Logger { return slog.New(slog.DiscardHandler) }

func TestRunOnceDrainsTheBacklog(t *testing.T) {
	f := &fakeExpirer{results: []result{{n: 100}, {n: 100}, {n: 30}}}
	total, err := expiry.New(f, time.Second, 100, discard()).RunOnce(context.Background())
	if err != nil || total != 230 {
		t.Fatalf("RunOnce = %d, %v; want 230", total, err)
	}
	if len(f.calls) != 3 || f.calls[0] != 100 {
		t.Errorf("calls = %v, want three batches of 100 (stop after the short one)", f.calls)
	}
}

func TestRunOnceStopsAtAnError(t *testing.T) {
	boom := errors.New("database unavailable")
	f := &fakeExpirer{results: []result{{n: 100}, {n: 7, err: boom}}}
	total, err := expiry.New(f, time.Second, 100, discard()).RunOnce(context.Background())
	if !errors.Is(err, boom) || total != 107 {
		t.Errorf("RunOnce = %d, %v; want 107 and the error", total, err)
	}
}

func TestRunKeepsGoingAfterErrorsAndStopsOnCancel(t *testing.T) {
	f := &fakeExpirer{results: []result{{err: errors.New("database unavailable")}, {n: 3}}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		expiry.New(f, 10*time.Millisecond, 100, discard()).Run(ctx)
		close(done)
	}()

	deadline := time.After(2 * time.Second)
	for f.callCount() < 4 {
		select {
		case <-deadline:
			t.Fatalf("worker made %d calls in 2s; it should keep polling after an error", f.callCount())
		case <-time.After(5 * time.Millisecond):
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run did not return after cancel")
	}
}
