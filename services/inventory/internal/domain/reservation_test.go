package domain_test

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/rizkyr99/sagamart/services/inventory/internal/domain"
)

func TestStatusFinal(t *testing.T) {
	for status, want := range map[domain.Status]bool{
		domain.StatusActive:    false,
		domain.StatusCommitted: true,
		domain.StatusReleased:  true,
		domain.StatusExpired:   true,
	} {
		if got := status.Final(); got != want {
			t.Errorf("%s.Final() = %v, want %v", status, got, want)
		}
	}
}

// TestDecide is the reservation transition table from RFC-0001 §4.4: one row per (status, command, timing).
func TestDecide(t *testing.T) {
	expiresAt := time.Date(2026, 10, 21, 3, 10, 0, 0, time.UTC)
	before := expiresAt.Add(-time.Second)
	at := expiresAt // strict expiry: the expiry instant itself counts as expired
	after := expiresAt.Add(time.Minute)

	type row struct {
		status  domain.Status
		cmd     domain.Command
		now     time.Time
		want    domain.Outcome
		wantErr error
	}
	transition := func(to domain.Status, op domain.StockOp) domain.Outcome {
		return domain.Outcome{Changed: true, Status: to, StockOp: op}
	}
	unchanged := func(s domain.Status) domain.Outcome { return domain.Outcome{Changed: false, Status: s} }

	rows := []row{
		// Commit: only an unexpired active reservation can be sold.
		{domain.StatusActive, domain.CommandCommit, before, transition(domain.StatusCommitted, domain.StockOpCommit), nil},
		{domain.StatusActive, domain.CommandCommit, at, domain.Outcome{}, domain.ErrReservationNotFound},
		{domain.StatusActive, domain.CommandCommit, after, domain.Outcome{}, domain.ErrReservationNotFound},
		{domain.StatusCommitted, domain.CommandCommit, before, unchanged(domain.StatusCommitted), nil},
		{domain.StatusCommitted, domain.CommandCommit, after, unchanged(domain.StatusCommitted), nil},
		{domain.StatusReleased, domain.CommandCommit, before, domain.Outcome{}, domain.ErrReservationNotFound},
		{domain.StatusExpired, domain.CommandCommit, after, domain.Outcome{}, domain.ErrReservationNotFound},

		// Release: returns stock whenever the reservation is still active; repeats are harmless.
		{domain.StatusActive, domain.CommandRelease, before, transition(domain.StatusReleased, domain.StockOpRelease), nil},
		{domain.StatusActive, domain.CommandRelease, after, transition(domain.StatusReleased, domain.StockOpRelease), nil},
		{domain.StatusReleased, domain.CommandRelease, before, unchanged(domain.StatusReleased), nil},
		{domain.StatusExpired, domain.CommandRelease, after, unchanged(domain.StatusExpired), nil},
		{domain.StatusCommitted, domain.CommandRelease, before, domain.Outcome{}, domain.ErrReservationCommitted},

		// Expire: the worker acts only on active reservations that are due.
		{domain.StatusActive, domain.CommandExpire, before, domain.Outcome{}, domain.ErrNotDue},
		{domain.StatusActive, domain.CommandExpire, at, transition(domain.StatusExpired, domain.StockOpRelease), nil},
		{domain.StatusActive, domain.CommandExpire, after, transition(domain.StatusExpired, domain.StockOpRelease), nil},
		{domain.StatusCommitted, domain.CommandExpire, after, unchanged(domain.StatusCommitted), nil},
		{domain.StatusReleased, domain.CommandExpire, after, unchanged(domain.StatusReleased), nil},
		{domain.StatusExpired, domain.CommandExpire, after, unchanged(domain.StatusExpired), nil},
	}

	timing := func(now time.Time) string {
		switch {
		case now.Before(expiresAt):
			return "before expiry"
		case now.Equal(expiresAt):
			return "at expiry"
		default:
			return "after expiry"
		}
	}
	for _, r := range rows {
		t.Run(fmt.Sprintf("%s %s %s", r.status, r.cmd, timing(r.now)), func(t *testing.T) {
			res := domain.Reservation{OrderID: orderID, Status: r.status, ExpiresAt: expiresAt}
			got, err := domain.Decide(res, r.cmd, r.now)
			if !errors.Is(err, r.wantErr) {
				t.Fatalf("error = %v, want %v", err, r.wantErr)
			}
			if got != r.want {
				t.Errorf("outcome = %+v, want %+v", got, r.want)
			}
		})
	}
}

func TestDecideCoversEveryStatusAndCommand(t *testing.T) {
	// Guards the table above: a new status or command must get explicit rows, not fall through silently.
	now := time.Now()
	for _, s := range []domain.Status{domain.StatusActive, domain.StatusCommitted, domain.StatusReleased, domain.StatusExpired} {
		for _, c := range []domain.Command{domain.CommandCommit, domain.CommandRelease, domain.CommandExpire} {
			if _, err := domain.Decide(domain.Reservation{Status: s, ExpiresAt: now}, c, now); errors.Is(err, domain.ErrInvariant) {
				t.Errorf("%s %s is not handled: %v", s, c, err)
			}
		}
	}
}

func TestDecideRejectsUnknownStatusAndCommand(t *testing.T) {
	now := time.Now()
	if _, err := domain.Decide(domain.Reservation{Status: "PENDING"}, domain.CommandCommit, now); !errors.Is(err, domain.ErrInvariant) {
		t.Errorf("unknown status: error = %v, want ErrInvariant", err)
	}
	if _, err := domain.Decide(domain.Reservation{Status: domain.StatusActive, ExpiresAt: now.Add(time.Hour)}, "ship", now); !errors.Is(err, domain.ErrInvariant) {
		t.Errorf("unknown command: error = %v, want ErrInvariant", err)
	}
}
