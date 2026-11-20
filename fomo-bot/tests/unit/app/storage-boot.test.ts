// The boot (STORAGE_DESIGN.md s.16.6; conditions C7, C12, C14, C15, C17, C19, C26, C35, C36, C48 and
// review T's conditions for 6d-3): every refusal on its own, each warning, the stale openings both
// ways, KILL at boot, and the Windows, UNC, OneDrive and file-system cases through a fake probe. Each
// refusal closes the database and alerts with its code. Written before src/app/storage-boot.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { approveBuyTx } from '../../../src/app/approve-tx.ts';
import { BOOT_REFUSALS, BootError, LOCAL_FILE_SYSTEMS, bootStorage, checkDataPath, type BootOptions, type BootRefusal } from '../../../src/app/storage-boot.ts';
import { nodeFsProbe, type FsProbe } from '../../../src/app/run-files.ts';
import { MAX_TIMESTAMP_MS } from '../../../src/core/time.ts';
import { lamports } from '../../../src/core/units.ts';
import { insertOpening, readPosition } from '../../../src/storage/repo-book.ts';
import { buyOrderOf } from '../../../src/storage/repo-orders.ts';
import { readFlags, setHalt, setKill } from '../../../src/storage/repo-flags.ts';
import { verifyAuditChain } from '../../../src/storage/repo-audit.ts';
import { setUpConfig } from '../../../src/storage/repo-server.ts';
import type { Db } from '../../../src/storage/sqlite.ts';
import { firstVersion } from '../../../src/config/changes.ts';
import { DEFAULT_TUNABLES } from '../../../src/config/tunables.ts';
import { fileDb, migratedDb, rawDb, removeDir, tempDir } from '../storage/helpers.ts';
import { T, recordingAlerts, setUpDb, testClock, testSentinel, type RecordingAlerts, type TestClock, type TestSentinel } from './world.ts';
import { entryRequest, memoryAnchors, txWorld, type MemoryAnchors } from './tx-world.ts';

interface BootWorld {
  readonly dir: string;
  readonly file: string;
  readonly options: BootOptions;
  readonly alerts: RecordingAlerts;
  readonly anchors: MemoryAnchors;
  readonly sentinel: TestSentinel;
  readonly clock: TestClock;
}

/** A data folder with a set-up database (closed again), its two folders, and the boot's options. */
function bootWorld(prepare: (db: Db, file: string) => void = () => undefined, setUp: (file: string) => Db = setUpDb): BootWorld {
  const dir = realpathSync(tempDir('fomo-boot-'));
  mkdirSync(path.join(dir, 'run'), { mode: 0o700 });
  mkdirSync(path.join(dir, 'db-copies'), { mode: 0o700 });
  const file = path.join(dir, 'bot.sqlite');
  const db = setUp(file);
  prepare(db, file);
  db.close();
  const alerts = recordingAlerts();
  const anchors = memoryAnchors();
  const sentinel = testSentinel();
  const clock = testClock(T + 60_000);
  const options: BootOptions = {
    dataDir: dir,
    dbFile: 'bot.sqlite',
    copyDir: 'db-copies',
    runDir: 'run',
    platform: process.platform,
    uid: process.getuid?.() ?? null,
    windows: { userProfile: null, oneDriveRoots: [] },
    nodeVersion: 'v26.13.0',
    busyTimeoutMs: 100,
    clock,
    fs: nodeFsProbe,
    runLock: { held: true },
    sentinel,
    anchors,
    alerts,
  };
  return { dir, file, options, alerts, anchors, sentinel, clock };
}

/** Changes rows the database's own triggers guard, by lifting the triggers for the change: a stand-in for a damaged or hand-edited file. */
function underTriggers(file: string, table: string, sql: string): void {
  const raw = rawDb(file);
  try {
    const triggers = raw.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ?").all(table) as { name: string; sql: string }[];
    raw.exec('PRAGMA foreign_keys = OFF');
    raw.exec('BEGIN');
    for (const t of triggers) {
      raw.exec(`DROP TRIGGER "${t.name}"`);
    }
    raw.exec(sql);
    for (const t of triggers) {
      raw.exec(t.sql);
    }
    raw.exec('COMMIT');
  } finally {
    raw.close();
  }
}

