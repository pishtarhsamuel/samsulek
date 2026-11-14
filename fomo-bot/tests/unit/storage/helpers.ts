// Shared helpers for the storage tests (STORAGE_DESIGN.md s.5): temporary folders outside the
// project, a logical dump to prove a rollback left nothing behind, and raw node:sqlite handles for
// the cases the wrapper must refuse or survive (a foreign file, a full disk, a failing ROLLBACK).
// Only tests may open node:sqlite directly; in src/ only storage/sqlite.ts may (architecture rule).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StorageError, openDb, type Db, type StorageErrorCode } from '../../../src/storage/sqlite.ts';

export const TEST_TIMEOUT_MS = 100;

/** A new empty folder under the system temp folder, never under fomo-bot/data/. */
export function tempDir(prefix = 'fomo-db-'): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** Windows keeps a file busy for a moment after close, so removal retries (EBUSY). */
export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

export function memDb(): Db {
  return openDb(':memory:', { busyTimeoutMs: TEST_TIMEOUT_MS, create: true });
}

export function fileDb(file: string, create = true): Db {
  return openDb(file, { busyTimeoutMs: TEST_TIMEOUT_MS, create });
}

/** The options the bot's own handle uses, for raw handles that must behave the same. */
export const RAW_OPTIONS = {
  timeout: TEST_TIMEOUT_MS,
  readBigInts: true,
  enableForeignKeyConstraints: true,
  defensive: true,
  allowExtension: false,
} as const;

export function rawDb(file: string, options: { readonly readOnly?: boolean } = {}): DatabaseSync {
  return new DatabaseSync(file, { ...RAW_OPTIONS, ...options });
}

const bigintText = (_key: string, value: unknown): unknown => (typeof value === 'bigint' ? `${value}n` : value);

/** Every schema object and every row of every table, in a stable order: equal dumps mean equal databases. */
export function dump(db: Db): string {
  const schema = db.all("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name");
  const tables = db.all("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name");
  const rows = tables.map((t) => {
    const name = String(t['name']);
    return [name, db.all(`SELECT * FROM "${name}" ORDER BY rowid`)];
  });
  return JSON.stringify({ schema, rows }, bigintText);
}

/** Runs fn, expects a StorageError with this code, and returns it for more checks. */
export function storageError(fn: () => unknown, code: StorageErrorCode): StorageError {
  let caught: unknown = null;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof StorageError, `expected a StorageError "${code}", got ${String(caught)}`);
  assert.equal(caught.code, code, `expected "${code}", got "${caught.code}": ${caught.detail}`);
  return caught;
}

export function count(db: Db, table: string): bigint {
  const row = db.get(`SELECT count(*) AS n FROM "${table}"`);
  assert.ok(row !== undefined && typeof row['n'] === 'bigint');
  return row['n'];
}
