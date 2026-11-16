package dev.sagamart.order.store;

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
import dev.sagamart.order.saga.SagaState.Stage;
import java.time.Duration;
import java.time.Instant;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * A saga state as {@code sagas} stores it (RFC-0002 §4.3): the stage in {@code state}, the expiries
 * the scans index in their own columns, and the state's other fields in {@code state_detail}. A
 * state reads back equal to the one written; {@link #toState} is the only reader.
 */
record SagaColumns(
    Stage stage, ObjectNode detail, Instant reservationExpiresAt, Instant paymentDeadline) {

  private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

  static SagaColumns of(SagaState state) {
    ObjectNode detail = NODES.objectNode();
    SagaState own = state;
    if (state instanceof NeedsAttention n) {
      detail.put("stuckIn", n.stuckIn().stage().name());
      own = n.stuckIn();
    }
    Instant reservation = null;
    Instant deadline = null;
    switch (own) {
      case CreatingPayment s -> reservation = s.reservationExpiresAt();
      case AwaitingPayment s -> {
        reservation = s.reservationExpiresAt();
        deadline = s.paymentDeadline();
        detail.put("paymentUrl", s.paymentUrl());
      }
      case Cancelling s ->
          detail
              .put("reason", s.reason().name())
              .put("mayHaveIntent", s.mayHaveIntent())
              .put("voided", s.voided());
      case Refunding s ->
          detail
              .put("reason", s.reason().name())
              .put("refunded", s.refunded())
              .put("cancelPublished", s.cancelPublished());
      case Cancelled s -> detail.put("reason", s.reason().name());
      case NeedsAttention _ -> throw new IllegalArgumentException("NEEDS_ATTENTION inside itself");
      case ReservingStock _, CommittingStock _, Completed _ -> {}
    }
    return new SagaColumns(state.stage(), detail, reservation, deadline);
  }

  static SagaState toState(
      Stage stage, JsonNode detail, Instant reservationExpiresAt, Instant paymentDeadline) {
    if (stage == Stage.NEEDS_ATTENTION) {
      Stage stuckIn = Stage.valueOf(detail.required("stuckIn").asString());
      return new NeedsAttention(own(stuckIn, detail, reservationExpiresAt, paymentDeadline));
    }
    return own(stage, detail, reservationExpiresAt, paymentDeadline);
  }

  private static SagaState own(
      Stage stage, JsonNode detail, Instant reservationExpiresAt, Instant paymentDeadline) {
    return switch (stage) {
      case RESERVING_STOCK -> new ReservingStock();
      case CREATING_PAYMENT -> new CreatingPayment(reservationExpiresAt);
      case AWAITING_PAYMENT ->
          new AwaitingPayment(
              reservationExpiresAt, paymentDeadline, detail.required("paymentUrl").asString());
      case COMMITTING_STOCK -> new CommittingStock();
      case COMPLETED -> new Completed();
      case CANCELLING ->
          new Cancelling(
              reason(detail),
              detail.required("mayHaveIntent").asBoolean(),
              detail.required("voided").asBoolean());
      case REFUNDING ->
          new Refunding(
              reason(detail),
              detail.required("refunded").asBoolean(),
              detail.required("cancelPublished").asBoolean());
      case CANCELLED -> new Cancelled(reason(detail));
      case NEEDS_ATTENTION -> throw new IllegalStateException("NEEDS_ATTENTION inside itself");
    };
  }

  private static CancelReason reason(JsonNode detail) {
    return CancelReason.valueOf(detail.required("reason").asString());
  }

  // ---- What the rest of the row follows from the state ----

  /** {@code order.cancelled} has gone out: every CANCELLED was announced on its first entry. */
  static boolean cancelPublished(SagaState state) {
    return switch (state) {
      case Cancelled _ -> true;
      case Refunding s -> s.cancelPublished();
      case NeedsAttention s -> cancelPublished(s.stuckIn());
      default -> false;
    };
  }

  /** {@code orders.cancel_reason}: set exactly when the order is CANCELLED. */
  static CancelReason cancelReason(SagaState state) {
    if (state.orderStatus() != OrderStatus.CANCELLED) {
      return null;
    }
    return switch (state) {
      case Cancelling s -> s.reason();
      case Refunding s -> s.reason();
      case Cancelled s -> s.reason();
      case NeedsAttention s -> cancelReason(s.stuckIn());
      default -> throw new IllegalStateException(state.stage() + " is cancelled without a reason");
    };
  }

  /** {@code orders.payment_url}: set while the order awaits payment (order.proto). */
  static String paymentUrl(SagaState state) {
    return state instanceof AwaitingPayment s ? s.paymentUrl() : null;
  }

  // ---- pending_command ----

  static ObjectNode command(SagaCommand command) {
    return switch (command) {
      case ReserveStock c -> type("ReserveStock").put("ttlSeconds", c.ttl().toSeconds());
      case CreatePaymentIntent c ->
          type("CreatePaymentIntent").put("expiresAt", c.expiresAt().toString());
      case CommitReservation _ -> type("CommitReservation");
      case VoidPaymentIntent _ -> type("VoidPaymentIntent");
      case ReleaseReservation _ -> type("ReleaseReservation");
      case RefundPayment _ -> type("RefundPayment");
    };
  }

  static SagaCommand toCommand(JsonNode node) {
    String type = node.required("type").asString();
    return switch (type) {
      case "ReserveStock" ->
          new ReserveStock(Duration.ofSeconds(node.required("ttlSeconds").asLong()));
      case "CreatePaymentIntent" ->
          new CreatePaymentIntent(Instant.parse(node.required("expiresAt").asString()));
      case "CommitReservation" -> new CommitReservation();
      case "VoidPaymentIntent" -> new VoidPaymentIntent();
      case "ReleaseReservation" -> new ReleaseReservation();
      case "RefundPayment" -> new RefundPayment();
      default -> throw new IllegalArgumentException("unknown saga command " + type);
    };
  }

  private static ObjectNode type(String type) {
    return NODES.objectNode().put("type", type);
  }
}
