package dev.sagamart.order.runner;

import static dev.sagamart.order.runner.FakeDependencies.PAYMENT_URL;
import static dev.sagamart.order.runner.FakeDependencies.RESERVATION_EXPIRES;
import static dev.sagamart.order.runner.FakeDependencies.status;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.fail;

import dev.sagamart.contracts.inventory.v1.InventoryServiceGrpc;
import dev.sagamart.contracts.inventory.v1.ReserveStockRequest;
import dev.sagamart.contracts.payment.v1.PaymentServiceGrpc;
import dev.sagamart.order.saga.CancelReason;
import dev.sagamart.order.saga.SagaEvent.PaymentFailed;
import dev.sagamart.order.saga.SagaEvent.PaymentSucceeded;
import dev.sagamart.order.saga.SagaState;
import dev.sagamart.order.saga.SagaState.AwaitingPayment;
import dev.sagamart.order.saga.SagaState.Cancelled;
import dev.sagamart.order.saga.SagaState.Cancelling;
import dev.sagamart.order.saga.SagaState.CommittingStock;
import dev.sagamart.order.saga.SagaState.Completed;
import dev.sagamart.order.saga.SagaState.CreatingPayment;
import dev.sagamart.order.saga.SagaState.NeedsAttention;
import dev.sagamart.order.saga.SagaState.ReservingStock;
import dev.sagamart.order.store.NewOrder;
import dev.sagamart.order.store.NewOrder.Line;
import dev.sagamart.order.store.NewOrder.ShippingAddress;
import dev.sagamart.order.store.SagaStore;
import dev.sagamart.order.store.SagaStore.Claim;
import io.grpc.Status;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Predicate;
import java.util.stream.IntStream;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import tools.jackson.databind.json.JsonMapper;

/**
 * The runner end to end against Postgres and in-process Inventory and Payment: claims, calls,
 * retries and budgets (RFC-0002 §4.6, §4.7). Backoffs are milliseconds here, not seconds.
 */
@Testcontainers
class SagaRunnerTest {

  // The image Compose runs (deploy/compose/infra.yml).
  @Container
  static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:17.2-alpine");

  static final Duration LEASE = Duration.ofSeconds(30);

  static JdbcClient jdbc;
  static SagaStore store;

