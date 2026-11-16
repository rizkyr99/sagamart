package dev.sagamart.order.store;

import dev.sagamart.order.saga.OrderEvent;
import dev.sagamart.order.saga.OrderEvent.OrderCancelled;
import dev.sagamart.order.saga.OrderEvent.OrderConfirmed;
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator;
import io.opentelemetry.context.Context;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * Builds the {@code order.*} envelopes (conventions §6, {@code contracts/events}). They carry no
 * personal data: no shipping address, no names.
 */
final class OrderEvents {

  private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

  /** RFC 3339 in UTC with millisecond precision (conventions §3). */
  private static final DateTimeFormatter TIME =
      DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

  private OrderEvents() {}

  /** What the events say about an order. */
  record Facts(
      UUID orderId, UUID buyerId, long total, String currency, List<NewOrder.Line> lines) {}

  static String type(OrderEvent event) {
    return switch (event) {
      case OrderConfirmed _ -> "order.confirmed";
      case OrderCancelled _ -> "order.cancelled";
    };
  }

  static ObjectNode envelope(UUID id, OrderEvent event, Facts order, Instant at) {
    ObjectNode data =
        NODES
            .objectNode()
            .put("orderId", order.orderId().toString())
            .put("buyerId", order.buyerId().toString());
    switch (event) {
      case OrderConfirmed _ -> {
        data.set("total", money(order.total(), order.currency()));
        var lines = data.putArray("lines");
        for (NewOrder.Line l : order.lines()) {
          lines
              .addObject()
              .put("sku", l.sku())
              .put("quantity", l.quantity())
              .set("unitPrice", money(l.unitPrice(), order.currency()));
        }
        data.put("confirmedAt", TIME.format(at));
      }
      case OrderCancelled e ->
          data.put("reason", e.reason().name()).put("cancelledAt", TIME.format(at));
    }
    String type = type(event);
    ObjectNode envelope =
        NODES
            .objectNode()
            .put("id", id.toString())
            .put("type", type)
            .put("source", "order")
            .put("specversion", "1.0")
            .put("time", TIME.format(at))
            .put("subject", order.orderId().toString())
            .put("dataschema", type + "/v1");
    String traceparent = traceparent();
    if (traceparent != null) {
      envelope.put("traceparent", traceparent);
    }
    envelope.set("data", data);
    return envelope;
  }

  private static ObjectNode money(long amount, String currency) {
    return NODES.objectNode().put("amount", amount).put("currency", currency);
  }

  /** The current span's W3C trace context, or null outside a sampled or recording span. */
  private static String traceparent() {
    Map<String, String> carrier = new HashMap<>();
    W3CTraceContextPropagator.getInstance().inject(Context.current(), carrier, Map::put);
    return carrier.get("traceparent");
  }
}
