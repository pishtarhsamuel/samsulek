// The K gate in app/ (STORAGE_DESIGN.md s.16.5.5 and s.16.6; reviews K, N and S): the engine's one
// approval authority binds the SQLite token store and the slot feed when it is made, registers its
// key as an own secret and wipes the array it was handed, and hands out only the issuer and the
// redeemer. T2 runs inside the store: a buy token is refused while new entries are latched or KILL
// was seen (the KILL file included); an exit token always goes through. The order row is written from
// the verifier's validated snapshot and risk's own canonical text. An executor cannot pass its own
// store or slot, and a token of another authority fails its MAC. Written before src/app/token-store.ts
// and src/app/authority.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as authorityFile from '../../../src/app/authority.ts';
import { createEngineAuthority, type EngineAuthority } from '../../../src/app/authority.ts';
import { createEntryLatch, createFaultSink, type EntryLatch, type Fault, type FaultSink, type FaultSite } from '../../../src/app/faults.ts';
import { SLOT_FEED_DEFAULTS, createSlotFeed, type SlotFeed } from '../../../src/app/slots.ts';
import * as storeFile from '../../../src/app/token-store.ts';
import { createSqliteTokenStore } from '../../../src/app/token-store.ts';
import { base58Of, base64UrlOf, hexOf } from '../../../src/core/encode.ts';
import { secretKinds } from '../../../src/core/redact.ts';
import { lamports } from '../../../src/core/units.ts';
import type { ApprovalToken } from '../../../src/risk/approval.ts';
import { canonicalPlan, planHash, planMaxSpend, type OrderPlan } from '../../../src/risk/plan.ts';
import path from 'node:path';
import { setEntriesStopped, setHalt, setKill, setPaused } from '../../../src/storage/repo-flags.ts';
import { insertOpening } from '../../../src/storage/repo-book.ts';
import { insertApproval, insertDecision, insertEntryIntent, insertExitIntent } from '../../../src/storage/repo-orders.ts';
import type { Db } from '../../../src/storage/sqlite.ts';
import { checked } from '../risk/fixtures.ts';
import { count, dump, fileDb, removeDir, tempDir } from '../storage/helpers.ts';
import { BUY, CLOSE, SELL } from '../storage/money-fixtures.ts';
import { T, recordingAlerts, setUpDb, testClock, testKeyBytes, testRng, testSentinel, type RecordingAlerts, type TestClock, type TestRng, type TestSentinel } from './world.ts';

interface AppWorld {
  readonly db: Db;
  readonly clock: TestClock;
  readonly feed: SlotFeed;
  readonly alerts: RecordingAlerts;
  readonly latch: EntryLatch;
  readonly sentinel: TestSentinel;
  readonly rng: TestRng;
  readonly faults: FaultSink;
  readonly reported: (readonly [FaultSite, Fault])[];
  readonly engine: EngineAuthority;
}

/** The engine's authority on a set-up database, the feed anchored at slot 1,005 (the fixtures' plans quote at 1,000). */
function makeWorld(db: Db, seed = 1): AppWorld {
  const clock = testClock(T + 10);
  const alerts = recordingAlerts();
  const latch = createEntryLatch();
  const sentinel = testSentinel();
  const rng = testRng(seed);
  const reported: (readonly [FaultSite, Fault])[] = [];
  const sink = createFaultSink({ latch, alerts, clock, onFatal: () => undefined, onDiskTrouble: () => undefined });
  const faults: FaultSink = {
    report: (site, f) => {
      reported.push([site, f]);
      sink.report(site, f);
    },
  };
  const feed = createSlotFeed({ ...SLOT_FEED_DEFAULTS, clock, alerts });
  feed.report('stream', 1_005n);
  feed.report('http', 1_005n);
  const engine = createEngineAuthority({ db, clock, slots: feed, rng, faults, latch, sentinel });
  return { db, clock, feed, alerts, latch, sentinel, rng, faults, reported, engine };
}

function withApp(fn: (w: AppWorld) => void, seed = 1): void {
  const db = setUpDb();
  try {
    fn(makeWorld(db, seed));
  } finally {
    db.close();
  }
}

