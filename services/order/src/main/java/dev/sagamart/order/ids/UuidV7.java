package dev.sagamart.order.ids;

import java.security.SecureRandom;
import java.time.Instant;
import java.util.UUID;

/**
 * UUIDv7 (RFC 9562 §5.7): a 48-bit Unix millisecond timestamp, then random bits. Time-ordered, so
 * index-friendly (conventions §3). The JDK only makes v4.
 */
public final class UuidV7 {

  private static final SecureRandom RANDOM = new SecureRandom();

  private UuidV7() {}

  public static UUID generate() {
    return at(Instant.now());
  }

  static UUID at(Instant time) {
    long millis = time.toEpochMilli();
    long msb = (millis << 16) | 0x7000L | (RANDOM.nextInt() & 0x0FFFL);
    long lsb = (RANDOM.nextLong() & 0x3FFF_FFFF_FFFF_FFFFL) | 0x8000_0000_0000_0000L;
    return new UUID(msb, lsb);
  }
}
