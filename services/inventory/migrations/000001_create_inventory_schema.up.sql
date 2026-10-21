-- Inventory schema from RFC-0001 §4.3. Migrations are forward-only (conventions §9).

CREATE TABLE stock_levels (
    sku         TEXT PRIMARY KEY,
    on_hand     BIGINT NOT NULL,
    reserved    BIGINT NOT NULL DEFAULT 0,
    version     BIGINT NOT NULL DEFAULT 1,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Last line of defence: even an application bug cannot persist an oversell.
    CONSTRAINT stock_never_oversold CHECK (reserved >= 0 AND on_hand >= reserved)
);

CREATE TABLE reservations (
    id            UUID PRIMARY KEY,
    order_id      UUID NOT NULL UNIQUE,
    status        TEXT NOT NULL CHECK (status IN ('ACTIVE', 'COMMITTED', 'RELEASED', 'EXPIRED')),
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finalized_at  TIMESTAMPTZ
);

-- The expiry worker scans only active reservations, oldest expiry first.
CREATE INDEX reservations_active_expiry ON reservations (expires_at) WHERE status = 'ACTIVE';

CREATE TABLE reservation_lines (
    reservation_id UUID NOT NULL REFERENCES reservations (id),
    sku            TEXT NOT NULL REFERENCES stock_levels (sku),
    quantity       BIGINT NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (reservation_id, sku)
);

-- Transactional outbox (ADR-0006).
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
