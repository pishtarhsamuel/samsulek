// Property tests for entry sizing (TEST_PLAN.md s.4, invariants 3, 16 and 18), checked against
// limits recomputed here from the inputs, not against the caps the function reports:
// - an accepted size is at or above the minimum and never above any single cap;
// - the new position at its worst-case spend fits the exposure caps, and the wallet keeps the fee
//   reserve after the buy (invariant 3);
// - more equity or more pool liquidity never lowers a cap or the size (invariant 16);
// - caps round down (invariant 18);
// - the limits are the HARD values whatever the config says, and a live entry's are the LIVE_CAPS
//   and today's EUR caps (REVIEWS.md K, N1): the oracle clamps with its own literal numbers, and a
//   third of the cases configure every cap above its hard value.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { STRATEGY_IDS } from '../../../src/core/ids.ts';
import { bps, lamports } from '../../../src/core/units.ts';
import { sizeEntry, type LiveSolCaps, type SizingCaps, type SizingInput } from '../../../src/risk/sizing.ts';

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
// Every ceiling at or above its hard value, up to 100% and 100 SOL: sizing must act as if it were the hard value.
const looseCaps: fc.Arbitrary<SizingCaps> = fc.record({
  perTradeBps: fc.integer({ min: 1_000, max: 10_000 }).map(bps),
  maxPositionLamports: between(60_000_000n, 10n * SOL),
  exposureBps: fc.integer({ min: 5_000, max: 10_000 }).map(bps),
  maxExposureLamports: between(300_000_000n, 100n * SOL),
  launchShareBps: fc.integer({ min: 2_500, max: 10_000 }).map(bps),
  poolShareBps: fc.integer({ min: 50, max: 10_000 }).map(bps),
  minTradeLamports: between(10_000_000n, 20_000_000n),
  minTradeFloorLamports: fc.constant(lamports(10_000_000n)),
});
const capsArb = fc.oneof(wideCaps, realisticCaps, looseCaps);

const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const min = <T extends bigint | number>(...values: T[]): T => values.reduce((a, b) => (b < a ? b : a));

/** Half the cases are live entries with today's EUR caps (from far below to far above the SOL caps). */
const modeArb: fc.Arbitrary<Pick<SizingInput, 'mode' | 'liveSol'>> = fc.oneof(
  fc.record({ mode: fc.constant('paper' as const), liveSol: fc.constant(null) }),
  fc.record({
    mode: fc.constant('live' as const),
    liveSol: fc.record({ positionLamports: amount(120_000_000n), exposureLamports: amount(500_000_000n) }) as fc.Arbitrary<LiveSolCaps>,
  }),
);

/** The limits in force, from the policy's literal numbers (RISK_POLICY.md s.2 and s.3), not from config/caps.ts. */
function limits(input: SizingInput, caps: SizingCaps) {
  const live = input.mode === 'live' && input.liveSol !== null ? input.liveSol : null;
  return {
    perTrade: min<number>(caps.perTradeBps, 1_000, live ? 500 : 1_000),
    position: min<bigint>(caps.maxPositionLamports, 60_000_000n, live ? live.positionLamports : 60_000_000n),
    exposure: min<number>(caps.exposureBps, 5_000, live ? 2_000 : 5_000),
    maxExposure: min<bigint>(caps.maxExposureLamports, 300_000_000n, live ? live.exposureLamports : 300_000_000n),
    launch: min<number>(caps.launchShareBps, 2_500),
    pool: min<number>(caps.poolShareBps, 50),
  };
}

