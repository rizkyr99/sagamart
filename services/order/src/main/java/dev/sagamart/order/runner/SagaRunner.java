package dev.sagamart.order.runner;

import dev.sagamart.order.runner.StepOutcome.Done;
import dev.sagamart.order.runner.StepOutcome.Failed;
import dev.sagamart.order.runner.StepOutcome.Retryable;
import dev.sagamart.order.saga.SagaEvent;
import dev.sagamart.order.saga.SagaEvent.RetriesExhausted;
import dev.sagamart.order.saga.Transition;
import dev.sagamart.order.store.ApplyResult;
import dev.sagamart.order.store.ApplyResult.Applied;
import dev.sagamart.order.store.SagaStore;
import dev.sagamart.order.store.SagaStore.Claim;
import dev.sagamart.order.store.SagaStore.CommandStep;
import dev.sagamart.order.store.SagaStore.CommandStep.Outcome;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Runs the sagas' pending commands (RFC-0002 §4.1, §4.7): claims due sagas under a lease, makes
 * each call, and applies its result at the version it was made for. Persist, then call: the command
 * was committed with its state, so a crash anywhere here leaves it due again once the lease ends.
 */
public class SagaRunner {

  private static final Logger log = LoggerFactory.getLogger(SagaRunner.class);

  private final SagaStore store;
  private final StepExecutor executor;
  private final RetryPolicy retry;
  private final int batchSize;
  private final Duration lease;
  private final MeterRegistry meters;

  public SagaRunner(
      SagaStore store,
      StepExecutor executor,
      RetryPolicy retry,
      int batchSize,
      Duration lease,
      MeterRegistry meters) {
    this.store = store;
    this.executor = executor;
    this.retry = retry;
    this.batchSize = batchSize;
    this.lease = lease;
    this.meters = meters;
  }

  /** One poll: runs every due saga it can claim, concurrently, and returns how many it ran. */
  public int runDue() {
    List<Claim> claims = store.claimDue(batchSize, lease);
    // Each call waits on the network: a virtual thread per call.
    try (ExecutorService calls = Executors.newVirtualThreadPerTaskExecutor()) {
      claims.forEach(claim -> calls.submit(() -> run(claim)));
    }
    return claims.size();
  }

  /** Makes the claimed call once, and records what came of it. */
  void run(Claim claim) {
    String step = claim.command().getClass().getSimpleName();
    int attempt = claim.attempt() + 1;
    Timer.Sample sample = Timer.start(meters);
    StepOutcome outcome;
    try {
      outcome = executor.execute(claim.orderId(), claim.command());
    } catch (RuntimeException e) {
      // A bug or a database error on our side: retried like an unreachable dependency.
      log.atError()
          .addKeyValue("order_id", claim.orderId())
          .addKeyValue("step", step)
          .setCause(e)
          .log("saga step threw");
      outcome = new Retryable("INTERNAL", e.getClass().getSimpleName());
    }
    sample.stop(
        Timer.builder("sagamart.order.saga.step.duration")
            .description("Time per saga call, by command and outcome")
            .tags("step", step, "outcome", outcomeName(outcome))
            .publishPercentileHistogram()
            .register(meters));

    switch (outcome) {
      case Done d ->
          apply(claim, new CommandStep(step, attempt, Outcome.OK, null, null), d.event());
      case Failed f ->
          apply(
              claim,
              new CommandStep(step, attempt, Outcome.FAILED, f.code(), f.message()),
              new RetriesExhausted());
      case Retryable r -> {
        CommandStep call =
            new CommandStep(step, attempt, Outcome.RETRYABLE_ERROR, r.code(), r.message());
        Duration pendingFor = Duration.between(claim.pendingSince(), claim.now());
        Optional<Duration> backoff = retry.backoff(claim.command(), attempt, pendingFor);
        if (backoff.isPresent()) {
          store.retryLater(claim.orderId(), claim.version(), call, backoff.get());
        } else {
          apply(claim, call, new RetriesExhausted());
        }
      }
    }
  }

  private void apply(Claim claim, CommandStep call, SagaEvent result) {
    ApplyResult applied = store.applyResult(claim.orderId(), claim.version(), call, result);
    if (applied instanceof Applied(Transition t, int version)) {
      meters
          .counter(
              "sagamart.order.saga.transitions",
              "from",
              t.from().stage().name(),
              "to",
              t.to().stage().name())
          .increment();
      log.atInfo()
          .addKeyValue("order_id", claim.orderId())
          .addKeyValue("from", t.from().stage())
          .addKeyValue("to", t.to().stage())
          .addKeyValue("event", result.getClass().getSimpleName())
          .addKeyValue("attempt", call.attempt())
          .addKeyValue("version", version)
          .log("saga transition");
    }
  }

  private static String outcomeName(StepOutcome outcome) {
    return switch (outcome) {
      case Done _ -> "ok";
      case Retryable _ -> "retryable_error";
      case Failed _ -> "failed";
    };
  }
}
