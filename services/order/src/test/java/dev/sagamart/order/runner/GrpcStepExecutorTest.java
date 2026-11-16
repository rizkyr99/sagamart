package dev.sagamart.order.runner;

import static dev.sagamart.order.runner.FakeDependencies.PAYMENT_URL;
import static dev.sagamart.order.runner.FakeDependencies.RESERVATION_EXPIRES;
import static dev.sagamart.order.runner.FakeDependencies.domainError;
import static dev.sagamart.order.runner.FakeDependencies.status;
import static org.assertj.core.api.Assertions.assertThat;

import com.google.rpc.Code;
import dev.sagamart.contracts.inventory.v1.InventoryServiceGrpc;
import dev.sagamart.contracts.inventory.v1.ReleaseReason;
import dev.sagamart.contracts.inventory.v1.ReleaseReservationRequest;
import dev.sagamart.contracts.inventory.v1.ReserveStockRequest;
import dev.sagamart.contracts.payment.v1.CreatePaymentIntentRequest;
import dev.sagamart.contracts.payment.v1.PaymentServiceGrpc;
import dev.sagamart.contracts.payment.v1.RefundPaymentRequest;
import dev.sagamart.order.runner.StepOutcome.Done;
import dev.sagamart.order.runner.StepOutcome.Failed;
import dev.sagamart.order.runner.StepOutcome.Retryable;
import dev.sagamart.order.saga.CancelReason;
import dev.sagamart.order.saga.SagaCommand.CommitReservation;
import dev.sagamart.order.saga.SagaCommand.CreatePaymentIntent;
import dev.sagamart.order.saga.SagaCommand.RefundPayment;
import dev.sagamart.order.saga.SagaCommand.ReleaseReservation;
import dev.sagamart.order.saga.SagaCommand.ReserveStock;
import dev.sagamart.order.saga.SagaCommand.VoidPaymentIntent;
import dev.sagamart.order.saga.SagaEvent.AlreadyCaptured;
import dev.sagamart.order.saga.SagaEvent.InsufficientStock;
import dev.sagamart.order.saga.SagaEvent.IntentCreated;
import dev.sagamart.order.saga.SagaEvent.IntentVoided;
import dev.sagamart.order.saga.SagaEvent.Refunded;
import dev.sagamart.order.saga.SagaEvent.ReservationNotFound;
import dev.sagamart.order.saga.SagaEvent.ReservationReleased;
import dev.sagamart.order.saga.SagaEvent.StockCommitted;
import dev.sagamart.order.saga.SagaEvent.StockReserved;
import dev.sagamart.order.store.NewOrder.Line;
import dev.sagamart.order.store.SagaStore.StepInput;
import io.grpc.Status;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/** Each command as the call its contract describes, and each answer as the saga event it means. */
class GrpcStepExecutorTest {

  static final String INVENTORY = GrpcStepExecutor.INVENTORY_DOMAIN;
  static final String PAYMENT = GrpcStepExecutor.PAYMENT_DOMAIN;

  final UUID orderId = UUID.randomUUID();
  final FakeDependencies deps = new FakeDependencies();
  CancelReason cancelReason;

  final GrpcStepExecutor executor =
      new GrpcStepExecutor(
          InventoryServiceGrpc.newBlockingStub(deps.channel),
          PaymentServiceGrpc.newBlockingStub(deps.channel),
          id ->
              new StepInput(
                  id,
                  List.of(new Line("CAP", "Cap", 75_000, 1), new Line("TEE-M", "Tee", 150_000, 2)),
                  375_000,
                  "IDR",
                  cancelReason));

  @AfterEach
  void close() {
    deps.close();
  }

  @Test
  void reserveSendsEveryLineAndTheTtl() {
    assertThat(executor.execute(orderId, new ReserveStock(Duration.ofMinutes(10))))
        .isEqualTo(new Done(new StockReserved(RESERVATION_EXPIRES)));

    ReserveStockRequest sent = deps.requests(ReserveStockRequest.class).getFirst();
    assertThat(sent.getOrderId()).isEqualTo(orderId.toString());
    assertThat(sent.getTtl().getSeconds()).isEqualTo(600);
    assertThat(sent.getLinesList())
        .extracting(l -> l.getSku() + "×" + l.getQuantity())
        .containsExactly("CAP×1", "TEE-M×2");
  }

  @Test
  void createIntentSendsTheTotalUnderTheOrderIdAsItsKey() {
    Instant expires = RESERVATION_EXPIRES.minus(Duration.ofMinutes(2));

    assertThat(executor.execute(orderId, new CreatePaymentIntent(expires)))
        .isEqualTo(new Done(new IntentCreated(PAYMENT_URL, expires)));

    CreatePaymentIntentRequest sent = deps.requests(CreatePaymentIntentRequest.class).getFirst();
    assertThat(sent.getOrderId()).isEqualTo(orderId.toString());
    assertThat(sent.getIdempotencyKey()).isEqualTo(orderId.toString());
    assertThat(sent.getAmount().getAmount()).isEqualTo(375_000);
    assertThat(sent.getAmount().getCurrency()).isEqualTo("IDR");
    assertThat(sent.getPaymentMethod()).isEqualTo("MOCK_CARD");
    assertThat(sent.getExpiresAt().getSeconds()).isEqualTo(expires.getEpochSecond());
  }

  @Test
  void refundUsesItsOwnIdempotencyKey() {
    assertThat(executor.execute(orderId, new RefundPayment())).isEqualTo(new Done(new Refunded()));
    assertThat(deps.requests(RefundPaymentRequest.class).getFirst().getIdempotencyKey())
        .isEqualTo(orderId + ":refund");
  }