  final FakeDependencies deps = new FakeDependencies();
  final SagaRunner runner =
      runner(
          new GrpcStepExecutor(
              InventoryServiceGrpc.newBlockingStub(deps.channel),
              PaymentServiceGrpc.newBlockingStub(deps.channel),
              store::stepInput),
          Duration.ofMillis(1));

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
            jdbc,
            new TransactionTemplate(new DataSourceTransactionManager(dataSource)),
            JsonMapper.builder().build());
  }

  @AfterEach
  void close() {
    deps.close();
  }

  /**
   * Retries after {@code base}, doubling up to itself or 5 ms, whichever is longer; compensations
   * give up after 300 ms.
   */
  static SagaRunner runner(StepExecutor executor, Duration base) {
    Duration max = base.compareTo(Duration.ofMillis(5)) > 0 ? base : Duration.ofMillis(5);
    return new SagaRunner(
        store,
        executor,
        new RetryPolicy(3, base, max, Duration.ofMillis(300), RetryPolicyTest.MIDDLE),
        32,
        LEASE,
        new SimpleMeterRegistry());
  }

  // ---- Forward ----

  @Test
  void aCheckoutRunsToAwaitingPaymentThenCompletesOncePaid() {
    UUID id = created();

    runUntil(id, AwaitingPayment.class::isInstance);
    assertThat(state(id))
        .isEqualTo(
            new AwaitingPayment(
                RESERVATION_EXPIRES,
                RESERVATION_EXPIRES.minus(Duration.ofMinutes(2)),
                PAYMENT_URL));

    store.apply(id, new PaymentSucceeded());
    runUntil(id, Completed.class::isInstance);

    assertThat(history(id))
        .containsExactly(
            "TRANSITION OrderCreated -> RESERVING_STOCK",
            "COMMAND ReserveStock #1 OK",
            "EVENT StockReserved -> CREATING_PAYMENT",
            "COMMAND CreatePaymentIntent #1 OK",
            "EVENT IntentCreated -> AWAITING_PAYMENT",
            "EVENT payment.succeeded -> COMMITTING_STOCK",
            "COMMAND CommitReservation #1 OK",
            "EVENT StockCommitted -> COMPLETED");
    assertThat(outboxTypes(id)).containsExactly("order.confirmed");
  }

  @Test
  void outOfStockCancelsAtOnce() {
    deps.failNext(
        "ReserveStock",
        FakeDependencies.domainError(
            com.google.rpc.Code.FAILED_PRECONDITION,
            GrpcStepExecutor.INVENTORY_DOMAIN,
            "INSUFFICIENT_STOCK"));
    UUID id = created();

    runUntil(id, SagaState::isTerminal);

    assertThat(state(id)).isEqualTo(new Cancelled(CancelReason.INSUFFICIENT_STOCK));
    assertThat(outboxTypes(id)).containsExactly("order.cancelled");
  }

  // ---- Retries ----

  @Test
  void aForwardStepThatKeepsFailingCancelsAfterThreeRetries() {
    deps.failAlways("ReserveStock", status(Status.UNAVAILABLE));
    UUID id = created();

    runUntil(id, SagaState::isTerminal);

    assertThat(state(id)).isEqualTo(new Cancelled(CancelReason.INVENTORY_UNAVAILABLE));
    assertThat(history(id))
        .containsSubsequence(
            "COMMAND ReserveStock #1 RETRYABLE_ERROR UNAVAILABLE",
            "COMMAND ReserveStock #2 RETRYABLE_ERROR UNAVAILABLE",
            "COMMAND ReserveStock #3 RETRYABLE_ERROR UNAVAILABLE",
            "COMMAND ReserveStock #4 RETRYABLE_ERROR UNAVAILABLE",
            "EVENT RetriesExhausted -> CANCELLING",
            "COMMAND ReleaseReservation #1 OK",
            "EVENT ReservationReleased -> CANCELLED");
    assertThat(reserveCalls(id)).isEqualTo(4);
  }

  @Test
  void aRetryWaitsForItsBackoff() {
    SagaRunner slow =
        runner(
            new GrpcStepExecutor(
                InventoryServiceGrpc.newBlockingStub(deps.channel),
                PaymentServiceGrpc.newBlockingStub(deps.channel),
                store::stepInput),
            Duration.ofMinutes(1));
    deps.failNext("ReserveStock", status(Status.UNAVAILABLE));
    UUID id = created();

    slow.runDue();
    slow.runDue();

    assertThat(reserveCalls(id)).as("not retried before its backoff").isEqualTo(1);
    assertThat(
            jdbc.sql(
                    """
                    SELECT attempt = 1 AND claimed_until IS NULL
                        AND next_attempt_at > now() + interval '40 seconds'
                    FROM sagas WHERE order_id = :id""")
                .param("id", id)
                .query(Boolean.class)
                .single())
        .as("one failed try counted, the lease ended, the retry scheduled")
        .isTrue();
  }

  @Test
  void aFailureRepeatingCantFixGivesUpAtOnce() {
    deps.failNext("ReserveStock", status(Status.PERMISSION_DENIED));
    UUID id = created();

    runner.runDue();

    assertThat(state(id))
        .isEqualTo(new Cancelling(CancelReason.INVENTORY_UNAVAILABLE, false, false));
    assertThat(history(id)).contains("COMMAND ReserveStock #1 FAILED PERMISSION_DENIED");
  }

  @Test
  void aCompensationThatKeepsFailingNeedsAttention() {
    UUID id = created();
    runUntil(id, AwaitingPayment.class::isInstance);
    store.apply(id, new PaymentFailed());
    deps.failAlways("VoidPaymentIntent", status(Status.UNAVAILABLE));

    runUntil(id, NeedsAttention.class::isInstance);

    assertThat(state(id))
        .isEqualTo(new NeedsAttention(new Cancelling(CancelReason.PAYMENT_FAILED, true, false)));
    assertThat(history(id))
        .filteredOn(s -> s.startsWith("COMMAND VoidPaymentIntent"))
        .as("retried until the budget ran out")
        .hasSizeGreaterThan(3);
  }

  @Test
  void anExceptionInAStepIsRetriedNotLost() {
    SagaRunner broken =
        runner(
            (_, _) -> {
              throw new IllegalStateException("bug");
            },
            Duration.ofMinutes(1));
    UUID id = created();

    broken.runDue();

    assertThat(state(id)).isEqualTo(new ReservingStock());
    assertThat(history(id)).contains("COMMAND ReserveStock #1 RETRYABLE_ERROR INTERNAL");
  }

  // ---- Concurrency (RFC-0002 §4.7) ----

  @Test
  void aResultForASagaThatMovedOnIsDiscarded() {
    UUID id = created();
    runUntil(id, CreatingPayment.class::isInstance);
    Claim claim =
        store.claimDue(100, LEASE).stream()
            .filter(c -> c.orderId().equals(id))
            .findFirst()
            .orElseThrow();
    // The buyer pays before the intent's reply is recorded (the consumer, #64).
    store.apply(id, new PaymentSucceeded());

    runner.run(claim);

    assertThat(state(id)).isEqualTo(new CommittingStock());
    assertThat(history(id))
        .endsWith(
            "EVENT payment.succeeded -> COMMITTING_STOCK",
            "COMMAND CreatePaymentIntent #1 OK",
            "EVENT IntentCreated -> COMMITTING_STOCK");
  }

  @Test
  void twoRunnersNeverMakeTheSameCallTwice() throws Exception {
    List<UUID> ids = IntStream.range(0, 20).mapToObj(_ -> created()).toList();
    SagaRunner other =
        runner(
            new GrpcStepExecutor(
                InventoryServiceGrpc.newBlockingStub(deps.channel),
                PaymentServiceGrpc.newBlockingStub(deps.channel),
                store::stepInput),
            Duration.ofMillis(1));

    try (ExecutorService both = Executors.newFixedThreadPool(2)) {
      var a = both.submit(runner::runDue);
      var b = both.submit(other::runDue);
      a.get();
      b.get();
    }

    assertThat(ids).allSatisfy(id -> assertThat(reserveCalls(id)).isEqualTo(1));
  }

  // ---- Helpers ----

  static UUID created() {
    UUID id = UUID.randomUUID();
    store.create(
        new NewOrder(
            id,
            UUID.randomUUID(),
            List.of(new Line("TEE-M", "Tee, M", 150_000, 2), new Line("CAP", "Cap", 75_000, 1)),
            new ShippingAddress("A", "1", "B", "C", "D", "1")));
    return id;
  }

  /** Polls as the scheduler would, until the saga reaches {@code done}. */
  void runUntil(UUID id, Predicate<SagaState> done) {
    Instant giveUp = Instant.now().plusSeconds(10);
    while (!done.test(state(id))) {
      if (Instant.now().isAfter(giveUp)) {
        fail("stuck in %s; history %s", state(id), history(id));
      }
      if (runner.runDue() == 0) {
        Thread.onSpinWait();
      }
    }
  }

  static SagaState state(UUID id) {
    return store.find(id).orElseThrow().state();
  }

  long reserveCalls(UUID id) {
    return deps.requests(ReserveStockRequest.class).stream()
        .filter(r -> r.getOrderId().equals(id.toString()))
        .count();
  }

  /** History, compact: kind, name, attempt and outcome for calls, the new state for events. */
  static List<String> history(UUID id) {
    return jdbc.sql(
            """
            SELECT CASE kind
                WHEN 'COMMAND' THEN concat_ws(' ', kind, name, '#' || attempt, outcome,
                    detail ->> 'code')
                ELSE kind || ' ' || name || ' -> ' || to_state END
            FROM saga_steps WHERE order_id = :id ORDER BY seq""")
        .param("id", id)
        .query(String.class)
        .list();
  }

  static List<String> outboxTypes(UUID id) {
    return jdbc.sql("SELECT event_type FROM outbox WHERE aggregate_id = :id ORDER BY created_at")
        .param("id", id.toString())
        .query(String.class)
        .list();
  }
}
