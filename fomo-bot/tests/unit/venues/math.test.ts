// Venue quote math: constant product, the pump.fun bonding curve on virtual reserves, slippage
// floors and market-cap fee tiers (TEST_PLAN.md s.3 step 2). Hand vectors ported from the root
// project's tests/test_costs_memecoin.py, so both implementations agree to the lamport.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AmountError, bps, lamports, tokenUnits } from '../../../src/core/units.ts';
import {
  CurveCompleteError,
  cpAmountIn,
  cpAmountOut,
  curveBuy,
  curveSell,
  curveState,
  impactBpsCeil,
  marketCapLamports,
  minOut,
  selectFeeTier,
  totalFeeBps,
  type FeeTier,
} from '../../../src/venues/math.ts';

const SOL = 1_000_000_000n;
const LAUNCH = curveState({
  virtualQuote: lamports(30_000_000_000n),
  virtualToken: tokenUnits(1_073_000_000_000_000n),
  realToken: tokenUnits(793_100_000_000_000n),
  complete: false,
});

describe('constant product (fee from the input, rounded up; output rounded down)', () => {
  it('matches the hand vector', () => {
    // fee = ceil(1_000_000 x 25 / 10_000) = 2_500; out = floor(997_500 x 2e7 / 10_997_500) = 1_814_048
    assert.equal(cpAmountOut(1_000_000n, 10_000_000n, 20_000_000n, bps(25)), 1_814_048n);
  });

  it('rounds the fee up and the output down', () => {
    assert.equal(cpAmountOut(12_345n, 1_000_000n, 3_000_000n, bps(30)), 36_472n);
    assert.equal(cpAmountOut(12_345n, 1_000_000n, 3_000_000n, bps(0)), 36_583n);
    assert.equal(cpAmountOut(0n, 1_000_000n, 3_000_000n, bps(30)), 0n);
  });

  it('cpAmountIn is the exact inverse: the smallest input that reaches the target', () => {
    assert.equal(cpAmountIn(1_814_048n, 10_000_000n, 20_000_000n, bps(25)), 1_000_000n);
    assert.ok(cpAmountOut(999_999n, 10_000_000n, 20_000_000n, bps(25)) < 1_814_048n);
    assert.equal(cpAmountIn(0n, 10_000_000n, 20_000_000n, bps(25)), 0n);
  });

  it('refuses impossible or malformed input', () => {
    assert.throws(() => cpAmountIn(20_000_000n, 10_000_000n, 20_000_000n, bps(25)), /cannot take/);
    assert.throws(() => cpAmountOut(1n, 0n, 1n, bps(25)), AmountError);
    assert.throws(() => cpAmountOut(-1n, 1n, 1n, bps(25)), AmountError);
    assert.throws(() => cpAmountOut(1n, 1n, 1n, bps(10_000)), /fee/);
  });

  it('price impact in bps is rounded up (pessimistic)', () => {
    assert.equal(impactBpsCeil(1_000_000n, 10_000_000n, 20_000_000n, bps(25)), 930n); // exact 929.76
    assert.equal(impactBpsCeil(1_000n, 10n ** 15n, 10n ** 15n, bps(30)), 40n); // exact 40
    assert.throws(() => impactBpsCeil(0n, 1n, 1n, bps(0)), AmountError);
  });
});

