// The day state (EquityState of risk/daystate.ts, one row per ledger mode) and the equity snapshots
// (STORAGE_DESIGN.md s.3.5 and s.14): read back typed and checked, a missing row or an unknown shape
// throws (contract 1), and the engine's write may never lift the two-day halt: only the owner's
// /resume does, in repo-owner.ts. Snapshots: one per mode and millisecond; the one nearest an hour ago
// comes from the database (contract 6); they are kept a day, so a clock that jumps ahead cannot erase
// the hour the jump test reads. Written before src/storage/repo-day.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { LAMPORTS_PER_SOL as SOL, bps, lamports, signedLamports } from '../../../src/core/units.ts';
import { applyTransfer, confirmEquityJump, emptyEquityState, observeEquity, type EquityPolicy, type EquityState } from '../../../src/risk/daystate.ts';
import { RiskError } from '../../../src/risk/reserve.ts';
import { amountParam, boolParam, dayParam, intParam, msParam } from '../../../src/storage/codec.ts';
import * as dayFile from '../../../src/storage/repo-day.ts';
import { SNAPSHOT_KEEP_MS, insertSnapshot, newestSnapshot, pruneSnapshots, readDayState, snapshotNear, writeDayState } from '../../../src/storage/repo-day.ts';
import type { Db } from '../../../src/storage/sqlite.ts';
import { TEST_NOW, count, migratedDb, removeDir, storageError, tamper, tempDir } from './helpers.ts';

const T = TEST_NOW;
const HOUR = 3_600_000;
const MIN = 60_000;

/**
 * From the empty state to FULL (every field set, the jump hold and the acknowledgement included), one
 * step of risk/daystate.ts at a time, as the engine writes it: a jump held and confirmed before the
 * first accepted observation; a day at 3 SOL that falls to 2 SOL with a daily stop; the next day from
 * 2 SOL; a new jump held.
 */
const WALK: readonly EquityState[] = (() => {
  const held = { ...emptyEquityState(), jumpPending: true, jumpHeld: { equity: lamports(3n * SOL), at: T - 12 * MIN } };
  const confirmed = { ...held, jumpPending: false, jumpHeld: null, jumpAck: { equity: lamports(3n * SOL), at: T - 10 * MIN } };
  const first = { ...confirmed, day: '2026-11-15', dayStart: lamports(3n * SOL), lastEquity: lamports(3n * SOL), peak: lamports(3n * SOL) };
  const stopped = { ...first, lastEquity: lamports(2n * SOL), dailyStopDay: '2026-11-15', dailyStopStreak: 1 };
  const nextDay = { ...stopped, day: '2026-11-16', dayStart: lamports(2n * SOL) };
  const rose = { ...nextDay, lastEquity: lamports(2n * SOL + 5n) };
  const full = { ...rose, jumpPending: true, jumpHeld: { equity: lamports(4n * SOL), at: T - 1_000 } };
  return Object.freeze([held, confirmed, first, stopped, nextDay, rose, full].map((s) => Object.freeze(s)));
})();
const FULL = WALK[WALK.length - 1] as EquityState;
/** FULL before its new jump: the acknowledgement set, no hold. */
const ROSE = WALK[WALK.length - 2] as EquityState;

/** Writes the walk to FULL into one mode, one step per transaction, up to `upTo` (the whole walk by default). */
function walk(db: Db, mode: 'paper' | 'live', upTo: EquityState = FULL): void {
  for (const s of WALK.slice(0, WALK.indexOf(upTo) + 1)) {
    db.transaction((tx) => writeDayState(tx, mode, s, T));
  }
  assert.deepEqual(readDayState(db, mode), upTo);
}

function withDb(fn: (db: Db) => void): void {
  const db = migratedDb();
  try {
    fn(db);
  } finally {
    db.close();
  }
}

function withTampered(script: string, fn: (db: Db) => void): void {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'bot.sqlite');
    migratedDb(file).close();
    tamper(file, script);
    const db = migratedDb(file);
    try {
      fn(db);
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
}

