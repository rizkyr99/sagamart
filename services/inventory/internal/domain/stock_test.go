package domain_test

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/rizkyr99/sagamart/services/inventory/internal/domain"
)

func TestAvailable(t *testing.T) {
	if got := (domain.StockLevel{OnHand: 10, Reserved: 3}).Available(); got != 7 {
		t.Errorf("Available = %d, want 7", got)
	}
}

func TestReserveLinesAllFit(t *testing.T) {
	levels := map[string]domain.StockLevel{
		"BAJU-001": {SKU: "BAJU-001", OnHand: 5, Reserved: 1, Version: 3},
		"KAOS-001": {SKU: "KAOS-001", OnHand: 2, Reserved: 0, Version: 1},
	}
	got, err := domain.ReserveLines(levels, []domain.Line{{SKU: "BAJU-001", Quantity: 4}, {SKU: "KAOS-001", Quantity: 2}})
	if err != nil {
		t.Fatalf("ReserveLines: %v", err)
	}
	want := map[string]domain.StockLevel{
		"BAJU-001": {SKU: "BAJU-001", OnHand: 5, Reserved: 5, Version: 4},
		"KAOS-001": {SKU: "KAOS-001", OnHand: 2, Reserved: 2, Version: 2},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("ReserveLines = %+v, want %+v", got, want)
	}
	if levels["BAJU-001"].Reserved != 1 {
		t.Error("ReserveLines must not modify its input")
	}
}

func TestReserveLinesIsAllOrNothing(t *testing.T) {
	levels := map[string]domain.StockLevel{
		"BAJU-001": {SKU: "BAJU-001", OnHand: 5, Reserved: 0, Version: 1},
		"KAOS-001": {SKU: "KAOS-001", OnHand: 3, Reserved: 2, Version: 1},
	}
	got, err := domain.ReserveLines(levels, []domain.Line{
		{SKU: "BAJU-001", Quantity: 1}, // fits
		{SKU: "KAOS-001", Quantity: 2}, // 1 available
		{SKU: "TOPI-001", Quantity: 1}, // unknown SKU
	})

	var serr *domain.InsufficientStockError
	if !errors.As(err, &serr) || !errors.Is(err, domain.ErrInsufficientStock) {
		t.Fatalf("want *InsufficientStockError matching ErrInsufficientStock, got %v", err)
	}
	wantShortfalls := []domain.Shortfall{
		{SKU: "KAOS-001", Requested: 2, Available: 1},
		{SKU: "TOPI-001", Requested: 1, Available: 0},
	}
	if !reflect.DeepEqual(serr.Shortfalls, wantShortfalls) {
		t.Errorf("shortfalls = %+v, want %+v", serr.Shortfalls, wantShortfalls)
	}
	if got != nil {
		t.Errorf("nothing may be reserved on failure, got %+v", got)
	}
	if !strings.Contains(serr.Error(), "KAOS-001") {
		t.Errorf("Error() %q should name the SKUs", serr.Error())
	}
}

func TestReserveLinesExactlyAvailable(t *testing.T) {
	levels := map[string]domain.StockLevel{"KAOS-001": {SKU: "KAOS-001", OnHand: 3, Reserved: 1, Version: 1}}
	got, err := domain.ReserveLines(levels, []domain.Line{{SKU: "KAOS-001", Quantity: 2}})
	if err != nil {
		t.Fatalf("reserving exactly the available quantity: %v", err)
	}
	if got["KAOS-001"].Available() != 0 {
		t.Errorf("available = %d, want 0", got["KAOS-001"].Available())
	}
}

func TestApply(t *testing.T) {
	start := domain.StockLevel{SKU: "KAOS-001", OnHand: 10, Reserved: 4, Version: 7}
	tests := []struct {
		name    string
		op      domain.StockOp
		qty     int64
		want    domain.StockLevel
		wantErr error
	}{
		{"commit sells reserved units", domain.StockOpCommit, 3, domain.StockLevel{SKU: "KAOS-001", OnHand: 7, Reserved: 1, Version: 8}, nil},
		{"release frees reserved units", domain.StockOpRelease, 3, domain.StockLevel{SKU: "KAOS-001", OnHand: 10, Reserved: 1, Version: 8}, nil},
		{"none changes nothing", domain.StockOpNone, 3, start, nil},
		{"commit more than reserved", domain.StockOpCommit, 5, start, domain.ErrInvariant},
		{"release more than reserved", domain.StockOpRelease, 5, start, domain.ErrInvariant},
		{"non-positive quantity", domain.StockOpRelease, 0, start, domain.ErrInvariant},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := start.Apply(tt.op, tt.qty)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("error = %v, want %v", err, tt.wantErr)
			}
			if err == nil && got != tt.want {
				t.Errorf("Apply = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestSetStock(t *testing.T) {
	current := &domain.StockLevel{SKU: "KAOS-001", OnHand: 10, Reserved: 4, Version: 7}
	tests := []struct {
		name     string
		current  *domain.StockLevel
		onHand   int64
		expected int64
		want     domain.StockLevel
		wantErr  error
	}{
		{"create a new SKU", nil, 25, 0, domain.StockLevel{SKU: "KAOS-001", OnHand: 25, Version: 1}, nil},
		{"raise stock", current, 30, 7, domain.StockLevel{SKU: "KAOS-001", OnHand: 30, Reserved: 4, Version: 8}, nil},
		{"lower stock down to reserved", current, 4, 7, domain.StockLevel{SKU: "KAOS-001", OnHand: 4, Reserved: 4, Version: 8}, nil},
		{"below reserved", current, 3, 7, domain.StockLevel{}, domain.ErrStockBelowReserved},
		{"stale version", current, 30, 6, domain.StockLevel{}, domain.ErrVersionConflict},
		{"create when it already exists", current, 30, 0, domain.StockLevel{}, domain.ErrVersionConflict},
		{"update when it doesn't exist", nil, 30, 3, domain.StockLevel{}, domain.ErrVersionConflict},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := domain.SetStock(tt.current, "KAOS-001", tt.onHand, tt.expected)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("error = %v, want %v", err, tt.wantErr)
			}
			if err == nil && got != tt.want {
				t.Errorf("SetStock = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestSetStockRejectsNegativeOnHand(t *testing.T) {
	_, err := domain.SetStock(nil, "KAOS-001", -1, 0)
	var verr *domain.ValidationError
	if !errors.As(err, &verr) || !hasViolation(verr, "on_hand") {
		t.Fatalf("want a validation error on on_hand, got %v", err)
	}
}

func TestSetStockValidatesSKU(t *testing.T) {
	for _, sku := range []string{"", "KAOS 001", strings.Repeat("X", 65)} {
		_, err := domain.SetStock(nil, sku, 1, 0)
		var verr *domain.ValidationError
		if !errors.As(err, &verr) || !hasViolation(verr, "sku") {
			t.Errorf("SKU %q: want a validation error on sku, got %v", sku, err)
		}
	}
}
