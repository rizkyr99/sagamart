package dev.sagamart.order.saga;

import java.time.Instant;

/**
 * What happens to a saga: the result of the command it was waiting for, or an event consumed from
 * another service (RFC-0002 §4.4: "Event is either a command's result or a consumed event").
 */
public sealed interface SagaEvent {

  // ---- Command results ----

  /** Inventory reserved every line; {@code reservationExpiresAt} is Inventory's clock. */
  record StockReserved(Instant reservationExpiresAt) implements SagaEvent {}

  record InsufficientStock() implements SagaEvent {}

  record IntentCreated(String paymentUrl, Instant expiresAt) implements SagaEvent {}

  record StockCommitted() implements SagaEvent {}

  record ReservationNotFound() implements SagaEvent {}

  /** Voided, or there was no intent to void. */
  record IntentVoided() implements SagaEvent {}

  /** The void found the payment captured: the buyer paid as the deadline passed. */
  record AlreadyCaptured() implements SagaEvent {}

  /** Released, or there was nothing to release. */
  record ReservationReleased() implements SagaEvent {}

  record Refunded() implements SagaEvent {}

  /**
   * The pending command gave up: retries exhausted for a forward step, budget exhausted for a
   * compensation (RFC-0002 §4.6).
   */
  record RetriesExhausted() implements SagaEvent {}

  // ---- Consumed events and the deadline scan ----

  /** {@code payment.succeeded}. */
  record PaymentSucceeded() implements SagaEvent {}

  /** {@code payment.failed}. */
  record PaymentFailed() implements SagaEvent {}

  /** {@code inventory.reservation.expired}. */
  record ReservationExpired() implements SagaEvent {}

  /** The deadline scan found the saga awaiting payment past {@code payment_deadline}. */
  record PaymentDeadlinePassed() implements SagaEvent {}
}
