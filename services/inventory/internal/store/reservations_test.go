package store_test

import (
	"encoding/json"
	"errors"
	"math/rand/v2"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/rizkyr99/sagamart/services/inventory/internal/domain"
	"github.com/rizkyr99/sagamart/services/inventory/internal/events"
	"github.com/rizkyr99/sagamart/services/inventory/internal/events/schematest"
	"github.com/rizkyr99/sagamart/services/inventory/internal/store"
)

func seed(t *testing.T, s *store.Store, sku string, onHand int64) {
	t.Helper()
	if _, err := s.SetStock(testContext(t), sku, onHand, 0); err != nil {
		t.Fatalf("seed %s: %v", sku, err)
	}
}

func level(t *testing.T, s *store.Store, sku string) domain.StockLevel {
	t.Helper()
	levels, err := s.StockLevels(testContext(t), []string{sku})
	if err != nil {
		t.Fatalf("StockLevels: %v", err)
	}
	if len(levels) != 1 {
		t.Fatalf("StockLevels(%s) returned %d levels", sku, len(levels))
	}
	return levels[0]
}

func reserveReq(t *testing.T, orderID string, lines ...domain.Line) domain.ReserveRequest {
	t.Helper()
	req, err := domain.NewLimits(100).NormalizeReserve(domain.ReserveRequest{OrderID: orderID, Lines: lines})
	if err != nil {
		t.Fatalf("NormalizeReserve: %v", err)
	}
	return req
}

func TestReserveHoldsStock(t *testing.T) {
	needDB(t)
	t.Parallel()
	s, ctx := store.New(pool), testContext(t)
	a, b := newSKU(t, "A"), newSKU(t, "B")
	seed(t, s, a, 10)
	seed(t, s, b, 5)
	order := newOrderID(t)

	before := time.Now()
	res, err := s.Reserve(ctx, reserveReq(t, order, domain.Line{SKU: b, Quantity: 2}, domain.Line{SKU: a, Quantity: 3}))
	if err != nil {
		t.Fatalf("Reserve: %v", err)
	}

	if res.ID == "" || res.OrderID != order || res.Status != domain.StatusActive {
		t.Errorf("reservation = %+v", res)
	}
	if want := []domain.Line{{SKU: a, Quantity: 3}, {SKU: b, Quantity: 2}}; !reflect.DeepEqual(res.Lines, want) {
		t.Errorf("lines = %v, want %v", res.Lines, want)
	}
	if wantExpiry := before.Add(10 * time.Minute); res.ExpiresAt.Before(wantExpiry.Add(-5*time.Second)) || res.ExpiresAt.After(wantExpiry.Add(5*time.Second)) {
		t.Errorf("expires at %v, want about %v (default TTL)", res.ExpiresAt, wantExpiry)
	}
	if got := level(t, s, a); got.Reserved != 3 || got.OnHand != 10 || got.Version != 2 {
		t.Errorf("%s = %+v, want reserved 3 of 10 at version 2", a, got)
	}
	if got := level(t, s, b); got.Reserved != 2 || got.OnHand != 5 {
		t.Errorf("%s = %+v, want reserved 2 of 5", b, got)
	}
}

