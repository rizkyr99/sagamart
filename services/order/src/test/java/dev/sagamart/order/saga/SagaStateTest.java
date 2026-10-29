package dev.sagamart.order.saga;

import static dev.sagamart.order.saga.SagaTransitionTableTest.AWAITING;
import static dev.sagamart.order.saga.SagaTransitionTableTest.CANCELLED;
import static dev.sagamart.order.saga.SagaTransitionTableTest.CANCELLING_RELEASE_ONLY;
import static dev.sagamart.order.saga.SagaTransitionTableTest.CANCELLING_TO_VOID;
import static dev.sagamart.order.saga.SagaTransitionTableTest.CANCELLING_VOIDED;
import static dev.sagamart.order.saga.SagaTransitionTableTest.COMMITTING;
import static dev.sagamart.order.saga.SagaTransitionTableTest.COMPLETED;
import static dev.sagamart.order.saga.SagaTransitionTableTest.CREATING;
import static dev.sagamart.order.saga.SagaTransitionTableTest.REFUNDING_AFTER_CANCEL;
import static dev.sagamart.order.saga.SagaTransitionTableTest.REFUNDING_REFUNDED;
import static dev.sagamart.order.saga.SagaTransitionTableTest.REFUNDING_TO_REFUND;
import static dev.sagamart.order.saga.SagaTransitionTableTest.RESERVATION_EXPIRES;
import static dev.sagamart.order.saga.SagaTransitionTableTest.RESERVING;
import static dev.sagamart.order.saga.SagaTransitionTableTest.STUCK;
import static org.assertj.core.api.Assertions.assertThat;

import dev.sagamart.order.saga.SagaCommand.CommitReservation;
import dev.sagamart.order.saga.SagaCommand.CreatePaymentIntent;
import dev.sagamart.order.saga.SagaCommand.RefundPayment;
import dev.sagamart.order.saga.SagaCommand.ReleaseReservation;
import dev.sagamart.order.saga.SagaCommand.ReserveStock;
import dev.sagamart.order.saga.SagaCommand.VoidPaymentIntent;
import dev.sagamart.order.saga.SagaState.NeedsAttention;
import java.time.Duration;
import java.util.Arrays;
import java.util.Optional;
import java.util.function.Function;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

class SagaStateTest {

  /** RFC-0002 §4.4, the first table: saga state, order status, pending command. */
  static Stream<Arguments> states() {
    return Stream.of(
        Arguments.of(RESERVING, OrderStatus.PENDING, new ReserveStock(Duration.ofMinutes(10))),
        Arguments.of(
            CREATING,
            OrderStatus.PENDING,
            new CreatePaymentIntent(RESERVATION_EXPIRES.minus(Duration.ofMinutes(2)))),
        Arguments.of(AWAITING, OrderStatus.AWAITING_PAYMENT, null),
        Arguments.of(COMMITTING, OrderStatus.PAID, new CommitReservation()),
        Arguments.of(COMPLETED, OrderStatus.CONFIRMED, null),
        Arguments.of(CANCELLING_TO_VOID, OrderStatus.CANCELLED, new VoidPaymentIntent()),
        Arguments.of(CANCELLING_VOIDED, OrderStatus.CANCELLED, new ReleaseReservation()),
        Arguments.of(CANCELLING_RELEASE_ONLY, OrderStatus.CANCELLED, new ReleaseReservation()),
        Arguments.of(REFUNDING_TO_REFUND, OrderStatus.CANCELLED, new RefundPayment()),
        Arguments.of(REFUNDING_REFUNDED, OrderStatus.CANCELLED, new ReleaseReservation()),
        Arguments.of(CANCELLED, OrderStatus.CANCELLED, null),
        // Unchanged: the status of the state it got stuck in.
        Arguments.of(STUCK, OrderStatus.CANCELLED, null),
        Arguments.of(new NeedsAttention(REFUNDING_AFTER_CANCEL), OrderStatus.CANCELLED, null));
  }

  @ParameterizedTest(name = "{0}: {1}, {2}")
  @MethodSource("states")
  void mapsToOrderStatusAndPendingCommand(
      SagaState state, OrderStatus status, SagaCommand command) {
    assertThat(state.orderStatus()).isEqualTo(status);
    assertThat(state.pendingCommand()).isEqualTo(Optional.ofNullable(command));
  }

  @Test
  void onlyCompletedAndCancelledAreTerminal() {
    assertThat(
            Stream.of(
                    RESERVING,
                    CREATING,
                    AWAITING,
                    COMMITTING,
                    COMPLETED,
                    CANCELLING_TO_VOID,
                    REFUNDING_TO_REFUND,
                    CANCELLED,
                    STUCK)
                .filter(SagaState::isTerminal))
        .containsExactly(COMPLETED, CANCELLED);
  }

  /** The domain enums mirror sagamart.order.v1, so the API mapping (#60) is name for name. */
  @Test
  void enumsMatchTheContract() {
    assertThat(names(SagaState.Stage.values(), Enum::name))
        .isEqualTo(protoNames(dev.sagamart.contracts.order.v1.SagaState.values(), "SAGA_STATE_"));
    assertThat(names(OrderStatus.values(), Enum::name))
        .isEqualTo(
            protoNames(dev.sagamart.contracts.order.v1.OrderStatus.values(), "ORDER_STATUS_"));
    assertThat(names(CancelReason.values(), Enum::name))
        .isEqualTo(
            protoNames(dev.sagamart.contracts.order.v1.CancelReason.values(), "CANCEL_REASON_"));
  }

  private static <E> String names(E[] values, Function<E, String> name) {
    return Arrays.stream(values).map(name).collect(Collectors.joining(","));
  }

  private static String protoNames(Enum<?>[] values, String prefix) {
    return Arrays.stream(values)
        .map(Enum::name)
        .filter(n -> !n.equals("UNRECOGNIZED") && !n.endsWith("_UNSPECIFIED"))
        .map(n -> n.substring(prefix.length()))
        .collect(Collectors.joining(","));
  }
}