const issue = (w: AppWorld, plan: OrderPlan): ApprovalToken => w.engine.issuer.issue(checked(plan));

/** T1's buy rows, by the repositories, with the engine's token. */
function approveBuy(w: AppWorld, plan: OrderPlan = BUY): ApprovalToken {
  const token = issue(w, plan);
  w.db.transaction((tx) => {
    insertEntryIntent(tx, { id: plan.intentId, mode: plan.mode, strategy: 'momentum', mint: plan.mint, positionId: plan.positionId, sizeHint: 'normal', confidenceBps: null, createdAt: T, inputsAsOf: null, reasons: ['flow-up'], inputs: {} });
    insertOpening(tx, { id: plan.positionId, mint: plan.mint, strategy: 'momentum', mode: plan.mode, openedAt: T, maxSpend: planMaxSpend(plan) }, lamports(2_000_000n));
    insertDecision(tx, { outcome: 'entry-approved', intentId: plan.intentId, at: T, configVersion: 1, slot: 1_005n, size: lamports(plan.inAmount), limitedBy: 'per-trade', binding: 'per-trade' });
    insertApproval(tx, token, canonicalPlan(plan), T);
  });
  return token;
}

/** What T3 will do (the buy settled, the position holds tokens), by hand: no writer in this step makes it. */
function settleBuy(db: Db): void {
  db.transaction((tx) => tx.run("UPDATE positions SET status = 'open', max_spend = NULL, token_units = '400000', tokens_bought = '400000', updated_at = ? WHERE id = 'p1'", BigInt(T + 2)));
}

/** T1's exit rows, by the repositories, with the engine's token. */
function approveExit(w: AppWorld, plan: OrderPlan, seq: number): ApprovalToken {
  const token = issue(w, plan);
  w.db.transaction((tx) => {
    insertExitIntent(tx, { id: plan.intentId, positionId: plan.positionId, exitSeq: seq, fractionBps: 10_000, urgency: 'normal', createdAt: T + 3, inputsAsOf: null, reasons: ['take-profit'], inputs: {} });
    insertDecision(tx, { outcome: 'exit-approved', intentId: plan.intentId, at: T + 3, configVersion: 1, slot: 1_005n });
    insertApproval(tx, token, canonicalPlan(plan), T + 3);
  });
  return token;
}

/** A buy redeemed and settled, and a sell token ready: the exit cases start here. */
function boughtAndSelling(w: AppWorld): ApprovalToken {
  assert.equal(w.engine.redeemer.redeem(approveBuy(w), BUY).ok, true);
  settleBuy(w.db);
  return approveExit(w, SELL, 0);
}

describe('the K gate files: only what they may do', () => {
  it('the token store exports its maker and the authority file its maker, and nothing else', () => {
    assert.deepEqual(Object.keys(storeFile), ['createSqliteTokenStore']);
    assert.deepEqual(Object.keys(authorityFile), ['createEngineAuthority']);
  });

  it('the engine authority holds the issuer, the redeemer and its mode, frozen, and no verifier', () => {
    withApp((w) => {
      assert.deepEqual(Object.keys(w.engine).sort(), ['issuer', 'mode', 'redeemer']);
      assert.equal(w.engine.mode, 'paper');
      assert.equal(w.engine.redeemer.mode, 'paper');
      assert.ok(Object.isFrozen(w.engine));
    });
  });
});

describe('the approval key: registered as an own secret, the handed array wiped, the authority still works', () => {
  it("the key's forms are refused by the secret filter; the array the Rng gave is all zero; tokens still verify", () => {
    withApp((w) => {
      const key = testKeyBytes(1);
      for (const form of [hexOf(key), base58Of(key), base64UrlOf(key)]) {
        assert.ok(secretKinds(form).includes('own-secret'));
      }
      assert.equal(w.rng.keys.length, 1);
      assert.ok(w.rng.keys[0]?.every((b) => b === 0));
      assert.equal(w.engine.redeemer.redeem(approveBuy(w), BUY).ok, true);
      const cells = dump(w.db).toLowerCase();
      for (const form of [hexOf(key), base58Of(key), base64UrlOf(key)]) {
        assert.ok(!cells.includes(form.toLowerCase()), 'the key is in no cell');
      }
    });
  });
});

