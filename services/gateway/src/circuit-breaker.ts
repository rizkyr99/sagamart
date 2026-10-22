export type BreakerState = 'closed' | 'open' | 'half-open';

/**
 * A circuit breaker for calls to one dependency (RFC-0005 §4.5). After `failureThreshold` consecutive failures it
 * opens and refuses calls for `openMs`, so a down service gets no traffic and callers fail fast; then it lets one
 * trial call through, closing on success and re-opening on failure.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private trialInFlight = false;

  constructor(private readonly options: { failureThreshold: number; openMs: number; now?: () => number }) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  state(): BreakerState {
    if (this.openedAt === null) return 'closed';
    return this.now() - this.openedAt >= this.options.openMs ? 'half-open' : 'open';
  }

  /** Whether a call may go ahead; when not, how long until the breaker tries again. */
  allow(): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const state = this.state();
    if (state === 'closed') return { allowed: true };
    if (state === 'half-open' && !this.trialInFlight) {
      this.trialInFlight = true;
      return { allowed: true };
    }
    const openedAt = this.openedAt ?? this.now();
    return { allowed: false, retryAfterMs: Math.max(0, openedAt + this.options.openMs - this.now()) };
  }

  success(): void {
    this.failures = 0;
    this.openedAt = null;
    this.trialInFlight = false;
  }

  failure(): void {
    this.trialInFlight = false;
    if (this.openedAt !== null) {
      // The trial failed (or a call that started before opening): a full open period again.
      this.openedAt = this.now();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.options.failureThreshold) this.openedAt = this.now();
  }
}
