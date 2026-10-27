package dev.sagamart.order.logging;

import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.LoggerContext;
import ch.qos.logback.classic.spi.LoggingEvent;
import java.time.Instant;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.slf4j.event.KeyValuePair;
import org.springframework.boot.json.JsonParserFactory;
import org.springframework.mock.env.MockEnvironment;

/** Conventions §7: one JSON object per line with the required fields. */
class OrderLogFormatterTests {

  private final OrderLogFormatter formatter =
      new OrderLogFormatter(
          new MockEnvironment()
              .withProperty("order.env", "local")
              .withProperty("order.version", "0.1.0"));

  private final LoggerContext context = new LoggerContext();

  @Test
  void writesTheRequiredFields() {
    LoggingEvent event =
        event(
            Level.INFO,
            "order created",
            Map.of("traceId", "4bf92f3577b34da6a3ce929d0e0e4736", "spanId", "00f067aa0ba902b7"));

    String line = formatter.format(event);

    assertThat(line).endsWith("\n").doesNotContain("\n\n");
    assertThat(parse(line))
        .containsEntry("ts", "2026-10-21T01:23:45.678Z")
        .containsEntry("level", "info")
        .containsEntry("service", "order")
        .containsEntry("env", "local")
        .containsEntry("version", "0.1.0")
        .containsEntry("msg", "order created")
        .containsEntry("trace_id", "4bf92f3577b34da6a3ce929d0e0e4736")
        .containsEntry("span_id", "00f067aa0ba902b7");
  }

  @Test
  void addsDomainIdsAsFields() {
    LoggingEvent event = event(Level.WARN, "saga transition");
    event.addKeyValuePair(new KeyValuePair("order_id", "0192a7b2-0000-7000-8000-000000000001"));
    event.addKeyValuePair(new KeyValuePair("attempt", 2));

    assertThat(parse(formatter.format(event)))
        .containsEntry("level", "warn")
        .containsEntry("order_id", "0192a7b2-0000-7000-8000-000000000001")
        .containsEntry("attempt", 2);
  }

  @Test
  void leavesOutTraceIdsOutsideASpan() {
    assertThat(parse(formatter.format(event(Level.DEBUG, "tick"))))
        .doesNotContainKeys("trace_id", "span_id", "error");
  }

  @Test
  void includesTheStackTraceOfAnError() {
    LoggingEvent event = event(Level.ERROR, "relay failed");
    event.setThrowableProxy(
        new ch.qos.logback.classic.spi.ThrowableProxy(new IllegalStateException("broker down")));

    Map<String, Object> fields = parse(formatter.format(event));
    assertThat(fields).containsEntry("level", "error");
    assertThat((String) fields.get("error")).contains("IllegalStateException: broker down");
  }

  @Test
  void reportsTraceAsDebug() {
    assertThat(parse(formatter.format(event(Level.TRACE, "detail"))))
        .containsEntry("level", "debug");
  }

  private LoggingEvent event(Level level, String message) {
    return event(level, message, Map.of());
  }

  private LoggingEvent event(Level level, String message, Map<String, String> mdc) {
    LoggingEvent event = new LoggingEvent();
    event.setMDCPropertyMap(mdc);
    event.setLoggerContext(context);
    event.setLoggerName("dev.sagamart.order.Test");
    event.setLevel(level);
    event.setMessage(message);
    event.setInstant(Instant.parse("2026-10-21T01:23:45.678912Z"));
    return event;
  }

  private static Map<String, Object> parse(String line) {
    return JsonParserFactory.getJsonParser().parseMap(line);
  }
}
