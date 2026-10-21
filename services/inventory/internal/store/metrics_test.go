package store_test

import (
	"context"
	"testing"

	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"

	"github.com/rizkyr99/sagamart/services/inventory/internal/domain"
	"github.com/rizkyr99/sagamart/services/inventory/internal/store"
)

// transitions reads sagamart.inventory.reservation.transitions by status from reader.
func transitions(t *testing.T, reader *sdkmetric.ManualReader) map[string]int64 {
	t.Helper()
	var rm metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &rm); err != nil {
		t.Fatal(err)
	}
	got := map[string]int64{}
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name != "sagamart.inventory.reservation.transitions" {
				continue
			}
			for _, dp := range m.Data.(metricdata.Sum[int64]).DataPoints {
				to, _ := dp.Attributes.Value("to")
				got[to.AsString()] += dp.Value
			}
		}
	}
	return got
}

func TestTransitionsAreCountedOncePerPersistedChange(t *testing.T) {
	needDB(t)
	t.Parallel()
	reader := sdkmetric.NewManualReader()
	s := store.New(pool, store.WithMeterProvider(sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))))
	ctx := testContext(t)
	sku := newSKU(t, "METRIC")
	seed(t, s, sku, 10)

	committed, released := newOrderID(t), newOrderID(t)
	for _, order := range []string{committed, released} {
		if _, err := s.Reserve(ctx, reserveReq(t, order, domain.Line{SKU: sku, Quantity: 1})); err != nil {
			t.Fatal(err)
		}
	}
	for range 3 {
		if _, err := s.Commit(ctx, committed); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Release(ctx, released); err != nil {
			t.Fatal(err)
		}
	}
	_, _ = s.Release(ctx, committed)    // refused: already committed
	_, _ = s.Commit(ctx, newOrderID(t)) // refused: unknown order

	got := transitions(t, reader)
	if got["COMMITTED"] != 1 || got["RELEASED"] != 1 || len(got) != 2 {
		t.Errorf("transitions = %v, want exactly one COMMITTED and one RELEASED", got)
	}
}
