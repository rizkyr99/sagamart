package dev.sagamart.order.saga;

import dev.sagamart.order.saga.SagaCommand.CommitReservation;
import dev.sagamart.order.saga.SagaCommand.CreatePaymentIntent;
import dev.sagamart.order.saga.SagaCommand.RefundPayment;
import dev.sagamart.order.saga.SagaCommand.ReleaseReservation;
import dev.sagamart.order.saga.SagaCommand.ReserveStock;
import dev.sagamart.order.saga.SagaCommand.VoidPaymentIntent;
import java.time.Duration;
import java.time.Instant;
import java.util.Objects;
import java.util.Optional;

/**
 * Where a checkout saga is (RFC-0002 §4.4). Each state carries only what its rules need, and its
 * pending command follows from it, so a state and its next call are persisted together.
 */
public sealed interface SagaState {

  /** How long Inventory holds a reservation for checkout. */
  Duration RESERVATION_TTL = Duration.ofMinutes(10);

  /** Payment must be over this long before the reservation expires (deadline 8m < TTL 10m). */
  Duration PAYMENT_MARGIN = Duration.ofMinutes(2);

  /** The state's name; mirrors {@code sagamart.order.v1.SagaState}. */
  enum Stage {
    RESERVING_STOCK,
    CREATING_PAYMENT,
    AWAITING_PAYMENT,
    COMMITTING_STOCK,
    COMPLETED,
    CANCELLING,
    REFUNDING,
    CANCELLED,
    NEEDS_ATTENTION
  }

  Stage stage();

  OrderStatus orderStatus();

  /** The call the runner makes next; empty while waiting for an event, and when finished. */
  default Optional<SagaCommand> pendingCommand() {
    return Optional.empty();
  }

  default boolean isTerminal() {
    return false;
  }

  record ReservingStock() implements SagaState {
    @Override
    public Stage stage() {
      return Stage.RESERVING_STOCK;
    }

    @Override
    public OrderStatus orderStatus() {
      return OrderStatus.PENDING;
    }

    @Override
    public Optional<SagaCommand> pendingCommand() {
      return Optional.of(new ReserveStock(RESERVATION_TTL));
    }
  }

  /** {@code reservationExpiresAt} is Inventory's clock, from its reply. */
  record CreatingPayment(Instant reservationExpiresAt) implements SagaState {
    public CreatingPayment {
      Objects.requireNonNull(reservationExpiresAt);
    }

    @Override
    public Stage stage() {
      return Stage.CREATING_PAYMENT;
    }

    @Override
    public OrderStatus orderStatus() {
      return OrderStatus.PENDING;
    }

    @Override
    public Optional<SagaCommand> pendingCommand() {
      return Optional.of(new CreatePaymentIntent(reservationExpiresAt.minus(PAYMENT_MARGIN)));
    }
  }

  /** Waits for {@code payment.*} or for the deadline scan. */
  record AwaitingPayment(Instant reservationExpiresAt, Instant paymentDeadline, String paymentUrl)
      implements SagaState {
    public AwaitingPayment {
      Objects.requireNonNull(reservationExpiresAt);
      Objects.requireNonNull(paymentDeadline);
      Objects.requireNonNull(paymentUrl);
    }

    @Override
    public Stage stage() {
      return Stage.AWAITING_PAYMENT;
    }

    @Override
    public OrderStatus orderStatus() {
      return OrderStatus.AWAITING_PAYMENT;
    }
  }

  record CommittingStock() implements SagaState {
    @Override
    public Stage stage() {
      return Stage.COMMITTING_STOCK;
    }

    @Override
    public OrderStatus orderStatus() {
      return OrderStatus.PAID;
    }

    @Override
    public Optional<SagaCommand> pendingCommand() {
      return Optional.of(new CommitReservation());
    }
  }

  record Completed() implements SagaState {
    @Override
    public Stage stage() {
      return Stage.COMPLETED;
    }

    @Override
    public OrderStatus orderStatus() {
      return OrderStatus.CONFIRMED;
    }

    @Override
    public boolean isTerminal() {
      return true;
    }
  }

  /**
   * Void (if an intent may exist), then release.
   *
   * @param mayHaveIntent false only when cancelling before an intent was asked for; an intent whose
   *     creation gave up may still exist, so it is voided too
   * @param voided the void is done (or there was nothing to void); release is next
   */
  record Cancelling(CancelReason reason, boolean mayHaveIntent, boolean voided)
      implements SagaState {
    public Cancelling {
      Objects.requireNonNull(reason);
    }

    @Override
    public Stage stage() {
      return Stage.CANCELLING;
    }

    @Override
    public OrderStatus orderStatus() {
      return OrderStatus.CANCELLED;
    }

    @Override
    public Optional<SagaCommand> pendingCommand() {
      return Optional.of(
          mayHaveIntent && !voided ? new VoidPaymentIntent() : new ReleaseReservation());
    }
  }

  /**
   * Refund, then release if the reservation is still held (release is a no-op if not).
   *
   * @param cancelPublished {@code order.cancelled} already went out: this refund is for a payment
   *     that arrived after the order was cancelled, so reaching CANCELLED again publishes nothing
   */
  record Refunding(CancelReason reason, boolean refunded, boolean cancelPublished)
      implements SagaState {
    public Refunding {
      Objects.requireNonNull(reason);
    }

    @Override
    public Stage stage() {
      return Stage.REFUNDING;
    }

    @Override
    public OrderStatus orderStatus() {
      return OrderStatus.CANCELLED;
    }

    @Override
    public Optional<SagaCommand> pendingCommand() {
      return Optional.of(refunded ? new ReleaseReservation() : new RefundPayment());
    }
  }

  record Cancelled(CancelReason reason) implements SagaState {
    public Cancelled {
      Objects.requireNonNull(reason);
    }

    @Override
    public Stage stage() {
      return Stage.CANCELLED;
    }

    @Override
    public OrderStatus orderStatus() {
      return OrderStatus.CANCELLED;
    }

    @Override
    public boolean isTerminal() {
      return true;
    }
  }

  /** A compensation exhausted its budget in {@code stuckIn}; listed for an operator. */
  record NeedsAttention(SagaState stuckIn) implements SagaState {
    public NeedsAttention {
      Objects.requireNonNull(stuckIn);
    }

    @Override
    public Stage stage() {
      return Stage.NEEDS_ATTENTION;
    }

    /** Unchanged: the order keeps the status of the state it got stuck in. */
    @Override
    public OrderStatus orderStatus() {
      return stuckIn.orderStatus();
    }
  }
}
