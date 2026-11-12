// Property tests for the equity and day state (TEST_PLAN.md s.4, invariants 14 and 22): over random
// multi-day sequences of observations, deposits, withdrawals and jump confirmations (the Athens
// daylight-saving days included) the daily stop, the peak halt and the +50% hold are recomputed
// independently to the lamport, the baseline never moves within a day, the peak only rises, anomalies
// (zero, sanity breach, clock backwards, a held jump) never move anything, a transfer adjusts
// baseline, peak and last equity by exactly its amount, and a confirmed jump is the reference for the
// next hour so the same rise is never held twice on a stale snapshot.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { athensDay } from '../../../src/core/day.ts';
import { U64_MAX, bps, lamports, signedLamports, type Lamports } from '../../../src/core/units.ts';
import { RiskError } from '../../../src/risk/reserve.ts';
import {
  applyTransfer,
  confirmEquityJump,
  emptyEquityState,
  observeEquity,
  resumePeak,
  resumeStreak,
  type EquityPolicy,
  type EquityState,
  type EquityTrip,
} from '../../../src/risk/daystate.ts';

fc.configureGlobal({ numRuns: 1_000 }); // TEST_PLAN.md s.4 (this file's process only)

const POLICY: EquityPolicy = {
  dailyStopBps: bps(3_000),
  peakHaltBps: bps(5_000),
  sanityMaxLamports: lamports(2_000_000_000n),
  bankrollLamports: lamports(550_000_000n), // 3 x = 1.65 SOL
  sanityBankrollMultiple: 3,
  jumpBps: bps(5_000),
};
const HOUR = 3_600_000;
const START = Date.UTC(2026, 9, 22, 6); // a few days before the 25-hour day of 2026-10-25
const L = (n: bigint): Lamports => lamports(n);

const stepArb = fc.record({
  dt: fc.oneof(
    { weight: 5, arbitrary: fc.integer({ min: 0, max: 30 * HOUR }) },
    { weight: 4, arbitrary: fc.integer({ min: 0, max: HOUR / 2 }) }, // close together: a confirmed jump is still fresh
    { weight: 1, arbitrary: fc.integer({ min: -30 * HOUR, max: -1 }) },
  ),
  confirm: fc.boolean(),
  move: fc.oneof(
    { weight: 10, arbitrary: fc.constant('small' as const) },
    { weight: 3, arbitrary: fc.constant('drop' as const) },
    { weight: 2, arbitrary: fc.constant('rise' as const) },
    { weight: 1, arbitrary: fc.constant('zero' as const) },
    { weight: 1, arbitrary: fc.constant('huge' as const) },
    { weight: 2, arbitrary: fc.constant('unknown' as const) },
  ),
  pct: fc.integer({ min: 90, max: 110 }),
  stopCut: fc.integer({ min: 0, max: 60 }),
  agoPct: fc.option(fc.integer({ min: 50, max: 110 }), { nil: null }),
  transfer: fc.oneof({ weight: 9, arbitrary: fc.constant(0n) }, { weight: 1, arbitrary: fc.bigInt({ min: -150_000_000n, max: 150_000_000n }) }),
});

/** current is at least `rate` bps below `base`, in exact integer math. */
const fell = (base: bigint, current: bigint, rate: bigint): boolean => current < base && (base - current) * 10_000n >= rate * base;
/** equity is more than 50% above the reference: the rise is over half of the reference (another way to write 1.5 x). */
const over50 = (equity: bigint, reference: bigint): boolean => 2n * (equity - reference) > reference;
const ANOMALIES: readonly EquityTrip[] = ['equity-zero', 'sanity-max', 'sanity-bankroll', 'clock-backwards'];

/** The plain rule: held while a jump is pending, or when the rise is over 50% of the hour-ago snapshot or, for an hour after a confirmation, of the verified level if that is higher. */
function jumpExpected(prev: EquityState, now: number, equity: bigint, anHourAgo: bigint | null): boolean {
  if (prev.jumpPending) {
    return true;
  }
  const references: bigint[] = [];
  if (anHourAgo !== null) {
    references.push(anHourAgo);
  }
  if (prev.jumpAck !== null && now >= prev.jumpAck.at && now < prev.jumpAck.at + HOUR) {
    references.push(prev.jumpAck.equity);
  }
  if (references.length === 0) {
    return false;
  }
  return over50(equity, references.reduce((a, b) => (a > b ? a : b)));
}

