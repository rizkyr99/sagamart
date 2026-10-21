# Inventory service

Go service that knows what can be sold and never sells more than that. It holds stock levels per SKU and time-limited reservations for checkout. Design: [RFC-0001](../../docs/rfc/0001-inventory-reservation.md). Contract: [`sagamart.inventory.v1`](../../contracts/proto/sagamart/inventory/v1/inventory.proto).

> **Status:** the gRPC API is live. The expiry worker and outbox relay (#10) follow; `SetStockLevel` is not yet restricted to admins (#17).

## Run it

```bash
make up                       # from the repo root: Postgres, Redpanda, observability
cd services/inventory
cp .env.example .env
make run                      # migrations apply on start in local
```

Or run the built image with everything else: `make demo` from the repo root.

| Endpoint | Address |
|---|---|
| gRPC (`InventoryService`, `grpc.health.v1.Health`, reflection outside prod) | `localhost:9110` |
| Liveness / readiness / metrics | `http://localhost:8110/healthz`, `/readyz`, `/metrics` |

```bash
S=sagamart.inventory.v1.InventoryService
grpcurl -plaintext -d '{"sku":"KAOS-001","onHand":5}' localhost:9110 $S/SetStockLevel
grpcurl -plaintext -d '{"orderId":"0199f2c0-0000-7000-8000-000000000001","lines":[{"sku":"KAOS-001","quantity":3}]}' localhost:9110 $S/ReserveStock
grpcurl -plaintext -d '{"orderId":"0199f2c0-0000-7000-8000-000000000001"}' localhost:9110 $S/CommitReservation
grpcurl -plaintext -d '{"skus":["KAOS-001"]}' localhost:9110 $S/GetStockLevels
```

Errors follow the contract: a status code plus a `google.rpc.ErrorInfo` (domain `inventory.sagamart.dev`, reason such as `INSUFFICIENT_STOCK`). `INSUFFICIENT_STOCK` also carries an `InsufficientStockDetail`, and invalid requests carry a `google.rpc.BadRequest` naming each field.

### Metrics

| Metric | Labels |
|---|---|
| `sagamart_inventory_reservations_total`, `sagamart_inventory_reservation_duration_seconds` | `result`: `reserved`, `insufficient_stock`, `conflict`, `invalid`, `error` |
| `sagamart_inventory_reservation_transitions_total` | `to`: `COMMITTED`, `RELEASED` (repeats are not counted) |
| `sagamart_inventory_constraint_violations_total` | `constraint`; above zero means a bug |
| `rpc_server_call_duration_seconds` (otelgrpc) | per method and status |

Every gRPC call is a span with a child span per database statement (otelpgx).

## Configuration

Environment variables, validated at startup; every problem is reported at once and the process exits.

| Variable | Default | Notes |
|---|---|---|
| `INVENTORY_DB_URL` | — (required) | `postgres://user:pass@host:port/inventory?sslmode=disable` |
| `INVENTORY_ENV` | `local` | `local`, `test` or `prod`; reflection is off in `prod` |
| `INVENTORY_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `INVENTORY_HTTP_ADDR` | `:8110` | Probes and metrics |
| `INVENTORY_GRPC_ADDR` | `:9110` | |
| `INVENTORY_MIGRATE_ON_START` | `true` in local/test, else `false` | Deployments run migrations as a separate step |
| `INVENTORY_MAX_LINE_QUANTITY` | `100` | Per-line sanity limit (RFC-0001 decision log) |
| `INVENTORY_SHUTDOWN_TIMEOUT` | `15s` | Time to drain in-flight calls on SIGTERM |
| `INVENTORY_VERSION` | build version | Overrides the version in logs and telemetry |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | empty | e.g. `http://localhost:4317`; empty disables trace export, but logs still carry trace IDs |

## Layout

| Path | Contents |
|---|---|
| `cmd/inventory` | Entry point: wiring, servers, graceful shutdown, `healthcheck` command |
| `internal/config` | Environment configuration |
| `internal/domain` | Pure reservation rules: request validation, the status transition table, stock arithmetic. No I/O |
| `internal/telemetry` | Logger (conventions §7), OpenTelemetry tracing and metrics |
| `internal/store` | Postgres pool, migrations and the reservation store: each command is one transaction using conditional updates and a fixed lock order |
| `internal/events` | Event envelopes written to the outbox; `schematest` validates them against `contracts/events` |
| `internal/grpcapi` | `InventoryService`: request mapping, error mapping to status codes and details, reservation metrics |
| `internal/server` | HTTP probes and metrics, gRPC server setup |
| `migrations` | Forward-only SQL migrations, embedded in the binary |

## Tests

```bash
make test        # unit + integration (Testcontainers Postgres; needs Docker), race detector on
make test-unit   # unit only
make lint
```

Key suites:

- `internal/domain`: the reservation transition table (`TestDecide`, one row per status, command and timing) and `TestInventoryNeverOversells`, a property-based test (`rapid`). It drives an in-memory model built from the domain rules through random reserve, commit, release, expire, stock-change and clock steps, and checks after every step that nothing is oversold, `reserved` matches the active reservations, and stock is conserved. Run it harder with `go test ./internal/domain -run NeverOversells -rapid.checks=20000`.
- `internal/grpcapi`: through a real gRPC connection (bufconn) against a fake store: requests are normalized before the store, every domain error maps to its code and reason, `INSUFFICIENT_STOCK` and `BadRequest` details arrive intact, internal errors are not leaked, and calls stop at the caller's deadline.
- `internal/store` (one shared Testcontainers Postgres; each test owns its SKUs and order IDs):
  - `TestConcurrentReservationsNeverOversell`: 1,000 concurrent buyers for 100 units, exactly 100 succeed.
  - `TestConcurrentMultiLineReservationsDontDeadlock`: 300 overlapping multi-line reservations sent in random line order.
  - Retries of every command are idempotent, including 20 concurrent retries of one order.
  - Strict expiry on commit; admin stock changes with optimistic versioning; exactly one schema-valid `inventory.stock.adjusted` outbox event per successful change.
  - The `stock_never_oversold` constraint rejects every form of oversell.
