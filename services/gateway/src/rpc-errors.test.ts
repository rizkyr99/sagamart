import { BinaryWriter } from '@bufbuild/protobuf/wire';
import { Code, ConnectError } from '@connectrpc/connect';
type IncomingDetail = Extract<ConnectError['details'][number], { type: string }>;
import { describe, expect, it } from 'vitest';
import { errorDetails } from './rpc-errors.js';

// Encoded as Go's status.WithDetails sends them: google.rpc.ErrorInfo{reason=1, domain=2} and
// google.rpc.BadRequest{field_violations=1: {field=1, description=2}}.
const errorInfo = (reason: string) => ({
  type: 'google.rpc.ErrorInfo',
  value: new BinaryWriter().uint32(10).string(reason).uint32(18).string('inventory.sagamart.dev').finish(),
});
const badRequest = (...violations: [string, string][]) => {
  const w = new BinaryWriter();
  for (const [field, description] of violations) {
    w.uint32(10).bytes(new BinaryWriter().uint32(10).string(field).uint32(18).string(description).finish());
  }
  return { type: 'google.rpc.BadRequest', value: w.finish() };
};

/** An error as a client receives it: raw details, as from grpc-status-details-bin. */
const received = (err: ConnectError, details: IncomingDetail[]): ConnectError => {
  err.details.push(...details);
  return err;
};

describe('errorDetails', () => {
  it("reads ErrorInfo's reason", () => {
    const err = received(new ConnectError('conflict', Code.Aborted), [errorInfo('VERSION_CONFLICT')]);
    expect(errorDetails(err)).toEqual({ reason: 'VERSION_CONFLICT', violations: [] });
  });

  it("reads BadRequest's field violations", () => {
    const err = received(new ConnectError('bad', Code.InvalidArgument), [
      badRequest(['sku', 'must not contain whitespace'], ['on_hand', 'must be >= 0']),
    ]);
    expect(errorDetails(err)).toEqual({
      reason: undefined,
      violations: [
        { field: 'sku', description: 'must not contain whitespace' },
        { field: 'on_hand', description: 'must be >= 0' },
      ],
    });
  });

  it('ignores details it does not know, and bytes it cannot read', () => {
    const err = received(new ConnectError('x', Code.Internal), [
      { type: 'google.rpc.DebugInfo', value: new Uint8Array([1, 2, 3]) },
      { type: 'google.rpc.ErrorInfo', value: new Uint8Array([10, 200]) }, // truncated
    ]);
    expect(errorDetails(err)).toEqual({ reason: undefined, violations: [] });
  });
});
