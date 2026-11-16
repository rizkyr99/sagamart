package dev.sagamart.order.store;

import dev.sagamart.order.ids.UuidV7;
import dev.sagamart.order.saga.CancelReason;
import dev.sagamart.order.saga.OrderEvent;
import dev.sagamart.order.saga.OrderEvent.OrderCancelled;
import dev.sagamart.order.saga.Saga;
import dev.sagamart.order.saga.SagaEvent;
import dev.sagamart.order.saga.SagaEvent.PaymentFailed;
import dev.sagamart.order.saga.SagaEvent.PaymentSucceeded;
import dev.sagamart.order.saga.SagaEvent.ReservationExpired;
import dev.sagamart.order.saga.SagaState;
import dev.sagamart.order.saga.SagaState.ReservingStock;
import dev.sagamart.order.saga.SagaState.Stage;
import dev.sagamart.order.saga.Transition;
import dev.sagamart.order.store.ApplyResult.Applied;
import dev.sagamart.order.store.ApplyResult.Ignored;
import dev.sagamart.order.store.ApplyResult.NotFound;
import dev.sagamart.order.store.ApplyResult.Stale;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.OptionalInt;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * Orders and their sagas in Postgres (RFC-0002 §4.3, §4.7). Every write is one transaction: a
 * transition, its next command, its history row and its outbox events commit together or not at
 * all. Applying an event locks the saga row, so writes to one saga are serialized.
 */
@Repository
public class SagaStore {

  /** A saga as stored; {@code version} is what a command's result must match to apply. */
  public record StoredSaga(UUID orderId, SagaState state, int version) {}

  private final JdbcClient jdbc;
  private final TransactionTemplate tx;
  private final JsonMapper json;

  public SagaStore(JdbcClient jdbc, TransactionTemplate tx, JsonMapper json) {
    this.jdbc = jdbc;
    this.tx = tx;
    this.json = json;
  }

  /** Records the order and starts its saga in RESERVING_STOCK, due now. */
  public void create(NewOrder order) {
    SagaState initial = new ReservingStock();
    tx.executeWithoutResult(
        _ -> {
          jdbc.sql(
                  """
                  INSERT INTO orders (id, buyer_id, status, total_amount, shipping_address)
                  VALUES (:id, :buyer, :status, :total, CAST(:address AS jsonb))""")
              .param("id", order.id())
              .param("buyer", order.buyerId())
              .param("status", initial.orderStatus().name())
              .param("total", order.total())
              .param("address", json.writeValueAsString(order.shippingAddress()))
              .update();
          for (NewOrder.Line line : order.lines()) {
            jdbc.sql(
                    """
                    INSERT INTO order_lines (order_id, sku, name, unit_price, quantity)
                    VALUES (:id, :sku, :name, :price, :quantity)""")
                .param("id", order.id())
                .param("sku", line.sku())
                .param("name", line.name())
                .param("price", line.unitPrice())
                .param("quantity", line.quantity())
                .update();
          }
          jdbc.sql(
                  """
                  INSERT INTO sagas (order_id, state, state_detail, reservation_expires_at,
                      payment_deadline, cancel_published, pending_command, next_attempt_at)
                  VALUES (:id, :state, CAST(:detail AS jsonb), :reservation, :deadline,
                      :cancelPublished, CAST(:command AS jsonb),
                      CASE WHEN :hasCommand THEN now() END)""")
              .params(sagaColumns(order.id(), initial))
              .update();
          step(order.id(), "TRANSITION", "OrderCreated", null, initial.stage(), null);
        });
  }

  public Optional<StoredSaga> find(UUID orderId) {
    return jdbc.sql(
            """
            SELECT state, state_detail::text AS state_detail, reservation_expires_at,
                payment_deadline, version
            FROM sagas WHERE order_id = :id""")
        .param("id", orderId)
        .query((rs, _) -> new StoredSaga(orderId, state(rs), rs.getInt("version")))
        .optional();
  }

