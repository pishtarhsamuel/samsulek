// Equity and day state (RISK_POLICY.md s.4 and limits 9, 10, 12; invariants 14 and 22), ported from
// the root project's observe_equity. A pure state machine: every observation returns the next state
// and the trips it caused (the engine turns trips into flags). Baseline = the higher of the last
// equity and the day's first observation (an overnight gap down counts against today). Anomalies
// (zero, sanity breach, a clock that went backwards, an unverified +50% jump) never move the
// baseline, the peak or the last equity. The stops read a separate stop-equity (stale positions
// valued 0 after 5 min) and never move anything. TEST_PLAN.md s.3 step 4. Written first.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TIMESTAMP_MS } from '../../../src/core/time.ts';
import { U64_MAX, bps, lamports, signedLamports, type Lamports, type SignedLamports } from '../../../src/core/units.ts';
import { RiskError } from '../../../src/risk/reserve.ts';
import {
  applyTransfer,
  confirmEquityJump,
  dailyStopActive,
  emptyEquityState,
  observeEquity,
  resumePeak,
  resumeStreak,
  type EquityObservation,
  type EquityPolicy,
  type EquityState,
} from '../../../src/risk/daystate.ts';

const POLICY: EquityPolicy = {
  dailyStopBps: bps(3_000),
  peakHaltBps: bps(5_000),
  sanityMaxLamports: lamports(2_000_000_000n),
  bankrollLamports: lamports(550_000_000n), // 3 x = 1.65 SOL
  sanityBankrollMultiple: 3,
  jumpBps: bps(5_000),
};

const HOUR = 3_600_000;
const DAY1 = Date.UTC(2026, 10, 9, 12); // 2026-11-09 in Athens
const DAY2 = DAY1 + 24 * HOUR; // 2026-11-10
const L = (n: bigint): Lamports => lamports(n);

const state = (patch: Partial<EquityState> = {}): EquityState => {
  const made: EquityState = {
    day: '2026-11-09',
    dayStart: L(500_000_000n),
    lastEquity: L(500_000_000n),
    peak: L(500_000_000n),
    jumpPending: false,
    jumpHeld: null,
    jumpAck: null,
    dailyStopDay: null,
    dailyStopStreak: 0,
    streakHalt: false,
    ...patch,
  };
  // A held jump always has its held observation (the state check insists): 1.0 SOL at DAY1 unless a test says otherwise.
  return made.jumpPending && !('jumpHeld' in patch) ? { ...made, jumpHeld: { equity: L(1_000_000_000n), at: DAY1 } } : made;
};

const obs = (equity: bigint | null, now = DAY1, extra: Partial<EquityObservation> = {}): EquityObservation => ({
  now,
  equity: equity === null ? null : L(equity),
  stopEquity: equity === null ? null : L(equity),
  equityAnHourAgo: null,
  ...extra,
});

const run = (s: EquityState, o: EquityObservation, p: EquityPolicy = POLICY) => observeEquity(s, o, p);

describe('the first observations of a day', () => {
  it('the first ever observation sets the day, the baseline, the last equity and the peak', () => {
    const r = run(emptyEquityState(), obs(500_000_000n));
    assert.deepEqual(r.trips, []);
    assert.deepEqual(r.state, state());
  });

  it('later the same day: the baseline stays, the peak only rises, the last equity follows', () => {
    let r = run(state(), obs(520_000_000n, DAY1 + HOUR));
    assert.deepEqual([r.state.dayStart, r.state.lastEquity, r.state.peak], [L(500_000_000n), L(520_000_000n), L(520_000_000n)]);
    r = run(r.state, obs(510_000_000n, DAY1 + 2 * HOUR));
    assert.deepEqual([r.state.dayStart, r.state.lastEquity, r.state.peak], [L(500_000_000n), L(510_000_000n), L(520_000_000n)]);
    assert.deepEqual(r.trips, []);
  });
});

describe('a new day (00:00 Europe/Athens)', () => {
  it('baseline = the higher of the last equity and the first observation: a gap down counts against today', () => {
    const down = run(state({ lastEquity: L(800_000_000n), peak: L(800_000_000n) }), obs(700_000_000n, DAY2));
    assert.equal(down.state.day, '2026-11-10');
    assert.equal(down.state.dayStart, 800_000_000n);
    assert.deepEqual(down.trips, []); // 12.5% down: no stop
    const up = run(state({ lastEquity: L(800_000_000n), peak: L(800_000_000n) }), obs(900_000_000n, DAY2));
    assert.equal(up.state.dayStart, 900_000_000n); // a gap up is not credited as extra loss allowance
    assert.equal(up.state.peak, 900_000_000n);
  });

  it('with no earlier equity the first observation is the baseline', () => {
    const r = run(state({ lastEquity: L(0n), dayStart: L(0n) }), obs(400_000_000n, DAY2));
    assert.equal(r.state.dayStart, 400_000_000n);
  });

  it('turns at local midnight, also across the daylight-saving days', () => {
    const before = Date.UTC(2026, 2, 28, 21, 59, 59, 999); // 23:59:59.999 EET, 2026-03-28
    const after = Date.UTC(2026, 2, 28, 22, 0, 0, 0); // 00:00 EET, 2026-03-29 (a 23-hour day)
    const start = run(emptyEquityState(), obs(500_000_000n, before)).state;
    assert.equal(start.day, '2026-03-28');
    assert.equal(run(start, obs(510_000_000n, before)).state.dayStart, 500_000_000n);
    const next = run(start, obs(510_000_000n, after)).state;
    assert.equal(next.day, '2026-03-29');
    assert.equal(next.dayStart, 510_000_000n);
  });

  it('a baseline that was never observed today (0) is set by the first observation', () => {
    const r = run(state({ dayStart: L(0n), lastEquity: L(600_000_000n) }), obs(550_000_000n));
    assert.equal(r.state.dayStart, 600_000_000n);
  });
});

