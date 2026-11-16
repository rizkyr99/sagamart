package dev.sagamart.order.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.sagamart.order.store.NewOrder.Line;
import dev.sagamart.order.store.NewOrder.ShippingAddress;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class NewOrderTest {

  static final ShippingAddress ADDRESS =
      new ShippingAddress(
          "Siti Rahma", "+6281234567890", "Jl. Melati No. 7", "Bandung", "Jawa Barat", "40115");

  @Test
  void totalsItsLinesInIdr() {
    NewOrder order =
        new NewOrder(
            UUID.randomUUID(),
            UUID.randomUUID(),
            List.of(new Line("TEE-M", "Tee, M", 150_000, 2), new Line("CAP", "Cap", 75_000, 1)),
            ADDRESS);
    assertThat(order.total()).isEqualTo(375_000);
  }

  @Test
  void needsALine() {
    assertThatThrownBy(() -> new NewOrder(UUID.randomUUID(), UUID.randomUUID(), List.of(), ADDRESS))
        .isInstanceOf(IllegalArgumentException.class);
  }

  /** RFC-0002 §8: an order printed in a log line or an exception must not carry the address. */
  @Test
  void neverPrintsTheShippingAddress() {
    NewOrder order =
        new NewOrder(
            UUID.randomUUID(), UUID.randomUUID(), List.of(new Line("CAP", "Cap", 1, 1)), ADDRESS);
    assertThat(order.toString())
        .doesNotContain("Siti", "6281234567890", "Melati", "Bandung", "Jawa Barat", "40115");
  }
}
