// The paper engine's start (STORAGE_DESIGN.md s.16.6; conditions C1, C7, C13, C21, C64, C65 and review
// T's conditions for 6d-3): the inputs are checked before the boot touches anything; the boot runs
// first and its refusal comes through with nothing built; then the fault sink on the boot's latch (a
// disk fault or a busy storm stores the disk-db halt; the first fatal fault calls the caller's
// onFatal once), the one slot feed, exactly one paper authority bound to both, the deps the app/
// transactions need, and the redeemer for the executor. Any throw after the boot closes the database.
// The K gate is closed against this redeemer. Written before src/app/engine.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { approveBuyTx, type EntryOutcome } from '../../../src/app/approve-tx.ts';
import { assertPaperAuthority, startPaperEngine, type PaperEngine, type PaperEngineOptions } from '../../../src/app/engine.ts';
import { classify } from '../../../src/app/faults.ts';
import { ANCHOR_FILE, KILL_FILE, nodeFsProbe } from '../../../src/app/run-files.ts';
import { SLOT_FEED_DEFAULTS } from '../../../src/app/slots.ts';
import { BootError } from '../../../src/app/storage-boot.ts';
import type { RedeemResult } from '../../../src/risk/approval.ts';
import { verifyAuditChain } from '../../../src/storage/repo-audit.ts';
import { readHalts, setKill } from '../../../src/storage/repo-flags.ts';
import { buyOrderOf } from '../../../src/storage/repo-orders.ts';
import { setStrategyMode } from '../../../src/storage/repo-owner.ts';
import { insertSnapshot } from '../../../src/storage/repo-observe.ts';
import { lamports } from '../../../src/core/units.ts';
import { StorageError, type Db } from '../../../src/storage/sqlite.ts';
import { WSOL } from '../risk/fixtures.ts';
import { removeDir, tempDir } from '../storage/helpers.ts';
import { RENT, SLOT, entryRequest } from './tx-world.ts';
import { T, recordingAlerts, setUpDb, testClock, testRng, type RecordingAlerts, type TestClock, type TestRng } from './world.ts';

interface EngineWorld {
  readonly dir: string;
  readonly file: string;
  readonly clock: TestClock;
  readonly alerts: RecordingAlerts;
  readonly rng: TestRng;
  readonly fatal: string[];
  readonly options: PaperEngineOptions;
}

/** A data folder with a set-up database (momentum on paper), closed again, and the engine's options. */
function engineWorld(prepare: (db: Db) => void = () => undefined, seed = 1): EngineWorld {
  const dir = realpathSync(tempDir('fomo-engine-'));
  mkdirSync(path.join(dir, 'run'), { mode: 0o700 });
  mkdirSync(path.join(dir, 'db-copies'), { mode: 0o700 });
  const file = path.join(dir, 'bot.sqlite');
  const db = setUpDb(file);
  db.transaction((tx) => {
    setStrategyMode(tx, T - 1, 'owner-telegram', 'momentum', 'paper');
    insertSnapshot(tx, 'paper', T, lamports(550_000_000n), lamports(550_000_000n)); // the money check T1 needs fresh (6e-2)
  });
  prepare(db);
  db.close();
  const clock = testClock(T);
  const alerts = recordingAlerts();
  const rng = testRng(seed);
  const fatal: string[] = [];
  const options: PaperEngineOptions = {
    boot: {
      dataDir: dir,
      dbFile: 'bot.sqlite',
      copyDir: 'db-copies',
      runDir: 'run',
      platform: process.platform,
      uid: process.getuid?.() ?? null,
      windows: { userProfile: null, oneDriveRoots: [] },
      nodeVersion: 'v26.13.0',
      busyTimeoutMs: 100,
      fs: nodeFsProbe,
      runLock: { held: true },
    },
    clock,
    rng,
    alerts,
    marks: { marks: () => new Map() },
    rent: { wsolHelperRent: () => RENT },
    breakers: { breakers: () => [] },
    identity: Object.freeze({ wallet: 'OurWallet', wsolMint: WSOL, tokenAccountOf: (mint: string) => `AtaOf${mint}` }),
    slotOptions: { ...SLOT_FEED_DEFAULTS },
    onFatal: (code) => void fatal.push(code),
  };
  return { dir, file, clock, alerts, rng, fatal, options };
}

function withEngine(w: EngineWorld, fn: (w: EngineWorld) => void): void {
  try {
    fn(w);
  } finally {
    removeDir(w.dir);
  }
}