describe('the daily stop (limit 9): -30% from the day baseline, exact to the lamport', () => {
  it('29.99999...% down does not trip, exactly 30% does', () => {
    assert.deepEqual(run(state(), obs(350_000_001n)).trips, []);
    const r = run(state(), obs(350_000_000n));
    assert.deepEqual(r.trips, ['daily-stop']);
    assert.equal(r.state.dailyStopDay, '2026-11-09');
    assert.equal(r.state.dailyStopStreak, 1);
  });

  it('active for the rest of that day, off at the next midnight', () => {
    const tripped = run(state(), obs(350_000_000n)).state;
    assert.equal(dailyStopActive(tripped, DAY1 + 5 * HOUR), true);
    assert.equal(dailyStopActive(tripped, DAY2), false);
    assert.equal(dailyStopActive(state(), DAY1), false);
  });

  it('a stop on two days in a row also needs the owner (/resume): daily-stop-twice', () => {
    const second = state({ day: '2026-11-10', dayStart: L(340_000_000n), lastEquity: L(340_000_000n), peak: L(340_000_000n), dailyStopDay: '2026-11-09', dailyStopStreak: 1 });
    const r = run(second, obs(238_000_000n, DAY2)); // exactly -30%
    assert.deepEqual(r.trips, ['daily-stop', 'daily-stop-twice']);
    assert.equal(r.state.dailyStopStreak, 2);
  });

  it('days that are not consecutive start a new streak; the same day again does not count twice', () => {
    const gap = state({ dailyStopDay: '2026-11-07', dailyStopStreak: 1 });
    const g = run(gap, obs(340_000_000n));
    assert.deepEqual(g.trips, ['daily-stop']);
    assert.equal(g.state.dailyStopStreak, 1);
    const again = run(g.state, obs(330_000_000n, DAY1 + HOUR));
    assert.equal(again.state.dailyStopStreak, 1);
    assert.deepEqual(again.trips, ['daily-stop']);
  });

  it('the day counts as the Athens calendar day, not 24 hours: the streak follows the calendar across a 25-hour day', () => {
    const d24 = Date.UTC(2026, 9, 24, 21, 30); // 2026-10-25 00:30 EEST: the 25-hour day
    const d26 = Date.UTC(2026, 9, 25, 22, 30); // 2026-10-26 00:30 EET
    const first = run(state({ day: '2026-10-25', dayStart: L(500_000_000n), peak: L(500_000_000n) }), obs(340_000_000n, d24)).state;
    assert.equal(first.dailyStopDay, '2026-10-25');
    const second = run(state({ ...first, day: '2026-10-26', dayStart: L(340_000_000n), lastEquity: L(340_000_000n), peak: L(340_000_000n) }), obs(238_000_000n, d26));
    assert.equal(second.state.dailyStopStreak, 2);
  });
});

describe('the peak halt (limit 10): -50% from the peak', () => {
  const s = state({ dayStart: L(400_000_000n), lastEquity: L(1_000_000_000n), peak: L(1_000_000_000n) });
  it('49.99999...% down does not trip, exactly 50% does', () => {
    assert.deepEqual(run(s, obs(500_000_001n)).trips, []);
    assert.deepEqual(run(s, obs(500_000_000n)).trips, ['peak-halt']);
  });

  it('with no peak yet there is nothing to fall from', () => {
    assert.deepEqual(run(state({ peak: null }), obs(500_000_000n)).trips, []);
  });
});

