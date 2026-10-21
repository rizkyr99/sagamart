# Sagamart — Documentation

Sagamart is a polyglot, event-driven ecommerce platform (NestJS, Java/Spring Boot, Go) built to demonstrate production-grade distributed systems practice: sagas, transactional outbox, idempotency, observability, SLOs and chaos testing.

## How these docs are organised

| Folder | What lives there | Status |
|---|---|---|
| [`product/`](product/) | Product requirements and user journeys | Written |
| [`architecture/`](architecture/) | System design, context map, diagrams | Written |
| [`adr/`](adr/) | Architecture Decision Records (one decision per file) | Ongoing |
| [`rfc/`](rfc/) | Design docs written before each significant piece of work | Before each stage |
| [`contracts/`](contracts/) | OpenAPI, protobuf, AsyncAPI event schemas | From the Foundation stage |
| [`engineering/`](engineering/) | Development process, conventions, testing strategy | Written |
| [`quality/`](quality/) | NFRs, SLOs, threat model, capacity plan | Scale release onward |
| [`operations/`](operations/) | Runbooks, postmortems, backup and recovery | From the MVP (first chaos postmortems) |
| [`benchmarks/`](benchmarks/) | Load and flash-sale results: hardware, method, raw numbers | From the MVP |
| [`retros/`](retros/) | Weekly review and retro notes | From week 1 |

## Foundation documents

- [Product Requirements (PRD)](product/prd.md)
- [System Design](architecture/system-design.md)
- [Context Map](architecture/context-map.md)
- [Development Process](engineering/development-process.md)
- [Engineering Conventions](engineering/conventions.md)
- [Testing Strategy](engineering/testing-strategy.md)
- [ADR index](adr/README.md) and [ADR template](adr/0000-template.md)
- [RFC template](rfc/0000-template.md)

## Stages and releases

Work is planned in stages (0. Foundation, 1. First slice, 2. Checkout saga, 2.5 Showcase, 3. Events, 4. Scale work, 5. Complete, 6. Deploy) that deliver releases (MVP, Events, Scale, Core complete, Optional). Dates are in the [PRD release plan](product/prd.md#9-release-scope-and-timeline).

## Rules for these docs

1. **Docs as code.** Every change goes through a pull request, like code.
2. **Decisions go in ADRs.** If you find yourself explaining *why* in a PR description, it probably belongs in an ADR.
3. **RFC before code.** Any work that adds a service, changes a contract, or touches more than one service starts with an RFC.
4. **Diagrams are Mermaid** inside Markdown, so they diff and review like text.
5. **Keep them current.** A doc that disagrees with the code is a bug; fix one or the other in the same PR.
