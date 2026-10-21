# Sagamart

A polyglot, event-driven ecommerce platform (NestJS, Java/Spring Boot, Go) built to demonstrate production-grade distributed systems practice: orchestrated sagas, transactional outbox, idempotency, observability, SLOs and chaos testing.

The product is a single-merchant store for Indonesian shoppers. The engineering goal is that it never oversells, never double-charges and never loses an order, and that this is proven under load and injected failure.

> **Status:** Stage 0 — Foundation. Services land from Stage 1; see the [release plan](docs/product/prd.md#9-release-scope-and-timeline).

## Quick start

Requirements: Docker with Compose v2, GNU Make.

```bash
make up      # start Postgres x4, Redpanda, Redis, DynamoDB Local, Meilisearch, OTel, Prometheus, Jaeger, Grafana
make ps      # check container health
make help    # list every target
```

| Tool | URL |
|---|---|
| Redpanda console | <http://localhost:8080> |
| Grafana | <http://localhost:3001> (admin / admin) |
| Jaeger | <http://localhost:16686> |
| Prometheus | <http://localhost:9090> |
| Meilisearch | <http://localhost:7700> |

## Repository layout

| Path | Contents |
|---|---|
| [`apps/`](apps/) | Next.js storefront and admin |
| [`services/`](services/) | Backend services, one folder each |
| [`contracts/`](contracts/) | gRPC protobuf, OpenAPI and event schemas — the source of truth for every interface |
| [`deploy/`](deploy/) | Docker Compose, observability config, k6 load tests, chaos scripts |
| [`tests/`](tests/) | Acceptance (Cucumber) and end-to-end (Playwright) suites |
| [`tools/`](tools/) | Invariant checker and other test tooling |
| [`docs/`](docs/) | PRD, system design, ADRs, RFCs, process — start at [docs/README.md](docs/README.md) |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup and the development workflow.
