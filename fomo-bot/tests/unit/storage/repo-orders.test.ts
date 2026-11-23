// The money path up to the token (STORAGE_DESIGN.md s.15.6 and s.15.8): what a strategy asked for
// (an entry or exit intent), what risk decided, and the one-time approval, as T1 writes them in one
// transaction. Intents and decisions hold codes and numbers only (no prose, no addresses, no lists of
// numbers), through jsonParam; an exit's mode and mint come from its position, and each exit intent
// uses up the position's next number. An approval is stored only for an approved decision, from
// risk's own token and risk's own canonical plan text: storage hashes the text itself and requires
// the token's hash, and the MAC is never stored. Written before src/storage/repo-orders.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { firstVersion, nextVersion } from '../../../src/config/changes.ts';
import { DEFAULT_TUNABLES, valueAt, withValue, boundsOf } from '../../../src/config/tunables.ts';
import { lamports } from '../../../src/core/units.ts';
import type { ApprovalToken } from '../../../src/risk/approval.ts';
import { canonicalPlan, planHash, planMaxSpend, type OrderPlan } from '../../../src/risk/plan.ts';
import { insertOpening, readPosition } from '../../../src/storage/repo-book.ts';
import * as ordersFile from '../../../src/storage/repo-orders.ts';
import {
  ORDER_STATUSES,
  buyTokenExpiry,
  insertApproval,
  insertDecision,
  insertEntryIntent,
  insertExitIntent,
  intentExists,
  outstandingExitApprovals,
  type NewDecision,
  type NewEntryIntent,
  type NewExitIntent,
} from '../../../src/storage/repo-orders.ts';
import { writeOwnerConfig } from '../../../src/storage/repo-owner.ts';
import { setUpConfig, setUpLedger } from '../../../src/storage/repo-server.ts';
import type { Db, Tx } from '../../../src/storage/sqlite.ts';
import { TEST_NOW, count, dump, migratedDb, storageError } from './helpers.ts';
import { BUY, CLOSE, SELL, authority, issue, type Harness } from './money-fixtures.ts';

const T = TEST_NOW;

const ENTRY: NewEntryIntent = Object.freeze({
  id: 'intent-1',
  mode: 'paper',
  strategy: 'momentum',
  mint: 'MintA',
  positionId: 'p1',
  sizeHint: 'normal',
  confidenceBps: 7_500,
  createdAt: T,
  inputsAsOf: T - 1_000,
  reasons: Object.freeze(['flow-up', 'fresh-pool']),
  inputs: Object.freeze({ netFlowLamports: 123_456_789n, windowMs: 60_000, fresh: true, venue: 'pumpswap', score: null }),
});

const EXIT: NewExitIntent = Object.freeze({
  id: 'exit-p1-0',
  positionId: 'p1',
  exitSeq: 0,
  fractionBps: 10_000,
  urgency: 'normal',
  createdAt: T + 1,
  inputsAsOf: null,
  reasons: Object.freeze(['take-profit']),
  inputs: Object.freeze({}),
});

const approvedEntry = (intentId = 'intent-1'): NewDecision => ({
  outcome: 'entry-approved',
  intentId,
  at: T,
  configVersion: 1,
  slot: 1_005n,
  size: lamports(55_000_000n),
  limitedBy: 'per-trade',
  binding: 'per-trade',
});

function withDb(fn: (db: Db, h: Harness) => void): void {
  const db = migratedDb();
  try {
    db.transaction((tx) => {
      setUpConfig(tx, T, firstVersion(DEFAULT_TUNABLES, T));
      setUpLedger(tx, T, lamports(550_000_000n));
    });
    fn(db, authority());
  } finally {
    db.close();
  }
}

/** A careless caller that catches the refusal inside the transaction and commits: nothing of the call is written. */
function refusedInside(db: Db, fn: (tx: Tx) => unknown, code: Parameters<typeof storageError>[1], why: RegExp = /./): void {
  const before = dump(db);
  db.transaction((tx) => {
    assert.match(storageError(() => fn(tx), code).detail, why);
  });
  assert.equal(dump(db), before);
}

const openingOf = (plan: OrderPlan) => ({ id: plan.positionId, mint: plan.mint, strategy: 'momentum' as const, mode: plan.mode, openedAt: T, maxSpend: planMaxSpend(plan) });

/** T1's buy writes up to the decision (the token is the test's to store). */
function boughtUpToDecision(db: Db, plan: OrderPlan = BUY): void {
  db.transaction((tx) => {
    insertEntryIntent(tx, { ...ENTRY, id: plan.intentId, mint: plan.mint, positionId: plan.positionId, mode: plan.mode });
    insertOpening(tx, openingOf(plan), lamports(2_000_000n));
    insertDecision(tx, approvedEntry(plan.intentId));
  });
}

/** What T3 will do (the buy settled, the position holds tokens), written by hand: no writer in this step makes it. */
function holdTokens(db: Db, id: string): void {
  db.transaction((tx) => tx.run("UPDATE positions SET status = 'open', max_spend = NULL, token_units = '400000', tokens_bought = '400000', updated_at = ? WHERE id = ?", BigInt(T + 1), id));
}

