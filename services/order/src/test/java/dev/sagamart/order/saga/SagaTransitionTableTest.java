package dev.sagamart.order.saga;

import static dev.sagamart.order.saga.CancelReason.INSUFFICIENT_STOCK;
import static dev.sagamart.order.saga.CancelReason.INVENTORY_UNAVAILABLE;
import static dev.sagamart.order.saga.CancelReason.PAYMENT_FAILED;
import static dev.sagamart.order.saga.CancelReason.PAYMENT_TIMEOUT;
import static dev.sagamart.order.saga.CancelReason.PAYMENT_UNAVAILABLE;
import static dev.sagamart.order.saga.CancelReason.STOCK_UNAVAILABLE;
import static org.assertj.core.api.Assertions.assertThat;

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
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

/**
 * RFC-0002 §4.4, the transition table, as data. Each row is one test, and every (state, event) pair
 * that no row names must leave the saga unchanged, so a transition cannot exist only in the code or
 * only in the table. Rows marked † are the late and out-of-order arrivals.
 */
class SagaTransitionTableTest {

  static final Instant RESERVATION_EXPIRES = Instant.parse("2026-10-29T10:10:00Z");
  static final Instant DEADLINE = RESERVATION_EXPIRES.minus(Duration.ofMinutes(2));
  static final String URL = "https://pay.example/s/1";

  // ---- States, with every data variant the rules distinguish ----

  static final ReservingStock RESERVING = new ReservingStock();
  static final CreatingPayment CREATING = new CreatingPayment(RESERVATION_EXPIRES);
  static final AwaitingPayment AWAITING = new AwaitingPayment(RESERVATION_EXPIRES, DEADLINE, URL);
  static final CommittingStock COMMITTING = new CommittingStock();
  static final Completed COMPLETED = new Completed();

  /** Cancelled before any intent was asked for: release only. */
  static final Cancelling CANCELLING_RELEASE_ONLY =
      new Cancelling(INVENTORY_UNAVAILABLE, false, false);

  static final Cancelling CANCELLING_TO_VOID = new Cancelling(PAYMENT_TIMEOUT, true, false);
  static final Cancelling CANCELLING_VOIDED = new Cancelling(PAYMENT_TIMEOUT, true, true);

  static final Refunding REFUNDING_TO_REFUND = new Refunding(STOCK_UNAVAILABLE, false, false);
  static final Refunding REFUNDING_REFUNDED = new Refunding(STOCK_UNAVAILABLE, true, false);

  /** Refunding a payment that arrived after the order was already cancelled and announced. */
  static final Refunding REFUNDING_AFTER_CANCEL = new Refunding(PAYMENT_TIMEOUT, false, true);

  static final Refunding REFUNDING_AFTER_CANCEL_REFUNDED =
      new Refunding(PAYMENT_TIMEOUT, true, true);

  static final Cancelled CANCELLED = new Cancelled(PAYMENT_TIMEOUT);
  static final NeedsAttention STUCK = new NeedsAttention(CANCELLING_VOIDED);

  static final List<SagaState> STATES =
      List.of(
          RESERVING,
          CREATING,
          AWAITING,
          COMMITTING,
          COMPLETED,
          CANCELLING_RELEASE_ONLY,
          CANCELLING_TO_VOID,
          CANCELLING_VOIDED,
          REFUNDING_TO_REFUND,
          REFUNDING_REFUNDED,
          REFUNDING_AFTER_CANCEL,
          REFUNDING_AFTER_CANCEL_REFUNDED,
          CANCELLED,
          STUCK,
          new NeedsAttention(COMMITTING));

  static final List<SagaEvent> EVENTS =
      List.of(
          new StockReserved(RESERVATION_EXPIRES),
          new InsufficientStock(),
          new IntentCreated(URL, DEADLINE),
          new StockCommitted(),
          new ReservationNotFound(),
          new IntentVoided(),
          new AlreadyCaptured(),
          new ReservationReleased(),
          new Refunded(),
          new RetriesExhausted(),
          new PaymentSucceeded(),
          new PaymentFailed(),
          new ReservationExpired(),
          new PaymentDeadlinePassed());

