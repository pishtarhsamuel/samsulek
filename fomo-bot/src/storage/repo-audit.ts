// The audit log as the engine sees it (STORAGE_DESIGN.md s.1 and s.12; reviews P): it writes engine
// rows only, from a fixed list, and it reads the newest id and checks the whole chain (step 6d does
// that at start-up). The owner's rows come only from repo-owner.ts and the server's from
// repo-server.ts, which the engine may not import (architecture rule).
import { AUDIT_GENESIS, appendAuditRow, auditHash, type AuditDetail } from './audit-chain.ts';
import { codeCell, hex64Cell, intCell, jsonCell, jsonParam, msCell } from './codec.ts';
import { MAX_AUDIT_ID, cellOneOf, oneOf, required } from './repo-util.ts';
import { StorageError, type Reader, type Tx } from './sqlite.ts';

/** What the engine records: KILL and halts it sets, the due config steps it applies or drops on its own, and a demotion. */
export const ENGINE_AUDIT_ACTIONS = Object.freeze(['engine:kill-set', 'engine:halt-set', 'engine:apply-due', 'engine:drop-pending', 'engine:demote'] as const);
export type EngineAuditAction = (typeof ENGINE_AUDIT_ACTIONS)[number];

export function appendEngineAudit(tx: Tx, at: number, action: EngineAuditAction, detail: AuditDetail = {}): number {
  return appendAuditRow(tx, at, 'engine', oneOf(action, ENGINE_AUDIT_ACTIONS, 'an engine audit action'), detail);
}

const NEWEST_ID = 'SELECT coalesce(max(id), 0) AS id FROM audit_log';
const ALL_ROWS = 'SELECT id, at, actor, action, detail_json, prev_hash, hash FROM audit_log ORDER BY id';
const ACTORS = Object.freeze(['owner-telegram', 'owner-server', 'engine', 'ai'] as const);

/** The id of the newest audit row; 0 before the first. */
export function newestAuditId(r: Reader): number {
  return intCell(required(r.get(NEWEST_ID), 'the newest audit id'), 'id', 0, MAX_AUDIT_ID);
}

export interface ChainCheck {
  readonly rows: number;
  readonly newestId: number;
  readonly newestHash: string;
  /** When the newest row was written; null before the first (the boot compares the clock with it). */
  readonly newestAt: number | null;
}

/** One audit row as stored (the boot checks the anchor and the KILL and halt links with it). */
export interface AuditRow {
  readonly id: number;
  readonly at: number;
  readonly actor: (typeof ACTORS)[number];
  readonly action: string;
  readonly detail: unknown;
  readonly hash: string;
}

const ONE_ROW = 'SELECT id, at, actor, action, detail_json, hash FROM audit_log WHERE id = ?';

/** The row with this id, or null when the log has none (step 6d-3, the boot). */
export function readAuditRow(r: Reader, id: number): AuditRow | null {
  if (!Number.isSafeInteger(id) || id < 1 || id > MAX_AUDIT_ID) {
    throw new StorageError('bad-param', `expected an audit id from 1 to ${MAX_AUDIT_ID}`);
  }
  const row = r.get(ONE_ROW, BigInt(id));
  if (row === undefined) {
    return null;
  }
  return Object.freeze({
    id: intCell(row, 'id', 1, MAX_AUDIT_ID),
    at: msCell(row, 'at'),
    actor: cellOneOf(row, 'actor', ACTORS),
    action: codeCell(row, 'action'),
    detail: jsonCell(row, 'detail_json'), // frozen all the way down by jsonCell, so a reader cannot change it
    hash: hex64Cell(row, 'hash'),
  });
}

const broken = (detail: string): StorageError => new StorageError('audit-broken', detail);

/**
 * Reads every row from the first and checks that the ids run 1, 2, 3, that each row names the hash
 * of the row before it, and that each hash is that of the row's own fields. A failure names the row,
 * never a stored value.
 */
export function verifyAuditChain(r: Reader): ChainCheck {
  const rows = r.all(ALL_ROWS);
  let prev = AUDIT_GENESIS;
  let last = 0;
  let lastAt: number | null = null;
  for (const row of rows) {
    const id = intCell(row, 'id', 1, MAX_AUDIT_ID);
    if (id !== last + 1) {
      throw broken(last === 0 ? `row ${id} is the first row, and ids start at 1` : `row ${id} follows row ${last}: a row is missing`);
    }
    const at = msCell(row, 'at');
    const actor = cellOneOf(row, 'actor', ACTORS);
    const action = codeCell(row, 'action');
    const detailJson = jsonParam(jsonCell(row, 'detail_json')); // jsonCell takes back only jsonParam's own text
    const prevHash = hex64Cell(row, 'prev_hash');
    const hash = hex64Cell(row, 'hash');
    if (prevHash !== prev) {
      throw broken(`row ${id} does not name the hash of the row before it`);
    }
    if (auditHash(prevHash, id, at, actor, action, detailJson) !== hash) {
      throw broken(`row ${id} does not match its own hash`);
    }
    prev = hash;
    last = id;
    lastAt = at;
  }
  return Object.freeze({ rows: rows.length, newestId: last, newestHash: prev, newestAt: lastAt });
}
