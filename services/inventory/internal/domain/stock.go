package domain

import "fmt"

// StockLevel is the stock of one SKU. Available = OnHand - Reserved; both counts never go negative
// and Reserved never exceeds OnHand (the stock_never_oversold constraint).
type StockLevel struct {
	SKU      string
	OnHand   int64
	Reserved int64
	Version  int64 // increments on every change
}

// Available is what can still be reserved.
func (s StockLevel) Available() int64 { return s.OnHand - s.Reserved }

// ReserveLines reserves every line or none. levels is not modified; the result holds the updated levels
// of the SKUs that were reserved. Lines that don't fit, including unknown SKUs, are all reported in one
// *InsufficientStockError.
func ReserveLines(levels map[string]StockLevel, lines []Line) (map[string]StockLevel, error) {
	updated := make(map[string]StockLevel, len(lines))
	var shortfalls []Shortfall
	for _, line := range lines {
		level, ok := updated[line.SKU]
		if !ok {
			level, ok = levels[line.SKU]
		}
		if !ok || level.Available() < line.Quantity {
			shortfalls = append(shortfalls, Shortfall{SKU: line.SKU, Requested: line.Quantity, Available: max(level.Available(), 0)})
			continue
		}
		level.Reserved += line.Quantity
		level.Version++
		updated[line.SKU] = level
	}
	if len(shortfalls) > 0 {
		return nil, &InsufficientStockError{Shortfalls: shortfalls}
	}
	return updated, nil
}

// Apply performs a transition's stock operation for qty units. Releasing or committing more than is
// reserved returns ErrInvariant.
func (s StockLevel) Apply(op StockOp, qty int64) (StockLevel, error) {
	if op == StockOpNone {
		return s, nil
	}
	if qty < 1 || qty > s.Reserved {
		return s, fmt.Errorf("%w: %s has %d reserved, cannot settle %d", ErrInvariant, s.SKU, s.Reserved, qty)
	}
	switch op {
	case StockOpCommit:
		s.OnHand -= qty
	case StockOpRelease:
	default:
		return s, fmt.Errorf("%w: unknown stock operation %d", ErrInvariant, op)
	}
	s.Reserved -= qty
	s.Version++
	return s, nil
}

// SetStock sets OnHand for an admin stock change (PRD FR-11) with optimistic concurrency.
// current is nil when the SKU doesn't exist yet; expectedVersion 0 means "create".
func SetStock(current *StockLevel, sku string, onHand, expectedVersion int64) (StockLevel, error) {
	var vs violations
	if problem := checkSKU(sku, maxSKULength); problem != "" {
		vs.add("sku", "%s", problem)
	}
	if onHand < 0 {
		vs.add("on_hand", "must not be negative, got %d", onHand)
	}
	if err := vs.err(); err != nil {
		return StockLevel{}, err
	}

	if current == nil {
		if expectedVersion != 0 {
			return StockLevel{}, fmt.Errorf("%w: %s does not exist, expected version must be 0", ErrVersionConflict, sku)
		}
		return StockLevel{SKU: sku, OnHand: onHand, Version: 1}, nil
	}

	if expectedVersion != current.Version {
		return StockLevel{}, fmt.Errorf("%w: %s is at version %d, expected %d", ErrVersionConflict, sku, current.Version, expectedVersion)
	}
	if onHand < current.Reserved {
		return StockLevel{}, fmt.Errorf("%w: %s has %d reserved", ErrStockBelowReserved, sku, current.Reserved)
	}
	next := *current
	next.OnHand = onHand
	next.Version++
	return next, nil
}
