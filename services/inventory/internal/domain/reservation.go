package domain

import "time"

// Status is a reservation's lifecycle state. ACTIVE is the only non-final status.
type Status string

const (
	StatusActive    Status = "ACTIVE"
	StatusCommitted Status = "COMMITTED"
	StatusReleased  Status = "RELEASED"
	StatusExpired   Status = "EXPIRED"
)

// Final reports whether no further transition is possible.
func (s Status) Final() bool { panic("not implemented") }

// Reservation is a temporary hold on stock for one order.
type Reservation struct {
	ID        string
	OrderID   string
	Status    Status
	Lines     []Line
	ExpiresAt time.Time
}

// Command is something that can happen to an existing reservation.
type Command string

const (
	CommandCommit  Command = "commit"  // the saga confirms the sale
	CommandRelease Command = "release" // the saga cancels the checkout
	CommandExpire  Command = "expire"  // the expiry worker found it past its TTL
)

// StockOp is what a transition does to each line's stock level.
type StockOp int

const (
	StockOpNone    StockOp = iota
	StockOpCommit          // on_hand -= qty, reserved -= qty: the units are sold
	StockOpRelease         // reserved -= qty: the units are available again
)

// Outcome is the result of applying a command.
// Changed is false for an idempotent repeat: nothing is written and Status is the current status.
type Outcome struct {
	Changed bool
	Status  Status
	StockOp StockOp
}

// Decide applies the reservation transition table (RFC-0001 §4.4) to cmd at time now.
// Expiry is strict: a reservation is expired from ExpiresAt onward, whether or not the worker has run.
func Decide(r Reservation, cmd Command, now time.Time) (Outcome, error) { panic("not implemented") }
