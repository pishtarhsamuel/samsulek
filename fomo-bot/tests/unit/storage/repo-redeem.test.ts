// T2 (STORAGE_DESIGN.md s.15.7 and s.3.3): using an approval and recording its order, inside the
// token store bound into risk's verifier. The token is used once; the order row is written from the
// verifier's validated snapshot and risk's own canonical text, never from the executor's objects;
// every field of the text, the stored approval and the snapshot must agree, the slot must lie within
// the token's range, and the position must still take the order. Also the readers that depend on
// orders (exits in flight, a position's buy) and abandoning against each buy status. Only
// app/token-store.ts may import repo-redeem.ts (architecture rule). Written before
// src/storage/repo-redeem.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { firstVersion } from '../../../src/config/changes.ts';
import { DEFAULT_TUNABLES } from '../../../src/config/tunables.ts';
import { lamports } from '../../../src/core/units.ts';
import type { ApprovalToken, RedeemSnapshot, TokenStore } from '../../../src/risk/approval.ts';
import { canonicalPlan, planHash, planMaxSpend, validatePlan, type OrderPlan } from '../../../src/risk/plan.ts';
import { abandonOpening, insertOpening, readPosition } from '../../../src/storage/repo-book.ts';
import { buyOrderOf, exitsInFlight, insertApproval, insertDecision, insertEntryIntent, insertExitIntent } from '../../../src/storage/repo-orders.ts';
import * as redeemFile from '../../../src/storage/repo-redeem.ts';
import { redeemApproval } from '../../../src/storage/repo-redeem.ts';
import { setUpConfig, setUpLedger } from '../../../src/storage/repo-server.ts';
import { StorageError, type Db, type Tx } from '../../../src/storage/sqlite.ts';
import { TEST_NOW, count, dump, migratedDb, removeDir, storageError, tamper, tempDir } from './helpers.ts';
import { BUY, CLOSE, SELL, authority, issue, type Harness } from './money-fixtures.ts';

const T = TEST_NOW;
const REDEEM_AT = T + 10;

/** app/token-store.ts as 6d will write it: T2 as one transaction, from the snapshot and risk's own text. */
class SqliteStore implements TokenStore {
  db: Db | null = null;
  now = REDEEM_AT;
  consume(tokenId: string, snapshot: RedeemSnapshot): boolean {
    const db = this.db as Db;
    return db.transaction((tx) => redeemApproval(tx, tokenId, snapshot, canonicalPlan(snapshot.plan), this.now));
  }
}

interface World {
  readonly db: Db;
  readonly h: Harness;
  readonly store: SqliteStore;
}

function withWorld(fn: (w: World) => void): void {
  const db = migratedDb();
  try {
    db.transaction((tx) => {
      setUpConfig(tx, T, firstVersion(DEFAULT_TUNABLES, T));
      setUpLedger(tx, T, lamports(550_000_000n));
    });
    const store = new SqliteStore();
    store.db = db;
    fn({ db, h: authority({ store }), store });
  } finally {
    db.close();
  }
}

/** T1's buy: the intent, the opening position, the approved decision and the approval. Returns the token. */
function approveBuy(w: World, plan: OrderPlan = BUY): ApprovalToken {
  const token = issue(w.h, plan);
  w.db.transaction((tx) => {
    insertEntryIntent(tx, { id: plan.intentId, mode: plan.mode, strategy: 'momentum', mint: plan.mint, positionId: plan.positionId, sizeHint: 'normal', confidenceBps: null, createdAt: T, inputsAsOf: null, reasons: ['flow-up'], inputs: {} });
    insertOpening(tx, { id: plan.positionId, mint: plan.mint, strategy: 'momentum', mode: plan.mode, openedAt: T, maxSpend: planMaxSpend(plan) }, lamports(2_000_000n));
    insertDecision(tx, { outcome: 'entry-approved', intentId: plan.intentId, at: T, configVersion: 1, slot: 1_005n, size: lamports(plan.inAmount), limitedBy: 'per-trade', binding: 'per-trade' });
    insertApproval(tx, token, canonicalPlan(plan), T);
  });
  return token;
}

