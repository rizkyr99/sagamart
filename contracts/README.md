# Contracts

The source of truth for every interface between Sagamart components. Code is generated from these files, never hand-written. A change here is a contract change: it needs an RFC or ADR and passes the compatibility checks in CI (see [conventions](../docs/engineering/conventions.md)).

| Folder | Contents | Checked by |
|---|---|---|
| [`proto/`](proto/) | gRPC services for internal commands (`sagamart.<context>.v<n>`) | `make contracts-lint`, `make contracts-breaking` (buf) |
| [`openapi/`](openapi/) | Public gateway API and internal REST specs | OpenAPI validation (from Stage 1) |
| [`events/`](events/) | Event envelope and one JSON Schema per event type and version | Schema diff (from Stage 1) |

## Current contracts

| Contract | Status | Finalised in |
|---|---|---|
| `sagamart.inventory.v1.InventoryService` | Draft | RFC-0001 |
| `sagamart.payment.v1.PaymentService` | Draft | RFC-0002 |
| [Event envelope](events/envelope.schema.json) | Accepted (conventions §6) | — |

Event payload schemas live in `events/schemas/<event-type>.v<major>.schema.json` with an example payload next to each, so producers can validate what they emit and consumers can test parsing.

## Rules

1. Proto packages are versioned (`v1`); a breaking change is a new package version published alongside the old one.
2. Event schemas are additive within a version; renaming or removing a field means a new `/v2`.
3. Draft contracts may change freely until their RFC is accepted; after that, `buf breaking` and the schema diff are enforced.
