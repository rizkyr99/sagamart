import { createHash } from 'node:crypto';
import { ProblemError, problem } from '@sagamart/node-common';

const invalid = (field: string, message: string): ProblemError =>
  new ProblemError(
    problem({
      status: 400,
      code: 'VALIDATION_FAILED',
      detail: 'The request is invalid.',
      errors: [{ field, message }],
    }),
  );

/** The version in `If-Match: "<version>"` (contracts: IfMatch). Absent is 428; anything else malformed is 400. */
export function parseIfMatch(header: string | undefined): number {
  if (header === undefined) {
    throw new ProblemError(
      problem({
        status: 428,
        code: 'IF_MATCH_REQUIRED',
        detail: 'Send If-Match with the version from the ETag you last read.',
      }),
    );
  }
  const match = /^"([1-9][0-9]{0,8})"$/.exec(header);
  if (!match?.[1]) throw invalid('If-Match', 'must be one strong ETag, such as "3"');
  return Number(match[1]);
}

/** The Idempotency-Key header (contracts: IdempotencyKey): 8–128 of A–Z, a–z, 0–9, `.`, `_`, `:` and `-`. */
export function parseIdempotencyKey(header: string | undefined): string {
  if (header === undefined || !/^[A-Za-z0-9._:-]{8,128}$/.test(header)) {
    throw invalid('Idempotency-Key', 'is required: 8 to 128 letters, digits, ".", "_", ":" or "-"');
  }
  return header;
}

/** JSON with object keys sorted at every depth, so equal bodies hash equally however a client orders them. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  // JSON.stringify(undefined) is undefined, not a string: an absent body hashes like null.
  return value === undefined ? 'null' : JSON.stringify(value);
}

/** SHA-256 of method, path and canonical body: what "the same request" means for an Idempotency-Key. */
export function requestHash(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method} ${path}\n${canonical(body)}`)
    .digest('hex');
}
