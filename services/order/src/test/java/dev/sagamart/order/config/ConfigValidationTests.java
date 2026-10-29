package dev.sagamart.order.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.sagamart.order.OrderApplication;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.context.properties.bind.validation.BindValidationException;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.core.NestedExceptionUtils;
import org.springframework.validation.FieldError;

/** Conventions §10: a missing or malformed setting stops the service at startup, naming it. */
@ExtendWith(OutputCaptureExtension.class)
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

  @Test
  void refusesAUrlThatIsNotJdbcPostgres() {
    Map<String, Object> props = new HashMap<>(VALID);
    props.put("order.db.url", "postgres://localhost/order");
    assertThatThrownBy(() -> start(props))
        .satisfies(
            e ->
                assertThat(NestedExceptionUtils.getMostSpecificCause(e))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("ORDER_DB_URL")
                    .hasMessageContaining("jdbc:postgresql://"));
  }

  /** Every way startup can fail on config, including a bad URL that carries credentials. */
  static Stream<Arguments> failuresWithAPassword() {
    String password = "pw-" + UUID.randomUUID(); // generated: no secret-looking literal in the code
    return Stream.concat(
        invalid().map(a -> Arguments.of(a.get()[0], a.get()[1], password)),
        Stream.of(
            Arguments.of(
                "order.db.url", "postgres://order:" + password + "@localhost/order", password),
            Arguments.of(
                "order.db.url",
                "jdbcpostgresql://localhost/order?password=" + password,
                password)));
  }

  @ParameterizedTest(name = "{0}=\"{1}\"")
  @MethodSource("failuresWithAPassword")
  void neverLogsTheDatabasePassword(
      String key, String value, String password, CapturedOutput output) {
    Map<String, Object> props = new HashMap<>(VALID);
    props.put("order.db.password", password);
    props.put(key, value);
    assertThatThrownBy(() -> start(props))
        .satisfies(e -> assertThat(stackTrace(e)).doesNotContain(password));
    assertThat(output.getAll()).doesNotContain(password);
  }

  /** Credentials belong in ORDER_DB_USER and ORDER_DB_PASSWORD, where they are never logged. */
  static Stream<String> urlsWithCredentials() {
    return Stream.of(
        "jdbc:postgresql://localhost:1/order?password=%s",
        "jdbc:postgresql://localhost:1/order?user=order&password=%s",
        "jdbc:postgresql://localhost:1/order?sslpassword=%s",
        "jdbc:postgresql://order:%s@localhost:1/order");
  }

  @ParameterizedTest
  @MethodSource("urlsWithCredentials")
  void refusesCredentialsInTheUrlWithoutPrintingThem(String template, CapturedOutput output) {
    String secret = "pw-" + UUID.randomUUID();
    Map<String, Object> props = new HashMap<>(VALID);
    props.put("order.db.url", template.formatted(secret));
    // With migrations on, as in local: the first connection is where pgJDBC would print the URL.
    assertThatThrownBy(() -> start(props, "spring.flyway.enabled=true"))
        .satisfies(
            e -> {
              assertThat(NestedExceptionUtils.getMostSpecificCause(e))
                  .isInstanceOf(IllegalStateException.class)
                  .hasMessageContaining("ORDER_DB_URL")
                  .hasMessageContaining("ORDER_DB_PASSWORD");
              assertThat(stackTrace(e)).doesNotContain(secret);
            });
    assertThat(output.getAll()).doesNotContain(secret);
  }

  /** As command-line arguments, which outrank application.yaml like the environment does. */
  private static void start(Map<String, Object> props, String... overrides) {
    String[] args =
        props.entrySet().stream()
            .map(e -> "--" + e.getKey() + "=" + e.getValue())
            .toArray(String[]::new);
    new SpringApplicationBuilder(OrderApplication.class)
        .web(WebApplicationType.NONE)
        .properties("spring.grpc.server.port=0", "spring.flyway.enabled=false")
        .run(
            Stream.concat(Stream.of(args), Stream.of(overrides).map(o -> "--" + o))
                .toArray(String[]::new))
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
