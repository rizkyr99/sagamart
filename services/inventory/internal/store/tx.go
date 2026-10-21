package store

import (
	"context"
	"errors"
	"math/rand/v2"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Postgres error codes the store reacts to.
const (
	codeSerializationFailure = "40001"
	codeDeadlockDetected     = "40P01"
	codeUniqueViolation      = "23505"
)

// maxTxAttempts bounds retries of transactions that failed only because of a concurrent transaction (RFC-0001 §4.6).
const maxTxAttempts = 3

// inTx runs fn in a READ COMMITTED transaction, retrying deadlocks and serialisation failures with jittered backoff.
// fn may run more than once, so it must not have side effects outside the transaction.
func (s *Store) inTx(ctx context.Context, fn func(pgx.Tx) error) error {
	var err error
	for attempt := 1; attempt <= maxTxAttempts; attempt++ {
		err = pgx.BeginTxFunc(ctx, s.pool, pgx.TxOptions{IsoLevel: pgx.ReadCommitted}, fn)
		if !isRetryable(err) || attempt == maxTxAttempts {
			return err
		}
		backoff := time.Duration(attempt) * time.Duration(5+rand.IntN(20)) * time.Millisecond //nolint:gosec // G404: jitter, not a secret
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
	}
	return err
}

func isRetryable(err error) bool {
	return hasCode(err, codeSerializationFailure) || hasCode(err, codeDeadlockDetected)
}

func hasCode(err error, code string) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == code
}
