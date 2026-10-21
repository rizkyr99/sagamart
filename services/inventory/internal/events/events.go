// Package events builds the CloudEvents-compatible envelopes Inventory publishes (conventions §6).
// Envelopes are written to the outbox in the same transaction as the state change (ADR-0006).
package events

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"go.opentelemetry.io/otel/propagation"
)

// Event types published by Inventory; schemas live in contracts/events/schemas.
const (
	TypeStockAdjusted = "inventory.stock.adjusted"
)

// timeLayout is RFC 3339 in UTC with millisecond precision (conventions §3).
const timeLayout = "2006-01-02T15:04:05.000Z07:00"

// Envelope is the shared event envelope. Subject is the aggregate ID and the partition key.
type Envelope struct {
	ID          string `json:"id"`
	Type        string `json:"type"`
	Source      string `json:"source"`
	SpecVersion string `json:"specversion"`
	Time        string `json:"time"`
	Subject     string `json:"subject"`
	DataSchema  string `json:"dataschema"`
	TraceParent string `json:"traceparent,omitempty"`
	Data        any    `json:"data"`
}

// New builds a version 1 envelope for eventType about subject, carrying the trace context from ctx.
func New(ctx context.Context, eventType, subject string, data any, at time.Time) (Envelope, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return Envelope{}, fmt.Errorf("event id: %w", err)
	}
	carrier := propagation.MapCarrier{}
	propagation.TraceContext{}.Inject(ctx, carrier)

	return Envelope{
		ID:          id.String(),
		Type:        eventType,
		Source:      "inventory",
		SpecVersion: "1.0",
		Time:        at.UTC().Format(timeLayout),
		Subject:     subject,
		DataSchema:  eventType + "/v1",
		TraceParent: carrier.Get("traceparent"),
		Data:        data,
	}, nil
}

// StockAdjusted is the data of inventory.stock.adjusted/v1: an admin set a SKU's on-hand quantity.
type StockAdjusted struct {
	SKU       string `json:"sku"`
	OnHand    int64  `json:"onHand"`
	Available int64  `json:"available"`
	Version   int64  `json:"version"`
}
