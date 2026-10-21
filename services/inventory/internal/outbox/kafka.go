package outbox

import (
	"context"
	"fmt"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

// KafkaPublisher publishes with franz-go. The producer is idempotent (franz-go's default), so retries inside the
// client don't duplicate or reorder records within a partition.
type KafkaPublisher struct {
	client *kgo.Client
}

// NewKafkaPublisher connects to brokers. Each record must be acknowledged within deliveryTimeout.
func NewKafkaPublisher(brokers []string, deliveryTimeout time.Duration) (*KafkaPublisher, error) {
	client, err := kgo.NewClient(
		kgo.SeedBrokers(brokers...),
		kgo.RequiredAcks(kgo.AllISRAcks()),
		kgo.RecordDeliveryTimeout(deliveryTimeout),
		kgo.ProducerLinger(0), // the relay already batches; don't add latency
	)
	if err != nil {
		return nil, fmt.Errorf("create Kafka client: %w", err)
	}
	return &KafkaPublisher{client: client}, nil
}

// Publish produces msgs to topic and waits until every one is acknowledged.
func (p *KafkaPublisher) Publish(ctx context.Context, topic string, msgs []Message) error {
	records := make([]*kgo.Record, len(msgs))
	for i, m := range msgs {
		headers := make([]kgo.RecordHeader, 0, len(m.Headers))
		for k, v := range m.Headers {
			headers = append(headers, kgo.RecordHeader{Key: k, Value: []byte(v)})
		}
		records[i] = &kgo.Record{Topic: topic, Key: []byte(m.Key), Value: m.Value, Headers: headers}
	}
	if err := p.client.ProduceSync(ctx, records...).FirstErr(); err != nil {
		return fmt.Errorf("publish to %s: %w", topic, err)
	}
	return nil
}

// Close closes the client.
func (p *KafkaPublisher) Close() { p.client.Close() }
