// The day state and the equity snapshots, as the engine reads and writes them (STORAGE_DESIGN.md
// s.3.5 and s.14). The day state is the EquityState of risk/daystate.ts, one row per ledger mode,
// read back typed, checked and frozen: a missing row or an unknown shape throws, never a default
// (contract 1). The engine writes the whole state after each step, never looser than risk/daystate.ts
// makes it (review R): it can never lift the two-day halt, the daily stop or a held jump, nor lower
// the peak; only the owner's /resume (repo-owner.ts) and the server's reset (repo-server.ts) restart
// the peak and the streak, as risk/daystate.ts does. The snapshots are the base of the jump test:
// the one nearest an hour ago comes from here, never from a caller (contract 6), and they are kept a
// day, so a clock that jumps ahead by less than that cannot erase the hour the test reads.
import { athensDay, previousDay } from '../core/day.ts';
import type { Lamports } from '../core/units.ts';
import type { EquityState } from '../risk/daystate.ts';
import { amountParam, boolCell, boolParam, dayCell, dayParam, intCell, intParam, lamportsCell, lamportsCellOrNull, msCellOrNull, msParam } from './codec.ts';
import { expectChanges, oneOf, required } from './repo-util.ts';
import { StorageError, type Reader, type Row, type Tx } from './sqlite.ts';

const MODES = Object.freeze(['paper', 'live'] as const);
export type LedgerMode = (typeof MODES)[number];

const mode = (m: LedgerMode): LedgerMode => oneOf(m, MODES, 'a ledger mode (paper or live)');

// ---------------------------------------------------------------- the day state

const DAY_STATE =
  'SELECT shape, day, day_start, last_equity, peak, jump_pending, jump_held_equity, jump_held_at, jump_ack_equity, jump_ack_at, daily_stop_day, daily_stop_streak, streak_halt FROM day_state WHERE mode = ?';
const WRITE_DAY_STATE =
  'UPDATE day_state SET day = ?, day_start = ?, last_equity = ?, peak = ?, jump_pending = ?, jump_held_equity = ?, jump_held_at = ?, jump_ack_equity = ?, jump_ack_at = ?, daily_stop_day = ?, daily_stop_streak = ?, streak_halt = ?, updated_at = ? WHERE mode = ?';

const dayOrNull = (r: Row, col: string): string | null => (r[col] === null ? null : dayCell(r, col));

/** An equity and its time, both or neither (the jump hold and its acknowledgement). */
function pairOf(r: Row, equityCol: string, atCol: string): { readonly equity: Lamports; readonly at: number } | null {
  const equity = lamportsCellOrNull(r, equityCol);
  const at = msCellOrNull(r, atCol);
  if (equity === null || at === null) {
    if (equity !== at) {
      throw new StorageError('bad-cell', `column ${atCol} does not match column ${equityCol}`);
    }
    return null;
  }
  return Object.freeze({ equity, at });
}

function stateOf(r: Row): EquityState {
  intCell(r, 'shape', 1, 1); // only shape 1 is known: a newer row is never read as this one
  const jumpPending = boolCell(r, 'jump_pending');
  const jumpHeld = pairOf(r, 'jump_held_equity', 'jump_held_at');
  if (jumpPending !== (jumpHeld !== null)) {
    throw new StorageError('bad-cell', 'column jump_pending does not match the held jump');
  }
  return Object.freeze({
    day: dayOrNull(r, 'day'),
    dayStart: lamportsCell(r, 'day_start'),
    lastEquity: lamportsCell(r, 'last_equity'),
    peak: lamportsCellOrNull(r, 'peak'),
    jumpPending,
    jumpHeld,
    jumpAck: pairOf(r, 'jump_ack_equity', 'jump_ack_at'),
    dailyStopDay: dayOrNull(r, 'daily_stop_day'),
    dailyStopStreak: intCell(r, 'daily_stop_streak', 0, 1_000_000),
    streakHalt: boolCell(r, 'streak_halt'),
  });
}

/** The day state of one ledger mode; its row is required. */
export function readDayState(r: Reader, m: LedgerMode): EquityState {
  const checked = mode(m);
  return stateOf(required(r.get(DAY_STATE, checked), `the day state of ${checked}`));
}

/** risk/daystate.ts: a confirmation follows its held observation by at most 5 minutes (a test pins the two together). */
const CONFIRM_WINDOW_MS = 5 * 60_000;

const higher = (a: bigint, b: bigint): bigint => (a > b ? a : b);

const sameAck = (a: EquityState['jumpAck'], b: EquityState['jumpAck']): boolean =>
  a === null || b === null ? a === b : a.equity === b.equity && a.at === b.at;

