# Contracts

The source of truth for every interface between Sagamart components. Code is generated from these files, never hand-written. A change here is a contract change: it needs an RFC or ADR and passes the compatibility checks in CI (see [conventions](../docs/engineering/conventions.md)).

| Folder | Contents | Checked by |
|---|---|---|
| [`proto/`](proto/) | gRPC services for internal commands (`sagamart.<context>.v<n>`) | `make contracts-lint`, `make contracts-breaking` (buf) |
| [`openapi/`](openapi/) | Public gateway API and internal REST specs (OpenAPI 3.1); shared types in `openapi/components/` | `make contracts-openapi` (Redocly: lint, and every example validated against its schema) |
| [`identity.md`](identity.md) | The `x-sagamart-identity` token the gateway (users) and Order (its service identity) sign, and every service verifies | Review; implemented in `packages/node-common` and Inventory |
| [`payment-provider.md`](payment-provider.md) | The payment provider's API and signed webhooks: the edge of Payment's anti-corruption layer | Review; implemented by the mock provider and Payment's adapter |
| [`events/`](events/) | Event envelope, one JSON Schema per event type and version, and an example of each | `make contracts-events` |
| [`gen/go/`](gen/go/) | Generated Go code (module `github.com/rizkyr99/sagamart/contracts/gen/go`), committed | `make contracts-generate`; CI fails if it is stale |
| [`gen/ts/`](gen/ts/) | Generated TypeScript (protobuf-es), the workspace package `@sagamart/contracts`, committed | `make contracts-generate`; CI fails if it is stale |

## Current contracts

| Contract | Status | Finalised in |
|---|---|---|
| `sagamart.inventory.v1.InventoryService` | Accepted | [RFC-0001](../docs/rfc/0001-inventory-reservation.md) |
| `sagamart.order.v1.OrderService` | Accepted | [RFC-0002](../docs/rfc/0002-checkout-saga.md) |
| `sagamart.payment.v1.PaymentService` | Accepted | [RFC-0002](../docs/rfc/0002-checkout-saga.md) |
| [Public API v1](openapi/public-v1.yaml) | Accepted | [RFC-0005](../docs/rfc/0005-catalog-cart-gateway.md) |
| [Catalog internal API v1](openapi/catalog-internal-v1.yaml) | Accepted | RFC-0005 |
| [Internal identity v1.1](identity.md) | Accepted | RFC-0005; service identities in RFC-0002 |
| [Payment provider v1](payment-provider.md) | Accepted | RFC-0002 |
| [Event envelope](events/envelope.schema.json) | Accepted | [Conventions §6](../docs/engineering/conventions.md#6-events) |
| [`inventory.reservation.expired/v1`](events/schemas/inventory.reservation.expired.v1.schema.json) | Accepted | RFC-0001 |
| [`inventory.stock.adjusted/v1`](events/schemas/inventory.stock.adjusted.v1.schema.json) | Accepted | RFC-0001 |
| [`payment.succeeded/v1`](events/schemas/payment.succeeded.v1.schema.json), [`payment.failed/v1`](events/schemas/payment.failed.v1.schema.json), [`payment.refunded/v1`](events/schemas/payment.refunded.v1.schema.json) | Accepted | RFC-0002 |
| [`order.confirmed/v1`](events/schemas/order.confirmed.v1.schema.json), [`order.cancelled/v1`](events/schemas/order.cancelled.v1.schema.json) | Accepted | RFC-0002 |

Each event schema in `events/schemas/<event-type>.v<major>.schema.json` describes the whole event: it extends the envelope and pins `type`, `source`, `dataschema` and the shape of `data`. A matching example lives in `events/examples/<event-type>.v<major>.json`, so producers can validate what they emit and consumers can test parsing.

Go services import generated code from `contracts/gen/go`, and Node services from `@sagamart/contracts` (for example `@sagamart/contracts/inventory/v1`, used with Connect's gRPC transport). Java (Order) generates its own at build time from `proto/`.

## Rules

1. Proto packages are versioned (`v1`); a breaking change is a new package version published alongside the old one.
2. Event schemas are additive within a version; renaming or removing a field means a new `/v2`.
3. Draft contracts may change freely until their RFC is accepted; after that, `buf breaking` and the schema diff are enforced.
