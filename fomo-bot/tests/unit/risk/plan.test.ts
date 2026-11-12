// The order plan and its fingerprint (ARCHITECTURE.md s.3; RISK_POLICY.md invariant 1). The risk
// engine approves one exact plan: planHash is sha256 over a canonical text of EVERY field (keys
// sorted, bigints as decimal strings), so changing anything, mode and kind included, changes the
// hash, and a plan with a missing, extra or malformed field has no hash at all (fail closed).
// TEST_PLAN.md s.3 step 4 and s.5 (execution: "canonical planHash covers every field").
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bps, lamports, microLamportsPerCu } from '../../../src/core/units.ts';
import { RiskError } from '../../../src/risk/reserve.ts';
import {
  BASE_FEE_PER_SIGNATURE,
  PLAN_FIELDS,
  canonicalJson,
  canonicalPlan,
  planHash,
  planMaxSpend,
  validatePlan,
  type OrderPlan,
} from '../../../src/risk/plan.ts';

const PLAN: OrderPlan = {
  orderId: 'order-1',
  intentId: 'intent-1',
  positionId: 'p1',
  mode: 'paper',
  kind: 'buy',
  urgency: 'normal',
  venue: 'pumpswap',
  route: 'direct',
  mint: 'MintA',
  pool: 'PoolA',
  tokenAccount: 'AtaOfMintA',
  wallet: 'OurWallet',
  inAmount: 55_000_000n,
  expectedOut: 1_000_000_000n,
  minOut: 980_000_000n,
  slippageBps: bps(200),
  feeBps: bps(125),
  feeConfigSlot: 990n,
  cuLimit: 300_000,
  cuPrice: microLamportsPerCu(200_000n),
  tip: { path: 'jito', lamports: lamports(1_000n) },
  rentLamports: lamports(1_488_440n),
  attempts: 3,
  closeAccountAfter: false,
  quoteSlot: 1_000n,
  lastValidBlockHeight: null,
};

describe('canonical plan text', () => {
  it('is JSON with sorted keys, bigints as decimal strings and nothing else', () => {
    const text = canonicalPlan(PLAN);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), [...Object.keys(parsed)].sort());
    assert.deepEqual(Object.keys(parsed).sort(), [...PLAN_FIELDS].sort());
    assert.equal(parsed['inAmount'], '55000000');
    assert.equal(parsed['quoteSlot'], '1000');
    assert.equal(parsed['lastValidBlockHeight'], null);
    assert.deepEqual(parsed['tip'], { lamports: '1000', path: 'jito' });
    assert.equal(parsed['cuLimit'], 300_000);
    assert.equal(parsed['closeAccountAfter'], false);
  });

  it('does not depend on the order the fields were written in', () => {
    const reversed = Object.fromEntries(Object.entries(PLAN).reverse()) as unknown as OrderPlan;
    assert.equal(canonicalPlan(reversed), canonicalPlan(PLAN));
    assert.equal(planHash(reversed), planHash(PLAN));
  });
});

describe('the plan hash', () => {
  it('is a stable sha256 in lowercase hex', () => {
    assert.match(planHash(PLAN), /^[0-9a-f]{64}$/);
    assert.equal(planHash(PLAN), planHash({ ...PLAN }));
  });

  it('changes when ANY field changes, mode and kind included', () => {
    const changed: { [K in keyof OrderPlan]: OrderPlan[K] } = {
      orderId: 'order-2',
      intentId: 'intent-2',
      positionId: 'p2',
      mode: 'live',
      kind: 'sell',
      urgency: 'emergency',
      venue: 'pump-curve',
      route: 'jupiter-build',
      mint: 'MintB',
      pool: 'PoolB',
      tokenAccount: 'AtaOther',
      wallet: 'Attacker',
      inAmount: 55_000_001n,
      expectedOut: 1_000_000_001n,
      minOut: 0n,
      slippageBps: bps(201),
      feeBps: bps(126),
      feeConfigSlot: 991n,
      cuLimit: 300_001,
      cuPrice: microLamportsPerCu(200_001n),
      tip: { path: 'helius-swqos', lamports: lamports(1_000n) },
      rentLamports: lamports(1_488_441n),
      attempts: 4,
      closeAccountAfter: true,
      quoteSlot: 1_001n,
      lastValidBlockHeight: 5n,
    };
    const base = planHash(PLAN);
    const seen = new Set([base]);
    for (const field of PLAN_FIELDS) {
      const hash = planHash({ ...PLAN, [field]: changed[field] });
      assert.notEqual(hash, base, `changing ${field} must change the hash`);
      seen.add(hash);
    }
    assert.equal(seen.size, PLAN_FIELDS.length + 1, 'every change gives a different hash');
    assert.notEqual(planHash({ ...PLAN, tip: { path: 'jito', lamports: lamports(1_001n) } }), base, 'the tip amount too');
  });

  it('PLAN_FIELDS lists every field of the plan type (a new field cannot be left out of the hash)', () => {
    assert.deepEqual([...PLAN_FIELDS].sort(), Object.keys(PLAN).sort());
  });
});

