package domain

import "errors"

// Domain errors. The gRPC layer maps each to a status code and ErrorInfo reason (see the inventory contract).
var (
	ErrInsufficientStock    = errors.New("insufficient stock")
	ErrReservationNotFound  = errors.New("reservation not found")
	ErrReservationCommitted = errors.New("reservation already committed")
	ErrReservationConflict  = errors.New("order already has a reservation with different lines")
	ErrStockBelowReserved   = errors.New("on hand would drop below the reserved quantity")
	ErrVersionConflict      = errors.New("stock level version does not match")
	ErrNotDue               = errors.New("reservation has not reached its expiry time")
	// ErrInvariant means a rule in this package would be broken; it signals a bug, never a caller mistake.
	ErrInvariant = errors.New("inventory invariant violated")
)

// Shortfall is one reservation line that didn't fit available stock.
type Shortfall struct {
	SKU       string
	Requested int64
	Available int64 // 0 for unknown SKUs
}

// InsufficientStockError lists every line that didn't fit. errors.Is(err, ErrInsufficientStock) is true.
type InsufficientStockError struct {
	Shortfalls []Shortfall
}

func (e *InsufficientStockError) Error() string { panic("not implemented") }

func (e *InsufficientStockError) Is(target error) bool { panic("not implemented") }

// Violation is one invalid field, named by its path in the request (for a google.rpc.BadRequest detail).
type Violation struct {
	Field       string
	Description string
}

// ValidationError lists every invalid field in a request.
type ValidationError struct {
	Violations []Violation
}

func (e *ValidationError) Error() string { panic("not implemented") }
