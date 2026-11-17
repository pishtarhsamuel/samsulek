// The database wrapper (STORAGE_DESIGN.md s.1.1 and s.5; facts in VERIFIED_FACTS.md, node:sqlite
// rows): the file is ours and set up the safe way, a transaction is all or nothing and synchronous,
// nothing float-like goes in or comes out, one constant statement per call, errors carry a code and
// SQLite's own text (never a bound value), and a handle whose ROLLBACK failed refuses everything.
// Written before src/storage/sqlite.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, constants } from 'node:sqlite';
import {
  APPLICATION_ID,
  MAX_VALUE_BYTES,
  StorageError,
  authorize,
  openDb,
  wrapConnection,
  type AuthScope,
  type Connection,
  type Db,
  type Tx,
} from '../../../src/storage/sqlite.ts';
import { RAW_OPTIONS, count, dump, fileDb, memDb, rawDb, removeDir, storageError, tempDir } from './helpers.ts';

const POSIX = process.platform !== 'win32';
const T_DDL = 'CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER) STRICT';

function withTable(db: Db, ddl = T_DDL): Db {
  db.transaction((tx) => tx.script(ddl));
  return db;
}

function inDir(fn: (dir: string) => void, prefix?: string): void {
  const dir = tempDir(prefix);
  try {
    fn(dir);
  } finally {
    removeDir(dir);
  }
}

function setting(db: Db, name: string): unknown {
  const all = db.settings();
  assert.ok(Object.hasOwn(all, name), name);
  return all[name];
}

/**
 * A connection that behaves like the real one except where the test says otherwise. The overrides are
 * copied as property descriptors: a spread would read an overriding getter once and keep its value.
 */
function fakeOver(real: DatabaseSync, overrides: Partial<Connection> = {}): Connection {
  const base: Connection = {
    exec: (sql) => real.exec(sql),
    prepare: (sql) => real.prepare(sql),
    get isTransaction() {
      return real.isTransaction;
    },
    setAuthorizer: (callback) => real.setAuthorizer(callback),
    close: () => real.close(),
  };
  return Object.defineProperties(base, Object.getOwnPropertyDescriptors(overrides));
}

describe('openDb: the file is ours and set up the safe way', () => {
  it('a new file gets WAL, synchronous FULL, foreign keys, trusted_schema off, recursive triggers, the busy timeout and the bot application id', () => {
    inDir((dir) => {
      const file = path.join(dir, 'bot.sqlite');
      const db = fileDb(file);
      try {
        assert.equal(db.file, file);
        assert.equal(db.readOnly, false);
        assert.equal(setting(db, 'journal_mode'), 'wal');
        assert.equal(setting(db, 'synchronous'), 2n);
        assert.equal(setting(db, 'foreign_keys'), 1n);
        assert.equal(setting(db, 'trusted_schema'), 0n);
        assert.equal(setting(db, 'recursive_triggers'), 1n);
        assert.equal(setting(db, 'ignore_check_constraints'), 0n);
        assert.equal(setting(db, 'busy_timeout'), 100n);
        assert.equal(setting(db, 'application_id'), BigInt(APPLICATION_ID));
        assert.equal(APPLICATION_ID, 0x464f4d4f); // "FOMO"
      } finally {
        db.close();
      }
    });
  });

  it('the file and its -wal and -shm files are readable by the owner only (POSIX; Windows has no such modes)', (t) => {
    if (!POSIX) {
      t.skip('file modes do not apply on Windows');
      return;
    }
    inDir((dir) => {
      const file = path.join(dir, 'bot.sqlite');
      const db = withTable(fileDb(file));
      try {
        db.transaction((tx) => tx.run("INSERT INTO t (id) VALUES ('a')"));
        for (const f of [file, `${file}-wal`, `${file}-shm`]) {
          assert.equal(statSync(f).mode & 0o777, 0o600, f);
        }
      } finally {
        db.close();
      }
    });
  });

  it("':memory:' reports journal mode memory and works the same otherwise", () => {
    const db = withTable(memDb());
    try {
      assert.equal(db.file, ':memory:');
      assert.equal(setting(db, 'journal_mode'), 'memory');
      assert.equal(setting(db, 'recursive_triggers'), 1n);
      db.transaction((tx) => tx.run("INSERT INTO t (id) VALUES ('a')"));
      assert.equal(count(db, 't'), 1n);
    } finally {
      db.close();
    }
  });

  it('reopening the bot file keeps its data, also with create: false', () => {
    inDir((dir) => {
      const file = path.join(dir, 'bot.sqlite');
      const first = withTable(fileDb(file));
      first.transaction((tx) => tx.run("INSERT INTO t (id, n) VALUES ('a', 7)"));
      first.close();
      const again = fileDb(file, false);
      try {
        assert.deepEqual({ ...again.get("SELECT id, n FROM t WHERE id = 'a'") }, { id: 'a', n: 7n });
      } finally {
        again.close();
      }
    });
  });

  it('a file of another program is refused: another application id, or tables without ours (foreign-file)', () => {
    inDir((dir) => {
      const otherId = path.join(dir, 'other-id.sqlite');
      const raw1 = rawDb(otherId);
      raw1.exec('PRAGMA application_id = 7');
      raw1.close();
      storageError(() => fileDb(otherId), 'foreign-file');
      const tablesOnly = path.join(dir, 'tables.sqlite');
      const raw2 = rawDb(tablesOnly);
      raw2.exec('CREATE TABLE notes (x TEXT)');
      raw2.close();
      storageError(() => fileDb(tablesOnly), 'foreign-file');
      storageError(() => fileDb(tablesOnly, false), 'foreign-file');
    });
  });

  it('create: false never makes a new database: a missing file or an empty one is refused (missing) and no file appears', () => {
    inDir((dir) => {
      const missing = path.join(dir, 'missing.sqlite');
      storageError(() => fileDb(missing, false), 'missing');
      assert.equal(existsSync(missing), false);
      // a file that exists but is not ours yet (the moment between a check and the open): still refused
      const empty = path.join(dir, 'empty.sqlite');
      writeFileSync(empty, '');
      storageError(() => fileDb(empty, false), 'missing');
      assert.equal(statSync(empty).size, 0, 'nothing was written to it');
      // create: true claims an empty file
      const db = fileDb(empty, true);
      db.close();
    });
  });

  it('a file that is not a database is refused (not-a-database); a folder that does not exist gives io', () => {
    inDir((dir) => {
      const junk = path.join(dir, 'junk.sqlite');
      writeFileSync(junk, Buffer.alloc(4096, 0x41));
      storageError(() => fileDb(junk), 'not-a-database');
      storageError(() => fileDb(path.join(dir, 'no-such-folder', 'bot.sqlite')), 'io');
    });
  });

  it('bad options and paths are refused before anything is opened (bad-option)', () => {
    inDir((dir) => {
      const file = path.join(dir, 'bot.sqlite');
      const cases: [string, unknown][] = [
        ['relative path', ['bot.sqlite', { busyTimeoutMs: 100, create: true }]],
        ['file: URI', ['file:bot.sqlite', { busyTimeoutMs: 100, create: true }]],
        ['NUL in the path', [`${file}\0x`, { busyTimeoutMs: 100, create: true }]],
        ['empty path', ['', { busyTimeoutMs: 100, create: true }]],
        ['not a string', [42, { busyTimeoutMs: 100, create: true }]],
        ['negative timeout', [file, { busyTimeoutMs: -1, create: true }]],
        ['fractional timeout', [file, { busyTimeoutMs: 1.5, create: true }]],
        ['timeout above a minute', [file, { busyTimeoutMs: 60_001, create: true }]],
        ['create not boolean', [file, { busyTimeoutMs: 100, create: 'yes' }]],
        ['readOnly not boolean', [file, { busyTimeoutMs: 100, create: false, readOnly: 1 }]],
        ['read-only and create', [file, { busyTimeoutMs: 100, create: true, readOnly: true }]],
        ['read-only memory', [':memory:', { busyTimeoutMs: 100, create: false, readOnly: true }]],
        ['memory without create', [':memory:', { busyTimeoutMs: 100, create: false }]],
        ['no options', [file, undefined]],
      ];
      for (const [name, args] of cases) {
        const [f, o] = args as [string, never];
        storageError(() => openDb(f, o), 'bad-option');
        assert.equal(existsSync(file), false, name);
      }
    });
  });

  it('a read-only handle reads, refuses every transaction (readonly), and refuses a file that is not in WAL mode (pragma)', () => {
    inDir((dir) => {
      const file = path.join(dir, 'bot.sqlite');
      const db = withTable(fileDb(file));
      db.transaction((tx) => tx.run("INSERT INTO t (id) VALUES ('a')"));
      db.close();
      const ro = openDb(file, { busyTimeoutMs: 100, create: false, readOnly: true });
      try {
        assert.equal(ro.readOnly, true);
        assert.equal(count(ro, 't'), 1n);
        storageError(() => ro.transaction((tx) => tx.run("INSERT INTO t (id) VALUES ('b')")), 'readonly');
        let ran = false;
        storageError(() => ro.transaction(() => (ran = true)), 'readonly');
        assert.equal(ran, false, 'refused before the callback runs, not when its first write fails');
      } finally {
        ro.close();
      }
      storageError(() => openDb(path.join(dir, 'missing.sqlite'), { busyTimeoutMs: 100, create: false, readOnly: true }), 'missing');
      // a file of ours in the old rollback-journal mode: a read-only handle cannot switch it, so it refuses
      const oldMode = path.join(dir, 'old.sqlite');
      const raw = rawDb(oldMode);
      raw.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
      raw.exec('CREATE TABLE x (y TEXT) STRICT');
      raw.close();
      storageError(() => openDb(oldMode, { busyTimeoutMs: 100, create: false, readOnly: true }), 'pragma');
    });
  });

  it('paths with a space and Greek letters work, and the folder can be removed after close (Windows EBUSY)', () => {
    inDir((dir) => {
      const file = path.join(dir, 'μια βάση.sqlite');
      const db = withTable(fileDb(file));
      try {
        db.transaction((tx) => tx.run("INSERT INTO t (id) VALUES ('a')"));
        const copy = path.join(dir, 'αντίγραφο 1.sqlite');
        db.vacuumInto(copy);
        const c = fileDb(copy, false);
        assert.equal(count(c, 't'), 1n);
        c.close();
      } finally {
        db.close();
      }
    }, 'fomo db Ελλάδα-');
  });
});