const intentRow = (db: Db, id: string) => db.get('SELECT * FROM intents WHERE id = ?', id);
const approvalRow = (db: Db, id: string) => db.get('SELECT * FROM approvals WHERE token_id = ?', id);

describe('the orders file: only what it may do', () => {
  it('exports the intent, decision and approval writers, the order and approval readers and the order statuses, and nothing else', () => {
    assert.deepEqual(Object.keys(ordersFile).sort(), [
      'ORDER_STATUSES',
      'buyOrderOf',
      'buyTokenExpiry',
      'exitsInFlight',
      'insertApproval',
      'insertDecision',
      'insertEntryIntent',
      'insertExitIntent',
      'intentExists',
      'outstandingExitApprovals',
    ]);
    assert.deepEqual([...ORDER_STATUSES], ['approved', 'submitted', 'landed', 'failed', 'expired']);
    assert.ok(Object.isFrozen(ORDER_STATUSES));
  });
});

describe('entry intents: what a strategy asked for, in codes and numbers only', () => {
  it('stores an entry with its own columns set and the exit columns empty; its reasons and inputs as jsonParam writes them', () => {
    withDb((db) => {
      assert.equal(intentExists(db, 'intent-1'), false);
      db.transaction((tx) => insertEntryIntent(tx, ENTRY));
      assert.equal(intentExists(db, 'intent-1'), true);
      const r = intentRow(db, 'intent-1');
      assert.deepEqual(
        [r?.['kind'], r?.['mode'], r?.['strategy'], r?.['mint'], r?.['position_id'], r?.['size_hint'], r?.['confidence_bps'], r?.['exit_seq'], r?.['fraction_bps'], r?.['urgency']],
        ['entry', 'paper', 'momentum', 'MintA', 'p1', 'normal', 7_500n, null, null, null],
      );
      assert.deepEqual([r?.['created_at'], r?.['inputs_as_of']], [BigInt(T), BigInt(T - 1_000)]);
      assert.equal(r?.['reasons_json'], '{"reasons":["flow-up","fresh-pool"]}');
      assert.equal(r?.['inputs_json'], '{"netFlowLamports":"123456789","windowMs":60000,"fresh":true,"venue":"pumpswap","score":null}');
    });
  });

  it('each optional column on its own: no confidence, no inputs time, empty inputs', () => {
    withDb((db) => {
      db.transaction((tx) => insertEntryIntent(tx, { ...ENTRY, confidenceBps: null, inputsAsOf: null, inputs: {}, sizeHint: 'min' }));
      const r = intentRow(db, 'intent-1');
      assert.deepEqual([r?.['confidence_bps'], r?.['inputs_as_of'], r?.['inputs_json'], r?.['size_hint']], [null, null, '{}', 'min']);
    });
  });

  it('refuses, before any write, every field outside its form', () => {
    withDb((db) => {
      const bad: readonly Partial<Record<keyof NewEntryIntent, unknown>>[] = [
        { id: 'i'.repeat(64) },
        { id: 'bad id' },
        { mint: 'mysecretmint' },
        { positionId: '' },
        { mode: 'demo' },
        { strategy: 'copy' },
        { sizeHint: 'max' },
        { confidenceBps: -1 },
        { confidenceBps: 10_001 },
        { confidenceBps: 1.5 },
        { createdAt: Number.NaN },
        { inputsAsOf: -1 },
        { reasons: [] },
        { reasons: Array.from({ length: 17 }, (_v, i) => `r${i}`) },
        { reasons: ['flow-up', 'flow-up'] },
        { reasons: ['Flow Up'] },
        { reasons: 'flow-up' },
      ];
      for (const patch of bad) {
        refusedInside(db, (tx) => insertEntryIntent(tx, { ...ENTRY, ...patch } as NewEntryIntent), 'bad-param');
      }
      assert.equal(count(db, 'intents'), 0n);
    });
  });

  it('inputs are a flat record of at most 32 named whole numbers, amounts, flags and codes: no lists, objects, fractions or addresses', () => {
    withDb((db) => {
      const bad: readonly unknown[] = [
        { nested: { a: 1 } },
        { list: [1, 2] },
        { ratio: 0.5 },
        { wallet: 'Hk7wqzJ1mPZ3nYwLgk8Fa4Rr2Tq9vXs5' }, // an address is not a code
        { tooBig: Number.MAX_SAFE_INTEGER + 1 },
        Object.fromEntries(Array.from({ length: 33 }, (_v, i) => [`k${i}`, i])),
        { Bad: 1 },
        { '1x': 1 },
        { ['k'.repeat(33)]: 1 },
        { looksLikeAKey: 'a'.repeat(64) }, // a value the secret filter refuses
        { when: new Date(0) },
        ['list'],
        null,
        new Date(0), // a record of another kind
        { [Symbol('hidden')]: 1 },
        Object.defineProperty({}, 'lazy', { get: () => 1, enumerable: true }),
      ];
      for (const inputs of bad) {
        refusedInside(db, (tx) => insertEntryIntent(tx, { ...ENTRY, inputs } as NewEntryIntent), 'bad-param');
      }
    });
  });

  it('the largest intent passes: 16 reasons and 32 inputs at their longest', () => {
    withDb((db) => {
      const code = (i: number): string => `${String(i).padStart(2, '0')}.${'v'.repeat(30)}:${'w'.repeat(30)}`; // 64 characters, no 64 key-like ones in a row
      const reasons = Array.from({ length: 16 }, (_v, i) => code(i));
      const inputs = Object.fromEntries(Array.from({ length: 32 }, (_v, i) => [`k${String(i).padStart(2, '0')}${'x'.repeat(29)}`, code(i)]));
      db.transaction((tx) => insertEntryIntent(tx, { ...ENTRY, reasons, inputs }));
      assert.ok(String(intentRow(db, 'intent-1')?.['inputs_json']).length > 3_000);
    });
  });

  it('an entry opens a new position: an existing position id is refused, and a second intent with the same id is the database\'s refusal', () => {
    withDb((db) => {
      boughtUpToDecision(db);
      refusedInside(db, (tx) => insertEntryIntent(tx, { ...ENTRY, id: 'intent-2' }), 'row-count', /new position/);
      const before = dump(db);
      storageError(() => db.transaction((tx) => insertEntryIntent(tx, { ...ENTRY, positionId: 'p9' })), 'constraint');
      assert.equal(dump(db), before);
    });
  });
});

