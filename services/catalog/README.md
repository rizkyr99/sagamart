# Catalog + Cart service

NestJS 12 service for what Sagamart sells (products, SKUs, categories, prices) and what buyers intend to buy (carts). Two bounded contexts in one deployable, with separate stores: Postgres for the catalog, DynamoDB for carts. Design: [RFC-0005](../../docs/rfc/0005-catalog-cart-gateway.md), [ADR-0007](../../docs/adr/0007-cart-in-dynamodb.md), [ADR-0009](../../docs/adr/0009-cart-as-single-item.md). Contract: [`catalog-internal-v1.yaml`](../../contracts/openapi/catalog-internal-v1.yaml).

> **Status:** skeleton. Products and listing (#28) and carts (#29) come next. It has no business routes yet.

## Run it

```bash
make up                      # repo root: Postgres, DynamoDB Local, observability
make identity-keys           # once: local keys for x-sagamart-identity
pnpm install
cp services/catalog/.env.example services/catalog/.env   # paste IDENTITY_PUBLIC_KEYS from deploy/compose/.env
pnpm --filter @sagamart/catalog build
cd services/catalog && set -a && . ./.env && set +a && pnpm start
```

Or with everything else: `make demo` from the repo root.

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | Process alive |
| `GET /readyz` | Postgres and DynamoDB reachable within 1 s each, else `503` Problem Details |
| `GET /metrics` | Prometheus metrics from OpenTelemetry (HTTP server metrics, identity rejections) |
| `/internal/v1/*` | Internal API for the gateway. Every request needs a valid `x-sagamart-identity` (verified before routing, so unknown internal paths are `401` too); `@Roles('admin')` routes also need the role. |

Errors are always RFC 9457 Problem Details (`application/problem+json`) with a stable `code` and the request's `traceId`. Unexpected errors are logged and returned as `500 INTERNAL_ERROR` without their details.

## Configuration

Validated at startup with zod; every problem is reported in one JSON log line, then the process exits.

| Variable | Default | Notes |
|---|---|---|
| `CATALOG_DB_URL` | — (required) | `postgres://user:pass@host:port/catalog` |
| `CATALOG_IDENTITY_PUBLIC_KEYS` | — (required) | JSON `{"<kid>": "<SPKI DER, base64>"}` of trusted gateway keys |
| `CATALOG_ENV` | `local` | `local`, `test` or `prod` |
| `CATALOG_HTTP_PORT` | `8120` | |
| `CATALOG_LOG_LEVEL` | `info` | pino levels |
| `CATALOG_MIGRATE_ON_START` | `true` in local/test | Deployments run migrations as a separate step |
| `CATALOG_DYNAMODB_ENDPOINT` | AWS | `http://localhost:8001` for DynamoDB Local (dummy credentials are used then) |
| `CATALOG_DYNAMODB_REGION` | `ap-southeast-3` | Jakarta |
| `CATALOG_CARTS_TABLE` | `carts` | |
| `CATALOG_DYNAMODB_CREATE_TABLE` | `true` in local/test | Creates the table with TTL on `ttl`; real environments use infrastructure code |
| `CATALOG_VERSION` | `dev` | |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | empty | Trace export; spans are created either way, so logs carry trace IDs |

## How it starts

`node --import ./dist/instrument.js dist/main.js`. The service is an ES module (NestJS 12 is ESM). `instrument.ts` registers OpenTelemetry's ESM loader hook and starts telemetry **before** the app loads, so HTTP, Express, `pg` and the AWS SDK are traced. On SIGTERM, Nest closes the server and connections, then telemetry flushes, then `shutdown complete` is logged.

## Layout

| Path | Contents |
|---|---|
| `src/instrument.ts`, `src/main.ts` | Telemetry first, then bootstrap |
| `src/app.module.ts` | Module wiring: logging, TypeORM, DynamoDB, identity, roles |
| `src/config.ts` | Environment configuration |
| `src/identity.ts` | `IdentityMiddleware` (every `/internal` request), `RolesGuard`, `@Roles`, `identityOf` |
| `src/problem.filter.ts` | Every error as Problem Details |
| `src/health.controller.ts` | Probes and metrics |
| `src/dynamo.ts` | DynamoDB client and carts-table setup |
| `src/migrations/` | Forward-only TypeORM migrations |

## Tests

```bash
pnpm --filter @sagamart/catalog test   # needs Docker: Testcontainers Postgres and DynamoDB Local
```

The integration suite boots the real module against real containers and checks the migrations (including the `active_has_price` constraint), the carts table and its TTL, probes, metrics, the identity rules (missing, garbage, wrong audience, expired, unknown internal path, roles), and that errors are Problem Details without leaking internals.
