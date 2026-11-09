// Property tests for entry sizing (TEST_PLAN.md s.4, invariants 3, 16 and 18), checked against
// limits recomputed here from the inputs, not against the caps the function reports:
// - an accepted size is at or above the minimum and never above any single cap;
// - the new position at its worst-case spend fits the exposure caps, and the wallet keeps the fee
//   reserve after the buy (invariant 3);
// - more equity or more pool liquidity never lowers a cap or the size (invariant 16);
// - caps round down (invariant 18).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { STRATEGY_IDS } from '../../../src/core/ids.ts';
import { bps, lamports } from '../../../src/core/units.ts';
import { sizeEntry, type SizingCaps, type SizingInput } from '../../../src/risk/sizing.ts';

fc.configureGlobal({ numRuns: 1_000 }); // TEST_PLAN.md s.4 (this file's process only)

const SOL = 1_000_000_000n;
const amount = (max: bigint) => fc.bigInt({ min: 0n, max }).map(lamports);

const between = (min: bigint, max: bigint) => fc.bigInt({ min, max }).map(lamports);

// Wide ranges reach every edge; realistic ones (a 0.1-2 SOL account) make accepted sizes common, so
// the properties are never vacuous (an acceptance count is asserted below).
const wideCaps: fc.Arbitrary<SizingCaps> = fc.record({
  perTradeBps: fc.integer({ min: 100, max: 1_000 }).map(bps),
  maxPositionLamports: amount(60_000_000n),
  exposureBps: fc.integer({ min: 1_000, max: 5_000 }).map(bps),
  maxExposureLamports: amount(300_000_000n),
  launchShareBps: fc.constant(bps(2_500)),
  poolShareBps: fc.integer({ min: 10, max: 50 }).map(bps),
  minTradeLamports: amount(30_000_000n),
  minTradeFloorLamports: between(10_000_000n, 15_000_000n),
});
const realisticCaps: fc.Arbitrary<SizingCaps> = fc.record({
  perTradeBps: fc.integer({ min: 500, max: 1_000 }).map(bps),
  maxPositionLamports: between(40_000_000n, 60_000_000n),
  exposureBps: fc.integer({ min: 3_000, max: 5_000 }).map(bps),
  maxExposureLamports: between(200_000_000n, 300_000_000n),
  launchShareBps: fc.constant(bps(2_500)),
  poolShareBps: fc.integer({ min: 30, max: 50 }).map(bps),
  minTradeLamports: between(10_000_000n, 20_000_000n),
  minTradeFloorLamports: fc.constant(lamports(10_000_000n)),
});
const capsArb = fc.oneof(wideCaps, realisticCaps);

const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

const wideInput: fc.Arbitrary<SizingInput> = fc.record({
  strategy: fc.constantFrom(...STRATEGY_IDS),
  sizeHint: fc.constantFrom('min' as const, 'normal' as const),
  sizingEquity: amount(3n * SOL),
  exposure: amount(SOL),
  launchExposure: amount(300_000_000n),
  poolRealSolReserve: amount(1_000n * SOL),
  sol: amount(3n * SOL),
  reserveAfterBuy: between(10_000_000n, 20_000_000n),
  rent: amount(2_100_000n),
  buyAttemptFees: amount(1_000_000n),
  minTrade: amount(50_000_000n),
  liveRampHalf: fc.boolean(),
});
const realisticInput: fc.Arbitrary<SizingInput> = fc.record({
  strategy: fc.constantFrom(...STRATEGY_IDS),
  sizeHint: fc.constantFrom('min' as const, 'normal' as const),
  sizingEquity: between(400_000_000n, 2n * SOL),
  exposure: amount(100_000_000n),
  launchExposure: amount(20_000_000n),
  poolRealSolReserve: between(10n * SOL, 1_000n * SOL),
  sol: between(300_000_000n, 2n * SOL),
  reserveAfterBuy: between(10_000_000n, 16_000_000n),
  rent: amount(2_100_000n),
  buyAttemptFees: amount(400_000n),
  minTrade: amount(25_000_000n),
  liveRampHalf: fc.boolean(),
});
const inputArb = fc.oneof(wideInput, realisticInput);

