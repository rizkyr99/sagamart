package dev.sagamart.order.runner;

import dev.sagamart.order.saga.SagaCommand;
import dev.sagamart.order.saga.SagaCommand.CreatePaymentIntent;
import dev.sagamart.order.saga.SagaCommand.ReserveStock;
import java.time.Duration;
import java.util.Optional;
import java.util.random.RandomGenerator;

/**
 * When to try a failed call again (RFC-0002 §4.6). A forward step retries a few times, then the
 * saga cancels. A compensation, and CommitReservation (the buyer has paid, so its outcome must
 * become definitive), retries until its time budget runs out, then the saga needs attention.
 *
 * <p>Backoff doubles from {@code base} up to {@code max}, with ±20% jitter so retries of many sagas
 * don't arrive together.
 */
public record RetryPolicy(
    int forwardRetries,
    Duration base,
    Duration max,
    Duration compensationBudget,
    RandomGenerator random) {

  /**
   * How long to wait before the next try, or empty when the command has given up.
   *
   * @param failedTries tries of this command that have failed, including the one just made
   * @param pendingFor how long the command has been pending
   */
  public Optional<Duration> backoff(SagaCommand command, int failedTries, Duration pendingFor) {
    boolean forward = command instanceof ReserveStock || command instanceof CreatePaymentIntent;
    boolean givesUp =
        forward ? failedTries > forwardRetries : pendingFor.compareTo(compensationBudget) >= 0;
    if (givesUp) {
      return Optional.empty();
    }
    return Optional.of(jittered(doubled(failedTries)));
  }

  private Duration doubled(int failedTries) {
    // Capped before shifting, so a long retry run can't overflow.
    int doublings = Math.min(failedTries - 1, 30);
    Duration d = base.multipliedBy(1L << doublings);
    return d.compareTo(max) > 0 ? max : d;
  }

  private Duration jittered(Duration d) {
    double factor = 0.8 + 0.4 * random.nextDouble();
    return Duration.ofMillis(Math.round(d.toMillis() * factor));
  }
}
