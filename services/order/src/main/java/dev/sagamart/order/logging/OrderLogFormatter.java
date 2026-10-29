package dev.sagamart.order.logging;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.pattern.ThrowableProxyConverter;
import ch.qos.logback.classic.spi.ILoggingEvent;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import org.slf4j.event.KeyValuePair;
import org.springframework.boot.json.JsonWriter;
import org.springframework.boot.json.JsonWriter.PairExtractor;
import org.springframework.boot.logging.structured.StructuredLogFormatter;
import org.springframework.core.env.Environment;

/**
 * One JSON object per line with the fields of conventions §7. Domain IDs are added with SLF4J's
 * fluent API ({@code log.atInfo().addKeyValue("order_id", id).log("order created")}) and become
 * top-level fields; Micrometer Tracing puts the trace and span IDs in the MDC.
 */
public class OrderLogFormatter implements StructuredLogFormatter<ILoggingEvent> {

  private static final DateTimeFormatter TIMESTAMP =
      DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSSX").withZone(ZoneOffset.UTC);

  private static final PairExtractor<KeyValuePair> KEY_VALUE =
      PairExtractor.of(pair -> pair.key, pair -> pair.value);

  private final JsonWriter<ILoggingEvent> writer;

  public OrderLogFormatter(Environment environment) {
    // Read raw: logging starts before OrderProperties is bound and validated.
    String env = environment.getProperty("order.env", "");
    String version = environment.getProperty("order.version", "");
    ThrowableProxyConverter throwable = new ThrowableProxyConverter();
    throwable.start();
    this.writer =
        JsonWriter.<ILoggingEvent>of(
                members -> {
                  members.add("ts", event -> TIMESTAMP.format(event.getInstant()));
                  members.add("level", event -> level(event.getLevel()));
                  members.add("service", "order");
                  members.add("env", env);
                  members.add("version", version);
                  members.add("msg", ILoggingEvent::getFormattedMessage);
                  members.add("logger", ILoggingEvent::getLoggerName);
                  members
                      .add("trace_id", event -> event.getMDCPropertyMap().get("traceId"))
                      .whenHasLength();
                  members
                      .add("span_id", event -> event.getMDCPropertyMap().get("spanId"))
                      .whenHasLength();
                  members
                      .from(ILoggingEvent::getKeyValuePairs)
                      .whenNotEmpty()
                      .usingExtractedPairs(Iterable::forEach, KEY_VALUE);
                  members.add("error", throwable::convert).whenHasLength();
                })
            .withNewLineAtEnd();
  }

  @Override
  public String format(ILoggingEvent event) {
    return writer.writeToString(event);
  }

  /** Conventions §7 levels; TRACE is reported as debug. */
  private static String level(Level level) {
    return switch (level.toInt()) {
      case Level.ERROR_INT -> "error";
      case Level.WARN_INT -> "warn";
      case Level.INFO_INT -> "info";
      default -> "debug";
    };
  }
}
