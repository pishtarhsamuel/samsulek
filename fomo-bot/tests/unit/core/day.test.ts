// The owner's trading day: 00:00 Europe/Athens (ARCHITECTURE.md; RISK_POLICY.md limit 9 and
// invariant 14). The daily stop, the day's entry count and the day baseline all reset at local
// midnight, also on the two daylight-saving days (23 and 25 hours long). Pure: the instant is passed
// in (core/clock.ts reads the clock), the answer is a calendar date text "YYYY-MM-DD".
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { athensDay, dayFromParts, isDay, previousDay } from '../../../src/core/day.ts';

const utc = (y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0): number => Date.UTC(y, m - 1, d, h, min, s, ms);

describe('athensDay: the local calendar date in Europe/Athens', () => {
  it('an ordinary instant', () => {
    assert.equal(athensDay(utc(2026, 11, 9, 12)), '2026-11-09');
    assert.equal(athensDay(0), '1970-01-01');
  });

  it('winter (UTC+2): the day turns at 22:00 UTC', () => {
    assert.equal(athensDay(utc(2026, 11, 8, 21, 59, 59, 999)), '2026-11-08');
    assert.equal(athensDay(utc(2026, 11, 8, 22)), '2026-11-09');
  });

  it('summer (UTC+3): the day turns at 21:00 UTC', () => {
    assert.equal(athensDay(utc(2026, 7, 14, 20, 59, 59, 999)), '2026-07-14');
    assert.equal(athensDay(utc(2026, 7, 14, 21)), '2026-07-15');
  });

  it('spring forward, 2026-03-29: a 23-hour day from 22:00 UTC to 21:00 UTC', () => {
    assert.equal(athensDay(utc(2026, 3, 28, 21, 59, 59, 999)), '2026-03-28');
    assert.equal(athensDay(utc(2026, 3, 28, 22)), '2026-03-29');
    assert.equal(athensDay(utc(2026, 3, 29, 0, 59, 59, 999)), '2026-03-29'); // 02:59:59.999 before the jump
    assert.equal(athensDay(utc(2026, 3, 29, 1)), '2026-03-29'); // 04:00 after it
    assert.equal(athensDay(utc(2026, 3, 29, 20, 59, 59, 999)), '2026-03-29');
    assert.equal(athensDay(utc(2026, 3, 29, 21)), '2026-03-30');
  });

  it('fall back, 2026-10-25: a 25-hour day from 21:00 UTC to 22:00 UTC the next evening', () => {
    assert.equal(athensDay(utc(2026, 10, 24, 20, 59, 59, 999)), '2026-10-24');
    assert.equal(athensDay(utc(2026, 10, 24, 21)), '2026-10-25');
    assert.equal(athensDay(utc(2026, 10, 25, 0, 30)), '2026-10-25'); // 03:30 EEST
    assert.equal(athensDay(utc(2026, 10, 25, 1, 30)), '2026-10-25'); // 03:30 EET, the repeated hour
    assert.equal(athensDay(utc(2026, 10, 25, 21, 59, 59, 999)), '2026-10-25');
    assert.equal(athensDay(utc(2026, 10, 25, 22)), '2026-10-26');
  });

  it('refuses anything that is not a whole millisecond timestamp', () => {
    for (const bad of [Number.NaN, -1, 1.5, Infinity, '2026-11-09', null, undefined, 1n, Date.UTC(2200, 0, 1) + 1, Number.MAX_SAFE_INTEGER]) {
      assert.throws(() => athensDay(bad as number), /timestamp/, String(bad));
    }
  });
});

describe('athensDay properties', () => {
  const instant = fc.integer({ min: utc(2020, 1, 1), max: utc(2040, 1, 1) });

  it('always a valid date, never going backwards as time moves forward', () => {
    fc.assert(
      fc.property(instant, fc.integer({ min: 0, max: 400 * 24 * 3_600_000 }), (t, later) => {
        const a = athensDay(t);
        const b = athensDay(t + later);
        assert.ok(isDay(a) && isDay(b));
        assert.ok(a <= b, `${a} then ${b}`);
      }),
    );
  });

  it('a day lasts 23 to 25 hours: 25 hours later is always a later day, 22 hours later never a day past the next', () => {
    const HOUR = 3_600_000;
    fc.assert(
      fc.property(instant, (t) => {
        assert.ok(athensDay(t + 25 * HOUR) > athensDay(t), 'a day is at most 25 hours');
        assert.ok(athensDay(t + 22 * HOUR) <= athensDay(t + 25 * HOUR));
        assert.ok(athensDay(t + 48 * HOUR) >= previousDay(athensDay(t + 25 * HOUR)));
      }),
    );
  });

  it('every day boundary is local midnight: the instant before is the previous day and the day number goes up by exactly one', () => {
    fc.assert(
      fc.property(instant, (t) => {
        // walk forward to the first instant of the next day, in 1-minute steps from a coarse start
        let step = t;
        const day = athensDay(step);
        while (athensDay(step) === day) {
          step += 60_000;
        }
        assert.equal(previousDay(athensDay(step)), day);
      }),
      { numRuns: 60 },
    );
  });
});

describe('dayFromParts: fail closed if the time zone database leaves a part out', () => {
  const part = (type: string, value: string) => ({ type, value });
  it('builds the date from year, month and day parts, in any order and with other parts around', () => {
    assert.equal(dayFromParts([part('month', '11'), part('literal', '/'), part('day', '09'), part('year', '2026')]), '2026-11-09');
    assert.equal(dayFromParts([part('day', '01'), part('year', '2027'), part('month', '01'), part('weekday', 'Fri')]), '2027-01-01');
  });

  it('a year before 100 is refused too: JavaScript\'s Date.UTC would read it as 19xx', () => {
    assert.throws(() => dayFromParts([part('year', '99'), part('month', '01'), part('day', '01')]), /no calendar date/);
  });

  it('refuses a missing or impossible part instead of guessing a day', () => {
    assert.throws(() => dayFromParts([]), /no calendar date/);
    assert.throws(() => dayFromParts([part('year', '2026'), part('month', '11')]), /no calendar date/);
    assert.throws(() => dayFromParts([part('year', '2026'), part('month', '13'), part('day', '01')]), /no calendar date/);
    assert.throws(() => dayFromParts([part('year', '2026'), part('month', '02'), part('day', '30')]), /no calendar date/);
  });
});

describe('previousDay and isDay', () => {
  it('previousDay is plain calendar arithmetic, independent of daylight saving', () => {
    assert.equal(previousDay('2026-11-09'), '2026-11-08');
    assert.equal(previousDay('2026-03-01'), '2026-02-28');
    assert.equal(previousDay('2024-03-01'), '2024-02-29');
    assert.equal(previousDay('2026-01-01'), '2025-12-31');
    assert.equal(previousDay('2026-03-30'), '2026-03-29');
    assert.equal(previousDay('2026-10-26'), '2026-10-25');
  });

  it('refuses anything that is not a real calendar date', () => {
    for (const bad of ['2026-13-01', '2026-02-30', '2026-2-3', '26-02-03', '2026-02-03T00:00', '', ' 2026-02-03', null, 7]) {
      assert.equal(isDay(bad), false, String(bad));
      assert.throws(() => previousDay(bad as string), /date/, String(bad));
    }
    assert.equal(isDay('2024-02-29'), true);
    assert.equal(isDay('2026-02-29'), false);
  });
});
