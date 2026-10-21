# Changelog — inventory

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Releases are tagged `inventory/vX.Y.Z`.

## [Unreleased]

### Added

- Service skeleton: environment configuration validated at startup, JSON logs with trace IDs, OpenTelemetry tracing and Prometheus metrics, `/healthz`, `/readyz` and `/metrics`, gRPC server with health and reflection, graceful shutdown.
- First migration: `stock_levels` with the `stock_never_oversold` constraint, `reservations`, `reservation_lines` and `outbox` (RFC-0001 §4.3).
- Dockerfile (distroless, non-root) with a built-in `healthcheck` command; Compose service and Prometheus scrape job.
