package domain

// StockLevel is the stock of one SKU. Available = OnHand - Reserved; both counts never go negative
// and Reserved never exceeds OnHand (the stock_never_oversold constraint).
type StockLevel struct {
	SKU      string
	OnHand   int64
	Reserved int64
	Version  int64 // increments on every change
}

// Available is what can still be reserved.
func (s StockLevel) Available() int64 { panic("not implemented") }

// ReserveLines reserves every line or none. levels is not modified; the result holds the updated levels
// of the SKUs that were reserved. Lines that don't fit, including unknown SKUs, are all reported in one
// *InsufficientStockError.
func ReserveLines(levels map[string]StockLevel, lines []Line) (map[string]StockLevel, error) {
	panic("not implemented")
}

// Apply performs a transition's stock operation for qty units. Releasing or committing more than is
// reserved returns ErrInvariant.
func (s StockLevel) Apply(op StockOp, qty int64) (StockLevel, error) { panic("not implemented") }

// SetStock sets OnHand for an admin stock change (PRD FR-11) with optimistic concurrency.
// current is nil when the SKU doesn't exist yet; expectedVersion 0 means "create".
func SetStock(current *StockLevel, sku string, onHand, expectedVersion int64) (StockLevel, error) {
	panic("not implemented")
}
