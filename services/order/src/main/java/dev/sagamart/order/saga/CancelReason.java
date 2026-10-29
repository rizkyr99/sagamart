package dev.sagamart.order.saga;

/** Why an order was cancelled; mirrors {@code sagamart.order.v1.CancelReason}. */
public enum CancelReason {
  INSUFFICIENT_STOCK,
  PAYMENT_FAILED,
  PAYMENT_TIMEOUT,
  /** The reservation was lost (it expired) or could not be committed; any payment is refunded. */
  STOCK_UNAVAILABLE,
  /** Payment couldn't be started after the retry budget. */
  PAYMENT_UNAVAILABLE,
  /** Stock couldn't be reserved after the retry budget; nothing was charged. */
  INVENTORY_UNAVAILABLE
}
