-- RFC-0002 §4.6, #60 part 2: when the pending command became pending, so the runner can tell when a
-- compensation (or CommitReservation) has used up its 15-minute budget. Set with pending_command,
-- cleared with it.
ALTER TABLE sagas ADD COLUMN pending_since TIMESTAMPTZ;

UPDATE sagas SET pending_since = updated_at WHERE pending_command IS NOT NULL;

ALTER TABLE sagas ADD CONSTRAINT sagas_pending_since_with_command
    CHECK ((pending_command IS NULL) = (pending_since IS NULL));
