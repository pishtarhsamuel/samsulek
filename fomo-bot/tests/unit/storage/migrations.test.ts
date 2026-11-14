// The schema upgrade runner (STORAGE_DESIGN.md s.1.3 and s.5): forward only, each migration in its
// own transaction together with its version row, a healthy-file check and a 0600 copy before any
// change, and a refusal to start on anything unexpected (an edited migration, a database newer than
// the code, tables of another program, a broken version table). Written before migrations.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readdirSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, VERSION_TABLE_SQL, migrate, migrateWith, type MigrateOptions, type Migration } from '../../../src/storage/migrations.ts';
import { openDb, type Db, type NotPromise, type SqlParam, type Tx } from '../../../src/storage/sqlite.ts';
import { RAW_OPTIONS, count, dump, fileDb, memDb, rawDb, removeDir, storageError, tempDir } from './helpers.ts';

const POSIX = process.platform !== 'win32';
const NOW = Date.UTC(2026, 10, 13, 12, 30, 45);
const M1: Migration = { version: 1, name: 'create-a', sql: 'CREATE TABLE a (id TEXT PRIMARY KEY) STRICT;' };
const M2: Migration = { version: 2, name: 'create-b', sql: "CREATE TABLE b (id TEXT PRIMARY KEY, a TEXT NOT NULL REFERENCES a (id)) STRICT;\nINSERT INTO a (id) VALUES ('seed');" };
const M3_BAD: Migration = { version: 3, name: 'broken', sql: "CREATE TABLE c (id TEXT PRIMARY KEY) STRICT;\nINSERT INTO c (id) VALUES ('x');\nCREATE TABLE a (id TEXT) STRICT;" };
const M3: Migration = { version: 3, name: 'create-c', sql: 'CREATE TABLE c (id TEXT PRIMARY KEY) STRICT;' };

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function options(backupDir: string | null, now = NOW, allowFresh = true): MigrateOptions {
  return { now: () => now, backupDir, nodeVersion: 'v26.13.0', allowFresh };
}

function inFile(fn: (db: Db, dir: string, file: string) => void): void {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'bot.sqlite');
    const db = fileDb(file);
    try {
      fn(db, dir, file);
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir); // even when a planted bug makes close throw (review O, risk note 10)
  }
}

function versions(db: Db): unknown[] {
  return db.all('SELECT version, name, sha256, applied_at, node_version, sqlite_version FROM schema_migrations ORDER BY version').map((r) => ({ ...r }));
}

