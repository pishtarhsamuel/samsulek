// Time values. Timestamps are UTC milliseconds since the Unix epoch; durations are milliseconds.
// Reading the clock is allowed only in core/clock.ts (architecture rule); this file is pure.

/** A whole, non-negative, safe-integer number of milliseconds: a UTC timestamp or a duration. */
export function isMillis(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
