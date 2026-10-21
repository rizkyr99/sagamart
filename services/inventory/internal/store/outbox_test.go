package store_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/rizkyr99/sagamart/services/inventory/internal/store"
)

// Like the expiry tests, these are not parallel: ClaimOutbox acts on every unpublished row in the database.
// They assert only on events for their own SKUs.

func ownEvents(skus map[string]bool, batch []store.OutboxEvent) []store.OutboxEvent {
	var own []store.OutboxEvent
	for _, e := range batch {
		if skus[e.AggregateID] {
			own = append(own, e)
		}
	}
	return own
}

func drain(t *testing.T, s *store.Store, publish func(context.Context, []store.OutboxEvent) error) {
	t.Helper()
	for {
		n, err := s.ClaimOutbox(testContext(t), 100, publish)
		if err != nil {
			t.Fatalf("ClaimOutbox: %v", err)
		}
		if n == 0 {
			return
		}
	}
}

func TestClaimOutboxPublishesOnceInOrder(t *testing.T) {
	needDB(t)
	s, ctx := store.New(pool), testContext(t)
	drain(t, s, func(context.Context, []store.OutboxEvent) error { return nil }) // start from an empty outbox

	sku := newSKU(t, "OUT")
	seed(t, s, sku, 1)
	for v := int64(1); v <= 3; v++ {
		if _, err := s.SetStock(ctx, sku, 10*v, v); err != nil {
			t.Fatal(err)
		}
	}

	var got []store.OutboxEvent
	n, err := s.ClaimOutbox(ctx, 100, func(_ context.Context, batch []store.OutboxEvent) error {
		got = append(got, ownEvents(map[string]bool{sku: true}, batch)...)
		return nil
	})
	if err != nil || n < 4 {
		t.Fatalf("ClaimOutbox = %d, %v; want at least this test's 4 events", n, err)
	}
	if len(got) != 4 {
		t.Fatalf("published %d events for %s, want 4", len(got), sku)
	}
	for i := 1; i < len(got); i++ {
		if got[i].CreatedAt.Before(got[i-1].CreatedAt) {
			t.Errorf("events out of order: %v before %v", got[i-1].CreatedAt, got[i].CreatedAt)
		}
	}
	if got[0].EventType != "inventory.stock.adjusted" || len(got[0].Payload) == 0 || got[0].ID == "" {
		t.Errorf("event = %+v", got[0])
	}

	var unpublished int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM outbox WHERE aggregate_id = $1 AND published_at IS NULL`, sku).Scan(&unpublished); err != nil {
		t.Fatal(err)
	}
	if unpublished != 0 {
		t.Errorf("%d events still unpublished after a successful publish", unpublished)
	}
	_, err = s.ClaimOutbox(ctx, 100, func(_ context.Context, batch []store.OutboxEvent) error {
		if own := ownEvents(map[string]bool{sku: true}, batch); len(own) > 0 {
			t.Errorf("published events were claimed again: %v", own)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("second ClaimOutbox: %v", err)
	}
}

func TestClaimOutboxRetriesAfterAFailedPublish(t *testing.T) {
	needDB(t)
	s, ctx := store.New(pool), testContext(t)
	sku := newSKU(t, "RETRYOUT")
	seed(t, s, sku, 1)

	boom := errors.New("broker unavailable")
	if _, err := s.ClaimOutbox(ctx, 100, func(context.Context, []store.OutboxEvent) error { return boom }); !errors.Is(err, boom) {
		t.Fatalf("ClaimOutbox = %v, want the publish error", err)
	}

	var again int
	drain(t, s, func(_ context.Context, batch []store.OutboxEvent) error {
		again += len(ownEvents(map[string]bool{sku: true}, batch))
		return nil
	})
	if again != 1 {
		t.Errorf("event published %d times after the retry, want 1", again)
	}
}

func TestClaimOutboxRespectsLimit(t *testing.T) {
	needDB(t)
	s, ctx := store.New(pool), testContext(t)
	drain(t, s, func(context.Context, []store.OutboxEvent) error { return nil })
	for range 5 {
		seed(t, s, newSKU(t, "LIMIT"), 1)
	}
	var sizes []int
	n, err := s.ClaimOutbox(ctx, 2, func(_ context.Context, batch []store.OutboxEvent) error {
		sizes = append(sizes, len(batch))
		return nil
	})
	if err != nil || n != 2 || len(sizes) != 1 || sizes[0] != 2 {
		t.Errorf("ClaimOutbox(limit 2) = %d, %v, batches %v; want one batch of 2", n, err, sizes)
	}
	drain(t, s, func(context.Context, []store.OutboxEvent) error { return nil })
}

func TestConcurrentRelaysPublishEachEventOnce(t *testing.T) {
	needDB(t)
	s := store.New(pool)
	skus := map[string]bool{}
	for range 60 {
		sku := newSKU(t, "SHARE")
		skus[sku] = true
		seed(t, s, sku, 1)
	}

	var mu sync.Mutex
	seen := map[string]int{}
	var wg sync.WaitGroup
	for range 3 {
		wg.Go(func() {
			drain(t, s, func(_ context.Context, batch []store.OutboxEvent) error {
				mu.Lock()
				defer mu.Unlock()
				for _, e := range ownEvents(skus, batch) {
					seen[e.ID]++
				}
				return nil
			})
		})
	}
	wg.Wait()

	if len(seen) != 60 {
		t.Errorf("%d distinct events published, want 60", len(seen))
	}
	for id, n := range seen {
		if n != 1 {
			t.Errorf("event %s published %d times", id, n)
		}
	}
}