const wideFields = fc.record({
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
const realisticFields = fc.record({
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
const inputArb: fc.Arbitrary<SizingInput> = fc
  .tuple(fc.oneof(wideFields, realisticFields), modeArb)
  .map(([fields, mode]) => ({ ...fields, ...mode }));

const floorBps = (value: bigint, rate: number): bigint => (value * BigInt(rate)) / 10_000n;

describe('sizing properties', () => {
  it('an accepted size meets the minimum, every cap in force and the fee reserve (and sizes are accepted)', () => {
    let accepted = 0;
    let acceptedLive = 0;
    let acceptedLoose = 0;
    fc.assert(
      fc.property(inputArb, capsArb, (input, caps) => {
        const r = sizeEntry(input, caps);
        const limit = limits(input, caps);
        accepted += r.ok ? 1 : 0;
        acceptedLive += r.ok && input.mode === 'live' ? 1 : 0;
        acceptedLoose += r.ok && caps.perTradeBps > 1_000 && caps.maxExposureLamports > 300_000_000n ? 1 : 0;
        const accountMinimum = max(caps.minTradeLamports, caps.minTradeFloorLamports);
        const perTradeCap = floorBps(input.sizingEquity, limit.perTrade);
        // All entries stop only when the per-trade cap (10%, live 5%) misses the account minimum, never for one pool.
        assert.equal(!r.ok && r.reason === 'equity-below-minimum', perTradeCap < accountMinimum);
        if (!r.ok) {
          return;
        }
        const overhead = input.rent + input.buyAttemptFees;
        const exposureCap = floorBps(input.sizingEquity, limit.exposure);
        const minimum = max(input.minTrade, accountMinimum);
        assert.ok(r.size >= minimum && r.size > 0n, 'at least the minimum trade, never 0');
        assert.ok(r.size <= perTradeCap, 'limit 1: per trade');
        assert.ok(r.size <= limit.position, 'limit 2: per position');
        assert.ok(input.exposure + r.size + overhead <= exposureCap, 'limit 4: exposure at maxSpend');
        assert.ok(input.exposure + r.size + overhead <= limit.maxExposure, 'limit 5: absolute exposure');
        assert.ok(r.size <= floorBps(2n * input.poolRealSolReserve, limit.pool), 'limit 7: pool share');
        if (input.strategy === 'launch') {
          const effective = exposureCap < limit.maxExposure ? exposureCap : limit.maxExposure;
          assert.ok(input.launchExposure + r.size + overhead <= floorBps(effective, limit.launch), 'limit 8: launch');
        }
        assert.ok(input.sol - (r.size + overhead) >= input.reserveAfterBuy, 'invariant 3: the reserve survives the buy');
        // the hard numbers themselves, whatever the config: never above 0.06 SOL or 10% (live: 5%) of equity
        assert.ok(r.size <= 60_000_000n && r.size * 10_000n <= input.sizingEquity * (input.mode === 'live' ? 500n : 1_000n));
      }),
    );
    assert.ok(accepted >= 100, `only ${accepted} of 1,000 inputs were accepted: the property would be vacuous`);
    assert.ok(acceptedLive >= 30, `only ${acceptedLive} live entries were accepted`);
    assert.ok(acceptedLoose >= 30, `only ${acceptedLoose} entries under loose caps were accepted`);
  });

  it('caps configured above the hard values size exactly as the hard values do', () => {
    const hard = (caps: SizingCaps): SizingCaps => ({
      ...caps,
      perTradeBps: bps(1_000),
      maxPositionLamports: lamports(60_000_000n),
      exposureBps: bps(5_000),
      maxExposureLamports: lamports(300_000_000n),
      launchShareBps: bps(2_500),
      poolShareBps: bps(50),
    });
    fc.assert(
      fc.property(inputArb, looseCaps, (input, caps) => {
        assert.deepEqual(sizeEntry(input, caps), sizeEntry(input, hard(caps)));
      }),
    );
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

  it('the per-trade cap is its rate in force (at most 10%, live 5%) of equity rounded down, exactly', () => {
    fc.assert(
      fc.property(inputArb, capsArb, (input, caps) => {
        const cap = sizeEntry(input, caps).caps['per-trade'] ?? -1n;
        const exact = input.sizingEquity * BigInt(limits(input, caps).perTrade);
        assert.ok(cap * 10_000n <= exact && exact < (cap + 1n) * 10_000n);
      }),
    );
  });
});