describe('exit intents: the position\'s mode and mint, and its next exit number, used up once', () => {
  it('takes the mode and the mint from the position, never from the caller, and uses up the number', () => {
    withDb((db) => {
      boughtUpToDecision(db, { ...BUY, mode: 'paper' });
      holdTokens(db, 'p1');
      db.transaction((tx) => insertExitIntent(tx, EXIT));
      const r = intentRow(db, 'exit-p1-0');
      assert.deepEqual(
        [r?.['kind'], r?.['mode'], r?.['mint'], r?.['position_id'], r?.['strategy'], r?.['size_hint'], r?.['confidence_bps'], r?.['exit_seq'], r?.['fraction_bps'], r?.['urgency']],
        ['exit', 'paper', 'MintA', 'p1', null, null, null, 0n, 10_000n, 'normal'],
      );
      assert.equal(r?.['reasons_json'], '{"reasons":["take-profit"]}');
      assert.equal(readPosition(db, 'p1').exitSeq, 1);
      // the next exit, approved or refused, takes the next number
      refusedInside(db, (tx) => insertExitIntent(tx, { ...EXIT, id: 'exit-p1-again' }), 'row-count', /next exit number/);
      db.transaction((tx) => insertExitIntent(tx, { ...EXIT, id: 'exit-p1-1', exitSeq: 1, urgency: 'emergency', fractionBps: 1, inputsAsOf: T - 500 }));
      assert.equal(readPosition(db, 'p1').exitSeq, 2);
      const second = intentRow(db, 'exit-p1-1');
      assert.deepEqual([second?.['urgency'], second?.['fraction_bps'], second?.['inputs_as_of']], ['emergency', 1n, BigInt(T - 500)]);
    });
  });

  it('refused, with nothing written: a position that cannot exit, a missing one, and every field outside its form', () => {
    withDb((db) => {
      boughtUpToDecision(db);
      refusedInside(db, (tx) => insertExitIntent(tx, EXIT), 'row-count', /open or exiting/); // still opening
      refusedInside(db, (tx) => insertExitIntent(tx, { ...EXIT, positionId: 'nope' }), 'row-missing');
      holdTokens(db, 'p1');
      for (const patch of [{ fractionBps: 0 }, { fractionBps: 10_001 }, { urgency: 'panic' }, { exitSeq: -1 }, { exitSeq: 1_000_000 }, { createdAt: Number.NaN }, { reasons: [] }, { inputs: { x: [1] } }, { id: 'bad id' }]) {
        refusedInside(db, (tx) => insertExitIntent(tx, { ...EXIT, ...patch } as NewExitIntent), 'bad-param');
      }
      assert.equal(readPosition(db, 'p1').exitSeq, 0);
    });
  });
});

