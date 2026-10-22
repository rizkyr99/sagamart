# Catalog + Cart service

NestJS 12 service for what Sagamart sells (products, SKUs, categories, prices) and what buyers intend to buy (carts). Two bounded contexts in one deployable, with separate stores: Postgres for the catalog, DynamoDB for carts. Design: [RFC-0005](../../docs/rfc/0005-catalog-cart-gateway.md), [ADR-0007](../../docs/adr/0007-cart-in-dynamodb.md), [ADR-0009](../../docs/adr/0009-cart-as-single-item.md). Contract: [`catalog-internal-v1.yaml`](../../contracts/openapi/catalog-internal-v1.yaml).

> **Status:** complete for Stage 1: browsing, price lookups, admin writes and carts. The gateway (#30–#32) will put it behind the public API.

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
| `GET /internal/v1/carts/{cartKey}` | The cart with current prices, `priceChanged` per line and a total; a missing or expired cart is empty |
| `PUT /internal/v1/carts/{cartKey}/lines/{sku}` | Set a line's quantity (0 removes it); creates the cart on first write |
| `DELETE /internal/v1/carts/{cartKey}/lines/{sku}` | Remove a line |
| `/internal/v1/admin/*` | `admin` role. Create and edit categories, products and SKUs; list and read products in any status |

**Admin writes** follow three rules:

- **Edits need `If-Match`** with the version from the resource's `ETag`. Missing is `428`, stale is `412 VERSION_CONFLICT` with `currentVersion`, so a lost update can't happen.
- **Creates need `Idempotency-Key`**, enforced here in the same transaction as the write (RFC-0005 §4.4). The key row is claimed first. A concurrent duplicate waits on it and then gets the stored status, body and `ETag`. The same key with a different body is `422 IDEMPOTENCY_KEY_REUSED`, and a duplicate still waiting after the 2 s statement timeout gets `409 REQUEST_IN_PROGRESS`. A failed write leaves no record. Keys are per user and kept 24 hours; a sweep deletes older ones hourly.
- **`min_price` follows every SKU write** in the same transaction. Every SKU write locks its product row first, which serialises the 100-SKU limit and the price recompute and keeps one lock order. An active product always keeps an active SKU (`422 PRODUCT_NEEDS_ACTIVE_SKU`, backed by the `active_has_price` constraint). Category moves are serialised by an advisory lock so they can't form a cycle (`422 CATEGORY_CYCLE`).

**Carts** are one DynamoDB item each ([ADR-0009](../../docs/adr/0009-cart-as-single-item.md)). The access patterns:

| Operation | DynamoDB call |
|---|---|
| Read a cart | `GetItem` on `pk = CART#<cartKey>`, strongly consistent. An item past its `ttl` reads as empty: TTL deletion is lazy. |
| Change a cart | `GetItem`, apply the cart rules (`cart.ts`), then one `PutItem` conditional on the `version` read (`attribute_not_exists(pk)` for a new cart). On a lost race, read and re-apply, up to 6 attempts with jittered backoff, then `503`. |

- **Keys:** `user:<userId>`, usable only by that user (else `403`). A guest cart is `guest:<sha256 of the token>`: the hash is the capability, so a leaked table never exposes tokens.
- **Atomic limits:** the 50-line limit and the write are one conditional put, so racing adds can't overfill a cart.
- **Expiry:** every write sets one `ttl` (now + 7 days) on the whole item, so lines never expire separately.
- **Prices:** a line keeps the price from when it was added or its quantity last changed. Views show the current price from the Catalog module in the same process, with `priceChanged`. SKUs that are no longer for sale show `price: null` and stay out of the total.
- **Failures:** DynamoDB failing or timing out (500 ms per call, two retries) is `503 DEPENDENCY_UNAVAILABLE` with `Retry-After`; browsing is unaffected.

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
| `src/catalog/` | The Catalog context: `cursor.ts` and `listing-query.ts` (pure, unit-tested); reads in `catalog.queries.ts` and `catalog.controller.ts`; writes in `catalog.admin.ts`, `admin.controller.ts` and `admin.schemas.ts` |
| `src/cart/` | The Cart context: `cart.ts` (rules, pure, unit-tested), `cart.store.ts` (DynamoDB), `cart.controller.ts` |
| `src/idempotency.ts`, `src/preconditions.ts` | Idempotency-Key enforcement and sweep; `If-Match`, `Idempotency-Key` and request-hash rules (pure, unit-tested) |
| `src/validation.ts` | zod parsing that fails as `400 VALIDATION_FAILED` with one `errors[]` entry per field |
| `src/testing/` | Test support, not built: the Testcontainers harness and the contract checker |
| `src/migrations/` | Forward-only TypeORM migrations |

## Tests

```bash
pnpm --filter @sagamart/catalog test   # needs Docker: Testcontainers Postgres and DynamoDB Local
```

The integration suite boots the real module against real containers and checks the migrations (including the `active_has_price` constraint), the carts table and its TTL, probes, metrics, the identity rules (missing, garbage, wrong audience, expired, unknown internal path, roles), and that errors are Problem Details without leaking internals.

The Catalog suite seeds Postgres directly and checks every response body against `catalog-internal-v1.yaml` (`src/testing/contract.ts` bundles the spec with Redocly and validates with Ajv): sort orders and filters across page boundaries, ties and same-millisecond timestamps, cursors staying stable while products are added, cursor mismatch, subcategories, hidden drafts and archived SKUs, and `skus:lookup` limits.

The admin suite covers roles, `If-Match` (missing, stale, two edits racing on one version), `min_price` through adds, price changes and archiving, the 100-SKU limit with five adds racing at 98, category cycles, and idempotency: replay, a reused key, five concurrent duplicates, a failed write leaving no record, a request still in progress, and 24-hour expiry.

The cart suite runs against DynamoDB Local. It covers creating a cart on first write, quantity changes and removal, changed and withdrawn prices, unknown and inactive SKUs, the 50-line limit, concurrent adds landing from several tabs, racing adds at 48 lines (exactly two land), one TTL refreshed by every write, expired carts, key ownership, and `503` with browsing unaffected when DynamoDB is down. Removing the version condition makes the two race tests fail.
