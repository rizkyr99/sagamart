package domain

import (
	"cmp"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
)

// maxSKULength bounds SKU codes everywhere a SKU enters the service.
const maxSKULength = 64

// Line is a quantity of one SKU in a reservation.
type Line struct {
	SKU      string
	Quantity int64
}

// Limits are the validation bounds for reservation requests (RFC-0001 §4.2).
type Limits struct {
	MaxLines        int
	MaxLineQuantity int64
	MaxSKULength    int
	MinTTL          time.Duration
	MaxTTL          time.Duration
	DefaultTTL      time.Duration
}

// NewLimits returns the RFC-0001 limits with the configured per-line quantity cap.
func NewLimits(maxLineQuantity int) Limits {
	return Limits{
		MaxLines:        50,
		MaxLineQuantity: int64(maxLineQuantity),
		MaxSKULength:    maxSKULength,
		MinTTL:          time.Minute,
		MaxTTL:          30 * time.Minute,
		DefaultTTL:      10 * time.Minute,
	}
}

// ReserveRequest asks to hold stock for every line of an order.
type ReserveRequest struct {
	OrderID string
	Lines   []Line
	TTL     time.Duration // zero means DefaultTTL
}

// NormalizeReserve validates req and returns it with lines sorted by SKU (the lock order that prevents
// deadlocks) and the default TTL applied. Every invalid field is reported in one *ValidationError.
func (l Limits) NormalizeReserve(req ReserveRequest) (ReserveRequest, error) {
	var vs violations

	if _, err := uuid.Parse(req.OrderID); err != nil {
		vs.add("order_id", "must be a UUID")
	}

	switch n := len(req.Lines); {
	case n == 0:
		vs.add("lines", "at least one line is required")
	case n > l.MaxLines:
		vs.add("lines", "at most %d lines, got %d", l.MaxLines, n)
	}
	seen := make(map[string]bool, len(req.Lines))
	for i, line := range req.Lines {
		field := fmt.Sprintf("lines[%d]", i)
		if problem := checkSKU(line.SKU, l.MaxSKULength); problem != "" {
			vs.add(field+".sku", "%s", problem)
		} else if seen[line.SKU] {
			vs.add(field+".sku", "duplicate SKU %s", line.SKU)
		}
		seen[line.SKU] = true
		if line.Quantity < 1 || line.Quantity > l.MaxLineQuantity {
			vs.add(field+".quantity", "must be between 1 and %d, got %d", l.MaxLineQuantity, line.Quantity)
		}
	}

	ttl := req.TTL
	if ttl == 0 {
		ttl = l.DefaultTTL
	}
	if ttl < l.MinTTL || ttl > l.MaxTTL {
		vs.add("ttl", "must be between %v and %v, got %v", l.MinTTL, l.MaxTTL, req.TTL)
	}

	if err := vs.err(); err != nil {
		return ReserveRequest{}, err
	}

	lines := slices.Clone(req.Lines)
	slices.SortFunc(lines, func(a, b Line) int { return cmp.Compare(a.SKU, b.SKU) })
	return ReserveRequest{OrderID: req.OrderID, Lines: lines, TTL: ttl}, nil
}

// CheckRetry decides a repeated ReserveStock for an order that already has a reservation: the same lines
// return the original reservation (nil error); different lines are ErrReservationConflict.
// req must already be normalized.
func CheckRetry(existing Reservation, req ReserveRequest) error {
	if !slices.Equal(existing.Lines, req.Lines) {
		return ErrReservationConflict
	}
	return nil
}

// maxStockQuery bounds GetStockLevels requests (inventory contract).
const maxStockQuery = 100

// ValidateStockQuery checks a GetStockLevels request: 1 to 100 well-formed SKUs.
func ValidateStockQuery(skus []string) error {
	var vs violations
	switch n := len(skus); {
	case n == 0:
		vs.add("skus", "at least one SKU is required")
	case n > maxStockQuery:
		vs.add("skus", "at most %d SKUs, got %d", maxStockQuery, n)
	}
	for i, sku := range skus {
		if problem := checkSKU(sku, maxSKULength); problem != "" {
			vs.add(fmt.Sprintf("skus[%d]", i), "%s", problem)
		}
	}
	return vs.err()
}

// checkSKU returns a description of what is wrong with sku, or "" when it is valid.
func checkSKU(sku string, maxLen int) string {
	switch {
	case sku == "":
		return "is required"
	case len(sku) > maxLen:
		return fmt.Sprintf("at most %d characters, got %d", maxLen, len(sku))
	case strings.ContainsFunc(sku, unicode.IsSpace):
		return "must not contain whitespace"
	}
	return ""
}