  static Stream<Arguments> releaseReasons() {
    return Stream.of(
        Arguments.of(CancelReason.PAYMENT_FAILED, ReleaseReason.RELEASE_REASON_PAYMENT_FAILED),
        Arguments.of(CancelReason.PAYMENT_TIMEOUT, ReleaseReason.RELEASE_REASON_PAYMENT_TIMEOUT),
        Arguments.of(CancelReason.STOCK_UNAVAILABLE, ReleaseReason.RELEASE_REASON_ORDER_CANCELLED),
        Arguments.of(
            CancelReason.INVENTORY_UNAVAILABLE, ReleaseReason.RELEASE_REASON_ORDER_CANCELLED));
  }

  @ParameterizedTest
  @MethodSource("releaseReasons")
  void releaseSaysWhy(CancelReason cancelled, ReleaseReason sent) {
    cancelReason = cancelled;
    assertThat(executor.execute(orderId, new ReleaseReservation()))
        .isEqualTo(new Done(new ReservationReleased()));
    assertThat(deps.requests(ReleaseReservationRequest.class).getFirst().getReason())
        .isEqualTo(sent);
  }

  @Test
  void theOtherCallsAnswerTheirSuccessEvents() {
    assertThat(executor.execute(orderId, new CommitReservation()))
        .isEqualTo(new Done(new StockCommitted()));
    assertThat(executor.execute(orderId, new VoidPaymentIntent()))
        .isEqualTo(new Done(new IntentVoided()));
  }

  // ---- Errors ----

  /** Domain errors the saga has a row for are answers, not failures. */
  static Stream<Arguments> answers() {
    return Stream.of(
        Arguments.of(
            "ReserveStock",
            new ReserveStock(Duration.ofMinutes(10)),
            domainError(Code.FAILED_PRECONDITION, INVENTORY, "INSUFFICIENT_STOCK"),
            new InsufficientStock()),
        Arguments.of(
            "CommitReservation",
            new CommitReservation(),
            domainError(Code.NOT_FOUND, INVENTORY, "RESERVATION_NOT_FOUND"),
            new ReservationNotFound()),
        Arguments.of(
            "VoidPaymentIntent",
            new VoidPaymentIntent(),
            domainError(Code.FAILED_PRECONDITION, PAYMENT, "ALREADY_CAPTURED"),
            new AlreadyCaptured()),
        Arguments.of(
            "VoidPaymentIntent",
            new VoidPaymentIntent(),
            domainError(Code.NOT_FOUND, PAYMENT, "INTENT_NOT_FOUND"),
            new IntentVoided()),
        Arguments.of(
            "ReleaseReservation",
            new ReleaseReservation(),
            domainError(Code.NOT_FOUND, INVENTORY, "RESERVATION_NOT_FOUND"),
            new ReservationReleased()));
  }

  @ParameterizedTest(name = "{0}: {2}")
  @MethodSource("answers")
  void aDomainErrorWithASagaRowIsAnAnswer(
      String rpc,
      dev.sagamart.order.saga.SagaCommand command,
      io.grpc.StatusRuntimeException error,
      dev.sagamart.order.saga.SagaEvent event) {
    deps.failNext(rpc, error);
    assertThat(executor.execute(orderId, command)).isEqualTo(new Done(event));
  }

  @Test
  void anUnreachableOrSlowDependencyIsRetryable() {
    deps.failNext("ReserveStock", status(Status.UNAVAILABLE))
        .failNext("ReserveStock", status(Status.DEADLINE_EXCEEDED))
        .failNext(
            "CreatePaymentIntent", domainError(Code.UNAVAILABLE, PAYMENT, "PROVIDER_UNAVAILABLE"));
    ReserveStock reserve = new ReserveStock(Duration.ofMinutes(10));

    assertThat(executor.execute(orderId, reserve))
        .isEqualTo(new Retryable("UNAVAILABLE", "scripted"));
    assertThat(executor.execute(orderId, reserve))
        .isEqualTo(new Retryable("DEADLINE_EXCEEDED", "scripted"));
    assertThat(executor.execute(orderId, new CreatePaymentIntent(RESERVATION_EXPIRES)))
        .isEqualTo(new Retryable("PROVIDER_UNAVAILABLE", "provider unavailable"));
  }

  @Test
  void anErrorRepeatingCantFixFails() {
    deps.failNext("ReserveStock", status(Status.PERMISSION_DENIED))
        // Inventory refuses to release a sold reservation; the saga must never have asked.
        .failNext(
            "ReleaseReservation",
            domainError(Code.FAILED_PRECONDITION, INVENTORY, "RESERVATION_COMMITTED"))
        .failNext("RefundPayment", domainError(Code.FAILED_PRECONDITION, PAYMENT, "NOT_CAPTURED"));

    assertThat(executor.execute(orderId, new ReserveStock(Duration.ofMinutes(10))))
        .isEqualTo(new Failed("PERMISSION_DENIED", "scripted"));
    assertThat(executor.execute(orderId, new ReleaseReservation()))
        .isEqualTo(new Failed("RESERVATION_COMMITTED", "reservation committed"));
    assertThat(executor.execute(orderId, new RefundPayment()))
        .isEqualTo(new Failed("NOT_CAPTURED", "not captured"));
  }

  @Test
  void aReasonFromAnotherServicesDomainIsNotTrusted() {
    // ALREADY_CAPTURED means something only when Payment says it.
    deps.failNext(
        "VoidPaymentIntent", domainError(Code.FAILED_PRECONDITION, INVENTORY, "ALREADY_CAPTURED"));

    assertThat(executor.execute(orderId, new VoidPaymentIntent()))
        .isEqualTo(new Failed("FAILED_PRECONDITION", "already captured"));
  }
}
