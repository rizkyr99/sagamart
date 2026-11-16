package dev.sagamart.order.runner;

import com.google.protobuf.InvalidProtocolBufferException;
import com.google.protobuf.Timestamp;
import com.google.rpc.ErrorInfo;
import dev.sagamart.contracts.inventory.v1.CommitReservationRequest;
import dev.sagamart.contracts.inventory.v1.InventoryServiceGrpc.InventoryServiceBlockingStub;
import dev.sagamart.contracts.inventory.v1.ReleaseReason;
import dev.sagamart.contracts.inventory.v1.ReleaseReservationRequest;
import dev.sagamart.contracts.inventory.v1.ReservationLine;
import dev.sagamart.contracts.inventory.v1.ReserveStockRequest;
import dev.sagamart.contracts.inventory.v1.ReserveStockResponse;
import dev.sagamart.contracts.payment.v1.CreatePaymentIntentRequest;
import dev.sagamart.contracts.payment.v1.CreatePaymentIntentResponse;
import dev.sagamart.contracts.payment.v1.Money;
import dev.sagamart.contracts.payment.v1.PaymentServiceGrpc.PaymentServiceBlockingStub;
import dev.sagamart.contracts.payment.v1.RefundPaymentRequest;
import dev.sagamart.contracts.payment.v1.VoidPaymentIntentRequest;
import dev.sagamart.order.runner.StepOutcome.Done;
import dev.sagamart.order.runner.StepOutcome.Failed;
import dev.sagamart.order.runner.StepOutcome.Retryable;
import dev.sagamart.order.saga.CancelReason;
import dev.sagamart.order.saga.SagaCommand;
import dev.sagamart.order.saga.SagaCommand.CommitReservation;
import dev.sagamart.order.saga.SagaCommand.CreatePaymentIntent;
import dev.sagamart.order.saga.SagaCommand.RefundPayment;
import dev.sagamart.order.saga.SagaCommand.ReleaseReservation;
import dev.sagamart.order.saga.SagaCommand.ReserveStock;
import dev.sagamart.order.saga.SagaCommand.VoidPaymentIntent;
import dev.sagamart.order.saga.SagaEvent;
import dev.sagamart.order.saga.SagaEvent.AlreadyCaptured;
import dev.sagamart.order.saga.SagaEvent.InsufficientStock;
import dev.sagamart.order.saga.SagaEvent.IntentCreated;
import dev.sagamart.order.saga.SagaEvent.IntentVoided;
import dev.sagamart.order.saga.SagaEvent.Refunded;
import dev.sagamart.order.saga.SagaEvent.ReservationNotFound;
import dev.sagamart.order.saga.SagaEvent.ReservationReleased;
import dev.sagamart.order.saga.SagaEvent.StockCommitted;
import dev.sagamart.order.saga.SagaEvent.StockReserved;
import dev.sagamart.order.store.SagaStore.StepInput;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.protobuf.StatusProto;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;

/**
 * Saga commands as calls to Inventory and Payment (RFC-0002 §4.2, §4.6). The answer becomes the
 * saga event the state machine expects; a domain error the saga has a row for is an answer too.
 *
 * <p>{@code orders} loads what a call sends about the order: its lines, total and cancel reason.
 */
public class GrpcStepExecutor implements StepExecutor {

  static final String INVENTORY_DOMAIN = "inventory.sagamart.dev";
  static final String PAYMENT_DOMAIN = "payment.sagamart.dev";

  /** Per-call deadlines (RFC-0002 §4.6): Payment's calls wait on the provider. */
  static final Duration INVENTORY_DEADLINE = Duration.ofSeconds(2);

  static final Duration PAYMENT_DEADLINE = Duration.ofSeconds(3);
  static final Duration REFUND_DEADLINE = Duration.ofSeconds(5);

  /** The only method until the storefront offers others (RFC-0002 §4.2). */
  static final String PAYMENT_METHOD = "MOCK_CARD";

  /** Failures worth repeating: the call may not have reached its server, or may succeed later. */
  private static final Set<Status.Code> RETRYABLE =
      Set.of(
          Status.Code.UNAVAILABLE,
          Status.Code.DEADLINE_EXCEEDED,
          Status.Code.RESOURCE_EXHAUSTED,
          Status.Code.ABORTED,
          Status.Code.INTERNAL,
          Status.Code.UNKNOWN,
          Status.Code.CANCELLED);

  private final InventoryServiceBlockingStub inventory;
  private final PaymentServiceBlockingStub payment;
  private final Function<UUID, StepInput> orders;

  public GrpcStepExecutor(
      InventoryServiceBlockingStub inventory,
      PaymentServiceBlockingStub payment,
      Function<UUID, StepInput> orders) {
    this.inventory = inventory;
    this.payment = payment;
    this.orders = orders;
  }

  @Override
  public StepOutcome execute(UUID orderId, SagaCommand command) {
    try {
      return new Done(call(orderId, command));
    } catch (StatusRuntimeException e) {
      return failure(command, e);
    }
  }

