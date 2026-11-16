package dev.sagamart.order.runner;

import dev.sagamart.contracts.inventory.v1.InventoryServiceGrpc;
import dev.sagamart.contracts.payment.v1.PaymentServiceGrpc;
import dev.sagamart.order.config.OrderProperties;
import dev.sagamart.order.store.SagaStore;
import io.micrometer.core.instrument.MeterRegistry;
import java.util.random.RandomGenerator;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBooleanProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.grpc.client.GrpcChannelFactory;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;

/** Wires the runner to Inventory and Payment, and polls it (RFC-0002 §4.7: every second). */
@Configuration(proxyBeanMethods = false)
class SagaRunnerConfig {

  @Bean
  GrpcStepExecutor stepExecutor(
      GrpcChannelFactory channels, OrderProperties properties, SagaStore store) {
    return new GrpcStepExecutor(
        InventoryServiceGrpc.newBlockingStub(channels.createChannel(properties.inventory().addr())),
        PaymentServiceGrpc.newBlockingStub(channels.createChannel(properties.payment().addr())),
        store::stepInput);
  }

  @Bean
  SagaRunner sagaRunner(
      SagaStore store, StepExecutor executor, OrderProperties properties, MeterRegistry meters) {
    OrderProperties.Saga saga = properties.saga();
    return new SagaRunner(
        store,
        executor,
        new RetryPolicy(
            saga.forwardRetries(),
            saga.retryBase(),
            saga.retryMax(),
            saga.compensationBudget(),
            RandomGenerator.getDefault()),
        saga.batchSize(),
        saga.lease(),
        meters);
  }

  /** Off in tests that drive the runner themselves. */
  @Configuration(proxyBeanMethods = false)
  @EnableScheduling
  @ConditionalOnBooleanProperty(name = "order.saga.poll", matchIfMissing = true)
  static class Polling {

    private final SagaRunner runner;

    Polling(SagaRunner runner) {
      this.runner = runner;
    }

    @Scheduled(fixedDelayString = "${order.saga.poll-interval}")
    void poll() {
      runner.runDue();
    }
  }
}
