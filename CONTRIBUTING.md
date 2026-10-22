# Contributing to Sagamart

The full process is in [docs/engineering/development-process.md](docs/engineering/development-process.md) and the conventions are in [docs/engineering/conventions.md](docs/engineering/conventions.md). This page is the short version.

## Local setup

| Tool | Version | Needed for |
|---|---|---|
| Docker + Compose v2 | 27+ / 2.29+ | Everything (`make up`) |
| GNU Make | 4+ | The single entry point |
| Go | 1.25+ | Inventory, Payment, Event workers, mock provider, invariant checker |
| Node.js | 24.11+ (`.node-version`) | Gateway, Catalog + Cart, web app |
| pnpm | 10.34.7, from `packageManager` in `package.json` | The Node workspace; any pnpm 9.7+ or corepack switches to it automatically |
| Java | 21+ | Order service |

Protobuf tooling (`buf`) runs in Docker through `make contracts-lint`, so it does not need a local install.

### Node workspace

```bash
pnpm install          # every Node package and service
pnpm build            # first: services read workspace packages' compiled type declarations
pnpm lint             # ESLint (strict type-checked) and Prettier
pnpm typecheck && pnpm test
```

Shared code lives in `packages/node-common` (logger, telemetry, config validation, Problem Details, the internal identity). Services depend on it as `"@sagamart/node-common": "workspace:*"`.

Version notes, so nobody "upgrades" by accident: TypeScript is pinned to 6.0 because typescript-eslint 8 supports TypeScript below 6.1. pnpm is pinned to 10.x because the binaries of pnpm 11 and 12 can't be installed by pnpm 10's version switcher or by corepack 0.34. Revisit both when the tooling catches up.

```bash
git clone git@github.com:rizkyr99/sagamart.git
cd sagamart
make up
```

`make up` copies `deploy/compose/.env.example` to `deploy/compose/.env` on first run. Edit `.env` to change ports or credentials; it is never committed.

Run `make identity-keys` once: it writes the local Ed25519 key pair the gateway signs internal identities with, and that services verify (`contracts/identity.md`). `make demo` refuses to start Catalog without it.

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
| Catalog — internal API, probes, metrics | 8120 |
| Gateway — public API (from #30) | 8100 |

## Workflow

1. Pick an issue that meets the Definition of Ready.
2. Branch from `main`: `feat/<topic>`, `fix/<topic>`, `docs/<topic>` or `chore/<topic>`.
3. Write the failing test first for domain logic and commit it.
4. Keep the pull request under about 400 changed lines; fill in the PR template.
5. Commit with Conventional Commits and a service scope: `feat(inventory): expire reservations with min-heap`.
6. Self-review in a later session, then squash-merge once CI is green.

Work that adds a service, changes a contract or touches more than one service starts with an RFC in [`docs/rfc/`](docs/rfc/).
