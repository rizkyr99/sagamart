package dev.sagamart.order.runner;

import dev.sagamart.order.saga.SagaEvent;

/** What one call of a saga command came to. */
public sealed interface StepOutcome {

  /** The call answered, with success or a business outcome the saga handles. */
  record Done(SagaEvent event) implements StepOutcome {}

  /** The call may succeed if repeated: unreachable, too slow, or overloaded. */
  record Retryable(String code, String message) implements StepOutcome {}

  /** Repeating can't help (a malformed request, a refused identity, a broken invariant). */
  record Failed(String code, String message) implements StepOutcome {}
}