describe('transaction(): all or nothing, synchronous, one at a time', () => {
  it('commits and returns the value of the callback', () => {
    const db = withTable(memDb());
    try {
      const out = db.transaction((tx) => {
        tx.run("INSERT INTO t (id, n) VALUES ('a', 1)");
        return tx.run("UPDATE t SET n = n + 1 WHERE id = 'a'");
      });
      assert.equal(out, 1);
      assert.deepEqual({ ...db.get('SELECT n FROM t') }, { n: 2n });
    } finally {
      db.close();
    }
  });

  it('a throw anywhere in the callback rolls everything back and the same error comes out', () => {
    const db = withTable(memDb());
    try {
      db.transaction((tx) => tx.run("INSERT INTO t (id) VALUES ('kept')"));
      const before = dump(db);
      const boom = new Error('boom');
      let caught: unknown = null;
      try {
        db.transaction((tx) => {
          tx.run("INSERT INTO t (id) VALUES ('x')");
          tx.run("UPDATE t SET n = 5 WHERE id = 'kept'");
          tx.script('CREATE TABLE u (z TEXT) STRICT');
          throw boom;
        });
      } catch (e) {
        caught = e;
      }
      assert.equal(caught, boom);
      assert.equal(dump(db), before);
      // a constraint failure rolls back the earlier statements too
      storageError(
        () =>
          db.transaction((tx) => {
            tx.run("INSERT INTO t (id) VALUES ('y')");
            tx.run("INSERT INTO t (id) VALUES ('kept')");
          }),
        'constraint',
      );
      assert.equal(dump(db), before);
      // the handle is fine afterwards
      db.transaction((tx) => tx.run("INSERT INTO t (id) VALUES ('z')"));
      assert.equal(count(db, 't'), 2n);
    } finally {
      db.close();
    }
  });

  it('an async callback is refused (async-in-transaction): what it wrote before its first await is rolled back, and the tx is dead after', async () => {
    const db = withTable(memDb());
    try {
      const before = dump(db);
      let later: unknown = null;
      const asyncFn = async (tx: Tx): Promise<void> => {
        tx.run("INSERT INTO t (id) VALUES ('before-await')");
        await Promise.resolve();
        try {
          tx.run("INSERT INTO t (id) VALUES ('after-await')");
        } catch (e) {
          later = e;
        }
      };
      storageError(() => db.transaction(asyncFn as unknown as (tx: Tx) => number), 'async-in-transaction');
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(later instanceof StorageError && later.code === 'tx-closed', String(later));
      assert.equal(dump(db), before);
      // a callback returning a rejected promise does not leave an unhandled rejection behind
      storageError(() => db.transaction((() => Promise.reject(new Error('late'))) as unknown as (tx: Tx) => number), 'async-in-transaction');
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      db.close();
    }
  });

  it('the type of transaction() refuses an async callback at compile time', () => {
    const db = memDb();
    try {
      // @ts-expect-error an async callback is a compile error (NotPromise)
      storageError(() => db.transaction(async () => 1), 'async-in-transaction');
    } finally {
      db.close();
    }
  });

  it('nesting is refused (nested-transaction) and the outer transaction rolls back', () => {
    const db = withTable(memDb());
    try {
      storageError(
        () =>
          db.transaction((tx) => {
            tx.run("INSERT INTO t (id) VALUES ('outer')");
            return db.transaction((inner) => inner.run("INSERT INTO t (id) VALUES ('inner')"));
          }),
        'nested-transaction',
      );
      assert.equal(count(db, 't'), 0n);
    } finally {
      db.close();
    }
  });

  it('inside a transaction the handle itself refuses reads, copies, checks and close (nested-transaction): use the tx', () => {
    inDir((dir) => {
      const db = withTable(fileDb(path.join(dir, 'bot.sqlite')));
      try {
        const calls: [string, () => unknown][] = [
          ['get', () => db.get('SELECT 1 AS one')],
          ['all', () => db.all('SELECT 1 AS one')],
          ['vacuumInto', () => db.vacuumInto(path.join(dir, 'copy.sqlite'))],
          ['quickCheck', () => db.quickCheck()],
          ['foreignKeyCheck', () => db.foreignKeyCheck()],
          ['close', () => db.close()],
        ];
        for (const [name, call] of calls) {
          db.transaction(() => {
            storageError(call, 'nested-transaction');
            return name;
          });
        }
        assert.equal(existsSync(path.join(dir, 'copy.sqlite')), false);
        assert.equal(count(db, 't'), 0n, 'the handle is still open and usable');
      } finally {
        db.close();
      }
    });
  });

  it('a tx kept after its transaction ended throws tx-closed, whether the transaction committed or rolled back', () => {
    const db = withTable(memDb());
    try {
      let kept: Tx | null = null;
      db.transaction((tx) => {
        kept = tx;
        return 0;
      });
      let failed: Tx | null = null;
      assert.throws(() =>
        db.transaction((tx) => {
          failed = tx;
          throw new Error('stop');
        }),
      );
      for (const tx of [kept, failed] as unknown as Tx[]) {
        storageError(() => tx.run("INSERT INTO t (id) VALUES ('late')"), 'tx-closed');
        storageError(() => tx.get('SELECT 1 AS one'), 'tx-closed');
        storageError(() => tx.all('SELECT 1 AS one'), 'tx-closed');
        storageError(() => tx.script('CREATE TABLE late (x TEXT) STRICT'), 'tx-closed');
        // the worst moment: while a later transaction is open, an old tx must not write into it
        db.transaction((now) => {
          storageError(() => tx.run("INSERT INTO t (id) VALUES ('sneaky')"), 'tx-closed');
          storageError(() => tx.script('CREATE TABLE sneaky (x TEXT) STRICT'), 'tx-closed');
          return now.run("INSERT INTO t (id) VALUES ('mine')");
        });
        db.transaction((now) => now.run("DELETE FROM t WHERE id = 'mine'"));
      }
      assert.equal(count(db, 't'), 0n);
      assert.equal(db.get("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'sneaky'")?.['n'], 0n);
    } finally {
      db.close();
    }
  });

  it('after SQLite rolls the whole transaction back itself (disk full), nothing more runs in it: the next statement and the commit are refused', () => {
    inDir((dir) => {
      const file = path.join(dir, 'full.sqlite');
      const real = rawDb(file);
      real.exec('PRAGMA journal_mode = WAL');
      real.exec('CREATE TABLE f (x TEXT) STRICT');
      real.exec('PRAGMA max_page_count = 6'); // the disk-full simulation (VERIFIED_FACTS U8)
      const db = wrapConnection(real, file, false);
      try {
        const fill = (tx: Tx): StorageError => {
          try {
            for (let i = 0; i < 1_000; i += 1) {
              tx.run('INSERT INTO f (x) VALUES (?)', 'y'.repeat(900));
            }
          } catch (e) {
            assert.ok(e instanceof StorageError);
            return e;
          }
          assert.fail('the database never filled up');
        };
        // 1: the callback carries on after the error: refused, nothing is written in autocommit mode
        let full: StorageError | null = null;
        const e = storageError(
          () =>
            db.transaction((tx) => {
              tx.run("INSERT INTO f (x) VALUES ('first')");
              full = fill(tx);
              tx.run("INSERT INTO f (x) VALUES ('after')");
            }),
          'tx-failed',
        );
        assert.match(e.detail, /\(full\)/);
        assert.equal((full as StorageError | null)?.code, 'full');
        assert.equal(count(db, 'f'), 0n);
        // 2: the callback swallows the error and returns: the commit is refused
        storageError(() => db.transaction((tx) => fill(tx).code), 'tx-failed');
        assert.equal(count(db, 'f'), 0n);
        // the handle is not poisoned: a small transaction still fits
        assert.equal(db.transaction((tx) => tx.run("INSERT INTO f (x) VALUES ('fits')")), 1);
      } finally {
        db.close();
      }
    });
  });

  it('a statement error the callback catches still sinks the whole transaction: nothing after it runs, nothing is saved (tx-failed; review O)', () => {
    const db = withTable(
      memDb(),
      "CREATE TABLE pos (id TEXT PRIMARY KEY) STRICT;\nCREATE TABLE counters (name TEXT PRIMARY KEY, n INTEGER NOT NULL CHECK (n <= 4)) STRICT;\nINSERT INTO counters (name, n) VALUES ('open', 0);",
    );
    try {
      const before = dump(db);
      const failures: [string, (tx: Tx) => unknown][] = [
        ['a CHECK', (tx) => tx.run("UPDATE counters SET n = n + 5 WHERE name = 'open'")],
        ['a UNIQUE', (tx) => [tx.run("INSERT INTO pos (id) VALUES ('U')"), tx.run("INSERT INTO pos (id) VALUES ('U')")]],
        ['a refused parameter', (tx) => tx.run("UPDATE counters SET n = ? WHERE name = 'open'", 1 as unknown as string)],
        ['a refused statement', (tx) => tx.run('SELECT 1')],
        ['a REAL cell', (tx) => tx.get('SELECT 0.5 AS r')],
        ['a refused script', (tx) => tx.script('PRAGMA foreign_keys = OFF;')],
      ];
      for (const [name, fail] of failures) {
        // the callback swallows the failure and returns: the commit is refused
        const swallowed = storageError(
          () =>
            db.transaction((tx) => {
              tx.run("INSERT INTO pos (id) VALUES ('A')");
              try {
                fail(tx);
              } catch {
                // a careless catch
              }
              return 0;
            }),
          'tx-failed',
        );
        assert.match(swallowed.detail, /failed \(/, name);
        assert.equal(dump(db), before, name);
        // the callback swallows it and goes on: the next statement is refused too
        storageError(
          () =>
            db.transaction((tx) => {
              try {
                fail(tx);
              } catch {
                // a careless catch
              }
              return tx.run("INSERT INTO pos (id) VALUES ('B')");
            }),
          'tx-failed',
        );
        assert.equal(dump(db), before, name);
      }
      // a later transaction is not affected
      assert.equal(db.transaction((tx) => tx.run("INSERT INTO pos (id) VALUES ('C')")), 1);
    } finally {
      db.close();
    }
  });

  it('if SQLite no longer holds the transaction although no statement failed, the next statement and the commit are refused (tx-closed)', () => {
    const real = rawDb(':memory:');
    real.exec(T_DDL);
    let lie = false;
    const db = wrapConnection(
      fakeOver(real, {
        get isTransaction() {
          return lie ? false : real.isTransaction;
        },
        setAuthorizer: () => undefined, // no authorizer: the test rolls back on the raw connection itself
      }),
      ':memory:',
      false,
    );
    try {
      storageError(
        () =>
          db.transaction((tx) => {
            tx.run("INSERT INTO t (id) VALUES ('a')");
            lie = true;
            return tx.run("INSERT INTO t (id) VALUES ('b')");
          }),
        'tx-closed',
      );
      lie = false;
      real.exec('ROLLBACK'); // the stand-in hid the open transaction from the wrapper's own ROLLBACK
      storageError(
        () =>
          db.transaction((tx) => {
            lie = true;
            return tx.get('SELECT 1 AS one');
          }),
        'tx-closed',
      );
      lie = false;
      real.exec('ROLLBACK');
      storageError(
        () =>
          db.transaction((tx) => {
            tx.run("INSERT INTO t (id) VALUES ('c')");
            lie = true; // checked once more right before COMMIT
            return 0;
          }),
        'tx-closed',
      );
      lie = false;
      real.exec('ROLLBACK');
      assert.equal(count(db, 't'), 0n);
    } finally {
      db.close();
    }
  });

  it('a connection that cannot even say whether it holds the transaction counts as not holding it, and its rollback poisons the handle', () => {
    const real = rawDb(':memory:');
    real.exec(T_DDL);
    let broken = false;
    const db = wrapConnection(
      fakeOver(real, {
        get isTransaction(): boolean {
          if (broken) {
            throw new Error('database is not open');
          }
          return real.isTransaction;
        },
      }),
      ':memory:',
      false,
    );
    storageError(
      () =>
        db.transaction((tx) => {
          tx.run("INSERT INTO t (id) VALUES ('a')");
          broken = true;
          return tx.run("INSERT INTO t (id) VALUES ('b')");
        }),
      'tx-closed',
    );
    storageError(() => db.get('SELECT 1 AS one'), 'poisoned');
    db.close();
  });

  it('a COMMIT that fails after SQLite let go of the transaction (an I/O error) poisons the handle: whether it reached the disk is unknown (review O)', () => {
    const real = rawDb(':memory:');
    real.exec(T_DDL);
    const db = wrapConnection(
      fakeOver(real, {
        exec: (sql) => {
          if (sql === 'COMMIT') {
            real.exec('ROLLBACK'); // stands in for "the commit frame may or may not be in the WAL"
            throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
          }
          real.exec(sql);
        },
      }),
      ':memory:',
      false,
    );
    const e = storageError(() => db.transaction((tx) => tx.run("INSERT INTO t (id) VALUES ('a')")), 'io');
    assert.equal(e.sqliteCode, 10);
    storageError(() => db.get('SELECT 1 AS one'), 'poisoned');
    storageError(() => db.transaction(() => 1), 'poisoned');
    db.close();
  });

  it('a COMMIT that fails (a deferred foreign key) rolls back and the handle stays usable', () => {
    const db = memDb();
    try {
      db.transaction((tx) =>
        tx.script(
          'CREATE TABLE parent (id TEXT PRIMARY KEY) STRICT;\n' +
            'CREATE TABLE child (id TEXT PRIMARY KEY, p TEXT NOT NULL REFERENCES parent (id) DEFERRABLE INITIALLY DEFERRED) STRICT;',
        ),
      );
      storageError(() => db.transaction((tx) => tx.run("INSERT INTO child (id, p) VALUES ('c', 'nobody')")), 'constraint');
      assert.equal(count(db, 'child'), 0n);
      db.transaction((tx) => {
        tx.run("INSERT INTO parent (id) VALUES ('p')");
        return tx.run("INSERT INTO child (id, p) VALUES ('c', 'p')");
      });
      assert.equal(count(db, 'child'), 1n);
    } finally {
      db.close();
    }
  });

  it('a ROLLBACK that fails poisons the handle: the first error still comes out, and every later call but close throws poisoned', () => {
    inDir((dir) => {
      const real = rawDb(':memory:');
      real.exec(T_DDL);
      const db = wrapConnection(
        fakeOver(real, {
          exec: (sql) => {
            if (sql === 'ROLLBACK') {
              throw new Error('disk I/O error');
            }
            real.exec(sql);
          },
        }),
        ':memory:',
        false,
      );
      const boom = new Error('boom');
      assert.throws(
        () =>
          db.transaction((tx) => {
            tx.run("INSERT INTO t (id) VALUES ('a')");
            throw boom;
          }),
        (e) => e === boom,
      );
      const calls: (() => unknown)[] = [
        () => db.transaction(() => 1),
        () => db.get('SELECT 1 AS one'),
        () => db.all('SELECT 1 AS one'),
        () => db.quickCheck(),
        () => db.foreignKeyCheck(),
        () => db.vacuumInto(path.join(dir, 'copy.sqlite')),
      ];
      for (const call of calls) {
        storageError(call, 'poisoned');
      }
      assert.equal(existsSync(path.join(dir, 'copy.sqlite')), false);
      db.close();
      storageError(() => db.get('SELECT 1 AS one'), 'closed');
    });
  });

  it('a script that changes a safety setting past the text checks: the authorizer refuses it, and without the authorizer the handle is poisoned (review P)', () => {
    // a stand-in for a bypass of the text checks: the script also flips a setting
    const sneaky = (real: DatabaseSync, overrides: Partial<Connection> = {}): Db =>
      wrapConnection(
        fakeOver(real, {
          exec: (sql) => {
            real.exec(sql);
            if (sql.startsWith('CREATE TABLE sneaky')) {
              real.exec('PRAGMA ignore_check_constraints = 1');
            }
          },
          ...overrides,
        }),
        ':memory:',
        false,
      );
    const setUpRaw = (): DatabaseSync => {
      const real = rawDb(':memory:');
      real.exec(T_DDL);
      real.exec('PRAGMA recursive_triggers = ON');
      real.exec('PRAGMA trusted_schema = OFF');
      return real;
    };
    // the first line: SQLite's authorizer refuses the PRAGMA, nothing changes, the handle stays usable
    const guarded = sneaky(setUpRaw());
    try {
      storageError(() => guarded.transaction((tx) => tx.script('CREATE TABLE sneaky (x TEXT) STRICT;')), 'denied');
      assert.equal(setting(guarded, 'ignore_check_constraints'), 0n);
      assert.equal(guarded.get("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'sneaky'")?.['n'], 0n);
    } finally {
      guarded.close();
    }
    // the second line, with no authorizer at all: the settings read back after the script catch it
    const db = sneaky(setUpRaw(), { setAuthorizer: () => undefined });
    try {
      db.transaction((tx) => tx.script('CREATE TABLE fine (x TEXT) STRICT;'));
      storageError(() => db.transaction((tx) => tx.script('CREATE TABLE sneaky (x TEXT) STRICT;')), 'poisoned');
      storageError(() => db.get('SELECT 1 AS one'), 'poisoned');
    } finally {
      db.close();
    }
  });

  it('a script that ends the transaction itself: the authorizer refuses the END; without the authorizer the handle is poisoned, also when the script fails after the END', () => {
    const scripts = ["INSERT INTO t (id) VALUES ('b');\nEND;", "INSERT INTO t (id) VALUES ('b');\nEND;\nTHIS IS NOT SQL;"];
    const attempt = (db: Db, script: string): void => {
      db.transaction((tx) => {
        tx.run("INSERT INTO t (id) VALUES ('a')");
        tx.script(script);
        return tx.run("INSERT INTO t (id) VALUES ('c')");
      });
    };
    for (const script of scripts) {
      // the first line: the END is refused, the transaction stays whole and rolls back, the handle is fine
      const db = withTable(memDb());
      try {
        storageError(() => attempt(db, script), 'denied');
        assert.equal(count(db, 't'), 0n);
        assert.equal(db.transaction((tx) => tx.run("INSERT INTO t (id) VALUES ('d')")), 1);
      } finally {
        db.close();
      }
      // the second line, with no authorizer: the wrapper sees the transaction gone and poisons the handle
      const real = rawDb(':memory:');
      const bare = withTable(wrapConnection(fakeOver(real, { setAuthorizer: () => undefined }), ':memory:', false));
      try {
        storageError(() => attempt(bare, script), 'poisoned');
        storageError(() => bare.get('SELECT 1 AS one'), 'poisoned');
      } finally {
        bare.close();
      }
    }
    // a script that fails with the transaction still open keeps its own error, and the handle is fine
    const db = withTable(memDb());
    try {
      storageError(() => db.transaction((tx) => tx.script('CREATE TABLE t (x TEXT) STRICT;')), 'other');
      assert.equal(count(db, 't'), 0n);
    } finally {
      db.close();
    }
  });

  it('two handles on one file: the second waits for the busy timeout and gets busy; after the first commits it sees the row', () => {
    inDir((dir) => {
      const file = path.join(dir, 'bot.sqlite');
      const a = withTable(fileDb(file));
      const b = fileDb(file, false);
      try {
        a.transaction((tx) => {
          tx.run("INSERT INTO t (id) VALUES ('from-a')");
          storageError(() => b.transaction((txb) => txb.run("INSERT INTO t (id) VALUES ('from-b')")), 'busy');
          return 0;
        });
        assert.equal(b.transaction((tx) => tx.get("SELECT id FROM t WHERE id = 'from-a'"))?.['id'], 'from-a');
      } finally {
        a.close();
        b.close();
      }
    });
  });

  it('BEGIN itself failing leaves the handle usable', () => {
    const real = rawDb(':memory:');
    real.exec(T_DDL);
    let failBegin = true;
    const db = wrapConnection(
      fakeOver(real, {
        exec: (sql) => {
          if (sql === 'BEGIN IMMEDIATE' && failBegin) {
            failBegin = false;
            const e = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5, errstr: 'database is locked' });
            throw e;
          }
          real.exec(sql);
        },
      }),
      ':memory:',
      false,
    );
    try {
      const busy = storageError(() => db.transaction(() => 1), 'busy');
      assert.equal(busy.sqliteCode, 5);
      assert.equal(db.transaction((tx) => tx.run("INSERT INTO t (id) VALUES ('a')")), 1);
    } finally {
      db.close();
    }
  });
});

