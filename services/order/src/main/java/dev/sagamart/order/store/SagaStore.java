package dev.sagamart.order.store;

import dev.sagamart.order.ids.UuidV7;
import dev.sagamart.order.saga.CancelReason;
import dev.sagamart.order.saga.OrderEvent;
import dev.sagamart.order.saga.OrderEvent.OrderCancelled;
import dev.sagamart.order.saga.Saga;
import dev.sagamart.order.saga.SagaCommand;
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
import java.time.Duration;
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

  /**
   * A saga the runner leased. {@code attempt} counts the failed tries of {@code command} so far;
   * {@code now} is the database's clock, for the retry budget.
   */
  public record Claim(
      UUID orderId,
      SagaCommand command,
      int version,
      int attempt,
      Instant pendingSince,
      Instant now) {}

  /** One try of a command, for history (FR-12). {@code error} is null when it succeeded. */
  public record CommandStep(
      String name, int attempt, Outcome outcome, String error, String detail) {

    public enum Outcome {
      OK,
      RETRYABLE_ERROR,
      FAILED
    }
  }

  /** What a saga's calls send about the order. {@code cancelReason} is null unless cancelled. */
  public record StepInput(
      UUID orderId,
      List<NewOrder.Line> lines,
      long total,
      String currency,
      CancelReason cancelReason) {}

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
                      payment_deadline, cancel_published, pending_command, next_attempt_at,
                      pending_since)
                  VALUES (:id, :state, CAST(:detail AS jsonb), :reservation, :deadline,
                      :cancelPublished, CAST(:command AS jsonb),
                      CASE WHEN :hasCommand THEN now() END, CASE WHEN :hasCommand THEN now() END)""")
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
    return apply(orderId, event, OptionalInt.empty(), null);
  }

  /**
   * Applies a command's result, unless the saga moved on since the command was issued at {@code
   * expectedVersion} (RFC-0002 §4.7.3): then it's discarded as {@link Stale}.
   */
  public ApplyResult applyIfVersion(UUID orderId, SagaEvent event, int expectedVersion) {
    return apply(orderId, event, OptionalInt.of(expectedVersion), null);
  }

  /**
   * A call the runner made, and what came of it: {@code call} goes in history before the result is
   * applied, in the same transaction, at the version the call was made for.
   */
  public ApplyResult applyResult(UUID orderId, int version, CommandStep call, SagaEvent result) {
    return apply(orderId, result, OptionalInt.of(version), call);
  }

  /**
   * Claims up to {@code limit} sagas whose pending command is due and not leased, and leases them
   * for {@code lease} (RFC-0002 §4.7). Concurrent claimers skip each other's rows.
   */
  public List<Claim> claimDue(int limit, Duration lease) {
    return jdbc.sql(
            """
            UPDATE sagas s SET claimed_until = now() + make_interval(secs => :lease)
            FROM (
                SELECT order_id FROM sagas
                WHERE pending_command IS NOT NULL AND next_attempt_at <= now()
                    AND (claimed_until IS NULL OR claimed_until < now())
                ORDER BY next_attempt_at
                LIMIT :limit
                FOR UPDATE SKIP LOCKED) due
            WHERE s.order_id = due.order_id
            RETURNING s.order_id, s.pending_command::text AS pending_command, s.version,
                s.attempt, s.pending_since, now() AS now""")
        .param("lease", lease.toMillis() / 1000.0)
        .param("limit", limit)
        .query(
            (rs, _) ->
                new Claim(
                    rs.getObject("order_id", UUID.class),
                    SagaColumns.toCommand(json.readTree(rs.getString("pending_command"))),
                    rs.getInt("version"),
                    rs.getInt("attempt"),
                    instant(rs, "pending_since"),
                    instant(rs, "now")))
        .list();
  }

  /**
   * The call failed and will be retried after {@code backoff}: recorded in history, the attempt
   * counted, the lease ended. Nothing changes if the saga moved on since {@code version}.
   */
  public void retryLater(UUID orderId, int version, CommandStep call, Duration backoff) {
    tx.executeWithoutResult(
        _ -> {
          Optional<Stage> stage =
              jdbc.sql(
                      """
                      SELECT state FROM sagas WHERE order_id = :id AND version = :version
                      FOR UPDATE""")
                  .param("id", orderId)
                  .param("version", version)
                  .query((rs, _) -> Stage.valueOf(rs.getString("state")))
                  .optional();
          if (stage.isEmpty()) {
            return;
          }
          command(orderId, stage.get(), call);
          jdbc.sql(
                  """
                  UPDATE sagas SET attempt = attempt + 1,
                      next_attempt_at = now() + make_interval(secs => :backoff),
                      claimed_until = NULL, updated_at = now()
                  WHERE order_id = :id""")
              .param("id", orderId)
              .param("backoff", backoff.toMillis() / 1000.0)
              .update();
        });
  }

  /** What the calls of an order's saga send: its lines, total and, once cancelled, the reason. */
  public StepInput stepInput(UUID orderId) {
    return jdbc.sql("SELECT total_amount, currency, cancel_reason FROM orders WHERE id = :id")
        .param("id", orderId)
        .query(
            (rs, _) -> {
              String reason = rs.getString("cancel_reason");
              return new StepInput(
                  orderId,
                  lines(orderId),
                  rs.getLong("total_amount"),
                  rs.getString("currency"),
                  reason == null ? null : CancelReason.valueOf(reason));
            })
        .single();
  }

  private ApplyResult apply(
      UUID orderId, SagaEvent event, OptionalInt expectedVersion, CommandStep call) {
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
          if (call != null) {
            command(orderId, stage, call);
          }

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
                      pending_since = CASE WHEN :hasCommand THEN now() END,
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

  /** Records a try of the pending command; {@code stage} is where the saga was when it was made. */
  private void command(UUID orderId, Stage stage, CommandStep call) {
    ObjectNode detail = null;
    if (call.error() != null) {
      detail = json.createObjectNode().put("code", call.error()).put("message", call.detail());
    }
    jdbc.sql(
            """
            INSERT INTO saga_steps (order_id, seq, kind, name, from_state, to_state, attempt,
                outcome, detail)
            SELECT :id, COALESCE(MAX(seq), 0) + 1, 'COMMAND', :name, :stage, :stage, :attempt,
                :outcome, CAST(:detail AS jsonb)
            FROM saga_steps WHERE order_id = :id""")
        .param("id", orderId)
        .param("name", call.name())
        .param("stage", stage.name())
        .param("attempt", call.attempt())
        .param("outcome", call.outcome().name())
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
