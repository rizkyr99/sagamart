package events_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"go.opentelemetry.io/otel/trace"

	"github.com/rizkyr99/sagamart/services/inventory/internal/events"
	"github.com/rizkyr99/sagamart/services/inventory/internal/events/schematest"
)

func TestStockAdjustedMatchesContract(t *testing.T) {
	sc := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: trace.TraceID{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16},
		SpanID:  trace.SpanID{1, 2, 3, 4, 5, 6, 7, 8}, TraceFlags: trace.FlagsSampled,
	})
	ctx := trace.ContextWithSpanContext(context.Background(), sc)

	env, err := events.New(ctx, events.TypeStockAdjusted, "KAOS-001",
		events.StockAdjusted{SKU: "KAOS-001", OnHand: 100, Available: 97, Version: 4},
		time.Date(2026, 10, 21, 2, 0, 0, 0, time.FixedZone("WIB", 7*3600)))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	payload, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	schematest.Validate(t, events.TypeStockAdjusted, payload)

	if env.Time != "2026-10-20T19:00:00.000Z" {
		t.Errorf("time = %s, want UTC with milliseconds", env.Time)
	}
	if env.TraceParent != "00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01" {
		t.Errorf("traceparent = %q", env.TraceParent)
	}
}

func TestNewWithoutTraceOmitsTraceParent(t *testing.T) {
	env, err := events.New(context.Background(), events.TypeStockAdjusted, "KAOS-001",
		events.StockAdjusted{SKU: "KAOS-001", OnHand: 1, Available: 1, Version: 1}, time.Now())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	payload, _ := json.Marshal(env)
	schematest.Validate(t, events.TypeStockAdjusted, payload)
	if env.TraceParent != "" {
		t.Errorf("traceparent = %q, want empty", env.TraceParent)
	}
}

func TestSchemaRejectsWrongData(t *testing.T) {
	// Guards the validator itself: a payload that breaks the contract must fail.
	env, _ := events.New(context.Background(), events.TypeStockAdjusted, "KAOS-001",
		events.StockAdjusted{SKU: "KAOS-001", OnHand: -1, Available: 1, Version: 1}, time.Now())
	payload, _ := json.Marshal(env)

	rec := &recorder{TB: t}
	schematest.Validate(rec, events.TypeStockAdjusted, payload)
	if !rec.failed {
		t.Error("negative onHand passed schema validation")
	}
}

type recorder struct {
	testing.TB
	failed bool
}

func (r *recorder) Errorf(string, ...any) { r.failed = true }
