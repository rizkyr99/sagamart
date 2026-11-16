package dev.sagamart.order.store;

import static org.assertj.core.api.Assertions.assertThat;

import dev.sagamart.order.saga.CancelReason;
import dev.sagamart.order.saga.OrderStatus;
import dev.sagamart.order.saga.SagaCommand;
import dev.sagamart.order.saga.SagaCommand.CommitReservation;
import dev.sagamart.order.saga.SagaCommand.CreatePaymentIntent;
import dev.sagamart.order.saga.SagaCommand.RefundPayment;
import dev.sagamart.order.saga.SagaCommand.ReleaseReservation;
import dev.sagamart.order.saga.SagaCommand.ReserveStock;
import dev.sagamart.order.saga.SagaCommand.VoidPaymentIntent;
import dev.sagamart.order.saga.SagaState;
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
import java.util.stream.Stream;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import tools.jackson.databind.json.JsonMapper;

class SagaColumnsTest {

  static final Instant RESERVATION_EXPIRES = Instant.parse("2026-11-16T10:10:00Z");
  static final JsonMapper JSON = JsonMapper.builder().build();

  /** One of every state, and every field value that changes what the state does next. */
  static Stream<SagaState> states() {
    Refunding refundingAfterCancel = new Refunding(CancelReason.PAYMENT_TIMEOUT, false, true);
    return Stream.of(
        new ReservingStock(),
        new CreatingPayment(RESERVATION_EXPIRES),
        new AwaitingPayment(
            RESERVATION_EXPIRES,
            RESERVATION_EXPIRES.minus(Duration.ofMinutes(2)),
            "https://pay.example/s/1"),
        new CommittingStock(),
        new Completed(),
        new Cancelling(CancelReason.PAYMENT_FAILED, true, false),
        new Cancelling(CancelReason.PAYMENT_FAILED, true, true),
        new Cancelling(CancelReason.INVENTORY_UNAVAILABLE, false, false),
        new Refunding(CancelReason.STOCK_UNAVAILABLE, false, false),
        new Refunding(CancelReason.STOCK_UNAVAILABLE, true, false),
        refundingAfterCancel,
        new Cancelled(CancelReason.INSUFFICIENT_STOCK),
        new NeedsAttention(new CommittingStock()),
        new NeedsAttention(new Cancelling(CancelReason.PAYMENT_TIMEOUT, true, false)),
        new NeedsAttention(refundingAfterCancel));
  }

  @ParameterizedTest
  @MethodSource("states")
  void aStateReadsBackAsWritten(SagaState state) {
    SagaColumns columns = SagaColumns.of(state);
    // Through JSON text, as the database stores it.
    var detail = JSON.readTree(JSON.writeValueAsString(columns.detail()));

    assertThat(columns.stage()).isEqualTo(state.stage());
    assertThat(
            SagaColumns.toState(
                columns.stage(), detail, columns.reservationExpiresAt(), columns.paymentDeadline()))
        .isEqualTo(state);
  }

  @ParameterizedTest
  @MethodSource("states")
  void theCancelReasonIsSetExactlyWhenTheOrderIsCancelled(SagaState state) {
    assertThat(SagaColumns.cancelReason(state) != null)
        .isEqualTo(state.orderStatus() == OrderStatus.CANCELLED);
  }

  @ParameterizedTest
  @MethodSource("states")
  void theCancellationIsMarkedPublishedOnceCancelledHasBeenReached(SagaState state) {
    SagaState own = state instanceof NeedsAttention n ? n.stuckIn() : state;
    boolean announced =
        own instanceof Cancelled || (own instanceof Refunding r && r.cancelPublished());
    assertThat(SagaColumns.cancelPublished(state)).isEqualTo(announced);
  }

  static Stream<SagaCommand> commands() {
    return Stream.of(
        new ReserveStock(Duration.ofMinutes(10)),
        new CreatePaymentIntent(RESERVATION_EXPIRES.minus(Duration.ofMinutes(2))),
        new CommitReservation(),
        new VoidPaymentIntent(),
        new ReleaseReservation(),
        new RefundPayment());
  }

  @ParameterizedTest
  @MethodSource("commands")
  void aCommandReadsBackAsWritten(SagaCommand command) {
    var stored = JSON.readTree(JSON.writeValueAsString(SagaColumns.command(command)));
    assertThat(SagaColumns.toCommand(stored)).isEqualTo(command);
  }
}