func TestReserveIsAllOrNothing(t *testing.T) {
	needDB(t)
	t.Parallel()
	s, ctx := store.New(pool), testContext(t)
	a, b, unknown := newSKU(t, "A"), newSKU(t, "B"), newSKU(t, "UNKNOWN")
	seed(t, s, a, 10)
	seed(t, s, b, 1)
	order := newOrderID(t)

	_, err := s.Reserve(ctx, reserveReq(t, order,
		domain.Line{SKU: a, Quantity: 3}, domain.Line{SKU: b, Quantity: 2}, domain.Line{SKU: unknown, Quantity: 1}))

	var serr *domain.InsufficientStockError
	if !errors.As(err, &serr) {
		t.Fatalf("want *InsufficientStockError, got %v", err)
	}
	got := map[string]domain.Shortfall{}
	for _, sf := range serr.Shortfalls {
		got[sf.SKU] = sf
	}
	if got[b] != (domain.Shortfall{SKU: b, Requested: 2, Available: 1}) || got[unknown] != (domain.Shortfall{SKU: unknown, Requested: 1}) || len(got) != 2 {
		t.Errorf("shortfalls = %+v", serr.Shortfalls)
	}
	if lvl := level(t, s, a); lvl.Reserved != 0 || lvl.Version != 1 {
		t.Errorf("%s changed after a failed reservation: %+v", a, lvl)
	}

	// Nothing was left behind for the order: a reservation that fits now succeeds.
	if _, err := s.Reserve(ctx, reserveReq(t, order, domain.Line{SKU: a, Quantity: 3})); err != nil {
		t.Fatalf("Reserve after a failed attempt: %v", err)
	}
}

func TestReserveRetry(t *testing.T) {
	needDB(t)
	t.Parallel()
	s, ctx := store.New(pool), testContext(t)
	sku := newSKU(t, "RETRY")
	seed(t, s, sku, 10)
	order := newOrderID(t)
	req := reserveReq(t, order, domain.Line{SKU: sku, Quantity: 4})

	first, err := s.Reserve(ctx, req)
	if err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	for range 10 {
		again, err := s.Reserve(ctx, req)
		if err != nil {
			t.Fatalf("retry: %v", err)
		}
		if again.ID != first.ID || !again.ExpiresAt.Equal(first.ExpiresAt) {
			t.Fatalf("retry returned %+v, want the original %+v", again, first)
		}
	}
	if lvl := level(t, s, sku); lvl.Reserved != 4 {
		t.Errorf("reserved = %d after 11 identical calls, want 4", lvl.Reserved)
	}

	_, err = s.Reserve(ctx, reserveReq(t, order, domain.Line{SKU: sku, Quantity: 5}))
	if !errors.Is(err, domain.ErrReservationConflict) {
		t.Errorf("different lines for the same order: error = %v, want ErrReservationConflict", err)
	}
}

