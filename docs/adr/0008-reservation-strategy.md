# ADR-0008: Reserve stock with a single conditional UPDATE in Postgres

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-21 |
| **Deciders** | Rizky |
| **Related** | [RFC-0001](../rfc/0001-inventory-reservation.md) §5 and §7, [benchmark report](../benchmarks/2026-10-21-reservation-strategies.md), issue [#11](https://github.com/rizkyr99/sagamart/issues/11) |

## Context

Inventory must never oversell (PRD FR-06), including in a flash sale where thousands of buyers race for a few units of one SKU (J6, target ≥ 2,000 reservation attempts/s on one laptop-class host). All buyers of a hot SKU contend for one stock row, so how a reservation takes stock decides both correctness and throughput. RFC-0001 proposed benchmarking three strategies before committing to one.

## Options considered

### Option A — Conditional UPDATE

One statement per line: `UPDATE stock_levels SET reserved = reserved + q WHERE sku = $1 AND on_hand - reserved >= q`. Postgres re-evaluates the condition against the latest committed row after waiting for the lock.

- **Measured:** correct in every run. 2,383 hot-SKU attempts/s (p50 152 ms) at 500 VUs; 744 steady reservations/s with the default pool.
- **Pros:** one round trip while holding the row lock; one source of truth; the `stock_never_oversold` check constraint backs it up.
- **Cons:** sold-out buyers still queue on the hot row in Postgres.

### Option B — Row lock, check in Go

`SELECT ... FOR UPDATE`, compare in Go, then `UPDATE`.

- **Measured:** correct in every run. 1,817 hot-SKU attempts/s (p50 218 ms); 682 steady reservations/s.
- **Pros:** the check is ordinary Go code.
- **Cons:** two round trips under the lock; slower than A everywhere, with no correctness advantage.

### Option C — Redis Lua fast path

A Lua script checks and decrements availability in Redis atomically; only successful reservations go on to Postgres.

- **Measured:** correct in every run. 5,892 hot-SKU attempts/s (p50 41 ms). But only 616 steady reservations/s, the slowest, and a higher p99 for the buyers who *did* get stock (719 ms vs A's 477 ms).
- **Pros:** sold-out answers never touch Postgres.
- **Cons:** a second source of truth for stock. Every other state change (commit, release, expiry, admin edits) must update it too, plus reconciliation after crashes and a Redis durability policy. Every successful reservation costs an extra round trip.

## Decision

We will keep **Option A**, the single conditional UPDATE, as Inventory's reservation strategy. Strategies B and C stay on the unmerged [`bench/reservation-strategies`](https://github.com/rizkyr99/sagamart/tree/bench/reservation-strategies) branch.

A is the simplest correct option. It meets the flash-sale target on this hardware and is the fastest strategy for the reservations that actually succeed. C's advantage is limited to answering sold-out attempts quickly. That doesn't justify a second source of truth for stock, and cheaper ways to get the same effect exist.

## Consequences

- **Positive:** Postgres remains the only source of truth for stock; no new infrastructure on the reservation path; nothing in `main` changes.
- **Negative:** in a flash sale, sold-out attempts still queue in Postgres behind the hot row. With 5,000 simultaneous new connections on one laptop, p50 was ≈2.6 s for every Postgres strategy.
- **Follow-ups:**
  - Configurable pool size with pool metrics (#22): the steady-load ceiling moved from 744/s to 1,159/s with 32 connections.
  - Scale release (RFC-0004): the in-process sold-out cache from RFC-0001 §7, multiple Inventory instances, and Postgres tuning, then re-run the same scripts.

## Revisit when

Flash-sale tests in the Scale release show sold-out rejections still dominating latency or Postgres load *after* the in-process sold-out cache. Or a hot SKU needs more throughput than one Postgres row can give, at which point compare sharded stock rows (splitting a SKU's units across N rows) against C.
