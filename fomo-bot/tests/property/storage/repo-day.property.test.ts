// The engine's day-state write against risk/daystate.ts itself (review R, risk 1): every state the
// risk module's steps make from the stored one (an observation, a confirmed jump, a deposit) is
// written and read back unchanged, also around the owner's resumes, so the guard in repo-day.ts never
// refuses what the risk module does. The steps run as the engine will run them (STORAGE_DESIGN.md
// s.3.5): the hour-ago base from the stored snapshots, one write per step, the halt rows of the trips.
// The refusals themselves are tested one by one in tests/unit/storage/repo-day.test.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { LAMPORTS_PER_SOL as SOL, bps, lamports, signedLamports } from '../../../src/core/units.ts';
import {
  applyTransfer,
  confirmEquityJump,
  observeEquity,
  resumePeak,
  resumeStreak,
  type EquityPolicy,
  type EquityState,
  type EquityTrip,
} from '../../../src/risk/daystate.ts';
import { RiskError } from '../../../src/risk/reserve.ts';
import { insertSnapshot, readDayState, snapshotNear, writeDayState } from '../../../src/storage/repo-day.ts';
import { setHalt } from '../../../src/storage/repo-flags.ts';
import { resumeHalt } from '../../../src/storage/repo-owner.ts';
import { StorageError, type Tx } from '../../../src/storage/sqlite.ts';
import { TEST_NOW, migratedDb } from '../../unit/storage/helpers.ts';

const HOUR = 3_600_000;
const MIN = 60_000;

/** The paper policy of tests/unit/risk/daystate.test.ts: -30% a day, -50% from the peak, sanity at 2 SOL and 3 x 0.55 SOL, +50% within an hour. */
const POLICY: EquityPolicy = {
  mode: 'paper',
  dailyStopBps: bps(3_000),
  peakHaltBps: bps(5_000),
  sanityMaxLamports: lamports(2n * SOL),
  bankrollLamports: lamports(550_000_000n),
  sanityBankrollMultiple: 3,
  jumpBps: bps(5_000),
};

type Step =
  | { readonly kind: 'observe'; readonly dt: number; readonly equity: bigint | null; readonly stop: 'same' | 'none' | bigint }
  | { readonly kind: 'confirm'; readonly dt: number; readonly verified: bigint }
  | { readonly kind: 'deposit'; readonly dt: number; readonly amount: bigint }
  | { readonly kind: 'resume'; readonly dt: number; readonly which: 'peak' | 'streak' };

// minutes (a jump and its confirmation), about an hour (the hour-ago base), a day or two (stop days in a row, gaps), and a clock that steps back
const dtArb = fc.oneof(
  fc.integer({ min: 0, max: 10 * MIN }),
  fc.integer({ min: 50 * MIN, max: 70 * MIN }),
  fc.integer({ min: 20 * HOUR, max: 50 * HOUR }),
  fc.integer({ min: -2 * HOUR, max: -1 }),
);
// mostly within the sanity limits (0.05 to 1.6 SOL), now and then zero or above them, now and then not fully valued
const equityArb = fc.oneof(
  { weight: 8, arbitrary: fc.bigInt({ min: 50_000_000n, max: 1_600_000_000n }) },
  { weight: 1, arbitrary: fc.constantFrom(0n, 1_700_000_000n, 2_100_000_000n) },
  { weight: 1, arbitrary: fc.constant(null) },
);
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.record({
      kind: fc.constant('observe' as const),
      dt: dtArb,
      equity: equityArb,
      // the stops' equity: the full one, unknown, or lower (stale positions valued 0)
      stop: fc.oneof(fc.constantFrom('same' as const, 'none' as const), fc.bigInt({ min: 0n, max: 1_000_000_000n })),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('confirm' as const), dt: fc.integer({ min: 0, max: 6 * MIN }), verified: fc.bigInt({ min: 0n, max: 1_700_000_000n }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('deposit' as const), dt: dtArb, amount: fc.bigInt({ min: 1n, max: 500_000_000n }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('resume' as const), dt: dtArb, which: fc.constantFrom('peak' as const, 'streak' as const) }) },
);

/** How often the runs reached each transition the guard checks: a property that never reaches one proves nothing about it. */
const seen = new Map<string, number>();
const saw = (what: string): void => {
  seen.set(what, (seen.get(what) ?? 0) + 1);
};

