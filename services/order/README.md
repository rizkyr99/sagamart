# Order service

Java service that owns orders and runs the checkout saga: it reserves stock, takes payment and confirms or cancels, so that an order is never lost and never charged twice. Design: [RFC-0002](../../docs/rfc/0002-checkout-saga.md). Contract: [`sagamart.order.v1`](../../contracts/proto/sagamart/order/v1/order.proto).

> **Status:** skeleton (#58), the saga state machine (#59), saga persistence and the saga runner (#60, parts 1 and 2 of 4). The runner drives any stored saga through Inventory and Payment, but nothing creates orders yet: every `OrderService` RPC answers `UNIMPLEMENTED`. Next in #60: `CreateOrder` and the payment-deadline scan.

## Run it

Needs Java 25 only: `./mvnw` downloads Maven.

```bash
make up                       # from the repo root: Postgres, Redpanda, observability
cd services/order
cp .env.example .env
make run                      # migrations apply on start in local
```

Or run the built image with everything else: `make demo` from the repo root.

| Endpoint | Address |
|---|---|
| gRPC (`OrderService`, `grpc.health.v1.Health`, reflection outside prod) | `localhost:9140` |
| Liveness / readiness / metrics | `http://localhost:8140/healthz`, `/readyz` (checks the database), `/metrics` |

```bash
grpcurl -plaintext localhost:9140 list
grpcurl -plaintext localhost:9140 grpc.health.v1.Health/Check
```

No grpcurl? `docker run --rm --network host fullstorydev/grpcurl:v1.9.3 -plaintext localhost:9140 list`.

## Configuration

Environment variables, bound to `OrderProperties` and validated at startup: a missing or malformed value stops the service with the variable's name (conventions §10). See [.env.example](.env.example).

| Variable | Notes |
|---|---|
| `ORDER_ENV` | `local`, `test` or `prod`; also the Spring profile, so `prod` loads `application-prod.yaml` |
| `ORDER_DB_URL`, `ORDER_DB_USER`, `ORDER_DB_PASSWORD` | `jdbc:postgresql://` URL; the password is never logged |
| `ORDER_VERSION` | defaults to the pom version; shown in every log line and in traces |
| `ORDER_MIGRATE_ON_START` | defaults to `true`, and to `false` in prod, where migrations are a deployment step (conventions §9) |
| `ORDER_HTTP_PORT`, `ORDER_GRPC_PORT` | default `8140` and `9140` |
| `ORDER_INVENTORY_ADDR`, `ORDER_PAYMENT_ADDR` | `host:port` of Inventory's and Payment's gRPC (plaintext in Compose: `inventory:9110`, `payment:9150`) |
| `ORDER_SAGA_POLL_INTERVAL`, `ORDER_SAGA_LEASE`, `ORDER_SAGA_BATCH_SIZE` | the runner: default `1s`, `30s` and `32` (RFC-0002 §4.7) |
| `ORDER_SAGA_FORWARD_RETRIES`, `ORDER_SAGA_RETRY_BASE`, `ORDER_SAGA_RETRY_MAX`, `ORDER_SAGA_COMPENSATION_BUDGET` | retries: default `3`, `1s`, `30s` and `15m` (RFC-0002 §4.6) |
| `ORDER_LOG_LEVEL`, `ORDER_SHUTDOWN_TIMEOUT` | default `info` and `15s` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP over gRPC, default `http://localhost:4317` |

## Observability

- **Logs:** one JSON object per line with the conventions §7 fields (`ts`, `level`, `service`, `env`, `version`, `msg`, `trace_id`, `span_id`), written by `OrderLogFormatter`. Add domain IDs as fields with SLF4J's fluent API: `log.atInfo().addKeyValue("order_id", id).log("order confirmed")`.
- **Traces:** every gRPC call and HTTP request is a span, exported over OTLP. Probes and scrapes (`/healthz`, `/readyz`, `/metrics`) are not observed, so they neither bury real traces nor skew request metrics.
- **Metrics:** Prometheus at `/metrics`: `grpc_server_*` and `http_server_requests_seconds` histograms, JVM, and the `hikaricp_*` pool. The runner adds `sagamart_order_saga_step_duration_seconds{step,outcome}` and `sagamart_order_saga_transitions_total{from,to}`; the remaining saga metrics (RFC-0002 §6) come with the scan and the queries.

## The saga state machine

[`dev.sagamart.order.saga`](src/main/java/dev/sagamart/order/saga) is RFC-0002 §4.4 as code: `Saga.apply(SagaState, SagaEvent)` returns a `Transition` (the next state, and the `order.*` events to publish). It is pure: no I/O and no clock. The runner and the consumers (#60, #64) persist and apply it.

- **States** are sealed records that carry only what their rules need. For example, `Cancelling` knows whether an intent may exist and whether it was voided. Each state derives its `pendingCommand()`, so a state and its next call are persisted together.
- **Unlisted events change nothing.** An event the table doesn't list for a state (a duplicate, a late result, an event overtaken by another) returns `applied = false`, and the saga stays as it was.
- **Tests:**
  - `SagaTransitionTableTest` holds the table as data: one test per row, plus a check that every other (state, event) pair is ignored, so code and table can't drift.
  - `SagaPropertiesTest` (jqwik) drives a model of Inventory, Payment, the buyer and a redelivering, reordering event bus with random moves. It asserts that every history ends terminal or `NEEDS_ATTENTION`, never confirms without a commit, never ends `CANCELLED` holding money or stock or having sold the stock, never asks Inventory to release a committed reservation, and announces each outcome once.

## Schema

[`V1__create_order_schema.sql`](src/main/resources/db/migration/V1__create_order_schema.sql) is RFC-0002 §4.3: `orders`, `order_lines`, `sagas`, `saga_steps`, `processed_events` (the inbox), `idempotency_keys` and `outbox`. [`V2`](src/main/resources/db/migration/V2__saga_state_detail.sql) adds `sagas.state_detail`. Migrations are forward-only: fix forward with a new `V<n>__...sql`, never edit a merged one.

## Persistence

[`SagaStore`](src/main/java/dev/sagamart/order/store/SagaStore.java) applies the state machine to stored sagas (RFC-0002 §4.7):

- **One transaction per write.** The new state, its pending command, its `saga_steps` row and its `order.*` outbox events commit together or not at all.
- **One writer per saga.** Applying an event locks the saga row (`FOR UPDATE`). A command's result goes through `applyIfVersion`, and a result for an older version is discarded as `Stale` and recorded in history.
- **States read back as written.** [`SagaColumns`](src/main/java/dev/sagamart/order/store/SagaColumns.java) is the only mapping: the stage in `state`, the expiries in their own columns for the scans, and the rest in `state_detail`. `cancel_published` and the order's status, cancel reason and payment URL follow from the state. Times are kept to the microsecond, truncated.
- **Every outcome is in history** except an event for an unknown order: applied, ignored (`{"applied": false}`) and stale (`{"discarded": "stale"}`).
- **`order.cancelled` once.** A transition that would announce a second cancellation is refused, and nothing is written.
- **Every call is in history** (`kind = COMMAND`): its attempt, outcome (`OK`, `RETRYABLE_ERROR`, `FAILED`) and the error's code, written in the same transaction as its result.
- **Events match the contracts and carry no personal data.** `SagaStoreTest` validates every emitted event against `contracts/events`. The shipping address is stored, never published, and `NewOrder` prints it redacted.

## The runner

[`SagaRunner`](src/main/java/dev/sagamart/order/runner/SagaRunner.java) makes the calls (RFC-0002 §4.6, §4.7). Every second it:

1. **Claims** up to 32 due sagas (`FOR UPDATE SKIP LOCKED`) and leases them for 30 s, longer than any call's deadline. A crashed runner's lease runs out and the saga is due again.
2. **Calls** Inventory or Payment for each, concurrently, with the RFC's deadlines (2 s Inventory, 3 s Payment, 5 s refunds). [`GrpcStepExecutor`](src/main/java/dev/sagamart/order/runner/GrpcStepExecutor.java) turns the answer into a saga event. A domain error the saga has a row for is an answer: `INSUFFICIENT_STOCK`, `RESERVATION_NOT_FOUND`, `ALREADY_CAPTURED`; nothing to void or release counts as done.
3. **Applies** the result at the version the call was made for; a saga that moved on meanwhile discards it.

Failures follow [`RetryPolicy`](src/main/java/dev/sagamart/order/runner/RetryPolicy.java):

| Command | Retryable (`UNAVAILABLE`, deadline, overloaded) | Not retryable (bad request, refused identity, broken invariant) |
|---|---|---|
| `ReserveStock`, `CreatePaymentIntent` | 3 retries after 1, 2, 4 s (±20%), then the saga cancels | the saga cancels at once |
| `CommitReservation`, and the compensations: `VoidPaymentIntent`, `ReleaseReservation`, `RefundPayment` | backoff doubling to 30 s, for 15 min from when the command became pending (`sagas.pending_since`), then `NEEDS_ATTENTION` | `NEEDS_ATTENTION` at once |

## Develop

| Command | Does |
|---|---|
| `make test` | unit and integration tests (Testcontainers Postgres; needs Docker) |
| `make lint` | Spotless (google-java-format) and Checkstyle |
| `make format` | applies google-java-format |
| `make verify` | everything CI runs |

- Java for `contracts/proto` is generated at build time into `target/generated-sources`, never committed.
- Constructor injection only: Checkstyle rejects `@Autowired`, and tests get constructor injection from `junit-platform.properties`.
- google-java-format is pinned to 1.36.1: 1.37.0 fails inside Spotless 3.10.4.
