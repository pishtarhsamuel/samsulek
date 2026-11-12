// The hard limits (RISK_POLICY.md s.2 and s.3, kind H), the bounds for /set and AI changes (s.12,
// TUNABLE_BOUNDS) and the stricter live values of owner decision 9 (LIVE_CAPS). These are code
// constants: config files, /set and the AI can only stay at or below a ceiling (at or above a floor),
// and the risk code clamps every configured cap against them, so a bad config can never loosen a
// limit. Changing anything here needs the owner's OK in chat plus risk-guardian and security-auditor
// sign-off; the guard hook asks the owner before any edit of this file. Pure: no imports, no I/O.

/** Freezes an object and everything inside it, so no caller can change a limit at run time. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) {
      deepFreeze(inner);
    }
    Object.freeze(value);
  }
  return value;
}

/** Ceilings (and the floors named ...Min... or ...Floor... or ...Multiple/Windows/Attempts) of kind H. */
export const HARD_CAPS = deepFreeze({
  // limits 1-8: size and exposure
  tradePctBps: 1_000, // 10% of the sizing equity per trade
  positionLamports: 60_000_000n, // 0.06 SOL swap input per position
  openPositions: 4, // opening positions count
  exposurePctBps: 5_000, // 50% of equity
  exposureLamports: 300_000_000n, // 0.30 SOL
  poolShareBps: 50, // 0.5% of pool liquidity (2 x the real SOL reserve)
  launchShareOfExposureCapBps: 2_500, // the launch strategy's share of the exposure cap
  // limits 9, 10 and 12: stops and sanity
  dailyStopBps: 3_000,
  peakHaltBps: 5_000,
  equitySanityLamports: 2_000_000_000n,
  equitySanityBankrollMultiple: 3,
  equityJumpBps: 5_000,
  // limit 11: the fee reserve (all floors)
  feeReserveFloorLamports: 10_000_000n,
  feeReserveP95Multiple: 2,
  exitBudgetWindows: 9,
  exitAttemptsPerWindow: 3,
  // limits 13-15
  entriesPerDay: 12,
  costRuleBps: 500,
  minTradeFloorLamports: 10_000_000n, // a floor: no buy below 0.01 SOL, whatever sizing says
  // limits 16-20: order plans
  buySlippageBps: 300,
  sellSlippageBps: 500, // normal exits
  emergencySellSlippageBps: 1_000, // protective and emergency exits
  cuLimit: 300_000,
  cuSimulatedTenths: 12, // the CU limit is at most 1.2 x the simulated units
  cuPriceMicroLamports: 200_000n,
  exitCuPriceMicroLamports: 400_000n,
  tipLamports: [0n, 1_000n, 5_000n] as const, // none, Jito, Helius SWQOS-only; never another amount
  landingSpendBps: 30, // priority + tip, buys and normal exits
  exitLandingSpendBps: 60,
  planFreshSlots: 25,
  markStaleMs: 30_000,
  markProtectiveMs: 60_000,
  // the backstop of REVIEWS.md K: a buy's worst-case spend (input + rent + every attempt), a margin
  // above limit 2's 0.0617 SOL that covers a Token-2022 account's rent
  buyMaxSpendLamports: 70_000_000n,
  // limits 21-29
  priceCrossCheckMaxBps: 500,
  tokenAgeMinMs: 180_000,
  curveProgressMaxBps: 9_500,
  hardStopMaxBps: 4_000,
  timeStopMaxMin: 240,
  strategyLiveLossLamports: 50_000_000n,
  paperPFailMinBps: 2_000,
  paperExtraLatencyMinMs: 2_000,
  paperCompetitionMinBpsPerLeg: 50,
  // limit 30: the signer keeps its own copy (Phase 8)
  signerDailyBuyLamports: 350_000_000n,
  signerDailyOtherFeeLamports: 20_000_000n,
  signerSignaturesPerHour: 150,
  // operations
  liveReconcileToleranceLamports: 500_000n,
  aiMonthlyUsdMicros: 1_000_000n,
} as const);

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const SOL = 1_000_000_000n;

/**
 * The [min, max] of every value /set and approved AI proposals may change (s.12). A test asserts
 * each max is at or below its HARD_CAPS ceiling and each floor's min at or above its HARD_CAPS floor.
 */
export const TUNABLE_BOUNDS = deepFreeze({
  risk: {
    tradePctBps: [100, 1_000],
    openPositions: [1, 4],
    exposurePctBps: [1_000, 5_000],
    entriesPerDay: [1, 12],
    costRuleBps: [200, 500],
    poolShareBps: [10, 50],
    priceCrossCheckBps: [100, 500],
    dailyStopBps: [500, 3_000],
    peakHaltBps: [1_000, 5_000],
    buySlippageBps: [50, 300],
    sellSlippageBps: [100, 500],
    landingSpendBps: [5, 30],
    tokenAgeMs: [180_000, 30 * DAY_MS],
    curveProgressBps: [1_000, 9_000],
  },
  crowdflow: {
    minDistinctBuyers5m: [3, 50],
    minCompletenessBps: [3_000, 9_000],
    maxTopBuyerShareBps: [1_000, 6_000],
    maxSameSlotShareBps: [1_000, 6_000],
    maxIdenticalSizeShareBps: [1_000, 6_000],
    minAccelerationBps: [0, 50_000],
    maxRun15mBps: [1_000, 20_000],
  },
  momentum: {
    minAgeMs: [DAY_MS, 30 * DAY_MS],
    minLiquidityLamports: [20n * SOL, 2_000n * SOL],
    pullbackBps: [500, 4_000],
  },
  launch: {
    minHolders: [20, 500],
    maxTop10ShareBps: [1_000, 5_000],
    maxCreatorShareBps: [0, 1_000],
    curveProgressWindowBps: [1_000, 9_000],
  },
  exits: {
    hardStopBps: [1_000, 4_000],
    takeProfitBps: [2_000, 30_000],
    trailBps: [1_000, 5_000],
    timeStopMin: [5, 240],
    timeStopMinGainBps: [0, 2_000],
  },
  paper: {
    pFailBps: [2_000, 9_500],
    extraLatencyMs: [2_000, 10_000],
    competitionBpsPerLeg: [50, 300],
  },
} as const);

/**
 * The root project's stricter values, used in live until owner decision 9 (RISK_POLICY.md s.2):
 * 5% and EUR 5 per position, 20% and EUR 10 exposure, 5 entries a day, -3% daily, -15% peak, 0.5% of
 * the pool. The EUR caps are converted to lamports at arm-live and each 00:00 Athens (rounded down);
 * the lower of the SOL and the EUR cap applies, and no price means no live entries.
 */
export const LIVE_CAPS = deepFreeze({
  tradePctBps: 500,
  positionEurCents: 500,
  exposurePctBps: 2_000,
  exposureEurCents: 1_000,
  entriesPerDay: 5,
  dailyStopBps: 300,
  peakHaltBps: 1_500,
  poolShareBps: 50,
} as const);
