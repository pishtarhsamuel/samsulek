// Model-based property tests for the portfolio ledger (TEST_PLAN.md s.4, invariants 5, 6 and 10).
// Random sequences of opens, buys, sells, closes, abandons, deposits and withdrawals, failed orders
// and wrong refunds mixed in, run side by side with a small independent model of SOL, tokens, rent
// and status. The model also predicts which operations must be refused, so the ledger can neither
// accept an impossible operation nor refuse a valid one. fast-check prints the seed and the shrunk
// counterexample on failure.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { STRATEGY_IDS } from '../../../src/core/ids.ts';
import { lamports, signedLamports, tokenUnits } from '../../../src/core/units.ts';
import {
  LedgerError,
  abandonOpening,
  applyBuy,
  applyClose,
  applySell,
  cashFlow,
  checkConservation,
  deposit,
  emptyLedger,
  openPosition,
  withdraw,
  type Ledger,
  type LedgerMode,
  type Position,
  type PositionStatus,
} from '../../../src/portfolio/ledger.ts';

const MINTS = ['MintA', 'MintB', 'MintC'] as const;
const RENTS = [0n, 1_513_840n, 2_039_280n] as const;
const NUM_RUNS = 1_000; // TEST_PLAN.md s.4: 1,000 cases per property

type Op =
  | { readonly kind: 'open'; readonly mint: number; readonly strategy: number }
  | {
      readonly kind: 'buy';
      readonly pick: number;
      readonly landed: boolean;
      readonly quoteIn: bigint;
      readonly feeBps: number;
      readonly tokensOut: bigint;
      readonly networkFee: bigint;
      readonly tip: bigint;
      readonly rent: number;
    }
  | {
      readonly kind: 'sell';
      readonly pick: number;
      readonly landed: boolean;
      readonly fractionBps: number;
      readonly quoteOut: bigint;
      readonly venueFee: bigint;
      readonly networkFee: bigint;
      readonly tip: bigint;
      readonly close: boolean;
      readonly badRefund: boolean;
    }
  | { readonly kind: 'close'; readonly pick: number; readonly landed: boolean; readonly networkFee: bigint; readonly badRefund: boolean }
  | { readonly kind: 'abandon'; readonly pick: number }
  | { readonly kind: 'deposit'; readonly amount: bigint }
  | { readonly kind: 'withdraw'; readonly amount: bigint };

const landedArb = fc.integer({ min: 0, max: 19 }).map((n) => n > 2); // about 85% land
const rarely = fc.integer({ min: 0, max: 9 }).map((n) => n === 0); // about 10%
const fee = fc.bigInt({ min: 0n, max: 200_000n });
const tip = fc.bigInt({ min: 0n, max: 10_000n });

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('open' as const), mint: fc.nat({ max: 2 }), strategy: fc.nat({ max: 2 }) }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('buy' as const),
      pick: fc.nat(),
      landed: landedArb,
      quoteIn: fc.bigInt({ min: 0n, max: 300_000_000n }),
      feeBps: fc.integer({ min: 0, max: 500 }),
      tokensOut: fc.bigInt({ min: 0n, max: 10n ** 15n }),
      networkFee: fee,
      tip,
      rent: fc.nat({ max: 2 }),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('sell' as const),
      pick: fc.nat(),
      landed: landedArb,
      fractionBps: fc.oneof(fc.constant(10_000), fc.integer({ min: 0, max: 10_000 })),
      quoteOut: fc.bigInt({ min: 0n, max: 400_000_000n }),
      venueFee: fc.bigInt({ min: 0n, max: 5_000_000n }),
      networkFee: fee,
      tip,
      close: fc.boolean(),
      badRefund: rarely,
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('close' as const), pick: fc.nat(), landed: landedArb, networkFee: fee, badRefund: rarely }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('abandon' as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('deposit' as const), amount: fc.bigInt({ min: 0n, max: 1_000_000_000n }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('withdraw' as const), amount: fc.bigInt({ min: 0n, max: 1_000_000_000n }) }) },
);

