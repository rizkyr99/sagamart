package domain_test

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/rizkyr99/sagamart/services/inventory/internal/domain"
)

const orderID = "0199f29e-8a10-7b2c-9d3e-4f5a6b7c8d9e"

func TestNewLimits(t *testing.T) {
	got := domain.NewLimits(7)
	want := domain.Limits{
		MaxLines:        50,
		MaxLineQuantity: 7,
		MaxSKULength:    64,
		MinTTL:          time.Minute,
		MaxTTL:          30 * time.Minute,
		DefaultTTL:      10 * time.Minute,
	}
	if got != want {
		t.Errorf("NewLimits(7) = %+v, want %+v", got, want)
	}
}

func TestNormalizeReserveSortsLinesAndDefaultsTTL(t *testing.T) {
	lines := []domain.Line{{SKU: "KAOS-002", Quantity: 1}, {SKU: "BAJU-001", Quantity: 2}, {SKU: "KAOS-001", Quantity: 3}}
	req := domain.ReserveRequest{OrderID: orderID, Lines: lines}

	got, err := domain.NewLimits(100).NormalizeReserve(req)
	if err != nil {
		t.Fatalf("NormalizeReserve: %v", err)
	}

	wantLines := []domain.Line{{SKU: "BAJU-001", Quantity: 2}, {SKU: "KAOS-001", Quantity: 3}, {SKU: "KAOS-002", Quantity: 1}}
	if !reflect.DeepEqual(got.Lines, wantLines) {
		t.Errorf("lines = %v, want sorted by SKU %v", got.Lines, wantLines)
	}
	if got.TTL != 10*time.Minute {
		t.Errorf("TTL = %v, want default 10m", got.TTL)
	}
	if lines[0].SKU != "KAOS-002" {
		t.Error("NormalizeReserve must not reorder the caller's slice")
	}
}

func TestNormalizeReserveKeepsExplicitTTL(t *testing.T) {
	got, err := domain.NewLimits(100).NormalizeReserve(domain.ReserveRequest{
		OrderID: orderID, Lines: []domain.Line{{SKU: "KAOS-001", Quantity: 1}}, TTL: 3 * time.Minute,
	})
	if err != nil {
		t.Fatalf("NormalizeReserve: %v", err)
	}
	if got.TTL != 3*time.Minute {
		t.Errorf("TTL = %v, want 3m", got.TTL)
	}
}

func TestNormalizeReserveAcceptsBoundaries(t *testing.T) {
	limits := domain.NewLimits(100)
	lines := make([]domain.Line, 50)
	for i := range lines {
		lines[i] = domain.Line{SKU: "SKU-" + strings.Repeat("A", i+1), Quantity: 100}
	}
	lines[0].SKU = strings.Repeat("X", 64)

	for _, ttl := range []time.Duration{time.Minute, 30 * time.Minute} {
		if _, err := limits.NormalizeReserve(domain.ReserveRequest{OrderID: orderID, Lines: lines, TTL: ttl}); err != nil {
			t.Errorf("50 lines, quantity 100, 64-char SKU, TTL %v rejected: %v", ttl, err)
		}
	}
}

func TestNormalizeReserveRejectsInvalidRequests(t *testing.T) {
	one := []domain.Line{{SKU: "KAOS-001", Quantity: 1}}
	tooMany := make([]domain.Line, 51)
	for i := range tooMany {
		tooMany[i] = domain.Line{SKU: "SKU-" + strings.Repeat("A", i+1), Quantity: 1}
	}

	tests := []struct {
		name  string
		req   domain.ReserveRequest
		field string
	}{
		{"missing order id", domain.ReserveRequest{Lines: one}, "order_id"},
		{"order id not a UUID", domain.ReserveRequest{OrderID: "order-1", Lines: one}, "order_id"},
		{"no lines", domain.ReserveRequest{OrderID: orderID}, "lines"},
		{"more than 50 lines", domain.ReserveRequest{OrderID: orderID, Lines: tooMany}, "lines"},
		{"empty SKU", domain.ReserveRequest{OrderID: orderID, Lines: []domain.Line{{SKU: "", Quantity: 1}}}, "lines[0].sku"},
		{"SKU with spaces", domain.ReserveRequest{OrderID: orderID, Lines: []domain.Line{{SKU: "KAOS 001", Quantity: 1}}}, "lines[0].sku"},
		{"SKU too long", domain.ReserveRequest{OrderID: orderID, Lines: []domain.Line{{SKU: strings.Repeat("X", 65), Quantity: 1}}}, "lines[0].sku"},
		{"duplicate SKU", domain.ReserveRequest{OrderID: orderID, Lines: []domain.Line{{SKU: "KAOS-001", Quantity: 1}, {SKU: "KAOS-001", Quantity: 2}}}, "lines[1].sku"},
		{"zero quantity", domain.ReserveRequest{OrderID: orderID, Lines: []domain.Line{{SKU: "KAOS-001", Quantity: 0}}}, "lines[0].quantity"},
		{"negative quantity", domain.ReserveRequest{OrderID: orderID, Lines: []domain.Line{{SKU: "KAOS-001", Quantity: -1}}}, "lines[0].quantity"},
		{"quantity above cap", domain.ReserveRequest{OrderID: orderID, Lines: []domain.Line{{SKU: "KAOS-001", Quantity: 101}}}, "lines[0].quantity"},
		{"TTL below 1 minute", domain.ReserveRequest{OrderID: orderID, Lines: one, TTL: 59 * time.Second}, "ttl"},
		{"TTL above 30 minutes", domain.ReserveRequest{OrderID: orderID, Lines: one, TTL: 31 * time.Minute}, "ttl"},
		{"negative TTL", domain.ReserveRequest{OrderID: orderID, Lines: one, TTL: -time.Minute}, "ttl"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := domain.NewLimits(100).NormalizeReserve(tt.req)
			var verr *domain.ValidationError
			if !errors.As(err, &verr) {
				t.Fatalf("want *ValidationError, got %v", err)
			}
			if !hasViolation(verr, tt.field) {
				t.Errorf("violations %+v do not include field %q", verr.Violations, tt.field)
			}
		})
	}
}

