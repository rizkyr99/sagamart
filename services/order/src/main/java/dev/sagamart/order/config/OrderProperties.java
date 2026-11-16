package dev.sagamart.order.config;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.PositiveOrZero;
import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/**
 * The service's settings, bound from {@code ORDER_*} environment variables (application.yaml) and
 * validated at startup: a missing or malformed value stops the service before it serves anything.
 */
@Validated
@ConfigurationProperties("order")
public record OrderProperties(
    // Lower case only: ORDER_ENV is also the Spring profile, and "prod" selects
    // application-prod.yaml.
    @NotNull @Pattern(regexp = "local|test|prod", message = "must be local, test or prod")
        String env,
    @NotBlank String version,
    @Valid @NotNull Db db,
    @Valid @NotNull Upstream inventory,
    @Valid @NotNull Upstream payment,
    @Valid @NotNull Saga saga) {

  public record Db(
      // The scheme is checked in DatabaseConfig: a bind failure prints the value, and a URL may
      // carry
      // credentials.
      @NotBlank String url, @NotBlank String user, @NotBlank String password) {

    @Override
    public String toString() {
      return "Db[url=" + url + ", user=" + user + ", password=***]";
    }
  }

  /** A gRPC dependency: {@code host:port}, plaintext inside the Compose network. */
  public record Upstream(@NotBlank String addr) {}

  /**
   * The saga runner (RFC-0002 §4.6, §4.7). Defaults are the RFC's; tests shorten the waits.
   *
   * @param pollInterval how often the runner looks for due work
   * @param lease how long a claim holds a saga; longer than any call's deadline
   * @param batchSize sagas claimed per poll, run concurrently
   * @param forwardRetries retries of ReserveStock and CreatePaymentIntent before the saga cancels
   * @param retryBase the first backoff, doubled per retry
   * @param retryMax the longest backoff
   * @param compensationBudget how long a compensation, or CommitReservation, keeps retrying
   */
  public record Saga(
      @NotNull Duration pollInterval,
      @NotNull Duration lease,
      @Positive int batchSize,
      @PositiveOrZero int forwardRetries,
      @NotNull Duration retryBase,
      @NotNull Duration retryMax,
      @NotNull Duration compensationBudget) {}
}