  record Row(SagaState from, SagaEvent event, SagaState to, List<OrderEvent> publish, String note) {

    @Override
    public String toString() {
      return from.stage()
          + " + "
          + event.getClass().getSimpleName()
          + " → "
          + to.stage()
          + ": "
          + note;
    }
  }

  static final List<Row> TABLE = table();

  private static List<Row> table() {
    List<Row> rows = new ArrayList<>();
    rows.add(
        row(
            RESERVING,
            new StockReserved(RESERVATION_EXPIRES),
            CREATING,
            "stores reservation_expires_at from Inventory's reply"));
    rows.add(
        row(
            RESERVING,
            new InsufficientStock(),
            new Cancelled(INSUFFICIENT_STOCK),
            List.of(new OrderCancelled(INSUFFICIENT_STOCK)),
            "reason=INSUFFICIENT_STOCK; nothing to compensate"));
    rows.add(
        row(
            RESERVING,
            new RetriesExhausted(),
            new Cancelling(INVENTORY_UNAVAILABLE, false, false),
            "reason=INVENTORY_UNAVAILABLE; release only, a no-op if nothing was reserved"));
    rows.add(
        row(
            CREATING,
            new IntentCreated(URL, DEADLINE),
            new AwaitingPayment(RESERVATION_EXPIRES, DEADLINE, URL),
            "stores payment_url; payment_deadline = min(reservation − 2m, intent expiry)"));
    rows.add(
        row(
            CREATING,
            new IntentCreated(URL, DEADLINE.minus(Duration.ofMinutes(3))),
            new AwaitingPayment(RESERVATION_EXPIRES, DEADLINE.minus(Duration.ofMinutes(3)), URL),
            "an intent expiring sooner than the reservation sets the deadline"));
    rows.add(
        row(
            CREATING,
            new IntentCreated(URL, RESERVATION_EXPIRES.plus(Duration.ofMinutes(5))),
            new AwaitingPayment(RESERVATION_EXPIRES, DEADLINE, URL),
            "an intent outliving the reservation can't push the deadline past it"));
    rows.add(
        row(
            CREATING,
            new RetriesExhausted(),
            new Cancelling(PAYMENT_UNAVAILABLE, true, false),
            "reason=PAYMENT_UNAVAILABLE; void anyway, the intent may exist"));
    rows.add(
        row(
            CREATING,
            new PaymentSucceeded(),
            COMMITTING,
            "† the buyer paid before the intent's reply was recorded"));
    rows.add(row(AWAITING, new PaymentSucceeded(), COMMITTING, "paid"));
    rows.add(
        row(
            AWAITING,
            new PaymentFailed(),
            new Cancelling(PAYMENT_FAILED, true, false),
            "reason=PAYMENT_FAILED"));
    rows.add(
        row(
            AWAITING,
            new PaymentDeadlinePassed(),
            new Cancelling(PAYMENT_TIMEOUT, true, false),
            "reason=PAYMENT_TIMEOUT; void first"));
    rows.add(
        row(
            AWAITING,
            new ReservationExpired(),
            new Cancelling(STOCK_UNAVAILABLE, true, false),
            "† reason=STOCK_UNAVAILABLE; shouldn't happen (deadline 8m < TTL 10m), handled"));
    rows.add(
        row(
            COMMITTING,
            new StockCommitted(),
            COMPLETED,
            List.of(new OrderConfirmed()),
            "order.confirmed"));
    rows.add(
        row(
            COMMITTING,
            new ReservationNotFound(),
            new Refunding(STOCK_UNAVAILABLE, false, false),
            "reason=STOCK_UNAVAILABLE"));
    rows.add(
        row(
            COMMITTING,
            new RetriesExhausted(),
            new NeedsAttention(COMMITTING),
            "the commit may have happened: never refund a sale; an operator looks (still PAID)"));
    rows.add(row(CANCELLING_TO_VOID, new IntentVoided(), CANCELLING_VOIDED, "then release"));
    rows.add(
        row(
            CANCELLING_TO_VOID,
            new AlreadyCaptured(),
            COMMITTING,
            "† the buyer paid as the deadline passed: try to commit"));
    rows.add(
        row(
            CANCELLING_VOIDED,
            new ReservationReleased(),
            new Cancelled(PAYMENT_TIMEOUT),
            List.of(new OrderCancelled(PAYMENT_TIMEOUT)),
            "order.cancelled with the reason"));
    rows.add(
        row(
            CANCELLING_RELEASE_ONLY,
            new ReservationReleased(),
            new Cancelled(INVENTORY_UNAVAILABLE),
            List.of(new OrderCancelled(INVENTORY_UNAVAILABLE)),
            "nothing to void: released, then cancelled"));
    for (SagaState compensating :
        List.of(
            CANCELLING_RELEASE_ONLY,
            CANCELLING_TO_VOID,
            CANCELLING_VOIDED,
            REFUNDING_TO_REFUND,
            REFUNDING_REFUNDED,
            REFUNDING_AFTER_CANCEL,
            REFUNDING_AFTER_CANCEL_REFUNDED)) {
      rows.add(
          row(
              compensating,
              new RetriesExhausted(),
              new NeedsAttention(compensating),
              "budget exhausted: an operator must look"));
    }
    rows.add(row(REFUNDING_TO_REFUND, new Refunded(), REFUNDING_REFUNDED, "then release"));
    rows.add(
        row(
            REFUNDING_AFTER_CANCEL,
            new Refunded(),
            REFUNDING_AFTER_CANCEL_REFUNDED,
            "then release"));
    rows.add(
        row(
            REFUNDING_REFUNDED,
            new ReservationReleased(),
            new Cancelled(STOCK_UNAVAILABLE),
            List.of(new OrderCancelled(STOCK_UNAVAILABLE)),
            "then CANCELLED, announced"));
    rows.add(
        row(
            REFUNDING_AFTER_CANCEL_REFUNDED,
            new ReservationReleased(),
            CANCELLED,
            "then CANCELLED again: order.cancelled only on the first entry"));
    rows.add(
        row(
            CANCELLED,
            new PaymentSucceeded(),
            REFUNDING_AFTER_CANCEL,
            "† defensive: money arrived for a cancelled order"));
    return List.copyOf(rows);
  }

