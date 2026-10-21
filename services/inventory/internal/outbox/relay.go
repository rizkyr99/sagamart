// Package outbox publishes events from the transactional outbox to Redpanda (ADR-0003, ADR-0006).
package outbox

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/rizkyr99/sagamart/services/inventory/internal/store"
)

// maxBackoff caps the wait between attempts while the broker is unavailable.
const maxBackoff = 30 * time.Second

// Message is one record to publish. Key is the aggregate ID, so one aggregate's events stay in one partition, in order.
type Message struct {
	Key     string
	Value   []byte
	Headers map[string]string
}

// Publisher sends a batch of messages to a topic and returns once the broker has acknowledged all of them.
type Publisher interface {
	Publish(ctx context.Context, topic string, msgs []Message) error
}

// Claimer hands out unpublished outbox events; *store.Store implements it.
type Claimer interface {
	ClaimOutbox(ctx context.Context, limit int, publish func(context.Context, []store.OutboxEvent) error) (int, error)
}

// Relay moves events from the outbox to the broker.
type Relay struct {
	claimer   Claimer
	publisher Publisher
	topic     string
	interval  time.Duration
	batch     int
	log       *slog.Logger
	metrics   metrics
}

// New returns a Relay that polls every interval and publishes batches of up to batch events to topic.
func New(claimer Claimer, publisher Publisher, topic string, interval time.Duration, batch int, log *slog.Logger) *Relay {
	return &Relay{claimer: claimer, publisher: publisher, topic: topic, interval: interval, batch: batch, log: log, metrics: newMetrics()}
}

// Run publishes pending events until ctx is done. After a failure it backs off exponentially, up to maxBackoff.
func (r *Relay) Run(ctx context.Context) {
	wait := r.interval
	for {
		n, err := r.RunOnce(ctx)
		switch {
		case err != nil && ctx.Err() == nil:
			r.log.ErrorContext(ctx, "outbox publish failed", "error", err, "published", n, "retry_in", wait.String())
			wait = min(wait*2, maxBackoff)
		default:
			wait = r.interval
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

// RunOnce publishes batches until one comes back short and returns how many events were published.
func (r *Relay) RunOnce(ctx context.Context) (int, error) {
	total := 0
	for {
		n, err := r.claimer.ClaimOutbox(ctx, r.batch, r.publish)
		total += n
		if err != nil {
			r.metrics.failures.Add(ctx, 1)
			return total, err
		}
		if n < r.batch {
			return total, nil
		}
	}
}

func (r *Relay) publish(ctx context.Context, batch []store.OutboxEvent) error {
	msgs := make([]Message, len(batch))
	for i, e := range batch {
		msgs[i] = ToMessage(e)
	}
	if err := r.publisher.Publish(ctx, r.topic, msgs); err != nil {
		return err
	}
	now := time.Now()
	for _, e := range batch {
		r.metrics.published(ctx, e.EventType, now.Sub(e.CreatedAt).Seconds())
	}
	return nil
}

// ToMessage maps an outbox event to a broker message: key = aggregate ID, CloudEvents headers, and the trace
// context from the envelope so consumers continue the producer's trace.
func ToMessage(e store.OutboxEvent) Message {
	headers := map[string]string{
		"ce_id":        e.ID,
		"ce_type":      e.EventType,
		"ce_source":    "inventory",
		"content-type": "application/cloudevents+json",
	}
	var env struct {
		TraceParent string `json:"traceparent"`
	}
	if json.Unmarshal(e.Payload, &env) == nil && env.TraceParent != "" {
		headers["traceparent"] = env.TraceParent
	}
	return Message{Key: e.AggregateID, Value: e.Payload, Headers: headers}
}