/** The descriptors of this process that point at the file (Linux): a refused boot leaves none. */
const openHandles = (file: string): number =>
  readdirSync('/proc/self/fd').filter((fd) => {
    try {
      return readlinkSync(`/proc/self/fd/${fd}`) === file;
    } catch {
      return false;
    }
  }).length;

function refusal(w: BootWorld, over: Partial<BootOptions> = {}): BootRefusal {
  let got: BootRefusal | null = null;
  assert.throws(
    () => bootStorage({ ...w.options, ...over }),
    (e: unknown) => {
      if (!(e instanceof BootError)) {
        return false;
      }
      got = e.refusal;
      assert.equal(e.code, `boot:${e.refusal}`);
      return true;
    },
  );
  assert.ok(w.alerts.seen.some((a) => a.code === `boot:${String(got)}` && a.severity === 'fatal'), 'the refusal alerts with its code');
  if (process.platform === 'linux') {
    assert.equal(openHandles(w.file), 0, 'the database is closed');
  }
  return got as unknown as BootRefusal;
}

function withBoot(w: BootWorld, fn: (w: BootWorld) => void): void {
  try {
    fn(w);
  } finally {
    removeDir(w.dir);
  }
}

const POSIX = process.platform !== 'win32';

describe('the boot: a healthy start', { skip: !POSIX }, () => {
  it('opens, checks and reports; the first start warns that no anchor exists, then writes it; folders 0700, files 0600', () => {
    withBoot(bootWorld(), (w) => {
      const { db, report, latch } = bootStorage(w.options);
      try {
        const chain = verifyAuditChain(db);
        assert.deepEqual(
          { ...report, halts: [...report.halts], abandoned: [...report.abandoned], openingsWithOrders: [...report.openingsWithOrders], warnings: [...report.warnings] },
          { schemaVersion: 1, auditNewestId: chain.newestId, auditNewestHash: chain.newestHash, killOn: false, halts: [], abandoned: [], openingsWithOrders: [], warnings: ['no-audit-anchor'] },
        );
        assert.deepEqual(w.anchors.written, [{ id: chain.newestId, hash: chain.newestHash, at: chain.newestAt }]);
        assert.deepEqual(latch.blocked(), []);
        assert.equal(latch.killSeen(), false);
        assert.ok(w.alerts.seen.some((a) => a.code === 'no-audit-anchor' && a.severity === 'warn'));
        assert.deepEqual(w.alerts.seen.at(-1), { code: 'boot-ok', severity: 'info', codes: [`audit:${chain.newestId}`, chain.newestHash] }, 'the anchor in the boot alert (review T)');
        for (const d of [w.dir, path.join(w.dir, 'run'), path.join(w.dir, 'db-copies')]) {
          assert.equal(statSync(d).mode & 0o777, 0o700, d);
        }
        assert.equal(statSync(w.file).mode & 0o777, 0o600);
        assert.ok(Object.isFrozen(report));
      } finally {
        db.close();
      }
      // the next start finds its anchor and warns about nothing
      const again = bootStorage(w.options);
      assert.deepEqual([...again.report.warnings], []);
      again.db.close();
    });
  });

  it('KILL stored or the KILL file: KILL on, seen by the latch; the file stores KILL (source sentinel); halts listed', () => {
    withBoot(
      bootWorld((db) => {
        db.transaction((tx) => setHalt(tx, 'disk-db', T));
      }),
      (w) => {
        w.sentinel.on = true;
        const { db, report, latch } = bootStorage(w.options);
        try {
          assert.equal(report.killOn, true);
          assert.deepEqual([...report.halts], ['disk-db']);
          assert.equal(latch.killSeen(), true);
          assert.equal(readFlags(db).kill?.source, 'sentinel');
          assert.equal(w.anchors.written.at(-1)?.id, verifyAuditChain(db).newestId, 'the anchor names the KILL row');
        } finally {
          db.close();
        }
      },
    );
    withBoot(
      bootWorld((db) => {
        db.transaction((tx) => setKill(tx, T, 'cli'));
      }),
      (w) => {
        const { db, report, latch } = bootStorage(w.options);
        assert.equal(report.killOn, true);
        assert.equal(latch.killSeen(), true);
        db.close();
      },
    );
  });

  it('stale openings: one with no buy order is abandoned at max(now, opened_at); one with an order stays counted, with a warning (C48)', () => {
    withBoot(
      bootWorld((db) => {
        db.transaction((tx) => insertOpening(tx, { id: 'ps_stale', mint: 'MintS', strategy: 'momentum', mode: 'paper', openedAt: T + 120_000, maxSpend: lamports(30_000_000n) }, lamports(125_000n)));
        const t = txWorld(db);
        assert.equal(approveBuyTx(t.deps, entryRequest()).kind, 'approved');
      }),
      (w) => {
        // the order of the second opening: what T2 wrote, by hand (a redeem needs the old process's key)
        underTriggers(
          w.file,
          'orders',
          "INSERT INTO orders (id, intent_id, token_id, position_id, mode, kind, status, plan_hash, plan_json, in_amount, min_out, max_spend, quote_slot, created_at, updated_at) SELECT 'or_1', a.intent_id, a.token_id, a.position_id, a.mode, a.kind, 'approved', a.plan_hash, '{}', '55000000', a.min_out, a.max_spend, a.quote_slot, a.issued_at, a.issued_at FROM approvals AS a WHERE a.position_id = 'ps_new1'",
        );
        const { db, report } = bootStorage(w.options);
        try {
          assert.deepEqual([...report.abandoned], ['ps_stale']);
          assert.deepEqual([...report.openingsWithOrders], ['ps_new1']);
          assert.ok(report.warnings.includes('opening-with-order'));
          const stale = readPosition(db, 'ps_stale');
          assert.equal(stale.status, 'closed');
          assert.equal(stale.closedAt, T + 120_000, 'booked at opened_at, ahead of the clock');
          assert.equal(readPosition(db, 'ps_new1').status, 'opening');
        } finally {
          db.close();
        }
      },
    );
  });

  it('a buy token an old process still holds (the run lock broken) is refused once the boot abandoned its position: the database closes the door, no order (review T, security 3)', () => {
    withBoot(bootWorld(), (w) => {
      const old = fileDb(w.file, false); // the old process, still alive, with its own key and a token valid at its slot
      try {
        const t = txWorld(old);
        const o = approveBuyTx(t.deps, entryRequest());
        assert.equal(o.kind, 'approved');
        const { db, report } = bootStorage(w.options);
        try {
          assert.deepEqual([...report.abandoned], ['ps_new1']);
        } finally {
          db.close();
        }
        if (o.kind === 'approved') {
          assert.equal(t.authority.redeemer.redeem(o.token, o.plan).ok, false);
        }
        assert.equal(buyOrderOf(old, 'ps_new1'), null);
        assert.equal(readPosition(old, 'ps_new1').status, 'closed');
      } finally {
        old.close();
      }
    });
  });

  it('a clock behind the newest audit row only warns (C26), even at the largest time', () => {
    withBoot(
      bootWorld((db) => {
        db.transaction((tx) => setHalt(tx, 'from-the-future', MAX_TIMESTAMP_MS));
      }),
      (w) => {
        const { db, report } = bootStorage(w.options);
        assert.ok(report.warnings.includes('clock-behind-audit'));
        assert.ok(w.alerts.seen.some((a) => a.code === 'clock-behind-audit' && a.severity === 'warn'));
        db.close();
      },
    );
  });

  it('an anchor that cannot be written only warns', () => {
    withBoot(bootWorld(), (w) => {
      w.anchors.failing = true;
      const { db, report } = bootStorage(w.options);
      assert.ok(report.warnings.includes('anchor-write-failed'));
      db.close();
    });
  });

  it('an alert sink that throws latches entries as a bug; the start goes on, and a refusal still throws its BootError', () => {
    withBoot(bootWorld(), (w) => {
      const alerts = { alert: (): never => assert.fail('the sink is down') };
      const { db, latch } = bootStorage({ ...w.options, alerts });
      try {
        assert.deepEqual([...latch.blocked()], ['bug']);
      } finally {
        db.close();
      }
      assert.throws(
        () => bootStorage({ ...w.options, alerts, runLock: { held: false } as unknown as BootOptions['runLock'] }),
        (e: unknown) => e instanceof BootError && e.refusal === 'run-lock',
      );
    });
  });
});

