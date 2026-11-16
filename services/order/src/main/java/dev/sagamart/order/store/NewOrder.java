package dev.sagamart.order.store;

import java.util.List;
import java.util.Objects;
import java.util.UUID;

/**
 * An order as checkout accepted it, with prices locked (RFC-0002 §4.3). Validated by {@code
 * CreateOrder}; the store relies on the schema's checks as the last line.
 */
public record NewOrder(UUID id, UUID buyerId, List<Line> lines, ShippingAddress shippingAddress) {

  public NewOrder {
    Objects.requireNonNull(id);
    Objects.requireNonNull(buyerId);
    Objects.requireNonNull(shippingAddress);
    lines = List.copyOf(lines);
    if (lines.isEmpty()) {
      throw new IllegalArgumentException("an order needs at least one line");
    }
  }

  /** In IDR, which has no minor unit. */
  public long total() {
    return lines.stream().mapToLong(l -> Math.multiplyExact(l.unitPrice(), l.quantity())).sum();
  }

  /** {@code name} is the product and variant name at order time. */
  public record Line(String sku, String name, long unitPrice, int quantity) {}

  /**
   * Personal data (RFC-0002 §8): stored with the order, never logged or published. {@link
   * #toString} hides it, so an order in a log line or an exception message can't leak it.
   */
  public record ShippingAddress(
      String name,
      String phone,
      String addressLine,
      String city,
      String province,
      String postalCode) {

    @Override
    public String toString() {
      return "ShippingAddress[redacted]";
    }
  }
}
