package dev.sagamart.order.saga;

/** An order's status as buyers see it (RFC-0002 §4.4); mirrors {@code sagamart.order.v1}. */
public enum OrderStatus {
  PENDING,
  AWAITING_PAYMENT,
  PAID,
  CONFIRMED,
  CANCELLED
}