describe('the engine\'s day-state file: only what it may do', () => {
  it('exports the day state\'s read and write, the peak-restart check and the snapshots\', and nothing else: a new export here is a reviewed change', () => {
    assert.deepEqual(Object.keys(dayFile).sort(), ['SNAPSHOT_KEEP_MS', 'checkPeakRestart', 'insertSnapshot', 'newestSnapshot', 'pruneSnapshots', 'readDayState', 'snapshotNear', 'writeDayState']);
  });
});

describe('the day state: one row per ledger mode, read back exactly as risk/daystate.ts keeps it', () => {
  it('each mode starts as the empty state, typed and frozen', () => {
    withDb((db) => {
      for (const mode of ['paper', 'live'] as const) {
        const state = readDayState(db, mode);
        assert.deepEqual(state, emptyEquityState());
        assert.ok(Object.isFrozen(state));
      }
    });
  });

  it('writes and reads back a full state, the jump hold and its acknowledgement included; the other mode stays', () => {
    withDb((db) => {
      walk(db, 'live');
      const read = readDayState(db, 'live');
      assert.ok(Object.isFrozen(read.jumpHeld) && Object.isFrozen(read.jumpAck));
      assert.deepEqual(readDayState(db, 'paper'), emptyEquityState());
      const settled: EquityState = { ...FULL, jumpPending: false, jumpHeld: null, jumpAck: { equity: lamports(3n * SOL + SOL / 2n), at: T } }; // confirmed
      db.transaction((tx) => writeDayState(tx, 'live', settled, T + 1));
      assert.deepEqual(readDayState(db, 'live'), settled);
      assert.equal(db.get("SELECT updated_at FROM day_state WHERE mode = 'live'")?.['updated_at'], BigInt(T + 1));
    });
  });

  it('the mode is paper or live, the time a timestamp, and a state the code or the schema refuses writes nothing', () => {
    withDb((db) => {
      walk(db, 'paper', ROSE);
      storageError(() => readDayState(db, 'demo' as unknown as 'paper'), 'bad-param');
      storageError(() => db.transaction((tx) => writeDayState(tx, 'demo' as unknown as 'paper', FULL, T)), 'bad-param');
      storageError(() => db.transaction((tx) => writeDayState(tx, 'paper', FULL, Number.NaN)), 'bad-param');
      storageError(() => db.transaction((tx) => writeDayState(tx, 'paper', { ...ROSE, jumpHeld: FULL.jumpHeld }, T)), 'constraint'); // a hold without its flag
      storageError(() => db.transaction((tx) => writeDayState(tx, 'paper', { ...ROSE, dailyStopStreak: -1 }, T)), 'bad-param'); // the streak never falls
      storageError(() => db.transaction((tx) => writeDayState(tx, 'paper', { ...ROSE, day: '2026-13-01' }, T)), 'bad-param');
      storageError(() => db.transaction((tx) => writeDayState(tx, 'paper', { ...ROSE, lastEquity: -1n as typeof FULL.lastEquity }, T)), 'bad-param');
      assert.deepEqual(readDayState(db, 'paper'), ROSE);
    });
  });

  it('the engine can never lift the two-day halt: only the owner\'s /resume does (repo-owner.ts)', () => {
    withDb((db) => {
      walk(db, 'paper', ROSE);
      // a second daily stop, the day after the first: the two-day halt
      const halted: EquityState = { ...ROSE, lastEquity: lamports(SOL), dailyStopDay: '2026-11-16', dailyStopStreak: 2, streakHalt: true };
      db.transaction((tx) => writeDayState(tx, 'paper', halted, T));
      const lifted: EquityState = { ...halted, dailyStopStreak: 0, streakHalt: false };
      // a careless caller that catches the refusal and commits still writes nothing
      db.transaction((tx) => {
        assert.match(storageError(() => writeDayState(tx, 'paper', lifted, T + 1), 'bad-param').detail, /resume/);
      });
      assert.deepEqual(readDayState(db, 'paper'), halted);
      const nextDay: EquityState = { ...halted, day: '2026-11-17', dayStart: lamports(SOL), dailyStopDay: '2026-11-17', dailyStopStreak: 3 };
      db.transaction((tx) => writeDayState(tx, 'paper', nextDay, T + 24 * HOUR)); // everything else the engine still writes, the next day
      assert.deepEqual(readDayState(db, 'paper'), nextDay);
    });
  });

  it('a row changed behind the bot\'s back is refused, never repaired (an unknown shape, a hold without its flag, a bad day), and a missing row throws', () => {
    withTampered("PRAGMA ignore_check_constraints = 1;\nUPDATE day_state SET shape = 2 WHERE mode = 'paper';", (db) => {
      assert.match(storageError(() => readDayState(db, 'paper'), 'bad-cell').detail, /column shape/);
      assert.deepEqual(readDayState(db, 'live'), emptyEquityState());
    });
    withTampered("PRAGMA ignore_check_constraints = 1;\nUPDATE day_state SET jump_pending = 1 WHERE mode = 'paper';", (db) => {
      assert.match(storageError(() => readDayState(db, 'paper'), 'bad-cell').detail, /column jump_pending/);
    });
    withTampered("PRAGMA ignore_check_constraints = 1;\nUPDATE day_state SET day = '2026-13-01' WHERE mode = 'paper';", (db) => {
      assert.match(storageError(() => readDayState(db, 'paper'), 'bad-cell').detail, /column day/);
    });
    withTampered("PRAGMA ignore_check_constraints = 1;\nUPDATE day_state SET jump_ack_equity = '5' WHERE mode = 'paper';", (db) => {
      assert.match(storageError(() => readDayState(db, 'paper'), 'bad-cell').detail, /column jump_ack_at does not match column jump_ack_equity/);
    });
    withTampered("DROP TRIGGER day_state_no_delete;\nDELETE FROM day_state WHERE mode = 'live';", (db) => {
      storageError(() => readDayState(db, 'live'), 'row-missing');
      storageError(() => db.transaction((tx) => writeDayState(tx, 'live', FULL, T)), 'row-missing');
    });
  });
});

