// The owner's commands, as the database records them (STORAGE_DESIGN.md s.12.1 and s.14; reviews P
// and Q): the owner's audit row first, as the newest row of all, then the change. Only the owner's
// command paths may import this file at runtime: app/owner.ts (from Telegram, after the owner check)
// and cli/ (at the server) (architecture rule). The engine cannot write an owner row, so it can never
// lift a halt, clear the pause, choose a strategy's mode or change the config on its own.
import type { ConfigVersion, PendingChange } from '../config/changes.ts';
import { STRATEGY_IDS, type StrategyId } from '../core/ids.ts';
import { appendAuditRow, type AuditDetail } from './audit-chain.ts';
import { changedPathsOf, holds, isConfigPath, treeOf } from './config-tree.ts';
import { amountParam, intParam, jsonParam, msParam } from './codec.ts';
import { readConfigHistory, readPendingChanges, type StoredVersion } from './repo-config.ts';
import { checkPeakRestart, readDayState } from './repo-day.ts';
import { readFlags, readHalts, readModes, STRATEGY_MODES, type StrategyMode } from './repo-flags.ts';
import { expectChanges, oneOf } from './repo-util.ts';
import { SCHEMA_V1_COPIES } from './schema-v1.ts';
import { StorageError, type Tx } from './sqlite.ts';

export const OWNER_AUDIT_ACTIONS = Object.freeze([
  'owner:set',
  'owner:rollback',
  'owner:cancel-pending',
  'owner:ai-approve',
  'owner:resume-peak',
  'owner:resume-streak',
  'owner:pause',
  'owner:unpause',
  'owner:off',
  'owner:paper',
  'owner:golive',
] as const);
export type OwnerAuditAction = (typeof OWNER_AUDIT_ACTIONS)[number];

export const OWNER_ACTORS = Object.freeze(['owner-telegram', 'owner-server'] as const);
/** Where the owner's command came from: Telegram after the owner check, or the server's terminal. */
export type OwnerActor = (typeof OWNER_ACTORS)[number];

export function appendOwnerAudit(tx: Tx, at: number, actor: OwnerActor, action: OwnerAuditAction, detail: AuditDetail = {}): number {
  const checkedActor = oneOf(actor, OWNER_ACTORS, 'the owner (from Telegram or at the server)');
  return appendAuditRow(tx, at, checkedActor, oneOf(action, OWNER_AUDIT_ACTIONS, 'an owner audit action'), detail);
}

// ---------------------------------------------------------------- resume after a paper halt

const RESUMES = Object.freeze({
  peak: Object.freeze({ action: 'owner:resume-peak', reason: 'peak-halt:paper' } as const),
  streak: Object.freeze({ action: 'owner:resume-streak', reason: 'daily-stop-twice:paper' } as const),
});
const LIFT_HALT = 'DELETE FROM halt_reasons WHERE reason = ?';
// the time halts were lifted starts the recovery wait: written only here and in repo-server.ts, never
// by the engine, which could otherwise move it back and cut the wait short (review Q, risk 1)
const HALTS_CLEARED = 'UPDATE flags SET halt_cleared_at = ?, updated_at = ? WHERE id = 1';
// the restarts of risk/daystate.ts resumePeak and resumeStreak (s.12.1: in the same transaction)
const REBASE_PEAK = "UPDATE day_state SET peak = last_equity, updated_at = ? WHERE mode = ? AND jump_pending = 0 AND last_equity <> '0'";
const RESTART_STREAK = 'UPDATE day_state SET daily_stop_streak = 0, streak_halt = 0, updated_at = ? WHERE mode = ?';

/**
 * The owner's /resume after the paper peak halt or the paper streak halt (decision D4: the live ones
 * only at the server): the owner's row, then the halt is lifted, the paper day state restarts as
 * risk/daystate.ts does (the peak at the last equity, or the streak at zero) and the clear time is
 * recorded. False, and nothing written, when that halt is not set; refused, with nothing written,
 * when the peak cannot restart (a held jump, or no known equity above zero).
 */