// ---------------------------------------------------------------- the independent model

interface ModelPosition {
  readonly mint: string;
  readonly status: PositionStatus;
  readonly tokens: bigint;
  readonly rent: bigint;
}

interface Model {
  readonly sol: bigint;
  readonly positions: ReadonlyMap<string, ModelPosition>;
}

function withPosition(model: Model, id: string, position: ModelPosition, sol: bigint): Model {
  const positions = new Map(model.positions);
  positions.set(id, position);
  return { sol, positions };
}

/** The ledger call for an operation and the model after it, or null when it must be refused. */
interface Step {
  readonly call: () => Ledger;
  readonly expected: Model | null;
}

function plan(op: Op, ledger: Ledger, model: Model, mode: LedgerMode, seq: number, now: number): Step {
  const ids = [...ledger.positions.keys()];
  const target = 'pick' in op && ids.length > 0 ? (ids[op.pick % ids.length] ?? 'none') : 'none';
  const m = model.positions.get(target);
  const orderId = `o${seq}`;
  switch (op.kind) {
    case 'open': {
      const id = `p${seq}`;
      const mint = MINTS[op.mint] ?? 'MintA';
      const taken = [...model.positions.values()].some((p) => p.mint === mint && p.status !== 'closed');
      return {
        call: () => openPosition(ledger, { id, mint, strategy: STRATEGY_IDS[op.strategy] ?? 'crowdflow', openedAt: now }),
        expected: taken ? null : withPosition(model, id, { mint, status: 'opening', tokens: 0n, rent: 0n }, model.sol),
      };
    }
    case 'buy': {
      const rent = RENTS[op.rent] ?? 0n;
      const call = (): Ledger =>
        applyBuy(ledger, {
          orderId,
          positionId: target,
          landed: op.landed,
          quoteIn: lamports(op.quoteIn),
          venueFee: lamports((op.quoteIn * BigInt(op.feeBps)) / 10_000n),
          tokensOut: tokenUnits(op.tokensOut),
          networkFee: lamports(op.networkFee),
          tip: lamports(op.tip),
          rentPaid: lamports(rent),
          at: now,
        });
      if (m === undefined || m.status !== 'opening') {
        return { call, expected: null };
      }
      if (!op.landed) {
        return { call, expected: op.networkFee <= model.sol ? withPosition(model, target, m, model.sol - op.networkFee) : null };
      }
      const cost = op.quoteIn + op.networkFee + op.tip + rent;
      const ok = op.quoteIn > 0n && op.tokensOut > 0n && cost <= model.sol;
      const next: ModelPosition = { ...m, status: 'open', tokens: op.tokensOut, rent };
      return { call, expected: ok ? withPosition(model, target, next, model.sol - cost) : null };
    }
    case 'sell': {
      const held = m?.tokens ?? 0n;
      const tokensIn = op.fractionBps === 10_000 ? held : (held * BigInt(op.fractionBps)) / 10_000n;
      const refund = (op.close ? (m?.rent ?? 0n) : 0n) + (op.badRefund ? 1n : 0n);
      const call = (): Ledger =>
        applySell(ledger, {
          orderId,
          positionId: target,
          landed: op.landed,
          tokensIn: tokenUnits(tokensIn),
          quoteOut: lamports(op.quoteOut),
          venueFee: lamports(op.venueFee),
          networkFee: lamports(op.networkFee),
          tip: lamports(op.tip),
          closeAccount: op.close,
          rentRefunded: lamports(refund),
          at: now,
        });
      if (m === undefined || m.status !== 'open') {
        return { call, expected: null };
      }
      if (!op.landed) {
        return { call, expected: op.networkFee <= model.sol ? withPosition(model, target, m, model.sol - op.networkFee) : null };
      }
      const left = held - tokensIn;
      const ok = tokensIn > 0n && (!op.close || left === 0n) && !op.badRefund && op.networkFee + op.tip <= model.sol;
      let status: PositionStatus = 'open';
      if (left === 0n) {
        status = op.close ? 'closed' : 'exiting';
      }
      const next: ModelPosition = { ...m, status, tokens: left, rent: op.close ? 0n : m.rent };
      const sol = model.sol + op.quoteOut + refund - op.networkFee - op.tip;
      return { call, expected: ok ? withPosition(model, target, next, sol) : null };
    }
    case 'close': {
      const refund = (m?.rent ?? 0n) + (op.badRefund ? 1n : 0n);
      const call = (): Ledger =>
        applyClose(ledger, {
          orderId,
          positionId: target,
          landed: op.landed,
          networkFee: lamports(op.networkFee),
          rentRefunded: lamports(refund),
          at: now,
        });
      if (m === undefined || m.status !== 'exiting') {
        return { call, expected: null };
      }
      if (!op.landed) {
        return { call, expected: op.networkFee <= model.sol ? withPosition(model, target, m, model.sol - op.networkFee) : null };
      }
      const ok = !op.badRefund && op.networkFee <= model.sol;
      const next: ModelPosition = { ...m, status: 'closed', rent: 0n };
      return { call, expected: ok ? withPosition(model, target, next, model.sol + refund - op.networkFee) : null };
    }
    case 'abandon': {
      const call = (): Ledger => abandonOpening(ledger, target, now);
      const ok = m !== undefined && m.status === 'opening';
      return { call, expected: ok ? withPosition(model, target, { ...m, status: 'closed' }, model.sol) : null };
    }
    case 'deposit': {
      const call = (): Ledger => deposit(ledger, lamports(op.amount), now);
      return { call, expected: op.amount > 0n ? { ...model, sol: model.sol + op.amount } : null };
    }
    case 'withdraw': {
      const call = (): Ledger => withdraw(ledger, lamports(op.amount), now);
      const ok = mode === 'live' && op.amount > 0n && op.amount <= model.sol;
      return { call, expected: ok ? { ...model, sol: model.sol - op.amount } : null };
    }
  }
}

