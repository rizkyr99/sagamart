import { BinaryWriter } from '@bufbuild/protobuf/wire';
import { Code, ConnectError } from '@connectrpc/connect';
type IncomingDetail = Extract<ConnectError['details'][number], { type: string }>;
import { describe, expect, it } from 'vitest';
import { classifyStockError, conflictProblem, unreadableConflict } from './stock-admin.js';

const info = (reason: string) => ({
  type: 'google.rpc.ErrorInfo',
  value: new BinaryWriter().uint32(10).string(reason).finish(),
});
const violation = (field: string, description: string) => ({
  type: 'google.rpc.BadRequest',
  value: new BinaryWriter()
    .uint32(10)
    .bytes(new BinaryWriter().uint32(10).string(field).uint32(18).string(description).finish())
    .finish(),
});

/** An error as a client receives it: raw details, as from grpc-status-details-bin. */
const received = (err: ConnectError, details: IncomingDetail[]): ConnectError => {
  err.details.push(...details);
  return err;
};

describe('classifyStockError', () => {
  it.each([
    ['VERSION_CONFLICT', Code.Aborted],
    ['STOCK_BELOW_RESERVED', Code.FailedPrecondition],
  ] as const)('recognises %s as a conflict to report with the current level', (reason, code) => {
    expect(classifyStockError(received(new ConnectError('x', code), [info(reason)]))).toEqual({
      kind: 'conflict',
      code: reason,
    });
  });

  it('turns INVALID_ARGUMENT into 400 with the public field names', () => {
    const result = classifyStockError(
      received(new ConnectError('bad', Code.InvalidArgument), [violation('on_hand', 'must be >= reserved')]),
    );
    expect(result).toMatchObject({
      kind: 'problem',
      problem: {
        status: 400,
        code: 'VALIDATION_FAILED',
        errors: [{ field: 'onHand', message: 'must be >= reserved' }],
      },
    });
  });

  it.each([Code.Unavailable, Code.DeadlineExceeded, Code.Canceled, Code.Internal, Code.Unknown])(
    'turns gRPC code %s into 503: Inventory is down, late or broken',
    (code) => {
      expect(classifyStockError(new ConnectError('x', code))).toMatchObject({
        kind: 'problem',
        problem: { status: 503, code: 'DEPENDENCY_UNAVAILABLE' },
      });
    },
  );

  it.each([Code.Unauthenticated, Code.PermissionDenied])(
    'turns %s into 500: the gateway checked the role, so Inventory refusing it is a key misconfiguration',
    (code) => {
      expect(classifyStockError(new ConnectError('x', code))).toMatchObject({
        kind: 'problem',
        problem: { status: 500, code: 'INTERNAL_ERROR' },
      });
    },
  );

  it('treats a non-gRPC error as 503', () => {
    expect(classifyStockError(new Error('socket hang up'))).toMatchObject({ problem: { status: 503 } });
  });
});

describe('conflictProblem', () => {
  it('carries the current version and quantities so the admin can retry correctly', () => {
    expect(
      conflictProblem('STOCK_BELOW_RESERVED', 'KAOS-M', { version: 7, onHand: 10, reserved: 4 }),
    ).toMatchObject({
      status: 409,
      code: 'STOCK_BELOW_RESERVED',
      currentVersion: 7,
      onHand: 10,
      reserved: 4,
    });
  });

  it('never claims a reserved quantity it does not know', () => {
    expect(conflictProblem('STOCK_BELOW_RESERVED', 'NEW', null).detail).not.toMatch(/units reserved/);
  });

  it('is a 503, not a 409 with made-up numbers, when the current level could not be read', () => {
    const p = unreadableConflict('VERSION_CONFLICT', 'KAOS-M');
    expect(p).toMatchObject({ status: 503, code: 'DEPENDENCY_UNAVAILABLE' });
    expect(p).not.toHaveProperty('currentVersion');
  });

  it('reports version 0 and no stock for a SKU with no stock record yet', () => {
    expect(conflictProblem('VERSION_CONFLICT', 'NEW', null)).toMatchObject({
      status: 409,
      code: 'VERSION_CONFLICT',
      currentVersion: 0,
      onHand: 0,
      reserved: 0,
    });
  });
});
