// The owner's commands, as the database records them (STORAGE_DESIGN.md s.12.1; reviews P): the
// owner's audit row first, as the newest row of all, then the change the database lets through only
// right after it. Only the owner's command paths may import this file at runtime: app/owner.ts (from
// Telegram, after the owner check) and cli/ (at the server) (architecture rule). The engine cannot
// write an owner row, so it can never lift a halt or clear the pause on its own.
import { STRATEGY_IDS, type StrategyId } from '../core/ids.ts';
import { appendAuditRow, type AuditDetail } from './audit-chain.ts';
import { msParam } from './codec.ts';
import { readFlags, readHalts, readModes, STRATEGY_MODES, type StrategyMode } from './repo-flags.ts';
import { expectChanges, oneOf } from './repo-util.ts';
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

/**
 * The owner's /resume after the paper peak halt or the paper streak halt (decision D4: the live ones
 * only at the server): the owner's row, then the halt is lifted and the clear time recorded. The
 * peak rebase and the streak reset of the day state go in the same transaction (step 6e). False,
 * and nothing written, when that halt is not set.
 */
export function resumeHalt(tx: Tx, at: number, actor: OwnerActor, which: 'peak' | 'streak'): boolean {
  const resume = RESUMES[oneOf(which, ['peak', 'streak'] as const, 'peak or streak')];
  const atParam = msParam(at);
  if (!readHalts(tx).some((h) => h.reason === resume.reason)) {
    return false;
  }
  appendOwnerAudit(tx, at, actor, resume.action, { reason: resume.reason });
  expectChanges(tx.run(LIFT_HALT, resume.reason), 1, 'lifting the halt');
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
