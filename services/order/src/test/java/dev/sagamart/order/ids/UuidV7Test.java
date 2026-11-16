package dev.sagamart.order.ids;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.stream.IntStream;
import org.junit.jupiter.api.Test;

class UuidV7Test {

  /** The id pattern of contracts/events/envelope.schema.json. */
  static final String ENVELOPE_ID =
      "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

  @Test
  void isVersion7WithTheRfcVariant() {
    UUID id = UuidV7.generate();
    assertThat(id.version()).isEqualTo(7);
    assertThat(id.variant()).isEqualTo(2);
    assertThat(id.toString()).matches(ENVELOPE_ID);
  }

  @Test
  void carriesItsMillisecondInTheTopBits() {
    Instant at = Instant.parse("2026-11-16T10:00:00.123Z");
    assertThat(UuidV7.at(at).getMostSignificantBits() >>> 16).isEqualTo(at.toEpochMilli());
  }

  @Test
  void sortsByTime() {
    Instant at = Instant.parse("2026-11-16T10:00:00Z");
    UUID earlier = UuidV7.at(at);
    UUID later = UuidV7.at(at.plusMillis(1));
    // Postgres orders UUIDs bytewise, as their text sorts.
    assertThat(earlier.toString()).isLessThan(later.toString());
  }

  @Test
  void isUniqueWithinOneMillisecond() {
    Instant at = Instant.parse("2026-11-16T10:00:00Z");
    Set<UUID> ids = new HashSet<>();
    IntStream.range(0, 10_000).forEach(_ -> ids.add(UuidV7.at(at)));
    assertThat(ids).hasSize(10_000);
  }
}
