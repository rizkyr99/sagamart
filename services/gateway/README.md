# API gateway (BFF)

NestJS 12 service: the only public entry point. It authenticates callers, rate-limits them, and calls internal services with a signed identity. From #31 it also composes responses (Catalog data plus Inventory stock), so the browser makes one call per screen. It owns no business data. Design: [RFC-0005](../../docs/rfc/0005-catalog-cart-gateway.md). Contract: [`public-v1.yaml`](../../contracts/openapi/public-v1.yaml).

> **Status:** complete for Stage 1: browsing, product pages, carts, and admin for products, categories and stock.

## Run it

```bash
make up && make identity-keys   # repo root: infrastructure, then keys and the dev JWT secret (once)
pnpm install
cp services/gateway/.env.example services/gateway/.env   # paste the values from deploy/compose/.env
pnpm --filter @sagamart/gateway build
cd services/gateway && set -a && . ./.env && set +a && pnpm start
```

Or with everything else: `make demo`, then:

```bash
curl -s -X POST localhost:8100/v1/dev/token -H 'content-type: application/json' \
  -d '{"role":"admin","userId":"0199f2e0-0000-7000-8000-000000000001"}'
```

| Endpoint | Purpose |
|---|---|
| `GET /v1/categories` | Every category (from Catalog) |
| `GET /v1/products` | Catalog's listing (filters, sort, cursor) with each product's `stockStatus` |
| `GET /v1/products/{slug}` | A product with each SKU's `available` units and `stockStatus` |
| `POST /v1/cart/guest-token` | A guest cart token; **writes nothing** |
| `GET /v1/cart`, `PUT` and `DELETE /v1/cart/lines/{sku}` | The caller's cart: a signed-in buyer's own, or the guest cart named by `X-Cart-Token`. Lines get `available`, `exceedsAvailable` and `stockStatus`. |
| `/v1/admin/categories`, `/v1/admin/products`, `/v1/admin/products/{id}`, `/v1/admin/products/{id}/skus`, `/v1/admin/skus/{sku}` | **Admin.** Forwarded to Catalog's admin API with `Idempotency-Key` (creates) and `If-Match` (edits), which Catalog enforces. Its status, `ETag` and body are relayed. |
| `PUT /v1/admin/skus/{sku}/stock` | **Admin.** Sets on-hand stock through Inventory's `SetStockLevel` (2 s deadline). See below. |
| `POST /v1/dev/token` | A development JWT for `buyer` or `admin` (one hour). **Exists only with `GATEWAY_DEV_AUTH=true`**, and the gateway refuses to start with that in `prod`. |
| `GET /healthz`, `GET /readyz` | Liveness and readiness. Readiness checks nothing downstream: the gateway degrades per dependency instead (RFC-0005 §4.5). |
| `GET /metrics` | Prometheus metrics |

## How a request is handled

1. **Deadline.** Every request gets a budget (`GATEWAY_REQUEST_DEADLINE_MS`, 5 s).
2. **Authentication.** No `Authorization` header means anonymous: guests and browsing need no token. A bearer token must be a valid development JWT: HS256 only, our issuer and audience, unexpired with 5 s of skew, a UUID subject and a known role. Anything else is `401` with `WWW-Authenticate`, never silently anonymous. With dev auth off, no bearer token is accepted until OIDC arrives (Core complete).
3. **Rate limiting.** A token bucket per user (signed in) or per IP (anonymous): 20 requests/s with a burst of 40 by default. It runs as one Lua script in Redis, so the refill and take are atomic and use Redis's clock, shared by every gateway instance.
   - An empty bucket is `429 RATE_LIMITED` with `Retry-After`.
   - Each Redis command has a **50 ms** deadline and nothing queues while disconnected. If Redis is down or slow, the request is **allowed** and `rate_limit_fail_open` is counted: rate limiting must never take the API down. At startup the gateway waits up to 1 s for Redis, so it doesn't start out unlimited.
