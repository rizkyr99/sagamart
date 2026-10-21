# Product Requirements Document — Sagamart

| | |
|---|---|
| **Owner** | Rizky |
| **Status** | Draft |
| **Last updated** | 2026-10-21 |
| **Related** | [System Design](../architecture/system-design.md), [Context Map](../architecture/context-map.md) |

## 1. Summary

Sagamart is a single-merchant online store for Indonesian shoppers: browse a catalog, add to cart, check out, pay, and track the order live. Behind that simple experience sits a distributed backend designed to stay correct under load and partial failure — no overselling during flash sales, no double charges, no lost orders when a service crashes mid-checkout.

The product exists primarily as an engineering portfolio, so the requirements below deliberately emphasise correctness and operability over breadth of features.

## 2. Problem statement

Real ecommerce systems fail in predictable ways under pressure:

- **Overselling** when many buyers race for limited stock.
- **Double charges** when payment requests or webhooks are retried.
- **Stuck or lost orders** when one service fails between steps of a multi-step checkout.
- **Opaque failures**: operators can't see where a checkout broke.

Sagamart should demonstrate a design that prevents each of these, and prove it with measurements and failure tests.

## 3. Goals and non-goals

### Goals

1. A complete buyer journey: browse → search → cart → checkout → pay → track.
2. Zero oversells and zero double charges, demonstrated under load and injected failures.
3. Every checkout is traceable end to end across all services.
4. Operators can see and recover failed workflows from an admin UI.
5. The system is documented to the standard of a mature engineering team.

### Non-goals (explicitly out of scope)

- Multiple sellers / marketplace features
- Coupons, promotions, loyalty points
- Recommendations and personalisation
- Product reviews and ratings
- Customer-requested cancellations, returns and refunds after an order is confirmed (automatic refunds as part of a failed checkout are in scope, see FR-08)
- Real payment gateway or courier integration (both are mocked behind interfaces)
- Native mobile app
- Multi-currency and multi-language (IDR and English only; Indonesian copy optional)

## 4. Users and personas

| Persona | Description | Primary needs |
|---|---|---|
| **Buyer** | Shops on phone or laptop, often during sales | Fast pages, accurate stock, safe payment, clear order status |
| **Store admin** | Manages products, stock and orders | Edit catalog, adjust stock, see order states, handle failures |
| **Operator (SRE)** | Keeps the system running | Dashboards, alerts, traces, ability to replay failed events |

## 5. User journeys

### J1 — Browse and search
1. Buyer opens the storefront and sees categories and featured products.
2. Buyer searches by keyword and filters by category and price.
3. Buyer opens a product page with price, description, images and stock status.

### J2 — Cart
1. Buyer adds items to the cart as a guest or signed-in user.
2. Cart persists for 7 days; a guest cart merges into the user's cart on sign-in.
3. Cart shows current price and availability, and warns if either changed.

### J3 — Checkout and payment
1. Buyer enters shipping address and selects a (mock) payment method.
2. System reserves stock, creates the order, and requests payment.
3. Buyer completes the (mock) payment.
4. On success the order is confirmed; on failure or timeout, stock is released and the order is cancelled.

### J4 — Order tracking
1. Buyer sees order history and the status of each order.
2. Status updates appear live without refreshing (pending → paid → confirmed → shipped → delivered).

### J5 — Administration
1. Admin creates and edits products and stock levels.
2. Admin views orders and their full saga history step by step.
3. Admin marks confirmed orders as shipped, then delivered.
4. Admin views dead-lettered events and replays them after a fix.

### J6 — Flash sale
1. Admin sets a limited stock level for a product (e.g. 100 units).
2. Thousands of buyers attempt to buy at once.
3. Exactly 100 units are sold; everyone else gets a clear "sold out" response quickly.

## 6. Functional requirements

