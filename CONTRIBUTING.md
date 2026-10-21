# Contributing to Sagamart

The full process is in [docs/engineering/development-process.md](docs/engineering/development-process.md) and the conventions are in [docs/engineering/conventions.md](docs/engineering/conventions.md). This page is the short version.

## Local setup

| Tool | Version | Needed for |
|---|---|---|
| Docker + Compose v2 | 27+ / 2.29+ | Everything (`make up`) |
| GNU Make | 4+ | The single entry point |
| Go | 1.25+ | Inventory, Payment, Event workers, mock provider, invariant checker |
| Node.js | 22 LTS+ | Gateway, Catalog + Cart, web app |
| Java | 21+ | Order service |

Protobuf tooling (`buf`) runs in Docker through `make contracts-lint`, so it does not need a local install.

```bash
git clone git@github.com:rizkyr99/sagamart.git
cd sagamart
make up
```

`make up` copies `deploy/compose/.env.example` to `deploy/compose/.env` on first run. Edit `.env` to change ports or credentials; it is never committed.

`make up` starts infrastructure only, so you can run the service you're working on from source (`make run` in its folder). `make demo` builds and starts every service as well.

### Local ports

| Component | Port |
|---|---|
| Postgres — catalog / order / payment / inventory | 5433 / 5434 / 5435 / 5436 |
| Redpanda Kafka API / admin / schema registry | 19092 / 19644 / 18081 |
| Redpanda console | 8080 |
| Redis | 6380 |
| DynamoDB Local | 8001 |
| Meilisearch | 7700 |
| OTel collector (gRPC / HTTP) | 4317 / 4318 |
| Prometheus | 9090 |
| Jaeger UI | 16686 |
| Grafana | 3001 |
| Inventory — HTTP (probes, metrics) / gRPC | 8110 / 9110 |

## Workflow

1. Pick an issue that meets the Definition of Ready.
2. Branch from `main`: `feat/<topic>`, `fix/<topic>`, `docs/<topic>` or `chore/<topic>`.
3. Write the failing test first for domain logic and commit it.
4. Keep the pull request under about 400 changed lines; fill in the PR template.
5. Commit with Conventional Commits and a service scope: `feat(inventory): expire reservations with min-heap`.
6. Self-review in a later session, then squash-merge once CI is green.

Work that adds a service, changes a contract or touches more than one service starts with an RFC in [`docs/rfc/`](docs/rfc/).