describe('statements: one constant statement, nothing float-like in or out', () => {
  it('parameters are strings, bigints within 64 bits, null or bytes; numbers, booleans, undefined and objects are refused (bad-param)', () => {
    const db = withTable(memDb(), 'CREATE TABLE p (a TEXT, b INTEGER, c BLOB) STRICT');
    try {
      db.transaction((tx) => tx.run('INSERT INTO p (a, b, c) VALUES (?, ?, ?)', 'x', -(2n ** 63n), new Uint8Array([1, 2])));
      db.transaction((tx) => tx.run('INSERT INTO p (a, b, c) VALUES (?, ?, ?)', null, 2n ** 63n - 1n, null));
      assert.equal(count(db, 'p'), 2n);
      const bad: unknown[] = [7, 1.5, Number.NaN, true, undefined, { a: 1 }, ['x'], 2n ** 63n, -(2n ** 63n) - 1n, new DataView(new ArrayBuffer(2)), Symbol('s')];
      for (const value of bad) {
        const e = storageError(() => db.transaction((tx) => tx.run('INSERT INTO p (a) VALUES (?)', value as string)), 'bad-param');
        assert.match(e.detail, /parameter 1/);
        storageError(() => db.get('SELECT ? AS v', value as string), 'bad-param');
      }
      assert.equal(count(db, 'p'), 2n);
    } finally {
      db.close();
    }
  });

  it('the number of parameters must equal the number of ? placeholders: SQLite would bind a missing one as NULL (bad-param)', () => {
    const db = withTable(memDb());
    try {
      storageError(() => db.transaction((tx) => tx.run('INSERT INTO t (id, n) VALUES (?, ?)', 'a')), 'bad-param');
      storageError(() => db.transaction((tx) => tx.run('INSERT INTO t (id) VALUES (?)', 'a', 'b')), 'bad-param');
      storageError(() => db.get('SELECT 1 AS one', 'x'), 'bad-param');
      // a ? inside a quoted string is text, not a placeholder
      assert.deepEqual({ ...db.get("SELECT 'a?b' AS q, ? AS v", 'x') }, { q: 'a?b', v: 'x' });
      assert.equal(count(db, 't'), 0n);
    } finally {
      db.close();
    }
  });

  it('a REAL cell is refused on read (bad-cell), and its value is not in the error', () => {
    const db = memDb();
    try {
      const e = storageError(() => db.get('SELECT 12345.678 AS price'), 'bad-cell');
      assert.match(e.detail, /price/);
      assert.doesNotMatch(e.message, /12345/);
      storageError(() => db.all("SELECT 'ok' AS a UNION ALL SELECT 0.5"), 'bad-cell');
      assert.deepEqual({ ...db.get("SELECT 1 AS i, 'x' AS s, NULL AS z, x'0102' AS b") }, { i: 1n, s: 'x', z: null, b: new Uint8Array([1, 2]) });
    } finally {
      db.close();
    }
  });

  it('one statement per call: a semicolon (SQLite would drop the rest silently), comments, odd quotes and named parameters are refused (bad-sql)', () => {
    const db = withTable(memDb());
    try {
      const bad = [
        "INSERT INTO t (id) VALUES ('a'); INSERT INTO t (id) VALUES ('b')",
        "INSERT INTO t (id) VALUES ('a');",
        "INSERT INTO t (id) VALUES ('a') -- note",
        "/* note */ INSERT INTO t (id) VALUES ('a')",
        'INSERT INTO [t] (id) VALUES (?)',
        'INSERT INTO `t` (id) VALUES (?)',
        'INSERT INTO t (id) VALUES (:id)',
        'INSERT INTO t (id) VALUES (@id)',
        'INSERT INTO t (id) VALUES ($id)',
        'INSERT INTO t (id) VALUES (?1)',
        "INSERT INTO t (id) VALUES ('unterminated)",
        'INSERT INTO t (id) VALUES ("unterminated)',
        "INSERT INTO t (id) VALUES ('é')",
        "INSERT INTO t (id)\r\nVALUES ('a')",
        "INSERT INTO t (id) VALUES ('a\0')",
        '',
        '   ',
        '42',
        'x'.repeat(200_001),
      ];
      for (const sql of bad) {
        const params = sql.includes('?') ? ['a'] : [];
        storageError(() => db.transaction((tx) => tx.run(sql, ...params)), 'bad-sql');
      }
      storageError(() => db.transaction((tx) => tx.run(42 as unknown as string)), 'bad-sql');
      assert.equal(count(db, 't'), 0n);
      // quoted text may hold any of those characters
      db.transaction((tx) => tx.run("INSERT INTO \"t\" (id) VALUES ('a;b -- /* [c] `d` :e @f $g ?h')"));
      assert.equal(db.get('SELECT id FROM t')?.['id'], 'a;b -- /* [c] `d` :e @f $g ?h');
      // an escaped quote stays inside the string
      db.transaction((tx) => tx.run("INSERT INTO t (id) VALUES ('it''s; fine')"));
      assert.equal(count(db, 't'), 2n);
    } finally {
      db.close();
    }
  });

  it('the first word decides: the handle reads with SELECT only, run() writes with INSERT, UPDATE or DELETE, a tx may read with RETURNING', () => {
    const db = withTable(memDb());
    try {
      for (const sql of ["INSERT INTO t (id) VALUES ('a')", "DELETE FROM t", 'PRAGMA journal_mode', 'WITH x AS (SELECT 1) SELECT * FROM x']) {
        storageError(() => db.get(sql), 'bad-sql');
        storageError(() => db.all(sql), 'bad-sql');
      }
      for (const sql of ['SELECT 1', 'PRAGMA foreign_keys = OFF', 'BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT s', 'RELEASE s', 'DROP TABLE t', "ATTACH 'x' AS y", 'VACUUM', 'REPLACE INTO t (id) VALUES (1)', 'CREATE TABLE z (x TEXT)']) {
        storageError(() => db.transaction((tx) => tx.run(sql)), 'bad-sql');
      }
      for (const sql of ['PRAGMA foreign_keys = OFF', 'COMMIT', 'DROP TABLE t']) {
        storageError(() => db.transaction((tx) => tx.get(sql)), 'bad-sql');
        storageError(() => db.transaction((tx) => tx.all(sql)), 'bad-sql');
      }
      const id = db.transaction((tx) => tx.get("insert into t (id, n) values ('a', 1) returning id")?.['id']);
      assert.equal(id, 'a');
      const rows = db.transaction((tx) => tx.all('UPDATE t SET n = n + 1 RETURNING n'));
      assert.deepEqual(rows.map((r) => r['n']), [2n]);
      assert.equal(db.transaction((tx) => tx.run('  delete from t')), 1);
    } finally {
      db.close();
    }
  });

  it('a refused PRAGMA has no effect at all: SQLite applies a flag PRAGMA when it is prepared, so the check comes before SQLite sees it', () => {
    const db = withTable(memDb(), 'CREATE TABLE c (x INTEGER NOT NULL CHECK (x > 0)) STRICT');
    try {
      for (const sql of ['PRAGMA ignore_check_constraints = ON', 'PRAGMA foreign_keys = OFF', 'PRAGMA recursive_triggers = OFF', 'PRAGMA trusted_schema = ON']) {
        storageError(() => db.get(sql), 'bad-sql');
        storageError(() => db.transaction((tx) => tx.run(sql)), 'bad-sql');
        storageError(() => db.transaction((tx) => tx.get(sql)), 'bad-sql');
      }
      assert.equal(setting(db, 'ignore_check_constraints'), 0n);
      assert.equal(setting(db, 'foreign_keys'), 1n);
      assert.equal(setting(db, 'recursive_triggers'), 1n);
      assert.equal(setting(db, 'trusted_schema'), 0n);
      storageError(() => db.transaction((tx) => tx.run('INSERT INTO c (x) VALUES (-1)')), 'constraint');
    } finally {
      db.close();
    }
  });

  it('#name parameters and the pragma_ functions are refused: pragma_optimize would run ANALYZE from a read (review O)', () => {
    const db = withTable(memDb(), "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) STRICT;\nCREATE INDEX t_v ON t (v);\nINSERT INTO t (v) VALUES ('a'), ('b');");
    try {
      storageError(() => db.get('SELECT ? AS p, #a AS x', 'one'), 'bad-sql'); // SQLite would bind #a as NULL
      storageError(() => db.transaction((tx) => tx.run('UPDATE t SET v = #v WHERE id = 1')), 'bad-sql');
      for (const sql of [
        'SELECT 1 AS x FROM pragma_optimize(65538)',
        'SELECT 1 AS x FROM "pragma_optimize"(65538)',
        'SELECT 1 AS x FROM main.PRAGMA_OPTIMIZE(65538)',
        "SELECT * FROM pragma_table_info('t')",
      ]) {
        storageError(() => db.get(sql), 'bad-sql');
        storageError(() => db.all(sql), 'bad-sql');
        storageError(() => db.transaction((tx) => tx.get(sql)), 'bad-sql');
      }
      storageError(() => db.transaction((tx) => tx.script('CREATE TABLE z AS SELECT * FROM pragma_optimize(65538);')), 'bad-sql');
      assert.equal(db.get("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'sqlite_stat1'")?.['n'], 0n, 'no ANALYZE ran');
    } finally {
      db.close();
    }
  });

  it('a cached statement is checked again on every call: its first word against the caller, its parameters against its placeholders (review O)', () => {
    const db = withTable(memDb());
    try {
      // the parameters of a statement that already ran
      const insert = 'INSERT INTO t (id, n) VALUES (?, ?)';
      db.transaction((tx) => tx.run(insert, 'a', 1n));
      for (const params of [['b', 2], ['b', true], ['b'], ['b', 2n, 3n], ['b', undefined]] as unknown[][]) {
        storageError(() => db.transaction((tx) => tx.run(insert, ...(params as string[]))), 'bad-param');
      }
      const read = 'SELECT n FROM t WHERE id = ?';
      assert.equal(db.get(read, 'a')?.['n'], 1n);
      storageError(() => db.get(read, 1 as unknown as string), 'bad-param');
      storageError(() => db.get(read), 'bad-param');
      // a writing statement first used inside a transaction is still refused on the handle (it would autocommit)
      const returning = "INSERT INTO t (id) VALUES ('c') RETURNING id";
      assert.equal(db.transaction((tx) => tx.get(returning))?.['id'], 'c');
      storageError(() => db.get(returning), 'bad-sql');
      storageError(() => db.all(returning), 'bad-sql');
      // a SELECT cached through the handle is still refused by run()
      const select = 'SELECT id FROM t';
      assert.equal(db.all(select).length, 2);
      storageError(() => db.transaction((tx) => tx.run(select)), 'bad-sql');
      assert.equal(count(db, 't'), 2n);
    } finally {
      db.close();
    }
  });

  it('a value above the size limit (1 MiB) is refused (bad-param) and sinks its transaction (review O)', () => {
    const db = withTable(memDb(), 'CREATE TABLE big (v TEXT) STRICT');
    try {
      assert.equal(MAX_VALUE_BYTES, 1_048_576);
      db.transaction((tx) => tx.run('INSERT INTO big (v) VALUES (?)', 'a '.repeat(500_000)));
      const e = storageError(() => db.transaction((tx) => tx.run('INSERT INTO big (v) VALUES (?)', 'a '.repeat(600_000))), 'bad-param');
      assert.equal(e.sqliteCode, 18);
      assert.equal(count(db, 'big'), 1n);
    } finally {
      db.close();
    }
  });

  it('two result columns with one name are refused: one would silently replace the other (bad-sql)', () => {
    const db = memDb();
    try {
      storageError(() => db.get('SELECT 1 AS a, 2 AS a'), 'bad-sql');
    } finally {
      db.close();
    }
  });

  it('rows are frozen, have no prototype, and a column named __proto__ is just a key', () => {
    const db = memDb();
    try {
      const row = db.get("SELECT 'x' AS __proto__, 1 AS z");
      assert.ok(row !== undefined);
      assert.ok(Object.isFrozen(row));
      assert.equal(Object.getPrototypeOf(row), null);
      assert.deepEqual(Object.keys(row), ['__proto__', 'z']);
      const rows = db.all('SELECT 1 AS a UNION ALL SELECT 2');
      assert.ok(Object.isFrozen(rows));
      assert.deepEqual(rows.map((r) => r['a']), [1n, 2n]);
      assert.equal(db.get('SELECT 1 AS a WHERE 0'), undefined);
      assert.deepEqual(db.all('SELECT 1 AS a WHERE 0'), []);
      assert.equal(db.transaction((tx) => tx.get('SELECT 1 AS a WHERE 0')), undefined);
      const inTx = db.transaction((tx) => tx.get("SELECT 'x' AS __proto__"));
      assert.ok(inTx !== undefined && Object.isFrozen(inTx) && Object.getPrototypeOf(inTx) === null);
    } finally {
      db.close();
    }
  });

  it('SQL is constant text: after 500 different statements the next new one is refused (bad-sql), known ones still run', () => {
    const db = memDb();
    try {
      for (let i = 0; i < 500; i += 1) {
        db.get(`SELECT ${i} AS v`);
      }
      const e = storageError(() => db.get('SELECT 500 AS v'), 'bad-sql');
      assert.match(e.detail, /constant/);
      assert.equal(db.get('SELECT 7 AS v')?.['v'], 7n);
    } finally {
      db.close();
    }
  });

  it('a script runs several DDL statements with a trigger, and refuses transaction control, PRAGMA, ATTACH, DETACH and VACUUM (bad-sql)', () => {
    const db = memDb();
    try {
      db.transaction((tx) =>
        tx.script(
          [
            'CREATE TABLE ao (id TEXT PRIMARY KEY) STRICT;',
            'CREATE TRIGGER ao_no_delete BEFORE DELETE ON ao BEGIN SELECT RAISE(ABORT, \'ao rows are never deleted\'); END;',
          ].join('\n'),
        ),
      );
      // no comments: one between BEGIN and its semicolon hid the BEGIN from the check (review O)
      for (const sql of ['END;\nBEGIN -- c\n;', 'END;\nBEGIN /* c */;', '-- a note\nCREATE TABLE w2 (x TEXT) STRICT;', 'CREATE TABLE w2 (x TEXT) STRICT; /* a note */']) {
        storageError(() => db.transaction((tx) => tx.script(`CREATE TABLE w (x TEXT) STRICT;\n${sql}\nCREATE TABLE w3 (x TEXT) STRICT;`)), 'bad-sql');
      }
      for (const word of ['COMMIT', 'rollback', 'SAVEPOINT s', 'RELEASE s', 'PRAGMA foreign_keys = OFF', "ATTACH 'x' AS y", 'DETACH y', 'VACUUM']) {
        storageError(() => db.transaction((tx) => tx.script(`CREATE TABLE w (x TEXT) STRICT;\n${word};`)), 'bad-sql');
      }
      // BEGIN as a statement (END; BEGIN; would get past the check after the script), not a trigger body
      for (const sql of ['END;\nBEGIN;', 'END; begin ;', 'END;\nBEGIN TRANSACTION;', 'END;\nBEGIN IMMEDIATE;', 'END;\nbegin deferred;', 'END;\nBEGIN EXCLUSIVE;', 'END TRANSACTION;']) {
        storageError(() => db.transaction((tx) => tx.script(`CREATE TABLE w (x TEXT) STRICT;\n${sql}\nCREATE TABLE w2 (x TEXT) STRICT;`)), 'bad-sql');
      }
      storageError(() => db.transaction((tx) => tx.script('CREATE TABLE w (x TEXT) STRICT;\nEND;\nBEGIN')), 'bad-sql');
      assert.equal(db.get("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('w', 'w2')")?.['n'], 0n);
      for (const sql of ['', "CREATE TABLE w (x TEXT DEFAULT 'é') STRICT", 'CREATE TABLE w (x TEXT) STRICT;\r\n', 42 as unknown as string]) {
        storageError(() => db.transaction((tx) => tx.script(sql)), 'bad-sql');
      }
      // quoted text is data, not a command or a comment (a config source is called 'rollback'); a quoted
      // name is still a name, so "pragma_optimize" counts
      db.transaction((tx) => tx.script("CREATE TABLE q (x TEXT CHECK (x IN ('rollback', 'commit', 'it''s -- not /* a comment'))) STRICT;"));
      storageError(() => db.transaction((tx) => tx.script('CREATE VIEW v2 AS SELECT * FROM "pragma_optimize"(65538);')), 'bad-sql');
      // SQLite reads a single-quoted word as a name where a name belongs; a quote inside [ ] or ` `
      // would put the quote tracking out of step (security-auditor, review P: each of these ran)
      for (const sql of [
        "SELECT 1 FROM 'pragma_optimize'(65538);",
        "CREATE TABLE tq (x INTEGER) STRICT;\nCREATE TRIGGER tq_after AFTER INSERT ON tq BEGIN SELECT 1 FROM 'pragma_optimize'(65538); END;", // a trigger body too
        "CREATE TABLE [a'b] (x INTEGER) STRICT;\nPRAGMA ignore_check_constraints = 1;\nCREATE TABLE [c'd] (y INTEGER) STRICT;",
        "CREATE TABLE `a'b` (x INTEGER) STRICT;\nPRAGMA recursive_triggers = 0;\nCREATE TABLE `c'd` (y INTEGER) STRICT;",
        "CREATE TABLE r (x TEXT DEFAULT 'pragma_x') STRICT;",
      ]) {
        storageError(() => db.transaction((tx) => tx.script(sql)), 'bad-sql');
      }
      assert.equal(setting(db, 'ignore_check_constraints'), 0n);
      assert.equal(setting(db, 'recursive_triggers'), 1n);
      assert.equal(db.get("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'sqlite_stat1'")?.['n'], 0n);
      storageError(() => db.transaction((tx) => tx.script('CREATE TABLE r ("x" TEXT) STRICT;\nrollback;')), 'bad-sql');
      storageError(() => db.transaction((tx) => tx.script("CREATE TABLE r (x TEXT DEFAULT 'a\"b') STRICT;\nVACUUM;")), 'bad-sql');
      // words inside longer names are fine
      db.transaction((tx) => tx.script('CREATE TABLE w (commit_sha TEXT, released_at INTEGER) STRICT;'));
      assert.equal(count(db, 'w'), 0n);
    } finally {
      db.close();
    }
  });
});