// ---------------------------------------------------------------- checks

function snapshot(ledger: Ledger): string {
  return JSON.stringify(ledger, (_key, value: unknown) => {
    if (typeof value === 'bigint') {
      return `${value}n`;
    }
    if (value instanceof Map || value instanceof Set) {
      return [...value];
    }
    return value;
  });
}

function matchesModel(ledger: Ledger, model: Model): void {
  assert.equal(ledger.sol, model.sol, 'SOL matches the model');
  assert.equal(ledger.positions.size, model.positions.size);
  for (const [id, m] of model.positions) {
    const p = ledger.positions.get(id);
    assert.ok(p !== undefined, `position ${id} exists`);
    assert.equal(p.status, m.status);
    assert.equal(p.tokenUnits, m.tokens);
    assert.equal(p.rentLocked, m.rent);
    assert.ok(p.costBasis >= p.rentLocked, 'the basis always covers the locked rent');
    if (p.status === 'closed') {
      assert.equal(p.costBasis, 0n);
      assert.equal(p.realized, cashFlow(p), 'a closed position realized exactly its cash flow');
      assert.ok(p.realized <= p.sold - p.bought, 'fees never improve the PnL');
    }
  }
  checkConservation(ledger);
}

/** Rent comes back only with a 100% sell plus close; a partial sell releases basis rounded up. */
function checkTransition(before: Ledger, after: Ledger, op: Op): void {
  for (const [id, p] of after.positions) {
    const old = before.positions.get(id);
    if (old !== undefined && p.rentRefunded > old.rentRefunded) {
      assert.equal(p.status, 'closed', 'rent is refunded only by the close');
      assert.equal(p.tokenUnits, 0n);
    }
    const sold = old === undefined ? 0n : old.tokenUnits - p.tokenUnits;
    if (old !== undefined && op.kind === 'sell' && sold > 0n && p.tokenUnits > 0n) {
      const released = old.costBasis - p.costBasis;
      const exact = (old.costBasis - old.rentLocked) * sold; // released x held, exactly
      assert.ok(released * old.tokenUnits >= exact, 'never releases less than the exact share');
      assert.ok((released - 1n) * old.tokenUnits < exact, 'rounded up by less than one lamport');
    }
  }
}

