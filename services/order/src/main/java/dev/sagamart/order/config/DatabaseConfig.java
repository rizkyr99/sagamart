package dev.sagamart.order.config;

import com.zaxxer.hikari.HikariDataSource;
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
}