const floorBps = (value: bigint, rate: number): bigint => (value * BigInt(rate)) / 10_000n;

describe('sizing properties', () => {
  it('an accepted size meets the minimum, every cap and the fee reserve (and sizes are accepted)', () => {
    let accepted = 0;
    fc.assert(
      fc.property(inputArb, capsArb, (input, caps) => {
        const r = sizeEntry(input, caps);
        accepted += r.ok ? 1 : 0;
        const accountMinimum = max(caps.minTradeLamports, caps.minTradeFloorLamports);
        const perTradeCap = floorBps(input.sizingEquity, caps.perTradeBps);
        // All entries stop only when 10% of equity misses the account minimum, never for one pool.
        assert.equal(!r.ok && r.reason === 'equity-below-minimum', perTradeCap < accountMinimum);
        if (!r.ok) {
          return;
        }
        const overhead = input.rent + input.buyAttemptFees;
        const exposureCap = floorBps(input.sizingEquity, caps.exposureBps);
        const minimum = max(input.minTrade, accountMinimum);
        assert.ok(r.size >= minimum && r.size > 0n, 'at least the minimum trade, never 0');
        assert.ok(r.size <= floorBps(input.sizingEquity, caps.perTradeBps), 'limit 1: per trade');
        assert.ok(r.size <= caps.maxPositionLamports, 'limit 2: per position');
        assert.ok(input.exposure + r.size + overhead <= exposureCap, 'limit 4: exposure at maxSpend');
        assert.ok(input.exposure + r.size + overhead <= caps.maxExposureLamports, 'limit 5: absolute exposure');
        assert.ok(r.size <= floorBps(2n * input.poolRealSolReserve, caps.poolShareBps), 'limit 7: pool share');
        if (input.strategy === 'launch') {
          const effective = exposureCap < caps.maxExposureLamports ? exposureCap : caps.maxExposureLamports;
          assert.ok(input.launchExposure + r.size + overhead <= floorBps(effective, caps.launchShareBps), 'limit 8: launch');
        }
        assert.ok(input.sol - (r.size + overhead) >= input.reserveAfterBuy, 'invariant 3: the reserve survives the buy');
      }),
    );
    assert.ok(accepted >= 100, `only ${accepted} of 1,000 inputs were accepted: the property would be vacuous`);
  });

  it('more equity or more liquidity never lowers a cap or the size', () => {
    const more = fc.bigInt({ min: 0n, max: SOL });
    fc.assert(
      fc.property(inputArb, capsArb, more, fc.boolean(), (input, caps, extra, onEquity) => {
        const bigger: SizingInput = onEquity
          ? { ...input, sizingEquity: lamports(input.sizingEquity + extra) }
          : { ...input, poolRealSolReserve: lamports(input.poolRealSolReserve + extra) };
        const before = sizeEntry(input, caps);
        const after = sizeEntry(bigger, caps);
        for (const [name, value] of Object.entries(before.caps)) {
          const later = after.caps[name as keyof typeof after.caps];
          assert.ok(later !== undefined && later >= value, `cap ${name} never falls`);
        }
        if (before.ok) {
          assert.ok(after.ok, 'still accepted');
          assert.ok(after.size >= before.size, 'the size never falls');
        }
      }),
    );
  });

  it('the per-trade cap is 10% of equity rounded down, exactly', () => {
    fc.assert(
      fc.property(inputArb, capsArb, (input, caps) => {
        const cap = sizeEntry(input, caps).caps['per-trade'] ?? -1n;
        const exact = input.sizingEquity * BigInt(caps.perTradeBps);
        assert.ok(cap * 10_000n <= exact && exact < (cap + 1n) * 10_000n);
      }),
    );
  });
});