describe('errors: a code and SQLite own text, never a bound value', () => {
  it('a failed CHECK is a constraint error whose text names the check, not the value (secrets canary)', () => {
    const db = withTable(memDb(), 'CREATE TABLE s (code TEXT NOT NULL CONSTRAINT short_code CHECK (length(code) <= 8)) STRICT');
    try {
      const secret = 'api_key=SECRET1234567890';
      const e = storageError(() => db.transaction((tx) => tx.run('INSERT INTO s (code) VALUES (?)', secret)), 'constraint');
      assert.equal(e.sqliteCode, 275);
      assert.match(e.detail, /short_code/);
      for (const text of [e.detail, e.message, String(e.stack)]) {
        assert.doesNotMatch(text, /SECRET/);
      }
      assert.equal(e.name, 'StorageError');
    } finally {
      db.close();
    }
  });

  it('a trigger RAISE keeps its text, and INSERT OR REPLACE cannot delete a row past a no-delete trigger (recursive triggers on)', () => {
    const db = withTable(
      memDb(),
      "CREATE TABLE ao (id TEXT PRIMARY KEY, v TEXT) STRICT;\nCREATE TRIGGER ao_no_delete BEFORE DELETE ON ao BEGIN SELECT RAISE(ABORT, 'ao rows are never deleted'); END;",
    );
    try {
      db.transaction((tx) => tx.run("INSERT INTO ao (id, v) VALUES ('k', 'one')"));
      for (const sql of ["DELETE FROM ao WHERE id = 'k'", "INSERT OR REPLACE INTO ao (id, v) VALUES ('k', 'two')"]) {
        const e = storageError(() => db.transaction((tx) => tx.run(sql)), 'constraint');
        assert.equal(e.detail, 'ao rows are never deleted');
        assert.equal(e.sqliteCode, 1811);
      }
      assert.deepEqual({ ...db.get('SELECT id, v FROM ao') }, { id: 'k', v: 'one' });
    } finally {
      db.close();
    }
  });

  it('other failures map to their codes: syntax (other), read-only file (readonly), closed connection (closed), unknown errors (other)', () => {
    inDir((dir) => {
      const db = memDb();
      try {
        const syntax = storageError(() => db.get('SELECT FROM WHERE'), 'other');
        assert.equal(syntax.sqliteCode, 1);
      } finally {
        db.close();
      }
      const file = path.join(dir, 'bot.sqlite');
      withTable(fileDb(file)).close();
      const ro = wrapConnection(rawDb(file, { readOnly: true }), file, false);
      try {
        const e = storageError(() => ro.transaction((tx) => tx.run("INSERT INTO t (id) VALUES ('a')")), 'readonly');
        assert.equal(e.sqliteCode, 8);
      } finally {
        ro.close();
      }
      const real = rawDb(':memory:');
      const gone = wrapConnection(real, ':memory:', false);
      real.close();
      storageError(() => gone.get('SELECT 1 AS one'), 'closed');
      const odd = wrapConnection(
        fakeOver(rawDb(':memory:'), {
          prepare: () => {
            throw new TypeError('something unexpected');
          },
        }),
        ':memory:',
        false,
      );
      const other = storageError(() => odd.get('SELECT 1 AS one'), 'other');
      assert.equal(other.sqliteCode, null);
      odd.close();
      const thrown = wrapConnection(
        fakeOver(rawDb(':memory:'), {
          prepare: () => {
            throw 'a plain string'; // what an odd library might throw
          },
        }),
        ':memory:',
        false,
      );
      assert.equal(storageError(() => thrown.get('SELECT 1 AS one'), 'other').detail, 'a plain string');
      thrown.close();
    });
  });

  it('error text is printable ASCII and short, whatever SQLite said', () => {
    const real = rawDb(':memory:');
    const db = wrapConnection(
      fakeOver(real, {
        prepare: () => {
          throw Object.assign(new Error(`bad\nline‮${'x'.repeat(500)}`), { code: 'ERR_SQLITE_ERROR', errcode: 1 });
        },
      }),
      ':memory:',
      false,
    );
    try {
      const e = storageError(() => db.get('SELECT 1 AS one'), 'other');
      assert.match(e.detail, /^[\x20-\x7e]*$/);
      assert.ok(e.detail.length <= 200, String(e.detail.length));
      assert.ok(e.message.includes(e.detail));
    } finally {
      db.close();
    }
  });
});