function copiesIn(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe('migrate: forward only, recorded, checked', () => {
  it('a fresh database goes to the latest version in order, each one recorded with its checksum, Node and SQLite versions and the time', () => {
    inFile((db, dir) => {
      const result = migrateWith(db, [M1, M2], options(dir));
      assert.deepEqual(result, { from: 0, to: 2, backup: null }); // nothing to copy in an empty file
      const sqliteVersion = db.get('SELECT sqlite_version() AS v')?.['v'];
      assert.deepEqual(versions(db), [
        { version: 1n, name: 'create-a', sha256: sha256(M1.sql), applied_at: BigInt(NOW), node_version: 'v26.13.0', sqlite_version: sqliteVersion },
        { version: 2n, name: 'create-b', sha256: sha256(M2.sql), applied_at: BigInt(NOW), node_version: 'v26.13.0', sqlite_version: sqliteVersion },
      ]);
      assert.equal(count(db, 'a'), 1n);
      assert.equal(count(db, 'b'), 0n);
      assert.deepEqual(copiesIn(dir).filter((f) => f.startsWith('pre-migration')), []);
    });
  });

  it("a normal start never builds a fresh schema: without the owner's setup flag an empty database is refused (missing) and stays empty (review O)", () => {
    inFile((db, dir) => {
      const e = storageError(() => migrateWith(db, [M1, M2], options(dir, NOW, false)), 'missing');
      assert.match(e.detail, /setup/);
      assert.equal(db.get('SELECT count(*) AS n FROM sqlite_schema')?.['n'], 0n);
      // once set up, a normal start migrates as usual
      migrateWith(db, [M1], options(dir));
      assert.deepEqual(migrateWith(db, [M1, M2], options(dir, NOW, false)).to, 2);
      // and an empty list with no schema is nothing to do, not a refusal
      const mem = memDb();
      try {
        assert.deepEqual(migrateWith(mem, [], options(null, NOW, false)), { from: 0, to: 0, backup: null });
      } finally {
        mem.close();
      }
    });
  });

  it('the health check after migrating runs too: a file that turns bad during the migration is refused (corrupt)', () => {
    const mem = memDb();
    try {
      migrateWith(mem, [M1], options(null));
      let checks = 0;
      // the same handle, except that its quick_check finds a problem from the second call on (after migrating)
      const turning: Db = Object.freeze({
        file: mem.file,
        readOnly: mem.readOnly,
        get: (sql: string, ...p: SqlParam[]) => mem.get(sql, ...p),
        all: (sql: string, ...p: SqlParam[]) => mem.all(sql, ...p),
        transaction: <T,>(fn: (tx: Tx) => NotPromise<T>): NotPromise<T> => mem.transaction(fn),
        settings: () => mem.settings(),
        quickCheck: () => ((checks += 1) > 1 ? ['Tree 2 page 3: damaged'] : mem.quickCheck()),
        foreignKeyCheck: () => mem.foreignKeyCheck(),
        vacuumInto: (f: string) => mem.vacuumInto(f),
        close: () => mem.close(),
      });
      const e = storageError(() => migrateWith(turning, [M1, M2], options(null)), 'corrupt');
      assert.match(e.detail, /Tree 2 page 3/);
      assert.equal(checks, 2, 'checked before and after');
    } finally {
      mem.close();
    }
  });

  it('a second run is a no-op: same version, no copy, nothing changed', () => {
    inFile((db, dir) => {
      migrateWith(db, [M1, M2], options(dir));
      const before = dump(db);
      assert.deepEqual(migrateWith(db, [M1, M2], options(dir, NOW + 1_000)), { from: 2, to: 2, backup: null });
      assert.equal(dump(db), before);
      assert.deepEqual(copiesIn(dir).filter((f) => f.startsWith('pre-migration')), []);
    });
  });

  it('pending migrations on a database with data: a healthy-file check, then a 0600 copy named without colons, then the new versions', () => {
    inFile((db, dir) => {
      migrateWith(db, [M1], options(dir));
      db.transaction((tx) => tx.run("INSERT INTO a (id) VALUES ('mine')"));
      const before = dump(db);
      const result = migrateWith(db, [M1, M2, M3], options(dir));
      assert.equal(result.from, 1);
      assert.equal(result.to, 3);
      assert.ok(result.backup !== null);
      assert.equal(path.dirname(result.backup), dir);
      assert.equal(path.basename(result.backup), 'pre-migration-v1-v3-20261113T123045Z.sqlite');
      assert.doesNotMatch(path.basename(result.backup), /:/);
      if (POSIX) {
        assert.equal(statSync(result.backup).mode & 0o777, 0o600);
      }
      const copy = fileDb(result.backup, false);
      try {
        assert.equal(dump(copy), before, 'the copy is the database as it was before the migration');
      } finally {
        copy.close();
      }
      assert.deepEqual(versions(db).map((v) => (v as { version: bigint }).version), [1n, 2n, 3n]);
    });
  });

  it('a failing migration rolls back only itself: the earlier ones and the copy stay, the error names it, and a fixed list continues', () => {
    inFile((db, dir) => {
      migrateWith(db, [M1], options(dir));
      const e = storageError(() => migrateWith(db, [M1, M2, M3_BAD], options(dir)), 'other');
      assert.match(e.detail, /migration 3 broken/);
      assert.deepEqual(versions(db).map((v) => (v as { version: bigint }).version), [1n, 2n]);
      assert.equal(db.get("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'c'")?.['n'], 0n, 'nothing of migration 3 is left');
      assert.deepEqual(copiesIn(dir).filter((f) => f.startsWith('pre-migration')), ['pre-migration-v1-v3-20261113T123045Z.sqlite']);
      assert.deepEqual(migrateWith(db, [M1, M2, M3], options(dir, NOW + 1_000)), {
        from: 2,
        to: 3,
        backup: path.join(dir, 'pre-migration-v2-v3-20261113T123046Z.sqlite'),
      });
    });
  });

  it('an applied migration whose text or name changed is refused (schema-edited): nothing runs, no copy is made', () => {
    inFile((db, dir) => {
      migrateWith(db, [M1, M2], options(dir));
      const before = dump(db);
      storageError(() => migrateWith(db, [{ ...M1, sql: `${M1.sql}\n` }, M2, M3], options(dir)), 'schema-edited');
      storageError(() => migrateWith(db, [{ ...M1, name: 'renamed' }, M2], options(dir)), 'schema-edited');
      assert.equal(dump(db), before);
      assert.deepEqual(copiesIn(dir).filter((f) => f.startsWith('pre-migration')), []);
    });
  });

  it('two runners at once: the one that finds the version moved inside its own transaction stops (schema-broken) and applies nothing twice', () => {
    inFile((a, dir, file) => {
      const b = fileDb(file, false);
      try {
        // b migrates while a is between reading the versions and applying (a's clock call is that moment)
        const late = { ...options(dir), now: () => (migrateWith(b, [M1, M2], options(dir)), NOW) };
        const e = storageError(() => migrateWith(a, [M1, M2], late), 'schema-broken');
        assert.match(e.detail, /migration 1 create-a/);
        assert.deepEqual(versions(a).map((v) => (v as { version: bigint }).version), [1n, 2n]);
        assert.equal(count(a, 'a'), 1n, 'the seed row of migration 2 exists once');
      } finally {
        b.close();
      }
    });
  });

  it('a database newer than the code is refused (schema-newer)', () => {
    inFile((db, dir) => {
      migrateWith(db, [M1, M2], options(dir));
      storageError(() => migrateWith(db, [M1], options(dir)), 'schema-newer');
      storageError(() => migrateWith(db, [], options(dir)), 'schema-newer');
    });
  });

  it('tables without the version table belong to someone else (foreign-file)', () => {
    inFile((db, dir) => {
      db.transaction((tx) => tx.script('CREATE TABLE notes (x TEXT) STRICT;'));
      storageError(() => migrateWith(db, [M1], options(dir)), 'foreign-file');
    });
  });

  it('a version table with a gap, or with no rows, is refused (schema-broken)', () => {
    inFile((db, dir, file) => {
      migrateWith(db, [M1, M2], options(dir));
      db.close();
      const raw = rawDb(file);
      raw.exec('DROP TRIGGER schema_migrations_no_delete');
      raw.exec('DELETE FROM schema_migrations WHERE version = 1');
      raw.close();
      const gap = fileDb(file, false);
      try {
        assert.match(storageError(() => migrateWith(gap, [M1, M2], options(dir)), 'schema-broken').detail, /not 1\.\.N/);
        assert.match(storageError(() => migrateWith(gap, [M1, M2, M3], options(dir)), 'schema-broken').detail, /not 1\.\.N/);
      } finally {
        gap.close();
      }
      const raw2 = rawDb(file);
      raw2.exec('DELETE FROM schema_migrations');
      raw2.close();
      const empty = fileDb(file, false);
      try {
        assert.match(storageError(() => migrateWith(empty, [M1, M2], options(dir)), 'schema-broken').detail, /empty/);
      } finally {
        empty.close();
      }
    });
  });

  it('a damaged file or a missing foreign-key parent is refused before anything changes (corrupt), and no copy is made', () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, 'bot.sqlite');
      const db = fileDb(file);
      migrateWith(db, [M1, M2], options(dir));
      db.close();
      const raw = new DatabaseSync(file, { ...RAW_OPTIONS, enableForeignKeyConstraints: false });
      raw.exec("INSERT INTO b (id, a) VALUES ('orphan', 'nobody')");
      raw.close();
      const orphan = fileDb(file, false);
      try {
        const e = storageError(() => migrateWith(orphan, [M1, M2, M3], options(dir)), 'corrupt');
        assert.match(e.detail, /b: row 1 has no parent in a/);
        assert.deepEqual(versions(orphan).length, 2);
      } finally {
        orphan.close();
      }
      // a damaged page
      const big = path.join(dir, 'big.sqlite');
      const bigDb = fileDb(big);
      migrateWith(bigDb, [M1], options(dir));
      for (let i = 0; i < 300; i += 1) {
        bigDb.transaction((tx) => tx.run('INSERT INTO a (id) VALUES (?)', `${'k'.repeat(200)}${i}`));
      }
      bigDb.close();
      const fd = openSync(big, 'r+');
      writeSync(fd, Buffer.alloc(512, 0xee), 0, 512, 4096 * 7 + 2000);
      closeSync(fd);
      const damaged = fileDb(big, false);
      try {
        const e = storageError(() => migrateWith(damaged, [M1, M2], options(dir)), 'corrupt');
        assert.match(e.detail, /page|malformed/);
      } finally {
        damaged.close();
      }
      assert.deepEqual(copiesIn(dir).filter((f) => f.startsWith('pre-migration')), []);
    } finally {
      removeDir(dir);
    }
  });

  it("the copy folder must be an existing absolute folder; ':memory:' takes none and a file needs one (bad-option)", () => {
    inFile((db, dir) => {
      migrateWith(db, [M1], options(dir));
      storageError(() => migrateWith(db, [M1, M2], options(null)), 'bad-option');
      storageError(() => migrateWith(db, [M1, M2], options('relative/folder')), 'bad-option');
      storageError(() => migrateWith(db, [M1, M2], options(path.join(dir, 'missing'))), 'bad-option');
      storageError(() => migrateWith(db, [M1, M2], options(path.join(dir, 'bot.sqlite'))), 'bad-option');
      assert.equal(versions(db).length, 1);
    });
    const mem = memDb();
    try {
      storageError(() => migrateWith(mem, [M1], options('/tmp')), 'bad-option');
      assert.deepEqual(migrateWith(mem, [M1, M2], options(null)), { from: 0, to: 2, backup: null });
      assert.deepEqual(migrateWith(mem, [M1, M2, M3], options(null)), { from: 2, to: 3, backup: null });
    } finally {
      mem.close();
    }
  });

  it('the clock and the Node version are checked (bad-option), and a read-only handle cannot migrate (readonly)', () => {
    const mem = memDb();
    try {
      for (const now of [Number.NaN, -1, 1.5, 8e12]) {
        storageError(() => migrateWith(mem, [M1], options(null, now)), 'bad-option');
      }
      for (const nodeVersion of ['', 'V26', 'v26 13', 'x'.repeat(65)]) {
        storageError(() => migrateWith(mem, [M1], { ...options(null), nodeVersion }), 'bad-option');
      }
      const good = options(null);
      for (const bad of [undefined, null, { ...good, now: undefined }, { ...good, now: NOW }, { ...good, allowFresh: undefined }, { ...good, allowFresh: 'yes' }]) {
        storageError(() => migrateWith(mem, [M1], bad as unknown as MigrateOptions), 'bad-option');
      }
      assert.equal(mem.get("SELECT count(*) AS n FROM sqlite_schema")?.['n'], 0n);
    } finally {
      mem.close();
    }
    const dir = tempDir();
    try {
      const file = path.join(dir, 'bot.sqlite');
      const db = fileDb(file);
      migrateWith(db, [M1], options(dir));
      db.close();
      const ro = openDb(file, { busyTimeoutMs: 100, create: false, readOnly: true });
      try {
        assert.deepEqual(migrateWith(ro, [M1], options(dir)), { from: 1, to: 1, backup: null }); // checking needs no write
        storageError(() => migrateWith(ro, [M1, M2], options(dir)), 'readonly');
        assert.deepEqual(copiesIn(dir).filter((f) => f.startsWith('pre-migration')), [], 'refused before any copy is made');
      } finally {
        ro.close();
      }
    } finally {
      removeDir(dir);
    }
  });

  it('the list itself is checked: versions 1..N in order, code names, non-empty ASCII text with LF only (bad-option)', () => {
    const mem = memDb();
    try {
      const bad: Migration[][] = [
        [M2],
        [M1, M3],
        [M1, M1],
        [{ ...M1, version: 0 }],
        [{ ...M1, version: 1.5 }],
        [{ ...M1, name: 'Create A' }],
        [{ ...M1, name: '' }],
        [{ ...M1, sql: '' }],
        [{ ...M1, sql: 'CREATE TABLE a (id TEXT) STRICT;\r\n' }],
        [{ ...M1, sql: "CREATE TABLE a (id TEXT DEFAULT 'é') STRICT;" }],
        [{ ...M1, sql: 7 as unknown as string }],
        [null as unknown as Migration],
      ];
      for (const list of bad) {
        storageError(() => migrateWith(mem, list, options(null)), 'bad-option');
      }
      storageError(() => migrateWith(mem, 'x' as unknown as Migration[], options(null)), 'bad-option');
      assert.equal(mem.get("SELECT count(*) AS n FROM sqlite_schema")?.['n'], 0n);
    } finally {
      mem.close();
    }
  });
});

