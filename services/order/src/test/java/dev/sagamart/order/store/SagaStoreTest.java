package dev.sagamart.order.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.sagamart.order.saga.CancelReason;
import dev.sagamart.order.saga.Saga;
import dev.sagamart.order.saga.SagaCommand;
import dev.sagamart.order.saga.SagaEvent;
import dev.sagamart.order.saga.SagaEvent.AlreadyCaptured;
import dev.sagamart.order.saga.SagaEvent.InsufficientStock;
import dev.sagamart.order.saga.SagaEvent.IntentCreated;
import dev.sagamart.order.saga.SagaEvent.IntentVoided;
import dev.sagamart.order.saga.SagaEvent.PaymentDeadlinePassed;
import dev.sagamart.order.saga.SagaEvent.PaymentFailed;
import dev.sagamart.order.saga.SagaEvent.PaymentSucceeded;
import dev.sagamart.order.saga.SagaEvent.Refunded;
import dev.sagamart.order.saga.SagaEvent.ReservationNotFound;
import dev.sagamart.order.saga.SagaEvent.ReservationReleased;
import dev.sagamart.order.saga.SagaEvent.RetriesExhausted;
import dev.sagamart.order.saga.SagaEvent.StockCommitted;
import dev.sagamart.order.saga.SagaEvent.StockReserved;
import dev.sagamart.order.saga.SagaState;
import dev.sagamart.order.saga.SagaState.Cancelled;
import dev.sagamart.order.saga.SagaState.Cancelling;
import dev.sagamart.order.saga.SagaState.CreatingPayment;
import dev.sagamart.order.saga.SagaState.ReservingStock;
import dev.sagamart.order.saga.Transition;
import dev.sagamart.order.store.ApplyResult.Applied;
import dev.sagamart.order.store.ApplyResult.Ignored;
import dev.sagamart.order.store.ApplyResult.NotFound;
import dev.sagamart.order.store.ApplyResult.Stale;
import dev.sagamart.order.store.NewOrder.Line;
import dev.sagamart.order.store.SagaStore.Claim;
import dev.sagamart.order.store.SagaStore.CommandStep;
import dev.sagamart.order.store.SagaStore.CommandStep.Outcome;
import dev.sagamart.order.store.SagaStore.StoredSaga;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.stream.Stream;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** The store on a real Postgres, migrated by the service's own migrations. */
@Testcontainers
class SagaStoreTest {

  // The image Compose runs (deploy/compose/infra.yml).
  @Container
  static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:17.2-alpine");

  static final Instant RESERVATION_EXPIRES = Instant.parse("2026-11-16T10:10:00Z");
  static final String PAYMENT_URL = "https://pay.example/s/1";
  static final JsonMapper JSON = JsonMapper.builder().build();

  static JdbcClient jdbc;
  static SagaStore store;

