package outbox_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/modules/redpanda"
	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/twmb/franz-go/pkg/kmsg"

	"github.com/rizkyr99/sagamart/services/inventory/internal/domain"
	"github.com/rizkyr99/sagamart/services/inventory/internal/events/schematest"
	"github.com/rizkyr99/sagamart/services/inventory/internal/outbox"
	"github.com/rizkyr99/sagamart/services/inventory/internal/store"
)

// TestRelayPublishesEachStateChangeOnce runs the whole path on real infrastructure: state changes write the
// outbox in their own transactions, the relay publishes to a real Redpanda, and a consumer sees exactly one
// schema-valid event per change, keyed by aggregate ID, in order (issue #10).
func TestRelayPublishesEachStateChangeOnce(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test: needs Docker")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	pg, err := postgres.Run(ctx, "postgres:17.2-alpine", postgres.WithDatabase("inventory"), postgres.BasicWaitStrategies())
	if err != nil {
		t.Fatalf("start postgres: %v", err)
	}
	t.Cleanup(func() { _ = pg.Terminate(context.Background()) })
	rp, err := redpanda.Run(ctx, "redpandadata/redpanda:v24.2.10")
	if err != nil {
		t.Fatalf("start redpanda: %v", err)
	}
	t.Cleanup(func() { _ = rp.Terminate(context.Background()) })

	dbURL, err := pg.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Migrate(dbURL); err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	broker, err := rp.KafkaSeedBroker(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// The relay never creates topics; like redpanda-init in Compose, create it up front with 6 partitions.
	createTopic(ctx, t, broker, "inventory.events", 6)

	// Three state changes: create stock, change it, and expire a reservation.
	s := store.New(pool)
	if _, err := s.SetStock(ctx, "KAOS-001", 10, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetStock(ctx, "KAOS-001", 20, 1); err != nil {
		t.Fatal(err)
	}
	order := uuid.Must(uuid.NewV7()).String()
	req, _ := domain.NewLimits(100).NormalizeReserve(domain.ReserveRequest{OrderID: order, Lines: []domain.Line{{SKU: "KAOS-001", Quantity: 2}}})
	if _, err := s.Reserve(ctx, req); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE reservations SET expires_at = now() - interval '1 second' WHERE order_id = $1`, order); err != nil {
		t.Fatal(err)
	}
	if n, err := s.ExpireDue(ctx, 10); err != nil || n != 1 {
		t.Fatalf("ExpireDue = %d, %v", n, err)
	}

	pub, err := outbox.NewKafkaPublisher([]string{broker}, 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer pub.Close()
	relay := outbox.New(s, pub, "inventory.events", time.Second, 100, discard())
	if n, err := relay.RunOnce(ctx); err != nil || n != 3 {
		t.Fatalf("RunOnce = %d, %v; want 3", n, err)
	}
	if n, err := relay.RunOnce(ctx); err != nil || n != 0 {
		t.Fatalf("second RunOnce = %d, %v; want nothing left to publish", n, err)
	}

	records := consume(ctx, t, broker, "inventory.events", 3)

	type envelope struct {
		Type    string `json:"type"`
		Subject string `json:"subject"`
		Data    struct {
			OnHand int64 `json:"onHand"`
		} `json:"data"`
	}
	var stock []int64
	for _, r := range records {
		var env envelope
		if err := json.Unmarshal(r.Value, &env); err != nil {
			t.Fatal(err)
		}
		schematest.Validate(t, env.Type, r.Value)
		if string(r.Key) != env.Subject {
			t.Errorf("record key %q, want the subject %q", r.Key, env.Subject)
		}
		headers := map[string]string{}
		for _, h := range r.Headers {
			headers[h.Key] = string(h.Value)
		}
		if headers["ce_type"] != env.Type {
			t.Errorf("ce_type header %q, want %q", headers["ce_type"], env.Type)
		}
		if env.Type == "inventory.stock.adjusted" {
			stock = append(stock, env.Data.OnHand)
		}
	}
	if len(stock) != 2 || stock[0] != 10 || stock[1] != 20 {
		t.Errorf("stock events %v, want [10 20] in order on the SKU's partition", stock)
	}

	// Nothing more arrives: each change was published exactly once.
	if extra := consume(ctx, t, broker, "inventory.events", 4); len(extra) != 3 {
		t.Errorf("topic holds %d records, want exactly 3", len(extra))
	}
}

func createTopic(ctx context.Context, t *testing.T, broker, topic string, partitions int32) {
	t.Helper()
	cl, err := kgo.NewClient(kgo.SeedBrokers(broker))
	if err != nil {
		t.Fatal(err)
	}
	defer cl.Close()
	req := kmsg.NewPtrCreateTopicsRequest()
	rt := kmsg.NewCreateTopicsRequestTopic()
	rt.Topic, rt.NumPartitions, rt.ReplicationFactor = topic, partitions, 1
	req.Topics = append(req.Topics, rt)
	resp, err := req.RequestWith(ctx, cl)
	if err != nil {
		t.Fatalf("create topic %s: %v", topic, err)
	}
	if err := kerr.ErrorForCode(resp.Topics[0].ErrorCode); err != nil {
		t.Fatalf("create topic %s: %v", topic, err)
	}
}

// consume reads the topic from the start until it has want records or a few seconds pass.
func consume(ctx context.Context, t *testing.T, broker, topic string, want int) []*kgo.Record {
	t.Helper()
	cl, err := kgo.NewClient(kgo.SeedBrokers(broker), kgo.ConsumeTopics(topic), kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()))
	if err != nil {
		t.Fatal(err)
	}
	defer cl.Close()

	var records []*kgo.Record
	deadline := time.Now().Add(5 * time.Second)
	for len(records) < want && time.Now().Before(deadline) {
		pollCtx, cancel := context.WithTimeout(ctx, time.Second)
		fetches := cl.PollFetches(pollCtx)
		cancel()
		fetches.EachRecord(func(r *kgo.Record) { records = append(records, r) })
	}
	return records
}
