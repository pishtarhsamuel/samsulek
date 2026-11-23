// The tunables-to-caps mapping of step 6d-2 (STORAGE_DESIGN.md s.16.4, conditions C2, C49 and C69;
// review L): every cap the engine hands the risk engine comes from the active tunables or the hard
// value, never above the hard value, so no clamp ever bites in paper. The wSOL helper rent comes
// only from the chain read (the RentSource), never from a constant or a tunable. The failed-fee
// budget of automatic exits is its own number (3,375,000), never the reserve's per-position budget
// (3,380,000). The day-state policy takes paper's bankroll from the stored deposit (D7) and only
// the paper mode. Written before src/app/caps.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_ROUTES,
  FAILED_FEE_BUDGET,
  MARK_POLICY,
  MIN_TRADE_LAMPORTS,
  buyCapsOf,
  dayPolicyOf,
  exitPlanCapsOf,
  lowEquityStopOf,
} from '../../../src/app/caps.ts';
import { AppError } from '../../../src/app/faults.ts';
import { HARD_CAPS } from '../../../src/config/caps.ts';
import { DEFAULT_TUNABLES, TUNABLE_PATHS, boundsOf, withValue, type Tunables } from '../../../src/config/tunables.ts';
import { AmountError, lamports, microLamportsPerCu, type Lamports } from '../../../src/core/units.ts';
import { BASE_FEE_PER_SIGNATURE, attemptCost, feeReserve, positionExitBudget } from '../../../src/risk/reserve.ts';
import { sizeEntry } from '../../../src/risk/sizing.ts';
import fc from 'fast-check';
import type { StoredAccount } from '../../../src/storage/repo-book.ts';

const RENT = lamports(2_039_280n);
const HARD_TIP_MAX = HARD_CAPS.tipLamports.reduce<bigint>((most, tip) => (tip > most ? tip : most), 0n);

/** Every tunable at its lower bound, then every tunable at its upper bound. */
function atBounds(which: 0 | 1): Tunables {
  return TUNABLE_PATHS.reduce((t, path) => withValue(t, path, boundsOf(path)[which]), DEFAULT_TUNABLES);
}

const paperAccount = (over: Partial<StoredAccount> = {}): StoredAccount => ({
  mode: 'paper',
  sol: lamports(550_000_000n),
  totalDeposits: lamports(550_000_000n),
  totalWithdrawals: lamports(0n),
  updatedAt: 1,
  ...over,
});

describe('app/caps.ts: the fixed numbers', () => {
  it('the minimum trade is RISK_POLICY limit 15: 0.02 SOL, above the 0.01 SOL hard floor', () => {
    assert.equal(MIN_TRADE_LAMPORTS, 20_000_000n);
    assert.ok(MIN_TRADE_LAMPORTS >= HARD_CAPS.minTradeFloorLamports);
  });

  it('the routes are direct and the Jupiter build: never Jupiter /order, which charges its own fee', () => {
    assert.deepEqual([...ALLOWED_ROUTES], ['direct', 'jupiter-build']);
    assert.ok(Object.isFrozen(ALLOWED_ROUTES));
  });

  it('the failed-fee budget is 9 x 3 attempts at the hard exit fees and no tip: 3,375,000, below the reserve budget', () => {
    const attempt = attemptCost(
      { signatures: 1, cuPrice: microLamportsPerCu(HARD_CAPS.exitCuPriceMicroLamports), cuLimit: HARD_CAPS.cuLimit, tip: lamports(0n) },
      BASE_FEE_PER_SIGNATURE,
    );
    assert.equal(attempt, 125_000n);
    assert.equal(FAILED_FEE_BUDGET, BigInt(HARD_CAPS.exitBudgetWindows * HARD_CAPS.exitAttemptsPerWindow) * attempt);
    assert.equal(FAILED_FEE_BUDGET, 3_375_000n);
    const reserveBudget = positionExitBudget(buyCapsOf(DEFAULT_TUNABLES, RENT).reserve);
    assert.equal(reserveBudget, 3_380_000n);
    assert.ok(FAILED_FEE_BUDGET < reserveBudget);
  });

  it('the mark policy: stale after the hard 30 s, valued 0 for the stops after 5 min (RISK_POLICY s.4)', () => {
    assert.deepEqual({ ...MARK_POLICY }, { staleAfterMs: HARD_CAPS.markStaleMs, stopZeroAfterMs: 300_000 });
    assert.equal(MARK_POLICY.staleAfterMs, 30_000);
    assert.ok(Object.isFrozen(MARK_POLICY));
  });
});

