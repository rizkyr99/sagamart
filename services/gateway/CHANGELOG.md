# Changelog — gateway

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Releases are tagged `gateway/vX.Y.Z`.

## [Unreleased]

### Added

- Admin (#32, FR-11): product, SKU and category routes forwarded to Catalog with `Idempotency-Key` and `If-Match` (status and `ETag` relayed), and `PUT /v1/admin/skus/{sku}/stock` through Inventory's `SetStockLevel`. Conflicts become `409` with the current version, on-hand and reserved units, read from Inventory's `ErrorInfo` reason.
- Browsing and carts (#31, RFC-0005 §4.4):
  - `GET /v1/categories`, `/v1/products` and `/v1/products/{slug}` with Inventory stock, batched by 100 under a 150 ms deadline, a failed batch marking only its SKUs `UNKNOWN`;
  - `POST /v1/cart/guest-token` and `GET`, `PUT` and `DELETE` on `/v1/cart` with `available` and `exceedsAvailable`;
  - a circuit breaker on Catalog;
  - Inventory over gRPC through the generated `@sagamart/contracts`.
- Service skeleton (#30, RFC-0005 §4.2, §4.5, §8):
  - zod-validated configuration that refuses dev auth in `prod`;
  - development JWTs (`POST /v1/dev/token`, HS256, one hour) only when `GATEWAY_DEV_AUTH=true`;
  - bearer-token verification and `@Roles`;
  - an internal client that signs `x-sagamart-identity` per target service and enforces per-call deadlines capped by the request's own;
  - token-bucket rate limiting per user or IP in Redis (one Lua script, a 50 ms deadline, fails open), with `429` and `Retry-After`;
  - Problem Details for every error, `/healthz`, `/readyz`, `/metrics` and OpenTelemetry;
  - a Dockerfile and a Compose service.