describe('vacuumInto, quickCheck, foreignKeyCheck and close', () => {
  it('vacuumInto writes a consistent copy that only the owner can read, and never overwrites a file', (t) => {
    inDir((dir) => {
      const db = withTable(fileDb(path.join(dir, 'bot.sqlite')));
      try {
        db.transaction((tx) => tx.run("INSERT INTO t (id, n) VALUES ('a', 1)"));
        const copy = path.join(dir, 'pre-migration-v0-v1-20261113T120000Z.sqlite');
        db.vacuumInto(copy);
        if (POSIX) {
          assert.equal(statSync(copy).mode & 0o777, 0o600);
        } else {
          t.diagnostic('file mode not checked on Windows');
        }
        const c = fileDb(copy, false);
        try {
          assert.deepEqual(c.quickCheck(), []);
          assert.equal(dump(c), dump(db));
        } finally {
          c.close();
        }
        const before = readFileSync(copy);
        storageError(() => db.vacuumInto(copy), 'io');
        assert.deepEqual(readFileSync(copy), before, 'the existing file is untouched');
        for (const target of ['copy.sqlite', ':memory:', `${copy}\0`, '']) {
          storageError(() => db.vacuumInto(target), 'bad-option');
        }
        storageError(() => db.vacuumInto(path.join(dir, 'no-such-folder', 'copy.sqlite')), 'io');
      } finally {
        db.close();
      }
    });
  });

  it('a VACUUM INTO that fails leaves no partial copy behind', () => {
    inDir((dir) => {
      const real = rawDb(':memory:');
      const db = wrapConnection(
        fakeOver(real, {
          prepare: (sql) => {
            if (sql.startsWith('VACUUM INTO')) {
              throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
            }
            return real.prepare(sql);
          },
        }),
        ':memory:',
        false,
      );
      try {
        const target = path.join(dir, 'copy.sqlite');
        storageError(() => db.vacuumInto(target), 'full');
        assert.equal(existsSync(target), false);
      } finally {
        db.close();
      }
    });
  });

  it('quickCheck: [] when healthy; a damaged page header throws corrupt; damage inside a page is listed, and reading it throws corrupt', () => {
    inDir((dir) => {
      const file = path.join(dir, 'bot.sqlite');
      const db = withTable(fileDb(file), 'CREATE TABLE big (id INTEGER PRIMARY KEY, v TEXT NOT NULL) STRICT');
      for (let i = 0; i < 300; i += 1) {
        db.transaction((tx) => tx.run('INSERT INTO big (v) VALUES (?)', 'x'.repeat(200)));
      }
      assert.deepEqual(db.quickCheck(), []);
      const damaged = (name: string, offset: number): Db => {
        const copy = path.join(dir, name);
        db.vacuumInto(copy);
        const fd = openSync(copy, 'r+');
        writeSync(fd, Buffer.alloc(512, 0xee), 0, 512, offset);
        closeSync(fd);
        return fileDb(copy, false);
      };
      const header = damaged('header.sqlite', 4096 * 3);
      try {
        const e = storageError(() => header.quickCheck(), 'corrupt');
        assert.equal(e.sqliteCode, 11);
        storageError(() => header.all('SELECT v FROM big'), 'corrupt');
      } finally {
        header.close();
      }
      const inside = damaged('inside.sqlite', 4096 * 7 + 2000);
      try {
        const problems = inside.quickCheck();
        assert.ok(problems.length > 1, problems.join(' | '));
        for (const p of problems) {
          assert.match(p, /^[\x20-\x7e]+$/);
        }
        assert.ok(problems.some((p) => /page 8/.test(p)), problems.join(' | '));
        storageError(() => inside.all('SELECT v FROM big'), 'corrupt');
      } finally {
        inside.close();
      }
      db.close();
    });
  });

  it('foreignKeyCheck lists rows whose parent is missing (written while the checks were off) and is [] otherwise', () => {
    inDir((dir) => {
      const file = path.join(dir, 'bot.sqlite');
      const db = withTable(
        fileDb(file),
        'CREATE TABLE parent (id TEXT PRIMARY KEY) STRICT;\nCREATE TABLE child (id TEXT PRIMARY KEY, p TEXT NOT NULL REFERENCES parent (id)) STRICT;',
      );
      assert.deepEqual(db.foreignKeyCheck(), []);
      db.close();
      const raw = new DatabaseSync(file, { ...RAW_OPTIONS, enableForeignKeyConstraints: false });
      raw.exec("INSERT INTO child (id, p) VALUES ('c', 'nobody')");
      raw.close();
      const again = fileDb(file, false);
      try {
        assert.deepEqual(again.foreignKeyCheck(), ['child: row 1 has no parent in parent (constraint 0)']);
        storageError(() => again.transaction((tx) => tx.run("INSERT INTO child (id, p) VALUES ('d', 'nobody')")), 'constraint');
      } finally {
        again.close();
      }
    });
  });

  it('close is idempotent; a closed handle refuses everything (closed)', () => {
    inDir((dir) => {
      const db = withTable(memDb());
      db.close();
      db.close();
      const calls: (() => unknown)[] = [
        () => db.transaction(() => 1),
        () => db.get('SELECT 1 AS one'),
        () => db.all('SELECT 1 AS one'),
        () => db.quickCheck(),
        () => db.foreignKeyCheck(),
        () => db.vacuumInto(path.join(dir, 'copy.sqlite')),
      ];
      for (const call of calls) {
        storageError(call, 'closed');
      }
    });
  });

  it('a close that fails still marks the handle closed', () => {
    const real = rawDb(':memory:');
    const db = wrapConnection(
      fakeOver(real, {
        close: () => {
          real.close();
          throw new Error('close failed');
        },
      }),
      ':memory:',
      false,
    );
    storageError(() => db.close(), 'other');
    storageError(() => db.get('SELECT 1 AS one'), 'closed');
    db.close();
  });
});