describe('the boot: every refusal on its own', { skip: !POSIX }, () => {
  it('lists its refusals', () => {
    assert.deepEqual(
      [...BOOT_REFUSALS],
      ['runtime-not-frozen', 'run-lock', 'path', 'open', 'health', 'migrations', 'required-rows', 'config', 'audit-chain', 'audit-anchor', 'kill-link', 'halt-link', 'book', 'conservation', 'paper-account', 'live-account', 'abandon', 'sentinel'],
    );
  });

  it('runtime-not-frozen: built-ins that can be changed (a child process without --frozen-intrinsics, C7)', () => {
    withBoot(bootWorld(), (w) => {
      const url = (rel: string): string => pathToFileURL(path.resolve(import.meta.dirname, rel)).href;
      const script = path.join(w.dir, 'unfrozen.mjs');
      writeFileSync(
        script,
        [
          `import { bootStorage, BootError } from ${JSON.stringify(url('../../../src/app/storage-boot.ts'))};`,
          `import { nodeFsProbe } from ${JSON.stringify(url('../../../src/app/run-files.ts'))};`,
          'const alerts = { alert: () => undefined };',
          `const o = { dataDir: ${JSON.stringify(w.dir)}, dbFile: 'bot.sqlite', copyDir: 'db-copies', runDir: 'run', platform: process.platform, uid: process.getuid(), windows: { userProfile: null, oneDriveRoots: [] }, nodeVersion: 'v26.13.0', busyTimeoutMs: 100, clock: { now: () => ${T} }, fs: nodeFsProbe, runLock: { held: true }, sentinel: { present: () => false }, anchors: { read: () => null, write: () => undefined }, alerts };`,
          'try { bootStorage(o); console.log("booted"); } catch (e) { console.log(e instanceof BootError ? e.refusal : String(e)); }',
        ].join('\n'),
      );
      const r = spawnSync(process.execPath, ['--no-warnings', '--import', url('../../setup/no-secrets.ts'), script], { encoding: 'utf8' });
      assert.equal(r.stdout.trim(), 'runtime-not-frozen', r.stderr);
    });
  });

  it('run-lock: the boot needs the run lock held', () => {
    withBoot(bootWorld(), (w) => {
      assert.equal(refusal(w, { runLock: { held: false } as unknown as BootOptions['runLock'] }), 'run-lock');
    });
  });

  it('path: a relative folder, a file name that is a path, a missing folder, a link anywhere, a hard link, a foreign owner, a failed chmod, a file system off the list', () => {
    withBoot(bootWorld(), (w) => {
      assert.equal(refusal(w, { dataDir: 'relative/dir' }), 'path');
      // a path, a dot name, a trailing dot (Windows drops it), a Windows device name whatever its extension
      for (const name of ['sub/bot.sqlite', '..', '', '.', 'bot.sqlite.', 'NUL', 'con.sqlite', 'Lpt1.db']) {
        assert.equal(refusal(w, { dbFile: name }), 'path', name);
      }
      assert.equal(refusal(w, { runDir: 'db-copies' }), 'path', 'the run folder is the copy folder');
      assert.equal(refusal(w, { runDir: 'missing' }), 'path');
      const link = `${w.dir}-link`;
      symlinkSync(w.dir, link);
      try {
        assert.equal(refusal(w, { dataDir: link }), 'path', 'a linked data folder');
      } finally {
        removeDir(link);
      }
      const other = (patch: Partial<ReturnType<FsProbe['lstat']> & object>, at = w.file): FsProbe => ({
        ...nodeFsProbe,
        lstat: (p) => {
          const real = nodeFsProbe.lstat(p);
          return p === at && real !== null ? { ...real, ...patch } : real;
        },
      });
      assert.equal(refusal(w, { fs: other({ isSymbolicLink: true }) }), 'path', 'a linked database file');
      assert.equal(refusal(w, { fs: other({ nlink: 2 }) }), 'path', 'a hard-linked database file (review T)');
      assert.equal(refusal(w, { fs: other({ uid: 12_345 }) }), 'path', 'a database owned by someone else');
      assert.equal(refusal(w, { fs: other({ uid: 12_345 }, path.join(w.dir, 'run')) }), 'path', 'a run folder owned by someone else');
      assert.equal(refusal(w, { fs: other({ isDirectory: false }, path.join(w.dir, 'db-copies')) }), 'path', 'a copy folder that is not a folder');
      assert.equal(refusal(w, { fs: { ...nodeFsProbe, chmod: () => assert.fail('EPERM') } }), 'path', 'a chmod that fails');
      assert.equal(refusal(w, { uid: null }), 'path', 'no uid to check owners with');
      if (process.platform === 'linux') {
        assert.equal(refusal(w, { fs: { ...nodeFsProbe, fsType: () => 0x6969 } }), 'path', 'NFS');
        assert.equal(refusal(w, { fs: { ...nodeFsProbe, fsType: () => null } }), 'path', 'no type on Linux');
        const mountedAt = (at: string, type: number): FsProbe => ({ ...nodeFsProbe, fsType: (t) => (t === at ? type : nodeFsProbe.fsType(t)) });
        assert.equal(refusal(w, { fs: mountedAt(path.join(w.dir, 'run'), 0x6969) }), 'path', 'NFS mounted on the run folder');
        assert.equal(refusal(w, { fs: mountedAt(w.file, 0x65735546) }), 'path', 'FUSE bind-mounted on the database file');
      }
    });
    withBoot(
      bootWorld((_db, file) => {
        writeFileSync(`${file}-wal`, '');
        linkSync(`${file}-wal`, `${file}-wal-copy`);
      }),
      (w) => {
        assert.equal(refusal(w), 'path', 'a hard-linked -wal');
      },
    );
  });

  it('open: a missing database and a foreign SQLite file (C12)', () => {
    withBoot(bootWorld(), (w) => {
      assert.equal(refusal(w, { dbFile: 'none.sqlite' }), 'open');
      const foreign = path.join(w.dir, 'foreign.sqlite');
      const raw = rawDb(foreign);
      raw.exec('CREATE TABLE t (x)');
      raw.close();
      assert.equal(refusal(w, { dbFile: 'foreign.sqlite' }), 'open');
    });
  });

  it('health: a foreign-key violation (C14)', () => {
    withBoot(
      bootWorld((db) => {
        assert.equal(approveBuyTx(txWorld(db).deps, entryRequest()).kind, 'approved');
      }),
      (w) => {
        // the decision names a config version that is not there (the CHECKs allow it; only the key fails)
        underTriggers(w.file, 'risk_decisions', 'UPDATE risk_decisions SET config_version = 99');
        assert.equal(refusal(w), 'health');
      },
    );
  });

  it('migrations: a migration changed after it ran', () => {
    withBoot(bootWorld(), (w) => {
      underTriggers(w.file, 'schema_migrations', "UPDATE schema_migrations SET sha256 = '00' || substr(sha256, 3) WHERE version = 1");
      assert.equal(refusal(w), 'migrations');
    });
  });

  it('required-rows: no ledger accounts (the owner setup was not finished, C19)', () => {
    const setUpConfigOnly = (file: string): Db => {
      const db = migratedDb(file);
      db.transaction((tx) => setUpConfig(tx, T, firstVersion(DEFAULT_TUNABLES, T)));
      return db;
    };
    withBoot(bootWorld(() => undefined, setUpConfigOnly), (w) => {
      assert.equal(refusal(w), 'required-rows');
    });
  });

  it('config: a stored version that does not decode', () => {
    withBoot(bootWorld(), (w) => {
      underTriggers(w.file, 'config_versions', "UPDATE config_versions SET values_json = '{}' WHERE id = 1");
      assert.equal(refusal(w), 'config');
    });
  });

  it('audit-chain: a row changed behind the chain (C17)', () => {
    withBoot(bootWorld(), (w) => {
      underTriggers(w.file, 'audit_log', "UPDATE audit_log SET detail_json = '{\"edited\":true}' WHERE id = 1");
      assert.equal(refusal(w), 'audit-chain');
    });
  });

  it('audit-chain: an audit log with every row gone (an empty chain holds, but the owner setup wrote rows)', () => {
    withBoot(bootWorld(), (w) => {
      underTriggers(w.file, 'audit_log', 'DELETE FROM audit_log');
      assert.equal(refusal(w), 'audit-chain');
    });
  });

  it('audit-anchor: an anchor past the newest row, an anchor whose hash differs, an anchor file that is malformed (C36, s.16.11 Q1)', () => {
    withBoot(bootWorld(), (w) => {
      const chain = (() => {
        const db = fileDb(w.file, false);
        try {
          return verifyAuditChain(db);
        } finally {
          db.close();
        }
      })();
      w.anchors.written.push({ id: chain.newestId + 1, hash: chain.newestHash, at: T });
      assert.equal(refusal(w), 'audit-anchor', 'the log is shorter than when it last ran');
      w.anchors.written.push({ id: chain.newestId, hash: 'ff'.repeat(32), at: T });
      assert.equal(refusal(w), 'audit-anchor', 'an older copy of the database');
      assert.equal(refusal(w, { anchors: { read: () => assert.fail('malformed'), write: () => undefined } }), 'audit-anchor');
    });
  });

  it('kill-link: KILL naming another audit row, or a row of another source (C35)', () => {
    withBoot(
      bootWorld((db) => {
        db.transaction((tx) => setKill(tx, T, 'cli'));
      }),
      (w) => {
        underTriggers(w.file, 'flags', 'UPDATE flags SET kill_audit_id = 1');
        assert.equal(refusal(w), 'kill-link');
      },
    );
    withBoot(
      bootWorld((db) => {
        db.transaction((tx) => setKill(tx, T, 'cli'));
      }),
      (w) => {
        underTriggers(w.file, 'flags', "UPDATE flags SET kill_source = 'telegram'");
        assert.equal(refusal(w), 'kill-link');
      },
    );
  });

  it('halt-link: a halt naming another audit row, or one of another reason (C35)', () => {
    withBoot(
      bootWorld((db) => {
        db.transaction((tx) => setHalt(tx, 'disk-db', T));
      }),
      (w) => {
        underTriggers(w.file, 'halt_reasons', 'UPDATE halt_reasons SET set_audit_id = 1');
        assert.equal(refusal(w), 'halt-link');
      },
    );
    withBoot(
      bootWorld((db) => {
        db.transaction((tx) => setHalt(tx, 'disk-db', T));
      }),
      (w) => {
        underTriggers(w.file, 'halt_reasons', "UPDATE halt_reasons SET reason = 'peak-halt:paper'");
        assert.equal(refusal(w), 'halt-link');
      },
    );
  });

  it('book: a stuck position', () => {
    withBoot(
      bootWorld((db) => {
        db.transaction((tx) => insertOpening(tx, { id: 'ps_1', mint: 'MintA', strategy: 'momentum', mode: 'paper', openedAt: T, maxSpend: lamports(30_000_000n) }, lamports(125_000n)));
      }),
      (w) => {
        underTriggers(w.file, 'positions', "UPDATE positions SET status = 'stuck', max_spend = NULL WHERE id = 'ps_1'");
        assert.equal(refusal(w), 'book');
      },
    );
  });

  it('conservation: SOL that the books do not explain', () => {
    withBoot(bootWorld(), (w) => {
      underTriggers(w.file, 'ledger_accounts', "UPDATE ledger_accounts SET sol = '550000001' WHERE mode = 'paper'");
      assert.equal(refusal(w), 'conservation');
    });
  });

  it("paper-account and live-account: a paper withdrawal; live money before Phase 8 (D7)", () => {
    withBoot(bootWorld(), (w) => {
      underTriggers(w.file, 'ledger_accounts', "UPDATE ledger_accounts SET sol = '549999999', total_withdrawals = '1' WHERE mode = 'paper'");
      assert.equal(refusal(w), 'paper-account');
    });
    withBoot(bootWorld(), (w) => {
      underTriggers(w.file, 'ledger_accounts', "UPDATE ledger_accounts SET sol = '1', total_deposits = '1' WHERE mode = 'live'");
      assert.equal(refusal(w), 'live-account');
    });
  });

  it('abandon: a stale opening that storage will not close (a clock past the year 2200)', () => {
    withBoot(
      bootWorld((db) => {
        db.transaction((tx) => insertOpening(tx, { id: 'ps_stale', mint: 'MintS', strategy: 'momentum', mode: 'paper', openedAt: T, maxSpend: lamports(30_000_000n) }, lamports(125_000n)));
      }),
      (w) => {
        w.clock.set(Number.MAX_SAFE_INTEGER);
        assert.equal(refusal(w), 'abandon');
      },
    );
  });

  it('sentinel: the KILL file is there and KILL cannot be stored', () => {
    withBoot(bootWorld(), (w) => {
      w.sentinel.on = true;
      w.clock.set(Number.MAX_SAFE_INTEGER);
      assert.equal(refusal(w), 'sentinel');
    });
  });
});

