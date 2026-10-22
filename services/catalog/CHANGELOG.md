# Changelog — catalog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Releases are tagged `catalog/vX.Y.Z`.

## [Unreleased]

### Added

- Service skeleton (NestJS 12, ESM): zod-validated configuration, startup migrations for the RFC-0005 schema (categories, products with `active_has_price`, SKUs, idempotency keys), the DynamoDB carts table with TTL, `x-sagamart-identity` verification on every `/internal` request and `@Roles`, Problem Details for every error, `/healthz`, `/readyz`, `/metrics`, OpenTelemetry through the ESM loader hook, graceful shutdown that flushes telemetry, a Dockerfile and a Compose service.
