package dev.sagamart.order.config;

import io.micrometer.observation.ObservationPredicate;
import java.util.Set;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.server.observation.ServerRequestObservationContext;

@Configuration(proxyBeanMethods = false)
class ObservabilityConfig {

  private static final Set<String> UNOBSERVED = Set.of("/healthz", "/readyz", "/metrics");

  /**
   * No traces or request metrics for probes and scrapes: Docker probes every 5 s and Prometheus
   * scrapes every 15 s, which would bury the requests worth looking at.
   */
  @Bean
  ObservationPredicate skipProbesAndScrapes() {
    return (name, context) ->
        !(context instanceof ServerRequestObservationContext request
            && UNOBSERVED.contains(request.getCarrier().getRequestURI()));
  }
}