describe('checkDataPath on Windows, through a fake probe (V4 on a real Windows machine is the owner)', () => {
  const profile = 'C:\\Users\\Owner';
  const fakeWin = (existing: readonly string[]): FsProbe => ({
    lstat: (p) => (existing.includes(p) ? { isSymbolicLink: false, isDirectory: !p.endsWith('.sqlite'), mode: 0o666, uid: 0, nlink: 1 } : null),
    realpath: (p) => p,
    fsType: () => null,
    chmod: () => assert.fail('no chmod on Windows'),
  });
  const win = (dataDir: string, oneDriveRoots: readonly string[] = []): Pick<BootOptions, 'dataDir' | 'dbFile' | 'copyDir' | 'runDir' | 'platform' | 'uid' | 'windows' | 'fs'> => {
    const join = (n: string): string => `${dataDir}\\${n}`;
    return {
      dataDir,
      dbFile: 'bot.sqlite',
      copyDir: 'db-copies',
      runDir: 'run',
      platform: 'win32',
      uid: null,
      windows: { userProfile: profile, oneDriveRoots },
      fs: fakeWin([dataDir, join('run'), join('db-copies'), join('bot.sqlite')]),
    };
  };
  const refused = (o: ReturnType<typeof win>): boolean => {
    try {
      checkDataPath(o);
      return false;
    } catch (e) {
      return e instanceof BootError && e.refusal === 'path';
    }
  };

  it('a folder under the profile passes, a name starting with two dots included', () => {
    checkDataPath(win(`${profile}\\fomo-bot\\data`));
    checkDataPath(win(`${profile}\\..fomo`));
  });

  it('refuses a profile next door, and two names for one folder where case does not count', () => {
    assert.ok(refused(win('C:\\Users\\Owner2\\fomo')), 'C:\\Users\\Owner2 is not under C:\\Users\\Owner');
    const o = win(`${profile}\\fomo`);
    const both = fakeWin([o.dataDir, `${o.dataDir}\\run`, `${o.dataDir}\\db-copies`, `${o.dataDir}\\DB-COPIES`, `${o.dataDir}\\bot.sqlite`]);
    checkDataPath({ ...o, fs: both });
    assert.ok(refused({ ...o, fs: both, runDir: 'DB-COPIES' }), 'the run folder is the copy folder');
  });

  it('refuses a UNC path, a folder outside the profile, a OneDrive root and a OneDrive folder name', () => {
    for (const dir of ['\\\\server\\share\\fomo', '//server/share/fomo', '\\\\?\\UNC\\server\\share\\fomo', 'D:\\fomo', `${profile}\\OneDrive - Company\\fomo`, `${profile}\\onedrive\\fomo`]) {
      assert.ok(refused(win(dir)), dir);
    }
    assert.ok(refused(win(`${profile}\\Docs\\fomo`, [`${profile}\\Docs`])), 'under a OneDrive root');
    assert.ok(refused({ ...win(`${profile}\\fomo`), windows: { userProfile: null, oneDriveRoots: [] } }), 'no profile to check against');
  });

  it('the hard-link and link checks hold on Windows too', () => {
    const o = win(`${profile}\\fomo`);
    const linked: FsProbe = { ...o.fs, lstat: (p) => ({ ...(o.fs.lstat(p) ?? { isSymbolicLink: false, isDirectory: true, mode: 0, uid: 0, nlink: 1 }), nlink: p.endsWith('.sqlite') ? 2 : 1 }) };
    assert.ok(refused({ ...o, fs: linked }));
    const junction: FsProbe = { ...o.fs, realpath: (p) => `D:\\elsewhere${p.slice(2)}` };
    assert.ok(refused({ ...o, fs: junction }), 'a junction on the way');
  });
});

describe('the local file systems (V1: linux/magic.h)', () => {
  it('ext2/3/4, xfs, btrfs, tmpfs and overlay, by their numbers', () => {
    assert.deepEqual([...LOCAL_FILE_SYSTEMS.entries()], [
      [0xef53, 'ext4'],
      [0x58465342, 'xfs'],
      [0x9123683e, 'btrfs'],
      [0x01021994, 'tmpfs'],
      [0x794c7630, 'overlay'],
    ]);
  });
});
