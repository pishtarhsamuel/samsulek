// The day state and the equity snapshots, as the engine reads them (STORAGE_DESIGN.md s.3.5, s.14 and
// s.17.16). The day state is the EquityState of risk/daystate.ts, one row per ledger mode, read back
// typed, checked and frozen: a missing row or an unknown shape throws, never a default (contract 1). The
// snapshots are the base of the jump test: the one nearest an hour ago comes from here, never from a
// caller (contract 6). This file only reads (review W1): the observation's writes (the day state and the
// snapshots) are storage/repo-observe.ts, which only app/day-tx.ts may import; the confirmation of a held
// jump is storage/repo-jump.ts, which only app/jump-tx.ts may import; the owner's /resume and the server's
// reset restart the peak and the streak themselves (repo-owner.ts, repo-server.ts).
import type { Lamports } from '../core/units.ts';
import type { EquityState } from '../risk/daystate.ts';
import { boolCell, dayCell, intCell, lamportsCell, lamportsCellOrNull, msCell, msCellOrNull, msParam } from './codec.ts';
import { oneOf, required } from './repo-util.ts';
import { StorageError, type Reader, type Row } from './sqlite.ts';

const MODES = Object.freeze(['paper', 'live'] as const);
export type LedgerMode = (typeof MODES)[number];

const mode = (m: LedgerMode): LedgerMode => oneOf(m, MODES, 'a ledger mode (paper or live)');

// ---------------------------------------------------------------- the day state

const DAY_STATE =
  'SELECT shape, day, day_start, last_equity, peak, jump_pending, jump_held_equity, jump_held_at, jump_ack_equity, jump_ack_at, daily_stop_day, daily_stop_streak, streak_halt FROM day_state WHERE mode = ?';

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

// the base of the jump test, on the (mode, at) key: the newest known row at or before the target (and
// now), and the oldest known row after the target and at or before now; the nearer wins in code
const KNOWN_AT_OR_BEFORE = 'SELECT at, equity FROM equity_snapshots WHERE mode = ? AND at <= ? AND equity IS NOT NULL ORDER BY at DESC LIMIT 1';
const KNOWN_AFTER = 'SELECT at, equity FROM equity_snapshots WHERE mode = ? AND at > ? AND at <= ? AND equity IS NOT NULL ORDER BY at LIMIT 1';
const NEWEST = 'SELECT at, equity, stop_equity FROM equity_snapshots WHERE mode = ? AND at <= ? ORDER BY at DESC LIMIT 1';

/** A snapshot row with a known equity: its equity and its own time. */
function knownOf(row: Row | undefined): { readonly equity: Lamports; readonly at: number } | null {
  return row === undefined ? null : Object.freeze({ equity: lamportsCell(row, 'equity'), at: msCell(row, 'at') });
}

/**
 * The known equity nearest `target` in this mode, with the row's own time, among the rows at or before
 * `now` only (C42: a row a clock that stepped back left in the future is never the base); the older one
 * on a tie; null when there is none.
 */
export function snapshotNear(r: Reader, m: LedgerMode, target: number, now: number): { readonly equity: Lamports; readonly at: number } | null {
  const checked = mode(m);
  const targetParam = msParam(target);
  const nowParam = msParam(now);
  const before = knownOf(r.get(KNOWN_AT_OR_BEFORE, checked, targetParam < nowParam ? targetParam : nowParam));
  const after = knownOf(r.get(KNOWN_AFTER, checked, targetParam, nowParam));
  if (before === null || after === null) {
    return before ?? after;
  }
  return after.at - target < target - before.at ? after : before;
}

/** The newest snapshot at or before `now` in this mode, unknown equity included (T1's freshness rule), or null. */
export function newestSnapshot(r: Reader, m: LedgerMode, now: number): { readonly at: number; readonly equity: Lamports | null; readonly stopEquity: Lamports | null } | null {
  const row = r.get(NEWEST, mode(m), msParam(now));
  return row === undefined ? null : Object.freeze({ at: msCell(row, 'at'), equity: lamportsCellOrNull(row, 'equity'), stopEquity: lamportsCellOrNull(row, 'stop_equity') });
}
