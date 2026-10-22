# Changelog — catalog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Releases are tagged `catalog/vX.Y.Z`.

## [Unreleased]

### Added

- Carts (#29, FR-04): one DynamoDB item per cart (ADR-0009) keyed by user or hashed guest token. Lines are set and removed with writes conditional on the cart's version and retried on conflict, with at most 50 lines and quantity 1–100. Every write refreshes one 7-day TTL. Views show current prices with `priceChanged`. DynamoDB calls have a 500 ms deadline, and failures are `503` with `Retry-After`.
- Admin writes (#28, FR-11): create and edit categories, products and SKUs, and list and read products in any status. Edits use `If-Match` (`412`, `428`); creates use `Idempotency-Key`, enforced in the same transaction with a 24-hour hourly sweep; `min_price` is kept in the same transaction as every SKU write, with at most 100 SKUs per product; category moves can't form cycles. New IDs are UUIDv7.
- Browsing and price lookups (#28, RFC-0005 §4.2–4.3): categories, product listing with keyset cursors bound to their query (`newest`, `price_asc`, `price_desc`; category including subcategories; price range), product detail by slug, and `skus:lookup`. Responses are checked against `catalog-internal-v1.yaml` in tests.
- Service skeleton (NestJS 12, ESM): zod-validated configuration, startup migrations for the RFC-0005 schema (categories, products with `active_has_price`, SKUs, idempotency keys), the DynamoDB carts table with TTL, `x-sagamart-identity` verification on every `/internal` request and `@Roles`, Problem Details for every error, `/healthz`, `/readyz`, `/metrics`, OpenTelemetry through the ESM loader hook, graceful shutdown that flushes telemetry, a Dockerfile and a Compose service.