export function resumeHalt(tx: Tx, at: number, actor: OwnerActor, which: 'peak' | 'streak'): boolean {
  const checked = oneOf(which, ['peak', 'streak'] as const, 'peak or streak');
  const resume = RESUMES[checked];
  const atParam = msParam(at);
  if (!readHalts(tx).some((h) => h.reason === resume.reason)) {
    return false;
  }
  if (checked === 'peak') {
    checkPeakRestart(readDayState(tx, 'paper'), 'paper');
  }
  appendOwnerAudit(tx, at, actor, resume.action, { reason: resume.reason });
  expectChanges(tx.run(LIFT_HALT, resume.reason), 1, 'lifting the halt');
  if (checked === 'peak') {
    expectChanges(tx.run(REBASE_PEAK, atParam, 'paper'), 1, 'restarting the peak');
  } else {
    expectChanges(tx.run(RESTART_STREAK, atParam, 'paper'), 1, 'restarting the streak');
  }
  expectChanges(tx.run(HALTS_CLEARED, atParam, atParam), 1, 'the time halts were cleared');
  return true;
}

// ---------------------------------------------------------------- the pause

const UNPAUSE = 'UPDATE flags SET paused = 0, paused_at = NULL, updated_at = ? WHERE id = 1 AND paused = 1';

/** Clears the owner's pause with the owner's row; false, and nothing written, when there is none. */
export function unpause(tx: Tx, at: number, actor: OwnerActor): boolean {
  const atParam = msParam(at);
  if (readFlags(tx).pausedAt === null) {
    return false;
  }
  appendOwnerAudit(tx, at, actor, 'owner:unpause');
  expectChanges(tx.run(UNPAUSE, atParam), 1, 'clearing the pause');
  return true;
}

// ---------------------------------------------------------------- strategy modes

const SET_MODE = 'UPDATE strategy_modes SET mode = ?, changed_by = ?, changed_at = ? WHERE strategy = ?';
// leaving live starts the go-live gate again (RISK_POLICY s.10), and a gate start only moves later
const LEAVE_LIVE = 'UPDATE strategy_modes SET mode = ?, changed_by = ?, changed_at = ?, gate_since = max(gate_since, ?) WHERE strategy = ?';
const MODE_ACTION = Object.freeze({ off: 'owner:off', paper: 'owner:paper', live: 'owner:golive' } as const);
const MODE_CHANGER = Object.freeze({ off: 'owner-off', paper: 'owner-paper', live: 'owner-golive' } as const);

/**
 * The owner's /off, /paper or /golive for one strategy. Live only from paper (review Q, risk 6),
 * and leaving live starts the gate again. The go-live gate itself, the server's arm flag and the
 * live switch are checked by the command before it gets here (Phase 4 and 8); the database refuses
 * live from anything but /golive.
 */
export function setStrategyMode(tx: Tx, at: number, actor: OwnerActor, strategy: StrategyId, mode: StrategyMode): void {
  const id = oneOf(strategy, STRATEGY_IDS, 'a strategy');
  const checked = oneOf(mode, STRATEGY_MODES, 'a mode (off, paper or live)');
  const atParam = msParam(at);
  const current = readModes(tx)[id].mode;
  if (checked === 'live' && current !== 'paper') {
    throw new StorageError('bad-param', 'a strategy goes live only from paper');
  }
  appendOwnerAudit(tx, at, actor, MODE_ACTION[checked], { strategy: id });
  if (current === 'live' && checked !== 'live') {
    expectChanges(tx.run(LEAVE_LIVE, checked, MODE_CHANGER[checked], atParam, atParam, id), 1, 'the strategy mode');
    return;
  }
  expectChanges(tx.run(SET_MODE, checked, MODE_CHANGER[checked], atParam, id), 1, 'the strategy mode');
}

// ---------------------------------------------------------------- the config commands

