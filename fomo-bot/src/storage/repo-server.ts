// What only the owner at the server may do (STORAGE_DESIGN.md s.12.1 and s.14; RISK_POLICY s.8: KILL
// is cleared, and every halt lifted, only with `fomo reset-halt` at the server): the server's audit
// row first, as the newest row of all, then the change. Only cli/ may import this file at runtime
// (architecture rule): never the engine, never Telegram.
import type { ConfigVersion } from '../config/changes.ts';
import { appendAuditRow, type AuditDetail } from './audit-chain.ts';
import { treeOf } from './config-tree.ts';
import { intCell, jsonParam, msParam } from './codec.ts';
import { checkPeakRestart, readDayState } from './repo-day.ts';
import { readFlags, readHalts } from './repo-flags.ts';
import { expectChanges, oneOf, required } from './repo-util.ts';
import { StorageError, type Tx } from './sqlite.ts';

export const SERVER_AUDIT_ACTIONS = Object.freeze(['server:clear-kill', 'server:reset-halt', 'server:setup'] as const);
export type ServerAuditAction = (typeof SERVER_AUDIT_ACTIONS)[number];

export function appendServerAudit(tx: Tx, at: number, action: ServerAuditAction, detail: AuditDetail = {}): number {
  return appendAuditRow(tx, at, 'owner-server', oneOf(action, SERVER_AUDIT_ACTIONS, 'a server audit action'), detail);
}

const CLEAR_KILL = 'UPDATE flags SET kill = 0, kill_at = NULL, kill_source = NULL, kill_audit_id = NULL, updated_at = ? WHERE id = 1 AND kill = 1';
const LIFT_ALL_HALTS = 'DELETE FROM halt_reasons';
// the time halts (and, owner decision D6, KILL) were lifted starts the recovery wait: written only
// here and in repo-owner.ts (review Q, risk 1)
const HALTS_CLEARED = 'UPDATE flags SET halt_cleared_at = ?, updated_at = ? WHERE id = 1';
// the restarts of risk/daystate.ts resumePeak and resumeStreak, for each mode whose halt is lifted
const REBASE_PEAK = "UPDATE day_state SET peak = last_equity, updated_at = ? WHERE mode = ? AND jump_pending = 0 AND last_equity <> '0'";
const RESTART_STREAK = 'UPDATE day_state SET daily_stop_streak = 0, streak_halt = 0, updated_at = ? WHERE mode = ?';
const MODES = Object.freeze(['paper', 'live'] as const);

/**
 * `fomo reset-halt --clear-kill`: the server's row, then KILL is cleared and the recovery wait
 * starts, as after a lifted halt (owner decision D6). Refused, with nothing written, when KILL is
 * not set.
 */
export function clearKill(tx: Tx, at: number): void {
  const atParam = msParam(at);
  if (readFlags(tx).kill === null) {
    throw new StorageError('row-count', 'KILL is not set: there is nothing to clear');
  }
  appendServerAudit(tx, at, 'server:clear-kill');
  expectChanges(tx.run(CLEAR_KILL, atParam), 1, 'clearing KILL');
  expectChanges(tx.run(HALTS_CLEARED, atParam, atParam), 1, 'the time KILL was cleared');
}

/**
 * `fomo reset-halt`: the server's row, then every halt (paper and live) is lifted, the day state of
 * each mode whose peak or streak halt it lifts restarts as risk/daystate.ts does, and the clear time
 * is recorded. Returns how many; 0, and nothing written, when there is none. Refused, with nothing
 * written, while a mode whose peak halt it would lift holds an equity jump or has no known equity
 * above zero: the peak could not restart, and the halt would come straight back.
 */
export function resetHalts(tx: Tx, at: number): number {
  const atParam = msParam(at);
  const halts = readHalts(tx);
  if (halts.length === 0) {
    return 0;
  }
  const reasons = new Set(halts.map((h) => h.reason));
  const peaks = MODES.filter((m) => reasons.has(`peak-halt:${m}`));
  const streaks = MODES.filter((m) => reasons.has(`daily-stop-twice:${m}`));
  for (const m of peaks) {
    checkPeakRestart(readDayState(tx, m), m);
  }
  appendServerAudit(tx, at, 'server:reset-halt', { reasons: halts.map((h) => h.reason) });
  expectChanges(tx.run(LIFT_ALL_HALTS), halts.length, 'lifting the halts');
  for (const m of peaks) {
    expectChanges(tx.run(REBASE_PEAK, atParam, m), 1, 'restarting the peak');
  }
  for (const m of streaks) {
    expectChanges(tx.run(RESTART_STREAK, atParam, m), 1, 'restarting the streak');
  }
  expectChanges(tx.run(HALTS_CLEARED, atParam, atParam), 1, 'the time halts were cleared');
  return halts.length;
}

const VERSION_COUNT = 'SELECT count(*) AS n FROM config_versions';
const INSERT_FIRST_VERSION = "INSERT INTO config_versions (id, created_at, author, values_json, changed_json, undo_to) VALUES (1, ?, 'default', ?, ?, NULL)";

/**
 * The owner's one-time setup writes config version 1 (contract 1: a normal start refuses to run
 * without it, and nothing ever writes a default in its place): the server's row, then the version.
 * Only a first version (id 1, the default author, nothing changed or undone); refused, with nothing
 * written, once a version exists.
 */
export function setUpConfig(tx: Tx, at: number, version: ConfigVersion): void {
  msParam(at);
  const { id, createdAt, author, values, changed, undoTo } = version;
  if (id !== 1 || author !== 'default' || !Array.isArray(changed) || changed.length !== 0 || undoTo !== null) {
    throw new StorageError('bad-param', 'expected the first config version: id 1, the default author, nothing changed or undone');
  }
  const created = msParam(createdAt);
  const tree = treeOf(values, 'bad-param');
  if (intCell(required(tx.get(VERSION_COUNT), 'the version count'), 'n', 0, Number.MAX_SAFE_INTEGER) !== 0) {
    throw new StorageError('row-count', 'the config is set up already: version 1 exists');
  }
  appendServerAudit(tx, at, 'server:setup');
  expectChanges(tx.run(INSERT_FIRST_VERSION, created, jsonParam(tree), jsonParam([])), 1, 'config version 1');
}
