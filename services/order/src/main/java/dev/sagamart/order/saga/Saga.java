package dev.sagamart.order.saga;

import static dev.sagamart.order.saga.Transition.ignored;
import static dev.sagamart.order.saga.Transition.to;

import dev.sagamart.order.saga.OrderEvent.OrderCancelled;
import dev.sagamart.order.saga.OrderEvent.OrderConfirmed;
import dev.sagamart.order.saga.SagaEvent.AlreadyCaptured;
import dev.sagamart.order.saga.SagaEvent.InsufficientStock;
import dev.sagamart.order.saga.SagaEvent.IntentCreated;
import dev.sagamart.order.saga.SagaEvent.IntentVoided;
import dev.sagamart.order.saga.SagaEvent.PaymentDeadlinePassed;
import dev.sagamart.order.saga.SagaEvent.PaymentFailed;
import dev.sagamart.order.saga.SagaEvent.PaymentSucceeded;
import dev.sagamart.order.saga.SagaEvent.Refunded;
import dev.sagamart.order.saga.SagaEvent.ReservationExpired;
import dev.sagamart.order.saga.SagaEvent.ReservationNotFound;
import dev.sagamart.order.saga.SagaEvent.ReservationReleased;
import dev.sagamart.order.saga.SagaEvent.RetriesExhausted;
import dev.sagamart.order.saga.SagaEvent.StockCommitted;
import dev.sagamart.order.saga.SagaEvent.StockReserved;
import dev.sagamart.order.saga.SagaState.AwaitingPayment;
import dev.sagamart.order.saga.SagaState.Cancelled;
import dev.sagamart.order.saga.SagaState.Cancelling;
import dev.sagamart.order.saga.SagaState.CommittingStock;
import dev.sagamart.order.saga.SagaState.Completed;
import dev.sagamart.order.saga.SagaState.CreatingPayment;
import dev.sagamart.order.saga.SagaState.NeedsAttention;
import dev.sagamart.order.saga.SagaState.Refunding;
import dev.sagamart.order.saga.SagaState.ReservingStock;
import java.time.Instant;

/**
 * The checkout saga's state machine: RFC-0002 §4.4's transition table as one switch. Pure: no I/O,
 * no clock; persistence, the runner and the consumers (#60, #64) apply it.
 *
 * <p>An event the table doesn't list for a state (a duplicate, a late result of a superseded call,
 * an event overtaken by another) leaves the saga unchanged.
 */
public final class Saga {

  private Saga() {}

  public static Transition apply(SagaState state, SagaEvent event) {
    return switch (state) {
      case ReservingStock _ ->
          switch (event) {
            case StockReserved e -> to(state, event, new CreatingPayment(e.reservationExpiresAt()));
            case InsufficientStock _ -> cancelled(state, event, CancelReason.INSUFFICIENT_STOCK);
            // No intent can exist yet: release only.
            case RetriesExhausted _ ->
                to(state, event, new Cancelling(CancelReason.INVENTORY_UNAVAILABLE, false, false));
            default -> ignored(state, event);
          };
      case CreatingPayment s ->
          switch (event) {
            case IntentCreated e ->
                to(
                    state,
                    event,
                    new AwaitingPayment(
                        s.reservationExpiresAt(),
                        paymentDeadline(s.reservationExpiresAt(), e.expiresAt()),
                        e.paymentUrl()));
            // The intent may exist though its reply was lost: void it anyway.
            case RetriesExhausted _ ->
                to(state, event, new Cancelling(CancelReason.PAYMENT_UNAVAILABLE, true, false));
            // The buyer paid before the intent's reply was recorded.
            case PaymentSucceeded _ -> to(state, event, new CommittingStock());
            default -> ignored(state, event);
          };
      case AwaitingPayment _ ->
          switch (event) {
            case PaymentSucceeded _ -> to(state, event, new CommittingStock());
            case PaymentFailed _ -> cancel(state, event, CancelReason.PAYMENT_FAILED);
            // Void first: the void settles a race with a late payment, with the provider.
            case PaymentDeadlinePassed _ -> cancel(state, event, CancelReason.PAYMENT_TIMEOUT);
            // Shouldn't happen (deadline 8m < TTL 10m); handled anyway.
            case ReservationExpired _ -> cancel(state, event, CancelReason.STOCK_UNAVAILABLE);
            default -> ignored(state, event);
          };
      case CommittingStock _ ->
          switch (event) {
            case StockCommitted _ -> to(state, event, new Completed(), new OrderConfirmed());
            // Money must not stay taken for an unconfirmed order.
            case ReservationNotFound _, RetriesExhausted _ ->
                to(state, event, new Refunding(CancelReason.STOCK_UNAVAILABLE, false, false));
            default -> ignored(state, event);
          };
      case Cancelling s ->
          switch (event) {
            case IntentVoided _ when s.mayHaveIntent() && !s.voided() ->
                to(state, event, new Cancelling(s.reason(), true, true));
            // Paid as the deadline passed. Void runs before release, so the reservation is
            // normally still held: commit it. If it expired, ReservationNotFound refunds.
            case AlreadyCaptured _ when s.mayHaveIntent() && !s.voided() ->
                to(state, event, new CommittingStock());
            case ReservationReleased _ when !s.mayHaveIntent() || s.voided() ->
                cancelled(state, event, s.reason());
            case RetriesExhausted _ -> to(state, event, new NeedsAttention(state));
            default -> ignored(state, event);
          };
      case Refunding s ->
          switch (event) {
            case Refunded _ when !s.refunded() ->
                to(state, event, new Refunding(s.reason(), true, s.cancelPublished()));
            case ReservationReleased _ when s.refunded() ->
                s.cancelPublished()
                    ? to(state, event, new Cancelled(s.reason()))
                    : cancelled(state, event, s.reason());
            case RetriesExhausted _ -> to(state, event, new NeedsAttention(state));
            default -> ignored(state, event);
          };
      case Cancelled s ->
          switch (event) {
            // Defensive: money arrived for a cancelled order. order.cancelled already went out.
            case PaymentSucceeded _ -> to(state, event, new Refunding(s.reason(), false, true));
            default -> ignored(state, event);
          };
      // Terminal, or waiting for an operator: nothing moves it.
      case Completed _, NeedsAttention _ -> ignored(state, event);
    };
  }

  /**
   * Anchored to absolute expiries from the replies, so a slow step can't push the deadline past the
   * reservation: {@code min(reservation_expires_at − 2m, intent expires_at)}.
   */
  static Instant paymentDeadline(Instant reservationExpiresAt, Instant intentExpiresAt) {
    Instant beforeReservation = reservationExpiresAt.minus(SagaState.PAYMENT_MARGIN);
    return intentExpiresAt.isBefore(beforeReservation) ? intentExpiresAt : beforeReservation;
  }

  /** Cancel after payment was asked for: void first, then release. */
  private static Transition cancel(SagaState state, SagaEvent event, CancelReason reason) {
    return to(state, event, new Cancelling(reason, true, false));
  }

  /** First entry to CANCELLED: announce it. */
  private static Transition cancelled(SagaState state, SagaEvent event, CancelReason reason) {
    return to(state, event, new Cancelled(reason), new OrderCancelled(reason));
  }
}
