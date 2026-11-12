// The hard limits, the /set and AI bounds and the live caps (RISK_POLICY.md s.2, s.3 and s.12;
// TEST_PLAN.md s.4 invariant 11: "every TUNABLE_BOUNDS max <= its H"). These tests pin the numbers to
// the policy, so a change to config/caps.ts that the policy does not say shows up here, and they
// check the relations between the three tables: no /set bound reaches past a hard ceiling (or below a
// hard floor), and every live value is at least as strict as its hard one.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HARD_CAPS, LIVE_CAPS, TUNABLE_BOUNDS } from '../../../src/config/caps.ts';

type Bound = readonly [number, number] | readonly [bigint, bigint];

/** Each tunable that has a hard limit, and whether that limit is a ceiling (max <= it) or a floor (min >= it). */
const AGAINST_HARD: ReadonlyArray<readonly [string, Bound, 'ceiling' | 'floor', number | bigint]> = [
  ['risk.tradePctBps', TUNABLE_BOUNDS.risk.tradePctBps, 'ceiling', HARD_CAPS.tradePctBps],
  ['risk.openPositions', TUNABLE_BOUNDS.risk.openPositions, 'ceiling', HARD_CAPS.openPositions],
  ['risk.exposurePctBps', TUNABLE_BOUNDS.risk.exposurePctBps, 'ceiling', HARD_CAPS.exposurePctBps],
  ['risk.entriesPerDay', TUNABLE_BOUNDS.risk.entriesPerDay, 'ceiling', HARD_CAPS.entriesPerDay],
  ['risk.costRuleBps', TUNABLE_BOUNDS.risk.costRuleBps, 'ceiling', HARD_CAPS.costRuleBps],
  ['risk.poolShareBps', TUNABLE_BOUNDS.risk.poolShareBps, 'ceiling', HARD_CAPS.poolShareBps],
  ['risk.priceCrossCheckBps', TUNABLE_BOUNDS.risk.priceCrossCheckBps, 'ceiling', HARD_CAPS.priceCrossCheckMaxBps],
  ['risk.dailyStopBps', TUNABLE_BOUNDS.risk.dailyStopBps, 'ceiling', HARD_CAPS.dailyStopBps],
  ['risk.peakHaltBps', TUNABLE_BOUNDS.risk.peakHaltBps, 'ceiling', HARD_CAPS.peakHaltBps],
  ['risk.buySlippageBps', TUNABLE_BOUNDS.risk.buySlippageBps, 'ceiling', HARD_CAPS.buySlippageBps],
  ['risk.sellSlippageBps', TUNABLE_BOUNDS.risk.sellSlippageBps, 'ceiling', HARD_CAPS.sellSlippageBps],
  ['risk.landingSpendBps', TUNABLE_BOUNDS.risk.landingSpendBps, 'ceiling', HARD_CAPS.landingSpendBps],
  ['risk.tokenAgeMs', TUNABLE_BOUNDS.risk.tokenAgeMs, 'floor', HARD_CAPS.tokenAgeMinMs],
  ['risk.curveProgressBps', TUNABLE_BOUNDS.risk.curveProgressBps, 'ceiling', HARD_CAPS.curveProgressMaxBps],
  ['exits.hardStopBps', TUNABLE_BOUNDS.exits.hardStopBps, 'ceiling', HARD_CAPS.hardStopMaxBps],
  ['exits.timeStopMin', TUNABLE_BOUNDS.exits.timeStopMin, 'ceiling', HARD_CAPS.timeStopMaxMin],
  ['paper.pFailBps', TUNABLE_BOUNDS.paper.pFailBps, 'floor', HARD_CAPS.paperPFailMinBps],
  ['paper.extraLatencyMs', TUNABLE_BOUNDS.paper.extraLatencyMs, 'floor', HARD_CAPS.paperExtraLatencyMinMs],
  ['paper.competitionBpsPerLeg', TUNABLE_BOUNDS.paper.competitionBpsPerLeg, 'floor', HARD_CAPS.paperCompetitionMinBpsPerLeg],
];