describe('anomalies never move the baseline, the peak or the last equity', () => {
  const unchanged = (s: EquityState, o: EquityObservation, trips: string[]) => {
    const r = run(s, o);
    assert.deepEqual(r.trips, trips);
    assert.deepEqual(r.state, s);
  };
  const big = { ...POLICY, bankrollLamports: L(10_000_000_000n) }; // so only the absolute maximum applies

  it('equity above 2.0 SOL (the maximum) or above 3 x the bankroll halts', () => {
    assert.deepEqual(run(state(), obs(2_000_000_000n), big).trips.includes('sanity-max'), false);
    const over = run(state(), obs(2_000_000_001n), big);
    assert.deepEqual(over.trips, ['sanity-max']);
    assert.deepEqual(over.state, state());
    assert.deepEqual(run(state(), obs(1_650_000_000n)).trips, []);
    unchanged(state(), obs(1_650_000_001n), ['sanity-bankroll']);
    unchanged(state(), obs(2_100_000_000n), ['sanity-max', 'sanity-bankroll']);
  });

  it('zero equity halts', () => {
    unchanged(state(), obs(0n), ['equity-zero']);
  });

  it('a clock that went backwards past a day boundary halts, the state untouched', () => {
    unchanged(state({ day: '2026-11-10' }), obs(500_000_000n, DAY1), ['clock-backwards']);
  });

  it('unknown equity changes nothing and trips nothing (entries are blocked elsewhere)', () => {
    unchanged(state(), obs(null), []);
  });
});

describe('the stops read the stop-equity and move nothing (REVIEWS.md D, M3)', () => {
  it('unknown equity with a stale-valued stop-equity can still trip the stops', () => {
    const stopOnly = (equity: bigint): EquityObservation => ({ now: DAY1 + HOUR, equity: null, stopEquity: L(equity), equityAnHourAgo: null });
    const daily = run(state(), stopOnly(349_999_999n));
    assert.deepEqual(daily.trips, ['daily-stop']);
    assert.equal(daily.state.dayStart, 500_000_000n); // baseline, peak and last equity untouched
    assert.equal(daily.state.peak, 500_000_000n);
    assert.equal(daily.state.lastEquity, 500_000_000n);
    assert.deepEqual(run(state(), stopOnly(250_000_000n)).trips, ['daily-stop', 'peak-halt']);
    assert.deepEqual(run(state(), stopOnly(400_000_000n)).trips, []);
  });

  it('with known equity a lower stop-equity trips the stops but the accepted equity moves the state', () => {
    const r = run(state(), { now: DAY1, equity: L(450_000_000n), stopEquity: L(300_000_000n), equityAnHourAgo: null });
    assert.deepEqual(r.trips, ['daily-stop']);
    assert.equal(r.state.lastEquity, 450_000_000n);
  });

  it('a stop-equity above the equity is inconsistent input and is refused', () => {
    assert.throws(() => run(state(), { now: DAY1, equity: L(400_000_000n), stopEquity: L(500_000_000n), equityAnHourAgo: null }), RiskError);
  });

  it('on a day with no baseline yet the daily stop has nothing to compare with', () => {
    const r = run(state({ day: '2026-11-09', dayStart: L(0n) }), { now: DAY1, equity: null, stopEquity: L(1n), equityAnHourAgo: null });
    assert.deepEqual(r.trips, ['peak-halt']);
    assert.deepEqual(run(state({ day: '2026-11-08' }), { now: DAY1, equity: null, stopEquity: L(1n), equityAnHourAgo: null }).trips, ['peak-halt']);
  });
});

describe('+50% within an hour (limit 12): held until verified, baseline and peak stay put', () => {
  const pumped = (equity: bigint, ago: bigint | null, s = state({ dayStart: L(600_000_000n), lastEquity: L(600_000_000n), peak: L(600_000_000n) })) =>
    run(s, obs(equity, DAY1, { equityAnHourAgo: ago === null ? null : L(ago) }));

  it('exactly +50% is not a jump; one lamport more is', () => {
    assert.deepEqual(pumped(900_000_000n, 600_000_000n).trips, []);
    const jump = pumped(900_000_001n, 600_000_000n);
    assert.deepEqual(jump.trips, ['equity-jump']);
    assert.equal(jump.state.jumpPending, true);
    assert.deepEqual([jump.state.dayStart, jump.state.peak, jump.state.lastEquity], [L(600_000_000n), L(600_000_000n), L(600_000_000n)]);
  });

  it('while pending nothing moves but the held observation, however the next observations look, until the engine confirms', () => {
    const held = pumped(900_000_001n, 600_000_000n).state;
    assert.deepEqual(held.jumpHeld, { equity: 900_000_001n, at: DAY1 });
    const next = run(held, obs(950_000_000n, DAY1 + HOUR));
    assert.deepEqual(next.trips, ['equity-jump']);
    assert.deepEqual(next.state.jumpHeld, { equity: 950_000_000n, at: DAY1 + HOUR }); // the latest held observation
    assert.deepEqual({ ...next.state, jumpHeld: held.jumpHeld }, held);
    const confirmed = confirmEquityJump(next.state, L(950_000_000n), DAY1 + HOUR, POLICY);
    assert.equal(confirmed.jumpPending, false);
    assert.equal(confirmed.jumpHeld, null);
    const after = run(confirmed, obs(950_000_000n, DAY1 + HOUR));
    assert.deepEqual(after.trips, []);
    assert.equal(after.state.peak, 950_000_000n); // only now may the peak move
  });

  it('the stops still work while a jump is pending (a pump that collapses must not hide a loss)', () => {
    const held = state({ jumpPending: true, dayStart: L(500_000_000n), peak: L(500_000_000n) });
    assert.deepEqual(run(held, obs(300_000_000n)).trips, ['equity-jump', 'daily-stop']);
  });

  it('no equity from an hour ago (a fresh start) means no jump check', () => {
    assert.deepEqual(pumped(1_000_000_000n, null).trips, []);
  });
});

