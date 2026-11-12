// The owner's trading day: 00:00 Europe/Athens (ARCHITECTURE.md; RISK_POLICY.md limit 9 and
// invariant 14). The daily stop, the day's entry count and the day baseline reset at local
// midnight, also on the two daylight-saving days (23 and 25 hours long), because the date comes
// from the time zone database, never from adding 24 hours. Pure: the instant is passed in
// (core/clock.ts reads the clock); the answer is a calendar date text "YYYY-MM-DD".
import { isTimestamp } from './time.ts';

const DAY_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/;

const ATHENS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Athens',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** A real calendar date as "YYYY-MM-DD" (2026-02-30 is not one). */
export function isDay(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const match = DAY_TEXT.exec(value);
  if (match === null) {
    return false;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** The date text from the parts the formatter returned; throws if the time zone database left one out. */
export function dayFromParts(parts: readonly { readonly type: string; readonly value: string }[]): string {
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const text = `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
  if (!isDay(text)) {
    throw new RangeError('the time zone database gave no calendar date');
  }
  return text;
}

/** The Europe/Athens calendar date of a UTC millisecond timestamp. */
export function athensDay(ms: number): string {
  if (!isTimestamp(ms)) {
    throw new RangeError('athensDay needs a whole millisecond timestamp up to the year 2200');
  }
  return dayFromParts(ATHENS.formatToParts(new Date(ms)));
}

/** The calendar date before this one: plain date arithmetic, so daylight saving cannot skew it. */
export function previousDay(day: string): string {
  if (!isDay(day)) {
    throw new RangeError('previousDay needs a calendar date like 2026-11-09');
  }
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date - 1)).toISOString().slice(0, 10);
}
