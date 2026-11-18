// The config versions and the waiting loosenings, as the engine reads them, and the two writes the
// engine may make itself (STORAGE_DESIGN.md s.3.4 and s.14; ARCHITECTURE.md s.7). Reads come back as
// stored, typed and frozen, for config/changes.ts to check and decode (storage cannot import the
// config module at runtime). Version 1 is required, never a default (contract 1): only the owner's
// setup at the server writes it (repo-server.ts). The owner's commands write versions and pending
// rows with the owner's audit row first (repo-owner.ts, which the engine cannot import). The engine
// may only apply a due loosening exactly as the owner queued it, or drop a due one, each with its
// own audit row first; storage re-checks the step, so a bug in the engine can never write a version
// the owner did not ask for, nor apply one early.
import type { ConfigVersion } from '../config/changes.ts';
import { holds, isConfigPath, treeOf, withAmount } from './config-tree.ts';
import { intCell, intParam, jsonCell, jsonParam, lamportsCell, msCell, msParam } from './codec.ts';
import { appendEngineAudit } from './repo-audit.ts';
import { cellOneOf, expectChanges, required } from './repo-util.ts';
import { StorageError, type Reader, type Row, type Tx } from './sqlite.ts';

export const CONFIG_AUTHORS = Object.freeze(['default', 'owner', 'ai-approved', 'rollback'] as const);
export type ConfigAuthor = (typeof CONFIG_AUTHORS)[number];
export const CHANGE_SOURCES = Object.freeze(['owner', 'ai-approved', 'rollback'] as const);
export type ChangeSource = (typeof CHANGE_SOURCES)[number];

/** One config version as stored; config/changes.ts checks the history and decodeTunables reads the values. */
export interface StoredVersion {
  readonly id: number;
  readonly createdAt: number;
  readonly author: ConfigAuthor;
  /** The exact stored text, in jsonParam's form (lamports as decimal text). */
  readonly valuesJson: string;
  readonly changed: readonly string[];
  readonly undoTo: number | null;
}

/** One waiting loosening as stored; the config module converts the amounts to its tunable's kind. */
export interface StoredPending {
  readonly path: string;
  readonly from: bigint;
  readonly to: bigint;
  readonly source: ChangeSource;
  readonly requestedAt: number;
  readonly applyAt: number;
}

const MAX_VERSION = Number.MAX_SAFE_INTEGER;
const HISTORY = 'SELECT id, created_at, author, values_json, changed_json, undo_to FROM config_versions ORDER BY id';
const ACTIVE = 'SELECT id, created_at, author, values_json, changed_json, undo_to FROM config_versions ORDER BY id DESC LIMIT 1';
const PENDING = 'SELECT path, from_value, to_value, source, requested_at, apply_at FROM pending_changes ORDER BY path';
const PENDING_ONE = 'SELECT path, from_value, to_value, source, requested_at, apply_at FROM pending_changes WHERE path = ?';
const INSERT_VERSION = 'INSERT INTO config_versions (id, created_at, author, values_json, changed_json, undo_to) VALUES (?, ?, ?, ?, ?, ?)';
const DELETE_PENDING = 'DELETE FROM pending_changes WHERE path = ?';

function versionOf(r: Row): StoredVersion {
  const values = jsonCell(r, 'values_json'); // read back only in jsonParam's exact form
  const text = r['values_json'];
  if (typeof text !== 'string' || typeof values !== 'object' || values === null || Array.isArray(values)) {
    throw new StorageError('bad-cell', 'column values_json does not hold the tunables');
  }
  const changed = jsonCell(r, 'changed_json');
  if (!Array.isArray(changed) || !changed.every(isConfigPath)) {
    throw new StorageError('bad-cell', 'column changed_json does not hold a list of tunable names');
  }
  return Object.freeze({
    id: intCell(r, 'id', 1, MAX_VERSION),
    createdAt: msCell(r, 'created_at'),
    author: cellOneOf(r, 'author', CONFIG_AUTHORS),
    valuesJson: text,
    changed: Object.freeze([...(changed as readonly string[])]),
    undoTo: r['undo_to'] === null ? null : intCell(r, 'undo_to', 1, MAX_VERSION),
  });
}

function pendingOf(r: Row): StoredPending {
  const path = r['path'];
  if (!isConfigPath(path)) {
    throw new StorageError('bad-cell', 'column path does not hold a tunable name');
  }
  return Object.freeze({
    path,
    from: lamportsCell(r, 'from_value'),
    to: lamportsCell(r, 'to_value'),
    source: cellOneOf(r, 'source', CHANGE_SOURCES),
    requestedAt: msCell(r, 'requested_at'),
    applyAt: msCell(r, 'apply_at'),
  });
}