/** The streak risk/daystate.ts counts when the stop day becomes `stopDay`: one more on the day after a stop day, 1 after a gap. */
function streakFloor(before: EquityState, stopDay: string | null): number {
  if (stopDay === null || stopDay === before.dailyStopDay) {
    return before.dailyStopStreak;
  }
  return before.dailyStopDay === previousDay(stopDay) ? before.dailyStopStreak + 1 : 1;
}

/**
 * Why the engine's write would leave the day state looser than the one step of risk/daystate.ts that
 * could have produced it (an observation, a confirmation or a deposit), or null (review R, risk 1 and
 * security 3). The daily stop and the jump hold live only here, not in halt_reasons. Refused:
 * - the two-day halt lifted; the day or today's stop day moved back or cleared (the daily stop lifted);
 *   a day moved past the write's own day, or a new stop day that is not the state's own day;
 * - a stop streak below what the stop days give (one more on the day after a stop day, 1 after a gap,
 *   0 only by the owner), or a streak of two or more without the two-day halt;
 * - a held jump cleared other than by its confirmation (at most 5 minutes after the hold, never above
 *   it), or the acknowledgement changed at any other time (a higher one weakens the jump test for an hour);
 * - a new day at an equity of zero (never accepted);
 * - a lower or cleared peak, a peak below the last equity, or a new day without one: a withdrawal
 *   moves the peak only with its recorded transfer (the ledger, 6c-2b-2), never here;
 * - a new day's baseline below the higher of the last equity and the day's first observation; the
 *   same day's baseline lower, or, after a reset, set again below that.
 * Storage cannot see the observations: an equity the engine made up looks like a real one.
 */
function transitionProblem(before: EquityState, after: EquityState, at: number): string | null {
  if (before.streakHalt && !after.streakHalt) {
    return "the two-day halt is lifted only by the owner's /resume or the server's reset";
  }
  if (before.day !== null && (after.day === null || after.day < before.day)) {
    return 'the day never moves back';
  }
  if (before.dailyStopDay !== null && (after.dailyStopDay === null || after.dailyStopDay < before.dailyStopDay)) {
    return 'a daily stop is never lifted early: its day never moves back';
  }
  // never past the write's own day: a day far ahead could never move back, and the mode would stay
  // halted for good (re-check, security N2); a new stop day is the state's own day (observeEquity)
  const writeDay = athensDay(at);
  if (after.day !== before.day && after.day !== null && after.day > writeDay) {
    return "the day moves only up to the write's own day";
  }
  const stopDay = after.dailyStopDay;
  if (stopDay !== before.dailyStopDay && stopDay !== null && (stopDay !== after.day || stopDay > writeDay)) {
    return "a new stop day is the state's own day, never past the write's";
  }
  if (after.dailyStopStreak < streakFloor(before, after.dailyStopDay)) {
    return 'the stop streak counts every stop day: one more on the day after a stop day, 1 after a gap, 0 only by the owner';
  }
  if (after.dailyStopStreak >= 2 && !after.streakHalt) {
    return 'two stop days in a row set the two-day halt';
  }
  if (before.jumpPending && !after.jumpPending) {
    const held = before.jumpHeld;
    const ack = after.jumpAck;
    if (held === null || ack === null || ack.at < held.at || ack.at - held.at > CONFIRM_WINDOW_MS || ack.equity > held.equity) {
      return 'a held jump is cleared only by its confirmation: at most 5 minutes after the hold, never above it';
    }
  } else if (!sameAck(before.jumpAck, after.jumpAck)) {
    return 'the jump acknowledgement changes only with a confirmation';
  }
  if (before.peak !== null && (after.peak === null || after.peak < before.peak)) {
    return 'the peak never falls here: a withdrawal moves it only with its recorded transfer';
  }
  if (after.peak !== null && after.peak < after.lastEquity) {
    return 'the peak is never below the last equity';
  }
  if (after.day === null) {
    return null; // nothing accepted yet: the first observation sets the baseline and the peak
  }
  if (after.day !== before.day) {
    // risk/daystate.ts never accepts a zero equity (the equity-zero trip): a new day at zero would
    // leave the day's baseline at 0, and the daily stop off (re-check, risk 1 and security N1)
    if (after.lastEquity < 1n) {
      return 'an accepted observation is above zero';
    }
    if (after.peak === null) {
      return 'an accepted observation sets the peak';
    }
    if (after.dayStart < (before.day === null ? after.lastEquity : higher(before.lastEquity, after.lastEquity))) {
      return "a new day's baseline is the higher of the last equity and the day's first observation";
    }
  } else if (before.dayStart > 0n ? after.dayStart < before.dayStart : after.dayStart > 0n && after.dayStart < higher(before.lastEquity, after.lastEquity)) {
    return "the day's baseline never falls, and after a reset it is set again from the higher of the last equity and the observation";
  }
  return null;
}