  /** Applies a consumed event (RFC-0002 §4.7.6): whatever the saga's version is now. */
  public ApplyResult apply(UUID orderId, SagaEvent event) {
    return apply(orderId, event, OptionalInt.empty());
  }

  /**
   * Applies a command's result, unless the saga moved on since the command was issued at {@code
   * expectedVersion} (RFC-0002 §4.7.3): then it's discarded as {@link Stale}.
   */
  public ApplyResult applyIfVersion(UUID orderId, SagaEvent event, int expectedVersion) {
    return apply(orderId, event, OptionalInt.of(expectedVersion));
  }

  private ApplyResult apply(UUID orderId, SagaEvent event, OptionalInt expectedVersion) {
    return tx.execute(
        _ -> {
          Optional<Locked> found =
              jdbc.sql(
                      """
                      SELECT state, state_detail::text AS state_detail, reservation_expires_at,
                          payment_deadline, cancel_published, version, now() AS now
                      FROM sagas WHERE order_id = :id FOR UPDATE""")
                  .param("id", orderId)
                  .query(
                      (rs, _) ->
                          new Locked(
                              state(rs),
                              rs.getBoolean("cancel_published"),
                              rs.getInt("version"),
                              instant(rs, "now")))
                  .optional();
          if (found.isEmpty()) {
            return new NotFound();
          }
          Locked saga = found.get();
          Stage stage = saga.state().stage();

          if (expectedVersion.isPresent() && expectedVersion.getAsInt() != saga.version()) {
            ObjectNode detail =
                json.createObjectNode()
                    .put("discarded", "stale")
                    .put("expectedVersion", expectedVersion.getAsInt())
                    .put("version", saga.version());
            step(orderId, "EVENT", name(event), stage, stage, detail);
            return new Stale(saga.version());
          }

          Transition t = Saga.apply(saga.state(), event);
          if (!t.applied()) {
            step(
                orderId,
                "EVENT",
                name(event),
                stage,
                stage,
                json.createObjectNode().put("applied", false));
            return new Ignored(t, saga.version());
          }
          if (saga.cancelPublished()
              && t.publish().stream().anyMatch(OrderCancelled.class::isInstance)) {
            // The state machine announces a cancellation once; a second one is a bug, not a fact.
            throw new IllegalStateException("order.cancelled already published for " + orderId);
          }

          jdbc.sql(
                  """
                  UPDATE sagas SET state = :state, state_detail = CAST(:detail AS jsonb),
                      reservation_expires_at = COALESCE(:reservation, reservation_expires_at),
                      payment_deadline = COALESCE(:deadline, payment_deadline),
                      cancel_published = :cancelPublished,
                      pending_command = CAST(:command AS jsonb), attempt = 0,
                      next_attempt_at = CASE WHEN :hasCommand THEN now() END,
                      claimed_until = NULL, version = version + 1, updated_at = now()
                  WHERE order_id = :id""")
              .params(sagaColumns(orderId, t.to()))
              .update();
          CancelReason reason = SagaColumns.cancelReason(t.to());
          jdbc.sql(
                  """
                  UPDATE orders SET status = :status, cancel_reason = :reason, payment_url = :url,
                      version = version + 1, updated_at = now()
                  WHERE id = :id""")
              .param("id", orderId)
              .param("status", t.to().orderStatus().name())
              .param("reason", reason == null ? null : reason.name())
              .param("url", SagaColumns.paymentUrl(t.to()))
              .update();
          step(orderId, "EVENT", name(event), stage, t.to().stage(), null);
          if (!t.publish().isEmpty()) {
            publish(orderId, t.publish(), saga.now());
          }
          return new Applied(t, saga.version() + 1);
        });
  }

  /** The saga row as the apply transaction locked it; {@code now} is the transaction's time. */
  private record Locked(SagaState state, boolean cancelPublished, int version, Instant now) {}