describe('the validated snapshot', () => {
  it('is a frozen plain copy with every field, hashing exactly like the original', () => {
    const snapshot = validatePlan(PLAN);
    assert.notEqual(snapshot, PLAN);
    assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.tip));
    assert.deepEqual({ ...snapshot }, { ...PLAN });
    assert.equal(planHash(snapshot), planHash(PLAN));
  });

  it('cannot be changed through the original afterwards', () => {
    const mutable = { ...PLAN };
    const snapshot = validatePlan(mutable);
    (mutable as { wallet: string }).wallet = 'Attacker';
    assert.equal(snapshot.wallet, 'OurWallet');
  });
});

describe('worst-case spend (what an approval token carries)', () => {
  // One attempt: 5,000 base + ceil(200,000 x 300,000 / 10^6) = 60,000 priority + 1,000 tip = 66,000.
  it('a buy: input + rent + every allowed attempt, the tip counted on each', () => {
    assert.equal(BASE_FEE_PER_SIGNATURE, 5_000n);
    assert.equal(planMaxSpend(PLAN), 55_000_000n + 1_488_440n + 3n * 66_000n);
  });

  it('a sell or a close spends tokens, not SOL: only its fees count', () => {
    const sell: OrderPlan = { ...PLAN, kind: 'sell', inAmount: 400_000n, rentLamports: lamports(0n) };
    assert.equal(planMaxSpend(sell), 3n * 66_000n);
    const close: OrderPlan = { ...sell, kind: 'close-account', inAmount: 0n, attempts: 1 };
    assert.equal(planMaxSpend(close), 66_000n);
  });

  it('is exact at the extremes and refuses a malformed plan', () => {
    const cheap: OrderPlan = { ...PLAN, cuLimit: 1, cuPrice: microLamportsPerCu(1n), tip: { path: 'none', lamports: lamports(0n) }, attempts: 1, rentLamports: lamports(0n), inAmount: 0n };
    assert.equal(planMaxSpend(cheap), 5_001n); // 1 x 1 / 10^6 rounds up to 1 lamport
    assert.throws(() => planMaxSpend({ ...PLAN, attempts: 0 }), RiskError);
    assert.throws(() => planMaxSpend({ ...PLAN, inAmount: 2n ** 64n - 1n }), /./); // overflow is refused, never wrapped
  });
});