describe('T2 through the engine redeemer', () => {
  it('a buy: the order row is the snapshot and the text, the token consumed at the feed slot and the clock time; a replay changes nothing', () => {
    withApp((w) => {
      const token = approveBuy(w);
      assert.equal(token.expiresAtSlot, 1_025n); // the hard 25 slots after the quote (config/caps.ts)
      assert.match(token.id, /^tk_[0-9a-f]{32}$/); // from the engine's Rng
      const result = w.engine.redeemer.redeem(token, BUY);
      assert.equal(result.ok, true);
      const a = w.db.get('SELECT consumed_at, consumed_slot FROM approvals WHERE token_id = ?', token.id);
      assert.deepEqual([a?.['consumed_at'], a?.['consumed_slot']], [BigInt(T + 10), 1_005n]);
      const o = w.db.get('SELECT id, token_id, kind, status, plan_hash, plan_json, in_amount FROM orders');
      assert.deepEqual([o?.['id'], o?.['token_id'], o?.['kind'], o?.['status'], o?.['plan_hash'], o?.['plan_json'], o?.['in_amount']], ['order-1', token.id, 'buy', 'approved', planHash(BUY), canonicalPlan(BUY), '55000000']);
      const before = dump(w.db);
      const again = w.engine.redeemer.redeem(token, BUY);
      assert.deepEqual(again, { ok: false, problems: ['already-consumed'] });
      assert.equal(dump(w.db), before);
      assert.ok(!before.includes(token.mac), 'the MAC is in no cell');
      assert.deepEqual(w.reported, []);
    });
  });

  it('extra arguments to redeem are ignored: no store and no slot can be handed in', () => {
    withApp((w) => {
      const token = approveBuy(w);
      const redeem = w.engine.redeemer.redeem as (...args: unknown[]) => ReturnType<EngineAuthority['redeemer']['redeem']>;
      assert.equal(redeem(token, BUY, { consume: () => true }, 1_000n).ok, true);
      assert.deepEqual(redeem(token, BUY, { consume: () => true }, 1_000n), { ok: false, problems: ['already-consumed'] });
    });
  });

  it('the plan object the executor passed in can change after redeem: the row stays what risk validated', () => {
    withApp((w) => {
      const token = approveBuy(w);
      const mine = { ...BUY } as { -readonly [K in keyof OrderPlan]: OrderPlan[K] };
      const result = w.engine.redeemer.redeem(token, mine);
      assert.ok(result.ok);
      assert.ok(Object.isFrozen(result.plan));
      mine.inAmount = 1n;
      mine.orderId = 'order-x';
      const o = w.db.get('SELECT id, in_amount, plan_json FROM orders');
      assert.deepEqual([o?.['id'], o?.['in_amount'], o?.['plan_json']], ['order-1', '55000000', canonicalPlan(BUY)]);
      assert.equal(result.plan.inAmount, BUY.inAmount);
    });
  });

  it('a token the database does not hold: store-error, reported as a bug (row-missing latches entries)', () => {
    withApp((w) => {
      const token = issue(w, BUY); // issued, but T1 never stored it
      assert.deepEqual(w.engine.redeemer.redeem(token, BUY), { ok: false, problems: ['store-error'] });
      assert.deepEqual(
        w.reported.map(([site, f]) => [site, f.code]),
        [['t2', 'error:storage-row-missing']],
      );
      assert.deepEqual(w.latch.blocked(), ['bug']);
      assert.equal(count(w.db, 'orders'), 0n);
    });
  });

  it('a second exit while one is in flight is the database refusal: store-error, reported, nothing written', () => {
    withApp((w) => {
      const sell = boughtAndSelling(w);
      assert.equal(w.engine.redeemer.redeem(sell, SELL).ok, true);
      const close = approveExit(w, CLOSE, 1);
      const before = dump(w.db);
      assert.deepEqual(w.engine.redeemer.redeem(close, CLOSE), { ok: false, problems: ['store-error'] });
      assert.equal(dump(w.db), before);
      assert.deepEqual(
        w.reported.map(([site, f]) => [site, f.code, f.scope]),
        [['t2-exit', 'error:storage-constraint', 'intent']],
      );
      assert.deepEqual(w.alerts.codes(), ['error:storage-constraint']);
    });
  });
});