/** Starts the engine, runs fn, closes it. */
function started(w: EngineWorld, fn: (e: PaperEngine) => void, over: Partial<PaperEngineOptions> = {}): void {
  const e = startPaperEngine({ ...w.options, ...over });
  try {
    fn(e);
  } finally {
    e.close();
  }
}

/** The descriptors of this process that point at the file (Linux): a closed engine leaves none. */
const openHandles = (file: string): number =>
  readdirSync('/proc/self/fd').filter((fd) => {
    try {
      return readlinkSync(`/proc/self/fd/${fd}`) === file;
    } catch {
      return false;
    }
  }).length;

const closed = (w: EngineWorld): void => {
  if (process.platform === 'linux') {
    assert.equal(openHandles(w.file), 0, 'the database is closed');
  }
};

/** The slot the fixtures' plans quote near (1,000), on both channels. */
const atSlot = (e: PaperEngine, slot = SLOT): void => {
  e.slotFeed.report('stream', slot);
  e.slotFeed.report('http', slot);
};

const approved = (o: EntryOutcome) => {
  assert.equal(o.kind, 'approved', JSON.stringify(o, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
  return o as Extract<EntryOutcome, { kind: 'approved' }>;
};

const anchorFile = (w: EngineWorld): { readonly id: number; readonly hash: string } => JSON.parse(readFileSync(path.join(w.dir, 'run', ANCHOR_FILE), 'utf8')) as { id: number; hash: string };

const POSIX = process.platform !== 'win32';

describe('the paper engine: a start', { skip: !POSIX }, () => {
  it('boots, then builds one paper authority and the deps the transactions need; frozen; the key drawn once and wiped', () => {
    withEngine(engineWorld(), (w) => {
      started(w, (e) => {
        assert.deepEqual(Object.keys(e).sort(), ['close', 'deps', 'ids', 'redeemer', 'report', 'slotFeed']);
        assert.ok(Object.isFrozen(e) && Object.isFrozen(e.deps) && Object.isFrozen(e.ids));
        assert.deepEqual(Object.keys(e.deps).sort(), ['alerts', 'anchors', 'breakers', 'clock', 'db', 'exitWatch', 'faults', 'identity', 'issuer', 'latch', 'marks', 'mode', 'rent', 'sentinel', 'slots']);
        assert.equal(e.deps.mode, 'paper');
        assert.equal(e.redeemer.mode, 'paper');
        assert.ok(!('verifier' in e) && !('issuer' in e) && !('verify' in e.redeemer), 'the executor gets the redeemer only (C65)');
        assert.equal(e.deps.slots, e.slotFeed, 'one feed for the deps and the authority');
        assert.equal(e.deps.clock, w.clock);
        assert.equal(e.deps.alerts, w.alerts);
        assert.equal(e.deps.marks, w.options.marks);
        assert.equal(e.deps.rent, w.options.rent);
        assert.equal(e.deps.breakers, w.options.breakers);
        assert.equal(e.deps.identity, w.options.identity);
        assert.equal(w.rng.keys.length, 1, 'exactly one authority (C64)');
        assert.ok(w.rng.keys[0]?.every((b) => b === 0), 'the array the Rng gave is wiped');
        assert.deepEqual([...e.report.warnings], ['no-audit-anchor']);
        assert.equal(anchorFile(w).id, e.report.auditNewestId, 'the anchor file in the run folder names the newest row');
        assert.equal(statSync(path.join(w.dir, 'run', ANCHOR_FILE)).mode & 0o777, 0o600);
        assert.equal(e.ids.positionId(), `ps_${'1'.padStart(32, '0')}`, 'ids from the Rng');
        assert.equal(e.ids.orderId(), `or_${'2'.padStart(32, '0')}`);
        assert.equal(e.slotFeed.currentSlot(), null, 'no slot until a channel reports one');
      });
      closed(w);
    });
  });

  it('the whole chain is wired: a buy approved through the deps, redeemed through the redeemer at the feed slot, one order', () => {
    withEngine(engineWorld(), (w) => {
      started(w, (e) => {
        atSlot(e);
        const o = approved(approveBuyTx(e.deps, entryRequest()));
        assert.equal(e.redeemer.redeem(o.token, o.plan).ok, true);
        assert.equal(buyOrderOf(e.deps.db, 'ps_new1')?.status, 'approved');
        assert.deepEqual(e.redeemer.redeem(o.token, o.plan), { ok: false, problems: ['already-consumed'] });
      });
    });
  });

  it('the boot latch is the engine latch: KILL stored before the start is seen, and buys are refused', () => {
    withEngine(
      engineWorld((db) => {
        db.transaction((tx) => setKill(tx, T - 1, 'cli'));
      }),
      (w) => {
        started(w, (e) => {
          assert.equal(e.report.killOn, true);
          assert.equal(e.deps.latch.killSeen(), true);
          atSlot(e);
          assert.notEqual(approveBuyTx(e.deps, entryRequest()).kind, 'approved');
        });
      },
    );
  });

  it("the KILL file in the engine's own run folder stops buys once it appears", () => {
    withEngine(engineWorld(), (w) => {
      started(w, (e) => {
        atSlot(e);
        writeFileSync(path.join(w.dir, 'run', KILL_FILE), '');
        assert.notEqual(approveBuyTx(e.deps, entryRequest()).kind, 'approved');
        assert.equal(e.deps.latch.killSeen(), true);
      });
    });
  });

  it('close() closes the database; a second close is harmless', () => {
    withEngine(engineWorld(), (w) => {
      const e = startPaperEngine(w.options);
      e.close();
      closed(w);
      e.close();
    });
  });
});

describe('the paper engine: its fault sink (review T conditions for 6d-3)', { skip: !POSIX }, () => {
  it('a busy storm stores the disk-db halt, with its audit row, and moves the anchor file to it', () => {
    withEngine(engineWorld(), (w) => {
      started(w, (e) => {
        const busy = classify(new StorageError('busy', 'database is locked'));
        for (let i = 0; i < 3; i += 1) {
          e.deps.faults.report('t1-buy', busy);
        }
        assert.deepEqual(
          readHalts(e.deps.db).map((h) => h.reason),
          ['disk-db'],
        );
        assert.ok(e.deps.latch.blocked().includes('storage-busy'));
        assert.equal(anchorFile(w).id, verifyAuditChain(e.deps.db).newestId);
      });
    });
  });

  it('one disk-full fault stores the disk-db halt too', () => {
    withEngine(engineWorld(), (w) => {
      started(w, (e) => {
        e.deps.faults.report('t1-buy', classify(new StorageError('full', 'database or disk is full')));
        assert.deepEqual(
          readHalts(e.deps.db).map((h) => h.reason),
          ['disk-db'],
        );
      });
    });
  });

  it("the first fatal fault calls the caller's onFatal, once", () => {
    withEngine(engineWorld(), (w) => {
      started(w, (e) => {
        const poisoned = classify(new StorageError('poisoned', 'the outcome of ROLLBACK is unknown'));
        e.deps.faults.report('t2', poisoned);
        e.deps.faults.report('t2', poisoned);
        assert.deepEqual(w.fatal, ['error:storage-poisoned']);
      });
    });
  });
});

describe('the paper engine: the K gate against its redeemer (C1)', { skip: !POSIX }, () => {
  it('extra arguments change nothing; an expired token stays expired whatever slot the executor names', () => {
    withEngine(engineWorld(), (w) => {
      started(w, (e) => {
        atSlot(e);
        const o = approved(approveBuyTx(e.deps, entryRequest()));
        atSlot(e, 1_030n); // past the token's expiry slot, 1,025
        const redeem = e.redeemer.redeem as (...args: unknown[]) => RedeemResult;
        const r = redeem(o.token, o.plan, { consume: () => true }, 1_000n);
        assert.equal(r.ok, false);
        assert.ok(!r.ok && r.problems.includes('expired'), JSON.stringify(r));
        assert.equal(buyOrderOf(e.deps.db, 'ps_new1'), null);
      });
    });
  });

  it("a token of another engine fails its MAC: it never reaches this engine's store", () => {
    const one = engineWorld(() => undefined, 1);
    const two = engineWorld(() => undefined, 2);
    try {
      started(one, (a) => {
        started(two, (b) => {
          atSlot(a);
          atSlot(b);
          const o = approved(approveBuyTx(a.deps, entryRequest()));
          approved(approveBuyTx(b.deps, entryRequest())); // the same rows in b's database, b's own token
          const r = b.redeemer.redeem(o.token, o.plan);
          assert.ok(!r.ok && r.problems.includes('bad-mac'), JSON.stringify(r));
          assert.equal(buyOrderOf(b.deps.db, 'ps_new1'), null);
        });
      });
    } finally {
      removeDir(one.dir);
      removeDir(two.dir);
    }
  });
});

describe('the paper engine: refusals', { skip: !POSIX }, () => {
  it('a refused boot comes through as its BootError: no key drawn, the database closed', () => {
    withEngine(engineWorld(), (w) => {
      assert.throws(
        () => startPaperEngine({ ...w.options, boot: { ...w.options.boot, runLock: { held: false } as unknown as PaperEngineOptions['boot']['runLock'] } }),
        (e: unknown) => e instanceof BootError && e.refusal === 'run-lock',
      );
      assert.equal(w.rng.keys.length, 0);
      closed(w);
    });
  });

  it('bad inputs are refused before the boot touches anything: a TypeError, no key, no alert, no anchor', () => {
    const fn = (): void => undefined;
    const cases: readonly (readonly [string, Partial<PaperEngineOptions>])[] = [
      ['onFatal', { onFatal: 'exit' as unknown as PaperEngineOptions['onFatal'] }],
      ['rng ids', { rng: { approvalKey: () => new Uint8Array(32).fill(1), tokenId: () => 'tk_1', positionId: () => 'ps_1' } as unknown as PaperEngineOptions['rng'] }],
      ['rng', { rng: null as unknown as PaperEngineOptions['rng'] }],
      ['clock', { clock: { now: 1 } as unknown as PaperEngineOptions['clock'] }],
      ['alerts', { alerts: {} as unknown as PaperEngineOptions['alerts'] }],
      ['marks', { marks: {} as unknown as PaperEngineOptions['marks'] }],
      ['rent', { rent: { wsolHelperRent: RENT } as unknown as PaperEngineOptions['rent'] }],
      ['breakers', { breakers: { breakers: [] } as unknown as PaperEngineOptions['breakers'] }],
      ['identity', { identity: { wallet: 'OurWallet', wsolMint: WSOL } as unknown as PaperEngineOptions['identity'] }],
      ['wallet', { identity: { wallet: '', wsolMint: WSOL, tokenAccountOf: fn } as unknown as PaperEngineOptions['identity'] }],
      ['wsol', { identity: { wallet: 'OurWallet', wsolMint: 7, tokenAccountOf: fn } as unknown as PaperEngineOptions['identity'] }],
      ['boot', { boot: null as unknown as PaperEngineOptions['boot'] }],
      ['data folder', { boot: { dataDir: 7, runDir: 'run' } as unknown as PaperEngineOptions['boot'] }],
      ['slot options', { slotOptions: { ...SLOT_FEED_DEFAULTS, maxAgeMs: 0 } }],
    ];
    for (const [name, over] of cases) {
      withEngine(engineWorld(), (w) => {
        assert.throws(() => startPaperEngine({ ...w.options, ...over }), TypeError, name);
        assert.equal(w.rng.keys.length, 0, name);
        assert.deepEqual(w.alerts.seen, [], `${name}: the boot never ran`);
        assert.equal(existsSync(path.join(w.dir, 'run', ANCHOR_FILE)), false, name);
      });
    }
  });

  it('a throw after the boot closes the database and alerts: an Rng whose key is all zero (the authority refuses it)', () => {
    withEngine(engineWorld(), (w) => {
      const zero = { ...w.rng, approvalKey: () => new Uint8Array(32) };
      assert.throws(() => startPaperEngine({ ...w.options, rng: zero }), TypeError);
      closed(w);
      assert.deepEqual(w.alerts.seen.at(-1), { code: 'engine-start-failed', severity: 'fatal' });
    });
  });

  it('an alert sink that throws then does not hide the error', () => {
    withEngine(engineWorld(), (w) => {
      const zero = { ...w.rng, approvalKey: () => new Uint8Array(32) };
      const alerts = { alert: (): never => assert.fail('the sink is down') };
      assert.throws(
        () => startPaperEngine({ ...w.options, rng: zero, alerts }),
        (e: unknown) => e instanceof TypeError && /approval key/.test(e.message),
      );
      closed(w);
    });
  });
});

describe('assertPaperAuthority (C64): the one start-up check of the wiring', () => {
  const issuer = { issue: () => undefined };
  it('passes a paper redeemer with an issuer', () => {
    assertPaperAuthority({ issuer, redeemer: { mode: 'paper', redeem: () => undefined } });
  });
  it('refuses a live redeemer, a missing issuer, and an issuer without issue', () => {
    for (const a of [
      { issuer, redeemer: { mode: 'live', redeem: () => undefined } },
      { issuer: null, redeemer: { mode: 'paper', redeem: () => undefined } },
      { issuer: {}, redeemer: { mode: 'paper', redeem: () => undefined } },
      { issuer, redeemer: { mode: 'paper' } },
    ]) {
      assert.throws(() => assertPaperAuthority(a as never), TypeError, JSON.stringify(a));
    }
  });
});
