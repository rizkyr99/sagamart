package dev.sagamart.order.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.sagamart.order.OrderApplication;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.HashMap;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.context.properties.bind.validation.BindValidationException;
import org.springframework.core.NestedExceptionUtils;
import org.springframework.validation.FieldError;

/** Conventions §10: a missing or malformed setting stops the service at startup, naming it. */
class ConfigValidationTests {

  private static final Map<String, Object> VALID =
      Map.of(
          "order.env", "test",
          "order.db.url", "jdbc:postgresql://localhost:1/order",
          "order.db.user", "order",
          "order.db.password", "order");

  static Stream<Arguments> invalid() {
    return Stream.of(
        Arguments.of("order.env", "", "order.env"),
        Arguments.of("order.env", "staging", "order.env"),
        Arguments.of("order.env", "PROD", "order.env"),
        Arguments.of("order.db.url", "", "order.db.url"),
        Arguments.of("order.db.url", "postgres://localhost/order", "order.db.url"),
        Arguments.of("order.db.user", "", "order.db.user"),
        Arguments.of("order.db.password", "", "order.db.password"));
  }

  @ParameterizedTest(name = "{0}=\"{1}\"")
  @MethodSource("invalid")
  void refusesToStart(String key, String value, String named) {
    Map<String, Object> props = new HashMap<>(VALID);
    props.put(key, value);
    assertThatThrownBy(() -> start(props))
        .satisfies(
            e -> {
              Throwable root = NestedExceptionUtils.getMostSpecificCause(e);
              assertThat(root).isInstanceOf(BindValidationException.class);
              // Only the bad setting is reported (an empty URL breaks two rules, both on it).
              assertThat(((BindValidationException) root).getValidationErrors().getAllErrors())
                  .isNotEmpty()
                  .allSatisfy(
                      err -> assertThat(((FieldError) err).getField()).isEqualTo(field(named)));
            });
  }

  @ParameterizedTest(name = "{0}=\"{1}\"")
  @MethodSource("invalid")
  void neverLogsTheDatabasePassword(String key, String value, String named) {
    Map<String, Object> props = new HashMap<>(VALID);
    props.put("order.db.password", "s3cret-pw");
    props.put(key, value);
    assertThatThrownBy(() -> start(props))
        .satisfies(e -> assertThat(stackTrace(e)).doesNotContain("s3cret-pw"));
  }

  /** As command-line arguments, which outrank application.yaml like the environment does. */
  private static void start(Map<String, Object> props) {
    String[] args =
        props.entrySet().stream()
            .map(e -> "--" + e.getKey() + "=" + e.getValue())
            .toArray(String[]::new);
    new SpringApplicationBuilder(OrderApplication.class)
        .web(WebApplicationType.NONE)
        .properties("spring.grpc.server.port=0", "spring.flyway.enabled=false")
        .run(args)
        .close();
  }

  private static String field(String property) {
    return property.substring("order.".length());
  }

  private static String stackTrace(Throwable e) {
    var out = new StringWriter();
    e.printStackTrace(new PrintWriter(out));
    return out.toString();
  }
}