describe('a confirmed jump is the reference for the next hour (no livelock on a stale snapshot)', () => {
  const T = DAY1 + 60_000; // when the engine confirmed: a minute after the held observation
  const base = state({ dayStart: L(600_000_000n), lastEquity: L(600_000_000n), peak: L(600_000_000n) });
  const held = (): EquityState => run(base, obs(950_000_000n, DAY1, { equityAnHourAgo: L(600_000_000n) })).state;
  const confirmed = (): EquityState => confirmEquityJump(held(), L(950_000_000n), T, POLICY);
  /** The hour-ago snapshot is still the pre-jump 600M: it has not aged out yet. */
  const stale = (equity: bigint, now: number): ReturnType<typeof run> => run(confirmed(), obs(equity, now, { equityAnHourAgo: L(600_000_000n) }));

  it('the same rise does not hold again and again: after the confirmation it is accepted and the peak moves', () => {
    assert.deepEqual(held().jumpPending, true);
    const r = stale(950_000_000n, T + 60_000);
    assert.deepEqual(r.trips, []);
    assert.equal(r.state.peak, 950_000_000n);
    assert.equal(r.state.lastEquity, 950_000_000n);
    assert.equal(r.state.jumpAck?.equity, 950_000_000n); // the acknowledgement stays in the state
    assert.deepEqual(stale(960_000_000n, T + 30 * 60_000).trips, []); // and keeps working all hour
  });

  it('without the acknowledgement the same observation would hold again: the old livelock', () => {
    const noAck = { ...confirmed(), jumpAck: null };
    assert.deepEqual(run(noAck, obs(950_000_000n, T + 60_000, { equityAnHourAgo: L(600_000_000n) })).trips, ['equity-jump']);
  });

  it('a further rise of more than 50% above the verified level holds again', () => {
    assert.deepEqual(stale(1_425_000_000n, T + 60_000).trips, []); // exactly +50% of 950M
    assert.deepEqual(stale(1_425_000_001n, T + 60_000).trips, ['equity-jump']);
  });

  it('the acknowledgement lasts one hour: the last millisecond of it still counts, the next does not', () => {
    assert.deepEqual(stale(950_000_000n, T + HOUR - 1).trips, []);
    assert.deepEqual(stale(950_000_000n, T + HOUR).trips, ['equity-jump']);
  });

  it('an acknowledgement from the future (the clock stepped back) is ignored: the test only gets stricter', () => {
    assert.deepEqual(stale(950_000_000n, T - 1).trips, ['equity-jump']);
    assert.deepEqual(stale(950_000_000n, T).trips, []);
  });

  it('the reference is the higher of the hour-ago snapshot and the verified level', () => {
    const ack = (equity: bigint) => state({ jumpAck: { equity: L(equity), at: T } });
    // verified level above the snapshot: the verified level is the reference (800M x 1.5 = 1,200M)
    assert.deepEqual(run(ack(800_000_000n), obs(1_000_000_000n, T, { equityAnHourAgo: L(600_000_000n) })).trips, []);
    // snapshot above the verified level: the snapshot is the reference (600M x 1.5 = 900M, not 500M x 1.5 = 750M)
    assert.deepEqual(run(ack(500_000_000n), obs(800_000_000n, T, { equityAnHourAgo: L(600_000_000n) })).trips, []);
    assert.deepEqual(run(ack(500_000_000n), obs(900_000_001n, T, { equityAnHourAgo: L(600_000_000n) })).trips, ['equity-jump']);
  });

  it('with no snapshot at all the verified level alone is the reference', () => {
    assert.deepEqual(run(state({ jumpAck: { equity: L(800_000_000n), at: T } }), obs(1_200_000_000n, T)).trips, []);
    assert.deepEqual(run(state({ jumpAck: { equity: L(800_000_000n), at: T } }), obs(1_200_000_001n, T)).trips, ['equity-jump']);
  });

  it('only a held jump can be confirmed, with a positive verified equity and a real timestamp', () => {
    assert.throws(() => confirmEquityJump(state(), L(950_000_000n), T, POLICY), /no held equity jump/);
    const pending = state({ jumpPending: true });
    assert.throws(() => confirmEquityJump(pending, L(0n), T, POLICY), RiskError);
    assert.throws(() => confirmEquityJump(pending, 5 as unknown as Lamports, T, POLICY), RiskError);
    assert.throws(() => confirmEquityJump(pending, L(950_000_000n), Number.NaN, POLICY), RiskError);
    assert.throws(() => confirmEquityJump(pending, L(950_000_000n), MAX_TIMESTAMP_MS + 1, POLICY), RiskError);
    assert.deepEqual(confirmEquityJump(pending, L(950_000_000n), T, POLICY).jumpAck, { equity: 950_000_000n, at: T });
  });

  it('the verified equity must be one the sanity limits accept: a confirmation cannot put the reference above them', () => {
    const pending = state({ jumpPending: true, jumpHeld: { equity: L(2_000_000_000n), at: DAY1 } });
    // the bankroll cap: 3 x 0.55 SOL
    assert.deepEqual(confirmEquityJump(pending, L(1_650_000_000n), T, POLICY).jumpAck, { equity: 1_650_000_000n, at: T });
    assert.throws(() => confirmEquityJump(pending, L(1_650_000_001n), T, POLICY), /sanity limits/);
    // the absolute maximum, with a bankroll big enough that only it applies
    const big = { ...POLICY, bankrollLamports: L(10_000_000_000n) };
    assert.deepEqual(confirmEquityJump(pending, L(2_000_000_000n), T, big).jumpAck, { equity: 2_000_000_000n, at: T });
    assert.throws(() => confirmEquityJump(pending, L(2_000_000_001n), T, big), RiskError);
    // a lower configured maximum
    const low = { ...POLICY, sanityMaxLamports: L(1_000_000_000n) };
    assert.deepEqual(confirmEquityJump(pending, L(1_000_000_000n), T, low).jumpAck, { equity: 1_000_000_000n, at: T });
    assert.throws(() => confirmEquityJump(pending, L(1_000_000_001n), T, low), /sanity limits/);
    // the policy is checked too: a looser-than-hard threshold is refused here as everywhere
    assert.throws(() => confirmEquityJump(pending, L(950_000_000n), T, { ...POLICY, jumpBps: bps(5_001) }), RiskError);
    assert.throws(() => confirmEquityJump(pending, L(950_000_000n), T, null as unknown as EquityPolicy), RiskError);
  });

  it('confirming changes nothing but the pending flag, the held observation and the acknowledgement', () => {
    const before = held();
    const after = confirmEquityJump(before, L(950_000_000n), T, POLICY);
    assert.deepEqual({ ...after, jumpPending: true, jumpHeld: before.jumpHeld, jumpAck: null }, { ...before, jumpAck: null });
  });

  it('the verified level can never vouch for more than the latest held observation saw (REVIEWS.md K, finding 3)', () => {
    const heldLow = state({ jumpPending: true, jumpHeld: { equity: L(800_000_000n), at: DAY1 } });
    // held at 0.8 SOL, "verified" at 1.6 SOL: the record is 0.8 SOL, so a jump to 1.6 holds again
    const c = confirmEquityJump(heldLow, L(1_600_000_000n), T, POLICY);
    assert.deepEqual(c.jumpAck, { equity: 800_000_000n, at: T });
    assert.deepEqual(run(c, obs(1_600_000_000n, T + 60_000, { equityAnHourAgo: L(600_000_000n) })).trips, ['equity-jump']);
    // a pump that collapsed: the verified level is the lower one, and that is the record (the hold can always be cleared)
    assert.deepEqual(confirmEquityJump(heldLow, L(500_000_000n), T, POLICY).jumpAck, { equity: 500_000_000n, at: T });
    // verified at exactly what was held: unchanged
    assert.deepEqual(confirmEquityJump(heldLow, L(800_000_000n), T, POLICY).jumpAck, { equity: 800_000_000n, at: T });
  });

  it('a confirmation must follow the latest held observation within five minutes and never precede it', () => {
    const pending = state({ jumpPending: true, jumpHeld: { equity: L(1_000_000_000n), at: DAY1 } });
    assert.equal(confirmEquityJump(pending, L(900_000_000n), DAY1, POLICY).jumpPending, false); // at once
    assert.equal(confirmEquityJump(pending, L(900_000_000n), DAY1 + 5 * 60_000, POLICY).jumpPending, false); // the last allowed millisecond
    assert.throws(() => confirmEquityJump(pending, L(900_000_000n), DAY1 + 5 * 60_000 + 1, POLICY), /observe again/);
    assert.throws(() => confirmEquityJump(pending, L(900_000_000n), DAY1 - 1, POLICY), /observe again/);
    assert.throws(() => confirmEquityJump(pending, L(900_000_000n), DAY1 + 24 * HOUR, POLICY), /observe again/); // a record dated far ahead
  });

  it('a held jump and its held observation come together or not at all', () => {
    assert.throws(() => run(state({ jumpPending: true, jumpHeld: null }), obs(500_000_000n)), /held observation/);
    assert.throws(() => run(state({ jumpPending: false, jumpHeld: { equity: L(1n), at: DAY1 } }), obs(500_000_000n)), /held observation/);
    for (const bad of [{ equity: L(0n), at: DAY1 }, { equity: L(2_000_000_001n), at: DAY1 }, { equity: L(1n), at: -1 }, { equity: 5, at: DAY1 }, 5]) {
      assert.throws(() => run(state({ jumpPending: true, jumpHeld: bad as unknown as EquityState['jumpHeld'] }), obs(500_000_000n)), RiskError);
    }
  });
});