func TestNormalizeReserveReportsEveryViolation(t *testing.T) {
	_, err := domain.NewLimits(100).NormalizeReserve(domain.ReserveRequest{
		OrderID: "nope",
		Lines:   []domain.Line{{SKU: "", Quantity: 0}},
		TTL:     time.Hour,
	})
	var verr *domain.ValidationError
	if !errors.As(err, &verr) {
		t.Fatalf("want *ValidationError, got %v", err)
	}
	for _, field := range []string{"order_id", "lines[0].sku", "lines[0].quantity", "ttl"} {
		if !hasViolation(verr, field) {
			t.Errorf("missing violation for %s in %+v", field, verr.Violations)
		}
	}
	if !strings.Contains(verr.Error(), "order_id") {
		t.Errorf("Error() %q should name the fields", verr.Error())
	}
}

func hasViolation(err *domain.ValidationError, field string) bool {
	for _, v := range err.Violations {
		if v.Field == field && v.Description != "" {
			return true
		}
	}
	return false
}

func TestCheckRetry(t *testing.T) {
	existing := domain.Reservation{
		OrderID: orderID,
		Status:  domain.StatusActive,
		Lines:   []domain.Line{{SKU: "BAJU-001", Quantity: 2}, {SKU: "KAOS-001", Quantity: 1}},
	}
	tests := []struct {
		name    string
		lines   []domain.Line
		wantErr error
	}{
		{"same lines", []domain.Line{{SKU: "BAJU-001", Quantity: 2}, {SKU: "KAOS-001", Quantity: 1}}, nil},
		{"different quantity", []domain.Line{{SKU: "BAJU-001", Quantity: 3}, {SKU: "KAOS-001", Quantity: 1}}, domain.ErrReservationConflict},
		{"extra line", []domain.Line{{SKU: "BAJU-001", Quantity: 2}, {SKU: "KAOS-001", Quantity: 1}, {SKU: "KAOS-002", Quantity: 1}}, domain.ErrReservationConflict},
		{"missing line", []domain.Line{{SKU: "BAJU-001", Quantity: 2}}, domain.ErrReservationConflict},
		{"different SKU", []domain.Line{{SKU: "BAJU-002", Quantity: 2}, {SKU: "KAOS-001", Quantity: 1}}, domain.ErrReservationConflict},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := domain.CheckRetry(existing, domain.ReserveRequest{OrderID: orderID, Lines: tt.lines})
			if !errors.Is(err, tt.wantErr) {
				t.Errorf("CheckRetry = %v, want %v", err, tt.wantErr)
			}
		})
	}
}

func TestCheckRetryReturnsOriginalWhateverItsStatus(t *testing.T) {
	// A retried ReserveStock is answered with the original reservation even after it was finalised;
	// the saga then learns the real state from its next command.
	for _, status := range []domain.Status{domain.StatusCommitted, domain.StatusReleased, domain.StatusExpired} {
		existing := domain.Reservation{OrderID: orderID, Status: status, Lines: []domain.Line{{SKU: "KAOS-001", Quantity: 1}}}
		if err := domain.CheckRetry(existing, domain.ReserveRequest{OrderID: orderID, Lines: existing.Lines}); err != nil {
			t.Errorf("status %s: CheckRetry = %v, want nil", status, err)
		}
	}
}

func TestValidateStockQuery(t *testing.T) {
	if err := domain.ValidateStockQuery([]string{"KAOS-001", "BAJU-001"}); err != nil {
		t.Errorf("valid query rejected: %v", err)
	}
	hundred := make([]string, 100)
	for i := range hundred {
		hundred[i] = "SKU-" + strings.Repeat("A", i%60+1)
	}
	if err := domain.ValidateStockQuery(hundred); err != nil {
		t.Errorf("100 SKUs rejected: %v", err)
	}

	tests := []struct {
		name  string
		skus  []string
		field string
	}{
		{"empty", nil, "skus"},
		{"more than 100", append(hundred, "ONE-MORE"), "skus"},
		{"blank SKU", []string{"KAOS-001", ""}, "skus[1]"},
		{"SKU with spaces", []string{"KAOS 001"}, "skus[0]"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var verr *domain.ValidationError
			if err := domain.ValidateStockQuery(tt.skus); !errors.As(err, &verr) || !hasViolation(verr, tt.field) {
				t.Errorf("want a violation on %s, got %v", tt.field, err)
			}
		})
	}
}