const CONFIG_ACTIONS = Object.freeze(['owner:set', 'owner:rollback', 'owner:ai-approve', 'owner:cancel-pending'] as const);
export type OwnerConfigAction = (typeof CONFIG_ACTIONS)[number];
/** Each command writes its versions and pending rows under its own author; a /cancel writes none. */
const AUTHOR_OF = Object.freeze({ 'owner:set': 'owner', 'owner:rollback': 'rollback', 'owner:ai-approve': 'ai-approved', 'owner:cancel-pending': null } as const);

/** What one config command writes, as config/changes.ts planned it. */
export interface OwnerConfigWrite {
  /** The version that applies now; null when nothing applies now (every change waits, or a /cancel). */
  readonly version: ConfigVersion | null;
  /** New waiting loosenings, each at least a day. */
  readonly pending: readonly PendingChange[];
  /** The tunables whose waiting row this command replaces or cancels. */
  readonly cancelled: readonly string[];
}

const INSERT_VERSION = 'INSERT INTO config_versions (id, created_at, author, values_json, changed_json, undo_to) VALUES (?, ?, ?, ?, ?, ?)';
const INSERT_PENDING = 'INSERT INTO pending_changes (path, from_value, to_value, source, requested_at, apply_at) VALUES (?, ?, ?, ?, ?, ?)';
const DELETE_PENDING = 'DELETE FROM pending_changes WHERE path = ?';

function paths(list: unknown, what: string): readonly string[] {
  if (!Array.isArray(list) || !list.every(isConfigPath) || new Set(list).size !== list.length) {
    throw new StorageError('bad-param', `expected ${what}: tunable names, each once`);
  }
  return Object.freeze([...(list as readonly string[])]);
}

function amountOf(v: unknown): bigint {
  if (typeof v === 'bigint' && v >= 0n) {
    return v;
  }
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) {
    return BigInt(v);
  }
  throw new StorageError('bad-param', 'expected a tunable value: a whole number of at least 0');
}

/**
 * /set, /rollback, an approved AI proposal or /cancel: the owner's row first, then the cancelled rows
 * deleted, the version that applies now and the new waiting rows. Storage re-checks what it can see
 * without the config module, before any write: the command's own author; the next version id, undoing
 * only to an earlier one; a version that keeps every tunable and lists exactly what it changed; each
 * new row made from the tunable's current value, waiting at least a day, one per tunable. Returns the
 * new version's id, or null when none applies now.
 */