/** The paper policy of tests/unit/risk/daystate.test.ts. */
const POLICY: EquityPolicy = {
  mode: 'paper',
  dailyStopBps: bps(3_000),
  peakHaltBps: bps(5_000),
  sanityMaxLamports: lamports(2n * SOL),
  bankrollLamports: lamports(550_000_000n),
  sanityBankrollMultiple: 3,
  jumpBps: bps(5_000),
};

/** Sets a mode's day state directly, outside the engine's writer: the starting point of a refusal test. */
function seed(db: Db, s: EquityState): void {
  const opt = <V>(v: V | null, f: (x: V) => string | bigint): string | bigint | null => (v === null ? null : f(v));
  db.transaction((tx) =>
    tx.run(
      'UPDATE day_state SET day = ?, day_start = ?, last_equity = ?, peak = ?, jump_pending = ?, jump_held_equity = ?, jump_held_at = ?, jump_ack_equity = ?, jump_ack_at = ?, daily_stop_day = ?, daily_stop_streak = ?, streak_halt = ? WHERE mode = ?',
      opt(s.day, dayParam),
      amountParam(s.dayStart),
      amountParam(s.lastEquity),
      opt(s.peak, amountParam),
      boolParam(s.jumpPending),
      opt(s.jumpHeld, (h) => amountParam(h.equity)),
      opt(s.jumpHeld, (h) => msParam(h.at)),
      opt(s.jumpAck, (a) => amountParam(a.equity)),
      opt(s.jumpAck, (a) => msParam(a.at)),
      opt(s.dailyStopDay, dayParam),
      intParam(s.dailyStopStreak),
      boolParam(s.streakHalt),
      'paper',
    ),
  );
  assert.deepEqual(readDayState(db, 'paper'), s);
}

