package dev.sagamart.order.runner;

import static org.assertj.core.api.Assertions.assertThat;

import dev.sagamart.order.saga.SagaCommand;
import dev.sagamart.order.saga.SagaCommand.CommitReservation;
import dev.sagamart.order.saga.SagaCommand.CreatePaymentIntent;
import dev.sagamart.order.saga.SagaCommand.RefundPayment;
import dev.sagamart.order.saga.SagaCommand.ReleaseReservation;
import dev.sagamart.order.saga.SagaCommand.ReserveStock;
import dev.sagamart.order.saga.SagaCommand.VoidPaymentIntent;
import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import java.util.random.RandomGenerator;
import java.util.stream.IntStream;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

/** RFC-0002 §4.6's retry rules. */
class RetryPolicyTest {

  /** nextDouble() is 0.5, so the jitter factor is exactly 1. */
  static final RandomGenerator MIDDLE = () -> Long.MIN_VALUE;

  static final Duration NO_TIME = Duration.ZERO;

  final RetryPolicy policy =
      new RetryPolicy(
          3, Duration.ofSeconds(1), Duration.ofSeconds(30), Duration.ofMinutes(15), MIDDLE);

  static Stream<SagaCommand> forward() {
    return Stream.of(
        new ReserveStock(Duration.ofMinutes(10)), new CreatePaymentIntent(Instant.EPOCH));
  }

  @ParameterizedTest
  @MethodSource("forward")
  void aForwardStepRetriesThreeTimesAfter1And2And4Seconds(SagaCommand command) {
    assertThat(IntStream.rangeClosed(1, 4).mapToObj(n -> policy.backoff(command, n, NO_TIME)))
        .containsExactly(
            Optional.of(Duration.ofSeconds(1)),
            Optional.of(Duration.ofSeconds(2)),
            Optional.of(Duration.ofSeconds(4)),
            Optional.empty());
  }

  /** The compensations, and CommitReservation: the buyer paid, so its outcome must be known. */
  static Stream<SagaCommand> untilTheBudget() {
    return Stream.of(
        new CommitReservation(),
        new VoidPaymentIntent(),
        new ReleaseReservation(),
        new RefundPayment());
  }

  @ParameterizedTest
  @MethodSource("untilTheBudget")
  void aCompensationRetriesForFifteenMinutesBackingOffUpTo30Seconds(SagaCommand command) {
    assertThat(policy.backoff(command, 1, NO_TIME)).contains(Duration.ofSeconds(1));
    assertThat(policy.backoff(command, 5, NO_TIME)).contains(Duration.ofSeconds(16));
    assertThat(policy.backoff(command, 6, NO_TIME)).contains(Duration.ofSeconds(30));
    assertThat(policy.backoff(command, 1_000, Duration.ofMinutes(14).plusSeconds(59)))
        .contains(Duration.ofSeconds(30));
    assertThat(policy.backoff(command, 40, Duration.ofMinutes(15))).isEmpty();
  }

  @Test
  void jitterSpreadsRetriesByUpToTwentyPercent() {
    RetryPolicy low =
        new RetryPolicy(
            3, Duration.ofSeconds(10), Duration.ofSeconds(30), Duration.ofMinutes(15), () -> 0L);
    RetryPolicy high =
        new RetryPolicy(
            3, Duration.ofSeconds(10), Duration.ofSeconds(30), Duration.ofMinutes(15), () -> -1L);
    ReleaseReservation release = new ReleaseReservation();

    assertThat(low.backoff(release, 1, NO_TIME)).contains(Duration.ofSeconds(8));
    assertThat(high.backoff(release, 1, NO_TIME).orElseThrow())
        .isBetween(Duration.ofMillis(11_999), Duration.ofSeconds(12));
  }
}