function allBounds(): Array<readonly [string, Bound]> {
  const out: Array<readonly [string, Bound]> = [];
  for (const [group, params] of Object.entries(TUNABLE_BOUNDS)) {
    for (const [name, bound] of Object.entries(params as Record<string, Bound>)) {
      out.push([`${group}.${name}`, bound]);
    }
  }
  return out;
}

describe('TUNABLE_BOUNDS: /set and the AI stay inside the hard limits (invariant 11)', () => {
  it('every bound is a [min, max] pair of one kind of number with min <= max', () => {
    const bounds = allBounds();
    assert.equal(bounds.length, 36, 'one bound per parameter of s.12 and the T limits of s.3: a new one belongs in the policy first');
    for (const [name, bound] of bounds) {
      assert.equal(bound.length, 2, name);
      const [min, max] = bound;
      assert.equal(typeof min, typeof max, name);
      assert.ok(min <= max, `${name}: ${String(min)} > ${String(max)}`);
      if (typeof min === 'number') {
        assert.ok(Number.isSafeInteger(min) && Number.isSafeInteger(max as number) && min >= 0, `${name}: whole numbers from 0`);
      } else {
        assert.ok(min >= 0n, `${name}: not below zero`);
      }
    }
  });

  it('no max reaches past its hard ceiling, and no min below its hard floor', () => {
    for (const [name, [min, max], kind, hard] of AGAINST_HARD) {
      assert.equal(typeof max, typeof hard, name);
      if (kind === 'ceiling') {
        assert.ok(max <= hard, `${name}: max ${String(max)} above the hard ceiling ${String(hard)}`);
      } else {
        assert.ok(min >= hard, `${name}: min ${String(min)} below the hard floor ${String(hard)}`);
      }
    }
  });

  it('every parameter of RISK_POLICY.md s.12 has its bound', () => {
    const names = new Set(allBounds().map(([name]) => name));
    for (const name of [
      'risk.tradePctBps', 'risk.openPositions', 'risk.exposurePctBps', 'risk.entriesPerDay', 'risk.costRuleBps', 'risk.poolShareBps',
      'risk.priceCrossCheckBps', 'risk.dailyStopBps', 'risk.peakHaltBps', 'risk.buySlippageBps', 'risk.sellSlippageBps',
      'risk.landingSpendBps', 'crowdflow.minDistinctBuyers5m', 'crowdflow.minCompletenessBps', 'crowdflow.maxTopBuyerShareBps',
      'crowdflow.maxSameSlotShareBps', 'crowdflow.maxIdenticalSizeShareBps', 'crowdflow.minAccelerationBps', 'crowdflow.maxRun15mBps',
      'momentum.minAgeMs', 'momentum.minLiquidityLamports', 'momentum.pullbackBps', 'launch.minHolders', 'launch.maxTop10ShareBps',
      'launch.maxCreatorShareBps', 'launch.curveProgressWindowBps', 'exits.hardStopBps', 'exits.takeProfitBps', 'exits.trailBps',
      'exits.timeStopMin', 'exits.timeStopMinGainBps', 'paper.pFailBps', 'paper.extraLatencyMs', 'paper.competitionBpsPerLeg',
    ]) {
      assert.ok(names.has(name), `missing bound for ${name}`);
    }
  });

  it('the bounds are the numbers of RISK_POLICY.md s.12 and the limits table', () => {
    assert.deepEqual(TUNABLE_BOUNDS.risk.tradePctBps, [100, 1_000]); // [1%, 10%]
    assert.deepEqual(TUNABLE_BOUNDS.risk.openPositions, [1, 4]);
    assert.deepEqual(TUNABLE_BOUNDS.risk.exposurePctBps, [1_000, 5_000]); // [10%, 50%]
    assert.deepEqual(TUNABLE_BOUNDS.risk.dailyStopBps, [500, 3_000]); // [5%, 30%]
    assert.deepEqual(TUNABLE_BOUNDS.risk.peakHaltBps, [1_000, 5_000]); // [10%, 50%]
    assert.deepEqual(TUNABLE_BOUNDS.risk.buySlippageBps, [50, 300]); // [0.5%, 3%]
    assert.deepEqual(TUNABLE_BOUNDS.risk.sellSlippageBps, [100, 500]); // [1%, 5%]
    assert.deepEqual(TUNABLE_BOUNDS.risk.landingSpendBps, [5, 30]); // [0.05%, 0.3%]
    assert.deepEqual(TUNABLE_BOUNDS.risk.tokenAgeMs, [180_000, 2_592_000_000]); // [3 min, 30 days]
    assert.deepEqual(TUNABLE_BOUNDS.momentum.minLiquidityLamports, [20_000_000_000n, 2_000_000_000_000n]); // [20, 2,000] SOL
    assert.deepEqual(TUNABLE_BOUNDS.exits.timeStopMin, [5, 240]);
    assert.deepEqual(TUNABLE_BOUNDS.paper.extraLatencyMs, [2_000, 10_000]); // [2 s, 10 s]
  });
});