describe('the migrations of the bot', () => {
  it('MIGRATIONS is frozen, valid, LF-only, and migrate() applies it to a fresh database', () => {
    assert.ok(Object.isFrozen(MIGRATIONS));
    for (const m of MIGRATIONS) {
      assert.ok(Object.isFrozen(m));
      assert.doesNotMatch(m.sql, /\r/);
    }
    const mem = memDb();
    try {
      const result = migrate(mem, options(null));
      assert.deepEqual(result, { from: 0, to: MIGRATIONS.length, backup: null });
      assert.deepEqual(migrate(mem, options(null)), { from: MIGRATIONS.length, to: MIGRATIONS.length, backup: null });
    } finally {
      mem.close();
    }
  });

  it('the version table never changes once released: its SQL is pinned by sha256', () => {
    assert.doesNotMatch(VERSION_TABLE_SQL, /\r/);
    assert.equal(sha256(VERSION_TABLE_SQL), 'e74dddd168d5fe818c52787f501e947d7a0a9b9da8565d41fe7e13f35d1ba5fb');
  });

  it('the version table refuses rows out of order, edits and deletions (database tripwires)', () => {
    const mem = memDb();
    try {
      migrateWith(mem, [M1], options(null));
      const row = ['create-x', 'ab'.repeat(32), BigInt(NOW), 'v26.13.0', '3.54.0'];
      storageError(
        () => mem.transaction((tx) => tx.run('INSERT INTO schema_migrations (version, name, sha256, applied_at, node_version, sqlite_version) VALUES (3, ?, ?, ?, ?, ?)', ...row)),
        'constraint',
      );
      storageError(() => mem.transaction((tx) => tx.run("UPDATE schema_migrations SET name = 'other'")), 'constraint');
      storageError(() => mem.transaction((tx) => tx.run('DELETE FROM schema_migrations')), 'constraint');
      storageError(
        () => mem.transaction((tx) => tx.run('INSERT INTO schema_migrations (version, name, sha256, applied_at, node_version, sqlite_version) VALUES (2, ?, ?, ?, ?, ?)', 'Bad Name', ...row.slice(1))),
        'constraint',
      );
      assert.equal(count(mem, 'schema_migrations'), 1n);
    } finally {
      mem.close();
    }
  });
});
