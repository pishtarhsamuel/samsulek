// The schema upgrade runner (STORAGE_DESIGN.md s.1.3). Forward only, never a down migration:
// - an empty file is a new database; tables without schema_migrations are another program's file;
// - an applied migration whose name or sha256 changed, or a database newer than this code, stops
//   the bot (the owner restores or upgrades by hand);
// - before pending migrations run on a database with data: quick_check and foreign_key_check, then
//   a consistent copy (VACUUM INTO, owner-only, named without colons so it works on Windows);
// - each migration runs in its own transaction with its schema_migrations row; inside it the
//   version is read again, so a second runner at the same moment stops instead of applying twice;
// - the checks run again at the end.
// The version table belongs to the runner (it is created with migration 1, in its transaction) and
// never changes once released: its SQL is pinned by sha256 in a test.
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { isTimestamp } from '../core/time.ts';
import { code, codeCell, codeParam, hex64, hex64Cell, hex64Param, intCell, intParam, isCodeText, ms, msParam } from './codec.ts';
import { StorageError, type Db } from './sqlite.ts';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export interface MigrateOptions {
  readonly now: () => number;
  readonly backupDir: string | null; // an existing absolute folder; null only for ':memory:'
  readonly nodeVersion: string; // process.version, e.g. "v26.13.0"
  /**
   * true only for the owner's one-time setup: a database without a schema may then get one. A
   * normal start passes false, so the wrong or an empty file is refused instead of quietly
   * becoming a new, empty ledger (no positions, no halts, no peak) (risk-guardian, review O).
   */
  readonly allowFresh: boolean;
}

export interface MigrateResult {
  readonly from: number;
  readonly to: number;
  readonly backup: string | null; // the copy made before the first pending migration, if any
}

/** The bot's migrations, 1..N in order, frozen. Migration 1 (the step 6 schema) arrives in step 6c. */
export const MIGRATIONS: readonly Migration[] = Object.freeze([]);

export const VERSION_TABLE_SQL: string = [
  'CREATE TABLE schema_migrations (',
  '  version INTEGER PRIMARY KEY CHECK (version >= 1),',
  `  name TEXT NOT NULL CHECK ${code('name')},`,
  `  sha256 TEXT NOT NULL CHECK ${hex64('sha256')},`,
  `  applied_at INTEGER NOT NULL CHECK ${ms('applied_at')},`,
  `  node_version TEXT NOT NULL CHECK ${code('node_version')},`,
  `  sqlite_version TEXT NOT NULL CHECK ${code('sqlite_version')}`,
  ') STRICT;',
  'CREATE TRIGGER schema_migrations_in_order BEFORE INSERT ON schema_migrations',
  '  WHEN NEW.version <> (SELECT COALESCE(MAX(version), 0) + 1 FROM schema_migrations)',
  "  BEGIN SELECT RAISE(ABORT, 'schema migration out of order'); END;",
  'CREATE TRIGGER schema_migrations_no_update BEFORE UPDATE ON schema_migrations',
  "  BEGIN SELECT RAISE(ABORT, 'schema migrations are never changed'); END;",
  'CREATE TRIGGER schema_migrations_no_delete BEFORE DELETE ON schema_migrations',
  "  BEGIN SELECT RAISE(ABORT, 'schema migrations are never deleted'); END;",
  '',
].join('\n');

const MIGRATION_SQL = /^[\t\n\x20-\x7e]+$/;
const badOption = (detail: string): StorageError => new StorageError('bad-option', detail);
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function checkList(list: unknown): readonly Migration[] {
  if (!Array.isArray(list)) {
    throw badOption('migrations must be a list');
  }
  list.forEach((m: unknown, i) => {
    const entry = (typeof m === 'object' && m !== null ? m : {}) as Partial<Migration>;
    const ok = entry.version === i + 1 && isCodeText(entry.name) && typeof entry.sql === 'string' && MIGRATION_SQL.test(entry.sql);
    if (!ok) {
      throw badOption(`migration ${i + 1}: versions run 1..N in order, names are codes, SQL is non-empty ASCII with LF line ends`);
    }
  });
  return list as readonly Migration[];
}

function isFolder(dir: unknown): dir is string {
  return typeof dir === 'string' && path.isAbsolute(dir) && existsSync(dir) && statSync(dir).isDirectory();
}

function checkOptions(db: Db, options: MigrateOptions): void {
  if (typeof options !== 'object' || options === null || typeof options.now !== 'function') {
    throw badOption('migrate needs { now, backupDir, nodeVersion }');
  }
  if (!isCodeText(options.nodeVersion)) {
    throw badOption('nodeVersion must look like v26.13.0');
  }
  if (typeof options.allowFresh !== 'boolean') {
    throw badOption('allowFresh must be true or false');
  }
  if (db.file === ':memory:' ? options.backupDir !== null : !isFolder(options.backupDir)) {
    throw badOption("the copy folder must be an existing absolute folder (and null for ':memory:')");
  }
}

