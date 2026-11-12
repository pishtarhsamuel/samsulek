// Time values. Timestamps are UTC milliseconds since the Unix epoch; durations are milliseconds.
// Reading the clock is allowed only in core/clock.ts (architecture rule); this file is pure.

/** The latest instant the bot accepts as "now": 2200-01-01. A clock beyond it is a clock problem. */
export const MAX_TIMESTAMP_MS = 7_258_118_400_000;

/** A whole, non-negative, safe-integer number of milliseconds: a UTC timestamp or a duration. */
export function isMillis(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * A UTC timestamp the bot can act on: whole milliseconds from 1970 up to 2200. The upper bound keeps
 * a far-future clock from reaching the date code (which cannot format it) or from locking a stored
 * day ahead of real time.
 */
export function isTimestamp(value: unknown): value is number {
  return isMillis(value) && value <= MAX_TIMESTAMP_MS;
}