/** Refused with a message matching `why`: nothing is written, even when a careless caller catches the refusal and commits. */
function refused(db: Db, after: EquityState, why: RegExp, at = T + 1): void {
  const before = readDayState(db, 'paper');
  db.transaction((tx) => {
    assert.match(storageError(() => writeDayState(tx, 'paper', after, at), 'bad-param').detail, why);
  });
  assert.deepEqual(readDayState(db, 'paper'), before);
}

/** Written, and read back as given. */
function accepted(db: Db, after: EquityState, at = T + 2): void {
  db.transaction((tx) => writeDayState(tx, 'paper', after, at));
  assert.deepEqual(readDayState(db, 'paper'), after);
}

const DAY = 86_400_000;

const PEAK = (12n * SOL) / 10n;
const NOW_EQUITY = (9n * SOL) / 10n;
/** A day after a daily stop yesterday: a baseline of 1 SOL, 0.9 SOL now, a peak of 1.2 SOL. */
const BASE: EquityState = Object.freeze({
  ...emptyEquityState(),
  day: '2026-11-16',
  dayStart: lamports(SOL),
  lastEquity: lamports(NOW_EQUITY),
  peak: lamports(PEAK),
  dailyStopDay: '2026-11-15',
  dailyStopStreak: 1,
});

function from(start: EquityState, fn: (db: Db) => void): void {
  withDb((db) => {
    seed(db, start);
    fn(db);
  });
}

