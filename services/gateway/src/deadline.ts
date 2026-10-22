/**
 * When work must be done by (RFC-0005 §4.5). Every outbound call gets its own deadline, capped by what the incoming
 * request has left, so a hung dependency fails fast and no call outlives the request that needed it.
 */
export class Deadline {
  private constructor(readonly at: number) {}

  static in(ms: number, now: number = Date.now()): Deadline {
    return new Deadline(now + ms);
  }

  remaining(now: number = Date.now()): number {
    return Math.max(0, this.at - now);
  }

  expired(now: number = Date.now()): boolean {
    return this.remaining(now) === 0;
  }

  /** The sooner of this deadline and `ms` from now. */
  cap(ms: number, now: number = Date.now()): Deadline {
    return new Deadline(Math.min(this.at, now + ms));
  }

  /** Aborts when the deadline passes; already aborted if it has, so no call even starts. */
  signal(now: number = Date.now()): AbortSignal {
    const left = this.remaining(now);
    return left === 0
      ? AbortSignal.abort(new DOMException('deadline exceeded', 'TimeoutError'))
      : AbortSignal.timeout(left);
  }
}

/** Per-call deadlines from RFC-0005 §4.5, in milliseconds. */
export const DEADLINES = {
  catalogRead: 1000,
  catalogWrite: 3000,
  inventoryStockLevels: 150,
  inventorySetStock: 2000,
  redis: 50,
} as const;