describe('HARD_CAPS: the numbers of RISK_POLICY.md s.3', () => {
  it('sizes, exposure and stops', () => {
    assert.equal(HARD_CAPS.tradePctBps, 1_000);
    assert.equal(HARD_CAPS.positionLamports, 60_000_000n);
    assert.equal(HARD_CAPS.openPositions, 4);
    assert.equal(HARD_CAPS.exposurePctBps, 5_000);
    assert.equal(HARD_CAPS.exposureLamports, 300_000_000n);
    assert.equal(HARD_CAPS.poolShareBps, 50);
    assert.equal(HARD_CAPS.launchShareOfExposureCapBps, 2_500);
    assert.equal(HARD_CAPS.dailyStopBps, 3_000);
    assert.equal(HARD_CAPS.peakHaltBps, 5_000);
    assert.equal(HARD_CAPS.equitySanityLamports, 2_000_000_000n);
    assert.equal(HARD_CAPS.equitySanityBankrollMultiple, 3);
    assert.equal(HARD_CAPS.equityJumpBps, 5_000);
    assert.equal(HARD_CAPS.entriesPerDay, 12);
    assert.equal(HARD_CAPS.costRuleBps, 500);
    assert.equal(HARD_CAPS.minTradeFloorLamports, 10_000_000n);
  });

  it('the fee reserve of s.3a: one exit attempt at the caps, 9 x 3 attempts, the floor and the multiple', () => {
    const oneAttempt = 5_000n + (HARD_CAPS.exitCuPriceMicroLamports * BigInt(HARD_CAPS.cuLimit)) / 1_000_000n;
    assert.equal(oneAttempt, 125_000n);
    assert.equal(BigInt(HARD_CAPS.exitBudgetWindows * HARD_CAPS.exitAttemptsPerWindow) * oneAttempt + 5_000n, 3_380_000n);
    assert.equal(HARD_CAPS.feeReserveFloorLamports, 10_000_000n);
    assert.equal(HARD_CAPS.feeReserveP95Multiple, 2);
  });

  it('order plans: slippage, CU, tips, landing spend, freshness, and the worst-case spend backstop', () => {
    assert.equal(HARD_CAPS.buySlippageBps, 300);
    assert.equal(HARD_CAPS.sellSlippageBps, 500);
    assert.equal(HARD_CAPS.emergencySellSlippageBps, 1_000);
    assert.equal(HARD_CAPS.cuLimit, 300_000);
    assert.equal(HARD_CAPS.cuSimulatedTenths, 12);
    assert.equal(HARD_CAPS.cuPriceMicroLamports, 200_000n);
    assert.equal(HARD_CAPS.exitCuPriceMicroLamports, 400_000n);
    assert.deepEqual(HARD_CAPS.tipLamports, [0n, 1_000n, 5_000n]);
    assert.equal(HARD_CAPS.landingSpendBps, 30);
    assert.equal(HARD_CAPS.exitLandingSpendBps, 60);
    assert.equal(HARD_CAPS.planFreshSlots, 25);
    // limit 2's worst case at the caps with a Token-2022 account's rent (1,513,840) stays under the backstop
    const worst = HARD_CAPS.positionLamports + 1_513_840n + 3n * (5_000n + (HARD_CAPS.cuPriceMicroLamports * BigInt(HARD_CAPS.cuLimit)) / 1_000_000n + 5_000n);
    assert.ok(worst < HARD_CAPS.buyMaxSpendLamports, `${worst}`);
    assert.equal(HARD_CAPS.buyMaxSpendLamports, 70_000_000n);
  });

  it('the remaining limits: price check, token age, curve, stops, live loss budget, paper floors, signer', () => {
    assert.equal(HARD_CAPS.priceCrossCheckMaxBps, 500);
    assert.equal(HARD_CAPS.tokenAgeMinMs, 180_000);
    assert.equal(HARD_CAPS.curveProgressMaxBps, 9_500);
    assert.equal(HARD_CAPS.hardStopMaxBps, 4_000);
    assert.equal(HARD_CAPS.timeStopMaxMin, 240);
    assert.equal(HARD_CAPS.strategyLiveLossLamports, 50_000_000n);
    assert.equal(HARD_CAPS.paperPFailMinBps, 2_000);
    assert.equal(HARD_CAPS.paperExtraLatencyMinMs, 2_000);
    assert.equal(HARD_CAPS.paperCompetitionMinBpsPerLeg, 50);
    assert.equal(HARD_CAPS.signerDailyBuyLamports, 350_000_000n);
    assert.equal(HARD_CAPS.signerDailyOtherFeeLamports, 20_000_000n);
    assert.equal(HARD_CAPS.signerSignaturesPerHour, 150);
  });
});

