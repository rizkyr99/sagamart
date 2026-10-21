package store_test

import (
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"github.com/rizkyr99/sagamart/services/inventory/internal/domain"
	"github.com/rizkyr99/sagamart/services/inventory/internal/events"
	"github.com/rizkyr99/sagamart/services/inventory/internal/events/schematest"
	"github.com/rizkyr99/sagamart/services/inventory/internal/store"
)

// The expiry tests are deliberately not parallel: ExpireDue acts on every due reservation in the database, and Go
// runs all sequential tests before resuming parallel ones. They assert only on their own reservations.

// makeDue moves an order's expiry into the past, as if the TTL had passed.
func makeDue(t *testing.T, orderID string) {
	t.Helper()
	if _, err := pool.Exec(testContext(t), `UPDATE reservations SET expires_at = now() - interval '1 second' WHERE order_id = $1`, orderID); err != nil {
		t.Fatal(err)
	}
}

func reservationStatus(t *testing.T, orderID string) string {
	t.Helper()
	var status string
	if err := pool.QueryRow(testContext(t), `SELECT status FROM reservations WHERE order_id = $1`, orderID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	return status
}

func expiredEvents(t *testing.T, orderID string) [][]byte {
	t.Helper()
	rows, err := pool.Query(testContext(t), `
		SELECT payload FROM outbox WHERE event_type = $1 AND aggregate_id = $2`, events.TypeReservationExpired, orderID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var payloads [][]byte
	for rows.Next() {
		var p []byte
		if err := rows.Scan(&p); err != nil {
			t.Fatal(err)
		}
		payloads = append(payloads, p)
	}
	return payloads
}

func TestExpireDueReleasesStockAndPublishesEvent(t *testing.T) {
	needDB(t)
	s, ctx := store.New(pool), testContext(t)
	a, b := newSKU(t, "EXP"), newSKU(t, "EXP")
	seed(t, s, a, 10)
	seed(t, s, b, 10)
	order := newOrderID(t)
	res, err := s.Reserve(ctx, reserveReq(t, order, domain.Line{SKU: b, Quantity: 1}, domain.Line{SKU: a, Quantity: 2}))
	if err != nil {
		t.Fatal(err)
	}
	makeDue(t, order)

	n, err := s.ExpireDue(ctx, 100)
	if err != nil || n < 1 {
		t.Fatalf("ExpireDue = %d, %v", n, err)
	}
	if got := reservationStatus(t, order); got != "EXPIRED" {
		t.Errorf("status = %s, want EXPIRED", got)
	}
	for _, sku := range []string{a, b} {
		if lvl := level(t, s, sku); lvl.Reserved != 0 || lvl.OnHand != 10 {
			t.Errorf("%s = %+v, want the stock released", sku, lvl)
		}
	}

	payloads := expiredEvents(t, order)
	if len(payloads) != 1 {
		t.Fatalf("%d expired events for the order, want 1", len(payloads))
	}
	var traced struct {
		TraceParent string `json:"traceparent"`
	}
	if err := json.Unmarshal(payloads[0], &traced); err != nil || traced.TraceParent == "" {
		t.Errorf("expired event has no traceparent; each expiry should start its own trace: %s", payloads[0])
	}
	schematest.Validate(t, events.TypeReservationExpired, payloads[0])
	var env struct {
		Subject string                    `json:"subject"`
		Data    events.ReservationExpired `json:"data"`
	}
	if err := json.Unmarshal(payloads[0], &env); err != nil {
		t.Fatal(err)
	}
	if env.Subject != order || env.Data.OrderID != order || env.Data.ReservationID != res.ID {
		t.Errorf("event = %+v", env)
	}
	qty := map[string]int64{}
	for _, l := range env.Data.Lines {
		qty[l.SKU] = l.Quantity
	}
	if len(qty) != 2 || qty[a] != 2 || qty[b] != 1 {
		t.Errorf("event lines = %+v, want %s×2 and %s×1", env.Data.Lines, a, b)
	}

	// Already expired: nothing more to do for this order.
	if _, err := s.ExpireDue(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if got := len(expiredEvents(t, order)); got != 1 {
		t.Errorf("%d expired events after a second run, want 1", got)
	}
}

func TestExpireDueLeavesOtherReservationsAlone(t *testing.T) {
	needDB(t)
	s, ctx := store.New(pool), testContext(t)
	sku := newSKU(t, "KEEP")
	seed(t, s, sku, 10)
	notDue, committed, released := newOrderID(t), newOrderID(t), newOrderID(t)
	for _, order := range []string{notDue, committed, released} {
		if _, err := s.Reserve(ctx, reserveReq(t, order, domain.Line{SKU: sku, Quantity: 1})); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.Commit(ctx, committed); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Release(ctx, released); err != nil {
		t.Fatal(err)
	}
	makeDue(t, committed)
	makeDue(t, released)

	if _, err := s.ExpireDue(ctx, 100); err != nil {
		t.Fatal(err)
	}
	for order, want := range map[string]string{notDue: "ACTIVE", committed: "COMMITTED", released: "RELEASED"} {
		if got := reservationStatus(t, order); got != want {
			t.Errorf("status = %s, want %s", got, want)
		}
	}
	if lvl := level(t, s, sku); lvl.OnHand != 9 || lvl.Reserved != 1 {
		t.Errorf("level = %+v, want 9 on hand (one sold) and 1 reserved (not due)", lvl)
	}
}

func TestExpiredReservationIsFinal(t *testing.T) {
	needDB(t)
	s, ctx := store.New(pool), testContext(t)
	sku := newSKU(t, "FINAL")
	seed(t, s, sku, 10)
	order := newOrderID(t)
	if _, err := s.Reserve(ctx, reserveReq(t, order, domain.Line{SKU: sku, Quantity: 3})); err != nil {
		t.Fatal(err)
	}
	makeDue(t, order)
	if _, err := s.ExpireDue(ctx, 100); err != nil {
		t.Fatal(err)
	}

	if _, err := s.Commit(ctx, order); !errors.Is(err, domain.ErrReservationNotFound) {
		t.Errorf("Commit after expiry: %v, want ErrReservationNotFound", err)
	}
	if status, err := s.Release(ctx, order); err != nil || status != domain.StatusExpired {
		t.Errorf("Release after expiry = %s, %v; want EXPIRED and no error", status, err)
	}
	if lvl := level(t, s, sku); lvl.Reserved != 0 || lvl.OnHand != 10 {
		t.Errorf("stock released twice or not at all: %+v", lvl)
	}
}

// TestConcurrentExpiryExpiresEachReservationOnce runs several workers at once, as the Scale release will:
// SKIP LOCKED lets them share the work, and no reservation is expired or released twice.
func TestConcurrentExpiryExpiresEachReservationOnce(t *testing.T) {
	needDB(t)
	s, ctx := store.New(pool), testContext(t)
	sku := newSKU(t, "MANY")
	seed(t, s, sku, 1000)

	orders := make([]string, 200)
	for i := range orders {
		orders[i] = newOrderID(t)
		if _, err := s.Reserve(ctx, reserveReq(t, orders[i], domain.Line{SKU: sku, Quantity: 2})); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `
		UPDATE reservations SET expires_at = now() - interval '1 second'
		WHERE id IN (SELECT reservation_id FROM reservation_lines WHERE sku = $1)`, sku); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	errs := make(chan error, 4)
	for range 4 {
		wg.Go(func() {
			for {
				n, err := s.ExpireDue(ctx, 25)
				if err != nil {
					errs <- err
					return
				}
				if n == 0 {
					return
				}
			}
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("ExpireDue: %v", err)
	}

	if lvl := level(t, s, sku); lvl.Reserved != 0 || lvl.OnHand != 1000 {
		t.Errorf("level = %+v, want everything released exactly once", lvl)
	}
	var events int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM outbox WHERE aggregate_id = ANY($1)`, orders).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != len(orders) {
		t.Errorf("%d expired events for %d reservations, want one each", events, len(orders))
	}
}

func TestExpireDueRespectsMax(t *testing.T) {
	needDB(t)
	s, ctx := store.New(pool), testContext(t)
	sku := newSKU(t, "MAX")
	seed(t, s, sku, 100)
	for range 5 {
		order := newOrderID(t)
		if _, err := s.Reserve(ctx, reserveReq(t, order, domain.Line{SKU: sku, Quantity: 1})); err != nil {
			t.Fatal(err)
		}
		makeDue(t, order)
	}
	n, err := s.ExpireDue(ctx, 2)
	if err != nil || n != 2 {
		t.Errorf("ExpireDue(max 2) = %d, %v; want 2", n, err)
	}
	for {
		n, err := s.ExpireDue(ctx, 100)
		if err != nil {
			t.Fatal(err)
		}
		if n == 0 {
			break
		}
	}
	if lvl := level(t, s, sku); lvl.Reserved != 0 {
		t.Errorf("reserved = %d after draining, want 0", lvl.Reserved)
	}
}
