package outbox_test

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/rizkyr99/sagamart/services/inventory/internal/outbox"
	"github.com/rizkyr99/sagamart/services/inventory/internal/store"
)

// fakeClaimer serves batches from a queue and remembers what was acknowledged.
type fakeClaimer struct {
	mu        sync.Mutex
	pending   []store.OutboxEvent
	published []store.OutboxEvent
	calls     int
}

func (f *fakeClaimer) ClaimOutbox(ctx context.Context, limit int, publish func(context.Context, []store.OutboxEvent) error) (int, error) {
	f.mu.Lock()
	f.calls++
	n := min(limit, len(f.pending))
	batch := append([]store.OutboxEvent(nil), f.pending[:n]...)
	f.mu.Unlock()
	if n == 0 {
		return 0, nil
	}
	if err := publish(ctx, batch); err != nil {
		return 0, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pending = f.pending[n:]
	f.published = append(f.published, batch...)
	return n, nil
}

func (f *fakeClaimer) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

type fakePublisher struct {
	mu      sync.Mutex
	topics  []string
	msgs    []outbox.Message
	failFor int // fail this many calls first
}

func (f *fakePublisher) Publish(_ context.Context, topic string, msgs []outbox.Message) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failFor > 0 {
		f.failFor--
		return errors.New("broker unavailable")
	}
	f.topics = append(f.topics, topic)
	f.msgs = append(f.msgs, msgs...)
	return nil
}

func events(n int) []store.OutboxEvent {
	out := make([]store.OutboxEvent, n)
	for i := range out {
		out[i] = store.OutboxEvent{ID: "e" + string(rune('a'+i%26)), AggregateID: "KAOS-001", EventType: "inventory.stock.adjusted", Payload: []byte(`{}`)}
	}
	return out
}

func discard() *slog.Logger { return slog.New(slog.DiscardHandler) }

func TestToMessage(t *testing.T) {
	msg := outbox.ToMessage(store.OutboxEvent{
		ID:          "0199f2b0-1d2e-7f30-9a4b-5c6d7e8f9012",
		AggregateID: "0199f29e-8a10-7b2c-9d3e-4f5a6b7c8d9e",
		EventType:   "inventory.reservation.expired",
		Payload:     []byte(`{"id":"0199f2b0-1d2e-7f30-9a4b-5c6d7e8f9012","traceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01","data":{}}`),
	})
	if msg.Key != "0199f29e-8a10-7b2c-9d3e-4f5a6b7c8d9e" {
		t.Errorf("key = %q, want the aggregate ID", msg.Key)
	}
	want := map[string]string{
		"ce_id":        "0199f2b0-1d2e-7f30-9a4b-5c6d7e8f9012",
		"ce_type":      "inventory.reservation.expired",
		"ce_source":    "inventory",
		"content-type": "application/cloudevents+json",
		"traceparent":  "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
	}
	for k, v := range want {
		if msg.Headers[k] != v {
			t.Errorf("header %s = %q, want %q", k, msg.Headers[k], v)
		}
	}
	if string(msg.Value) != `{"id":"0199f2b0-1d2e-7f30-9a4b-5c6d7e8f9012","traceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01","data":{}}` {
		t.Errorf("value changed: %s", msg.Value)
	}
}

func TestToMessageWithoutTrace(t *testing.T) {
	msg := outbox.ToMessage(store.OutboxEvent{ID: "x", AggregateID: "KAOS-001", EventType: "inventory.stock.adjusted", Payload: []byte(`{"data":{}}`)})
	if _, ok := msg.Headers["traceparent"]; ok {
		t.Errorf("traceparent header set without a trace: %v", msg.Headers)
	}
}

func TestRunOnceDrainsTheOutbox(t *testing.T) {
	c := &fakeClaimer{pending: events(250)}
	p := &fakePublisher{}
	n, err := outbox.New(c, p, "inventory.events", time.Second, 100, discard()).RunOnce(context.Background())
	if err != nil || n != 250 {
		t.Fatalf("RunOnce = %d, %v; want 250", n, err)
	}
	if len(p.msgs) != 250 || p.topics[0] != "inventory.events" || len(c.pending) != 0 {
		t.Errorf("published %d to %v, %d left", len(p.msgs), p.topics, len(c.pending))
	}
}

func TestRunOnceReturnsPublishErrors(t *testing.T) {
	c := &fakeClaimer{pending: events(3)}
	p := &fakePublisher{failFor: 1}
	if _, err := outbox.New(c, p, "inventory.events", time.Second, 100, discard()).RunOnce(context.Background()); err == nil {
		t.Fatal("RunOnce returned nil after a failed publish")
	}
	if len(c.pending) != 3 {
		t.Errorf("events dropped after a failed publish: %d pending", len(c.pending))
	}
}

func TestRunRecoversAfterFailuresAndStopsOnCancel(t *testing.T) {
	c := &fakeClaimer{pending: events(5)}
	p := &fakePublisher{failFor: 2}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		outbox.New(c, p, "inventory.events", 5*time.Millisecond, 100, discard()).Run(ctx)
		close(done)
	}()

	deadline := time.After(3 * time.Second)
	for {
		c.mu.Lock()
		published := len(c.published)
		c.mu.Unlock()
		if published == 5 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("relay did not recover from broker failures: %d published", published)
		case <-time.After(5 * time.Millisecond):
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run did not return after cancel")
	}
	if c.callCount() < 3 {
		t.Errorf("only %d claims; expected retries after the two failures", c.callCount())
	}
}
