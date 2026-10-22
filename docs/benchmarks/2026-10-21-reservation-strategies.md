# Benchmark: Inventory reservation strategies

| | |
|---|---|
| **Date** | 2026-10-21 |
| **Issue** | [#11](https://github.com/rizkyr99/sagamart/issues/11) |
| **Decision** | [ADR-0008](../adr/0008-reservation-strategy.md) |
| **Code measured** | [`bench/reservation-strategies`](https://github.com/rizkyr99/sagamart/tree/bench/reservation-strategies) at `0452ac1` (throwaway branch, never merged) |
| **Raw results** | [`raw/`](2026-10-21-reservation-strategies/raw/): k6 summary JSON, invariant checks, CPU samples |

## Question

Which way of taking stock should Inventory use, given that correctness is not negotiable and a flash sale is the hardest case? RFC-0001 §5 proposed three strategies:

| | Strategy | How a line is reserved |
|---|---|---|
| **A** | Conditional UPDATE (current `main`) | `UPDATE stock_levels SET reserved = reserved + q WHERE sku = $1 AND on_hand - reserved >= q` |
| **B** | Row lock | `SELECT ... FOR UPDATE`, check in Go, then `UPDATE` |
| **C** | Redis Lua fast path | A Lua script checks and decrements every line's availability in Redis, atomically. Only on success does the reservation go to Postgres (using A's update as a safety net). Shortfalls are answered from Redis alone. |

Everything else is identical: the same transaction structure (claim the order, lines in SKU order, all or nothing), the same gRPC API, the same container.

## Result in one paragraph

**Every strategy was correct in every run**: exactly 100 of 100 units sold in all 18 flash-sale runs, and the database invariants held after all 21 runs. On a hot SKU, **C was fastest by far** (≈5,900 attempts/s, p50 41 ms) because sold-out buyers never reach Postgres. **A met the PRD's flash-sale target** (≈2,400 attempts/s; target ≥ 2,000), and **B was slowest** of the Postgres strategies, as RFC-0001 predicted. Under steady multi-SKU load **A was fastest and C slowest**: every successful reservation still has to commit in Postgres, so C's extra Redis round trip is pure cost there. None of the strategies reached the requested 2,000 reservations/s of steady load on this laptop. A diagnostic run shows the default 12-connection pool was the main limit (744/s → 1,159/s with 32 connections, #22).

## Environment

| | |
|---|---|
| Host | 13th Gen Intel Core i7-1355U (2 performance + 8 efficiency cores, 12 threads), 30 GB RAM, about 5 GB free during the runs |
| OS | Linux 6.8.0-90 (elementary OS 7.1), Docker 29.1.3 |
| Inventory | Go 1.27.3, the `make demo` container, no CPU or memory limits. pgx pool at its default of max(4, NumCPU) = **12 connections**. Expiry worker and outbox relay running. |
| Postgres | 17.2-alpine, Compose defaults: `shared_buffers=128MB`, `max_connections=100`, `synchronous_commit=on`, READ COMMITTED |
| Redis | 7.4.1-alpine (used by strategy C only) |
| Load generator | k6 1.8.2 (`grafana/k6:1.8.2`), on the **same host** over loopback (`--network host`), calling Inventory's gRPC API directly |

Everything shares one laptop, k6 included, so absolute numbers are a floor for this hardware, not a capacity figure. The comparison between strategies is what this benchmark is for: same host, same settings, same scripts, same day.

## Method

Scripts are in [`deploy/k6`](../../deploy/k6/). The bench branch's `run-strategy-matrix.sh` recreated the Inventory container with each strategy in turn and, **before every run**, emptied Inventory's tables (`reset-inventory.sh`). After every run it checked the invariants (`check-inventory.sql`): nothing oversold, `reserved` equal to what active reservations hold, and one reservation per order.

| Scenario | Shape | Repeats |
|---|---|---|
| **hot-5000** | 5,000 VUs, 1 attempt each, for 100 units of one SKU: the issue's scenario as written | 3 per strategy |
| **hot-500** | 500 VUs, 10 attempts each (5,000 attempts in total), for 100 units of one SKU | 3 per strategy |
| **spread** | `constant-arrival-rate` of 2,000 reservations/s for 60 s; each has 2–3 random SKUs (1–3 units) out of 1,000 SKUs with 1,000,000 units each, so stock never runs out | 1 per strategy |

**Why two hot-SKU shapes.** At 5,000 VUs, each VU opens its own gRPC connection at the same moment, and k6 itself competes with the service for the same 12 threads. Latency there is dominated by the connection storm on one machine: p50 rose from ≈150 ms at 500 VUs to ≈2.6 s at 5,000 VUs for the *same* strategy. The 500-VU shape keeps the same 5,000-attempt race and heavy contention on one row, but measures the reservation path rather than connection setup. Both are reported. k6 used ≈1.7 GB at 5,000 VUs, which fit within the free memory.

Hot-SKU tables show the median of three runs, choosing the run with the median p99; ranges cover all three. Latency is k6's `grpc_req_duration`.

## Results

### Correctness

| Strategy | Hot-SKU runs with exactly 100 sold | Runs with unexpected errors | Invariant checks passed |
|---|---|---|---|
| A | 6 of 6 | 0 | 7 of 7 |
| B | 6 of 6 | 0 | 7 of 7 |
| C | 6 of 6 | 0 | 7 of 7 |

Every attempt that didn't get stock received `FAILED_PRECONDITION` / `INSUFFICIENT_STOCK`; nothing else failed. The pool-size diagnostic below also passed its invariant check.

### Hot SKU: 500 VUs × 10 attempts for 100 units

| Strategy | Attempts/s, median (range) | p50 ms | p99 ms | p99 of the 100 sold, ms | p50 / p99 sold out, ms |
|---|---|---|---|---|---|
| A. Conditional UPDATE | **2,383** (1,824–2,646) | 152 | 502 | 477 | 151 / 502 |
| B. Row lock | 1,817 (1,692–1,817) | 218 | 573 | 407 | 218 / 573 |
| C. Redis Lua | **5,892** (4,895–5,892) | **41** | 400 | 719 | **40 / 145** |

### Hot SKU: 5,000 VUs × 1 attempt for 100 units

| Strategy | Attempts/s, median (range) | p50 ms | p99 ms | p99 of the 100 sold, ms | p50 / p99 sold out, ms |
|---|---|---|---|---|---|
| A. Conditional UPDATE | 1,105 (859–1,229) | 2,638 | 3,295 | 1,762 | 2,656 / 3,298 |
| B. Row lock | 1,030 (789–1,030) | 2,676 | 4,055 | 2,192 | 2,697 / 4,055 |
| C. Redis Lua | 1,876 (1,811–2,365) | 706 | 1,430 | 2,120 | 703 / 1,331 |

### Spread: 2,000 reservations/s requested for 60 s

| Strategy | Achieved/s | Reserved | Not started (dropped) | Failed | p50 ms | p90 ms | p99 ms | Mean CPU inventory / Postgres / Redis |
|---|---|---|---|---|---|---|---|---|
| A. Conditional UPDATE | **744** | 49,020 | 70,978 | 0 | 1,121 | 1,796 | 2,378 | 198% / 493% / 2% |
| B. Row lock | 682 | 44,963 | 75,038 | 0 | 1,238 | 1,854 | 2,284 | 196% / 487% / 3% |
| C. Redis Lua | 616 | 40,594 | 79,407 | 0 | 1,472 | 2,105 | 2,238 | 156% / 569% / 14% |
| *A with a 32-connection pool (diagnostic)* | *1,159* | *76,786* | *43,217* | *0* | *681* | — | *1,674* | *247% / 291% / 2%* |

"Not started" counts iterations k6 could not begin because every VU was busy waiting on the service. The service fell behind the arrival rate; requests did not fail. CPU is the mean of `docker stats` samples taken during the run (100% = one thread). CPU for the hot-SKU runs is omitted: those runs last about 2 seconds, too short for the sampler to measure reliably.

## Analysis

1. **Correctness doesn't separate the strategies.** All three are safe as implemented. For A and B, the `stock_never_oversold` constraint stands behind the row-level check. For C, the Lua script checks and decrements in one atomic step, with A's update behind it.
2. **A beats B, as RFC-0001 §5 predicted.** B holds the row lock across two round trips (`SELECT ... FOR UPDATE`, then `UPDATE`), so on a hot row each buyer waits longer for the one before. A's single statement re-checks availability after the lock wait and needs one round trip. A was faster on every hot-SKU shape and under steady load.
3. **C wins only where Postgres can be skipped.** In a flash sale, 98% of attempts are sold out. C answers those from Redis in ≈40 ms instead of queueing them behind the hot row in Postgres. But every *successful* reservation still commits in Postgres, plus a Redis round trip. So in steady load, where every request succeeds, C was the slowest (616/s vs A's 744/s), and the 100 successful buyers in a flash sale waited *longer* than with A (p99 719 ms vs 477 ms).
4. **Steady load is limited by the connection pool and commits, not by locking strategy.** Postgres ran at ≈5 cores in every spread run. Raising the pool from 12 to 32 connections lifted A from 744/s to 1,159/s and cut p50 from 1.1 s to 0.68 s, with *less* Postgres CPU. That points to time spent queueing for a connection. Pool sizing (#22) and further tuning belong to the Scale release (RFC-0004). They don't change the choice of strategy.
5. **What C would cost in production.** The benchmark version keeps Redis in step only through admin stock changes and reservations. A real C would also need commit, release and expiry to update Redis, and reconciliation after crashes between the Redis decrement and the Postgres commit. That crash would under-sell, never over-sell. It would also need a decision on Redis durability. That is a second source of truth for the one number this system must never get wrong.

## Not measured

- **The in-process "sold out" cache** (RFC-0001 §7): a short-lived per-SKU flag that answers rejections without Postgres once a SKU hits zero. It targets the same thing C wins on, without a second store. It is the natural next step if hot-SKU rejection latency matters.
- **Multiple Inventory instances** and a tuned Postgres: Scale release.
- **The full checkout path** through the gateway and Order saga: these scripts call Inventory directly.

## Reproducing

```bash
git checkout bench/reservation-strategies
make demo
deploy/k6/run-strategy-matrix.sh bench-results/$(date +%F)     # about 10 minutes
python3 deploy/k6/summarize-reservations.py bench-results/$(date +%F)
```
