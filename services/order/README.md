# Order service

Java service that owns orders and runs the checkout saga: it reserves stock, takes payment and confirms or cancels, so that an order is never lost and never charged twice. Design: [RFC-0002](../../docs/rfc/0002-checkout-saga.md). Contract: [`sagamart.order.v1`](../../contracts/proto/sagamart/order/v1/order.proto).

> **Status:** skeleton (#58). The service starts, migrates its schema and serves health, metrics and gRPC, but every `OrderService` RPC answers `UNIMPLEMENTED`. Next: the saga state machine (#59), then persistence and the runner (#60).

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
| `ORDER_LOG_LEVEL`, `ORDER_SHUTDOWN_TIMEOUT` | default `info` and `15s` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP over gRPC, default `http://localhost:4317` |

## Observability

- **Logs:** one JSON object per line with the conventions §7 fields (`ts`, `level`, `service`, `env`, `version`, `msg`, `trace_id`, `span_id`), written by `OrderLogFormatter`. Add domain IDs as fields with SLF4J's fluent API: `log.atInfo().addKeyValue("order_id", id).log("order confirmed")`.
- **Traces:** every gRPC call and HTTP request is a span, exported over OTLP. Probes and scrapes (`/healthz`, `/readyz`, `/metrics`) are not observed, so they neither bury real traces nor skew request metrics.
- **Metrics:** Prometheus at `/metrics`: `grpc_server_*` and `http_server_requests_seconds` histograms, JVM, and the `hikaricp_*` pool. The saga metrics (RFC-0002 §6) arrive with the saga.

## Schema

[`V1__create_order_schema.sql`](src/main/resources/db/migration/V1__create_order_schema.sql) is RFC-0002 §4.3: `orders`, `order_lines`, `sagas`, `saga_steps`, `processed_events` (the inbox), `idempotency_keys` and `outbox`. Migrations are forward-only: fix forward with a new `V<n>__...sql`, never edit a merged one.

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
