# ADR-0002: Choose a language per service by its workload

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-21 |
| **Deciders** | Rizky |
| **Related** | [System Design](../architecture/system-design.md) |

## Context

Sagamart has six services with different workloads: CRUD-heavy catalog work, transaction-heavy order orchestration, high-contention inventory, correctness-critical payments, and high-concurrency event consumers.

Using several languages adds tooling, CI and operational overhead. Using one language is simpler. However, a goal of the project is to demonstrate deep Go skills for distributed-systems roles while reusing existing NestJS strength and growing Spring Boot experience.

## Options considered

### Option A — single language (Go everywhere)
- **Pros:** one toolchain, shared libraries, maximum Go depth.
- **Cons:** slower to build CRUD and BFF layers; loses the chance to use Spring's mature transaction and state-machine tooling.

### Option B — single language (NestJS everywhere)
- **Pros:** fastest to build given current skills.
- **Cons:** weak fit for the high-concurrency hot paths; does not serve the Go learning goal.

### Option C — language per workload
- **NestJS** for the gateway/BFF and Catalog + Cart (I/O-bound CRUD, typed shared models with the frontend).
- **Java / Spring Boot** for Order (transactions, saga state machine, mature outbox patterns).
- **Go** for Inventory, Payment and Event workers (contention, concurrency, low memory per connection, predictable latency).

## Decision

We will use Option C. Go owns the three services where concurrency and throughput matter most, so the hardest engineering work is done in Go.

## Consequences

- **Positive:** each service uses a well-suited runtime; the project shows breadth and depth.
- **Negative:** three toolchains and three sets of libraries for logging, tracing and config. Mitigated by the shared [conventions](../engineering/conventions.md), generated contracts, and one `Makefile` entry point.
- **Follow-ups:** identical CI stages per language; shared OpenTelemetry setup notes per language.

## Revisit when

The overhead of maintaining three stacks consistently exceeds its value (for example, if conventions drift between languages more than once a month).