export function writeOwnerConfig(tx: Tx, at: number, actor: OwnerActor, action: OwnerConfigAction, write: OwnerConfigWrite): number | null {
  const checkedActor = oneOf(actor, OWNER_ACTORS, 'the owner (from Telegram or at the server)');
  const checkedAction = oneOf(action, CONFIG_ACTIONS, 'an owner config command');
  msParam(at);
  const { version, pending, cancelled } = write;
  const author = AUTHOR_OF[checkedAction];
  const cancels = paths(cancelled, 'the cancelled changes');
  if (!Array.isArray(pending)) {
    throw new StorageError('bad-param', 'expected a list of waiting changes');
  }
  const writes = version !== null || pending.length > 0;
  if (author === null ? writes || cancels.length === 0 : !writes && cancels.length === 0) {
    throw new StorageError('bad-param', 'a /cancel only cancels waiting changes, and every other command writes something');
  }
  const history = readConfigHistory(tx); // never empty: a missing version 1 throws
  const active = history[history.length - 1] as StoredVersion;
  const activeTree = treeOf(JSON.parse(active.valuesJson), 'bad-cell');

  let versionParams: readonly (string | bigint | null)[] | null = null;
  let versionId: number | null = null;
  let applied: readonly string[] = [];
  if (version !== null) {
    const { id, createdAt, author: written, values, changed, undoTo } = version;
    if (written !== author) {
      throw new StorageError('bad-param', 'each command writes its versions under its own author');
    }
    if (id !== active.id + 1 || (undoTo !== null && (!Number.isSafeInteger(undoTo) || undoTo < 1 || undoTo >= id))) {
      throw new StorageError('bad-param', 'a new version is the next one, and undoes only to an earlier one');
    }
    const created = msParam(createdAt);
    // never older than the active version (the history would no longer read in order), never later
    // than the command (a far date would refuse every later version); a clock behind the active
    // version dates a tightening as the active one (review R, risk 3 and security 2)
    if (createdAt < active.createdAt || createdAt > Math.max(at, active.createdAt)) {
      throw new StorageError('bad-param', 'a new version is dated no earlier than the active one and no later than the command');
    }
    const tree = treeOf(values, 'bad-param');
    const listed = paths(changed, 'the changed tunables');
    const actual = changedPathsOf(activeTree, tree);
    if (actual === null || actual.length === 0 || actual.join() !== listed.join()) {
      throw new StorageError('bad-param', 'a version keeps every tunable and lists exactly what it changed');
    }
    versionParams = [intParam(id), created, written, jsonParam(tree), jsonParam(listed), undoTo === null ? null : intParam(undoTo)];
    versionId = id;
    applied = listed;
  }

  const waiting = new Set(readPendingChanges(tx).map((p) => p.path));
  for (const path of cancels) {
    if (!waiting.has(path)) {
      throw new StorageError('row-count', `there is no waiting change of ${path} to cancel`);
    }
  }
  const seen = new Set<string>();
  const pendingParams = (pending as readonly PendingChange[]).map((row) => {
    const { path, from, to, source, requestedAt, applyAt } = row;
    if (!isConfigPath(path) || seen.has(path)) {
      throw new StorageError('bad-param', 'one waiting change per tunable, by its name');
    }
    seen.add(path);
    const fromAmount = amountOf(from);
    if (source !== author || !holds(activeTree, path, fromAmount)) {
      throw new StorageError('bad-param', "a waiting change is made by the command's own source, from the tunable's current value");
    }
    const requested = msParam(requestedAt);
    const due = msParam(applyAt);
    // asked for now, by this command, and due at least a day from now: a row dated in the past would
    // apply at once, one in the future would make every later config command refuse (review R, risk 2)
    if (requestedAt !== at || applyAt - at < SCHEMA_V1_COPIES.looseningDelayMs) {
      throw new StorageError('bad-param', 'a waiting change is asked for by this command, now, and waits at least a day');
    }
    return [path, amountParam(fromAmount), amountParam(amountOf(to)), source, requested, due] as const;
  });
  // RISK_POLICY s.12: a command replaces the waiting change of every tunable it sets or queues, and
  // /rollback replaces every waiting change; a tunable is applied now or waits, never both (risk 4)
  const queued = new Set<string>(pendingParams.map((p) => p[0]));
  if (applied.some((p) => queued.has(p))) {
    throw new StorageError('bad-param', 'a tunable is applied now or waits, not both');
  }
  if ([...applied, ...queued].some((p) => waiting.has(p) && !cancels.includes(p))) {
    throw new StorageError('bad-param', 'a command replaces the waiting change of every tunable it sets (RISK_POLICY s.12)');
  }
  if (checkedAction === 'owner:rollback' && [...waiting].some((p) => !cancels.includes(p))) {
    throw new StorageError('bad-param', '/rollback replaces every waiting change (RISK_POLICY s.12)');
  }

  appendOwnerAudit(tx, at, checkedActor, checkedAction, { version: versionId, applied: [...applied], pending: pendingParams.map((p) => p[0]), cancelled: [...cancels] });
  for (const path of cancels) {
    expectChanges(tx.run(DELETE_PENDING, path), 1, 'the cancelled waiting change');
  }
  if (versionParams !== null) {
    expectChanges(tx.run(INSERT_VERSION, ...versionParams), 1, 'the new version');
  }
  for (const params of pendingParams) {
    expectChanges(tx.run(INSERT_PENDING, ...params), 1, 'the waiting change');
  }
  return versionId;
}