/**
 * The engine's write after one observation, one confirmed jump or one deposit (one write per step):
 * the whole state, each field read once, never looser than that step of risk/daystate.ts
 * (transitionProblem): refused, with nothing written, otherwise. A withdrawal is not written here: it
 * comes with the ledger's transfer record (6c-2b-2). The owner's resume and the server's reset restart
 * the peak and the streak themselves (repo-owner.ts, repo-server.ts).
 */
export function writeDayState(tx: Tx, m: LedgerMode, state: EquityState, at: number): void {
  const checked = mode(m);
  const { day, dayStart, lastEquity, peak, jumpPending, jumpHeld, jumpAck, dailyStopDay, dailyStopStreak, streakHalt } = state;
  // each nested field read once: the check and the write see the same values
  const held = jumpHeld === null ? null : Object.freeze({ equity: jumpHeld.equity, at: jumpHeld.at });
  const ack = jumpAck === null ? null : Object.freeze({ equity: jumpAck.equity, at: jumpAck.at });
  const params = [
    day === null ? null : dayParam(day),
    amountParam(dayStart),
    amountParam(lastEquity),
    peak === null ? null : amountParam(peak),
    boolParam(jumpPending),
    held === null ? null : amountParam(held.equity),
    held === null ? null : msParam(held.at),
    ack === null ? null : amountParam(ack.equity),
    ack === null ? null : msParam(ack.at),
    dailyStopDay === null ? null : dayParam(dailyStopDay),
    intParam(dailyStopStreak),
    boolParam(streakHalt),
    msParam(at),
  ] as const;
  const after: EquityState = { day, dayStart, lastEquity, peak, jumpPending, jumpHeld: held, jumpAck: ack, dailyStopDay, dailyStopStreak, streakHalt };
  const problem = transitionProblem(readDayState(tx, checked), after, at);
  if (problem !== null) {
    throw new StorageError('bad-param', problem);
  }
  expectChanges(tx.run(WRITE_DAY_STATE, ...params, checked), 1, 'the day state');
}

/**
 * The peak can restart (the owner's resume, the server's reset) only as risk/daystate.ts resumePeak
 * allows: at a known equity above zero, and with no held jump (a hold means the last equity is in
 * doubt). Refused otherwise, before anything is written.
 */
export function checkPeakRestart(state: EquityState, m: LedgerMode): void {
  const checked = mode(m); // named in the message (a code, never a value): which mode blocks the reset
  if (state.jumpPending) {
    throw new StorageError('row-count', `resolve the held equity jump of ${checked} before restarting its peak (the engine confirms it, or observes again)`);
  }
  if (state.lastEquity < 1n) {
    throw new StorageError('row-count', `the peak of ${checked} restarts only at a known equity above zero`);
  }
}

// ---------------------------------------------------------------- the equity snapshots

const INSERT_SNAPSHOT = 'INSERT INTO equity_snapshots (mode, at, equity, stop_equity) VALUES (?, ?, ?, ?) ON CONFLICT (mode, at) DO NOTHING';
const NEAREST = 'SELECT equity FROM equity_snapshots WHERE mode = ? AND equity IS NOT NULL ORDER BY abs(at - ?), at LIMIT 1';
const PRUNE_SNAPSHOTS = 'DELETE FROM equity_snapshots WHERE at < ?';

/** How long snapshots are kept: the jump test reads the hour before now, and a day covers a clock that jumped ahead. */
export const SNAPSHOT_KEEP_MS = 86_400_000;

/**
 * One snapshot per mode and millisecond: true when stored, false when one for that millisecond was
 * already there (it stays). Unknown equity is stored as such; the stops' equity is never above the
 * full equity when both are known.
 */
export function insertSnapshot(tx: Tx, m: LedgerMode, at: number, equity: Lamports | null, stopEquity: Lamports | null): boolean {
  const checked = mode(m);
  const atParam = msParam(at);
  const full = equity === null ? null : amountParam(equity);
  const stops = stopEquity === null ? null : amountParam(stopEquity);
  if (equity !== null && stopEquity !== null && stopEquity > equity) {
    throw new StorageError('bad-param', "expected the stops' equity at most the full equity");
  }
  return tx.run(INSERT_SNAPSHOT, checked, atParam, full, stops) === 1;
}

/** The known equity of the snapshot nearest `target` in this mode (the older one on a tie), or null when there is none. */
export function snapshotNear(r: Reader, m: LedgerMode, target: number): Lamports | null {
  const row = r.get(NEAREST, mode(m), msParam(target));
  return row === undefined ? null : lamportsCell(row, 'equity');
}

/** Deletes the snapshots older than SNAPSHOT_KEEP_MS, in both modes; returns how many. */
export function pruneSnapshots(tx: Tx, now: number): number {
  msParam(now);
  return tx.run(PRUNE_SNAPSHOTS, msParam(Math.max(0, now - SNAPSHOT_KEEP_MS)));
}