describe('two daily stops on consecutive days are a halt only the owner lifts (REVIEWS.md K, finding 1)', () => {
  const day = (n: number): number => DAY1 + n * 24 * HOUR;
  const stop = (s: EquityState, at: number, open: bigint, low: bigint): ReturnType<typeof run> => run(run(s, obs(open, at)).state, obs(low, at + HOUR));

  it('a quiet day or a gap in between cannot lift it; the streak restarts but the halt stands', () => {
    // day 0: baseline 500M, down to 350M (-30%): the first stop
    let r = stop(emptyEquityState(), day(0), 500_000_000n, 350_000_000n);
    assert.deepEqual(r.trips, ['daily-stop']);
    assert.equal(r.state.streakHalt, false);
    // day 1: baseline 450M (an overnight gain), down to 315M (-30%): a stop on two days in a row
    r = stop(r.state, day(1), 450_000_000n, 315_000_000n);
    assert.deepEqual(r.trips, ['daily-stop', 'daily-stop-twice']);
    assert.equal(r.state.streakHalt, true);
    assert.equal(r.state.dailyStopStreak, 2);
    // day 2: a quiet day with no stop: the halt still stands and is reported on every observation
    r = run(r.state, obs(320_000_000n, day(2)));
    assert.deepEqual(r.trips, ['daily-stop-twice']);
    r = run(r.state, obs(325_000_000n, day(2) + HOUR));
    assert.deepEqual(r.trips, ['daily-stop-twice']);
    // with the equity unknown too (the stops read the stop-equity only)
    assert.deepEqual(run(r.state, { now: day(2) + 2 * HOUR, equity: null, stopEquity: null, equityAnHourAgo: null }).trips, ['daily-stop-twice']);
    // day 4 (day 3 not observed): a stop after a gap starts a streak of 1, and the halt still stands
    r = stop(r.state, day(4), 400_000_000n, 280_000_000n);
    assert.deepEqual(r.trips, ['daily-stop', 'daily-stop-twice']);
    assert.equal(r.state.dailyStopStreak, 1);
    assert.equal(r.state.streakHalt, true);
    // only the owner lifts it; today's stop still holds until midnight
    const lifted = resumeStreak(r.state);
    assert.equal(lifted.streakHalt, false);
    assert.equal(lifted.dailyStopStreak, 0);
    assert.deepEqual(run(lifted, obs(270_000_000n, day(4) + 2 * HOUR)).trips, ['daily-stop']);
    assert.deepEqual(run(lifted, obs(275_000_000n, day(5))).trips, []);
  });

  it('nothing but the owner clears it: not midnight, a transfer, a peak restart or a confirmed jump', () => {
    const halted = state({ streakHalt: true, dailyStopStreak: 2, dailyStopDay: '2026-11-09' });
    assert.equal(run(halted, obs(500_000_000n, DAY2)).state.streakHalt, true);
    assert.equal(applyTransfer(halted, signedLamports(100_000_000n)).streakHalt, true);
    assert.equal(resumePeak(halted).streakHalt, true);
    const pending = state({ streakHalt: true, jumpPending: true });
    assert.equal(confirmEquityJump(pending, L(900_000_000n), DAY1, POLICY).streakHalt, true);
    assert.equal(resumeStreak(halted).streakHalt, false);
  });

  it('two stops that are not on consecutive days are no halt', () => {
    let r = stop(emptyEquityState(), day(0), 500_000_000n, 350_000_000n);
    r = stop(r.state, day(2), 400_000_000n, 280_000_000n); // day 1 had none
    assert.deepEqual(r.trips, ['daily-stop']);
    assert.equal(r.state.streakHalt, false);
    assert.equal(r.state.dailyStopStreak, 1);
  });
});

