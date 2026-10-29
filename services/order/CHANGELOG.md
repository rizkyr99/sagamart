# Changelog — order

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Releases are tagged `order/vX.Y.Z`.

## [Unreleased]

### Added

- Service skeleton (#58): Java 25, Spring Boot 4.1 and the Maven Wrapper. It includes:
  - environment configuration validated at startup;
  - JSON logs with the conventions §7 fields and trace IDs;
  - OpenTelemetry tracing over OTLP, which leaves probes and scrapes out;
  - Prometheus metrics, `/healthz`, `/readyz` (database) and `/metrics`;
  - a gRPC server with health, reflection outside prod, and graceful shutdown;
  - `OrderService` registered, answering `UNIMPLEMENTED`.
- First migration (RFC-0002 §4.3): `orders`, `order_lines`, `sagas`, `saga_steps`, `processed_events`, `idempotency_keys` and `outbox`. Migrations run on start except in prod.
- Spotless (google-java-format) and Checkstyle, with constructor injection enforced.
- Dockerfile (Temurin 25 JRE, non-root) with a `/readyz` healthcheck; a Compose service on loopback ports 8140 and 9140; a Prometheus scrape job; and a CI job.