/** What T3 will do (the buy settled, the position holds tokens), written by hand: no writer in this step makes it. */
function settleBuy(db: Db, id: string): void {
  db.transaction((tx) => tx.run("UPDATE positions SET status = 'open', max_spend = NULL, token_units = '400000', tokens_bought = '400000', updated_at = ? WHERE id = ?", BigInt(T + 2), id));
}

/** T1's exit: the intent (it takes the next number), the approved decision and the approval. Returns the token. */
function approveExit(w: World, plan: OrderPlan, seq: number): ApprovalToken {
  const token = issue(w.h, plan);
  w.db.transaction((tx) => {
    insertExitIntent(tx, { id: plan.intentId, positionId: plan.positionId, exitSeq: seq, fractionBps: 10_000, urgency: 'normal', createdAt: T + 3, inputsAsOf: null, reasons: ['take-profit'], inputs: {} });
    insertDecision(tx, { outcome: 'exit-approved', intentId: plan.intentId, at: T + 3, configVersion: 1, slot: 1_005n });
    insertApproval(tx, token, canonicalPlan(plan), T + 3);
  });
  return token;
}

/** What verify validated, as the store receives it. */
const snapshotOf = (token: ApprovalToken, plan: OrderPlan, slot = 1_005n): RedeemSnapshot =>
  Object.freeze({
    intentId: token.intentId,
    positionId: token.positionId,
    mode: token.mode,
    kind: token.kind,
    reduceOnly: token.reduceOnly,
    planHash: token.planHash,
    maxSpendLamports: token.maxSpendLamports,
    minOut: token.minOut,
    expiresAtSlot: token.expiresAtSlot,
    slot,
    plan: validatePlan(plan),
  });

/** A careless caller that catches the refusal inside the transaction and commits: nothing of the call is written. */
function refusedInside(db: Db, fn: (tx: Tx) => unknown, code: Parameters<typeof storageError>[1], why: RegExp = /./): void {
  const before = dump(db);
  db.transaction((tx) => {
    assert.match(storageError(() => fn(tx), code).detail, why);
  });
  assert.equal(dump(db), before);
}

/** The same transaction with its k-th write failing (a full disk, an I/O error): what the caller sees, and what is left. */
function failingAt(tx: Tx, k: number): Tx {
  let n = 0;
  return {
    get: (sql, ...p) => tx.get(sql, ...p),
    all: (sql, ...p) => tx.all(sql, ...p),
    run: (sql, ...p) => {
      n += 1;
      if (n === k) {
        throw new StorageError('io', 'injected');
      }
      return tx.run(sql, ...p);
    },
    script: (sql) => tx.script(sql),
  } as Tx;
}

/** Each write of the call failing in turn leaves nothing behind: the whole transaction rolls back. */
function failsCleanly(db: Db, writes: number, fn: (tx: Tx) => unknown): void {
  const before = dump(db);
  for (let k = 1; k <= writes; k += 1) {
    storageError(() => db.transaction((tx) => fn(failingAt(tx, k))), 'io');
    assert.equal(dump(db), before, `write ${k}`);
  }
}

describe('the redeem file: only what it may do', () => {
  it('exports the one T2 writer and nothing else: a new export here is a reviewed change', () => {
    assert.deepEqual(Object.keys(redeemFile).sort(), ['redeemApproval']);
  });
});