describe('app/caps.ts: buyCapsOf', () => {
  it('maps every field from its tunable or its hard value', () => {
    const t = DEFAULT_TUNABLES;
    const caps = buyCapsOf(t, RENT);
    assert.deepEqual(
      { ...caps.sizing },
      {
        perTradeBps: t.risk.tradePctBps,
        maxPositionLamports: HARD_CAPS.positionLamports,
        exposureBps: t.risk.exposurePctBps,
        maxExposureLamports: HARD_CAPS.exposureLamports,
        launchShareBps: HARD_CAPS.launchShareOfExposureCapBps,
        poolShareBps: t.risk.poolShareBps,
        minTradeLamports: MIN_TRADE_LAMPORTS,
        minTradeFloorLamports: HARD_CAPS.minTradeFloorLamports,
      },
    );
    assert.deepEqual(
      { ...caps.reserve },
      {
        baseFeePerSignature: BASE_FEE_PER_SIGNATURE,
        exitSignatures: 1,
        exitCuPriceMax: HARD_CAPS.exitCuPriceMicroLamports,
        cuLimitMax: HARD_CAPS.cuLimit,
        retryWindows: HARD_CAPS.exitBudgetWindows,
        attemptsPerWindow: HARD_CAPS.exitAttemptsPerWindow,
        landedTipMax: HARD_TIP_MAX,
        reserveFloor: HARD_CAPS.feeReserveFloorLamports,
        p95Multiplier: HARD_CAPS.feeReserveP95Multiple,
        wsolHelperRent: RENT,
      },
    );
    assert.deepEqual({ ...caps.plan, allowedRoutes: [...caps.plan.allowedRoutes] }, { ...exitPlanCapsOf(t), allowedRoutes: [...ALLOWED_ROUTES] });
    assert.equal(caps.plan.buySlippageMaxBps, t.risk.buySlippageBps);
    assert.equal(caps.liveSol, null);
    assert.ok(Object.isFrozen(caps) && Object.isFrozen(caps.sizing) && Object.isFrozen(caps.reserve) && Object.isFrozen(caps.plan));
  });

  it('follows each risk tunable it maps', () => {
    let t = DEFAULT_TUNABLES;
    t = withValue(t, 'risk.tradePctBps', 300);
    t = withValue(t, 'risk.exposurePctBps', 2_000);
    t = withValue(t, 'risk.poolShareBps', 20);
    t = withValue(t, 'risk.buySlippageBps', 100);
    t = withValue(t, 'risk.sellSlippageBps', 200);
    t = withValue(t, 'risk.landingSpendBps', 10);
    const caps = buyCapsOf(t, RENT);
    assert.equal(caps.sizing.perTradeBps, 300);
    assert.equal(caps.sizing.exposureBps, 2_000);
    assert.equal(caps.sizing.poolShareBps, 20);
    assert.equal(caps.plan.buySlippageMaxBps, 100);
    assert.equal(caps.plan.exitSlippageNormalBps, 200);
    assert.equal(caps.plan.landingSpendBuyBps, 10);
    assert.equal(caps.plan.landingSpendExitBps, 10);
  });

  it('review L: the chain rent changes the reserve and nothing else', () => {
    const a = buyCapsOf(DEFAULT_TUNABLES, lamports(1_488_440n));
    const b = buyCapsOf(DEFAULT_TUNABLES, lamports(1_513_840n));
    assert.equal(a.reserve.wsolHelperRent, 1_488_440n);
    assert.equal(b.reserve.wsolHelperRent, 1_513_840n);
    assert.deepEqual({ ...a.reserve, wsolHelperRent: 0n }, { ...b.reserve, wsolHelperRent: 0n });
    assert.deepEqual(a.sizing, b.sizing);
    assert.deepEqual(a.plan, b.plan);
    // three positions: 3 x 3,380,000 plus the rent is above the 0.01 SOL floor, so the rent shows
    const costs = [lamports(100_000n), lamports(100_000n), lamports(100_000n)];
    const reserveOf = (rent: Lamports): Lamports => feeReserve({ p95ExitCosts: costs, wsolHelper: true }, buyCapsOf(DEFAULT_TUNABLES, rent).reserve);
    assert.equal(reserveOf(lamports(1_488_440n)), 3n * 3_380_000n + 1_488_440n);
    assert.equal(reserveOf(lamports(1_513_840n)) - reserveOf(lamports(1_488_440n)), 1_513_840n - 1_488_440n);
  });

  it('review L: no tunable can change the rent, at either bound', () => {
    for (const which of [0, 1] as const) {
      assert.equal(buyCapsOf(atBounds(which), RENT).reserve.wsolHelperRent, RENT);
    }
    for (const path of TUNABLE_PATHS) {
      for (const value of boundsOf(path)) {
        assert.equal(buyCapsOf(withValue(DEFAULT_TUNABLES, path, value), RENT).reserve.wsolHelperRent, RENT, path);
      }
    }
  });

  it('a rent that is not lamports refuses: a number, a negative amount, null', () => {
    assert.throws(() => buyCapsOf(DEFAULT_TUNABLES, 2_039_280 as unknown as Lamports), AmountError);
    assert.throws(() => buyCapsOf(DEFAULT_TUNABLES, -1n as Lamports), AmountError);
    assert.throws(() => buyCapsOf(DEFAULT_TUNABLES, null as unknown as Lamports), AmountError);
  });

  it('every cap stays at or inside its hard value for every tunable at either bound', () => {
    const settings = [atBounds(0), atBounds(1), ...TUNABLE_PATHS.flatMap((p) => boundsOf(p).map((v) => withValue(DEFAULT_TUNABLES, p, v)))];
    for (const t of settings) {
      const { sizing, plan } = buyCapsOf(t, RENT);
      assert.ok(sizing.perTradeBps <= HARD_CAPS.tradePctBps);
      assert.ok(sizing.exposureBps <= HARD_CAPS.exposurePctBps);
      assert.ok(sizing.poolShareBps <= HARD_CAPS.poolShareBps);
      assert.ok(sizing.minTradeLamports >= sizing.minTradeFloorLamports);
      assert.ok(plan.buySlippageMaxBps <= HARD_CAPS.buySlippageBps);
      assert.ok(plan.exitSlippageNormalBps <= HARD_CAPS.sellSlippageBps);
      assert.ok(plan.exitSlippageEmergencyBps <= HARD_CAPS.emergencySellSlippageBps);
      assert.ok(plan.landingSpendBuyBps <= HARD_CAPS.landingSpendBps);
      assert.ok(plan.landingSpendExitBps <= HARD_CAPS.exitLandingSpendBps);
      assert.ok(plan.planFreshSlots <= HARD_CAPS.planFreshSlots);
    }
  });
});