type Tally = Record<Op['kind'], number>;
const emptyTally = (): Tally => ({ open: 0, buy: 0, sell: 0, close: 0, abandon: 0, deposit: 0, withdraw: 0 });

function run(mode: LedgerMode, startSol: bigint, ops: readonly Op[], applied: Tally): void {
  let ledger = deposit(emptyLedger(mode), lamports(startSol), 0);
  let model: Model = { sol: startSol, positions: new Map() };
  let seq = 0;
  for (const op of ops) {
    seq += 1;
    const now = seq * 1_000;
    const before = snapshot(ledger);
    const step = plan(op, ledger, model, mode, seq, now);
    let next: Ledger | null = null;
    try {
      next = step.call();
    } catch (error: unknown) {
      if (!(error instanceof LedgerError)) {
        throw error;
      }
    }
    assert.equal(snapshot(ledger), before, 'an operation never changes the ledger it was given');
    if (step.expected === null) {
      assert.equal(next, null, `${op.kind} must be refused`);
      continue;
    }
    assert.ok(next !== null, `${op.kind} must be accepted`);
    checkTransition(ledger, next, op);
    matchesModel(next, step.expected);
    applied[op.kind] += 1;
    ledger = next;
    model = step.expected;
  }
}

describe('ledger properties', () => {
  it('random operation sequences match the model, keep every identity and refuse exactly the impossible', () => {
    const applied = emptyTally();
    fc.assert(
      fc.property(
        fc.constantFrom<LedgerMode>('paper', 'live'),
        fc.bigInt({ min: 1n, max: 2_000_000_000n }),
        fc.array(opArb, { maxLength: 60, size: 'max' }), // 'max': lengths up to 60, not fast-check's small default
        (mode, startSol, ops) => run(mode, startSol, ops, applied),
      ),
      { numRuns: NUM_RUNS },
    );
    // Every kind of operation really ran, not just its refusals.
    for (const [kind, count] of Object.entries(applied)) {
      assert.ok(count > 0, `${kind} was applied at least once`);
    }
  });

  it('a planted one-lamport error in any checked field is caught', () => {
    const fields = [
      'costBasis', 'rentLocked', 'realized', 'bought', 'sold', 'networkFees', 'failedFees',
      'tips', 'rentPaid', 'rentRefunded', 'tokenUnits', 'tokensBought', 'tokensSold', 'exitFees',
      'basisReleased',
    ] as const;
    fc.assert(
      fc.property(
        fc.bigInt({ min: 100_000_000n, max: 2_000_000_000n }),
        fc.bigInt({ min: 1n, max: 50_000_000n }),
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        fc.constantFrom(...fields),
        fc.constantFrom(1n, -1n),
        (startSol, quoteIn, tokensOut, field, delta) => {
          let l = openPosition(deposit(emptyLedger('paper'), lamports(startSol), 0), {
            id: 'p1',
            mint: 'MintA',
            strategy: 'crowdflow',
            openedAt: 0,
          });
          l = applyBuy(l, {
            orderId: 'o1',
            positionId: 'p1',
            landed: true,
            quoteIn: lamports(quoteIn),
            venueFee: lamports(quoteIn / 100n),
            tokensOut: tokenUnits(tokensOut),
            networkFee: lamports(15_000n),
            tip: lamports(1_000n),
            rentPaid: lamports(2_039_280n),
            at: 1,
          });
          const p = l.positions.get('p1');
          assert.ok(p !== undefined);
          const value = p[field] + delta;
          fc.pre(field === 'realized' || value >= 0n);
          const planted: Position =
            field === 'realized'
              ? { ...p, realized: signedLamports(value) }
              : { ...p, [field]: field.startsWith('token') ? tokenUnits(value) : lamports(value) };
          assert.throws(() => checkConservation({ ...l, positions: new Map([['p1', planted]]) }), LedgerError);
          assert.throws(() => checkConservation({ ...l, sol: lamports(l.sol + delta) }), LedgerError);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
