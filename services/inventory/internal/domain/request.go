package domain

import "time"

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
func NewLimits(maxLineQuantity int) Limits { panic("not implemented") }

// ReserveRequest asks to hold stock for every line of an order.
type ReserveRequest struct {
	OrderID string
	Lines   []Line
	TTL     time.Duration // zero means DefaultTTL
}

// NormalizeReserve validates req and returns it with lines sorted by SKU (the lock order that prevents
// deadlocks) and the default TTL applied. Every invalid field is reported in one *ValidationError.
func (l Limits) NormalizeReserve(req ReserveRequest) (ReserveRequest, error) { panic("not implemented") }

// CheckRetry decides a repeated ReserveStock for an order that already has a reservation: the same lines
// return the original reservation (nil error); different lines are ErrReservationConflict.
// req must already be normalized.
func CheckRetry(existing Reservation, req ReserveRequest) error { panic("not implemented") }
