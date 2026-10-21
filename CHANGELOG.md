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