describe('risk decisions: one per intent, its outcome fitting the intent, under the active config', () => {
  it('stores an approved entry with its size, an approved exit without one, and a refusal with its stage and reasons', () => {
    withDb((db) => {
      boughtUpToDecision(db);
      const d = db.get("SELECT * FROM risk_decisions WHERE intent_id = 'intent-1'");
      assert.deepEqual(
        [d?.['approved'], d?.['stage'], d?.['reasons_json'], d?.['size'], d?.['limited_by'], d?.['binding'], d?.['slot'], d?.['config_version'], d?.['at']],
        [1n, null, '{"reasons":[]}', '55000000', 'per-trade', 'per-trade', 1_005n, 1n, BigInt(T)],
      );
      holdTokens(db, 'p1');
      db.transaction((tx) => {
        insertExitIntent(tx, EXIT);
        insertDecision(tx, { outcome: 'exit-approved', intentId: 'exit-p1-0', at: T + 2, configVersion: 1, slot: 1_006n });
        insertExitIntent(tx, { ...EXIT, id: 'exit-p1-1', exitSeq: 1 });
        insertDecision(tx, { outcome: 'refused', intentId: 'exit-p1-1', at: T + 3, configVersion: 1, stage: 'plan', reasons: ['plan:min-out-below-slippage'], slot: 1_007n });
      });
      const exit = db.get("SELECT approved, stage, size, limited_by, binding, reasons_json FROM risk_decisions WHERE intent_id = 'exit-p1-0'");
      assert.deepEqual([exit?.['approved'], exit?.['stage'], exit?.['size'], exit?.['limited_by'], exit?.['binding'], exit?.['reasons_json']], [1n, null, null, null, null, '{"reasons":[]}']);
      const refusal = db.get("SELECT approved, stage, reasons_json, slot FROM risk_decisions WHERE intent_id = 'exit-p1-1'");
      assert.deepEqual([refusal?.['approved'], refusal?.['stage'], refusal?.['reasons_json'], refusal?.['slot']], [0n, 'plan', '{"reasons":["plan:min-out-below-slippage"]}', 1_007n]);
    });
  });

  it('an error with an unknown slot stores slot 0, which means unknown; nowhere else may the slot be unknown', () => {
    withDb((db) => {
      db.transaction((tx) => {
        insertEntryIntent(tx, { ...ENTRY, inputs: {} });
        insertDecision(tx, { outcome: 'refused', intentId: 'intent-1', at: T, configVersion: 1, stage: 'error', reasons: ['slot-unknown'], slot: null });
      });
      assert.equal(db.get("SELECT slot FROM risk_decisions WHERE intent_id = 'intent-1'")?.['slot'], 0n);
    });
    withDb((db) => {
      db.transaction((tx) => insertEntryIntent(tx, ENTRY));
      refusedInside(db, (tx) => insertDecision(tx, { outcome: 'refused', intentId: 'intent-1', at: T, configVersion: 1, stage: 'blocked', reasons: ['kill'], slot: null }), 'bad-param', /slot/);
      refusedInside(db, (tx) => insertDecision(tx, { ...approvedEntry(), slot: null as unknown as bigint }), 'bad-param');
    });
  });

  it('a known slot is at least 1, so a stored 0 can only mean unknown: slot 0 is refused for an approval and for a refusal of any stage, error included (review S)', () => {
    withDb((db) => {
      boughtUpToDecision(db, { ...BUY, intentId: 'intent-0', positionId: 'p0', mint: 'MintZ' });
      holdTokens(db, 'p0');
      db.transaction((tx) => {
        insertEntryIntent(tx, ENTRY);
        insertExitIntent(tx, { ...EXIT, id: 'exit-p0-0', positionId: 'p0' });
      });
      refusedInside(db, (tx) => insertDecision(tx, { ...approvedEntry(), slot: 0n }), 'bad-param', /known slot of at least 1/);
      refusedInside(db, (tx) => insertDecision(tx, { outcome: 'exit-approved', intentId: 'exit-p0-0', at: T, configVersion: 1, slot: 0n }), 'bad-param', /known slot of at least 1/);
      for (const stage of ['blocked', 'sizing', 'plan', 'error'] as const) {
        refusedInside(db, (tx) => insertDecision(tx, { outcome: 'refused', intentId: 'intent-1', at: T, configVersion: 1, stage, reasons: ['x'], slot: 0n }), 'bad-param', /known slot of at least 1/);
      }
      db.transaction((tx) => insertDecision(tx, { ...approvedEntry(), slot: 1n }));
      db.transaction((tx) => insertDecision(tx, { outcome: 'exit-approved', intentId: 'exit-p0-0', at: T, configVersion: 1, slot: 1n }));
      assert.deepEqual(db.all('SELECT slot FROM risk_decisions ORDER BY intent_id').map((r) => r['slot']), [1n, 1_005n, 1n]);
    });
  });

  it('the outcome must fit the intent: an entry is approved or refused as an entry, an exit as an exit; blocks and sizing are entry stages', () => {
    withDb((db) => {
      boughtUpToDecision(db);
      holdTokens(db, 'p1');
      db.transaction((tx) => insertExitIntent(tx, EXIT));
      refusedInside(db, (tx) => insertDecision(tx, approvedEntry('exit-p1-0')), 'bad-param', /exit/);
      for (const stage of ['blocked', 'sizing'] as const) {
        refusedInside(db, (tx) => insertDecision(tx, { outcome: 'refused', intentId: 'exit-p1-0', at: T, configVersion: 1, stage, reasons: ['x'], slot: 1n }), 'bad-param');
      }
      db.transaction((tx) => insertEntryIntent(tx, { ...ENTRY, id: 'intent-2', mint: 'MintB', positionId: 'p2' }));
      refusedInside(db, (tx) => insertDecision(tx, { outcome: 'exit-approved', intentId: 'intent-2', at: T, configVersion: 1, slot: 1n }), 'bad-param', /entry/);
      refusedInside(db, (tx) => insertDecision(tx, { outcome: 'refused', intentId: 'intent-2', at: T, configVersion: 1, stage: 'duplicate' as 'plan', reasons: ['x'], slot: 1n }), 'bad-param');
      refusedInside(db, (tx) => insertDecision(tx, approvedEntry('nope')), 'row-missing');
      // one decision per intent: a second one is the database's refusal
      const before = dump(db);
      storageError(() => db.transaction((tx) => insertDecision(tx, approvedEntry('intent-1'))), 'constraint');
      assert.equal(dump(db), before);
    });
  });

  it('refused, with nothing written: a size, limit or binding outside its list, and reasons that are empty, repeated or no codes', () => {
    withDb((db) => {
      db.transaction((tx) => insertEntryIntent(tx, ENTRY));
      for (const patch of [{ size: 0n }, { size: -1n }, { limitedBy: 'luck' }, { binding: 'live-ramp' }, { at: Number.NaN }, { slot: -1n }]) {
        refusedInside(db, (tx) => insertDecision(tx, { ...approvedEntry(), ...patch } as NewDecision), 'bad-param');
      }
      for (const reasons of [[], ['kill', 'kill'], ['Kill switch'], Array.from({ length: 65 }, (_v, i) => `r${i}`)]) {
        refusedInside(db, (tx) => insertDecision(tx, { outcome: 'refused', intentId: 'intent-1', at: T, configVersion: 1, stage: 'blocked', reasons, slot: 1n }), 'bad-param');
      }
      db.transaction((tx) => insertDecision(tx, { outcome: 'refused', intentId: 'intent-1', at: T, configVersion: 1, stage: 'blocked', reasons: Array.from({ length: 64 }, (_v, i) => `block-${i}`), slot: 1n }));
    });
  });

  it('a decision is made under the active config version: an older one, or one that does not exist, is refused', () => {
    withDb((db) => {
      const v1 = firstVersion(DEFAULT_TUNABLES, T);
      const path = 'risk.dailyStopBps';
      const [lo, hi] = boundsOf(path);
      const v2 = nextVersion(v1, withValue(v1.values, path, valueAt(v1.values, path) === lo ? hi : lo), 'owner', T + 1);
      db.transaction((tx) => writeOwnerConfig(tx, T + 1, 'owner-telegram', 'owner:set', { version: v2, pending: [], cancelled: [] }));
      db.transaction((tx) => insertEntryIntent(tx, ENTRY));
      refusedInside(db, (tx) => insertDecision(tx, approvedEntry()), 'bad-param', /active config version/); // names version 1
      refusedInside(db, (tx) => insertDecision(tx, { ...approvedEntry(), configVersion: 3 }), 'bad-param', /active config version/);
      db.transaction((tx) => insertDecision(tx, { ...approvedEntry(), configVersion: 2 }));
    });
  });
});