describe('app/caps.ts: exitPlanCapsOf', () => {
  it('maps every field: the hard 25 slots, the hard CU caps, one landing cap for buys and normal exits', () => {
    const t = DEFAULT_TUNABLES;
    const caps = exitPlanCapsOf(t);
    assert.deepEqual(
      { ...caps, allowedRoutes: [...caps.allowedRoutes] },
      {
        planFreshSlots: HARD_CAPS.planFreshSlots,
        buySlippageMaxBps: t.risk.buySlippageBps,
        exitSlippageNormalBps: t.risk.sellSlippageBps,
        exitSlippageEmergencyBps: HARD_CAPS.emergencySellSlippageBps,
        cuLimitMax: HARD_CAPS.cuLimit,
        cuPriceMaxBuy: HARD_CAPS.cuPriceMicroLamports,
        cuPriceMaxExit: HARD_CAPS.exitCuPriceMicroLamports,
        landingSpendBuyBps: t.risk.landingSpendBps,
        landingSpendExitBps: t.risk.landingSpendBps,
        allowedRoutes: [...ALLOWED_ROUTES],
      },
    );
    assert.equal(caps.allowedRoutes, ALLOWED_ROUTES);
    assert.ok(Object.isFrozen(caps));
  });
});

describe('app/caps.ts: dayPolicyOf (D7, contract 9)', () => {
  it("takes paper's bankroll from the stored deposit and the stops from the tunables", () => {
    const t = withValue(withValue(DEFAULT_TUNABLES, 'risk.dailyStopBps', 1_000), 'risk.peakHaltBps', 2_000);
    const policy = dayPolicyOf('paper', t, paperAccount({ totalDeposits: lamports(400_000_000n) }));
    assert.deepEqual(
      { ...policy },
      {
        mode: 'paper',
        dailyStopBps: 1_000,
        peakHaltBps: 2_000,
        sanityMaxLamports: HARD_CAPS.equitySanityLamports,
        bankrollLamports: 400_000_000n,
        sanityBankrollMultiple: HARD_CAPS.equitySanityBankrollMultiple,
        jumpBps: HARD_CAPS.equityJumpBps,
      },
    );
    assert.ok(Object.isFrozen(policy));
    assert.equal(dayPolicyOf('paper', DEFAULT_TUNABLES, paperAccount({ totalDeposits: lamports(1n) })).bankrollLamports, 1n);
    assert.equal(dayPolicyOf('paper', DEFAULT_TUNABLES, paperAccount({ totalDeposits: lamports(2_000_000_000n) })).bankrollLamports, 2_000_000_000n);
  });

  it('refuses a withdrawal, a zero deposit, a deposit over the 2 SOL sanity limit, the live account and the live mode', () => {
    const refused = (f: () => unknown): void => {
      assert.throws(f, (e: unknown) => e instanceof AppError && e.code === 'bad-request');
    };
    refused(() => dayPolicyOf('paper', DEFAULT_TUNABLES, paperAccount({ totalWithdrawals: lamports(1n) })));
    refused(() => dayPolicyOf('paper', DEFAULT_TUNABLES, paperAccount({ totalDeposits: lamports(0n) })));
    refused(() => dayPolicyOf('paper', DEFAULT_TUNABLES, paperAccount({ totalDeposits: lamports(2_000_000_001n) })));
    refused(() => dayPolicyOf('paper', DEFAULT_TUNABLES, paperAccount({ mode: 'live' })));
    refused(() => dayPolicyOf('live' as 'paper', DEFAULT_TUNABLES, paperAccount()));
  });
});