describe('T2 through risk\'s own verifier: a token used once, its order recorded from the validated snapshot', () => {
  it('a buy: the token is consumed at the redeem\'s time and slot, and its order holds exactly the text\'s fields', () => {
    withWorld((w) => {
      const token = approveBuy(w);
      const result = w.h.a.redeemer.redeem(token, BUY);
      assert.equal(result.ok, true);
      const a = w.db.get('SELECT consumed_at, consumed_slot FROM approvals WHERE token_id = ?', token.id);
      assert.deepEqual([a?.['consumed_at'], a?.['consumed_slot']], [BigInt(REDEEM_AT), 1_005n]);
      const o = w.db.get('SELECT * FROM orders');
      assert.deepEqual(
        [o?.['id'], o?.['intent_id'], o?.['token_id'], o?.['position_id'], o?.['mode'], o?.['kind'], o?.['status'], o?.['plan_hash'], o?.['plan_json'], o?.['in_amount'], o?.['min_out'], o?.['max_spend'], o?.['quote_slot'], o?.['created_at'], o?.['updated_at']],
        ['order-1', 'intent-1', token.id, 'p1', 'paper', 'buy', 'approved', planHash(BUY), canonicalPlan(BUY), '55000000', '980000000', planMaxSpend(BUY).toString(), 1_000n, BigInt(REDEEM_AT), BigInt(REDEEM_AT)],
      );
      assert.deepEqual(buyOrderOf(w.db, 'p1'), {
        id: 'order-1',
        intentId: 'intent-1',
        tokenId: token.id,
        positionId: 'p1',
        mode: 'paper',
        kind: 'buy',
        status: 'approved',
        planHash: planHash(BUY),
        inAmount: 55_000_000n,
        minOut: 980_000_000n,
        maxSpend: planMaxSpend(BUY),
        quoteSlot: 1_000n,
        createdAt: REDEEM_AT,
        updatedAt: REDEEM_AT,
      });
      assert.equal(buyOrderOf(w.db, 'p9'), null);
      // once only: the second redeem is refused, and nothing is written
      const before = dump(w.db);
      const again = w.h.a.redeemer.redeem(token, BUY);
      assert.equal(again.ok, false);
      assert.equal(dump(w.db), before);
      assert.ok(!dump(w.db).includes(token.mac), 'the MAC is in no cell');
    });
  });

  it('an exit: the sell and then the close are recorded, one in flight at a time, and the exits in flight count them', () => {
    withWorld((w) => {
      assert.equal(w.h.a.redeemer.redeem(approveBuy(w), BUY).ok, true);
      settleBuy(w.db, 'p1');
      assert.deepEqual(exitsInFlight(w.db, 'p1'), { count: 0, sellTokens: 0n });
      const sell = approveExit(w, SELL, 0);
      assert.equal(w.h.a.redeemer.redeem(sell, SELL).ok, true);
      assert.deepEqual(exitsInFlight(w.db, 'p1'), { count: 1, sellTokens: 400_000n });
      // a second exit while one is in flight is the database's refusal: nothing is written
      const close = approveExit(w, CLOSE, 1);
      const before = dump(w.db);
      storageError(() => w.db.transaction((tx) => redeemApproval(tx, close.id, snapshotOf(close, CLOSE), canonicalPlan(CLOSE), REDEEM_AT)), 'constraint');
      assert.equal(dump(w.db), before);
      w.db.transaction((tx) => tx.run("UPDATE orders SET status = 'failed', updated_at = ? WHERE id = 'order-2'", BigInt(T + 20)));
      assert.deepEqual(exitsInFlight(w.db, 'p1'), { count: 0, sellTokens: 0n });
      assert.equal(w.h.a.redeemer.redeem(close, CLOSE).ok, true);
      assert.deepEqual(exitsInFlight(w.db, 'p1'), { count: 1, sellTokens: 0n }); // a close spends no tokens
      assert.equal(count(w.db, 'orders'), 3n);
    });
  });
});