  @BeforeAll
  static void migrate() {
    Flyway.configure()
        .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
        .load()
        .migrate();
    var dataSource =
        new DriverManagerDataSource(
            POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
    jdbc = JdbcClient.create(dataSource);
    store =
        new SagaStore(
            jdbc, new TransactionTemplate(new DataSourceTransactionManager(dataSource)), JSON);
  }

  // ---- Creating an order ----

  @Test
  void createStartsTheSagaReservingStockAndDueNow() {
    UUID id = created();

    Map<String, Object> order =
        jdbc.sql("SELECT status, total_amount, currency, cancel_reason FROM orders WHERE id = :id")
            .param("id", id)
            .query()
            .singleRow();
    assertThat(order)
        .containsEntry("status", "PENDING")
        .containsEntry("total_amount", 375_000L)
        .containsEntry("currency", "IDR")
        .containsEntry("cancel_reason", null);
    assertThat(count("SELECT count(*) FROM order_lines WHERE order_id = :id", id)).isEqualTo(2);

    assertThat(store.find(id)).contains(new StoredSaga(id, new ReservingStock(), 1));
    assertThat(pendingCommand(id)).isEqualTo(new ReservingStock().pendingCommand().orElseThrow());
    assertThat(
            jdbc.sql("SELECT next_attempt_at <= now() FROM sagas WHERE order_id = :id")
                .param("id", id)
                .query(Boolean.class)
                .single())
        .as("due now")
        .isTrue();
    assertThat(steps(id)).containsExactly("TRANSITION OrderCreated null->RESERVING_STOCK");
  }

  // ---- Applying events ----

  static Stream<Arguments> paths() {
    StockReserved reserved = new StockReserved(RESERVATION_EXPIRES);
    IntentCreated intent = new IntentCreated(PAYMENT_URL, RESERVATION_EXPIRES);
    return Stream.of(
        Arguments.of(
            "pays", List.of(reserved, intent, new PaymentSucceeded(), new StockCommitted())),
        Arguments.of(
            "declined",
            List.of(
                reserved,
                intent,
                new PaymentFailed(),
                new IntentVoided(),
                new ReservationReleased())),
        Arguments.of(
            "pays as the deadline passes",
            List.of(
                reserved,
                intent,
                new PaymentDeadlinePassed(),
                new AlreadyCaptured(),
                new StockCommitted())),
        Arguments.of("out of stock", List.<SagaEvent>of(new InsufficientStock())),
        Arguments.of(
            "Inventory unavailable", List.of(new RetriesExhausted(), new ReservationReleased())),
        Arguments.of(
            "Payment unavailable",
            List.of(
                reserved, new RetriesExhausted(), new IntentVoided(), new ReservationReleased())),
        Arguments.of(
            "the commit finds no reservation",
            List.of(
                reserved,
                intent,
                new PaymentSucceeded(),
                new ReservationNotFound(),
                new Refunded(),
                new ReservationReleased())),
        Arguments.of(
            "the commit gives up",
            List.of(reserved, intent, new PaymentSucceeded(), new RetriesExhausted())),
        Arguments.of(
            "the refund gives up",
            List.of(
                reserved,
                intent,
                new PaymentSucceeded(),
                new ReservationNotFound(),
                new RetriesExhausted())),
        Arguments.of(
            "paid after it was cancelled",
            List.of(
                reserved,
                intent,
                new PaymentFailed(),
                new IntentVoided(),
                new ReservationReleased(),
                new PaymentSucceeded(),
                new Refunded(),
                new ReservationReleased())));
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("paths")
  void everyStepPersistsWhatTheStateMachineComputed(String path, List<SagaEvent> events) {
    UUID id = created();
    SagaState expected = new ReservingStock();
    int version = 1;

    for (SagaEvent event : events) {
      Transition t = Saga.apply(expected, event);
      expected = t.to();
      version++;

      assertThat(store.apply(id, event)).isEqualTo(new Applied(t, version));
      assertThat(store.find(id)).contains(new StoredSaga(id, expected, version));

      Map<String, Object> order =
          jdbc.sql("SELECT status, cancel_reason, payment_url FROM orders WHERE id = :id")
              .param("id", id)
              .query()
              .singleRow();
      CancelReason reason = SagaColumns.cancelReason(expected);
      assertThat(order)
          .as("the order row after %s", event)
          .containsEntry("status", expected.orderStatus().name())
          .containsEntry("cancel_reason", reason == null ? null : reason.name())
          .containsEntry("payment_url", SagaColumns.paymentUrl(expected));
      assertThat(pendingCommand(id)).isEqualTo(expected.pendingCommand().orElse(null));
    }
    assertThat(steps(id)).hasSize(events.size() + 1);
  }

  @Test
  void historyNamesConsumedEventsByTheirTopicType() {
    UUID id = created();
    drive(
        id,
        new StockReserved(RESERVATION_EXPIRES),
        new IntentCreated(PAYMENT_URL, RESERVATION_EXPIRES));
    store.apply(id, new PaymentSucceeded());

    assertThat(steps(id))
        .containsExactly(
            "TRANSITION OrderCreated null->RESERVING_STOCK",
            "EVENT StockReserved RESERVING_STOCK->CREATING_PAYMENT",
            "EVENT IntentCreated CREATING_PAYMENT->AWAITING_PAYMENT",
            "EVENT payment.succeeded AWAITING_PAYMENT->COMMITTING_STOCK");
  }

  @Test
  void theDeadlineIsStoredForTheScan() {
    UUID id = created();
    // The intent outlives the reservation, so the deadline is the reservation's, minus 2 minutes.
    drive(
        id,
        new StockReserved(RESERVATION_EXPIRES),
        new IntentCreated(PAYMENT_URL, RESERVATION_EXPIRES.plus(Duration.ofMinutes(5))));

    List<UUID> due =
        jdbc.sql(
                """
                SELECT order_id FROM sagas
                WHERE state = 'AWAITING_PAYMENT' AND payment_deadline <= :at""")
            .param("at", OffsetDateTime.parse("2026-11-16T10:08:00Z"))
            .query(UUID.class)
            .list();
    assertThat(due).contains(id);
  }

  @Test
  void timesAreTruncatedToTheMicrosecondNeverRoundedUp() {
    UUID id = created();
    drive(id, new StockReserved(RESERVATION_EXPIRES.plusNanos(999_999)));

    assertThat(store.find(id).orElseThrow().state())
        .isEqualTo(new CreatingPayment(RESERVATION_EXPIRES.plusNanos(999_000)));
  }

  // ---- order.* events ----

  @Test
  void confirmationPublishesOneOrderConfirmedMatchingTheContract() {
    UUID id = created();
    drive(
        id,
        new StockReserved(RESERVATION_EXPIRES),
        new IntentCreated(PAYMENT_URL, RESERVATION_EXPIRES),
        new PaymentSucceeded(),
        new StockCommitted());

    List<JsonNode> events = outbox(id);
    assertThat(events).hasSize(1);
    JsonNode event = events.getFirst();
    assertThat(EventSchemas.violations(event)).isEmpty();
    assertThat(event.at("/type").asString()).isEqualTo("order.confirmed");
    assertThat(event.at("/subject").asString()).isEqualTo(id.toString());
    assertThat(event.at("/data/total/amount").asLong()).isEqualTo(375_000);
    assertThat(event.at("/data/lines")).hasSize(2);
  }

  @Test
  void cancellationIsPublishedOnceEvenAfterALateRefund() {
    UUID id = created();
    drive(
        id,
        new StockReserved(RESERVATION_EXPIRES),
        new IntentCreated(PAYMENT_URL, RESERVATION_EXPIRES),
        new PaymentFailed(),
        new IntentVoided(),
        new ReservationReleased(),
        // Money arrives for the cancelled order: refunded, CANCELLED again, nothing announced.
        new PaymentSucceeded(),
        new Refunded(),
        new ReservationReleased());

    List<JsonNode> events = outbox(id);
    assertThat(events).hasSize(1);
    assertThat(EventSchemas.violations(events.getFirst())).isEmpty();
    assertThat(events.getFirst().at("/data/reason").asString()).isEqualTo("PAYMENT_FAILED");
  }

  @Test
  void eventsCarryNoPersonalData() {
    UUID id = created();
    drive(id, new InsufficientStock());

    String payload =
        jdbc.sql("SELECT payload::text FROM outbox WHERE aggregate_id = :id")
            .param("id", id.toString())
            .query(String.class)
            .single();
    assertThat(payload)
        .doesNotContain("Siti", "6281234567890", "Melati", "Bandung", "40115", "Tee, M");
  }

  @Test
  void aSecondCancellationIsRefusedAndNothingIsWritten() {
    UUID id = created();
    drive(
        id,
        new StockReserved(RESERVATION_EXPIRES),
        new IntentCreated(PAYMENT_URL, RESERVATION_EXPIRES),
        new PaymentFailed(),
        new IntentVoided());
    // As if order.cancelled had gone out already: a bug elsewhere, which the store must not repeat.
    jdbc.sql("UPDATE sagas SET cancel_published = true WHERE order_id = :id")
        .param("id", id)
        .update();
    List<String> history = steps(id);

    assertThatThrownBy(() -> store.apply(id, new ReservationReleased()))
        .isInstanceOf(IllegalStateException.class);

    assertThat(store.find(id))
        .contains(new StoredSaga(id, new Cancelling(CancelReason.PAYMENT_FAILED, true, true), 5));
    assertThat(outbox(id)).isEmpty();
    assertThat(steps(id)).isEqualTo(history);
  }

  // ---- Versions and the lease ----

  @Test
  void aResultForAnOlderVersionIsDiscarded() {
    UUID id = created();
    StockReserved reserved = new StockReserved(RESERVATION_EXPIRES);
    assertThat(store.applyIfVersion(id, reserved, 1)).isInstanceOf(Applied.class);

    assertThat(store.applyIfVersion(id, reserved, 1)).isEqualTo(new Stale(2));

    assertThat(store.find(id))
        .contains(new StoredSaga(id, new CreatingPayment(RESERVATION_EXPIRES), 2));
    assertThat(lastStepDetail(id).at("/discarded").asString()).isEqualTo("stale");
  }

  @Test
  void twoResultsForOneVersionApplyOnce() throws Exception {
    UUID id = created();
    CountDownLatch start = new CountDownLatch(1);
    Callable<ApplyResult> result =
        () -> {
          start.await();
          return store.applyIfVersion(id, new StockReserved(RESERVATION_EXPIRES), 1);
        };

    List<ApplyResult> results = new ArrayList<>();
    try (ExecutorService pool = Executors.newFixedThreadPool(2)) {
      Future<ApplyResult> first = pool.submit(result);
      Future<ApplyResult> second = pool.submit(result);
      start.countDown();
      results.add(first.get());
      results.add(second.get());
    }

    assertThat(results).filteredOn(Applied.class::isInstance).hasSize(1);
    assertThat(results).filteredOn(Stale.class::isInstance).hasSize(1);
    assertThat(store.find(id).orElseThrow().version()).isEqualTo(2);
  }

  @Test
  void applyingAResultEndsTheLeaseAndResetsTheAttempts() {
    UUID id = created();
    lease(id);

    store.applyIfVersion(id, new StockReserved(RESERVATION_EXPIRES), 1);

    assertThat(
            jdbc.sql(
                    """
                    SELECT claimed_until IS NULL AND attempt = 0 AND next_attempt_at <= now()
                    FROM sagas WHERE order_id = :id""")
                .param("id", id)
                .query(Boolean.class)
                .single())
        .as("lease ended, attempts reset, the next command due now")
        .isTrue();
  }

  @Test
  void anIgnoredEventLeavesTheLeaseAlone() {
    UUID id = created();
    lease(id);

    // Not listed for RESERVING_STOCK.
    assertThat(store.apply(id, new PaymentFailed())).isInstanceOf(Ignored.class);

    assertThat(
            jdbc.sql(
                    """
                    SELECT claimed_until IS NOT NULL AND attempt = 2 AND version = 1
                    FROM sagas WHERE order_id = :id""")
                .param("id", id)
                .query(Boolean.class)
                .single())
        .as("the runner's lease and attempts untouched")
        .isTrue();
    assertThat(lastStepDetail(id).at("/applied").asBoolean(true)).isFalse();
  }

  @Test
  void anEventForAnUnknownOrderIsNotFound() {
    UUID id = UUID.randomUUID();
    assertThat(store.apply(id, new PaymentSucceeded())).isEqualTo(new NotFound());
    assertThat(steps(id)).isEmpty();
  }

  @Test
  void aCancelledOrderKeepsItsReason() {
    UUID id = created();
    drive(id, new InsufficientStock());
    assertThat(store.find(id).orElseThrow().state())
        .isEqualTo(new Cancelled(CancelReason.INSUFFICIENT_STOCK));
  }

  // ---- Claims (RFC-0002 §4.7) ----

  @Test
  void aDueSagaIsClaimedOnceUntilItsLeaseEnds() {
    UUID id = created();

    assertThat(claimed(store.claimDue(1_000, Duration.ofSeconds(30)))).contains(id);
    assertThat(claimed(store.claimDue(1_000, Duration.ofSeconds(30))))
        .as("leased: no second claim")
        .doesNotContain(id);

    // The holder crashed: its lease runs out, and the saga is due again.
    jdbc.sql("UPDATE sagas SET claimed_until = now() - interval '1 second' WHERE order_id = :id")
        .param("id", id)
        .update();
    assertThat(store.claimDue(1_000, Duration.ofSeconds(30)))
        .filteredOn(c -> c.orderId().equals(id))
        .singleElement()
        .satisfies(
            c -> {
              assertThat(c.command()).isEqualTo(new ReservingStock().pendingCommand().get());
              assertThat(c.version()).isEqualTo(1);
              assertThat(c.attempt()).isZero();
              assertThat(c.pendingSince()).isBeforeOrEqualTo(c.now());
            });
  }

  @Test
  void aSagaWaitingForAnEventIsNeverClaimed() {
    UUID id = created();
    drive(
        id,
        new StockReserved(RESERVATION_EXPIRES),
        new IntentCreated(PAYMENT_URL, RESERVATION_EXPIRES));

    assertThat(claimed(store.claimDue(1_000, Duration.ofSeconds(30)))).doesNotContain(id);
  }

  @Test
  void aRetryForAnOlderVersionChangesNothing() {
    UUID id = created();
    drive(id, new StockReserved(RESERVATION_EXPIRES));
    List<String> history = steps(id);

    store.retryLater(
        id,
        1,
        new CommandStep("ReserveStock", 1, Outcome.RETRYABLE_ERROR, "UNAVAILABLE", ""),
        Duration.ofSeconds(1));

    assertThat(steps(id)).isEqualTo(history);
    assertThat(
            jdbc.sql("SELECT attempt FROM sagas WHERE order_id = :id")
                .param("id", id)
                .query(Integer.class)
                .single())
        .isZero();
  }

  @Test
  void pendingSinceIsSetWithTheCommandAndClearedWithIt() {
    UUID id = created();
    assertThat(pendingSinceIsSet(id)).isTrue();

    drive(
        id,
        new StockReserved(RESERVATION_EXPIRES),
        new IntentCreated(PAYMENT_URL, RESERVATION_EXPIRES));

    assertThat(pendingSinceIsSet(id)).as("waiting for payment: no command").isFalse();
  }

  // ---- Helpers ----

  static List<UUID> claimed(List<Claim> claims) {
    return claims.stream().map(Claim::orderId).toList();
  }

  static boolean pendingSinceIsSet(UUID id) {
    return jdbc.sql("SELECT pending_since IS NOT NULL FROM sagas WHERE order_id = :id")
        .param("id", id)
        .query(Boolean.class)
        .single();
  }

  static UUID created() {
    UUID id = UUID.randomUUID();
    store.create(
        new NewOrder(
            id,
            UUID.randomUUID(),
            List.of(new Line("TEE-M", "Tee, M", 150_000, 2), new Line("CAP", "Cap", 75_000, 1)),
            NewOrderTest.ADDRESS));
    return id;
  }

  static void drive(UUID id, SagaEvent... events) {
    for (SagaEvent event : events) {
      assertThat(store.apply(id, event)).as("%s applies", event).isInstanceOf(Applied.class);
    }
  }

  /** As a runner holds it: claimed for 30 s, on its second attempt, retry later. */
  static void lease(UUID id) {
    jdbc.sql(
            """
            UPDATE sagas SET claimed_until = now() + interval '30 seconds', attempt = 2,
                next_attempt_at = now() + interval '1 minute'
            WHERE order_id = :id""")
        .param("id", id)
        .update();
  }

  static long count(String sql, UUID id) {
    return jdbc.sql(sql).param("id", id).query(Long.class).single();
  }

  static SagaCommand pendingCommand(UUID id) {
    String command =
        jdbc.sql("SELECT pending_command::text FROM sagas WHERE order_id = :id")
            .param("id", id)
            .query((rs, _) -> rs.getString(1))
            .list()
            .getFirst();
    return command == null ? null : SagaColumns.toCommand(JSON.readTree(command));
  }

  static List<String> steps(UUID id) {
    return jdbc.sql(
            """
            SELECT kind || ' ' || name || ' ' || coalesce(from_state, 'null') || '->' || to_state
            FROM saga_steps WHERE order_id = :id ORDER BY seq""")
        .param("id", id)
        .query(String.class)
        .list();
  }

  static JsonNode lastStepDetail(UUID id) {
    return JSON.readTree(
        jdbc.sql(
                "SELECT detail::text FROM saga_steps WHERE order_id = :id ORDER BY seq DESC LIMIT 1")
            .param("id", id)
            .query(String.class)
            .single());
  }

  static List<JsonNode> outbox(UUID id) {
    return jdbc
        .sql("SELECT payload::text FROM outbox WHERE aggregate_id = :id ORDER BY created_at, id")
        .param("id", id.toString())
        .query(String.class)
        .list()
        .stream()
        .map(JSON::readTree)
        .toList();
  }
}
