// The flags, halts, strategy modes, entry bans and the day's entry count, as the engine reads and
// writes them (STORAGE_DESIGN.md s.1.4, s.3 and s.12). Reads come back typed, checked and frozen; a
// required row that is gone throws (contract 1). The engine's writes make trading stricter: it sets
// KILL, a halt and the pause, demotes a live strategy, restarts a go-live gate, adds bans and counts
// entries. Setting KILL or a halt, and a demotion, write their own audit row first (reviews P, P-R1).
// No write here moves a safety time back: a gate start only moves later, and the time halts were
// cleared is not here at all (review Q, risk 1 and 2). Lifting a halt, clearing KILL or the pause,
// recording a halt clear and choosing a strategy's mode are the owner's (repo-owner.ts,
// repo-server.ts). Two writes here can loosen, each within its rule:
// - the low-equity stop is the engine's own, set and lifted as equity moves (it is derived from
//   equity on every tick, step 6d, and sizing checks the minimum trade on its own);
// - pruning deletes cooldowns and pauses that ended at least a day ago, so a clock that jumps
//   ahead by less than a day cannot erase one that is still running (review Q, risk 3).
import { STRATEGY_IDS, type StrategyId } from '../core/ids.ts';
import { boolCell, boolParam, codeCell, codeParam, dayParam, idCell, idParam, intCell, intParam, msCell, msCellOrNull, msParam } from './codec.ts';
import { appendEngineAudit } from './repo-audit.ts';
import { MAX_AUDIT_ID, cellOneOf, expectChanges, oneOf, required } from './repo-util.ts';
import { StorageError, type Reader, type Tx } from './sqlite.ts';

// ---------------------------------------------------------------- flags

export const KILL_SOURCES = Object.freeze(['cli', 'telegram', 'sentinel'] as const);
export type KillSource = (typeof KILL_SOURCES)[number];

export interface KillState {
  readonly at: number;
  readonly source: KillSource;
  /** The audit row written when KILL was set: only a newer owner row can clear it. */
  readonly auditId: number;
}

export interface StoredFlags {
  readonly kill: KillState | null;
  readonly pausedAt: number | null;
  /** The engine's own low-equity stop (10% of equity below the minimum trade). */
  readonly entriesStopped: boolean;
  /** When halts were last lifted: entries wait out the recovery period after it. */
  readonly haltClearedAt: number | null;
  readonly updatedAt: number;
}

const FLAGS = 'SELECT kill, kill_at, kill_source, kill_audit_id, paused, paused_at, entries_stopped, halt_cleared_at, updated_at FROM flags WHERE id = 1';
const SET_KILL = 'UPDATE flags SET kill = 1, kill_at = ?, kill_source = ?, kill_audit_id = ?, updated_at = ? WHERE id = 1 AND kill = 0';
const SET_PAUSED = 'UPDATE flags SET paused = 1, paused_at = ?, updated_at = ? WHERE id = 1 AND paused = 0';
const SET_ENTRIES_STOPPED = 'UPDATE flags SET entries_stopped = ?, updated_at = ? WHERE id = 1';

export function readFlags(r: Reader): StoredFlags {
  const row = required(r.get(FLAGS), 'the flags row');
  const kill = boolCell(row, 'kill')
    ? Object.freeze({ at: msCell(row, 'kill_at'), source: cellOneOf(row, 'kill_source', KILL_SOURCES), auditId: intCell(row, 'kill_audit_id', 0, MAX_AUDIT_ID) })
    : null;
  return Object.freeze({
    kill,
    pausedAt: boolCell(row, 'paused') ? msCell(row, 'paused_at') : null,
    entriesStopped: boolCell(row, 'entries_stopped'),
    haltClearedAt: msCellOrNull(row, 'halt_cleared_at'),
    updatedAt: msCell(row, 'updated_at'),
  });
}

/**
 * Sets KILL with its own audit row, whose id the flag names. A KILL already set keeps its time and
 * source, and nothing is written: false.
 */
export function setKill(tx: Tx, at: number, source: KillSource): boolean {
  const checked = oneOf(source, KILL_SOURCES, 'a KILL source (cli, telegram or sentinel)');
  const atParam = msParam(at);
  if (readFlags(tx).kill !== null) {
    return false;
  }
  const auditId = appendEngineAudit(tx, at, 'engine:kill-set', { source: checked });
  expectChanges(tx.run(SET_KILL, atParam, checked, intParam(auditId), atParam), 1, 'setting KILL');
  return true;
}

/** The pause: the first one keeps its time; false when already paused. Clearing it is the owner's. */
export function setPaused(tx: Tx, at: number): boolean {
  const atParam = msParam(at);
  if (readFlags(tx).pausedAt !== null) {
    return false;
  }
  expectChanges(tx.run(SET_PAUSED, atParam, atParam), 1, 'setting the pause');
  return true;
}

/**
 * The engine's own low-equity stop (10% of equity below the minimum trade), on or off as equity
 * moves; false when it already was. Not an owner latch: step 6d derives it from equity every tick.
 */
