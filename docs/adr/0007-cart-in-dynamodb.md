# ADR-0007: Store carts in DynamoDB (DynamoDB Local in development)

| | |
|---|---|
| **Status** | Accepted (item layout refined by [ADR-0009](0009-cart-as-single-item.md)) |
| **Date** | 2026-10-21 |
| **Deciders** | Rizky |

## Context

Carts are high-write, short-lived, accessed almost entirely by a single key (cart ID or user ID), and should expire after 7 days of inactivity. They don't need joins or cross-entity transactions. The project also aims to show judgement in choosing between relational and NoSQL stores.

## Options considered

### Option A — Postgres

- **Pros:** one less technology; strong consistency.
- **Cons:** TTL needs a cleanup job; write-heavy ephemeral data bloats tables and indexes.

### Option B — Redis

- **Pros:** very fast, native TTL.
- **Cons:** durability depends on persistence settings; losing carts on restart hurts conversion; memory cost grows with carts.

### Option C — DynamoDB

- **Pros:** key-value access pattern fits exactly; native TTL; durable; scales horizontally with predictable latency; pay-per-request in the cloud.
- **Cons:** another technology; query flexibility is limited to designed access patterns; local development uses DynamoDB Local, which differs slightly from the managed service.

## Decision

We will store carts in DynamoDB (DynamoDB Local in development), with a single-table design:

| PK | SK | Attributes |
|---|---|---|
| `CART#<cartId>` | `META` | `ownerId`, `updatedAt`, `ttl` |
| `CART#<cartId>` | `LINE#<sku>` | `quantity`, `priceSnapshot`, `addedAt` |

`ttl` is refreshed on every cart write. Guest-to-user merge is a conditional write.

## Consequences

- **Positive:** access pattern and expiry handled natively; demonstrates NoSQL data modelling.
- **Negative:** one more data store; access patterns must be designed up front.
- **Follow-ups:** document the access patterns in the Catalog + Cart service README; benchmark cart reads/writes in the Scale release.

## Revisit when

Cart features need relational queries (e.g. analytics across carts) — feed those through events into a separate read model rather than changing the cart store.
