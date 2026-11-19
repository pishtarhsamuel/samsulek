// Storage's plan record against risk/plan.ts itself (STORAGE_DESIGN.md s.15.3): for every valid
// plan, storage reads back exactly risk's canonical text, computes exactly planHash, and binds the
// plan's own fields. So the hash comparison with the token at T1 and T2 can never fail between two
// honest encoders, and an order row always holds the plan risk approved. Ids and addresses come from
// an alphabet without vowels, so no random one spells a credential word (those are refused on
// purpose, s.15.3); lengths run up to 63 characters, the longest the secret filter lets through.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { U64_MAX, bps, lamports, microLamportsPerCu } from '../../../src/core/units.ts';
import { PLAN_MODES, PLAN_URGENCIES, ROUTES, TIP_PATHS, VENUES, canonicalPlan, planHash, type OrderPlan } from '../../../src/risk/plan.ts';
import { planRecordOf } from '../../../src/storage/plan-text.ts';

const ALPHABET = 'BCDFGHJKLMNPQRSTVWXYZbcdfghjkmnpqrstvwxyz123456789_-'.split('');
const idArb = (max: number) => fc.array(fc.constantFrom(...ALPHABET), { minLength: 1, maxLength: max }).map((cs) => cs.join(''));
const u64Arb = fc.oneof(fc.constantFrom(0n, 1n, U64_MAX - 1n, U64_MAX), fc.bigInt({ min: 0n, max: U64_MAX }));
const bpsArb = fc.oneof(fc.constantFrom(0, 10_000), fc.integer({ min: 0, max: 10_000 }));

const planArb: fc.Arbitrary<OrderPlan> = fc
  .record({
    orderId: idArb(63),
    intentId: idArb(63),
    positionId: idArb(63),
    mode: fc.constantFrom(...PLAN_MODES),
    kind: fc.constantFrom('buy' as const, 'sell' as const, 'close-account' as const),
    urgency: fc.constantFrom(...PLAN_URGENCIES),
    venue: fc.constantFrom(...VENUES),
    route: fc.constantFrom(...ROUTES),
    mint: idArb(44),
    pool: idArb(44),
    tokenAccount: idArb(44),
    wallet: idArb(44),
    inAmount: u64Arb,
    expectedOut: u64Arb,
    minOut: u64Arb,
    slippageBps: bpsArb,
    feeBps: bpsArb,
    feeConfigSlot: u64Arb,
    cuLimit: fc.oneof(fc.constantFrom(1, 4_294_967_295), fc.integer({ min: 1, max: 4_294_967_295 })),
    cuPrice: u64Arb,
    tipPath: fc.constantFrom(...TIP_PATHS),
    tipLamports: u64Arb,
    rentLamports: u64Arb,
    attempts: fc.oneof(fc.constantFrom(1, Number.MAX_SAFE_INTEGER), fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER })),
    closeAccountAfter: fc.boolean(),
    // the quote slot is a slot: at most 2^63 - 1, the largest SQLite integer
    quoteSlot: fc.oneof(fc.constantFrom(0n, 2n ** 63n - 1n), fc.bigInt({ min: 0n, max: 2n ** 63n - 1n })),
    lastValidBlockHeight: fc.option(u64Arb, { nil: null }),
  })
  .map(({ tipPath, tipLamports, slippageBps, feeBps, cuPrice, rentLamports, ...rest }) => ({
    ...rest,
    slippageBps: bps(slippageBps),
    feeBps: bps(feeBps),
    cuPrice: microLamportsPerCu(cuPrice),
    rentLamports: lamports(rentLamports),
    tip: { path: tipPath, lamports: lamports(tipLamports) },
  }));

describe('the plan record matches risk/plan.ts on every valid plan', () => {
  it('reads back exactly canonicalPlan, computes exactly planHash, and binds the plan\'s own fields', () => {
    fc.assert(
      fc.property(planArb, (plan) => {
        const text = canonicalPlan(plan);
        const rec = planRecordOf(text);
        assert.equal(rec.text, text);
        assert.equal(rec.hash, planHash(plan));
        assert.deepEqual(
          [rec.orderId, rec.intentId, rec.positionId, rec.mode, rec.kind, rec.mint, rec.inAmount, rec.minOut, rec.quoteSlot],
          [plan.orderId, plan.intentId, plan.positionId, plan.mode, plan.kind, plan.mint, plan.inAmount, plan.minOut, plan.quoteSlot],
        );
      }),
      { numRuns: 1_000 },
    );
  });
});