/**
 * Lists of reasons that would hand back text that never met the code check, had storage used their
 * own methods or their prototype's, or read an element twice (review S, security 1).
 */
function sneakyLists(): readonly (readonly [string, unknown])[] {
  class Sneaky extends Array<string> {}
  const holey: string[] = [];
  holey[1] = 'flow-up';
  const own = <O extends object>(target: O, key: PropertyKey, d: PropertyDescriptor): O => Object.defineProperty(target, key, d);
  let reads = 0;
  return [
    ['its own map', own(['flow-up'], 'map', { value: () => ['Bad prose, never checked'] })],
    ['its own toJSON', own(['flow-up'], 'toJSON', { value: () => ['Bad prose, never checked'] })],
    ['a proxy that answers each read differently', new Proxy(['flow-up'], { get: (t, k) => (k === '0' ? ((reads += 1) === 1 ? 'flow-up' : 'Bad prose') : Reflect.get(t, k)) })],
    ['a proxy that changes nothing', new Proxy(['flow-up'], {})],
    ['a subclass', Sneaky.from(['flow-up'])],
    ['another prototype', Object.setPrototypeOf(['flow-up'], null)],
    ['a getter element', own(['x'], '0', { get: () => 'flow-up', enumerable: true, configurable: true })],
    ['a hidden element', own(['x'], '0', { value: 'flow-up', enumerable: false })],
    ['an extra property', Object.assign(['flow-up'], { note: 'Bad prose' })],
    ['a symbol property', Object.assign(['flow-up'], { [Symbol('s')]: 1 })],
    ['a hole', holey],
    ['a list-like object', { 0: 'flow-up', length: 1 }],
  ];
}

describe('reason lists: a plain list of codes, read element by element, never through the caller\'s own methods (review S, security 1)', () => {
  it('an entry intent, an exit intent and a refused decision each refuse every sneaky list, with nothing written; a plain or frozen list passes', () => {
    withDb((db) => {
      boughtUpToDecision(db);
      holdTokens(db, 'p1');
      db.transaction((tx) => insertEntryIntent(tx, { ...ENTRY, id: 'intent-2', mint: 'MintB', positionId: 'p2' }));
      const refusal = (reasons: unknown): NewDecision => ({ outcome: 'refused', intentId: 'intent-2', at: T, configVersion: 1, stage: 'blocked', reasons: reasons as string[], slot: 1n });
      for (const [what, reasons] of sneakyLists()) {
        const r = reasons as readonly string[];
        for (const [writer, call] of [
          ['entry', (tx: Tx) => insertEntryIntent(tx, { ...ENTRY, id: 'intent-3', mint: 'MintC', positionId: 'p3', reasons: r })],
          ['exit', (tx: Tx) => insertExitIntent(tx, { ...EXIT, reasons: r })],
          ['decision', (tx: Tx) => insertDecision(tx, refusal(r))],
        ] as const) {
          const before = dump(db);
          db.transaction((tx) => {
            assert.match(storageError(() => call(tx), 'bad-param').detail, /plain/, `${writer}: ${what}`);
          });
          assert.equal(dump(db), before, `${writer}: ${what}`);
        }
      }
      assert.equal(readPosition(db, 'p1').exitSeq, 0);
      db.transaction((tx) => {
        insertEntryIntent(tx, { ...ENTRY, id: 'intent-3', mint: 'MintC', positionId: 'p3', reasons: ['flow-up', 'fresh-pool'] });
        insertExitIntent(tx, { ...EXIT, reasons: Object.freeze(['take-profit']) });
        insertDecision(tx, refusal(['kill']));
      });
      assert.equal(db.get("SELECT reasons_json FROM risk_decisions WHERE intent_id = 'intent-2'")?.['reasons_json'], '{"reasons":["kill"]}');
    });
  });
});

