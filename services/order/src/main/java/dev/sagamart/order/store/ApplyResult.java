package dev.sagamart.order.store;

import dev.sagamart.order.saga.Transition;

/**
 * What applying an event to a stored saga did. Every outcome but {@link NotFound} is in history.
 */
public sealed interface ApplyResult {

  /** The saga moved; {@code version} is its new version. */
  record Applied(Transition transition, int version) implements ApplyResult {}

  /** The table doesn't list the event for the state (a duplicate or a late event): unchanged. */
  record Ignored(Transition transition, int version) implements ApplyResult {}

  /**
   * A command's result arrived after the saga had moved on (RFC-0002 §4.7): discarded, unchanged.
   */
  record Stale(int version) implements ApplyResult {}

  /** No saga for that order. */
  record NotFound() implements ApplyResult {}
}
