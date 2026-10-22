import { createHash } from 'node:crypto';
import { z } from 'zod';

/** The query a cursor belongs to: sort and filters, normalised (absent filters are null). */
export type CursorQuery = Readonly<Record<string, string | number | null>>;

/** Keyset position: the last row's sort value and id. `t` keeps Postgres's microseconds, as text. */
export type CursorPosition = { t: string; id: string } | { p: number; id: string };

export type CursorKind = 'time' | 'price';

/** Why a cursor was refused: unreadable, or issued for a different query (RFC-0005 §4.3). */
export class CursorError extends Error {
  constructor(readonly reason: 'MALFORMED' | 'MISMATCH') {
    super(reason === 'MISMATCH' ? 'cursor belongs to a different query' : 'cursor is malformed');
    this.name = 'CursorError';
  }
}

/** SHA-256 prefix of the query with sorted keys, so a cursor can't be replayed against other filters. */
export function fingerprint(query: CursorQuery): string {
  const canonical = JSON.stringify(
    Object.keys(query)
      .sort()
      .map((key) => [key, query[key]]),
  );
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function encodeCursor(query: CursorQuery, position: CursorPosition): string {
  return Buffer.from(JSON.stringify({ q: fingerprint(query), ...position })).toString('base64url');
}

const envelope = z.looseObject({ q: z.string() });
const id = z.uuid();
const positions = {
  time: z.strictObject({ t: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/), id }),
  price: z.strictObject({ p: z.int().min(1).max(Number.MAX_SAFE_INTEGER), id }),
};

/** Decodes a cursor for `query`: the fingerprint must match, then the position must have the expected shape. */
export function decodeCursor(cursor: string, query: CursorQuery, kind: CursorKind): CursorPosition {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new CursorError('MALFORMED');
  }
  const parsed = envelope.safeParse(raw);
  if (!parsed.success) throw new CursorError('MALFORMED');
  const { q, ...rest } = parsed.data;
  // Fingerprint first: a cursor from another sort has another shape, but the caller's mistake is the query.
  if (q !== fingerprint(query)) throw new CursorError('MISMATCH');
  const position = positions[kind].safeParse(rest);
  if (!position.success) throw new CursorError('MALFORMED');
  return position.data;
}