describe('a decision\'s outcome is read once: the stored decision is the one that was checked (review S, security 2)', () => {
  it('an outcome that answers "refused" and then "exit-approved" is stored as the refusal it was checked as, never as an approval', () => {
    withDb((db) => {
      boughtUpToDecision(db);
      holdTokens(db, 'p1');
      db.transaction((tx) => insertExitIntent(tx, EXIT));
      let reads = 0;
      const shifty = Object.defineProperty({ intentId: 'exit-p1-0', at: T + 2, configVersion: 1, stage: 'plan', reasons: ['plan:min-out-below-slippage'], slot: 1_006n }, 'outcome', {
        get: () => ((reads += 1) === 1 ? 'refused' : 'exit-approved'),
        enumerable: true,
      }) as unknown as NewDecision;
      db.transaction((tx) => insertDecision(tx, shifty));
      assert.equal(reads, 1);
      const d = db.get("SELECT approved, stage, reasons_json FROM risk_decisions WHERE intent_id = 'exit-p1-0'");
      assert.deepEqual([d?.['approved'], d?.['stage'], d?.['reasons_json']], [0n, 'plan', '{"reasons":["plan:min-out-below-slippage"]}']);
    });
  });

  it('an outcome that answers "exit-approved" and then "refused" is checked and stored as the approval: the one answer read is the one kept', () => {
    withDb((db) => {
      boughtUpToDecision(db);
      holdTokens(db, 'p1');
      db.transaction((tx) => insertExitIntent(tx, EXIT));
      let reads = 0;
      const shifty = Object.defineProperty({ intentId: 'exit-p1-0', at: T + 2, configVersion: 1, slot: 1_006n }, 'outcome', {
        get: () => ((reads += 1) === 1 ? 'exit-approved' : 'refused'),
        enumerable: true,
      }) as unknown as NewDecision;
      db.transaction((tx) => insertDecision(tx, shifty));
      assert.equal(reads, 1);
      const d = db.get("SELECT approved, stage, reasons_json FROM risk_decisions WHERE intent_id = 'exit-p1-0'");
      assert.deepEqual([d?.['approved'], d?.['stage'], d?.['reasons_json']], [1n, null, '{"reasons":[]}']);
    });
  });
});