describe('the engine\'s write is never looser than the step of risk/daystate.ts that could have made it (review R)', () => {
  it('the daily stop: the day and the stop day never move back or clear, so a stop is never lifted early', () => {
    from(BASE, (db) => {
      refused(db, { ...BASE, day: '2026-11-15' }, /the day never moves back/);
      refused(db, { ...BASE, day: null }, /the day never moves back/);
      refused(db, { ...BASE, dailyStopDay: '2026-11-14' }, /never lifted early/);
      refused(db, { ...BASE, dailyStopDay: null }, /never lifted early/);
      accepted(db, { ...BASE, dailyStopDay: '2026-11-16', dailyStopStreak: 2, streakHalt: true }); // today's stop, the day after one
    });
  });

  it('a day is never written past the write\'s own day, and a new stop day is the state\'s own day: a day far ahead could never move back again (re-check, security N2)', () => {
    from(BASE, (db) => {
      refused(db, { ...BASE, day: '2199-12-31' }, /only up to the write's own day/);
      refused(db, { ...BASE, day: '2026-11-17' }, /only up to the write's own day/); // the write is still on the 16th
      accepted(db, { ...BASE, day: '2026-11-17' }, T + DAY); // on the 17th it may
    });
    from({ ...BASE, dailyStopDay: null, dailyStopStreak: 0 }, (db) => {
      refused(db, { ...BASE, dailyStopDay: '2199-12-31' }, /the state's own day/);
      refused(db, { ...BASE, dailyStopDay: '2026-11-15' }, /the state's own day/); // yesterday's date for today's stop would not block today
      accepted(db, { ...BASE, dailyStopDay: '2026-11-16' });
    });
    from(BASE, (db) => {
      refused(db, { ...BASE, day: '2026-11-17', dailyStopDay: '2026-11-17', dailyStopStreak: 2, streakHalt: true }, /only up to the write's own day/);
      // with the clock behind the state's day, risk/daystate.ts reports the clock and trips no stop
      refused(db, { ...BASE, dailyStopDay: '2026-11-16', dailyStopStreak: 2, streakHalt: true }, /never past the write's/, T - 2 * DAY);
      // a day the clock is behind (it stepped back) may stay as it is: risk/daystate.ts keeps it and reports the clock
      accepted(db, { ...BASE, lastEquity: lamports(NOW_EQUITY + 1n) }, T - 2 * DAY);
    });
  });

  it('a new day starts at an equity above zero: risk/daystate.ts never accepts zero, and a zero baseline would switch the daily stop off (re-check, risk 1 and security N1)', () => {
    withDb((db) => refused(db, { ...emptyEquityState(), day: '2026-11-16', dayStart: lamports(0n), lastEquity: lamports(0n), peak: lamports(0n) }, /above zero/));
    from(BASE, (db) => refused(db, { ...BASE, day: '2026-11-17', dayStart: lamports(0n), lastEquity: lamports(0n) }, /above zero/, T + DAY));
  });

  it('the stop streak counts every stop day, so the two-day halt cannot be headed off: one more the day after a stop day, 1 after a gap, 0 only by the owner', () => {
    from(BASE, (db) => {
      refused(db, { ...BASE, dailyStopStreak: 0 }, /counts every stop day/);
      refused(db, { ...BASE, dailyStopDay: '2026-11-16' }, /counts every stop day/); // the day after a stop day, still 1
      refused(db, { ...BASE, dailyStopDay: '2026-11-16', dailyStopStreak: 2 }, /two stop days in a row set the two-day halt/);
      accepted(db, { ...BASE, dailyStopStreak: 4, streakHalt: true }); // more is only stricter
    });
    // after a quiet day the streak restarts at 1; once set, the two-day halt stays
    const gap: EquityState = { ...BASE, day: '2026-11-18', dailyStopDay: '2026-11-18' };
    from(BASE, (db) => {
      refused(db, { ...gap, dailyStopStreak: 0 }, /counts every stop day/, T + 2 * DAY);
      accepted(db, { ...gap, dailyStopStreak: 1 }, T + 2 * DAY);
    });
    from({ ...BASE, dailyStopStreak: 2, streakHalt: true }, (db) => {
      refused(db, { ...gap, dailyStopStreak: 1 }, /resume/, T + 2 * DAY);
      refused(db, { ...BASE, dailyStopStreak: 1, streakHalt: true }, /counts every stop day/); // the same stop day: the streak stays
      accepted(db, { ...gap, dailyStopStreak: 1, streakHalt: true }, T + 2 * DAY);
    });
    // after the owner's resume the streak starts again from 0: the next stop day counts 1, even the day after a stop day
    from({ ...BASE, dailyStopStreak: 0 }, (db) => accepted(db, { ...BASE, dailyStopDay: '2026-11-16', dailyStopStreak: 1 }));
  });

  it('a held jump is cleared only by its confirmation, at most 5 minutes after the hold and never above it; the acknowledgement changes at no other time', () => {
    const heldEquity = SOL + SOL / 2n;
    const held: EquityState = { ...BASE, jumpPending: true, jumpHeld: { equity: lamports(heldEquity), at: T - MIN } };
    const confirmed = (equity: bigint, at: number): EquityState => ({ ...held, jumpPending: false, jumpHeld: null, jumpAck: { equity: lamports(equity), at } });
    from(held, (db) => {
      refused(db, { ...held, jumpPending: false, jumpHeld: null }, /cleared only by its confirmation/);
      refused(db, confirmed(SOL, T - MIN - 1), /cleared only by its confirmation/); // before the hold
      refused(db, confirmed(SOL, T - MIN + 5 * MIN + 1), /cleared only by its confirmation/); // more than 5 minutes after it
      refused(db, confirmed(heldEquity + 1n, T), /cleared only by its confirmation/); // above what the hold saw
      accepted(db, confirmed(heldEquity, T - MIN + 5 * MIN)); // the edges: the held equity itself, 5 minutes after
      const ack = readDayState(db, 'paper');
      // with no hold, it changes at no other time: not moved, not cleared, not with a new hold
      refused(db, { ...ack, jumpAck: { equity: lamports(SOL), at: T } }, /changes only with a confirmation/);
      refused(db, { ...ack, jumpAck: { equity: lamports(heldEquity), at: T + 4 * MIN + 1 } }, /changes only with a confirmation/); // only later: the test would use it for a later hour
      refused(db, { ...ack, jumpAck: { equity: lamports(heldEquity + 1n), at: T + 4 * MIN } }, /changes only with a confirmation/); // only higher
      refused(db, { ...ack, jumpAck: null }, /changes only with a confirmation/);
      refused(db, { ...ack, jumpPending: true, jumpHeld: { equity: lamports(SOL), at: T }, jumpAck: { equity: lamports(2n * SOL), at: T } }, /changes only with a confirmation/);
      accepted(db, { ...ack, jumpPending: true, jumpHeld: { equity: lamports(SOL), at: T } }); // a new hold keeps it
    });
  });

  it('the 5 minutes are risk/daystate.ts\'s own: its confirmation at the edge is written, and a millisecond later it refuses itself', () => {
    const held: EquityState = { ...BASE, jumpPending: true, jumpHeld: { equity: lamports(SOL + SOL / 2n), at: T - MIN } };
    from(held, (db) => {
      assert.throws(() => confirmEquityJump(held, lamports(SOL), T - MIN + 5 * MIN + 1, POLICY), RiskError);
      accepted(db, confirmEquityJump(held, lamports(SOL), T - MIN + 5 * MIN, POLICY));
    });
  });

  it('the peak never falls or clears here, and is never below the last equity: a withdrawal moves it only with its recorded transfer (6c-2b-2)', () => {
    from(BASE, (db) => {
      refused(db, { ...BASE, peak: lamports(PEAK - 1n) }, /the peak never falls here/);
      refused(db, { ...BASE, peak: null }, /the peak never falls here/);
      // a withdrawal's shape (all three lower by the same amount) too: here it would look exactly like a bug that hides a loss
      const w = SOL / 10n;
      refused(db, { ...BASE, dayStart: lamports(SOL - w), lastEquity: lamports(NOW_EQUITY - w), peak: lamports(PEAK - w) }, /the peak never falls here/);
      refused(db, { ...BASE, lastEquity: lamports(PEAK + 1n) }, /never below the last equity/); // a rise that did not raise the peak
      accepted(db, { ...BASE, lastEquity: lamports(PEAK + 1n), peak: lamports(PEAK + 1n) });
    });
  });

  it('a new day\'s baseline is the higher of the last equity and its first observation, and an accepted observation sets the peak', () => {
    const next: EquityState = { ...BASE, day: '2026-11-17', lastEquity: lamports((8n * SOL) / 10n) };
    from(BASE, (db) => {
      refused(db, { ...next, dayStart: lamports(NOW_EQUITY - 1n) }, /a new day's baseline/, T + DAY); // an overnight gap down counts against today
      accepted(db, { ...next, dayStart: lamports(NOW_EQUITY) }, T + DAY);
    });
    const first = { ...emptyEquityState(), day: '2026-11-16', lastEquity: lamports(SOL) };
    withDb((db) => {
      refused(db, { ...first, dayStart: lamports(SOL - 1n), peak: lamports(SOL) }, /a new day's baseline/); // the first observation ever: the baseline is that observation
      refused(db, { ...first, dayStart: lamports(SOL), peak: null }, /sets the peak/);
      accepted(db, { ...first, dayStart: lamports(SOL), peak: lamports(SOL) });
    });
    // a deposit before the first observation leaves no peak (risk/daystate.ts applyTransfer); the first observation sets one
    const deposited = { ...emptyEquityState(), lastEquity: lamports(2n * SOL) };
    withDb((db) => {
      accepted(db, deposited);
      accepted(db, { ...deposited, day: '2026-11-16', dayStart: lamports(SOL), lastEquity: lamports(SOL), peak: lamports(SOL) });
    });
  });

  it('the same day\'s baseline never falls, and after a reset it is set again from the higher of the last equity and the observation', () => {
    from(BASE, (db) => {
      refused(db, { ...BASE, dayStart: lamports(SOL - 1n) }, /the day's baseline never falls/);
      accepted(db, { ...BASE, dayStart: lamports(SOL + 1n) }); // higher is only stricter
    });
    // a withdrawal reset the baseline (the ledger's transfer write, 6c-2b-2): it stays 0 until the next accepted observation sets it
    const reset: EquityState = { ...BASE, dayStart: lamports(0n), lastEquity: lamports(SOL / 5n), peak: lamports(SOL / 5n) };
    from(reset, (db) => {
      refused(db, { ...reset, dayStart: lamports(SOL / 10n) }, /after a reset/);
      const deposited = applyTransfer(reset, signedLamports(1_000_000n)); // a deposit leaves it reset
      accepted(db, deposited);
      accepted(db, observeEquity(deposited, { now: T, equity: lamports(SOL / 5n), stopEquity: null, equityAnHourAgo: null }, POLICY).state);
      assert.equal(readDayState(db, 'paper').dayStart, SOL / 5n + 1_000_000n); // the higher: the last equity with the deposit
    });
  });
});

describe('the equity snapshots: the base of the jump test, from the database and kept a day', () => {
  it('stores one snapshot per mode and millisecond: the first stays, a second in the same millisecond is dropped', () => {
    withDb((db) => {
      assert.equal(db.transaction((tx) => insertSnapshot(tx, 'paper', T, lamports(SOL), lamports(SOL - 1n))), true);
      assert.equal(db.transaction((tx) => insertSnapshot(tx, 'paper', T, lamports(5n * SOL), null)), false);
      assert.equal(db.transaction((tx) => insertSnapshot(tx, 'live', T, null, null)), true); // unknown equity is kept as such
      assert.equal(count(db, 'equity_snapshots'), 2n);
      assert.deepEqual(snapshotNear(db, 'paper', T, T), { equity: SOL, at: T });
      storageError(() => db.transaction((tx) => insertSnapshot(tx, 'paper', Number.NaN, null, null)), 'bad-param');
      // the stops' equity is never above the full one (risk/daystate.ts); the schema has no CHECK for it, so the code refuses it
      storageError(() => db.transaction((tx) => insertSnapshot(tx, 'paper', T + 1, lamports(SOL), lamports(2n * SOL))), 'bad-param');
      assert.equal(count(db, 'equity_snapshots'), 2n);
      // a known stop equity with an unknown full one is real: stale positions count 0 for the stops
      assert.equal(db.transaction((tx) => insertSnapshot(tx, 'paper', T + 2, null, lamports(SOL))), true);
    });
  });

  it('the snapshot nearest a time, with a known equity, of that mode only, at or before now, with its own time; the older one on a tie (C42)', () => {
    withDb((db) => {
      assert.equal(snapshotNear(db, 'paper', T - HOUR, T), null);
      db.transaction((tx) => {
        insertSnapshot(tx, 'paper', T - 2 * HOUR, lamports(1n), null);
        insertSnapshot(tx, 'paper', T - HOUR - 60_000, lamports(2n), null);
        insertSnapshot(tx, 'paper', T - HOUR + 60_000, lamports(3n), null);
        insertSnapshot(tx, 'paper', T - HOUR + 1_000, null, null); // nearest, but its equity is unknown
        insertSnapshot(tx, 'paper', T + 600_000, lamports(4n), null); // after now: a clock that stepped back
        insertSnapshot(tx, 'live', T - HOUR, lamports(9n), null);
        return 0;
      });
      assert.deepEqual(snapshotNear(db, 'paper', T - HOUR, T), { equity: 2n, at: T - HOUR - 60_000 }); // a minute before and after: the older
      assert.deepEqual(snapshotNear(db, 'paper', T - HOUR + 30_000, T), { equity: 3n, at: T - HOUR + 60_000 });
      assert.deepEqual(snapshotNear(db, 'live', T - HOUR, T), { equity: 9n, at: T - HOUR });
      assert.deepEqual(snapshotNear(db, 'paper', 0, T), { equity: 1n, at: T - 2 * HOUR });
      // a row after now is never the base, however near it is
      assert.deepEqual(snapshotNear(db, 'paper', T + 600_000, T), { equity: 3n, at: T - HOUR + 60_000 });
      assert.deepEqual(snapshotNear(db, 'paper', T + 600_000, T + 600_000), { equity: 4n, at: T + 600_000 });
      assert.deepEqual(snapshotNear(db, 'paper', T, T - 2 * HOUR), { equity: 1n, at: T - 2 * HOUR }); // now before the target
      assert.equal(snapshotNear(db, 'paper', T - HOUR, T - 3 * HOUR), null);
      assert.ok(Object.isFrozen(snapshotNear(db, 'paper', T - HOUR, T)));
      for (const [target, now] of [
        [Number.NaN, T],
        [T, Number.NaN],
      ] as const) {
        storageError(() => snapshotNear(db, 'paper', target, now), 'bad-param');
      }
      storageError(() => snapshotNear(db, 'demo' as unknown as 'paper', T, T), 'bad-param');
    });
  });

  it('the newest snapshot at or before now, unknown equity included (T1 freshness, 6e)', () => {
    withDb((db) => {
      assert.equal(newestSnapshot(db, 'paper', T), null);
      db.transaction((tx) => {
        insertSnapshot(tx, 'paper', T - 60_000, lamports(5n), lamports(4n));
        insertSnapshot(tx, 'paper', T, null, null);
        insertSnapshot(tx, 'paper', T + 1_000, lamports(6n), null); // after now
        insertSnapshot(tx, 'live', T + 500, lamports(9n), null);
        return 0;
      });
      assert.deepEqual(newestSnapshot(db, 'paper', T), { at: T, equity: null, stopEquity: null });
      assert.deepEqual(newestSnapshot(db, 'paper', T - 1), { at: T - 60_000, equity: 5n, stopEquity: 4n });
      assert.deepEqual(newestSnapshot(db, 'paper', T + 1_000), { at: T + 1_000, equity: 6n, stopEquity: null });
      assert.deepEqual(newestSnapshot(db, 'live', T + 1_000), { at: T + 500, equity: 9n, stopEquity: null });
      assert.equal(newestSnapshot(db, 'live', T), null);
      assert.ok(Object.isFrozen(newestSnapshot(db, 'paper', T)));
      storageError(() => newestSnapshot(db, 'paper', Number.NaN), 'bad-param');
      storageError(() => newestSnapshot(db, 'demo' as unknown as 'paper', T), 'bad-param');
    });
  });

  it('prunes only snapshots older than a day, in both modes: a clock a day ahead at most erases nothing from the hour the jump test reads', () => {
    withDb((db) => {
      assert.equal(SNAPSHOT_KEEP_MS, 86_400_000);
      db.transaction((tx) => {
        for (const at of [T - 25 * HOUR, T - 2 * HOUR, T - HOUR, T]) {
          insertSnapshot(tx, 'paper', at, lamports(1n), null);
        }
        insertSnapshot(tx, 'live', T - 25 * HOUR, lamports(1n), null);
        return 0;
      });
      assert.equal(db.transaction((tx) => pruneSnapshots(tx, T)), 2); // the two from a day and an hour ago
      assert.equal(db.transaction((tx) => pruneSnapshots(tx, T + 23 * HOUR)), 1); // a clock 23 h ahead: two hours ago goes
      assert.deepEqual(snapshotNear(db, 'paper', T - HOUR, T + 23 * HOUR), { equity: 1n, at: T - HOUR }); // the hour-ago one is still there
      assert.equal(db.transaction((tx) => pruneSnapshots(tx, 5)), 0); // near 1970 the margin stops at 0
      storageError(() => db.transaction((tx) => pruneSnapshots(tx, Number.NaN)), 'bad-param');
      assert.equal(count(db, 'equity_snapshots'), 2n);
    });
  });
});