  private SagaEvent call(UUID orderId, SagaCommand command) {
    String id = orderId.toString();
    return switch (command) {
      case ReserveStock c -> {
        StepInput order = orders.apply(orderId);
        ReserveStockRequest.Builder request =
            ReserveStockRequest.newBuilder()
                .setOrderId(id)
                .setTtl(com.google.protobuf.Duration.newBuilder().setSeconds(c.ttl().toSeconds()));
        order
            .lines()
            .forEach(
                l ->
                    request.addLines(
                        ReservationLine.newBuilder().setSku(l.sku()).setQuantity(l.quantity())));
        ReserveStockResponse reply = inventory().reserveStock(request.build());
        yield new StockReserved(instant(reply.getExpiresAt()));
      }
      case CreatePaymentIntent c -> {
        StepInput order = orders.apply(orderId);
        CreatePaymentIntentResponse reply =
            payment(PAYMENT_DEADLINE)
                .createPaymentIntent(
                    CreatePaymentIntentRequest.newBuilder()
                        .setOrderId(id)
                        .setIdempotencyKey(id)
                        .setAmount(
                            Money.newBuilder()
                                .setAmount(order.total())
                                .setCurrency(order.currency()))
                        .setPaymentMethod(PAYMENT_METHOD)
                        .setExpiresAt(timestamp(c.expiresAt()))
                        .build());
        // Payment may shorten the expiry; the deadline is computed from what it answered.
        Instant expires = reply.hasExpiresAt() ? instant(reply.getExpiresAt()) : c.expiresAt();
        yield new IntentCreated(reply.getRedirectUrl(), expires);
      }
      case CommitReservation _ -> {
        inventory().commitReservation(CommitReservationRequest.newBuilder().setOrderId(id).build());
        yield new StockCommitted();
      }
      case VoidPaymentIntent _ -> {
        payment(PAYMENT_DEADLINE)
            .voidPaymentIntent(VoidPaymentIntentRequest.newBuilder().setOrderId(id).build());
        yield new IntentVoided();
      }
      case ReleaseReservation _ -> {
        CancelReason reason = orders.apply(orderId).cancelReason();
        inventory()
            .releaseReservation(
                ReleaseReservationRequest.newBuilder()
                    .setOrderId(id)
                    .setReason(releaseReason(reason))
                    .build());
        yield new ReservationReleased();
      }
      case RefundPayment _ -> {
        payment(REFUND_DEADLINE)
            .refundPayment(
                RefundPaymentRequest.newBuilder()
                    .setOrderId(id)
                    .setIdempotencyKey(id + ":refund")
                    .build());
        yield new Refunded();
      }
    };
  }

  /**
   * The domain errors that are answers, per command (the contracts' error lists). Anything else is
   * retried if it might pass, and fails otherwise.
   */
  private static final Map<Class<? extends SagaCommand>, Map<String, SagaEvent>> ANSWERS =
      Map.of(
          ReserveStock.class, Map.of("INSUFFICIENT_STOCK", new InsufficientStock()),
          CommitReservation.class, Map.of("RESERVATION_NOT_FOUND", new ReservationNotFound()),
          // A void after the buyer paid: the saga commits instead.
          VoidPaymentIntent.class,
              Map.of(
                  "ALREADY_CAPTURED", new AlreadyCaptured(),
                  // The intent was never created: nothing to void.
                  "INTENT_NOT_FOUND", new IntentVoided()),
          // Never reserved (the reservation gave up first): nothing to release.
          ReleaseReservation.class, Map.of("RESERVATION_NOT_FOUND", new ReservationReleased()));

  private static StepOutcome failure(SagaCommand command, StatusRuntimeException e) {
    Status status = e.getStatus();
    String reason = reason(command, e);
    SagaEvent answer =
        reason == null ? null : ANSWERS.getOrDefault(command.getClass(), Map.of()).get(reason);
    if (answer != null) {
      return new Done(answer);
    }
    String code = reason != null ? reason : status.getCode().name();
    String message = status.getDescription() == null ? "" : status.getDescription();
    return RETRYABLE.contains(status.getCode())
        ? new Retryable(code, message)
        : new Failed(code, message);
  }

  /** The ErrorInfo reason from the service the command calls, if the error carries one. */
  private static String reason(SagaCommand command, StatusRuntimeException e) {
    com.google.rpc.Status details = StatusProto.fromThrowable(e);
    if (details == null) {
      return null;
    }
    String domain =
        switch (command) {
          case ReserveStock _, CommitReservation _, ReleaseReservation _ -> INVENTORY_DOMAIN;
          case CreatePaymentIntent _, VoidPaymentIntent _, RefundPayment _ -> PAYMENT_DOMAIN;
        };
    for (var any : details.getDetailsList()) {
      if (any.is(ErrorInfo.class)) {
        try {
          ErrorInfo info = any.unpack(ErrorInfo.class);
          if (info.getDomain().equals(domain)) {
            return info.getReason();
          }
        } catch (InvalidProtocolBufferException ignored) {
          // A malformed detail is no answer; the status code decides.
        }
      }
    }
    return null;
  }

  private static ReleaseReason releaseReason(CancelReason reason) {
    if (reason == null) {
      return ReleaseReason.RELEASE_REASON_ORDER_CANCELLED;
    }
    return switch (reason) {
      case PAYMENT_FAILED -> ReleaseReason.RELEASE_REASON_PAYMENT_FAILED;
      case PAYMENT_TIMEOUT -> ReleaseReason.RELEASE_REASON_PAYMENT_TIMEOUT;
      default -> ReleaseReason.RELEASE_REASON_ORDER_CANCELLED;
    };
  }

  private InventoryServiceBlockingStub inventory() {
    return inventory.withDeadlineAfter(INVENTORY_DEADLINE.toMillis(), TimeUnit.MILLISECONDS);
  }

  private PaymentServiceBlockingStub payment(Duration deadline) {
    return payment.withDeadlineAfter(deadline.toMillis(), TimeUnit.MILLISECONDS);
  }

  private static Instant instant(Timestamp t) {
    return Instant.ofEpochSecond(t.getSeconds(), t.getNanos());
  }

  private static Timestamp timestamp(Instant i) {
    return Timestamp.newBuilder().setSeconds(i.getEpochSecond()).setNanos(i.getNano()).build();
  }
}
