import { Code, ConnectError } from '@connectrpc/connect';
import { problem } from '@sagamart/node-common';
import type { Problem } from '@sagamart/node-common';
import { errorDetails } from './rpc-errors.js';

// How Inventory's SetStockLevel answers become the public API's (contracts: setStockLevel). Pure.

export type StockConflictCode = 'VERSION_CONFLICT' | 'STOCK_BELOW_RESERVED';

export interface CurrentLevel {
  version: number;
  onHand: number;
  reserved: number;
}

export type StockFailure =
  { kind: 'conflict'; code: StockConflictCode } | { kind: 'problem'; problem: Problem };

/** Inventory's field names are the proto's; the public API's are camelCase. */
const PUBLIC_FIELDS: Readonly<Record<string, string>> = {
  on_hand: 'onHand',
  expected_version: 'expectedVersion',
};

export function classifyStockError(err: unknown): StockFailure {
  const unavailable: StockFailure = {
    kind: 'problem',
    problem: problem({ status: 503, code: 'DEPENDENCY_UNAVAILABLE', detail: 'Inventory is unavailable.' }),
  };
  if (!(err instanceof ConnectError)) return unavailable;
  const { reason, violations } = errorDetails(err);
  if (reason === 'VERSION_CONFLICT' || reason === 'STOCK_BELOW_RESERVED')
    return { kind: 'conflict', code: reason };
  switch (err.code) {
    case Code.InvalidArgument:
      return {
        kind: 'problem',
        problem: problem({
          status: 400,
          code: 'VALIDATION_FAILED',
          detail: 'The request is invalid.',
          errors: violations.map((v) => ({
            field: PUBLIC_FIELDS[v.field] ?? v.field,
            message: v.description,
          })),
        }),
      };
    // The gateway already checked the admin role, so Inventory refusing our identity means the keys don't match:
    // our fault, not the caller's.
    case Code.Unauthenticated:
    case Code.PermissionDenied:
      return {
        kind: 'problem',
        problem: problem({
          status: 500,
          code: 'INTERNAL_ERROR',
          detail: 'Something went wrong on our side.',
        }),
      };
    default:
      return unavailable;
  }
}

/** A 409 with what the admin needs to retry correctly: the current version, on-hand and reserved units. */
export function conflictProblem(code: StockConflictCode, sku: string, level: CurrentLevel | null): Problem {
  const current = level ?? { version: 0, onHand: 0, reserved: 0 };
  return problem({
    status: 409,
    code,
    detail:
      code === 'VERSION_CONFLICT'
        ? `${sku}'s stock changed since you read it.`
        : `${sku} has ${String(current.reserved)} units reserved; on hand can't go below that.`,
    extensions: { currentVersion: current.version, onHand: current.onHand, reserved: current.reserved },
  });
}
