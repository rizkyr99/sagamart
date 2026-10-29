package dev.sagamart.order;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.sagamart.contracts.order.v1.GetOrderRequest;
import dev.sagamart.contracts.order.v1.OrderServiceGrpc;
import io.grpc.ManagedChannel;
import io.grpc.ManagedChannelBuilder;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.health.v1.HealthCheckRequest;
import io.grpc.health.v1.HealthCheckResponse.ServingStatus;
import io.grpc.health.v1.HealthGrpc;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.List;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

/** The service as it runs: on a real Postgres, with HTTP and gRPC on real ports. */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
@Testcontainers
class OrderApplicationTests {

  // The image Compose runs (deploy/compose/infra.yml).
  @Container
  static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:17.2-alpine");

  static final int GRPC_PORT = freePort();

  static ManagedChannel channel;

  @DynamicPropertySource
  static void properties(DynamicPropertyRegistry registry) {
    registry.add("order.env", () -> "test");
    registry.add("order.db.url", POSTGRES::getJdbcUrl);
    registry.add("order.db.user", POSTGRES::getUsername);
    registry.add("order.db.password", POSTGRES::getPassword);
    registry.add("spring.grpc.server.port", () -> GRPC_PORT);
  }

  @BeforeAll
  static void connect() {
    channel = ManagedChannelBuilder.forAddress("localhost", GRPC_PORT).usePlaintext().build();
  }

  @AfterAll
  static void disconnect() {
    channel.shutdownNow();
  }

  @LocalServerPort int httpPort;

  private final JdbcTemplate jdbc;

  OrderApplicationTests(JdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  @Test
  void healthzSaysTheProcessIsUp() throws Exception {
    HttpResponse<String> res = get("/healthz");
    assertThat(res.statusCode()).isEqualTo(200);
    assertThat(res.body()).contains("\"status\":\"UP\"");
  }

  @Test
  void readyzChecksTheDatabase() throws Exception {
    HttpResponse<String> res = get("/readyz");
    assertThat(res.statusCode()).isEqualTo(200);
    assertThat(res.body()).contains("\"status\":\"UP\"");
  }

  @Test
  void metricsAreServedInPrometheusFormat() throws Exception {
    get("/v1/nothing-here"); // so there is at least one request to count
    HttpResponse<String> res = get("/metrics");
    assertThat(res.statusCode()).isEqualTo(200);
    assertThat(res.headers().firstValue("content-type"))
        .hasValueSatisfying(t -> assertThat(t).startsWith("text/plain"));
    assertThat(res.body())
        .contains(
            "http_server_requests_seconds_bucket", "jvm_memory_used_bytes", "hikaricp_connections");
  }

  @Test
  void probesAndScrapesAreNotObserved() throws Exception {
    // Docker probes every 5 s and Prometheus scrapes every 15 s: as traces they would bury real
    // ones.
    get("/healthz");
    get("/readyz");
    get("/metrics");
    assertThat(get("/metrics").body())
        .doesNotContain("uri=\"/healthz\"", "uri=\"/readyz\"", "uri=\"/metrics\"");
  }

  @Test
  void migrationsCreateTheSchema() {
    List<String> tables =
        jdbc.queryForList(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
            String.class);
    assertThat(tables)
        .contains(
            "orders",
            "order_lines",
            "sagas",
            "saga_steps",
            "processed_events",
            "idempotency_keys",
            "outbox");
  }

  @Test
  void aCancelledOrderNeedsAReason() {
    String insert =
        "INSERT INTO orders (id, buyer_id, status, cancel_reason, total_amount, shipping_address)"
            + " VALUES (gen_random_uuid(), gen_random_uuid(), ?, ?, 1000, '{}')";
    assertThatThrownBy(() -> jdbc.update(insert, "CANCELLED", null))
        .hasMessageContaining("cancelled_has_reason");
    assertThatThrownBy(() -> jdbc.update(insert, "PENDING", "PAYMENT_FAILED"))
        .hasMessageContaining("cancelled_has_reason");
  }

  @Test
  void grpcHealthIsServing() {
    var health = HealthGrpc.newBlockingStub(channel);
    assertThat(health.check(HealthCheckRequest.getDefaultInstance()).getStatus())
        .isEqualTo(ServingStatus.SERVING);
  }

  @Test
  void orderServiceIsRegisteredButNotImplementedYet() {
    var orders = OrderServiceGrpc.newBlockingStub(channel);
    assertThatThrownBy(() -> orders.getOrder(GetOrderRequest.newBuilder().setOrderId("x").build()))
        .isInstanceOfSatisfying(
            StatusRuntimeException.class,
            e -> assertThat(e.getStatus().getCode()).isEqualTo(Status.Code.UNIMPLEMENTED));
  }

  private HttpResponse<String> get(String path) throws IOException, InterruptedException {
    try (HttpClient http = HttpClient.newHttpClient()) {
      return http.send(
          HttpRequest.newBuilder(URI.create("http://localhost:" + httpPort + path)).build(),
          HttpResponse.BodyHandlers.ofString());
    }
  }

  private static int freePort() {
    try (ServerSocket socket = new ServerSocket(0)) {
      return socket.getLocalPort();
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }
}
