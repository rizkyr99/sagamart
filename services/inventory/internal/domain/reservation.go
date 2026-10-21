package domain

import (
	"fmt"
	"time"
)

// Status is a reservation's lifecycle state. ACTIVE is the only non-final status.
type Status string

const (
	StatusActive    Status = "ACTIVE"
	StatusCommitted Status = "COMMITTED"
	StatusReleased  Status = "RELEASED"
	StatusExpired   Status = "EXPIRED"
)

// Final reports whether no further transition is possible.
func (s Status) Final() bool { return s != StatusActive }

// Reservation is a temporary hold on stock for one order.
type Reservation struct {
	ID        string
	OrderID   string
	Status    Status
	Lines     []Line
	ExpiresAt time.Time
}

// expiredAt reports whether the reservation has reached its expiry time. The instant itself counts.
func (r Reservation) expiredAt(now time.Time) bool { return !now.Before(r.ExpiresAt) }

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

func transition(to Status, op StockOp) (Outcome, error) {
	return Outcome{Changed: true, Status: to, StockOp: op}, nil
}

func unchanged(current Status) (Outcome, error) { return Outcome{Status: current}, nil }

// Decide applies the reservation transition table (RFC-0001 §4.4) to cmd at time now.
// Expiry is strict: a reservation is expired from ExpiresAt onward, whether or not the worker has run.
func Decide(r Reservation, cmd Command, now time.Time) (Outcome, error) {
	switch r.Status {
	case StatusActive, StatusCommitted, StatusReleased, StatusExpired:
	default:
		return Outcome{}, fmt.Errorf("%w: unknown reservation status %q", ErrInvariant, r.Status)
	}

	switch cmd {
	case CommandCommit:
		switch {
		case r.Status == StatusCommitted:
			return unchanged(r.Status)
		case r.Status == StatusActive && !r.expiredAt(now):
			return transition(StatusCommitted, StockOpCommit)
		default: // released, expired, or active but past its expiry time
			return Outcome{}, ErrReservationNotFound
		}

	case CommandRelease:
		switch r.Status {
		case StatusActive:
			return transition(StatusReleased, StockOpRelease)
		case StatusCommitted:
			return Outcome{}, ErrReservationCommitted
		default: // already released or expired: the stock is already back
			return unchanged(r.Status)
		}

	case CommandExpire:
		switch {
		case r.Status.Final():
			return unchanged(r.Status)
		case !r.expiredAt(now):
			return Outcome{}, ErrNotDue
		default:
			return transition(StatusExpired, StockOpRelease)
		}
	}
	return Outcome{}, fmt.Errorf("%w: unknown command %q", ErrInvariant, cmd)
}
