package dev.sagamart.order.store;

import com.networknt.schema.Error;
import com.networknt.schema.Schema;
import com.networknt.schema.SchemaLocation;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SchemaRegistryConfig;
import com.networknt.schema.SpecificationVersion;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import tools.jackson.databind.JsonNode;

/**
 * Validates emitted events against {@code contracts/events} (testing strategy §3), with the schemas
 * read from the repository, so a contract change breaks this service's tests.
 */
final class EventSchemas {

  private static final String ID_PREFIX = "https://sagamart.dev/schemas/events/";

  /** Serves the schemas' {@code $id}s, and the {@code $ref}s between them, from the repository. */
  private static final SchemaRegistry REGISTRY =
      SchemaRegistry.withDefaultDialect(
          SpecificationVersion.DRAFT_2020_12,
          builder ->
              builder
                  .schemaRegistryConfig(
                      SchemaRegistryConfig.builder().formatAssertionsEnabled(true).build())
                  .schemas(EventSchemas::read));

  private EventSchemas() {}

  /** Tests run from services/order; anything outside the contracts isn't served. */
  private static String read(String iri) {
    if (!iri.startsWith(ID_PREFIX)) {
      return null;
    }
    try {
      return Files.readString(
          Path.of("../../contracts/events").resolve(iri.substring(ID_PREFIX.length())));
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  /** The violations of the schema the event's {@code dataschema} names; empty if it conforms. */
  static List<String> violations(JsonNode event) {
    String type = event.required("type").asString();
    Schema schema =
        REGISTRY.getSchema(SchemaLocation.of(ID_PREFIX + "schemas/" + type + ".v1.schema.json"));
    return schema.validate(event).stream().map(Error::toString).toList();
  }
}
