package dev.sagamart.order.saga;

/** What a transition publishes through the outbox ({@code order.*} events, ADR-0006). */
public sealed interface OrderEvent {

  /** {@code order.confirmed}. */
  record OrderConfirmed() implements OrderEvent {}

  /** {@code order.cancelled}, once per order. */
  record OrderCancelled(CancelReason reason) implements OrderEvent {}
}