describe('fail closed: a malformed plan has no hash', () => {
  const broken = (change: Record<string, unknown>): OrderPlan => ({ ...PLAN, ...change }) as unknown as OrderPlan;

  it('refuses a missing or an extra field', () => {
    const { pool: _pool, ...missing } = PLAN;
    assert.throws(() => planHash(missing as unknown as OrderPlan), /pool/);
    assert.throws(() => planHash(broken({ memo: 'x' })), /memo/);
    assert.throws(() => planHash(broken({ tip: { path: 'jito', lamports: lamports(1n), to: 'x' } })), /tip/);
  });

  it('refuses a field that hides: symbol-keyed, non-enumerable or only inherited', () => {
    const symbolic = { ...PLAN, [Symbol('memo')]: 'x' } as unknown as OrderPlan;
    assert.throws(() => planHash(symbolic), /symbol keys/);
    const hidden = Object.defineProperty({ ...PLAN }, 'memo', { value: 'x', enumerable: false });
    assert.throws(() => planHash(hidden as unknown as OrderPlan), /memo/);
    const inherited = Object.create(PLAN) as OrderPlan; // every field comes from the prototype
    assert.throws(() => planHash(inherited), /missing the field/);
  });

  it('echoes an unknown field name only safely (escaped and cut short)', () => {
    const hostile = broken({ ['x\ny'.repeat(20)]: 1 });
    assert.throws(
      () => planHash(hostile),
      (e: unknown) => e instanceof RiskError && !e.message.includes('\n') && e.message.length < 200,
    );
  });

  it('refuses wrong types and values outside their domain', () => {
    const cases: ReadonlyArray<Record<string, unknown>> = [
      { inAmount: 55_000_000 }, // a number where a bigint belongs
      { inAmount: -1n },
      { minOut: 2n ** 64n },
      { quoteSlot: 1.5 },
      { cuLimit: 1.5 },
      { cuLimit: 0 },
      { attempts: 0 },
      { slippageBps: 10_001 },
      { mode: 'off' },
      { kind: 'swap' },
      { urgency: 'panic' },
      { venue: 'orca' },
      { route: 'jupiter' },
      { tip: { path: 'tipjar', lamports: lamports(1n) } },
      { tip: null },
      { closeAccountAfter: 'no' },
      { orderId: 'has space' },
      { mint: '' },
      { lastValidBlockHeight: undefined },
      { lastValidBlockHeight: -1n },
    ];
    for (const change of cases) {
      assert.throws(() => planHash(broken(change)), RiskError, JSON.stringify(change, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v)));
    }
    assert.throws(() => planHash(null as unknown as OrderPlan), RiskError);
  });

  it('reads the plan once: a field cannot differ between the check and the hash', () => {
    let reads = 0;
    const shifty = {
      ...PLAN,
      get wallet(): string {
        reads += 1;
        return reads === 1 ? 'OurWallet' : 'Attacker';
      },
    };
    assert.equal(planHash(shifty), planHash(PLAN));
    assert.equal(reads, 1);
  });
});

describe('canonicalJson: one value, one text (REVIEWS.md K, security finding 8)', () => {
  it('sorts keys at every depth and writes bigints as decimal text, whatever order the keys came in', () => {
    assert.equal(canonicalJson({ b: 1n, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":"1"}');
    assert.equal(canonicalJson({ a: { d: 2, c: 3 }, b: 1n }), canonicalJson({ b: 1n, a: { c: 3, d: 2 } }));
    assert.equal(canonicalJson({ z: null, y: true, x: 'text', w: 0 }), '{"w":0,"x":"text","y":true,"z":null}');
  });

  it('a key named __proto__ is a key like any other, never dropped', () => {
    const tricky = JSON.parse('{"a":1,"__proto__":{"b":2}}') as unknown;
    assert.equal(canonicalJson(tricky), '{"__proto__":{"b":2},"a":1}');
    assert.notEqual(canonicalJson(tricky), canonicalJson({ a: 1 }));
  });

  it('refuses what JSON would silently change or drop: lists, undefined, functions, symbols, NaN, class instances', () => {
    const refused: readonly unknown[] = [[1, 2], { a: undefined }, { a: () => 1 }, { a: Symbol('x') }, { a: Number.NaN }, { a: Infinity }, new Map(), new Date(0), Object.create({ inherited: 1 }), { [Symbol('k')]: 1 }, undefined, () => 1];
    for (const value of refused) {
      assert.throws(() => canonicalJson(value), RiskError, String(typeof value));
    }
    // two shapes that used to read the same ([1,2] and {0:1,1:2}) are now different: one is refused
    assert.equal(canonicalJson({ 0: 1, 1: 2 }), '{"0":1,"1":2}');
    assert.throws(() => canonicalJson([1, 2]), RiskError);
  });
});
