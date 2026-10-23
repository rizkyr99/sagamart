import { BinaryReader, WireType } from '@bufbuild/protobuf/wire';
import type { ConnectError } from '@connectrpc/connect';

export interface ErrorDetails {
  /** google.rpc.ErrorInfo.reason, the stable error code (inventory contract). */
  reason: string | undefined;
  /** google.rpc.BadRequest field violations. */
  violations: { field: string; description: string }[];
}

/** Reads a message's string fields by number; the rest are skipped. */
function stringFields(bytes: Uint8Array): Map<number, string[]> {
  const reader = new BinaryReader(bytes);
  const fields = new Map<number, string[]>();
  while (reader.pos < reader.len) {
    const [no, wireType] = reader.tag();
    if (wireType === WireType.LengthDelimited) {
      const value = reader.bytes();
      fields.set(no, [...(fields.get(no) ?? []), new TextDecoder().decode(value)]);
    } else {
      reader.skip(wireType);
    }
  }
  return fields;
}

/**
 * The google.rpc details on a gRPC error, decoded by hand: ErrorInfo and BadRequest are two small messages, not worth
 * generating all of googleapis for. Unreadable details are ignored rather than failing the request.
 */
export function errorDetails(err: ConnectError): ErrorDetails {
  const out: ErrorDetails = { reason: undefined, violations: [] };
  for (const detail of err.details) {
    // Received details are raw ({type, value}); outgoing ones (built from a schema) never reach a client.
    if (!('type' in detail) || !(detail.value instanceof Uint8Array)) continue;
    try {
      if (detail.type === 'google.rpc.ErrorInfo') {
        out.reason = stringFields(detail.value).get(1)?.[0];
      } else if (detail.type === 'google.rpc.BadRequest') {
        const reader = new BinaryReader(detail.value);
        const violations: ErrorDetails['violations'] = [];
        while (reader.pos < reader.len) {
          const [no, wireType] = reader.tag();
          if (no === 1 && wireType === WireType.LengthDelimited) {
            const v = stringFields(reader.bytes());
            violations.push({ field: v.get(1)?.[0] ?? '', description: v.get(2)?.[0] ?? '' });
          } else {
            reader.skip(wireType);
          }
        }
        out.violations.push(...violations);
      }
    } catch {
      // A detail we can't read says nothing; the status code still stands.
    }
  }
  return out;
}
