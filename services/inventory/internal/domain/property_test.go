package domain_test

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"pgregory.net/rapid"

	"github.com/rizkyr99/sagamart/services/inventory/internal/domain"
)

// model is an in-memory Inventory built only from the domain rules. The property test drives it with random
// command sequences and checks the invariants that make "never oversell" true (RFC-0001 §9).
type model struct {
	now          time.Time
	limits       domain.Limits
	stock        map[string]domain.StockLevel
	reservations map[string]domain.Reservation // by order ID

	// Bookkeeping kept independently of the domain code, to check conservation of stock.
	setOnHand        map[string]int64 // on hand after the last admin change
	soldSinceLastSet map[string]int64
}

var (
	skus     = []string{"BAJU-001", "KAOS-001", "KAOS-002", "TOPI-001"}
	orderIDs = []string{
		"0199f29e-0000-7000-8000-000000000001", "0199f29e-0000-7000-8000-000000000002",
		"0199f29e-0000-7000-8000-000000000003", "0199f29e-0000-7000-8000-000000000004",
		"0199f29e-0000-7000-8000-000000000005", "0199f29e-0000-7000-8000-000000000006",
	}
)

func newModel() *model {
	return &model{
		now:              time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC),
		limits:           domain.NewLimits(5),
		stock:            map[string]domain.StockLevel{},
		reservations:     map[string]domain.Reservation{},
		setOnHand:        map[string]int64{},
		soldSinceLastSet: map[string]int64{},
	}
}

func (m *model) reserve(t *rapid.T) {
	order := rapid.SampledFrom(orderIDs).Draw(t, "order")
	picked := rapid.SliceOfNDistinct(rapid.SampledFrom(skus), 1, 3, rapid.ID[string]).Draw(t, "skus")
	lines := make([]domain.Line, len(picked))
	for i, sku := range picked {
		lines[i] = domain.Line{SKU: sku, Quantity: rapid.Int64Range(1, 5).Draw(t, "qty")}
	}
	ttl := time.Duration(rapid.IntRange(1, 30).Draw(t, "ttl_min")) * time.Minute

	req, err := m.limits.NormalizeReserve(domain.ReserveRequest{OrderID: order, Lines: lines, TTL: ttl})
	if err != nil {
		t.Fatalf("generated request should be valid: %v", err)
	}

	if existing, ok := m.reservations[order]; ok {
		err := domain.CheckRetry(existing, req)
		if err != nil && !errors.Is(err, domain.ErrReservationConflict) {
			t.Fatalf("CheckRetry: %v", err)
		}
		return // a retry never changes stock
	}

	updated, err := domain.ReserveLines(m.stock, req.Lines)
	if errors.Is(err, domain.ErrInsufficientStock) {
		return
	}
	if err != nil {
		t.Fatalf("ReserveLines: %v", err)
	}
	for sku, level := range updated {
		m.stock[sku] = level
	}
	m.reservations[order] = domain.Reservation{
		OrderID: order, Status: domain.StatusActive, Lines: req.Lines, ExpiresAt: m.now.Add(req.TTL),
	}
}

func (m *model) command(t *rapid.T, cmd domain.Command) {
	order := rapid.SampledFrom(orderIDs).Draw(t, "order")
	res, ok := m.reservations[order]
	if !ok {
		return // unknown order: the store answers RESERVATION_NOT_FOUND without touching stock
	}

	out, err := domain.Decide(res, cmd, m.now)
	if errors.Is(err, domain.ErrInvariant) {
		t.Fatalf("Decide(%s, %s): %v", res.Status, cmd, err)
	}
	if err != nil || !out.Changed {
		if out.Status != "" && out.Status != res.Status {
			t.Fatalf("an unchanged outcome must report the current status: %+v vs %s", out, res.Status)
		}
		return
	}
	if res.Status.Final() {
		t.Fatalf("final status %s changed to %s by %s", res.Status, out.Status, cmd)
	}

	for _, line := range res.Lines {
		level, err := m.stock[line.SKU].Apply(out.StockOp, line.Quantity)
		if err != nil {
			t.Fatalf("%s %s on %s: %v", cmd, out.Status, line.SKU, err)
		}
		m.stock[line.SKU] = level
		if out.StockOp == domain.StockOpCommit {
			m.soldSinceLastSet[line.SKU] += line.Quantity
		}
	}
	res.Status = out.Status
	m.reservations[order] = res
}

func (m *model) setStock(t *rapid.T) {
	sku := rapid.SampledFrom(skus).Draw(t, "sku")
	onHand := rapid.Int64Range(0, 30).Draw(t, "on_hand")

	var current *domain.StockLevel
	expected := int64(0)
	if level, ok := m.stock[sku]; ok {
		current = &level
		expected = level.Version
	}
	if rapid.Bool().Draw(t, "stale") {
		expected++ // a concurrent admin edit won the race
	}

	level, err := domain.SetStock(current, sku, onHand, expected)
	switch {
	case errors.Is(err, domain.ErrVersionConflict), errors.Is(err, domain.ErrStockBelowReserved):
		return
	case err != nil:
		t.Fatalf("SetStock: %v", err)
	}
	m.stock[sku] = level
	m.setOnHand[sku] = onHand
	m.soldSinceLastSet[sku] = 0
}

func (m *model) advanceClock(t *rapid.T) {
	m.now = m.now.Add(time.Duration(rapid.IntRange(0, 15*60).Draw(t, "seconds")) * time.Second)
}

func (m *model) checkInvariants(t *rapid.T) {
	activeBySKU := map[string]int64{}
	for _, r := range m.reservations {
		if r.Status == domain.StatusActive {
			for _, line := range r.Lines {
				activeBySKU[line.SKU] += line.Quantity
			}
		}
	}
	for sku, level := range m.stock {
		if level.Reserved < 0 || level.Available() < 0 {
			t.Fatalf("%s oversold: on_hand=%d reserved=%d", sku, level.OnHand, level.Reserved)
		}
		if level.Reserved != activeBySKU[sku] {
			t.Fatalf("%s reserved=%d but active reservations hold %d", sku, level.Reserved, activeBySKU[sku])
		}
		if want := m.setOnHand[sku] - m.soldSinceLastSet[sku]; level.OnHand != want {
			t.Fatalf("%s on_hand=%d, want %d (last set %d, sold since %d)",
				sku, level.OnHand, want, m.setOnHand[sku], m.soldSinceLastSet[sku])
		}
	}
	for sku, qty := range activeBySKU {
		if _, ok := m.stock[sku]; !ok && qty > 0 {
			t.Fatalf("active reservation holds %d of unknown SKU %s", qty, sku)
		}
	}
}

func TestInventoryNeverOversells(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		m := newModel()
		t.Repeat(map[string]func(*rapid.T){
			"reserve":  m.reserve,
			"commit":   func(t *rapid.T) { m.command(t, domain.CommandCommit) },
			"release":  func(t *rapid.T) { m.command(t, domain.CommandRelease) },
			"expire":   func(t *rapid.T) { m.command(t, domain.CommandExpire) },
			"setStock": m.setStock,
			"tick":     m.advanceClock,
			"":         m.checkInvariants,
		})
	})
}

// ExampleDecide shows the strict-expiry decision recorded in RFC-0001: a commit at the expiry instant is refused.
func ExampleDecide() {
	expiresAt := time.Date(2026, 10, 21, 3, 10, 0, 0, time.UTC)
	res := domain.Reservation{Status: domain.StatusActive, ExpiresAt: expiresAt}

	_, err := domain.Decide(res, domain.CommandCommit, expiresAt)
	fmt.Println(err)
	// Output: reservation not found
}