// TestConcurrentReservationsNeverOversell is the FR-06 guarantee under contention: 1,000 buyers race for
// 100 units of one SKU and exactly 100 win (testing strategy §2.1).
func TestConcurrentReservationsNeverOversell(t *testing.T) {
	needDB(t)
	s, ctx := store.New(pool), testContext(t)
	sku := newSKU(t, "FLASH")
	seed(t, s, sku, 100)

	const buyers = 1000
	var (
		wg                        sync.WaitGroup
		mu                        sync.Mutex
		reserved, soldOut, failed int
		firstErr                  error
	)
	start := make(chan struct{})
	for range buyers {
		req := reserveReq(t, newOrderID(t), domain.Line{SKU: sku, Quantity: 1})
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := s.Reserve(ctx, req)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				reserved++
			case errors.Is(err, domain.ErrInsufficientStock):
				soldOut++
			default:
				failed++
				if firstErr == nil {
					firstErr = err
				}
			}
		}()
	}
	close(start)
	wg.Wait()

	if failed > 0 {
		t.Fatalf("%d reservations failed unexpectedly; first error: %v", failed, firstErr)
	}
	if reserved != 100 || soldOut != buyers-100 {
		t.Errorf("reserved %d, sold out %d; want exactly 100 and %d", reserved, soldOut, buyers-100)
	}
	if lvl := level(t, s, sku); lvl.Reserved != 100 || lvl.Available() != 0 {
		t.Errorf("final level %+v, want 100 reserved and 0 available", lvl)
	}
	var rows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM reservation_lines WHERE sku = $1`, sku).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 100 {
		t.Errorf("%d reservation lines for %s, want 100", rows, sku)
	}
}

func TestConcurrentRetriesOfOneOrderReserveOnce(t *testing.T) {
	needDB(t)
	t.Parallel()
	s, ctx := store.New(pool), testContext(t)
	sku := newSKU(t, "SAMEORDER")
	seed(t, s, sku, 50)
	req := reserveReq(t, newOrderID(t), domain.Line{SKU: sku, Quantity: 3})

	ids := make(chan string, 20)
	errs := make(chan error, 20)
	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() {
			res, err := s.Reserve(ctx, req)
			if err != nil {
				errs <- err
				return
			}
			ids <- res.ID
		})
	}
	wg.Wait()
	close(ids)
	close(errs)

	for err := range errs {
		t.Errorf("concurrent retry failed: %v", err)
	}
	distinct := map[string]bool{}
	for id := range ids {
		distinct[id] = true
	}
	if len(distinct) != 1 {
		t.Errorf("concurrent retries produced %d reservations, want 1", len(distinct))
	}
	if lvl := level(t, s, sku); lvl.Reserved != 3 {
		t.Errorf("reserved = %d, want 3", lvl.Reserved)
	}
}

// TestConcurrentMultiLineReservationsDontDeadlock sends lines in random order; the store locks stock rows
// in SKU order, so overlapping reservations never deadlock.
func TestConcurrentMultiLineReservationsDontDeadlock(t *testing.T) {
	needDB(t)
	s, ctx := store.New(pool), testContext(t)
	skus := make([]string, 8)
	for i := range skus {
		skus[i] = newSKU(t, "MULTI")
		seed(t, s, skus[i], 10_000)
	}

	const buyers = 300
	want := map[string]int64{}
	reqs := make([]domain.ReserveRequest, buyers)
	for i := range reqs {
		picked := rand.Perm(len(skus))[:2+rand.IntN(4)]
		lines := make([]domain.Line, len(picked))
		for j, k := range picked {
			lines[j] = domain.Line{SKU: skus[k], Quantity: int64(1 + rand.IntN(3))}
			want[skus[k]] += lines[j].Quantity
		}
		// Deliberately not normalized: the store must not depend on the caller's line order.
		reqs[i] = domain.ReserveRequest{OrderID: newOrderID(t), Lines: lines, TTL: 10 * time.Minute}
	}

	var wg sync.WaitGroup
	errs := make(chan error, buyers)
	for _, req := range reqs {
		wg.Go(func() {
			if _, err := s.Reserve(ctx, req); err != nil {
				errs <- err
			}
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("Reserve: %v", err)
	}
	for _, sku := range skus {
		if lvl := level(t, s, sku); lvl.Reserved != want[sku] {
			t.Errorf("%s reserved %d, want %d", sku, lvl.Reserved, want[sku])
		}
	}
}

func TestCommit(t *testing.T) {
	needDB(t)
	t.Parallel()
	s, ctx := store.New(pool), testContext(t)
	sku := newSKU(t, "COMMIT")
	seed(t, s, sku, 10)
	order := newOrderID(t)
	if _, err := s.Reserve(ctx, reserveReq(t, order, domain.Line{SKU: sku, Quantity: 4})); err != nil {
		t.Fatalf("Reserve: %v", err)
	}

	committedAt, err := s.Commit(ctx, order)
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if time.Since(committedAt) > time.Minute || committedAt.IsZero() {
		t.Errorf("committed at %v", committedAt)
	}
	for range 10 {
		again, err := s.Commit(ctx, order)
		if err != nil || !again.Equal(committedAt) {
			t.Fatalf("repeat Commit = %v, %v; want the original %v", again, err, committedAt)
		}
	}
	if lvl := level(t, s, sku); lvl.OnHand != 6 || lvl.Reserved != 0 {
		t.Errorf("after commit %+v, want 6 on hand and 0 reserved", lvl)
	}

	if _, err := s.Release(ctx, order); !errors.Is(err, domain.ErrReservationCommitted) {
		t.Errorf("Release after Commit: error = %v, want ErrReservationCommitted", err)
	}
}

func TestCommitAfterExpiryIsRefused(t *testing.T) {
	needDB(t)
	t.Parallel()
	s, ctx := store.New(pool), testContext(t)
	sku := newSKU(t, "LATE")
	seed(t, s, sku, 10)
	order := newOrderID(t)
	if _, err := s.Reserve(ctx, reserveReq(t, order, domain.Line{SKU: sku, Quantity: 2})); err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	// The TTL passed, but the expiry worker hasn't run yet.
	if _, err := pool.Exec(ctx, `UPDATE reservations SET expires_at = now() - interval '1 second' WHERE order_id = $1`, order); err != nil {
		t.Fatal(err)
	}

	if _, err := s.Commit(ctx, order); !errors.Is(err, domain.ErrReservationNotFound) {
		t.Fatalf("Commit after expiry: error = %v, want ErrReservationNotFound (strict expiry)", err)
	}
	if lvl := level(t, s, sku); lvl.OnHand != 10 || lvl.Reserved != 2 {
		t.Errorf("a refused commit changed stock: %+v (releasing it is the expiry worker's job)", lvl)
	}
}

func TestUnknownOrder(t *testing.T) {
	needDB(t)
	t.Parallel()
	s, ctx := store.New(pool), testContext(t)
	order := newOrderID(t)
	if _, err := s.Commit(ctx, order); !errors.Is(err, domain.ErrReservationNotFound) {
		t.Errorf("Commit: error = %v, want ErrReservationNotFound", err)
	}
	if _, err := s.Release(ctx, order); !errors.Is(err, domain.ErrReservationNotFound) {
		t.Errorf("Release: error = %v, want ErrReservationNotFound", err)
	}
}

func TestRelease(t *testing.T) {
	needDB(t)
	t.Parallel()
	s, ctx := store.New(pool), testContext(t)
	sku := newSKU(t, "RELEASE")
	seed(t, s, sku, 10)
	order := newOrderID(t)
	if _, err := s.Reserve(ctx, reserveReq(t, order, domain.Line{SKU: sku, Quantity: 4})); err != nil {
		t.Fatalf("Reserve: %v", err)
	}

	for i := range 3 {
		status, err := s.Release(ctx, order)
		if err != nil || status != domain.StatusReleased {
			t.Fatalf("Release #%d = %s, %v; want RELEASED", i+1, status, err)
		}
	}
	if lvl := level(t, s, sku); lvl.Reserved != 0 || lvl.OnHand != 10 {
		t.Errorf("after release %+v, want everything available again", lvl)
	}
	if _, err := s.Commit(ctx, order); !errors.Is(err, domain.ErrReservationNotFound) {
		t.Errorf("Commit after Release: error = %v, want ErrReservationNotFound", err)
	}
}

func TestStockLevels(t *testing.T) {
	needDB(t)
	t.Parallel()
	s, ctx := store.New(pool), testContext(t)
	a, b := newSKU(t, "LVL"), newSKU(t, "LVL")
	seed(t, s, a, 3)
	seed(t, s, b, 7)

	levels, err := s.StockLevels(ctx, []string{b, newSKU(t, "MISSING"), a})
	if err != nil {
		t.Fatalf("StockLevels: %v", err)
	}
	if len(levels) != 2 {
		t.Fatalf("got %d levels, want 2 (unknown SKUs omitted): %+v", len(levels), levels)
	}
	byKey := map[string]int64{levels[0].SKU: levels[0].OnHand, levels[1].SKU: levels[1].OnHand}
	if byKey[a] != 3 || byKey[b] != 7 {
		t.Errorf("levels = %+v", levels)
	}
}

func TestSetStock(t *testing.T) {
	needDB(t)
	t.Parallel()
	s, ctx := store.New(pool), testContext(t)
	sku := newSKU(t, "SET")

	created, err := s.SetStock(ctx, sku, 10, 0)
	if err != nil || created != (domain.StockLevel{SKU: sku, OnHand: 10, Version: 1}) {
		t.Fatalf("create = %+v, %v", created, err)
	}
	if _, err := s.SetStock(ctx, sku, 10, 0); !errors.Is(err, domain.ErrVersionConflict) {
		t.Errorf("create twice: error = %v, want ErrVersionConflict", err)
	}
	if _, err := s.Reserve(ctx, reserveReq(t, newOrderID(t), domain.Line{SKU: sku, Quantity: 4})); err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	current := level(t, s, sku) // version 2 after the reservation

	updated, err := s.SetStock(ctx, sku, 25, current.Version)
	if err != nil || updated.OnHand != 25 || updated.Reserved != 4 || updated.Version != current.Version+1 {
		t.Fatalf("update = %+v, %v", updated, err)
	}
	if _, err := s.SetStock(ctx, sku, 30, current.Version); !errors.Is(err, domain.ErrVersionConflict) {
		t.Errorf("stale version: error = %v, want ErrVersionConflict", err)
	}
	if _, err := s.SetStock(ctx, sku, 3, updated.Version); !errors.Is(err, domain.ErrStockBelowReserved) {
		t.Errorf("below reserved: error = %v, want ErrStockBelowReserved", err)
	}
	if lvl := level(t, s, sku); lvl != updated {
		t.Errorf("rejected changes modified stock: %+v, want %+v", lvl, updated)
	}
}

func TestConcurrentCreatesOfOneSKU(t *testing.T) {
	needDB(t)
	t.Parallel()
	s, ctx := store.New(pool), testContext(t)
	sku := newSKU(t, "RACE")

	var wg sync.WaitGroup
	results := make(chan error, 10)
	for range 10 {
		wg.Go(func() {
			_, err := s.SetStock(ctx, sku, 5, 0)
			results <- err
		})
	}
	wg.Wait()
	close(results)

	created := 0
	for err := range results {
		switch {
		case err == nil:
			created++
		case !errors.Is(err, domain.ErrVersionConflict):
			t.Errorf("unexpected error: %v", err)
		}
	}
	if created != 1 {
		t.Errorf("%d concurrent creates succeeded, want 1", created)
	}
}

func TestSetStockWritesStockAdjustedEvent(t *testing.T) {
	needDB(t)
	t.Parallel()
	s, ctx := store.New(pool), testContext(t)
	sku := newSKU(t, "EVENT")

	if _, err := s.SetStock(ctx, sku, 10, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetStock(ctx, sku, 3, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetStock(ctx, sku, 99, 1); err == nil {
		t.Fatal("stale update succeeded")
	}

	rows, err := pool.Query(ctx, `
		SELECT event_type, aggregate_type, payload FROM outbox
		WHERE aggregate_id = $1 ORDER BY created_at, id`, sku)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()

	var got []events.StockAdjusted
	for rows.Next() {
		var eventType, aggregateType string
		var payload []byte
		if err := rows.Scan(&eventType, &aggregateType, &payload); err != nil {
			t.Fatal(err)
		}
		if eventType != events.TypeStockAdjusted || aggregateType != "stock_level" {
			t.Errorf("outbox row %s / %s", eventType, aggregateType)
		}
		schematest.Validate(t, events.TypeStockAdjusted, payload)

		var env struct {
			Subject string               `json:"subject"`
			Data    events.StockAdjusted `json:"data"`
		}
		if err := json.Unmarshal(payload, &env); err != nil {
			t.Fatal(err)
		}
		if env.Subject != sku {
			t.Errorf("subject = %s, want the SKU", env.Subject)
		}
		got = append(got, env.Data)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}

	want := []events.StockAdjusted{
		{SKU: sku, OnHand: 10, Available: 10, Version: 1},
		{SKU: sku, OnHand: 3, Available: 3, Version: 2},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("events = %+v, want exactly one per successful change %+v", got, want)
	}
}