describe('approvals: risk\'s own token for an approved decision, bound to the plan text storage hashed itself', () => {
  it('a plan that trades another mint than its position\'s is refused for a buy, a sell and a close, with nothing written (review S, risk 1 and security 3)', () => {
    withDb((db, h) => {
      boughtUpToDecision(db);
      const buyZ = { ...BUY, mint: 'MintZ' };
      refusedInside(db, (tx) => insertApproval(tx, issue(h, buyZ), canonicalPlan(buyZ), T), 'bad-param', /position's mint/);
      holdTokens(db, 'p1');
      db.transaction((tx) => {
        insertExitIntent(tx, EXIT);
        insertDecision(tx, { outcome: 'exit-approved', intentId: 'exit-p1-0', at: T + 2, configVersion: 1, slot: 1_005n });
        insertExitIntent(tx, { ...EXIT, id: 'exit-p1-1', exitSeq: 1 });
        insertDecision(tx, { outcome: 'exit-approved', intentId: 'exit-p1-1', at: T + 3, configVersion: 1, slot: 1_005n });
      });
      for (const plan of [{ ...SELL, mint: 'MintZ' }, { ...CLOSE, mint: 'MintZ' }]) {
        refusedInside(db, (tx) => insertApproval(tx, issue(h, plan), canonicalPlan(plan), T + 3), 'bad-param', /position's mint/);
      }
      assert.equal(count(db, 'approvals'), 0n);
      // the same tokens for the position's own mint are fine
      db.transaction((tx) => {
        insertApproval(tx, issue(h, SELL), canonicalPlan(SELL), T + 3);
        insertApproval(tx, issue(h, CLOSE), canonicalPlan(CLOSE), T + 3);
      });
      assert.equal(count(db, 'approvals'), 2n);
    });
  });

  it('stores the token\'s fields, the hash storage computed and the plan\'s quote slot; the MAC is stored nowhere', () => {
    withDb((db, h) => {
      boughtUpToDecision(db);
      const token = issue(h, BUY);
      db.transaction((tx) => insertApproval(tx, token, canonicalPlan(BUY), T + 5));
      const r = approvalRow(db, token.id);
      assert.deepEqual(
        [r?.['intent_id'], r?.['position_id'], r?.['mode'], r?.['kind'], r?.['reduce_only'], r?.['plan_hash'], r?.['max_spend'], r?.['min_out'], r?.['quote_slot'], r?.['expires_at_slot'], r?.['issued_at'], r?.['consumed_at'], r?.['consumed_slot']],
        ['intent-1', 'p1', 'paper', 'buy', 0n, planHash(BUY), planMaxSpend(BUY).toString(), '980000000', 1_000n, 1_025n, BigInt(T + 5), null, null],
      );
      assert.ok(!dump(db).includes(token.mac), 'the MAC is in no cell');
    });
  });

  it('a sell and a close of a position that holds tokens get their reduce-only approvals', () => {
    withDb((db, h) => {
      boughtUpToDecision(db);
      holdTokens(db, 'p1');
      db.transaction((tx) => {
        insertExitIntent(tx, EXIT);
        insertDecision(tx, { outcome: 'exit-approved', intentId: 'exit-p1-0', at: T + 2, configVersion: 1, slot: 1_005n });
        insertApproval(tx, issue(h, SELL), canonicalPlan(SELL), T + 2);
        insertExitIntent(tx, { ...EXIT, id: 'exit-p1-1', exitSeq: 1 });
        insertDecision(tx, { outcome: 'exit-approved', intentId: 'exit-p1-1', at: T + 3, configVersion: 1, slot: 1_005n });
        insertApproval(tx, issue(h, CLOSE), canonicalPlan(CLOSE), T + 3);
      });
      assert.deepEqual(db.all('SELECT kind, reduce_only FROM approvals ORDER BY token_id').map((r) => [r['kind'], r['reduce_only']]), [['sell', 1n], ['close-account', 1n]]);
    });
  });

  it('refuses, with nothing written, a plan text that is not the token\'s plan, and every token field that disagrees with the text', () => {
    withDb((db, h) => {
      boughtUpToDecision(db);
      const token = issue(h, BUY);
      const text = canonicalPlan(BUY);
      const other = canonicalPlan({ ...BUY, minOut: BUY.minOut - 1n });
      refusedInside(db, (tx) => insertApproval(tx, token, other, T), 'bad-param', /not the plan the token was issued for/);
      // a text that differs only in a field storage does not bind: only the hash tells
      refusedInside(db, (tx) => insertApproval(tx, token, canonicalPlan({ ...BUY, venue: 'raydium-cpmm' }), T), 'bad-param', /not the plan the token was issued for/);
      refusedInside(db, (tx) => insertApproval(tx, token, `${text} `, T), 'bad-param');
      const tampered: readonly Partial<Record<keyof ApprovalToken, unknown>>[] = [
        { intentId: 'intent-2' },
        { positionId: 'p2' },
        { mode: 'live' },
        { kind: 'sell' },
        { kind: 'withdraw' },
        { reduceOnly: true },
        { minOut: token.minOut + 1n },
        { maxSpendLamports: token.maxSpendLamports + 1n }, // a buy's spend is its position's held-back spend
        { expiresAtSlot: 999n },
        { expiresAtSlot: 1_026n },
        { planHash: planHash({ ...BUY, minOut: 1n }) },
        { id: 'bad id' },
      ];
      for (const patch of tampered) {
        refusedInside(db, (tx) => insertApproval(tx, { ...token, ...patch } as ApprovalToken, text, T), 'bad-param');
      }
      refusedInside(db, (tx) => insertApproval(tx, token, text, Number.NaN), 'bad-param');
      assert.equal(count(db, 'approvals'), 0n);
    });
  });

  it('needs an approved decision for its own intent, and a position that can take the order', () => {
    withDb((db, h) => {
      db.transaction((tx) => {
        insertEntryIntent(tx, ENTRY);
        insertOpening(tx, openingOf(BUY), lamports(0n));
      });
      const token = issue(h, BUY);
      refusedInside(db, (tx) => insertApproval(tx, token, canonicalPlan(BUY), T), 'row-missing', /decision/);
      db.transaction((tx) => insertDecision(tx, { outcome: 'refused', intentId: 'intent-1', at: T, configVersion: 1, stage: 'sizing', reasons: ['sizing:below-minimum'], slot: 1n }));
      refusedInside(db, (tx) => insertApproval(tx, token, canonicalPlan(BUY), T), 'bad-param', /approved/);
    });
    withDb((db, h) => {
      boughtUpToDecision(db);
      holdTokens(db, 'p1'); // the buy settled: the position no longer takes a buy
      refusedInside(db, (tx) => insertApproval(tx, issue(h, BUY), canonicalPlan(BUY), T), 'bad-param', /opening/);
    });
    withDb((db, h) => {
      boughtUpToDecision(db);
      holdTokens(db, 'p1');
      db.transaction((tx) => {
        insertExitIntent(tx, EXIT);
        insertDecision(tx, { outcome: 'exit-approved', intentId: 'exit-p1-0', at: T + 2, configVersion: 1, slot: 1_005n });
      });
      // what T3 will do while an exit is under way, written by hand: an exiting position still takes an exit's token
      db.transaction((tx) => tx.run("UPDATE positions SET status = 'exiting', updated_at = ? WHERE id = 'p1'", BigInt(T + 3)));
      db.transaction((tx) => insertApproval(tx, issue(h, SELL), canonicalPlan(SELL), T + 3));
      assert.equal(count(db, 'approvals'), 1n);
    });
    withDb((db, h) => {
      // a paper token for a position the book holds in live mode
      db.transaction((tx) => {
        insertEntryIntent(tx, ENTRY);
        insertOpening(tx, { ...openingOf(BUY), mode: 'live' }, lamports(0n));
        insertDecision(tx, approvedEntry());
      });
      refusedInside(db, (tx) => insertApproval(tx, issue(h, BUY), canonicalPlan(BUY), T), 'bad-param', /mode/);
    });
  });
});

describe('the approval readers of step 6d-2: exit tokens still usable, and when a buy token expires', () => {
  /** An open position with one exit intent and its approved decision, ready for an exit token. */
  function withExitDecided(db: Db, seq = 0): void {
    db.transaction((tx) => {
      insertExitIntent(tx, { ...EXIT, id: `exit-p1-${seq}`, exitSeq: seq });
      insertDecision(tx, { outcome: 'exit-approved', intentId: `exit-p1-${seq}`, at: T + 2 + seq, configVersion: 1, slot: 1_005n });
    });
  }
  /** What T2 does to a token, written by hand. */
  const useToken = (db: Db, tokenId: string, slot: bigint): void => {
    db.transaction((tx) => tx.run('UPDATE approvals SET consumed_at = ?, consumed_slot = ? WHERE token_id = ?', BigInt(T + 9), slot, tokenId));
  };

  it('counts an unused exit token until its expiry slot, inclusive, and not after it is used (review S, risk 3b)', () => {
    withDb((db, h) => {
      boughtUpToDecision(db);
      const buy = issue(h, BUY);
      db.transaction((tx) => insertApproval(tx, buy, canonicalPlan(BUY), T + 1));
      holdTokens(db, 'p1');
      assert.equal(outstandingExitApprovals(db, 'p1', 1_000n), 0, 'a buy token is no exit');
      withExitDecided(db);
      const sell = issue(h, SELL);
      db.transaction((tx) => insertApproval(tx, sell, canonicalPlan(SELL), T + 3));
      assert.equal(sell.expiresAtSlot, 1_025n);
      assert.equal(outstandingExitApprovals(db, 'p1', 1_000n), 1);
      assert.equal(outstandingExitApprovals(db, 'p1', 1_025n), 1, 'usable at its expiry slot');
      assert.equal(outstandingExitApprovals(db, 'p1', 1_026n), 0, 'expired');
      assert.equal(outstandingExitApprovals(db, 'p2', 1_000n), 0, 'another position');
      useToken(db, sell.id, 1_010n);
      assert.equal(outstandingExitApprovals(db, 'p1', 1_000n), 0, 'used: exitsInFlight counts its order instead');
      withExitDecided(db, 1);
      db.transaction((tx) => insertApproval(tx, issue(h, CLOSE), canonicalPlan(CLOSE), T + 4));
      assert.equal(outstandingExitApprovals(db, 'p1', 1_000n), 1, 'a close token counts too');
    });
  });

  it("a buy token's expiry slot, or null before the position has one", () => {
    withDb((db, h) => {
      assert.equal(buyTokenExpiry(db, 'p1'), null);
      boughtUpToDecision(db);
      assert.equal(buyTokenExpiry(db, 'p1'), null, 'a decision without its token');
      const buy = issue(h, BUY);
      db.transaction((tx) => insertApproval(tx, buy, canonicalPlan(BUY), T + 1));
      assert.equal(buyTokenExpiry(db, 'p1'), 1_025n);
      useToken(db, buy.id, 1_001n);
      assert.equal(buyTokenExpiry(db, 'p1'), 1_025n, 'used or not, the slot it expires at');
      holdTokens(db, 'p1');
      withExitDecided(db);
      db.transaction((tx) => insertApproval(tx, issue(h, SELL), canonicalPlan(SELL), T + 3));
      assert.equal(buyTokenExpiry(db, 'p1'), 1_025n, 'an exit token is not the buy token');
    });
  });

  it('two buy tokens for one position (a database no writer here can make) are refused, never read as one (review U, security 5)', () => {
    const broken = { get: () => undefined, all: () => [{ expires_at_slot: 1_025n }, { expires_at_slot: 2_000n }] } as unknown as Db;
    storageError(() => buyTokenExpiry(broken, 'p1'), 'row-count');
  });

  it('refuses a bad id or slot before reading', () => {
    withDb((db) => {
      storageError(() => outstandingExitApprovals(db, 'bad id', 1n), 'bad-param');
      storageError(() => outstandingExitApprovals(db, 'p1', -1n), 'bad-param');
      storageError(() => outstandingExitApprovals(db, 'p1', 2n ** 63n), 'bad-param');
      storageError(() => buyTokenExpiry(db, 'bad id'), 'bad-param');
    });
  });
});