  private Map<String, Object> sagaColumns(UUID orderId, SagaState state) {
    SagaColumns columns = SagaColumns.of(state);
    Optional<ObjectNode> command = state.pendingCommand().map(SagaColumns::command);
    Map<String, Object> params = new HashMap<>();
    params.put("id", orderId);
    params.put("state", columns.stage().name());
    params.put("detail", json.writeValueAsString(columns.detail()));
    params.put("reservation", timestamp(columns.reservationExpiresAt()));
    params.put("deadline", timestamp(columns.paymentDeadline()));
    params.put("cancelPublished", SagaColumns.cancelPublished(state));
    params.put("command", command.map(json::writeValueAsString).orElse(null));
    params.put("hasCommand", command.isPresent());
    return params;
  }

  /** Appends to the saga's history; the caller holds the saga row, so {@code seq} can't race. */
  private void step(
      UUID orderId, String kind, String name, Stage from, Stage to, ObjectNode detail) {
    jdbc.sql(
            """
            INSERT INTO saga_steps (order_id, seq, kind, name, from_state, to_state, detail)
            SELECT :id, COALESCE(MAX(seq), 0) + 1, :kind, :name, :from, :to,
                CAST(:detail AS jsonb)
            FROM saga_steps WHERE order_id = :id""")
        .param("id", orderId)
        .param("kind", kind)
        .param("name", name)
        .param("from", from == null ? null : from.name())
        .param("to", to.name())
        .param("detail", detail == null ? null : json.writeValueAsString(detail))
        .update();
  }

  /** Queues the transition's events in the outbox (ADR-0006), in the transition's transaction. */
  private void publish(UUID orderId, List<OrderEvent> events, Instant at) {
    OrderEvents.Facts facts =
        jdbc.sql("SELECT buyer_id, total_amount, currency FROM orders WHERE id = :id")
            .param("id", orderId)
            .query(
                (rs, _) ->
                    new OrderEvents.Facts(
                        orderId,
                        rs.getObject("buyer_id", UUID.class),
                        rs.getLong("total_amount"),
                        rs.getString("currency"),
                        lines(orderId)))
            .single();
    for (OrderEvent event : events) {
      UUID id = UuidV7.generate();
      jdbc.sql(
              """
              INSERT INTO outbox (id, aggregate_type, aggregate_id, event_type, payload)
              VALUES (:id, 'order', :aggregate, :type, CAST(:payload AS jsonb))""")
          .param("id", id)
          .param("aggregate", orderId.toString())
          .param("type", OrderEvents.type(event))
          .param("payload", json.writeValueAsString(OrderEvents.envelope(id, event, facts, at)))
          .update();
    }
  }

  private List<NewOrder.Line> lines(UUID orderId) {
    return jdbc.sql(
            "SELECT sku, name, unit_price, quantity FROM order_lines WHERE order_id = :id ORDER BY sku")
        .param("id", orderId)
        .query(
            (rs, _) ->
                new NewOrder.Line(
                    rs.getString("sku"),
                    rs.getString("name"),
                    rs.getLong("unit_price"),
                    rs.getInt("quantity")))
        .list();
  }

  /** The history name of an event: consumed events by their topic type (RFC-0002 §4.3). */
  static String name(SagaEvent event) {
    return switch (event) {
      case PaymentSucceeded _ -> "payment.succeeded";
      case PaymentFailed _ -> "payment.failed";
      case ReservationExpired _ -> "inventory.reservation.expired";
      default -> event.getClass().getSimpleName();
    };
  }

  private SagaState state(ResultSet rs) throws SQLException {
    return SagaColumns.toState(
        Stage.valueOf(rs.getString("state")),
        json.readTree(rs.getString("state_detail")),
        instant(rs, "reservation_expires_at"),
        instant(rs, "payment_deadline"));
  }

  private static Instant instant(ResultSet rs, String column) throws SQLException {
    OffsetDateTime value = rs.getObject(column, OffsetDateTime.class);
    return value == null ? null : value.toInstant();
  }

  /**
   * Postgres keeps microseconds and would round the rest: truncate instead, so a stored expiry is
   * never later than the one Inventory or Payment gave.
   */
  private static OffsetDateTime timestamp(Instant instant) {
    return instant == null ? null : instant.truncatedTo(ChronoUnit.MICROS).atOffset(ZoneOffset.UTC);
  }
}
