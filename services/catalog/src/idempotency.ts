import { Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { ProblemError, problem } from '@sagamart/node-common';
import { DataSource, QueryFailedError } from 'typeorm';
import type { EntityManager } from 'typeorm';

/** What a protected write answered, stored with its key and replayed on retries. */
export interface StoredResponse {
  status: number;
  body: unknown;
  etag: string;
}

export interface IdempotencyGuard {
  /** The identity's `sub`: keys are per user, so two users can't collide (RFC-0005 §4.6). */
  owner: string;
  key: string;
  /** requestHash() of method, path and body. */
  hash: string;
}

/** Postgres's error code and constraint, from TypeORM's wrapper. */
export function pgError(err: unknown): { code?: string; constraint?: string } {
  if (!(err instanceof QueryFailedError)) return {};
  const driver = err.driverError as { code?: unknown; constraint?: unknown };
  return {
    ...(typeof driver.code === 'string' ? { code: driver.code } : {}),
    ...(typeof driver.constraint === 'string' ? { constraint: driver.constraint } : {}),
  };
}

const RETENTION = '24 hours';
const SWEEP_EVERY_MS = 60 * 60 * 1000;

const meter = metrics.getMeter('@sagamart/catalog');
const replays = meter.createCounter('sagamart.catalog.idempotency_replays', {
  description: 'Admin writes answered from a stored response instead of running again.',
});

const inProgress = (): ProblemError =>
  new ProblemError(
    problem({
      status: 409,
      code: 'REQUEST_IN_PROGRESS',
      detail: 'A request with this Idempotency-Key is still running. Retry shortly for its result.',
    }),
  );

/**
 * Catalog-enforced Idempotency-Key (RFC-0005 §4.4). The key is claimed in the same transaction as the write, so
 * the write and its record commit together or not at all: a crash leaves nothing (a retry runs the write) or a
 * complete record (a retry gets the stored response).
 */
@Injectable()
export class Idempotency implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Idempotency');
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly db: DataSource) {}

  /** Runs `work` once per (owner, key); a retry with the same request gets the stored response. */
  async run(
    guard: IdempotencyGuard,
    work: (tx: EntityManager) => Promise<StoredResponse>,
  ): Promise<StoredResponse> {
    return this.db.transaction(async (tx) => {
      const { owner, key, hash } = guard;
      // An expired record no longer protects anything; the sweep may simply not have reached it yet.
      await tx.query(
        `DELETE FROM idempotency_keys WHERE owner = $1 AND key = $2 AND created_at < now() - $3::interval`,
        [owner, key, RETENTION],
      );
      let claimed: unknown[];
      try {
        // The primary key makes a concurrent duplicate wait here until the first transaction ends.
        claimed = await tx.query(
          `INSERT INTO idempotency_keys (owner, key, request_hash) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING RETURNING key`,
          [owner, key, hash],
        );
      } catch (err) {
        // The first request outlasted our statement timeout: tell the client to come back, not that it failed.
        if (pgError(err).code === '57014') throw inProgress();
        throw err;
      }

      if (claimed.length === 0) {
        const rows: {
          request_hash: string;
          status: number | null;
          response: Omit<StoredResponse, 'status'> | null;
        }[] = await tx.query(
          `SELECT request_hash, status, response FROM idempotency_keys WHERE owner = $1 AND key = $2`,
          [owner, key],
        );
        const stored = rows[0];
        // Committed records always have a response; anything else is a race with the sweep. Retrying is safe.
        if (!stored?.status || !stored.response) throw inProgress();
        if (stored.request_hash !== hash) {
          throw new ProblemError(
            problem({
              status: 422,
              code: 'IDEMPOTENCY_KEY_REUSED',
              detail: 'This key was used with a different request.',
            }),
          );
        }
        replays.add(1);
        return { status: stored.status, body: stored.response.body, etag: stored.response.etag };
      }

      const response = await work(tx);
      await tx.query(`UPDATE idempotency_keys SET status = $3, response = $4 WHERE owner = $1 AND key = $2`, [
        owner,
        key,
        response.status,
        JSON.stringify({ body: response.body, etag: response.etag }),
      ]);
      return response;
    });
  }

  /** Deletes records older than 24 hours; returns how many. Runs hourly, and once at startup. */
  async sweep(): Promise<number> {
    // Wrapped in a SELECT: TypeORM returns [rows, rowCount] for a bare DELETE but plain rows for a SELECT.
    const [{ n }] = await this.db.query<[{ n: number }]>(
      `WITH deleted AS (DELETE FROM idempotency_keys WHERE created_at < now() - $1::interval RETURNING 1)
       SELECT count(*)::int AS n FROM deleted`,
      [RETENTION],
    );
    return n;
  }

  onApplicationBootstrap(): void {
    const sweep = (): void => {
      this.sweep().then(
        (deleted) => {
          if (deleted > 0) this.log.log({ deleted }, 'expired idempotency keys deleted');
        },
        (err: unknown) => {
          this.log.warn({ err }, 'idempotency sweep failed; retrying next hour');
        },
      );
    };
    sweep();
    this.timer = setInterval(sweep, SWEEP_EVERY_MS).unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }
}
