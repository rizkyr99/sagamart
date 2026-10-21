# Architecture Decision Records

One file per decision, numbered in order. Accepted ADRs are never edited except to update their status; a change of mind is a new ADR that supersedes the old one. Start from the [template](0000-template.md).

| ADR | Decision | Status | Date |
|---|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions as ADRs | Accepted | 2026-10-21 |
| [0002](0002-polyglot-service-languages.md) | Choose a language per service by its workload | Accepted | 2026-10-21 |
| [0003](0003-redpanda-as-event-broker.md) | Use Redpanda (Kafka API) as the event broker | Accepted | 2026-10-21 |
| [0004](0004-database-per-service.md) | Each service owns its database | Accepted | 2026-10-21 |
| [0005](0005-orchestrated-checkout-saga.md) | Coordinate checkout with an orchestrated saga | Accepted | 2026-10-21 |
| [0006](0006-transactional-outbox.md) | Publish events through a transactional outbox | Accepted | 2026-10-21 |
| [0007](0007-cart-in-dynamodb.md) | Store carts in DynamoDB | Accepted | 2026-10-21 |

## Planned ADRs

| Topic | Expected before or during |
|---|---|
| Inventory reservation strategy (conditional UPDATE vs row lock vs Redis Lua), decided by benchmark | Stage 1, First slice |
| gRPC for internal commands vs REST | Stage 2, Checkout saga |
| Payment ledger design (double-entry, append-only) | Stage 2, Checkout saga |
| SSE vs WebSocket for live order status | Stage 3, Events |
| Search engine: Meilisearch vs OpenSearch | Stage 5, Complete |
| Identity provider: Casdoor vs Keycloak | Stage 5, Complete |
