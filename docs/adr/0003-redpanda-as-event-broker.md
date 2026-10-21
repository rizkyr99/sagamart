# ADR-0003: Use Redpanda (Kafka API) as the event broker

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-21 |
| **Deciders** | Rizky |

## Context

Services exchange domain events (order lifecycle, payments, catalog changes). Requirements:

- Per-aggregate ordering (all events for one order processed in order).
- Consumers can be down and catch up later; events can be replayed (e.g. to rebuild the search index).
- Multiple independent consumer groups per topic.
- Runs locally in one lightweight container.
- Widely recognised by industry and interviewers.

## Options considered

### Option A — RabbitMQ
- **Pros:** mature, flexible routing, simple per-message acknowledgement.
- **Cons:** queue-based, not a replayable log; ordering per key needs extra design; replays require re-publishing.

### Option B — NATS JetStream
- **Pros:** very light, simple, has persistence and replay.
- **Cons:** less common in large ecommerce stacks; smaller ecosystem of tooling and connectors.

### Option C — Apache Kafka
- **Pros:** industry standard log; partitions, consumer groups, replay.
- **Cons:** heavier to run locally (JVM, more memory).

### Option D — Redpanda
- **Pros:** Kafka-API compatible (same clients, same concepts), single binary, low memory, fast startup, built-in schema registry and console.
- **Cons:** smaller community than Kafka; some Kafka ecosystem tools behave slightly differently.

## Decision

We will use Redpanda. Services use standard Kafka client libraries (`franz-go` for Go, `kafkajs`/`@confluentinc/kafka-javascript` for NestJS, Spring Kafka for Java), so moving to Apache Kafka later is a configuration change.

Topics are one per context (`order.events`, `payment.events`, ...), keyed by aggregate ID.

## Consequences

- **Positive:** replayable log, per-key ordering, consumer groups; skills transfer directly to Kafka.
- **Negative:** at-least-once delivery means every consumer must be idempotent (see [conventions](../engineering/conventions.md#6-events)).
- **Follow-ups:** partition count per topic decided in the checkout saga RFC (RFC-0002); DLQ topics per consumer.

## Revisit when

A feature needs complex routing or per-message priorities that a log handles poorly.
