# ADR-0005: Coordinate checkout with an orchestrated saga in the Order service

| | |
|---|---|
| **Status** | Accepted (details in RFC-0002, checkout saga) |
| **Date** | 2026-10-21 |
| **Deciders** | Rizky |
| **Related** | [ADR-0004](0004-database-per-service.md), [System Design §5](../architecture/system-design.md#5-key-flow-checkout-saga) |

## Context

Checkout spans Order, Inventory and Payment, each with its own database. A distributed transaction (2PC) is not available across these stores and would couple their availability. We need a way to complete or cleanly undo a multi-step checkout when any step fails.

## Options considered

### Option A — Choreography
Each service reacts to the previous service's event (OrderCreated → Inventory reserves → StockReserved → Payment charges ...).
- **Pros:** no central coordinator; loose coupling.
- **Cons:** the workflow is implicit and spread across services; hard to see the state of one checkout; compensation logic scattered; cyclic dependencies grow as steps are added.

### Option B — Orchestration
The Order service runs an explicit state machine that sends commands and reacts to replies.
- **Pros:** the whole workflow lives in one place; each checkout's state is queryable (powers the admin saga inspector); timeouts and compensations are explicit and testable.
- **Cons:** the orchestrator is a central dependency; risk of it accumulating business logic that belongs elsewhere.

### Option C — Workflow engine (Temporal, Camunda)
- **Pros:** durable execution, retries and timers handled by the engine.
- **Cons:** another heavy component; hides the mechanics the project is meant to demonstrate.

## Decision

We will use an orchestrated saga implemented in the Order service (Spring Boot) as a persisted state machine. Commands to Inventory and Payment are synchronous gRPC calls with deadlines; results that arrive later (payment outcome, reservation expiry) arrive as events. Saga state and step history are stored in the Order database.

Inventory reservations carry a TTL so stock is released even if the orchestrator is down.

## Consequences

- **Positive:** a single, inspectable source of truth for every checkout; explicit compensations; easy to test with a transition table.
- **Negative:** Order service availability affects checkout (not browsing); orchestrator must be crash-safe (state persisted before each command, commands idempotent).
- **Follow-ups:** RFC-0002 (written before the Checkout saga stage) defines states, transitions, timeouts, retry budgets and idempotency keys per step.

## Revisit when

The number of workflows grows beyond checkout (refunds, returns, shipping) and hand-written orchestration becomes a burden — then evaluate Temporal.
