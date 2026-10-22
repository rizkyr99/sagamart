import { randomBytes } from 'node:crypto';

/**
 * A UUIDv7 (RFC 9562): 48 bits of Unix milliseconds, then random bits. Time-ordered, so new rows land at the end of
 * a B-tree index (conventions: UUIDv7 everywhere). Not monotonic within a millisecond, which no caller needs.
 */
export function uuidv7(now: number = Date.now()): string {
  if (!Number.isInteger(now) || now < 0 || now >= 2 ** 48) {
    throw new RangeError(`uuidv7 time must be whole milliseconds in 48 bits, got ${String(now)}`);
  }
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x70, 6); // version 7
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8); // variant 10
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