interface Applied {
  readonly version: number;
  readonly name: string;
  readonly sha256: string;
}

const HAS_VERSION_TABLE = "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'";

function appliedOf(db: Db): readonly Applied[] {
  if (db.get(HAS_VERSION_TABLE)?.['n'] === 0n) {
    if (db.get('SELECT count(*) AS n FROM sqlite_schema')?.['n'] !== 0n) {
      throw new StorageError('foreign-file', 'the database has tables but no schema_migrations table');
    }
    return [];
  }
  const rows = db.all('SELECT version, name, sha256 FROM schema_migrations ORDER BY version');
  const applied = rows.map((r, i) => {
    const version = intCell(r, 'version', 1, Number.MAX_SAFE_INTEGER);
    if (version !== i + 1) {
      throw new StorageError('schema-broken', 'the versions in schema_migrations are not 1..N');
    }
    return { version, name: codeCell(r, 'name'), sha256: hex64Cell(r, 'sha256') };
  });
  if (applied.length === 0) {
    throw new StorageError('schema-broken', 'schema_migrations is empty');
  }
  return applied;
}

function checkHealth(db: Db): void {
  const problems = [...db.quickCheck(), ...db.foreignKeyCheck()];
  if (problems.length > 0) {
    throw new StorageError('corrupt', `the database is not healthy: ${problems.slice(0, 3).join('; ')}`);
  }
}

/** "20261113T123045Z": UTC, whole seconds, no colons (Windows file names). */
function stamp(at: number): string {
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll('-', '').replaceAll(':', '');
}

function apply(db: Db, m: Migration, at: number, nodeVersion: string): void {
  try {
    db.transaction((tx) => {
      const current = tx.get(HAS_VERSION_TABLE)?.['n'] === 0n ? 0n : tx.get('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations')?.['v'];
      if (current !== BigInt(m.version - 1)) {
        throw new StorageError('schema-broken', 'another process changed the schema version at the same time');
      }
      if (m.version === 1) {
        tx.script(VERSION_TABLE_SQL);
      }
      tx.script(m.sql);
      const sqliteVersion = codeParam(String(tx.get('SELECT sqlite_version() AS v')?.['v']));
      return tx.run(
        'INSERT INTO schema_migrations (version, name, sha256, applied_at, node_version, sqlite_version) VALUES (?, ?, ?, ?, ?, ?)',
        intParam(m.version),
        codeParam(m.name),
        hex64Param(sha256(m.sql)),
        msParam(at),
        codeParam(nodeVersion),
        sqliteVersion,
      );
    });
  } catch (e) {
    if (e instanceof StorageError) {
      throw new StorageError(e.code, `migration ${m.version} ${m.name}: ${e.detail}`, e.sqliteCode);
    }
    throw e;
  }
}

/** Brings the database to the last version of `migrations`; the bot calls migrate() with its own list. */
export function migrateWith(db: Db, migrations: readonly Migration[], options: MigrateOptions): MigrateResult {
  const list = checkList(migrations);
  checkOptions(db, options);
  const applied = appliedOf(db);
  const from = applied.length;
  const to = list.length;
  if (from > to) {
    throw new StorageError('schema-newer', `the database is at version ${from} but this code knows only ${to}: run the newer code or restore a copy`);
  }
  for (const row of applied) {
    const m = list[row.version - 1] as Migration;
    if (m.name !== row.name || sha256(m.sql) !== row.sha256) {
      throw new StorageError('schema-edited', `migration ${row.version} ${row.name} was changed after it ran`);
    }
  }
  if (from === to) {
    return { from, to, backup: null };
  }
  if (from === 0 && !options.allowFresh) {
    throw new StorageError('missing', "the database has no schema: only the owner's one-time setup may create one");
  }
  if (db.readOnly) {
    throw new StorageError('readonly', 'migrations need a writable handle');
  }
  const at = options.now();
  if (!isTimestamp(at)) {
    throw badOption('the clock gave an invalid time');
  }
  let backup: string | null = null;
  if (from > 0) {
    checkHealth(db);
    if (options.backupDir !== null) {
      backup = path.join(options.backupDir, `pre-migration-v${from}-v${to}-${stamp(at)}.sqlite`);
      db.vacuumInto(backup);
    }
  }
  for (const m of list.slice(from)) {
    apply(db, m, at, options.nodeVersion);
  }
  checkHealth(db);
  return { from, to, backup };
}

export function migrate(db: Db, options: MigrateOptions): MigrateResult {
  return migrateWith(db, MIGRATIONS, options);
}