describe('LIVE_CAPS: the root\'s stricter values, never looser than the hard ones', () => {
  it('the numbers of RISK_POLICY.md s.2 (decision 9)', () => {
    assert.deepEqual({ ...LIVE_CAPS }, {
      tradePctBps: 500,
      positionEurCents: 500,
      exposurePctBps: 2_000,
      exposureEurCents: 1_000,
      entriesPerDay: 5,
      dailyStopBps: 300,
      peakHaltBps: 1_500,
      poolShareBps: 50,
    });
  });

  it('every live value is at least as strict as its hard one', () => {
    assert.ok(LIVE_CAPS.tradePctBps <= HARD_CAPS.tradePctBps);
    assert.ok(LIVE_CAPS.exposurePctBps <= HARD_CAPS.exposurePctBps);
    assert.ok(LIVE_CAPS.entriesPerDay <= HARD_CAPS.entriesPerDay);
    assert.ok(LIVE_CAPS.dailyStopBps <= HARD_CAPS.dailyStopBps);
    assert.ok(LIVE_CAPS.peakHaltBps <= HARD_CAPS.peakHaltBps);
    assert.ok(LIVE_CAPS.poolShareBps <= HARD_CAPS.poolShareBps);
  });
});

describe('nothing can change a limit at run time', () => {
  it('the three tables are frozen all the way down', () => {
    for (const table of [HARD_CAPS, TUNABLE_BOUNDS, LIVE_CAPS, HARD_CAPS.tipLamports, TUNABLE_BOUNDS.risk, TUNABLE_BOUNDS.risk.tradePctBps, TUNABLE_BOUNDS.momentum.minLiquidityLamports]) {
      assert.ok(Object.isFrozen(table));
    }
    assert.throws(() => {
      (HARD_CAPS as { tradePctBps: number }).tradePctBps = 10_000;
    }, TypeError);
    assert.throws(() => {
      (TUNABLE_BOUNDS.risk.tradePctBps as unknown as number[])[1] = 10_000;
    }, TypeError);
    assert.throws(() => {
      (HARD_CAPS.tipLamports as unknown as bigint[]).push(1_000_000n);
    }, TypeError);
    assert.equal(HARD_CAPS.tradePctBps, 1_000);
  });
});