describe('app/caps.ts: lowEquityStopOf, the low-equity stop (C33, RISK_POLICY s.6 step 4)', () => {
  it('at 10% per trade and the 0.02 SOL minimum: off at a sizing equity of 0.2 SOL, on one lamport below', () => {
    assert.equal(DEFAULT_TUNABLES.risk.tradePctBps, 1_000);
    assert.equal(lowEquityStopOf(lamports(0n), lamports(200_000_000n), DEFAULT_TUNABLES), false); // 10% is exactly 20,000,000
    assert.equal(lowEquityStopOf(lamports(0n), lamports(199_999_999n), DEFAULT_TUNABLES), true);
    // the sizing equity is the day's baseline when it is above zero and below the equity (approve.ts)
    assert.equal(lowEquityStopOf(lamports(199_999_999n), lamports(900_000_000n), DEFAULT_TUNABLES), true);
    assert.equal(lowEquityStopOf(lamports(900_000_000n), lamports(200_000_000n), DEFAULT_TUNABLES), false); // a baseline above the equity: the equity
    assert.equal(lowEquityStopOf(lamports(0n), lamports(0n), DEFAULT_TUNABLES), true);
    // a lower per-trade share needs more equity: at 5%, 0.4 SOL
    const five = withValue(DEFAULT_TUNABLES, 'risk.tradePctBps', 500);
    assert.equal(lowEquityStopOf(lamports(0n), lamports(399_999_999n), five), true);
    assert.equal(lowEquityStopOf(lamports(0n), lamports(400_000_000n), five), false);
    assert.throws(() => lowEquityStopOf(-1n as Lamports, lamports(1n), DEFAULT_TUNABLES), AmountError);
    assert.throws(() => lowEquityStopOf(lamports(0n), 1 as unknown as Lamports, DEFAULT_TUNABLES), AmountError);
  });

  it("agrees with sizeEntry's equity-below-minimum on 1,000 random equities, baselines and per-trade shares", () => {
    const [low, high] = boundsOf('risk.tradePctBps') as readonly [number, number];
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 3_000_000_000n }), fc.bigInt({ min: 0n, max: 3_000_000_000n }), fc.integer({ min: low, max: high }), (dayStart, equity, share) => {
        const t = withValue(DEFAULT_TUNABLES, 'risk.tradePctBps', share);
        const sizingEquity = dayStart > 0n && dayStart < equity ? dayStart : equity; // approve.ts's rule
        const sized = sizeEntry(
          {
            strategy: 'momentum',
            mode: 'paper',
            liveSol: null,
            sizeHint: 'normal',
            sizingEquity: lamports(sizingEquity),
            exposure: lamports(0n),
            launchExposure: lamports(0n),
            poolRealSolReserve: lamports(100_000_000_000n),
            sol: lamports(10_000_000_000n),
            reserveAfterBuy: lamports(0n),
            rent: lamports(0n),
            buyAttemptFees: lamports(0n),
            minTrade: lamports(0n),
            liveRampHalf: false,
          },
          buyCapsOf(t, RENT).sizing,
        );
        assert.equal(lowEquityStopOf(lamports(dayStart), lamports(equity), t), !sized.ok && sized.reason === 'equity-below-minimum');
      }),
      { numRuns: 1_000 },
    );
  });
});