describe('T2 refuses, with nothing written, whatever does not agree', () => {
  it('a token that is not there, and an already used one (false, nothing written)', () => {
    withWorld((w) => {
      const token = approveBuy(w);
      refusedInside(w.db, (tx) => redeemApproval(tx, 'tok-nope', snapshotOf(token, BUY), canonicalPlan(BUY), REDEEM_AT), 'row-missing');
      assert.equal(w.db.transaction((tx) => redeemApproval(tx, token.id, snapshotOf(token, BUY), canonicalPlan(BUY), REDEEM_AT)), true);
      const before = dump(w.db);
      assert.equal(w.db.transaction((tx) => redeemApproval(tx, token.id, snapshotOf(token, BUY), canonicalPlan(BUY), REDEEM_AT)), false);
      assert.equal(dump(w.db), before);
    });
  });

  it('each snapshot field that disagrees with the stored approval or the text, one at a time, and a text of another plan', () => {
    withWorld((w) => {
      const token = approveBuy(w);
      const good = snapshotOf(token, BUY);
      const tampered: readonly Partial<Record<keyof RedeemSnapshot, unknown>>[] = [
        { intentId: 'intent-2' },
        { positionId: 'p2' },
        { mode: 'live' },
        { kind: 'sell' },
        { reduceOnly: true },
        { planHash: planHash({ ...BUY, minOut: 1n }) },
        { maxSpendLamports: token.maxSpendLamports + 1n },
        { minOut: token.minOut + 1n },
        { expiresAtSlot: token.expiresAtSlot + 1n },
        { slot: -1n },
      ];
      for (const patch of tampered) {
        refusedInside(w.db, (tx) => redeemApproval(tx, token.id, { ...good, ...patch } as RedeemSnapshot, canonicalPlan(BUY), REDEEM_AT), 'bad-param');
      }
      refusedInside(w.db, (tx) => redeemApproval(tx, token.id, good, canonicalPlan({ ...BUY, minOut: BUY.minOut - 1n }), REDEEM_AT), 'bad-param');
      // a text that differs only in a field storage does not bind: only the hash tells
      refusedInside(w.db, (tx) => redeemApproval(tx, token.id, good, canonicalPlan({ ...BUY, venue: 'raydium-cpmm' }), REDEEM_AT), 'bad-param', /name one plan/);
      refusedInside(w.db, (tx) => redeemApproval(tx, token.id, good, `${canonicalPlan(BUY)} `, REDEEM_AT), 'bad-param');
      refusedInside(w.db, (tx) => redeemApproval(tx, 'bad id', good, canonicalPlan(BUY), REDEEM_AT), 'bad-param');
      refusedInside(w.db, (tx) => redeemApproval(tx, token.id, good, canonicalPlan(BUY), Number.NaN), 'bad-param');
      assert.equal(count(w.db, 'orders'), 0n);
    });
  });

  it('the order comes from the text, never from an object: a snapshot whose plan object says otherwise changes nothing in the row', () => {
    withWorld((w) => {
      const token = approveBuy(w);
      const odd = { ...snapshotOf(token, BUY), plan: validatePlan({ ...BUY, inAmount: 1n, orderId: 'order-x' }) };
      assert.equal(w.db.transaction((tx) => redeemApproval(tx, token.id, odd, canonicalPlan(BUY), REDEEM_AT)), true);
      const o = w.db.get('SELECT id, in_amount, plan_json FROM orders');
      assert.deepEqual([o?.['id'], o?.['in_amount'], o?.['plan_json']], ['order-1', '55000000', canonicalPlan(BUY)]);
    });
  });

  it('a slot one below the plan\'s quote or one above the token\'s expiry, and a clock behind the token\'s issue; both slot edges are fine', () => {
    withWorld((w) => {
      const token = approveBuy(w);
      refusedInside(w.db, (tx) => redeemApproval(tx, token.id, snapshotOf(token, BUY, 999n), canonicalPlan(BUY), REDEEM_AT), 'bad-param', /slot/);
      refusedInside(w.db, (tx) => redeemApproval(tx, token.id, snapshotOf(token, BUY, 1_026n), canonicalPlan(BUY), REDEEM_AT), 'bad-param', /slot/);
      refusedInside(w.db, (tx) => redeemApproval(tx, token.id, snapshotOf(token, BUY), canonicalPlan(BUY), T - 1), 'bad-param', /issued/);
      assert.equal(w.db.transaction((tx) => redeemApproval(tx, token.id, snapshotOf(token, BUY, 1_000n), canonicalPlan(BUY), T)), true);
    });
    withWorld((w) => {
      const token = approveBuy(w);
      assert.equal(w.db.transaction((tx) => redeemApproval(tx, token.id, snapshotOf(token, BUY, 1_025n), canonicalPlan(BUY), REDEEM_AT)), true);
    });
  });

  it('a buy whose plan spends more than its stored token allows (only a database changed behind the bot\'s back): refused before the database\'s own CHECK', () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, 'bot.sqlite');
      const seed = migratedDb(file);
      const store = new SqliteStore();
      store.db = seed;
      const w = { db: seed, h: authority({ store }), store };
      seed.transaction((tx) => {
        setUpConfig(tx, T, firstVersion(DEFAULT_TUNABLES, T));
        setUpLedger(tx, T, lamports(550_000_000n));
      });
      const token = approveBuy(w);
      seed.close();
      tamper(file, `DROP TRIGGER approvals_single_use;\nUPDATE approvals SET max_spend = '1' WHERE token_id = '${token.id}';`);
      const db = migratedDb(file);
      try {
        refusedInside(db, (tx) => redeemApproval(tx, token.id, { ...snapshotOf(token, BUY), maxSpendLamports: lamports(1n) }, canonicalPlan(BUY), REDEEM_AT), 'bad-param', /within its token's spend/);
      } finally {
        db.close();
      }
    } finally {
      removeDir(dir);
    }
  });

  it('a stored approval whose plan trades another mint than its position\'s (a writer bug, or a database changed behind the bot\'s back): refused for a buy and a sell, also through risk\'s verifier (review S, risk 1 and security 3)', () => {
    /** The row insertApproval itself refuses for this plan, written by hand. */
    const storeByHand = (db: Db, token: ApprovalToken, plan: OrderPlan): void => {
      db.transaction((tx) =>
        tx.run(
          'INSERT INTO approvals (token_id, intent_id, position_id, mode, kind, reduce_only, plan_hash, max_spend, min_out, quote_slot, expires_at_slot, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          token.id,
          token.intentId,
          token.positionId,
          token.mode,
          token.kind,
          token.reduceOnly ? 1n : 0n,
          token.planHash,
          token.maxSpendLamports.toString(),
          token.minOut.toString(),
          plan.quoteSlot,
          token.expiresAtSlot,
          BigInt(T),
        ),
      );
    };
    withWorld((w) => {
      const buyZ = { ...BUY, mint: 'MintZ' } as OrderPlan;
      w.db.transaction((tx) => {
        insertEntryIntent(tx, { id: 'intent-1', mode: 'paper', strategy: 'momentum', mint: 'MintA', positionId: 'p1', sizeHint: 'normal', confidenceBps: null, createdAt: T, inputsAsOf: null, reasons: ['flow-up'], inputs: {} });
        insertOpening(tx, { id: 'p1', mint: 'MintA', strategy: 'momentum', mode: 'paper', openedAt: T, maxSpend: planMaxSpend(buyZ) }, lamports(2_000_000n));
        insertDecision(tx, { outcome: 'entry-approved', intentId: 'intent-1', at: T, configVersion: 1, slot: 1_005n, size: lamports(BUY.inAmount), limitedBy: 'per-trade', binding: 'per-trade' });
      });
      const token = issue(w.h, buyZ);
      storeByHand(w.db, token, buyZ);
      refusedInside(w.db, (tx) => redeemApproval(tx, token.id, snapshotOf(token, buyZ), canonicalPlan(buyZ), REDEEM_AT), 'bad-param', /position's mint/);
      const before = dump(w.db);
      assert.equal(w.h.a.redeemer.redeem(token, buyZ).ok, false);
      assert.equal(dump(w.db), before);
      assert.equal(count(w.db, 'orders'), 0n);
    });
    withWorld((w) => {
      assert.equal(w.h.a.redeemer.redeem(approveBuy(w), BUY).ok, true);
      settleBuy(w.db, 'p1');
      const sellZ = { ...SELL, mint: 'MintZ' } as OrderPlan;
      w.db.transaction((tx) => {
        insertExitIntent(tx, { id: 'exit-p1-0', positionId: 'p1', exitSeq: 0, fractionBps: 10_000, urgency: 'normal', createdAt: T + 3, inputsAsOf: null, reasons: ['take-profit'], inputs: {} });
        insertDecision(tx, { outcome: 'exit-approved', intentId: 'exit-p1-0', at: T + 3, configVersion: 1, slot: 1_005n });
      });
      const token = issue(w.h, sellZ);
      storeByHand(w.db, token, sellZ);
      refusedInside(w.db, (tx) => redeemApproval(tx, token.id, snapshotOf(token, sellZ), canonicalPlan(sellZ), REDEEM_AT), 'bad-param', /position's mint/);
      const before = dump(w.db);
      assert.equal(w.h.a.redeemer.redeem(token, sellZ).ok, false);
      assert.equal(dump(w.db), before);
      assert.equal(count(w.db, 'orders'), 1n); // the buy only
    });
  });

  it('a position that can no longer take the order: an abandoned buy\'s token is never used', () => {
    withWorld((w) => {
      const token = approveBuy(w);
      w.db.transaction((tx) => abandonOpening(tx, 'p1', T + 5)); // no order yet: the token was never used
      refusedInside(w.db, (tx) => redeemApproval(tx, token.id, snapshotOf(token, BUY), canonicalPlan(BUY), REDEEM_AT), 'row-count', /position/);
      assert.equal(w.h.a.redeemer.redeem(token, BUY).ok, false);
      assert.equal(readPosition(w.db, 'p1').status, 'closed');
    });
  });
});