describe('equity and day state properties', () => {
  it('over random sequences every rule holds at every step, and every trip occurs', () => {
    const seen = new Map<EquityTrip, number>();
    let confirmations = 0;
    let savedByAck = 0; // accepted only because the verified level was the reference: the old livelock
    let transfers = 0;
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 40 }), (steps) => {
        let state: EquityState = emptyEquityState();
        let now = START;
        let level = 500_000_000n;
        for (const step of steps) {
          now = Math.max(0, now + step.dt);
          let equity: bigint | null;
          if (step.move === 'drop') {
            level = (level * 60n) / 100n;
          } else if (step.move === 'rise') {
            level = (level * 170n) / 100n;
          } else if (step.move === 'small') {
            level = (level * BigInt(step.pct)) / 100n;
          }
          level = level < 100_000_000n ? 100_000_000n : level > 1_600_000_000n ? 1_600_000_000n : level;
          equity = step.move === 'zero' ? 0n : step.move === 'huge' ? 2_500_000_000n : step.move === 'unknown' ? null : level;
          const cut = equity === null ? level : equity;
          const stopEquity = equity === null ? (step.stopCut > 30 ? null : (cut * BigInt(100 - step.stopCut)) / 100n) : (equity * BigInt(100 - step.stopCut)) / 100n;
          const anHourAgo = step.agoPct === null ? null : (level * BigInt(step.agoPct)) / 100n;
          let delta = step.transfer;
          if (delta < 0n && -delta > state.lastEquity) {
            delta = -state.lastEquity; // a withdrawal is never more than the last known equity
          }
          if (delta !== 0n) {
            const before = state;
            const t = delta;
            const moved = (value: bigint): bigint => (value + t > 0n ? value + t : 0n);
            state = applyTransfer(before, signedLamports(t));
            transfers += 1;
            assert.equal(state.dayStart, moved(before.dayStart), 'a transfer moves the baseline by exactly its amount');
            assert.equal(state.lastEquity, moved(before.lastEquity));
            assert.equal(state.peak, before.peak === null || moved(before.peak) === 0n ? null : moved(before.peak));
            assert.deepEqual({ ...state, dayStart: before.dayStart, lastEquity: before.lastEquity, peak: before.peak }, before, 'and nothing else');
          }

          const prev = state;
          const today = athensDay(now);
          const result = observeEquity(
            prev,
            { now, equity: equity === null ? null : L(equity), stopEquity: stopEquity === null ? null : L(stopEquity), equityAnHourAgo: anHourAgo === null ? null : L(anHourAgo) },
            POLICY,
          );
          const { state: next, trips } = result;
          for (const trip of trips) {
            seen.set(trip, (seen.get(trip) ?? 0) + 1);
          }

          // the day only goes backwards through the clock halt, and that changes nothing
          assert.equal(trips.includes('clock-backwards'), prev.day !== null && prev.day > today);
          const anomalous = trips.some((t) => ANOMALIES.includes(t));
          if (anomalous) {
            assert.deepEqual(next, prev, 'an anomaly never moves anything');
          }
          // sanity and zero checks, to the lamport
          if (equity !== null && !trips.includes('clock-backwards')) {
            assert.equal(trips.includes('equity-zero'), equity === 0n);
            assert.equal(trips.includes('sanity-max'), equity > 2_000_000_000n);
            assert.equal(trips.includes('sanity-bankroll'), equity > 1_650_000_000n);
          }
          const accepted = equity !== null && !anomalous && !trips.includes('equity-jump');
          if (equity !== null && !anomalous) {
            assert.equal(trips.includes('equity-jump'), jumpExpected(prev, now, equity, anHourAgo), 'held exactly when the rise is over 50% of the reference');
            const ackActive = prev.jumpAck !== null && now >= prev.jumpAck.at && now - prev.jumpAck.at < HOUR;
            if (accepted && ackActive && anHourAgo !== null && over50(equity, anHourAgo)) {
              savedByAck += 1;
            }
          }
          if (equity === null) {
            assert.deepEqual([next.dayStart, next.lastEquity, next.peak, next.jumpPending], [prev.dayStart, prev.lastEquity, prev.peak, prev.jumpPending], 'unknown equity moves nothing');
          }
          if (trips.includes('equity-jump')) {
            assert.equal(next.jumpPending, true);
            assert.deepEqual([next.dayStart, next.lastEquity, next.peak, next.day], [prev.dayStart, prev.lastEquity, prev.peak, prev.day], 'a held jump moves nothing');
          }
          if (accepted && equity !== null) {
            assert.equal(next.day, today);
            assert.equal(next.lastEquity, equity);
            assert.equal(next.peak, prev.peak === null ? equity : prev.peak > equity ? prev.peak : equity, 'the peak only rises');
            if (prev.day === today && prev.dayStart > 0n) {
              assert.equal(next.dayStart, prev.dayStart, 'the baseline does not move within a day');
            } else if (prev.day === null) {
              assert.equal(next.dayStart, equity);
            } else if (prev.lastEquity > 0n) {
              assert.equal(next.dayStart, prev.lastEquity > equity ? prev.lastEquity : equity, 'the higher of the last equity and the first observation');
            }
          }
          if (prev.peak !== null && next.peak !== null) {
            assert.ok(next.peak >= prev.peak, 'the peak never falls on an observation');
          }

          // the stops, recomputed from the stop equity and the state that came back
          const stop = stopEquity ?? equity;
          if (!anomalous && stop !== null) {
            const daily = next.day === today && next.dayStart > 0n && fell(next.dayStart, stop, 3_000n);
            const peakHalt = next.peak !== null && next.peak > 0n && fell(next.peak, stop, 5_000n);
            assert.equal(trips.includes('daily-stop'), daily);
            assert.equal(trips.includes('peak-halt'), peakHalt);
            if (daily) {
              assert.equal(next.dailyStopDay, today);
              assert.ok(next.dailyStopStreak >= 1);
              assert.equal(trips.includes('daily-stop-twice'), next.dailyStopStreak >= 2);
            }
          } else if (!anomalous) {
            assert.equal(trips.includes('daily-stop') || trips.includes('peak-halt'), false);
          }
          // a stop never moves the baseline, the peak or the last equity
          if (!accepted && !anomalous && equity === null) {
            assert.deepEqual([next.dayStart, next.peak, next.lastEquity], [prev.dayStart, prev.peak, prev.lastEquity]);
          }
          // the acknowledgement is only ever written by a confirmation
          assert.deepEqual(next.jumpAck, prev.jumpAck, 'an observation never touches the jump acknowledgement');
          state = next;
          if (next.jumpPending && step.confirm) {
            const verified = L(level); // 0.1 to 1.6 SOL, always a level the sanity limits accept
            const confirmed = confirmEquityJump(next, verified, now, POLICY);
            assert.equal(confirmed.jumpPending, false);
            assert.deepEqual(confirmed.jumpAck, { equity: verified, at: now });
            assert.deepEqual({ ...confirmed, jumpPending: true, jumpAck: next.jumpAck }, next, 'confirming changes nothing else');
            state = confirmed;
            confirmations += 1;
          }
        }
      }),
    );
    for (const trip of ['daily-stop', 'peak-halt', 'equity-jump', 'clock-backwards', 'equity-zero', 'sanity-max', 'sanity-bankroll'] as const) {
      assert.ok((seen.get(trip) ?? 0) >= 5, `the trip ${trip} occurred only ${seen.get(trip) ?? 0} times`);
    }
    assert.ok(confirmations >= 20, `only ${confirmations} confirmations`);
    assert.ok(savedByAck >= 5, `the acknowledgement decided only ${savedByAck} observations`);
    assert.ok(transfers >= 20, `only ${transfers} transfers`);
  });

  it('a deposit or withdrawal and its reverse give back the state, as long as nothing was clamped', () => {
    const stateArb = fc
      .record({
        dayStart: fc.bigInt({ min: 200_000_000n, max: 900_000_000n }),
        lastEquity: fc.bigInt({ min: 200_000_000n, max: 900_000_000n }),
        peak: fc.option(fc.bigInt({ min: 200_000_000n, max: 900_000_000n }), { nil: null }),
        delta: fc.bigInt({ min: -150_000_000n, max: 150_000_000n }),
      })
      .map((r) => ({
        r,
        state: { ...emptyEquityState(), day: '2026-11-09', dayStart: L(r.dayStart), lastEquity: L(r.lastEquity), peak: r.peak === null ? null : L(r.peak) } as EquityState,
      }));
    fc.assert(
      fc.property(stateArb, ({ r, state }) => {
        const moved = applyTransfer(state, signedLamports(r.delta));
        assert.equal(moved.dayStart, r.dayStart + r.delta, 'exactly the amount');
        assert.equal(moved.lastEquity, r.lastEquity + r.delta);
        assert.equal(moved.peak, r.peak === null ? null : r.peak + r.delta);
        assert.deepEqual(applyTransfer(moved, signedLamports(-r.delta)), state);
      }),
    );
  });

  it('a withdrawal larger than the last known equity, and a deposit past 2^64 - 1, are always refused', () => {
    const stateArb = fc.record({
      dayStart: fc.bigInt({ min: 0n, max: 900_000_000n }),
      lastEquity: fc.bigInt({ min: 0n, max: 900_000_000n }),
      peak: fc.option(fc.bigInt({ min: 1n, max: 900_000_000n }), { nil: null }),
      extra: fc.bigInt({ min: 1n, max: 1_000_000_000_000n }),
    });
    fc.assert(
      fc.property(stateArb, (r) => {
        const state = { ...emptyEquityState(), day: '2026-11-09', dayStart: L(r.dayStart), lastEquity: L(r.lastEquity), peak: r.peak === null ? null : L(r.peak) } as EquityState;
        assert.throws(() => applyTransfer(state, signedLamports(-(r.lastEquity + r.extra))), RiskError); // more than it had
        assert.doesNotThrow(() => applyTransfer(state, signedLamports(-r.lastEquity))); // exactly all of it
        const top = { ...state, lastEquity: L(U64_MAX - r.extra + 1n) } as EquityState;
        assert.throws(() => applyTransfer(top, signedLamports(r.extra)), RiskError); // one lamport past the top
        assert.doesNotThrow(() => applyTransfer(top, signedLamports(r.extra - 1n)));
      }),
    );
  });

  it('after a confirmation, for a whole hour, a rise of up to 50% over the verified level is never held, whatever the stale snapshot says; after the hour only the snapshot counts', () => {
    const T = Date.UTC(2026, 10, 9, 6);
    const inputs = fc.record({
      verified: fc.bigInt({ min: 100_000_000n, max: 1_100_000_000n }),
      elapsed: fc.oneof(fc.integer({ min: 0, max: HOUR - 1 }), fc.integer({ min: HOUR, max: 5 * HOUR })),
      snapshot: fc.option(fc.bigInt({ min: 1n, max: 2_000_000_000n }), { nil: null }),
      pct: fc.integer({ min: 20, max: 150 }),
    });
    let inside = 0;
    let outsideHeld = 0;
    fc.assert(
      fc.property(inputs, ({ verified, elapsed, snapshot, pct }) => {
        const equity = (verified * BigInt(pct)) / 100n; // at most 1.65 SOL: no sanity trip
        const state = { ...emptyEquityState(), day: athensDay(T), dayStart: L(verified), lastEquity: L(verified), peak: L(verified), jumpAck: { equity: L(verified), at: T } } as EquityState;
        const r = observeEquity(state, { now: T + elapsed, equity: L(equity), stopEquity: L(equity), equityAnHourAgo: snapshot === null ? null : L(snapshot) }, POLICY);
        if (elapsed < HOUR) {
          inside += 1;
          assert.equal(r.trips.includes('equity-jump'), false, 'the verified level is the floor of the reference for an hour');
          assert.equal(r.state.jumpPending, false);
        } else {
          const held = snapshot !== null && over50(equity, snapshot);
          assert.equal(r.trips.includes('equity-jump'), held, 'after an hour only the snapshot counts');
          outsideHeld += held ? 1 : 0;
        }
      }),
    );
    assert.ok(inside >= 100 && outsideHeld >= 20, `inside ${inside}, held after the hour ${outsideHeld}`);
  });

  it('a confirmation is accepted if and only if a jump is held and the level is within the sanity limits', () => {
    const T = Date.UTC(2026, 10, 9, 6);
    let accepted = 0;
    let refused = 0;
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.oneof({ weight: 6, arbitrary: fc.bigInt({ min: 1n, max: 1_650_000_000n }) }, { weight: 3, arbitrary: fc.bigInt({ min: 1_650_000_001n, max: 3_000_000_000n }) }, { weight: 1, arbitrary: fc.constant(0n) }),
        (pending, level) => {
          const state = { ...emptyEquityState(), day: athensDay(T), dayStart: L(500_000_000n), lastEquity: L(500_000_000n), peak: L(500_000_000n), jumpPending: pending } as EquityState;
          const fine = pending && level >= 1n && level <= 1_650_000_000n; // 3 x the bankroll is the lower of the two limits
          if (fine) {
            const c = confirmEquityJump(state, L(level), T, POLICY);
            assert.deepEqual(c.jumpAck, { equity: level, at: T });
            assert.equal(c.jumpPending, false);
            accepted += 1;
          } else {
            assert.throws(() => confirmEquityJump(state, L(level), T, POLICY), RiskError);
            refused += 1;
          }
        },
      ),
    );
    assert.ok(accepted >= 100 && refused >= 100, `accepted ${accepted}, refused ${refused}`);
  });

  it('/resume changes exactly one field: the peak (to the last accepted equity, never with a hold or no equity) or the streak', () => {
    let restarted = 0;
    let refused = 0;
    const states = fc.record({
      day: fc.constantFrom<string | null>(null, '2026-11-08', '2026-11-09'),
      dayStart: fc.bigInt({ min: 0n, max: 900_000_000n }),
      lastEquity: fc.bigInt({ min: 0n, max: 900_000_000n }),
      peak: fc.option(fc.bigInt({ min: 1n, max: 900_000_000n }), { nil: null }),
      jumpPending: fc.boolean(),
      ack: fc.option(fc.record({ equity: fc.bigInt({ min: 1n, max: 2_000_000_000n }), at: fc.integer({ min: 0, max: Date.UTC(2030, 0, 1) }) }), { nil: null }),
      dailyStopDay: fc.constantFrom<string | null>(null, '2026-11-08', '2026-11-09'),
      dailyStopStreak: fc.integer({ min: 0, max: 3 }),
    });
    fc.assert(
      fc.property(states, (r) => {
        const s: EquityState = {
          day: r.day,
          dayStart: L(r.dayStart),
          lastEquity: L(r.lastEquity),
          peak: r.peak === null ? null : L(r.peak),
          jumpPending: r.jumpPending,
          jumpAck: r.ack === null ? null : { equity: L(r.ack.equity), at: r.ack.at },
          dailyStopDay: r.dailyStopDay,
          dailyStopStreak: r.dailyStopStreak,
        };
        if (!s.jumpPending && s.lastEquity > 0n) {
          const p = resumePeak(s);
          assert.equal(p.peak, s.lastEquity);
          assert.deepEqual({ ...p, peak: s.peak }, s);
          restarted += 1;
        } else {
          assert.throws(() => resumePeak(s), RiskError);
          refused += 1;
        }
        const k = resumeStreak(s);
        assert.equal(k.dailyStopStreak, 0);
        assert.deepEqual({ ...k, dailyStopStreak: s.dailyStopStreak }, s);
      }),
    );
    assert.ok(restarted >= 100 && refused >= 100, `restarted ${restarted}, refused ${refused}`);
  });
});