describe('the daily stop holds through a clock that steps back (REVIEWS.md K, finding 2)', () => {
  it('a stop tripped earlier today still blocks entries if the clock then reads an earlier time or day', () => {
    const tripped = run(state(), obs(350_000_000n, DAY1 + HOUR)).state;
    assert.equal(tripped.dailyStopDay, '2026-11-09');
    assert.equal(dailyStopActive(tripped, DAY1 + HOUR), true);
    assert.equal(dailyStopActive(tripped, DAY1 - 5 * HOUR), true); // an earlier time on the same day
    assert.equal(dailyStopActive(tripped, DAY1 - 2 * 24 * HOUR), true); // two days earlier: still blocked
    assert.equal(dailyStopActive(tripped, DAY2), false); // the next Athens day: off
  });

  it('a clock earlier than the last observation blocks entries until the next observation reports it', () => {
    assert.equal(dailyStopActive(state(), DAY1), false);
    assert.equal(dailyStopActive(state(), DAY1 - 24 * HOUR), true); // the state has seen 2026-11-09
    assert.equal(dailyStopActive(state(), DAY2), false);
    assert.equal(dailyStopActive(emptyEquityState(), 0), false); // nothing observed yet: nothing to block
  });

  it('a stored stop dated after the clock blocks even if the state\'s own day lags (belt and braces)', () => {
    assert.equal(dailyStopActive(state({ day: '2026-11-08', dailyStopDay: '2026-11-09' }), DAY1 - 24 * HOUR), true);
    assert.equal(dailyStopActive(state({ day: '2026-11-08', dailyStopDay: '2026-11-07' }), DAY1 - 24 * HOUR), false);
  });
});