describe('T2 refuses buy tokens while entries are latched or KILL was seen; exit tokens always go through', () => {
  for (const [why, stop] of [
    ['entries latched', (w: AppWorld) => w.latch.set('storage')],
    ['KILL seen', (w: AppWorld) => w.latch.markKill()],
    ['the KILL file present', (w: AppWorld) => (w.sentinel.on = true)],
  ] as const) {
    it(`${why}: a buy token is refused (store-error), nothing is written, and it is no fault; an exit token still redeems`, () => {
      withApp((w) => {
        const buy = approveBuy(w);
        stop(w);
        const before = dump(w.db);
        assert.deepEqual(w.engine.redeemer.redeem(buy, BUY), { ok: false, problems: ['store-error'] });
        assert.equal(dump(w.db), before);
        assert.deepEqual(w.reported, []);
        if (why === 'the KILL file present') {
          assert.equal(w.latch.killSeen(), true, 'the sentinel marks KILL seen');
        }
      });
      withApp((w) => {
        const sell = boughtAndSelling(w);
        stop(w);
        assert.equal(w.engine.redeemer.redeem(sell, SELL).ok, true);
      });
    });
  }
});

describe('T2 reads the stops the database holds for a buy token (review T, risk 3 and security 2): KILL, a halt of either mode, the pause, the low-equity stop', () => {
  for (const [why, stop] of [
    ['KILL committed by another process', (db: Db) => db.transaction((tx) => setKill(tx, T + 5, 'cli'))],
    ['a halt of the paper mode', (db: Db) => db.transaction((tx) => setHalt(tx, 'peak-halt:paper', T + 5))],
    ['a halt of the live mode', (db: Db) => db.transaction((tx) => setHalt(tx, 'peak-halt:live', T + 5))],
    ['the pause', (db: Db) => db.transaction((tx) => setPaused(tx, T + 5))],
    ['the low-equity stop', (db: Db) => db.transaction((tx) => setEntriesStopped(tx, true, T + 5))],
  ] as const) {
    it(`${why}, written after the token was issued: the buy is refused with nothing written; an exit token still redeems`, () => {
      const dir = tempDir();
      try {
        const file = path.join(dir, 'bot.sqlite');
        const db = setUpDb(file);
        const other = fileDb(file, false); // another process's handle on the same file
        try {
          const w = makeWorld(db);
          const buy = approveBuy(w);
          stop(other);
          const before = dump(db);
          assert.deepEqual(w.engine.redeemer.redeem(buy, BUY), { ok: false, problems: ['store-error'] });
          assert.equal(dump(db), before);
          assert.equal(w.latch.killSeen(), why.startsWith('KILL'), 'KILL in the database is remembered in the latch');
          assert.deepEqual(w.alerts.codes(), []); // an expected refusal: no alert
        } finally {
          other.close();
          db.close();
        }
      } finally {
        removeDir(dir);
      }
      withApp((w) => {
        const sell = boughtAndSelling(w);
        stop(w.db);
        assert.equal(w.engine.redeemer.redeem(sell, SELL).ok, true);
      });
    });
  }
});

