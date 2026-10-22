# ADR-0009: Store each cart as a single DynamoDB item

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-22 |
| **Deciders** | Rizky |
| **Related** | Refines [ADR-0007](0007-cart-in-dynamodb.md) (the item layout only; DynamoDB stays), [RFC-0005](../rfc/0005-catalog-cart-gateway.md) §4.3 |

## Context

ADR-0007 chose DynamoDB for carts with a single-table design: a `META` item per cart plus one `LINE#<sku>` item per line, each with a `ttl` refreshed on writes. Carts expire 7 days after the last change (PRD FR-04).

While designing the cart module (RFC-0005), review found a flaw in that layout. A write refreshes the TTL of `META` and of the line it touches, but not of the other lines. A line added on day 1 and not touched again expires on day 8 even if the buyer changed another line on day 6. Its cart would then silently lose items, and any line counter in `META` would no longer match the lines that exist.

## Options considered

### Option A — Keep line items, refresh every TTL on every write

Each write rewrites all of the cart's items (up to 51) in one `TransactWriteItems`.

- **Pros:** keeps ADR-0007's layout; lines can be read or written individually.
- **Cons:** every small change costs up to 51 item writes; the transaction limits and consumed capacity grow with cart size; concurrency still needs a separate version on `META`.

### Option B — One item per cart

`PK = CART#<cartKey>` with a `lines` map (SKU → quantity, price snapshot, added time), a `version`, and one `ttl`.

- **Pros:** one TTL, so the cart expires as a whole. Every write is one conditional `PutItem` or `UpdateItem` on `version`. The 50-line limit is checked against the real cart in the same condition. Reads are one `GetItem`.
- **Cons:** a write replaces or updates one larger item instead of a small one. Bounded: 50 lines are a few KB, far below the 400 KB item limit.

## Decision

We will store each cart as a single DynamoDB item (Option B). ADR-0007's choice of DynamoDB and its access pattern (by cart key, with native TTL) are unchanged; only the item layout changes.

## Consequences

- **Positive:** a cart can't be partly expired; concurrency is one optimistic `version` check; the limit check and the write are atomic.
- **Negative:** two concurrent writes to different lines of one cart conflict on `version`, so one retries. That's acceptable at cart scale (one buyer, a few tabs).
- **Follow-ups:** RFC-0005 §4.3 describes the item; the Cart module README documents the access patterns (ADR-0007's follow-up).

## Revisit when

Carts need far more lines than 50, or per-line access patterns appear (for example, analytics across carts). Feed those through events into a separate read model instead.
