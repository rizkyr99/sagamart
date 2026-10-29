package dev.sagamart.order;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

/** Order service: orders and the checkout saga orchestrator (RFC-0002). */
@SpringBootApplication
@ConfigurationPropertiesScan
public class OrderApplication {

  public static void main(String[] args) {
    SpringApplication.run(OrderApplication.class, args);
  }
}