describe('the slot comes only from the bound feed', () => {
  it('a feed moved past the token expiry: expired; a lower reading later does not bring it back', () => {
    withApp((w) => {
      const token = approveBuy(w);
      w.feed.report('stream', 1_100n); // within the bound: accepted
      assert.deepEqual(w.engine.redeemer.redeem(token, BUY), { ok: false, problems: ['expired'] });
      w.feed.report('http', 1_010n);
      assert.deepEqual(w.engine.redeemer.redeem(token, BUY), { ok: false, problems: ['expired'] });
      assert.equal(count(w.db, 'orders'), 0n);
    });
  });

  it('a stale feed: redeem answers slot-unknown and issue throws; nothing is written', () => {
    withApp((w) => {
      const token = approveBuy(w);
      w.clock.advance(2_001);
      assert.deepEqual(w.engine.redeemer.redeem(token, BUY), { ok: false, problems: ['slot-unknown'] });
      assert.throws(() => issue(w, { ...BUY, intentId: 'intent-2', positionId: 'p2', mint: 'MintB', orderId: 'order-2' }), /slot is unknown/);
      assert.equal(count(w.db, 'orders'), 0n);
    });
  });

  it('one wild reading does not stop an exit: the sell is issued and redeemed at the real slot', () => {
    withApp((w) => {
      assert.equal(w.engine.redeemer.redeem(approveBuy(w), BUY).ok, true);
      settleBuy(w.db);
      w.feed.report('stream', 10n ** 15n);
      const sell = approveExit(w, SELL, 0);
      assert.equal(w.engine.redeemer.redeem(sell, SELL).ok, true);
      assert.equal(w.db.get('SELECT consumed_slot FROM approvals WHERE token_id = ?', sell.id)?.['consumed_slot'], 1_005n);
    });
  });

  it('the stream gone stale but HTTP alive: the exit loop reports its quote slot over HTTP, and exit tokens are still issued and redeemed', () => {
    withApp((w) => {
      assert.equal(w.engine.redeemer.redeem(approveBuy(w), BUY).ok, true);
      settleBuy(w.db);
      w.clock.advance(5_000); // nothing from the stream for 5 s
      w.feed.report('http', 1_012n);
      const sell = approveExit(w, SELL, 0);
      assert.equal(w.engine.redeemer.redeem(sell, SELL).ok, true);
      assert.equal(w.db.get('SELECT consumed_slot FROM approvals WHERE token_id = ?', sell.id)?.['consumed_slot'], 1_012n);
    });
  });
});

describe('one authority per key: a token of another authority fails its MAC', () => {
  it("a token from a second authority on the same database is refused bad-mac, and the first authority's store is not touched", () => {
    const db = setUpDb();
    try {
      const a = makeWorld(db, 1);
      const b = makeWorld(db, 2);
      const token = approveBuy(a);
      const before = dump(db);
      assert.deepEqual(b.engine.redeemer.redeem(token, BUY), { ok: false, problems: ['bad-mac'] });
      assert.equal(dump(db), before);
      assert.equal(a.engine.redeemer.redeem(token, BUY).ok, true);
    } finally {
      db.close();
    }
  });
});

describe('the makers refuse what they cannot use', () => {
  it('createEngineAuthority and createSqliteTokenStore need every dependency', () => {
    withApp((w) => {
      const ok = { db: w.db, clock: w.clock, slots: w.feed, rng: testRng(1), faults: w.faults, latch: w.latch, sentinel: w.sentinel };
      for (const key of Object.keys(ok)) {
        assert.throws(() => createEngineAuthority({ ...ok, [key]: null } as unknown as typeof ok), TypeError, key);
      }
      const args = [w.db, w.clock, w.faults, w.latch, w.sentinel] as const;
      for (let i = 0; i < args.length; i += 1) {
        for (const missing of i === 0 ? [null, undefined] : [null, {}]) {
          const broken = args.map((a, j) => (j === i ? missing : a)) as unknown as Parameters<typeof createSqliteTokenStore>;
          assert.throws(() => createSqliteTokenStore(...broken), TypeError, String(i));
        }
      }
      assert.ok(Object.isFrozen(createSqliteTokenStore(...args)));
    });
  });

  it('an Rng whose key is all zero or short is refused before anything is bound', () => {
    withApp((w) => {
      for (const key of [new Uint8Array(32), new Uint8Array(16).fill(1), 'k'.repeat(32), Array.from({ length: 32 }, () => 1)] as unknown as Uint8Array[]) {
        const rng = { ...testRng(1), approvalKey: () => key };
        assert.throws(() => createEngineAuthority({ db: w.db, clock: w.clock, slots: w.feed, rng, faults: w.faults, latch: w.latch, sentinel: w.sentinel }), /key/);
      }
    });
  });
});