export function setEntriesStopped(tx: Tx, stopped: boolean, at: number): boolean {
  const value = boolParam(stopped);
  const atParam = msParam(at);
  if (readFlags(tx).entriesStopped === stopped) {
    return false;
  }
  expectChanges(tx.run(SET_ENTRIES_STOPPED, value, atParam), 1, 'the low-equity stop');
  return true;
}

// ---------------------------------------------------------------- halts

export interface Halt {
  readonly reason: string;
  readonly setAt: number;
  /** The audit row written when the halt was set: only a newer owner row can lift it. */
  readonly setAuditId: number;
}

const HALTS = 'SELECT reason, set_at, set_audit_id FROM halt_reasons ORDER BY reason';
const HALT_COUNT = 'SELECT count(*) AS n FROM halt_reasons WHERE reason = ?';
const INSERT_HALT = 'INSERT INTO halt_reasons (reason, set_at, set_audit_id) VALUES (?, ?, ?)';

export function readHalts(r: Reader): readonly Halt[] {
  return Object.freeze(
    r.all(HALTS).map((row) => Object.freeze({ reason: codeCell(row, 'reason'), setAt: msCell(row, 'set_at'), setAuditId: intCell(row, 'set_audit_id', 0, MAX_AUDIT_ID) })),
  );
}

/**
 * Sets a halt with its own audit row, whose id the halt names. A halt already set keeps its first
 * time and link, and nothing is written: false. Never OR IGNORE, which would also drop a row that
 * fails a CHECK (VERIFIED_FACTS, conflict clauses).
 */
export function setHalt(tx: Tx, reason: string, at: number): boolean {
  const code = codeParam(reason);
  const atParam = msParam(at);
  if (intCell(required(tx.get(HALT_COUNT, code), 'the halt count'), 'n', 0, 1) === 1) {
    return false;
  }
  const auditId = appendEngineAudit(tx, at, 'engine:halt-set', { reason: code });
  expectChanges(tx.run(INSERT_HALT, code, atParam, intParam(auditId)), 1, 'setting a halt');
  return true;
}

// ---------------------------------------------------------------- strategy modes

export const STRATEGY_MODES = Object.freeze(['off', 'paper', 'live'] as const);
export type StrategyMode = (typeof STRATEGY_MODES)[number];
export const MODE_CHANGERS = Object.freeze(['migration', 'owner-off', 'owner-paper', 'owner-golive', 'auto-demote'] as const);
export type ModeChanger = (typeof MODE_CHANGERS)[number];

export interface ModeState {
  readonly mode: StrategyMode;
  readonly changedAt: number;
  readonly changedBy: ModeChanger;
  /** When the strategy's go-live gate started counting. */
  readonly gateSince: number;
}

const MODES = 'SELECT strategy, mode, changed_at, changed_by, gate_since FROM strategy_modes ORDER BY strategy';
// a demoted strategy returns to live only through a fresh gate (RISK_POLICY s.10), and a gate start
// only ever moves later: a stale time or a clock that stepped back cannot count older paper trades
const DEMOTE =
  "UPDATE strategy_modes SET mode = 'paper', changed_by = 'auto-demote', changed_at = ?, gate_since = max(gate_since, ?) WHERE strategy = ? AND mode = 'live'";
const RESTART_GATE = 'UPDATE strategy_modes SET gate_since = max(gate_since, ?) WHERE strategy = ?';

/** Every strategy's mode; a strategy whose row is gone throws (it is never assumed off). */
export function readModes(r: Reader): Readonly<Record<StrategyId, ModeState>> {
  const found = new Map<StrategyId, ModeState>();
  for (const row of r.all(MODES)) {
    found.set(
      cellOneOf(row, 'strategy', STRATEGY_IDS),
      Object.freeze({
        mode: cellOneOf(row, 'mode', STRATEGY_MODES),
        changedAt: msCell(row, 'changed_at'),
        changedBy: cellOneOf(row, 'changed_by', MODE_CHANGERS),
        gateSince: msCell(row, 'gate_since'),
      }),
    );
  }
  const out = {} as Record<StrategyId, ModeState>;
  for (const id of STRATEGY_IDS) {
    out[id] = required(found.get(id), `the mode of strategy ${id}`);
  }
  return Object.freeze(out);
}

/**
 * A live strategy goes back to paper (a config change, a send failure), with its own audit row, and
 * its go-live gate starts again; false, and nothing written, when it was not live.
 */
export function demote(tx: Tx, strategy: StrategyId, at: number): boolean {
  const id = oneOf(strategy, STRATEGY_IDS, 'a strategy');
  const atParam = msParam(at);
  if (readModes(tx)[id].mode !== 'live') {
    return false;
  }
  appendEngineAudit(tx, at, 'engine:demote', { strategy: id });
  expectChanges(tx.run(DEMOTE, atParam, atParam, id), 1, 'demoting the strategy');
  return true;
}

