# ADR-0001: Record architecture decisions as ADRs

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-21 |
| **Deciders** | Rizky |

## Context

Sagamart will accumulate many architectural decisions across three languages and six services. Without a record, the reasons behind choices are lost, decisions get relitigated, and reviewers (including future hiring teams) can't see the reasoning.

## Options considered

- **No formal record** — decisions live in commit messages and memory. Cheap now, expensive later.
- **One big design document** — easy to start, but it becomes stale and hides when and why things changed.
- **Architecture Decision Records** (Michael Nygard style) — one short, immutable file per decision, numbered and dated.

## Decision

We will record every significant architectural decision as an ADR in `docs/adr/`, using [the template](0000-template.md). ADRs are immutable once accepted; a change of mind is a new ADR that supersedes the old one.

A decision is "significant" if it is hard to reverse, affects more than one service, or a newcomer would reasonably ask "why did you do it this way?".

## Consequences

- **Positive:** decisions and their trade-offs are visible and reviewable; the repo shows engineering judgement, not just code.
- **Negative:** small overhead per decision.
- **Follow-ups:** keep the [ADR index](README.md) current.