describe('deposits, withdrawals and the owner\'s /resume (invariant 22)', () => {
  it('a withdrawal lowers the baseline, the peak and the last equity by exactly its amount, a deposit raises them', () => {
    const s = state({ dayStart: L(500_000_000n), lastEquity: L(520_000_000n), peak: L(600_000_000n) });
    const w = applyTransfer(s, signedLamports(-100_000_000n));
    assert.deepEqual([w.dayStart, w.lastEquity, w.peak], [L(400_000_000n), L(420_000_000n), L(500_000_000n)]);
    assert.deepEqual(applyTransfer(w, signedLamports(100_000_000n)), s);
  });

  it('withdrawing everything leaves zero and no peak; a baseline smaller than the withdrawal is reset, never negative', () => {
    const all = applyTransfer(state(), signedLamports(-500_000_000n));
    assert.deepEqual([all.dayStart, all.lastEquity, all.peak], [L(0n), L(0n), null]);
    const small = applyTransfer(state({ dayStart: L(100_000_000n), lastEquity: L(500_000_000n), peak: L(500_000_000n) }), signedLamports(-300_000_000n));
    assert.deepEqual([small.dayStart, small.lastEquity, small.peak], [L(0n), L(200_000_000n), L(200_000_000n)]);
    assert.equal(applyTransfer(state({ peak: null }), signedLamports(50n)).peak, null);
    assert.deepEqual(applyTransfer(state(), signedLamports(0n)), state());
  });

  it('a withdrawal larger than the last known equity is refused: it would wipe the daily-stop baseline and the peak', () => {
    const lost = state({ dayStart: L(500_000_000n), lastEquity: L(340_000_000n), peak: L(500_000_000n) });
    assert.throws(() => applyTransfer(lost, signedLamports(-340_000_001n)), /larger than the last known equity/);
    assert.deepEqual(applyTransfer(lost, signedLamports(-340_000_000n)).lastEquity, L(0n)); // exactly all of it is fine
    assert.throws(() => applyTransfer(emptyEquityState(), signedLamports(-1n)), RiskError); // nothing is known yet
  });

  it('a deposit that would pass 2^64 - 1 is refused, and so is a transfer outside +-(2^64 - 1)', () => {
    const nearTop = state({ lastEquity: L(U64_MAX - 10n) });
    assert.throws(() => applyTransfer(nearTop, signedLamports(11n)), /beyond 2\^64 - 1/);
    assert.deepEqual(applyTransfer(nearTop, signedLamports(10n)).lastEquity, L(U64_MAX));
    assert.throws(() => applyTransfer(state(), (U64_MAX + 1n) as SignedLamports), /signed bigint within 2\^64 - 1/);
    assert.throws(() => applyTransfer(state(), -(U64_MAX + 1n) as SignedLamports), /signed bigint within 2\^64 - 1/);
  });

  it('/resume after a peak halt rebases only the peak, to the last accepted equity: no caller can supply a value', () => {
    const before = state({ peak: L(900_000_000n), lastEquity: L(450_000_000n), dailyStopStreak: 2, dailyStopDay: '2026-11-09' });
    const r = resumePeak(before);
    assert.equal(r.peak, 450_000_000n);
    assert.deepEqual({ ...r, peak: before.peak }, before); // streak, stop day, baseline: all untouched
    assert.equal(resumePeak.length, 1); // the state is the only input
  });

  it('/resume cannot restart the peak without a known equity, or while a jump is held', () => {
    assert.throws(() => resumePeak(state({ lastEquity: L(0n) })), /known equity above zero/);
    assert.throws(() => resumePeak(emptyEquityState()), /known equity above zero/);
    assert.throws(() => resumePeak(state({ jumpPending: true })), /held equity jump/);
    // after the hold is confirmed it works again
    const confirmed = confirmEquityJump(state({ jumpPending: true }), L(500_000_000n), DAY1, POLICY);
    assert.equal(resumePeak(confirmed).peak, 500_000_000n);
  });

  it('/resume after two daily stops in a row lifts the halt and restarts the streak, nothing else', () => {
    const before = state({ peak: L(900_000_000n), dailyStopStreak: 2, streakHalt: true, dailyStopDay: '2026-11-09' });
    const r = resumeStreak(before);
    assert.equal(r.dailyStopStreak, 0);
    assert.equal(r.streakHalt, false);
    assert.deepEqual({ ...r, dailyStopStreak: 2, streakHalt: true }, before); // today's stop still holds until midnight, the peak is untouched
    assert.equal(dailyStopActive(r, DAY1), true);
  });
});

