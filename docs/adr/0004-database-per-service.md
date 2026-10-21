# ADR-0004: Each service owns its database

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-21 |
| **Deciders** | Rizky |

## Context

A shared database across services is the fastest way to build, but it couples services through the schema: a migration in one service can break another, and services can't scale or fail independently. Sagamart's goal is to show how independent services stay consistent without a shared database.

## Options considered

- **Shared database, shared schema** — simple joins and transactions; tight coupling.
- **Shared database server, schema per service, no cross-schema access** — cheaper to run, logically separate.
- **Database instance per service** — strongest isolation, more containers.

## Decision

Each service owns its data store, and no service reads or writes another's. Locally we run one Postgres container per Postgres-backed service so that isolation is enforced, not just agreed. Data needed across contexts is obtained through APIs or events (and cached locally where needed).

## Consequences

- **Positive:** independent schema evolution, failure isolation, clear ownership; forces the event-driven design the project is meant to demonstrate.
- **Negative:** no cross-service joins or transactions; consistency is eventual across contexts and needs the saga and outbox patterns ([ADR-0005](0005-orchestrated-checkout-saga.md), [ADR-0006](0006-transactional-outbox.md)). More containers locally.
- **Follow-ups:** reporting across contexts (if ever needed) is built as a separate read model fed by events.
