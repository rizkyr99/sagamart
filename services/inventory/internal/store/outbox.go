package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// OutboxEvent is an outbox row waiting to be published (ADR-0006). Payload is the complete event envelope.
type OutboxEvent struct {
	ID          string
	AggregateID string // the partition key
	EventType   string
	Payload     []byte
	CreatedAt   time.Time
}

// ClaimOutbox locks up to limit unpublished events, oldest first, and hands them to publish. When publish returns
// nil they are marked published in the same transaction; when it fails, nothing is marked and they are claimed
// again later. Concurrent relays skip each other's rows. Delivery is at least once: a crash after publish but
// before commit publishes the batch again, so consumers deduplicate by event id.
func (s *Store) ClaimOutbox(ctx context.Context, limit int, publish func(context.Context, []OutboxEvent) error) (int, error) {
	var claimed int
	// Not inTx: a retry would publish the batch a second time. A failed claim is simply picked up next tick.
	err := pgx.BeginTxFunc(ctx, s.pool, pgx.TxOptions{IsoLevel: pgx.ReadCommitted}, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT id::text, aggregate_id, event_type, payload, created_at FROM outbox
			WHERE published_at IS NULL
			ORDER BY created_at, id
			LIMIT $1
			FOR UPDATE SKIP LOCKED`, limit)
		if err != nil {
			return fmt.Errorf("claim outbox: %w", err)
		}
		batch, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (OutboxEvent, error) {
			var e OutboxEvent
			err := r.Scan(&e.ID, &e.AggregateID, &e.EventType, &e.Payload, &e.CreatedAt)
			return e, err
		})
		if err != nil {
			return fmt.Errorf("claim outbox: %w", err)
		}
		if len(batch) == 0 {
			return nil
		}

		if err := publish(ctx, batch); err != nil {
			return err
		}

		ids := make([]string, len(batch))
		for i, e := range batch {
			ids[i] = e.ID
		}
		if _, err := tx.Exec(ctx, `UPDATE outbox SET published_at = now() WHERE id = ANY($1::uuid[])`, ids); err != nil {
			return fmt.Errorf("mark outbox published: %w", err)
		}
		claimed = len(batch)
		return nil
	})
	if err != nil {
		return 0, err
	}
	return claimed, nil
}
