// The slot feed's bound as a property (STORAGE_DESIGN.md s.16.14; review T, risk 1): with one channel
// only (so no agreement can adopt a jump), over any stretch in which the slot stays known, it rises by
// at most toleranceSlots + ceil(maxSlotsPerSecond x elapsed): the tolerance never compounds, whatever
// the channel reports and however often. Also: the slot never goes down while known, and it is never
// a value the channel did not report. Random reports: steps of 1 to 1,900 ms, readings from 50 below
// to 400 above the last one, with rare wild jumps.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { SLOT_FEED_DEFAULTS, createSlotFeed } from '../../../src/app/slots.ts';

const T0 = Date.UTC(2026, 11, 1, 12);
const S = 400_000_000n;
const { toleranceSlots, maxSlotsPerSecond } = SLOT_FEED_DEFAULTS;

const stepArb = fc.record({
  dt: fc.integer({ min: 1, max: 1_900 }),
  delta: fc.oneof({ weight: 20, arbitrary: fc.integer({ min: -50, max: 400 }) }, { weight: 1, arbitrary: fc.integer({ min: 1_000, max: 1_000_000 }) }),
});

describe('slot feed properties (review T, risk 1)', () => {
  it('one channel can never raise a known slot by more than the budget plus the rate over the time it stays known', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 200 }), (steps) => {
        let now = T0;
        const feed = createSlotFeed({ ...SLOT_FEED_DEFAULTS, clock: { now: () => now }, alerts: { alert: () => undefined } });
        feed.report('stream', S);
        now += 500;
        feed.report('stream', S);
        const reported = new Set<bigint>([S]);
        let start: { slot: bigint; at: number } | null = { slot: S, at: now };
        let last = S;
        let reading = S;
        for (const { dt, delta } of steps) {
          now += dt;
          reading = reading + BigInt(delta) > 0n ? reading + BigInt(delta) : 1n;
          reported.add(reading);
          feed.report('stream', reading);
          const s = feed.currentSlot();
          if (s === null) {
            start = null; // a stretch ends; a cold start may re-anchor anywhere two readings agree
            continue;
          }
          assert.ok(reported.has(s), 'the slot is a reading the channel gave');
          if (start === null) {
            start = { slot: s, at: now };
            last = s;
            continue;
          }
          assert.ok(s >= last, 'the slot never goes down while known');
          const room: bigint = BigInt(toleranceSlots) + BigInt(Math.ceil(((now - start.at) * maxSlotsPerSecond) / 1_000));
          assert.ok(s - start.slot <= room, `rose ${String(s - start.slot)} slots in ${now - start.at} ms (room ${String(room)})`);
          last = s;
        }
      }),
      { numRuns: 500 },
    );
  });
});
