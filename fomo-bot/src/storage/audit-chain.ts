// The audit log's hash chain (STORAGE_DESIGN.md s.12; reviews P): the one place audit rows are
// written. Each row takes the next id, names the hash of the row before it (64 zeros for the first)
// and carries the sha256 of exactly its own fields, so a changed, removed or inserted row breaks the
// chain (checked from the first row at start-up, step 6d). Who may write which action is decided by
// the three files allowed to import this one (architecture rule): repo-audit.ts (engine rows),
// repo-owner.ts (the owner's commands) and repo-server.ts (the owner at the server); the database
// itself ties each action's prefix to its actor.
import { createHash } from 'node:crypto';
import { codeParam, hex64Cell, intCell, intParam, jsonParam, msParam } from './codec.ts';
import { MAX_AUDIT_ID, expectChanges } from './repo-util.ts';
import { StorageError, type Tx } from './sqlite.ts';

export const AUDIT_GENESIS = '0'.repeat(64);
export type AuditActor = 'owner-telegram' | 'owner-server' | 'engine' | 'ai';
/** Plain data only: jsonParam checks it (no getters, no class instances, no secrets) when it is written. */
export type AuditDetail = Readonly<Record<string, unknown>>;

const NEWEST = 'SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1';
const INSERT = 'INSERT INTO audit_log (id, at, actor, action, detail_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)';

/** sha256 of the row's fields, one per line after a version tag (none of them can hold a line break). */
export function auditHash(prevHash: string, id: number, at: number, actor: string, action: string, detailJson: string): string {
  return createHash('sha256').update(`fomo-audit-v1\n${prevHash}\n${id}\n${at}\n${actor}\n${action}\n${detailJson}`, 'utf8').digest('hex');
}

/** Appends one row in order and returns its id. The caller has checked the action against its own list. */
export function appendAuditRow(tx: Tx, at: number, actor: AuditActor, action: string, detail: AuditDetail): number {
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) {
    throw new StorageError('bad-param', 'expected an audit detail that is a plain object');
  }
  const atParam = msParam(at);
  const actorCode = codeParam(actor);
  const actionCode = codeParam(action);
  const detailJson = jsonParam(detail);
  const newest = tx.get(NEWEST);
  const id = newest === undefined ? 1 : intCell(newest, 'id', 1, MAX_AUDIT_ID - 1) + 1;
  const prevHash = newest === undefined ? AUDIT_GENESIS : hex64Cell(newest, 'hash');
  const hash = auditHash(prevHash, id, at, actorCode, actionCode, detailJson);
  expectChanges(tx.run(INSERT, intParam(id), atParam, actorCode, actionCode, detailJson, prevHash, hash), 1, 'the audit row');
  return id;
}