describe('every stored field and input is read exactly once (a getter cannot show the check one value and the code another)', () => {
  it('the acknowledgement, the held observation and the observation time', () => {
    let ackReads = 0;
    const ack = { equity: L(600_000_000n), get at(): number { ackReads += 1; return DAY1; } };
    run(state({ jumpAck: ack as unknown as EquityState['jumpAck'] }), obs(500_000_000n));
    assert.equal(ackReads, 1);
    let heldReads = 0;
    const held = { equity: L(600_000_000n), get at(): number { heldReads += 1; return DAY1; } };
    run(state({ jumpPending: true, jumpHeld: held as unknown as EquityState['jumpHeld'] }), obs(500_000_000n));
    assert.equal(heldReads, 1);
    let nowReads = 0;
    const observation = { get now(): number { nowReads += 1; return DAY1; }, equity: L(500_000_000n), stopEquity: L(500_000_000n), equityAnHourAgo: null };
    run(state(), observation as unknown as EquityObservation);
    assert.equal(nowReads, 1);
  });
});

describe('fail closed on bad input', () => {
  it('refuses a bad clock, bad amounts and a malformed state', () => {
    assert.throws(() => run(state(), obs(500_000_000n, Number.NaN)), RiskError);
    assert.throws(() => run(state(), obs(500_000_000n, -1)), RiskError);
    assert.throws(() => run(state(), obs(500_000_000n, MAX_TIMESTAMP_MS + 1)), RiskError); // a far-future clock cannot lock a day ahead
    assert.equal(run(emptyEquityState(), obs(500_000_000n, MAX_TIMESTAMP_MS)).state.day, '2200-01-01');
    assert.throws(() => run(state(), { ...obs(1n), equity: 5 as unknown as Lamports }), RiskError);
    assert.throws(() => run(state(), { ...obs(1n), equity: -1n as Lamports }), RiskError);
    assert.throws(() => run(state(), { ...obs(1n), equityAnHourAgo: 1.5 as unknown as Lamports }), RiskError);
    assert.throws(() => run(null as unknown as EquityState, obs(1n)), RiskError);
    assert.throws(() => run(state({ day: '2026-02-30' }), obs(1n)), RiskError);
    assert.throws(() => run(state({ dailyStopStreak: -1 }), obs(1n)), RiskError);
    assert.throws(() => run(state({ jumpPending: 'no' as unknown as boolean }), obs(1n)), RiskError);
    assert.throws(() => run(state({ streakHalt: 'yes' as unknown as boolean }), obs(1n)), RiskError);
    assert.throws(() => run({ ...state(), streakHalt: undefined } as unknown as EquityState, obs(1n)), RiskError); // a state saved before the field existed
    assert.throws(() => run({ ...state(), jumpHeld: undefined } as unknown as EquityState, obs(1n)), RiskError);
    assert.throws(() => run(state({ peak: -1n as Lamports }), obs(1n)), RiskError);
    // a stored jump acknowledgement is checked as well: a verified level of 0 or above 2.0 SOL, a bad time, or not an object
    for (const bad of [{ equity: L(0n), at: DAY1 }, { equity: L(2_000_000_001n), at: DAY1 }, { equity: L(1n), at: -1 }, { equity: L(1n), at: MAX_TIMESTAMP_MS + 1 }, { equity: 5, at: DAY1 }, 5, 'ack']) {
      assert.throws(() => run(state({ jumpAck: bad as unknown as EquityState['jumpAck'] }), obs(1n)), RiskError, JSON.stringify(bad, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v)));
    }
  });

  it('refuses a policy looser than the hard limits (never loosens a stop) and a zero threshold', () => {
    const bad: ReadonlyArray<Partial<EquityPolicy>> = [
      { dailyStopBps: bps(3_001) },
      { dailyStopBps: bps(0) },
      { peakHaltBps: bps(5_001) },
      { peakHaltBps: bps(0) },
      { sanityMaxLamports: L(2_000_000_001n) },
      { sanityBankrollMultiple: 4 },
      { sanityBankrollMultiple: 0 },
      { jumpBps: bps(5_001) },
      { jumpBps: bps(0) },
      { bankrollLamports: L(0n) },
    ];
    for (const patch of bad) {
      assert.throws(() => run(state(), obs(500_000_000n), { ...POLICY, ...patch }), RiskError, JSON.stringify(patch, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v)));
    }
  });

  it('transfers and dates are checked too', () => {
    assert.throws(() => applyTransfer(state(), 5 as unknown as ReturnType<typeof signedLamports>), RiskError);
    assert.throws(() => dailyStopActive(state(), Number.NaN), RiskError);
    assert.throws(() => dailyStopActive(state(), MAX_TIMESTAMP_MS + 1), RiskError);
    assert.throws(() => resumePeak(null as unknown as EquityState), RiskError);
    assert.throws(() => resumeStreak(null as unknown as EquityState), RiskError);
    assert.throws(() => confirmEquityJump(null as unknown as EquityState, L(1n), DAY1, POLICY), RiskError);
  });
});
