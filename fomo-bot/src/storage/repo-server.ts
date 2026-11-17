// What only the owner at the server may do (STORAGE_DESIGN.md s.12.1; RISK_POLICY s.8: KILL is
// cleared, and every halt lifted, only with `fomo reset-halt` at the server): the server's audit
// row first, as the newest row of all, then the change the database lets through only right after
// it. Only cli/ may import this file at runtime (architecture rule): never the engine, never
// Telegram.
import { appendAuditRow, type AuditDetail } from './audit-chain.ts';
import { msParam } from './codec.ts';
import { readFlags, readHalts } from './repo-flags.ts';
import { expectChanges, oneOf } from './repo-util.ts';
import { StorageError, type Tx } from './sqlite.ts';

export const SERVER_AUDIT_ACTIONS = Object.freeze(['server:clear-kill', 'server:reset-halt'] as const);
export type ServerAuditAction = (typeof SERVER_AUDIT_ACTIONS)[number];

export function appendServerAudit(tx: Tx, at: number, action: ServerAuditAction, detail: AuditDetail = {}): number {
  return appendAuditRow(tx, at, 'owner-server', oneOf(action, SERVER_AUDIT_ACTIONS, 'a server audit action'), detail);
}

const CLEAR_KILL = 'UPDATE flags SET kill = 0, kill_at = NULL, kill_source = NULL, kill_audit_id = NULL, updated_at = ? WHERE id = 1 AND kill = 1';
const LIFT_ALL_HALTS = 'DELETE FROM halt_reasons';
// the time halts were lifted starts the recovery wait: written only here and in repo-owner.ts (review Q, risk 1)
const HALTS_CLEARED = 'UPDATE flags SET halt_cleared_at = ?, updated_at = ? WHERE id = 1';

/** `fomo reset-halt --clear-kill`: the server's row, then KILL is cleared. Refused, with nothing written, when KILL is not set. */
export function clearKill(tx: Tx, at: number): void {
  const atParam = msParam(at);
  if (readFlags(tx).kill === null) {
    throw new StorageError('row-count', 'KILL is not set: there is nothing to clear');
  }
  appendServerAudit(tx, at, 'server:clear-kill');
  expectChanges(tx.run(CLEAR_KILL, atParam), 1, 'clearing KILL');
}

/** `fomo reset-halt`: the server's row, then every halt (paper and live) is lifted. Returns how many; 0, and nothing written, when there is none. */
export function resetHalts(tx: Tx, at: number): number {
  const atParam = msParam(at);
  const halts = readHalts(tx);
  if (halts.length === 0) {
    return 0;
  }
  appendServerAudit(tx, at, 'server:reset-halt', { reasons: halts.map((h) => h.reason) });
  expectChanges(tx.run(LIFT_ALL_HALTS), halts.length, 'lifting the halts');
  expectChanges(tx.run(HALTS_CLEARED, atParam, atParam), 1, 'the time halts were cleared');
  return halts.length;
}