const missingVersion = 'config version 1 (the owner\'s setup at the server writes it)';

/** Every version, oldest first, ids 1, 2, 3 without a gap; version 1 is required. */
export function readConfigHistory(r: Reader): readonly StoredVersion[] {
  const versions = r.all(HISTORY).map(versionOf);
  if (versions.length === 0) {
    throw new StorageError('row-missing', `${missingVersion} is missing`);
  }
  versions.forEach((v, i) => {
    if (v.id !== i + 1) {
      throw new StorageError('bad-cell', `config version ${v.id} follows version ${i}: a version is missing`);
    }
  });
  return Object.freeze(versions);
}

/** Every waiting loosening, by tunable name. */
export function readPendingChanges(r: Reader): readonly StoredPending[] {
  return Object.freeze(r.all(PENDING).map(pendingOf));
}

const pathParam = (path: unknown): string => {
  if (!isConfigPath(path)) {
    throw new StorageError('bad-param', 'expected a tunable name (group.name)');
  }
  return path;
};

/** The pending row of a tunable, due at `now` (a row that is not due yet is refused). */
function duePending(tx: Tx, path: string, now: number): StoredPending {
  const row = pendingOf(required(tx.get(PENDING_ONE, path), `the pending change of ${path}`));
  if (row.applyAt > now) {
    throw new StorageError('bad-param', `the pending change of ${path} is not due yet`);
  }
  return row;
}

/**
 * A due loosening, applied: the version after the active one that differs from it only at the
 * pending row's tunable, by exactly the queued value, written by the row's source and undoing to the
 * active version; the row is deleted and the engine's audit row comes first. Anything else is
 * refused before any write. A row whose tunable no longer holds the value it was made from is stale:
 * the engine drops it instead. Returns the new version's id.
 */
export function applyDueStep(tx: Tx, now: number, version: ConfigVersion): number {
  msParam(now);
  const { id, createdAt, author, values, changed, undoTo } = version;
  const created = msParam(createdAt);
  const changedJson = jsonParam(changed);
  const tree = treeOf(values, 'bad-param');
  if (!Array.isArray(changed) || changed.length !== 1) {
    throw new StorageError('bad-param', 'a due step changes exactly one tunable');
  }
  const path = pathParam(changed[0]);
  const row = duePending(tx, path, now);
  if (author !== row.source) {
    throw new StorageError('bad-param', 'a due step is written by the source of its pending change');
  }
  const active = versionOf(required(tx.get(ACTIVE), missingVersion));
  if (id !== active.id + 1 || undoTo !== active.id) {
    throw new StorageError('bad-param', 'a due step is the next version, and undoes to the active one');
  }
  // never older than the active version, never later than now (review R, risk 3 and security 2)
  if (createdAt < active.createdAt || createdAt > Math.max(now, active.createdAt)) {
    throw new StorageError('bad-param', 'a due step is dated no earlier than the active version and no later than now');
  }
  const activeTree = treeOf(JSON.parse(active.valuesJson), 'bad-cell');
  if (!holds(activeTree, path, row.from)) {
    throw new StorageError('bad-param', `${path} no longer holds the value its pending change was made from (stale: drop it)`);
  }
  // the whole stored text must be the active one with that one value moved: nothing else can differ
  const expected = withAmount(activeTree, path, row.to);
  if (expected === null || jsonParam(tree) !== jsonParam(expected)) {
    throw new StorageError('bad-param', 'a due step changes only its tunable, to exactly the queued value');
  }
  appendEngineAudit(tx, now, 'engine:apply-due', { path, version: id });
  expectChanges(tx.run(INSERT_VERSION, intParam(id), created, author, jsonParam(tree), changedJson, intParam(active.id)), 1, 'the due version');
  expectChanges(tx.run(DELETE_PENDING, path), 1, 'the applied pending change');
  return id;
}

/**
 * A due pending row that can no longer apply (its value is stale or out of bounds), dropped with the
 * engine's audit row first: a waiting loosening that is not applied keeps the config as strict as it
 * is. A row that is not due yet stays (the owner's /cancel removes it).
 */
export function dropDuePending(tx: Tx, now: number, path: string): void {
  msParam(now);
  const checked = pathParam(path);
  duePending(tx, checked, now);
  appendEngineAudit(tx, now, 'engine:drop-pending', { path: checked });
  expectChanges(tx.run(DELETE_PENDING, checked), 1, 'the dropped pending change');
}
