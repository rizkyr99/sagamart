package dev.sagamart.order.saga;

import java.time.Duration;
import java.time.Instant;

/**
 * The call a saga waits on. The order ID, its lines and the idempotency keys come from the order
 * when the runner executes it; every downstream call is idempotent on them (RFC-0002 §4.7).
 */
public sealed interface SagaCommand {

  record ReserveStock(Duration ttl) implements SagaCommand {}

  record CreatePaymentIntent(Instant expiresAt) implements SagaCommand {}

  record CommitReservation() implements SagaCommand {}

  record VoidPaymentIntent() implements SagaCommand {}

  record ReleaseReservation() implements SagaCommand {}

  record RefundPayment() implements SagaCommand {}
}