4. **Roles.** `@Roles('admin')` routes need the role (`401` anonymous, `403` otherwise). Services check again from the signed identity.
5. **Internal calls.** `InternalClient` attaches a fresh `x-sagamart-identity` ([contract](../../contracts/identity.md)) signed for that one service, with `sub` and `roles` from the caller.
   - Each call has its own deadline (RFC-0005 §4.5: Catalog reads 1 s, writes 3 s), capped by what the request has left, and is aborted when it passes.
   - A late or unreachable service is `503 DEPENDENCY_UNAVAILABLE` with `Retry-After`. Services' own responses, errors included, come back to the caller to relay.
   - For Inventory (#31), the capped deadline becomes the gRPC deadline, which Go propagates through `context`.

## Composition (RFC-0005 §4.4)

- **One Catalog call, then Inventory.** For a page, the gateway asks Catalog, then asks Inventory's `GetStockLevels` for every SKU on the page.
  - SKUs go in batches of 100 (the inventory contract's limit), sent in parallel under one **150 ms** deadline.
  - A batch that fails or is late marks only its own SKUs `UNKNOWN`, counted in `sagamart_gateway_stock_unknown_total`. A SKU Inventory doesn't know is `UNKNOWN` too.
  - The page always renders.
- **Stock status.** A SKU is `OUT_OF_STOCK` at 0, `LOW_STOCK` at 1–5, `IN_STOCK` above that. A product takes the best known status. It is `UNKNOWN` only if none of its SKUs is known to be available and one is unknown, because that one might be in stock.
- **Carts.** A signed-in buyer's cart is `user:<sub>`. A guest's is `guest:<sha256(X-Cart-Token)>`, so Catalog never stores the token itself.
  - No sign-in and no token is `401`; a token that isn't ours is `400`.
  - `exceedsAvailable` is `null` when stock is unknown. Nothing is reserved until checkout.
- **Catalog's errors are relayed** as Problem Details with the public path as `instance`, never the internal route.
- **Circuit breaker on Catalog.**
  - Five consecutive failures open it: unreachable, late, or `500`/`502`/`504`. Catalog's own `503` doesn't count; that means one of *its* dependencies is down (DynamoDB for carts), while browsing still works.
  - While open, calls fail at once with `503` and a `Retry-After` of the seconds left.
  - After 10 s one trial call goes through: success closes the breaker, failure re-opens it.
- **Inventory is called over gRPC** with Connect and the generated `@sagamart/contracts`. The capped deadline becomes the gRPC deadline.

## Admin stock (FR-11)

`PUT /v1/admin/skus/{sku}/stock` takes `{onHand, expectedVersion}`, where `expectedVersion` 0 creates the stock record. The gateway checks the admin role, validates the input (`400` without calling Inventory), then calls `SetStockLevel` with the caller's identity. Inventory checks the role again (#17).

- **Conflicts:** Inventory's `ErrorInfo` reason, decoded in `rpc-errors.ts`, tells its two precondition failures apart. `VERSION_CONFLICT` (another change came first) and `STOCK_BELOW_RESERVED` (on hand below what reservations hold) both become `409`. The gateway then reads the level and adds `currentVersion`, `onHand` and `reserved`, so the admin can retry with the right version and quantity.
- **Other failures:** Inventory's own validation is `400` with its fields in camelCase. Unavailable or late is `503`. Inventory refusing the gateway's identity means the keys don't match, so it is `500` and logged, never blamed on the caller.

Errors are RFC 9457 Problem Details with a stable `code` and the request's `traceId`.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `GATEWAY_IDENTITY_KEY_ID`, `GATEWAY_IDENTITY_PRIVATE_KEY` | — (required) | Ed25519 key that signs identities (PKCS#8 DER, base64); `make identity-keys` |
| `GATEWAY_DEV_AUTH` | `false` | `true` enables dev tokens; refused in `prod` |
| `GATEWAY_DEV_JWT_SECRET` | — | Required with dev auth; at least 32 characters |
| `GATEWAY_ENV` | `local` | `local`, `test` or `prod` |
| `GATEWAY_HTTP_PORT` | `8100` | |
| `GATEWAY_CATALOG_URL` | `http://localhost:8120` | |
| `GATEWAY_INVENTORY_URL` | `http://localhost:9110` | Inventory's gRPC endpoint (plaintext HTTP/2) |
| `GATEWAY_REDIS_URL` | `redis://localhost:6380` | Rate limits only; nothing durable |
| `GATEWAY_RATE_LIMIT_PER_SECOND`, `GATEWAY_RATE_LIMIT_BURST` | `20`, `40` | Per user or per IP |
| `GATEWAY_REQUEST_DEADLINE_MS` | `5000` | Budget for one incoming request |
| `GATEWAY_TRUST_PROXY` | `false` | Client IP from `X-Forwarded-For`; only behind a proxy we run |
| `GATEWAY_LOG_LEVEL`, `GATEWAY_VERSION`, `OTEL_EXPORTER_OTLP_ENDPOINT` | `info`, `dev`, empty | |

## Metrics

`sagamart_gateway_stock_unknown_total` (SKUs shown as `UNKNOWN`), `..._breaker_rejections_total`, `sagamart_gateway_rate_limited_total`, `..._rate_limit_fail_open_total`, `..._auth_rejections_total` by reason, `..._dependency_failures_total` by service and reason, plus HTTP server metrics from OpenTelemetry.

## Layout

| Path | Contents |
|---|---|
| `src/instrument.ts`, `src/main.ts` | Telemetry first, then bootstrap |
| `src/app.module.ts` | Wiring: logging, Redis, middleware order, roles |
| `src/config.ts` | Environment configuration |
| `src/dev-auth.ts`, `src/dev.controller.ts` | Development JWTs |
| `src/auth.ts` | `AuthMiddleware`, `RateLimitMiddleware`, `RolesGuard`, `@Roles` |
| `src/rate-limit.ts` | The token-bucket script and fail-open limiter |
| `src/deadline.ts` | Deadlines and the RFC's per-call budgets |
| `src/internal-client.ts` | Calls to internal services with identity and deadlines |
| `src/browse.controller.ts`, `src/cart.controller.ts`, `src/admin.controller.ts` | The public browse, cart and admin routes |
| `src/stock-admin.ts`, `src/rpc-errors.ts` | Stock-change failures as Problem Details, and gRPC error details (pure, unit-tested) |
| `src/stock.ts` | Stock status rules and batching (pure, unit-tested) |
| `src/catalog-client.ts`, `src/circuit-breaker.ts` | Catalog behind a circuit breaker (the breaker is pure, unit-tested) |
| `src/inventory-client.ts` | Inventory over gRPC |
| `src/cart-key.ts` | Guest tokens and cart keys |
| `src/request-context.ts` | The caller and deadline of a request |
| `src/problem.filter.ts`, `src/validation.ts` | Problem Details and request validation (as in Catalog) |
| `src/testing/` | Test support, not built: the contract checker |

## Tests

```bash
pnpm --filter @sagamart/gateway test   # needs Docker: Testcontainers Redis
```

- **Unit:** configuration (dev auth refused in prod), deadlines, dev tokens (expiry and skew, another secret, HS512, `alg: none`, wrong issuer or audience, bad roles and subjects), and the limiter's fail-open handling.
- **Browse integration:** a stub Catalog whose responses are checked against `catalog-internal-v1.yaml`, and a real gRPC Inventory stub. Every response is checked against `public-v1.yaml`. Covered:
  - stock status composition, with one Inventory call per page;
  - the identity and a deadline of at most 150 ms on Inventory calls;
  - a slow Inventory giving `UNKNOWN` fast, and batching with one batch failing;
  - Catalog errors relayed without internal paths, product pages, and 404;
  - guest tokens, guest and user cart keys, `exceedsAvailable`, and 401/400 for carts;
  - the breaker opening after five failures and then sparing Catalog, and Catalog unreachable.
- **Admin integration:** the same kind of stubs, with Inventory returning `ErrorInfo` and `BadRequest` details as Go does. It covers the role checks (no service is called on `401`/`403`), creates with `Idempotency-Key` relaying `201` and `ETag`, `If-Match` and a relayed `412`, listing parameters, setting stock with the admin identity under a 2 s deadline, both conflicts as `409` with the current level (and version 0 for an unknown SKU), input rejected before Inventory, Inventory's own validation, and Inventory down.
- **Integration:** a real Redis and a stub internal service that verifies the identity exactly as Catalog does. It covers probes, the dev-token route (present or absent), bad and expired tokens, roles, identity contents and forwarded headers, a call missing its deadline, an unreachable service, a burst then `429` then refill, separate buckets per user and IP, and failing open with Redis down and with Redis paused. The paused case then checks that the empty bucket is enforced once Redis answers again.