  private static Row row(SagaState from, SagaEvent event, SagaState to, String note) {
    return row(from, event, to, List.of(), note);
  }

  private static Row row(
      SagaState from, SagaEvent event, SagaState to, List<OrderEvent> publish, String note) {
    return new Row(from, event, to, publish, note);
  }

  @TestFactory
  Stream<DynamicTest> everyRowOfTheTable() {
    return TABLE.stream()
        .map(
            row ->
                DynamicTest.dynamicTest(
                    row.toString(),
                    () -> {
                      Transition t = Saga.apply(row.from(), row.event());
                      assertThat(t.to()).isEqualTo(row.to());
                      assertThat(t.publish()).isEqualTo(row.publish());
                      assertThat(t.applied()).isTrue();
                    }));
  }

  /** "Any terminal: duplicate or stale event → unchanged", generalised to every unlisted pair. */
  @TestFactory
  Stream<DynamicTest> everyOtherPairIsIgnored() {
    return STATES.stream()
        .flatMap(
            state ->
                EVENTS.stream()
                    .filter(event -> !listed(state, event))
                    .map(
                        event ->
                            DynamicTest.dynamicTest(
                                state + " + " + event.getClass().getSimpleName() + " → unchanged",
                                () -> {
                                  Transition t = Saga.apply(state, event);
                                  assertThat(t.to()).isEqualTo(state);
                                  assertThat(t.publish()).isEmpty();
                                  assertThat(t.applied()).isFalse();
                                })));
  }

  private static boolean listed(SagaState state, SagaEvent event) {
    return TABLE.stream()
        .anyMatch(row -> row.from().equals(state) && row.event().getClass() == event.getClass());
  }
}