describe('the authorizer: SQLite itself refuses what the text checks are there to stop (security condition 8b)', () => {
  const OK = constants.SQLITE_OK;
  const DENY = constants.SQLITE_DENY;
  type Case = readonly [AuthScope, number, string | null, string | null, string | null, number];

  it('statements read and write the bot rows and call functions; migration scripts also change the schema; the wrapper alone does the rest', () => {
    const c = constants;
    const cases: Case[] = [
      ['statement', c.SQLITE_SELECT, null, null, null, OK],
      ['statement', c.SQLITE_READ, 'positions', 'mint', 'main', OK],
      ['statement', c.SQLITE_READ, 'sqlite_master', 'name', 'main', OK], // the runner reads the schema
      ['statement', c.SQLITE_INSERT, 'positions', null, 'main', OK],
      ['statement', c.SQLITE_UPDATE, 'positions', 'status', 'main', OK],
      ['statement', c.SQLITE_DELETE, 'halt_reasons', null, 'main', OK],
      ['statement', c.SQLITE_FUNCTION, null, 'coalesce', null, OK],
      ['script', c.SQLITE_CREATE_TABLE, 'x', null, 'main', OK],
      ['script', c.SQLITE_CREATE_INDEX, 'x_i', 'x', 'main', OK],
      ['script', c.SQLITE_CREATE_TRIGGER, 'x_t', 'x', 'main', OK],
      ['script', c.SQLITE_DROP_TABLE, 'x', null, 'main', OK],
      ['script', c.SQLITE_DROP_INDEX, 'x_i', 'x', 'main', OK],
      ['script', c.SQLITE_DROP_TRIGGER, 'x_t', 'x', 'main', OK],
      ['script', c.SQLITE_REINDEX, 'x_i', null, 'main', OK], // reported while a partial index is built
      ['statement', c.SQLITE_REINDEX, 'x_i', null, 'main', DENY],
      ['script', c.SQLITE_INSERT, 'sqlite_master', null, 'main', OK], // what DDL writes
      ['script', c.SQLITE_UPDATE, 'sqlite_master', 'sql', 'main', OK],
      ['script', c.SQLITE_INSERT, 'flags', null, 'main', OK], // a migration's starting rows
      ['wrapper', c.SQLITE_TRANSACTION, 'BEGIN', null, null, OK],
      ['wrapper', c.SQLITE_PRAGMA, 'journal_mode', null, null, OK],
      ['wrapper', c.SQLITE_ATTACH, '/tmp/copy.sqlite', null, null, OK],
      ['wrapper', 99, null, null, null, OK],
      // never the schema outside a migration script
      ['statement', c.SQLITE_CREATE_TABLE, 'x', null, 'main', DENY],
      ['statement', c.SQLITE_CREATE_TRIGGER, 'x_t', 'x', 'main', DENY],
      ['statement', c.SQLITE_DROP_TABLE, 'audit_log', null, 'main', DENY],
      ['statement', c.SQLITE_ALTER_TABLE, 'main', 'flags', null, DENY],
      ['script', c.SQLITE_ALTER_TABLE, 'main', 'x', null, DENY], // a migration that needs ALTER brings a reviewed change first
      ['script', c.SQLITE_ALTER_TABLE, 'main', 't', 'b', DENY], // DROP COLUMN as SQLite really sends it
      // never the system tables, never another database
      ['statement', c.SQLITE_INSERT, 'sqlite_master', null, 'main', DENY],
      ['statement', c.SQLITE_UPDATE, 'sqlite_stat1', 'stat', 'main', DENY],
      ['statement', c.SQLITE_DELETE, 'SQLITE_MASTER', null, 'main', DENY],
      ['script', c.SQLITE_INSERT, 'sqlite_stat1', null, 'main', DENY],
      ['statement', c.SQLITE_READ, 'x', 'a', 'temp', DENY],
      ['statement', c.SQLITE_INSERT, 'x', null, 'other', DENY],
      ['script', c.SQLITE_CREATE_TABLE, 'x', null, 'temp', DENY],
      // the wrapper's own work only: settings, transactions, files
      ['statement', c.SQLITE_PRAGMA, 'ignore_check_constraints', '1', null, DENY],
      ['script', c.SQLITE_PRAGMA, 'recursive_triggers', 'OFF', null, DENY],
      ['statement', c.SQLITE_PRAGMA, 'optimize', '65538', null, DENY], // 'pragma_optimize'(65538)
      ['statement', c.SQLITE_TRANSACTION, 'COMMIT', null, null, DENY],
      ['script', c.SQLITE_TRANSACTION, 'BEGIN', null, null, DENY],
      ['statement', c.SQLITE_SAVEPOINT, 'BEGIN', 's1', null, DENY],
      ['statement', c.SQLITE_ATTACH, '/tmp/other.sqlite', null, null, DENY],
      ['script', c.SQLITE_DETACH, 'other', null, null, DENY],
      // what the bot never uses, even in a migration
      ['script', c.SQLITE_CREATE_TEMP_TABLE, 'x', null, 'temp', DENY],
      ['script', c.SQLITE_CREATE_TEMP_TRIGGER, 'x_t', 'x', 'temp', DENY],
      ['script', c.SQLITE_CREATE_VIEW, 'v', null, 'main', DENY],
      ['script', c.SQLITE_CREATE_VTABLE, 'v', 'fts5', 'main', DENY],
      ['statement', c.SQLITE_ANALYZE, 'positions', null, 'main', DENY],
      ['statement', c.SQLITE_RECURSIVE, null, null, null, DENY],
      ['statement', 99, null, null, null, DENY], // an action SQLite might add later
      ['script', 0, null, null, null, DENY],
    ];
    for (const [scope, action, a, b, dbName, want] of cases) {
      assert.equal(authorize(scope, action, a, b, dbName), want, `${scope} ${action} ${String(a)} ${String(b)} ${String(dbName)}`);
    }
  });

  it('is installed on the connection itself: a statement that skips the wrapper and its text checks is still refused', () => {
    const real = rawDb(':memory:');
    const db = wrapConnection(real, ':memory:', false);
    try {
      const refusedRaw = (run: () => unknown, what: string): void => {
        assert.throws(run, (e: unknown) => (e as { errcode?: unknown }).errcode === 23, what);
      };
      const before = db.settings();
      for (const sql of [
        'PRAGMA ignore_check_constraints = 1',
        'PRAGMA recursive_triggers = OFF',
        'PRAGMA journal_mode',
        'BEGIN',
        'SAVEPOINT s1',
        'ATTACH DATABASE ? AS other',
        'CREATE TABLE x (a INTEGER) STRICT',
        'CREATE TEMP TABLE y (a INTEGER)',
        'ANALYZE',
      ]) {
        refusedRaw(() => real.prepare(sql), sql);
      }
      // a pragma_ table function is checked when it runs, not when it is prepared (VERIFIED_FACTS)
      refusedRaw(() => real.prepare("SELECT 1 FROM 'pragma_optimize'(65538)").all(), 'pragma_optimize');
      refusedRaw(() => real.prepare('SELECT cid FROM pragma_table_info(?)').all('t'), 'pragma_table_info');
      assert.equal(real.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'sqlite_stat1'").get()?.['n'], 0n); // ANALYZE never ran
      refusedRaw(() => real.exec('PRAGMA ignore_check_constraints = 1'), 'exec');
      inDir((dir) => refusedRaw(() => real.prepare('VACUUM INTO ?').run(path.join(dir, 'copy.sqlite')), 'VACUUM INTO'));
      assert.equal(real.isTransaction, false);
      // nothing the refused statements tried took effect; the wrapper's own work still runs, and each time the scope goes back
      assert.deepEqual(db.settings(), before);
      assert.equal(setting(db, 'ignore_check_constraints'), 0n);
      withTable(db);
      db.transaction((tx) => tx.run("INSERT INTO t (id, n) VALUES ('a', 1)"));
      assert.deepEqual(db.quickCheck(), []);
      assert.deepEqual(db.foreignKeyCheck(), []);
      inDir((dir) => db.vacuumInto(path.join(dir, 'copy.sqlite')));
      storageError(() => db.transaction(() => { throw new StorageError('other', 'a failing callback'); }), 'other'); // its ROLLBACK runs as the wrapper
      storageError(() => db.transaction((tx) => tx.script('CREATE TABLE w (a INTEGER) STRICT;\nCREATE TABLE w (a INTEGER) STRICT;')), 'other'); // a script that fails
      for (const sql of ['PRAGMA ignore_check_constraints = 1', 'CREATE TABLE z (a INTEGER) STRICT', 'BEGIN']) {
        refusedRaw(() => real.prepare(sql), `${sql} (after the wrapper ran)`);
      }
      assert.equal(count(db, 't'), 1n);
    } finally {
      db.close();
    }
  });

  it('a denial through the wrapper is the code "denied" with SQLite code 23: temporary tables, views, virtual tables, recursive queries and other databases', () => {
    const db = memDb();
    try {
      withTable(db);
      for (const script of ['CREATE TEMP TABLE x (a INTEGER)', 'CREATE VIEW v AS SELECT 1 AS one', 'CREATE VIRTUAL TABLE f USING fts5(a)', 'CREATE TEMP TRIGGER tt AFTER INSERT ON t BEGIN SELECT 1; END']) {
        const e = storageError(() => db.transaction((tx) => tx.script(script)), 'denied');
        assert.equal(e.sqliteCode, 23, script);
      }
      // every ALTER TABLE form, as SQLite really runs it (review Q, security 3): refused, the table unchanged
      for (const script of ['ALTER TABLE t ADD COLUMN c TEXT', 'ALTER TABLE t RENAME TO t2', 'ALTER TABLE t RENAME COLUMN n TO n2', 'ALTER TABLE t DROP COLUMN n']) {
        storageError(() => db.transaction((tx) => tx.script(script)), 'denied');
      }
      assert.equal(db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 't'")?.['sql'], T_DDL);
      assert.equal(db.get("SELECT count(*) AS n FROM sqlite_master WHERE name = 't2'")?.['n'], 0n);
      const recursive = 'SELECT x FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3) SELECT x FROM c)';
      storageError(() => db.all(recursive), 'denied');
      storageError(() => db.all('SELECT name FROM temp.sqlite_master'), 'denied');
      storageError(() => db.transaction((tx) => tx.get(recursive)), 'denied');
      assert.equal(db.get("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('x', 'v', 'f', 'tt')")?.['n'], 0n);
    } finally {
      db.close();
    }
  });

  it('a trigger that writes works under it; a statement that writes the schema table does not', () => {
    // the schema tests apply migration 1 under the authorizer on every run
    const db = memDb();
    try {
      db.transaction((tx) =>
        tx.script('CREATE TABLE a (n INTEGER NOT NULL) STRICT;\nCREATE TABLE b (n INTEGER NOT NULL) STRICT;\nCREATE TRIGGER a_copy AFTER INSERT ON a BEGIN INSERT INTO b (n) VALUES (NEW.n); END;'),
      );
      db.transaction((tx) => tx.run('INSERT INTO a (n) VALUES (?)', 5n));
      assert.equal(db.get('SELECT n FROM b')?.['n'], 5n);
      storageError(() => db.transaction((tx) => tx.run('INSERT INTO sqlite_master (type) VALUES (?)', 'x')), 'denied');
    } finally {
      db.close();
    }
  });
});
