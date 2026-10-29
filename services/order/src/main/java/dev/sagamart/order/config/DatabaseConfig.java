package dev.sagamart.order.config;

import com.zaxxer.hikari.HikariDataSource;
import java.util.Arrays;
import java.util.Locale;
import java.util.Set;
import javax.sql.DataSource;
import org.springframework.boot.jdbc.DataSourceBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * The data source comes from the validated {@link OrderProperties}, so a bad database setting fails
 * validation with the variable's name rather than surfacing later as a connection error.
 */
@Configuration(proxyBeanMethods = false)
class DatabaseConfig {

  @Bean
  DataSource dataSource(OrderProperties properties) {
    checkUrl(properties.db().url());
    HikariDataSource dataSource =
        DataSourceBuilder.create()
            .type(HikariDataSource.class)
            .url(properties.db().url())
            .username(properties.db().user())
            .password(properties.db().password())
            .build();
    dataSource.setPoolName("order");
    return dataSource;
  }

  private static final String SCHEME = "jdbc:postgresql://";

  /** URL query parameters pgJDBC reads as secrets. */
  private static final Set<String> SECRET_PARAMETERS = Set.of("password", "sslpassword");

  /**
   * Rejects a URL that is not PostgreSQL or that carries credentials, which pgJDBC and Flyway would
   * print in connection errors. The messages never include the value.
   */
  static void checkUrl(String url) {
    if (!url.startsWith(SCHEME)) {
      throw new IllegalStateException("ORDER_DB_URL must be a jdbc:postgresql:// URL");
    }
    String rest = url.substring(SCHEME.length());
    int query = rest.indexOf('?');
    String hosts = query < 0 ? rest : rest.substring(0, query);
    int path = hosts.indexOf('/');
    boolean userInfo = (path < 0 ? hosts : hosts.substring(0, path)).contains("@");
    boolean secretParameter =
        query >= 0
            && Arrays.stream(rest.substring(query + 1).split("&"))
                .map(p -> p.split("=", 2)[0].toLowerCase(Locale.ROOT))
                .anyMatch(SECRET_PARAMETERS::contains);
    if (userInfo || secretParameter) {
      throw new IllegalStateException(
          "ORDER_DB_URL must not carry credentials: set ORDER_DB_USER and ORDER_DB_PASSWORD");
    }
  }
}
