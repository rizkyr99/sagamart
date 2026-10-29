package dev.sagamart.order.saga;

import java.util.List;

/**
 * One step of the state machine. {@code applied} is false for a duplicate or stale event: the saga
 * is unchanged and only the history records it.
 */
public record Transition(
    SagaState from, SagaEvent event, SagaState to, List<OrderEvent> publish, boolean applied) {

  public Transition {
    publish = List.copyOf(publish);
  }

  static Transition to(SagaState from, SagaEvent event, SagaState to, OrderEvent... publish) {
    return new Transition(from, event, to, List.of(publish), true);
  }

  static Transition ignored(SagaState state, SagaEvent event) {
    return new Transition(state, event, state, List.of(), false);
  }
}