describe('abandoning against each status of the buy order: only once the buy can no longer land', () => {
  for (const [status, path, allowed] of [
    ['approved', [] as string[], false],
    ['submitted', ['submitted'], false],
    ['landed', ['submitted', 'landed'], false],
    ['failed', ['failed'], true],
    ['expired', ['submitted', 'expired'], true],
  ] as const) {
    it(`a buy that is ${status}: ${allowed ? 'abandoned' : 'refused, it may still land or has landed'}`, () => {
      withWorld((w) => {
        assert.equal(w.h.a.redeemer.redeem(approveBuy(w), BUY).ok, true);
        for (const next of path) {
          w.db.transaction((tx) => tx.run('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', next, BigInt(T + 20), 'order-1'));
        }
        assert.equal(buyOrderOf(w.db, 'p1')?.status, status);
        if (allowed) {
          assert.equal(w.db.transaction((tx) => abandonOpening(tx, 'p1', T + 30)).status, 'closed');
        } else {
          refusedInside(w.db, (tx) => abandonOpening(tx, 'p1', T + 30), 'row-count', /may still land/);
        }
      });
    });
  }
});

describe('a write that fails part-way leaves nothing: each write of a call failing in turn', () => {
  it('the setup, a buy\'s T1, an exit intent and T2', () => {
    const db = migratedDb();
    try {
      failsCleanly(db, 3, (tx) => setUpLedger(tx, T, lamports(550_000_000n))); // the audit row and the two accounts
      db.transaction((tx) => {
        setUpConfig(tx, T, firstVersion(DEFAULT_TUNABLES, T));
        setUpLedger(tx, T, lamports(550_000_000n));
      });
    } finally {
      db.close();
    }
    withWorld((w) => {
      const token = issue(w.h, BUY);
      const t1 = (tx: Tx): void => {
        insertEntryIntent(tx, { id: 'intent-1', mode: 'paper', strategy: 'momentum', mint: 'MintA', positionId: 'p1', sizeHint: 'normal', confidenceBps: null, createdAt: T, inputsAsOf: null, reasons: ['flow-up'], inputs: {} });
        insertOpening(tx, { id: 'p1', mint: 'MintA', strategy: 'momentum', mode: 'paper', openedAt: T, maxSpend: planMaxSpend(BUY) }, lamports(0n));
        insertDecision(tx, { outcome: 'entry-approved', intentId: 'intent-1', at: T, configVersion: 1, slot: 1_005n, size: lamports(1n), limitedBy: 'per-trade', binding: 'per-trade' });
        insertApproval(tx, token, canonicalPlan(BUY), T);
      };
      failsCleanly(w.db, 4, t1);
      w.db.transaction(t1);
      failsCleanly(w.db, 2, (tx) => redeemApproval(tx, token.id, snapshotOf(token, BUY), canonicalPlan(BUY), REDEEM_AT));
      assert.equal(w.db.transaction((tx) => redeemApproval(tx, token.id, snapshotOf(token, BUY), canonicalPlan(BUY), REDEEM_AT)), true);
      settleBuy(w.db, 'p1');
      failsCleanly(w.db, 2, (tx) => insertExitIntent(tx, { id: 'exit-p1-0', positionId: 'p1', exitSeq: 0, fractionBps: 10_000, urgency: 'normal', createdAt: T + 3, inputsAsOf: null, reasons: ['take-profit'], inputs: {} }));
      assert.equal(readPosition(w.db, 'p1').exitSeq, 0);
    });
  });
});
