# Benchmarks

Load and flash-sale results. Each report records hardware, versions, method and raw numbers.

| Date | Report | Outcome |
|---|---|---|
| 2026-10-21 | [Inventory reservation strategies](2026-10-21-reservation-strategies.md) | All three strategies correct in every run; conditional UPDATE kept ([ADR-0008](../adr/0008-reservation-strategy.md)); flash-sale target met; steady-load ceiling tied to pool size (#22) |
| 2026-10-23 | [Browsing through the gateway](2026-10-23-browse.md) | Read-latency target missed: p99 0.9–1.0 s against 200 ms at 500 users, about 415 requests/s at most. Bottleneck is single-threaded gateway and Catalog; a third of gateway CPU is tracing. Stock showed `UNKNOWN` on about a quarter of pages under load. |
