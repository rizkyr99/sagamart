# Changelog

All notable changes to the Sagamart platform are recorded here. Each service also keeps its own `CHANGELOG.md`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the platform uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Foundation documents: PRD, system design, context map, ADR-0001 to ADR-0007, development process, conventions and testing strategy.
- Repository skeleton, `Makefile` entry point, `CONTRIBUTING.md`.
- Local infrastructure in Docker Compose: one Postgres per service, Redpanda with console, Redis, DynamoDB Local, Meilisearch, OpenTelemetry collector, Prometheus, Jaeger and Grafana.
- First contracts: `InventoryService` and `PaymentService` protobuf definitions, the event envelope schema, and buf lint and breaking-change configuration.
- CI gates for contracts, docs and secret scanning; issue and pull request templates.
- Inventory contract accepted (RFC-0001): `SetStockLevel`, domain error reasons with `InsufficientStockDetail`, and the `inventory.reservation.expired/v1` and `inventory.stock.adjusted/v1` event schemas with examples.
- Generated Go code for the contracts, committed under `contracts/gen/go` and checked for staleness in CI.
- Catalog + Cart service skeleton (`services/catalog`, NestJS 12): validated config, startup migrations for the RFC-0005 schema, the DynamoDB carts table with TTL, identity verification on every `/internal` request, Problem Details for every error, probes, Prometheus metrics, OpenTelemetry traces through the ESM loader hook, a Dockerfile and a Compose service.
- pnpm workspace for the Node services, with `@sagamart/node-common`: the conventions-format logger, OpenTelemetry setup, config validation, Problem Details, and the Ed25519 internal identity (sign and verify, tested against every rule in the identity contract and for interoperability with jose). A `node` CI job lints, typechecks, builds, tests and audits it.
- Contracts for the First slice (RFC-0005): the public API (`public-v1.yaml`), Catalog's internal API (`catalog-internal-v1.yaml`) and the internal identity token (`identity.md`), with OpenAPI linting and example validation in CI, and `make identity-keys` for local keys.
- k6 load tests for Inventory (`deploy/k6`): flash-sale and steady-load scenarios, an invariant check, and a results summariser. First benchmark report and ADR-0008 (reservation strategy).
- Inventory service (see `services/inventory/CHANGELOG.md`): domain rules, Postgres reservation store, gRPC API, reservation expiry worker and outbox relay to Redpanda; `make demo` runs it with the infrastructure.
