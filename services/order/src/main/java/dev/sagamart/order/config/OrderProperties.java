package dev.sagamart.order.config;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
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
    @Valid @NotNull Db db) {

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
}