**Priority** says how important a requirement is to the full product (MoSCoW). **Release** says when it ships (see [section 9](#9-release-scope-and-timeline)).

| ID | Requirement | Priority | Release | Journey |
|---|---|---|---|---|
| FR-01 | List and filter products with cursor-based pagination | Must | MVP | J1 |
| FR-02 | Full-text product search with category and price filters | Must | Core complete | J1 |
| FR-03 | Product detail with live stock status | Must | MVP | J1 |
| FR-04 | Guest and authenticated carts with 7-day TTL | Must | MVP | J2 |
| FR-05 | Merge guest cart into user cart on sign-in | Should | Core complete | J2 |
| FR-06 | Checkout reserves stock for a limited time (default 10 min) | Must | MVP | J3 |
| FR-07 | Payment requests are idempotent; retries never double-charge | Must | MVP | J3 |
| FR-08 | Failed or timed-out checkouts release stock and cancel the order automatically | Must | MVP | J3 |
| FR-09 | Live order status updates to the buyer | Must | Events | J4 |
| FR-10 | Order history for signed-in buyers | Must | Core complete | J4 |
| FR-11 | Admin CRUD for products and stock | Must | MVP | J5 |
| FR-12 | Admin view of each order's saga steps and timestamps | Must | MVP | J5 |
| FR-13 | Admin view and replay of dead-lettered events | Should | Core complete | J5 |
| FR-14 | Email/notification on order confirmation (mock channel) | Should | Events | J3 |
| FR-15 | Admin chaos panel to inject latency or stop a service (dev only) | Could | Optional | — |
| FR-16 | Admin marks orders shipped and delivered | Should | Core complete | J4, J5 |

### Acceptance criteria for the critical requirements

These are verified by integration tests, the invariant checker, and the load and chaos tests in the [testing strategy](../engineering/testing-strategy.md).

**FR-06 — Stock reservation**
- A reservation succeeds only if available stock ≥ requested quantity; otherwise it fails with `INSUFFICIENT_STOCK`.
- Under any number of concurrent requests, available stock never goes below zero.
- An expired reservation is released within 30 seconds of its TTL, even if the Order service is down.
- Releasing the same reservation twice has the same effect as releasing it once.

**FR-07 — Idempotent payments**
- The same `Idempotency-Key` retried 10 times creates exactly one payment intent and returns the original response each time.
- The same provider webhook delivered 3 times results in exactly one capture and one set of ledger entries.
- Ledger debits always equal ledger credits.

**FR-08 — Automatic rollback**
- The saga's payment deadline (default 8 minutes) is shorter than the reservation TTL (10 minutes), so the saga cancels before Inventory's expiry acts as the safety net.
- On payment failure or deadline expiry, the order reaches `CANCELLED` and its stock is released within 5 seconds (p95).
- If the Order service is killed mid-checkout, every affected order reaches a terminal state within 60 seconds of restart, with no leaked reservations.
- If a payment succeeds but the stock can no longer be committed, the payment is refunded automatically and the order is `CANCELLED`; the buyer is never charged for an order that isn't confirmed.

## 7. Non-functional requirements (initial targets)

Targets are provisional until measured in the Scale release; they will be formalised in `quality/nfr.md` and `quality/slo.md`.

| Area | Target |
|---|---|
| Correctness | 0 oversells, 0 double charges, 0 lost orders in all load and chaos tests |
| Read latency | Product list/detail API p99 < 200 ms at target load |
| Checkout latency | Checkout accepted p99 < 500 ms (payment completion is asynchronous) |
| Flash-sale throughput | ≥ 2,000 reservation attempts/s on a single laptop-class host |
| Search freshness | Catalog changes searchable within 5 s (p95) |
| Order status freshness | Status change visible to buyer within 2 s (p95) |
| Availability | Browsing keeps working if Order or Payment is down |
| Observability | 100% of requests carry a trace ID; every service exports metrics |

## 8. Success metrics for the portfolio

- Flash-sale benchmark published with methodology, hardware and p50/p99 numbers.
- At least 4 chaos scenarios executed, each with a written postmortem.
- At least 8 ADRs covering the major decisions.
- `make demo` brings up the full system from a clean clone in under 10 minutes.

## 9. Release scope and timeline

The full scope in this PRD is delivered in stages. The MVP contains the parts that prove correctness under load and failure; the rest follows.

| Release | Target date | Requirements included |
|---|---|---|
| **MVP** | 2026-12-13 | FR-01, FR-03, FR-04, FR-06, FR-07, FR-08, FR-11, FR-12; flash-sale benchmark (J6); invariant checker; 2+ chaos scenarios; README results and demo video |
| **Events** | 2027-01-03 | FR-09 (live order tracking), FR-14 (notifications) |
| **Scale** | 2027-01-31 | Multi-instance Go services, hot-SKU handling, leader election, profiling results |
| **Core complete** | 2027-02-28 | FR-02 (search), FR-05 (cart merge), FR-10 (order history), FR-13 (DLQ replay), FR-16 (shipping states), real OIDC auth, full SLOs and runbooks |
| **Optional** | 2027-03 | FR-15 (chaos panel), public deployment |

Until real auth lands, the gateway uses a signed development JWT so that buyer and admin roles still work end to end.

## 10. Assumptions and constraints

- Built by one engineer, part-time (~22 hrs/week on the project).
- Must run locally on one machine via Docker Compose.
- No paid third-party services required to run the demo.
- Prices in IDR, stored as integers (no fractional rupiah).

## 11. Open questions

- [x] Product name: Sagamart (decided 2026-10-21).
- [ ] Which auth provider: Casdoor (familiar) or Keycloak (more widely recognised)?
- [ ] Should the public demo (optional release) allow anonymous checkout with fake payment?
