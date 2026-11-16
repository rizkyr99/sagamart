package dev.sagamart.order.runner;

import dev.sagamart.order.saga.SagaCommand;
import java.util.UUID;

/** Makes the call a saga command stands for. Every call is idempotent on the order ID. */
public interface StepExecutor {

  StepOutcome execute(UUID orderId, SagaCommand command);
}
