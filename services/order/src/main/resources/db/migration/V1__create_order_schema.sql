-- RFC-0002 §4.3. Forward-only (conventions §9): never edit after merge, fix forward with V2.

CREATE TABLE orders (
    id               UUID PRIMARY KEY,                -- UUIDv7, also every downstream idempotency key's root
    buyer_id         UUID NOT NULL,                   -- the identity's sub
    status           TEXT NOT NULL CHECK (status IN ('PENDING', 'AWAITING_PAYMENT', 'PAID', 'CONFIRMED', 'CANCELLED')),
    cancel_reason    TEXT,
    total_amount     BIGINT NOT NULL CHECK (total_amount > 0),
    currency         CHAR(3) NOT NULL DEFAULT 'IDR',
    shipping_address JSONB NOT NULL,                  -- personal data (RFC-0002 §8)
    payment_url      TEXT,
    version          INT NOT NULL DEFAULT 1,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cancelled_has_reason CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL))
);
CREATE INDEX orders_by_buyer ON orders (buyer_id, created_at DESC, id DESC);
CREATE INDEX orders_by_status ON orders (status, created_at DESC, id DESC);

CREATE TABLE order_lines (
    order_id   UUID NOT NULL REFERENCES orders (id),
    sku        TEXT NOT NULL,
    name       TEXT NOT NULL,                         -- product and variant name at order time
    unit_price BIGINT NOT NULL CHECK (unit_price > 0),-- locked at checkout
    quantity   INT NOT NULL CHECK (quantity BETWEEN 1 AND 100),
    PRIMARY KEY (order_id, sku)
);

CREATE TABLE sagas (
    order_id               UUID PRIMARY KEY REFERENCES orders (id),
    state                  TEXT NOT NULL,
    pending_command        JSONB,                     -- the next call to make, if any
    attempt                INT NOT NULL DEFAULT 0,
    next_attempt_at        TIMESTAMPTZ,               -- when the runner should (re)try pending_command
    claimed_until          TIMESTAMPTZ,               -- lease: a runner is executing pending_command until then
    reservation_expires_at TIMESTAMPTZ,               -- from ReserveStock's reply (Inventory's clock)
    payment_deadline       TIMESTAMPTZ,               -- min(reservation_expires_at - 2m, intent expires_at)
    cancel_published       BOOLEAN NOT NULL DEFAULT false, -- order.cancelled goes out once per order
    version                INT NOT NULL DEFAULT 1,
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The runner's queue: work that is due now and not leased (RFC-0002 §4.7).
CREATE INDEX sagas_due ON sagas (next_attempt_at) WHERE pending_command IS NOT NULL;
CREATE INDEX sagas_deadline ON sagas (payment_deadline) WHERE state = 'AWAITING_PAYMENT';

CREATE TABLE saga_steps (                             -- append-only history for FR-12
    order_id   UUID NOT NULL REFERENCES orders (id),
    seq        INT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('EVENT', 'COMMAND', 'TRANSITION')),
    name       TEXT NOT NULL,                         -- e.g. ReserveStock, payment.succeeded
    from_state TEXT,
    to_state   TEXT,
    attempt    INT,
    outcome    TEXT CHECK (outcome IN ('OK', 'RETRYABLE_ERROR', 'FAILED')),
    detail     JSONB,                                 -- error code and message; never personal data
    at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (order_id, seq)
);

CREATE TABLE processed_events (                       -- inbox: each consumed event applied once
    event_id     UUID PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- As Catalog's (RFC-0005 §4.3); owner is the buyer, so keys are scoped per buyer.
CREATE TABLE idempotency_keys (
    owner        TEXT NOT NULL,
    key          TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status       INT,
    response     JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner, key)
);
CREATE INDEX idempotency_keys_created ON idempotency_keys (created_at);

-- ADR-0006 layout, as Inventory's.
CREATE TABLE outbox (
    id             UUID PRIMARY KEY,
    aggregate_type TEXT NOT NULL,
    aggregate_id   TEXT NOT NULL,
    event_type     TEXT NOT NULL,
    payload        JSONB NOT NULL,
    headers        JSONB NOT NULL DEFAULT '{}',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at   TIMESTAMPTZ
);
CREATE INDEX outbox_unpublished ON outbox (created_at) WHERE published_at IS NULL;