/** The strategy's go-live gate starts counting again from `at`, or stays at a later start it already has. */
export function restartGate(tx: Tx, strategy: StrategyId, at: number): void {
  const id = oneOf(strategy, STRATEGY_IDS, 'a strategy');
  expectChanges(tx.run(RESTART_GATE, msParam(at), id), 1, 'restarting the gate');
}

// ---------------------------------------------------------------- entry bans

export const BAN_KINDS = Object.freeze(['mint-cooldown', 'mint-ban', 'creator-ban', 'strategy-pause', 'strategy-off'] as const);
export type BanKind = (typeof BAN_KINDS)[number];
const PERMANENT: readonly BanKind[] = Object.freeze(['mint-ban', 'creator-ban']);
const STRATEGY_KINDS: readonly BanKind[] = Object.freeze(['strategy-pause', 'strategy-off']);

export interface Ban {
  readonly kind: BanKind;
  /** A mint, a creator or a strategy. */
  readonly key: string;
  /** When it ends; null for a ban, which never does. */
  readonly until: number | null;
  readonly reason: string;
  readonly setAt: number;
}

export interface NewBan {
  readonly kind: BanKind;
  readonly key: string;
  readonly until: number | null;
  readonly reason: string;
  readonly at: number;
}

// a cooldown or pause already there is lengthened to the later end, never shortened; a ban already there stays as it is
const ADD_ENDING_BAN = 'INSERT INTO entry_bans (kind, key, until, reason, set_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (kind, key) DO UPDATE SET until = max(until, excluded.until)';
const ADD_PERMANENT_BAN = 'INSERT INTO entry_bans (kind, key, until, reason, set_at) VALUES (?, ?, NULL, ?, ?) ON CONFLICT (kind, key) DO NOTHING';
const ACTIVE_BANS = 'SELECT kind, key, until, reason, set_at FROM entry_bans WHERE until IS NULL OR until > ? ORDER BY kind, key';
const PRUNE_BANS = "DELETE FROM entry_bans WHERE kind IN ('mint-cooldown', 'strategy-pause', 'strategy-off') AND until <= ?";

export function addBan(tx: Tx, ban: NewBan): void {
  const kind = oneOf(ban.kind, BAN_KINDS, 'a ban kind');
  const permanent = PERMANENT.includes(kind);
  const key = STRATEGY_KINDS.includes(kind) ? oneOf(ban.key, STRATEGY_IDS, 'a strategy') : idParam(ban.key);
  const reason = codeParam(ban.reason);
  const at = msParam(ban.at);
  if (permanent !== (ban.until === null)) {
    throw new StorageError('bad-param', permanent ? 'expected a ban without an end' : 'expected a cooldown or pause with an end');
  }
  if (permanent) {
    const changes = tx.run(ADD_PERMANENT_BAN, kind, key, reason, at); // 0: the ban was already there
    expectChanges(changes, changes === 0 ? 0 : 1, 'adding a ban');
    return;
  }
  expectChanges(tx.run(ADD_ENDING_BAN, kind, key, msParam(ban.until as number), reason, at), 1, 'adding a cooldown');
}

/** What still blocks at `now`: bans, and cooldowns and pauses that end after it. */
export function activeBans(r: Reader, now: number): readonly Ban[] {
  return Object.freeze(
    r.all(ACTIVE_BANS, msParam(now)).map((row) => {
      const kind = cellOneOf(row, 'kind', BAN_KINDS);
      return Object.freeze({
        kind,
        key: STRATEGY_KINDS.includes(kind) ? cellOneOf(row, 'key', STRATEGY_IDS) : idCell(row, 'key'),
        until: msCellOrNull(row, 'until'),
        reason: codeCell(row, 'reason'),
        setAt: msCell(row, 'set_at'),
      });
    }),
  );
}

/** Cooldowns and pauses stay for a day after they end before they are pruned (the rows are tiny). */
export const PRUNE_MARGIN_MS = 86_400_000;

/**
 * Deletes the cooldowns and pauses that ended at least a day before `now`; never a ban. Returns how
 * many. A clock that jumps ahead by less than the margin cannot erase one that is still running.
 */
export function pruneBans(tx: Tx, now: number): number {
  msParam(now); // a timestamp before any arithmetic on it
  return tx.run(PRUNE_BANS, msParam(Math.max(0, now - PRUNE_MARGIN_MS)));
}

// ---------------------------------------------------------------- the day's entry count

const ENTRIES_ON = 'SELECT count FROM entry_counts WHERE day = ?';
const COUNT_ENTRY = 'INSERT INTO entry_counts (day, count) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET count = count + 1';

/** Entries counted for the day (Athens calendar day, YYYY-MM-DD); 0 when none. */
export function entriesOn(r: Reader, day: string): number {
  const row = r.get(ENTRIES_ON, dayParam(day));
  return row === undefined ? 0 : intCell(row, 'count', 1, 1_000_000);
}

/** Counts one entry for the day and returns the new count; the database refuses one past the hard limit. */
export function countEntry(tx: Tx, day: string): number {
  const checked = dayParam(day);
  expectChanges(tx.run(COUNT_ENTRY, checked), 1, 'counting the entry');
  return entriesOn(tx, checked);
}
