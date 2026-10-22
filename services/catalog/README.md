# Catalog + Cart service

NestJS 12 service for what Sagamart sells (products, SKUs, categories, prices) and what buyers intend to buy (carts). Two bounded contexts in one deployable, with separate stores: Postgres for the catalog, DynamoDB for carts. Design: [RFC-0005](../../docs/rfc/0005-catalog-cart-gateway.md), [ADR-0007](../../docs/adr/0007-cart-in-dynamodb.md), [ADR-0009](../../docs/adr/0009-cart-as-single-item.md). Contract: [`catalog-internal-v1.yaml`](../../contracts/openapi/catalog-internal-v1.yaml).

> **Status:** browsing and price lookups work. Admin writes (the rest of #28) and carts (#29) come next.

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
| `GET /internal/v1/categories` | Every category, flat, by `position` |
| `GET /internal/v1/products` | Active products: `sort` (`newest`, `price_asc`, `price_desc`), `category` (includes subcategories), `minPrice`, `maxPrice`, `limit`, `cursor` |
| `GET /internal/v1/products/{slug}` | An active product with its active SKUs and prices; `404` otherwise |
| `POST /internal/v1/skus:lookup` | Names, prices and status of up to 100 SKUs, in the order asked; unknown SKUs are left out |

**Listing cursors** use keyset pagination on (`created_at`, `id`) or (`min_price`, `id`), so a page boundary never skips or repeats a product while others are added. The cursor carries `created_at` as text with Postgres's microseconds: a JavaScript `Date` would round to milliseconds and lose rows created in the same millisecond. It also carries a fingerprint of the sort and filters (not `limit`), so reusing it with another query is `400 CURSOR_MISMATCH`; a cursor that isn't ours is `400 VALIDATION_FAILED`.

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
| `src/catalog/` | The Catalog context: `cursor.ts` and `listing-query.ts` (pure, unit-tested), `catalog.queries.ts` (SQL), `catalog.controller.ts` |
| `src/validation.ts` | zod parsing that fails as `400 VALIDATION_FAILED` with one `errors[]` entry per field |
| `src/testing/` | Test support, not built: the Testcontainers harness and the contract checker |
| `src/migrations/` | Forward-only TypeORM migrations |

## Tests

```bash
pnpm --filter @sagamart/catalog test   # needs Docker: Testcontainers Postgres and DynamoDB Local
```

The integration suite boots the real module against real containers and checks the migrations (including the `active_has_price` constraint), the carts table and its TTL, probes, metrics, the identity rules (missing, garbage, wrong audience, expired, unknown internal path, roles), and that errors are Problem Details without leaking internals.

The Catalog suite seeds Postgres directly and checks every response body against `catalog-internal-v1.yaml` (`src/testing/contract.ts` bundles the spec with Redocly and validates with Ajv): sort orders and filters across page boundaries, ties and same-millisecond timestamps, cursors staying stable while products are added, cursor mismatch, subcategories, hidden drafts and archived SKUs, and `skus:lookup` limits.