function stopEquityOf(equity: bigint | null, stop: 'same' | 'none' | bigint): bigint | null {
  if (stop === 'same' || stop === 'none') {
    return stop === 'same' ? equity : null;
  }
  if (equity === null) {
    return stop;
  }
  return equity > stop ? equity - stop : 0n;
}

/** What the step moved, for the counts. */
function note(before: EquityState, next: EquityState, kind: Step['kind']): void {
  saw(kind);
  if (before.day !== null && next.day !== null && next.day > before.day) {
    saw('new day');
  }
  if (next.dailyStopDay !== before.dailyStopDay) {
    saw(next.dailyStopStreak === 1 && before.dailyStopStreak >= 1 ? 'stop after a gap' : 'stop');
  }
  if (next.streakHalt && !before.streakHalt) {
    saw('two-day halt');
  }
  if (next.jumpPending && !before.jumpPending) {
    saw('jump held');
  }
  if (before.peak !== null && next.peak !== null && next.peak > before.peak) {
    saw('peak raised');
  }
}

/** One step as the engine runs it, in one transaction: what the risk module makes is written; a step it refuses writes nothing. */
function step(tx: Tx, now: number, s: Step): void {
  const before = readDayState(tx, 'paper');
  if (s.kind === 'resume') {
    try {
      if (resumeHalt(tx, now, 'owner-telegram', s.which)) {
        assert.deepEqual(readDayState(tx, 'paper'), s.which === 'peak' ? resumePeak(before) : resumeStreak(before));
        saw(`resume ${s.which}`);
      }
    } catch (e) {
      // the peak cannot restart while a jump is held or the equity is zero: storage refuses it as resumePeak does
      assert.ok(e instanceof StorageError && e.code === 'row-count', String(e));
      assert.throws(() => resumePeak(before), RiskError);
      saw('resume refused');
    }
    return;
  }
  let next: EquityState;
  let trips: readonly EquityTrip[] = [];
  let stopEquity: bigint | null = null;
  try {
    if (s.kind === 'observe') {
      stopEquity = stopEquityOf(s.equity, s.stop);
      const observation = {
        now,
        equity: s.equity === null ? null : lamports(s.equity),
        stopEquity: stopEquity === null ? null : lamports(stopEquity),
        equityAnHourAgo: snapshotNear(tx, 'paper', now - HOUR),
      };
      ({ state: next, trips } = observeEquity(before, observation, POLICY));
    } else if (s.kind === 'confirm') {
      next = confirmEquityJump(before, lamports(s.verified), now, POLICY);
    } else {
      next = applyTransfer(before, signedLamports(s.amount));
    }
  } catch (e) {
    if (e instanceof RiskError) {
      return; // the risk module refused the step (no held jump, a late confirmation, a verified level above the limits)
    }
    throw e;
  }
  writeDayState(tx, 'paper', next, now); // never refused
  assert.deepEqual(readDayState(tx, 'paper'), next);
  note(before, next, s.kind);
  if (s.kind === 'observe') {
    insertSnapshot(tx, 'paper', now, s.equity === null ? null : lamports(s.equity), stopEquity === null ? null : lamports(stopEquity));
  }
  for (const trip of trips) {
    if (trip === 'peak-halt' || trip === 'daily-stop-twice') {
      setHalt(tx, `${trip}:paper`, now);
    }
  }
}

describe('the engine\'s day-state write accepts every step of risk/daystate.ts (review R)', () => {
  it('random days of observations, held and confirmed jumps, deposits and the owner\'s resumes: each state the risk module makes is written and read back unchanged', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 20, maxLength: 80 }), (steps) => {
        const db = migratedDb();
        try {
          let now = TEST_NOW;
          for (const s of steps) {
            now += s.dt;
            db.transaction((tx) => step(tx, now, s));
          }
        } finally {
          db.close();
        }
      }),
      { numRuns: 200 },
    );
    // every transition the guard checks was reached, many times over
    for (const what of ['observe', 'confirm', 'deposit', 'new day', 'stop', 'stop after a gap', 'two-day halt', 'jump held', 'peak raised', 'resume peak', 'resume streak', 'resume refused']) {
      assert.ok((seen.get(what) ?? 0) >= 10, `${what}: reached ${seen.get(what) ?? 0} times; ${JSON.stringify([...seen])}`);
    }
  });
});
