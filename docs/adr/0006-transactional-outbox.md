# ADR-0006: Publish events through a transactional outbox with a polling relay

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-21 |
| **Deciders** | Rizky |

## Context

When a service changes state and publishes an event, two systems are involved: its database and the broker. Writing to both directly ("dual write") can leave them inconsistent: the database commits but the publish fails, or the publish succeeds but the transaction rolls back. Either case loses or invents events, which breaks the saga and the read models.

## Options considered

### Option A — Dual write
Write to the database, then publish.
- **Cons:** inconsistent on crash between the two steps. Rejected.

### Option B — Outbox with polling relay
Write the event into an `outbox` table in the same transaction as the state change. A relay process polls unpublished rows (`FOR UPDATE SKIP LOCKED`, in batches), publishes them, and marks them published.
- **Pros:** simple, no extra infrastructure, easy to reason about and test.
- **Cons:** polling adds latency (tens to hundreds of ms) and load on the database.

### Option C — Outbox with CDC (Debezium)
Stream the outbox table from the database log.
- **Pros:** lower latency, no polling load.
- **Cons:** extra infrastructure (Kafka Connect, Debezium), more to operate locally.

## Decision

We will use the transactional outbox with a polling relay (Option B) in every service that publishes events. The relay runs inside each service process as a background worker.

Outbox row: `id (UUIDv7), aggregate_type, aggregate_id, event_type, payload (jsonb), headers (jsonb), created_at, published_at`.

## Consequences

- **Positive:** atomic state change + event; no lost events; works the same in Go, Java and NestJS.
- **Negative:** at-least-once publishing (a crash after publish but before marking can republish), so consumers must be idempotent. Polling interval trades latency for database load.
- **Follow-ups:** measure end-to-end event latency in the Scale release; outbox cleanup job (delete published rows after 7 days).

## Revisit when

Measured outbox latency threatens the order-status freshness target (2 s p95), or polling load becomes significant — then write a new ADR comparing Debezium CDC.
