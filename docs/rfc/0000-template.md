# RFC-NNNN: <title>

| | |
|---|---|
| **Author** | <name> |
| **Status** | Draft / In review / Accepted / Implemented / Withdrawn |
| **Created** | YYYY-MM-DD |
| **Stage** | <roadmap stage, e.g. 2 Checkout saga> |
| **Related** | <PRD sections, ADRs, issues> |

> An RFC is written **before** building anything that adds a service, changes a contract, or touches more than one service. Open it as a pull request; review comments are the discussion. Once accepted, record lasting decisions as ADRs.

## 1. Summary

Two or three sentences: what will be built and why now.

## 2. Motivation

Which PRD requirements or problems does this address? What happens if we don't do it?

## 3. Goals and non-goals

**Goals**
- ...

**Non-goals**
- ...

## 4. Proposed design

### 4.1 Overview
Diagram (Mermaid) plus a short explanation.

### 4.2 API and contract changes
New or changed endpoints, gRPC methods and events, with schemas or links to `contracts/`.

### 4.3 Data model
Tables / items, keys, indexes, migrations.

### 4.4 Key flows
Sequence diagrams for the happy path and each failure path.

### 4.5 Failure modes
| Failure | Detection | Behaviour | Recovery |
|---|---|---|---|
| ... | ... | ... | ... |

### 4.6 Concurrency and consistency
Where can races happen? What guarantees ordering and idempotency?

## 5. Alternatives considered

What else was considered and why it was not chosen.

## 6. Observability

New metrics, logs, traces, dashboards and alerts. How will we know it works in production?

## 7. Performance and capacity

Expected load, latency targets, and how they will be measured.

## 8. Security and privacy

Authentication, authorisation, data exposure, abuse cases.

## 9. Testing plan

Unit, integration, contract, E2E, load and chaos tests this change needs.

## 10. Rollout plan

Order of changes, migrations, feature flags, backward compatibility, how to roll back.

## 11. Open questions

- [ ] ...

## 12. Decision log

| Date | Decision | Notes |
|---|---|---|
| | | |