describe('pump.fun bonding curve on virtual reserves', () => {
  it('buy matches the hand vector', () => {
    assert.equal(curveBuy(LAUNCH, lamports(SOL), bps(100)), 34_277_831_558_567n);
    assert.equal(curveBuy(LAUNCH, lamports(SOL), bps(0)), 34_612_903_225_806n);
    assert.equal(curveBuy(LAUNCH, lamports(0n), bps(100)), 0n);
  });

  it('sell matches the hand vector (fee taken from the output, rounded up)', () => {
    assert.equal(curveSell(LAUNCH, tokenUnits(10_000_000_000_000n), bps(100)), 274_238_226n);
    assert.equal(curveSell(LAUNCH, tokenUnits(0n), bps(100)), 0n);
  });

  it('a buy never takes more than the real tokens left on the curve', () => {
    const nearlyDone = curveState({
      virtualQuote: lamports(80n * SOL),
      virtualToken: tokenUnits(300_000_000_000_000n),
      realToken: tokenUnits(1_000n),
      complete: false,
    });
    assert.equal(curveBuy(nearlyDone, lamports(SOL), bps(100)), 1_000n);
  });

  it('a complete curve refuses to quote (the token trades on another pool)', () => {
    const graduated = curveState({ ...LAUNCH, realToken: tokenUnits(0n), complete: true });
    assert.throws(() => curveBuy(graduated, lamports(SOL), bps(100)), CurveCompleteError);
    assert.throws(() => curveSell(graduated, tokenUnits(10_000n), bps(100)), CurveCompleteError);
  });

  it('refuses nonsense curve states', () => {
    assert.throws(() => curveState({ ...LAUNCH, virtualQuote: lamports(0n) }), AmountError);
    assert.throws(() => curveState({ ...LAUNCH, virtualToken: tokenUnits(0n) }), AmountError);
    assert.throws(() => curveState({ ...LAUNCH, realToken: tokenUnits(LAUNCH.virtualToken + 1n) }), /cannot exceed/);
    assert.throws(() => curveState({ ...LAUNCH, complete: 'no' as unknown as boolean }), AmountError);
  });
});

describe('slippage floor', () => {
  it('minOut is floor(expected x (1 - bps / 10_000))', () => {
    assert.equal(minOut(1_000n, bps(300)), 970n);
    assert.equal(minOut(999n, bps(1)), 998n); // 998.9001 -> 998
    assert.equal(minOut(5n, bps(10_000)), 0n);
  });
});

describe('market-cap fee tiers (PumpSwap-style)', () => {
  const tier = (thresholdSol: bigint, lp: number, protocol: number, creator: number): FeeTier => ({
    thresholdLamports: lamports(thresholdSol * SOL),
    lpBps: bps(lp),
    protocolBps: bps(protocol),
    creatorBps: bps(creator),
  });
  // A subset shaped like the live PumpSwap table (VERIFIED_FACTS s.3); the real table is read
  // from the on-chain fee config every run.
  const tiers = [tier(0n, 2, 93, 30), tier(420n, 2, 88, 30), tier(4_420n, 2, 68, 30), tier(98_240n, 20, 5, 5)];

  it('selects the last tier whose threshold is at or below the market cap', () => {
    assert.equal(totalFeeBps(selectFeeTier(tiers, 0n)), 125);
    assert.equal(totalFeeBps(selectFeeTier(tiers, 420n * SOL - 1n)), 125);
    assert.equal(totalFeeBps(selectFeeTier(tiers, 420n * SOL)), 120);
    assert.equal(totalFeeBps(selectFeeTier(tiers, 5_000n * SOL)), 100);
    assert.equal(totalFeeBps(selectFeeTier(tiers, 10n ** 18n)), 30);
  });

  it('refuses an empty, unsorted or invalid table (fail closed)', () => {
    assert.throws(() => selectFeeTier([], 1n), /fee tier/);
    assert.throws(() => selectFeeTier([tier(10n, 1, 1, 1)], 1n), /start at 0/);
    assert.throws(() => selectFeeTier([tier(0n, 1, 1, 1), tier(0n, 1, 1, 1)], 1n), /increasing/);
    assert.throws(() => selectFeeTier([tier(0n, 5_000, 5_000, 0)], 1n), /total/);
    assert.throws(() => selectFeeTier(tiers, -1n), AmountError);
  });

  it('market cap = quote reserve x supply / token reserve, rounded down', () => {
    // 85 SOL against 206_900_000 tokens (6 decimals) of a 1B supply -> floor(410.826 SOL)
    const mcap = marketCapLamports(85n * SOL, 206_900_000_000_000n, 1_000_000_000_000_000n);
    assert.equal(mcap, 410_826_486_225n);
    assert.throws(() => marketCapLamports(1n, 0n, 1n), AmountError);
  });
});
