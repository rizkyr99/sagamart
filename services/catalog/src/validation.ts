import { ProblemError, problem } from '@sagamart/node-common';
import type { FieldError } from '@sagamart/node-common';
import type { z } from 'zod';

/** `skus[0].price.amount`, as the contract's `errors[].field` shows it. */
function fieldPath(path: readonly PropertyKey[]): string {
  return path
    .map((part, i) =>
      typeof part === 'number' ? `[${String(part)}]` : `${i === 0 ? '' : '.'}${String(part)}`,
    )
    .join('');
}

/** Parses `value` with `schema`, or throws 400 VALIDATION_FAILED listing every invalid field. */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const errors: FieldError[] = result.error.issues.map((issue) => ({
    field: fieldPath(issue.path),
    message: issue.message,
  }));
  throw new ProblemError(
    problem({ status: 400, code: 'VALIDATION_FAILED', detail: 'The request is invalid.', errors }),
  );
}
