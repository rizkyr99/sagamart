-- RFC-0002 §4.3, revised in #60: the fields of a saga state that have no column of their own
-- (Cancelling's mayHaveIntent and voided, Refunding's refunded, the state NEEDS_ATTENTION is stuck
-- in). Without them a state can't be read back as it was written.
ALTER TABLE sagas ADD COLUMN state_detail JSONB NOT NULL DEFAULT '{}';

ALTER TABLE sagas ADD CONSTRAINT sagas_state_known CHECK (state IN (
    'RESERVING_STOCK', 'CREATING_PAYMENT', 'AWAITING_PAYMENT', 'COMMITTING_STOCK', 'COMPLETED',
    'CANCELLING', 'REFUNDING', 'CANCELLED', 'NEEDS_ATTENTION'));
