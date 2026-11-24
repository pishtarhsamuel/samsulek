// The caps the engine hands the risk engine, from the active tunables and the hard values
// (STORAGE_DESIGN.md s.16.4; conditions C2, C49, C58 and C69). Every number is at or inside its hard
// value, so no clamp of the risk engine ever bites in paper and nothing is capped silently. The wSOL
// helper rent is the argument, the chain read of the RentSource, never a constant or a tunable
// (review L). The failed-fee budget of automatic exits is its own number, 9 windows x 3 attempts at
// the hard exit fees with no tip (3,375,000), never the reserve's per-position budget (3,380,000),
// which only the reserve holds and which stays inside risk/ (the architecture test). The day-state
// policy is paper's only: its bankroll is the stored deposit (owner decision D7), and a live policy
// is a Phase 8 change.
import { HARD_CAPS } from '../config/caps.ts';
import type { Tunables } from '../config/tunables.ts';
import { bps, bpsOfFloor, lamports, microLamportsPerCu, type Lamports } from '../core/units.ts';
import type { EquityPolicy as MarkPolicy } from '../portfolio/equity.ts';
import type { BuyCaps } from '../risk/approve.ts';
import type { EquityPolicy as DayPolicy } from '../risk/daystate.ts';
import type { Route } from '../risk/plan.ts';
import type { PlanCaps } from '../risk/recheck.ts';
import { BASE_FEE_PER_SIGNATURE, attemptCost } from '../risk/reserve.ts';
import { capsInEffect, tradeMinimum } from '../risk/sizing.ts';
import type { StoredAccount } from '../storage/repo-book.ts';
import { AppError } from './faults.ts';

/** RISK_POLICY limit 15 (a P value, 0.02 SOL); the server's config file replaces it later. */
export const MIN_TRADE_LAMPORTS: Lamports = lamports(20_000_000n);

/** Never Jupiter /order: it charges its own fee (RISK_POLICY s.6). */
export const ALLOWED_ROUTES: readonly Route[] = Object.freeze(['direct', 'jupiter-build'] as const);

/** One exit attempt at the hard exit fees with no tip: 5,000 + 400,000 uL/CU x 300,000 CU / 10^6 = 125,000. */
const EXIT_ATTEMPT: Lamports = attemptCost(
  { signatures: 1, cuPrice: microLamportsPerCu(HARD_CAPS.exitCuPriceMicroLamports), cuLimit: HARD_CAPS.cuLimit, tip: lamports(0n) },
  BASE_FEE_PER_SIGNATURE,
);

/** RISK_POLICY s.3a: what failed automatic exits of one position may burn, until T3's per-day budget. */
export const FAILED_FEE_BUDGET: Lamports = lamports(BigInt(HARD_CAPS.exitBudgetWindows * HARD_CAPS.exitAttemptsPerWindow) * EXIT_ATTEMPT);

/** Marks: stale after the hard 30 s (entries blocked), valued 0 for the stops after 5 min (RISK_POLICY s.4). */
export const MARK_POLICY: MarkPolicy = Object.freeze({ staleAfterMs: HARD_CAPS.markStaleMs, stopZeroAfterMs: 300_000 });

const HARD_TIP_MAX: Lamports = lamports(HARD_CAPS.tipLamports.reduce<bigint>((most, tip) => (tip > most ? tip : most), 0n));

/** The plan caps of every re-check: buys use the buy fields, exits the exit fields. */
export function exitPlanCapsOf(t: Tunables): PlanCaps {
  const landing = bps(t.risk.landingSpendBps); // limit 18: one P value for buys and normal exits (stricter than the exit H)
  return Object.freeze({
    planFreshSlots: HARD_CAPS.planFreshSlots,
    buySlippageMaxBps: bps(t.risk.buySlippageBps),
    exitSlippageNormalBps: bps(t.risk.sellSlippageBps),
    exitSlippageEmergencyBps: bps(HARD_CAPS.emergencySellSlippageBps),
    cuLimitMax: HARD_CAPS.cuLimit,
    cuPriceMaxBuy: microLamportsPerCu(HARD_CAPS.cuPriceMicroLamports),
    cuPriceMaxExit: microLamportsPerCu(HARD_CAPS.exitCuPriceMicroLamports),
    landingSpendBuyBps: landing,
    landingSpendExitBps: landing,
    allowedRoutes: ALLOWED_ROUTES,
  });
}

/** A paper buy's caps; `wsolHelperRent` is the chain read, and a value that is not lamports refuses. */
export function buyCapsOf(t: Tunables, wsolHelperRent: Lamports): BuyCaps {
  const rent = lamports(wsolHelperRent);
  return Object.freeze({
    sizing: Object.freeze({
      perTradeBps: bps(t.risk.tradePctBps),
      maxPositionLamports: lamports(HARD_CAPS.positionLamports),
      exposureBps: bps(t.risk.exposurePctBps),
      maxExposureLamports: lamports(HARD_CAPS.exposureLamports),
      launchShareBps: bps(HARD_CAPS.launchShareOfExposureCapBps),
      poolShareBps: bps(t.risk.poolShareBps),
      minTradeLamports: MIN_TRADE_LAMPORTS,
      minTradeFloorLamports: lamports(HARD_CAPS.minTradeFloorLamports),
    }),
    reserve: Object.freeze({
      baseFeePerSignature: BASE_FEE_PER_SIGNATURE,
      exitSignatures: 1,
      exitCuPriceMax: microLamportsPerCu(HARD_CAPS.exitCuPriceMicroLamports),
      cuLimitMax: HARD_CAPS.cuLimit,
      retryWindows: HARD_CAPS.exitBudgetWindows,
      attemptsPerWindow: HARD_CAPS.exitAttemptsPerWindow,
      landedTipMax: HARD_TIP_MAX,
      reserveFloor: lamports(HARD_CAPS.feeReserveFloorLamports),
      p95Multiplier: HARD_CAPS.feeReserveP95Multiple,
      wsolHelperRent: rent,
    }),
    plan: exitPlanCapsOf(t),
    liveSol: null,
  });
}

/**
 * Paper's day-state policy (contract 9: the mode is the engine's, never a caller's). The bankroll is
 * the one stored deposit: refused unless nothing was withdrawn and the deposit is 1 lamport to the
 * 2 SOL sanity limit (the setup's own bounds).
 */
export function dayPolicyOf(mode: 'paper', t: Tunables, paper: StoredAccount): DayPolicy {
  const { mode: accountMode, totalDeposits, totalWithdrawals } = paper; // each field read once
  if (mode !== 'paper' || accountMode !== 'paper') {
    throw new AppError('bad-request', 'the day-state policy is built for the paper account only (live arrives in Phase 8)');
  }
  if (totalWithdrawals !== 0n || totalDeposits < 1n || totalDeposits > HARD_CAPS.equitySanityLamports) {
    throw new AppError('bad-request', "paper's bankroll is its one deposit: nothing withdrawn, 1 lamport to 2 SOL");
  }
  return Object.freeze({
    mode: 'paper',
    dailyStopBps: bps(t.risk.dailyStopBps),
    peakHaltBps: bps(t.risk.peakHaltBps),
    sanityMaxLamports: lamports(HARD_CAPS.equitySanityLamports),
    bankrollLamports: lamports(totalDeposits),
    sanityBankrollMultiple: HARD_CAPS.equitySanityBankrollMultiple,
    jumpBps: bps(HARD_CAPS.equityJumpBps),
  });
}

/**
 * The low-equity stop (C33; RISK_POLICY s.6 step 4): new entries stop when the per-trade share of the
 * sizing equity is below the account minimum. Exactly sizeEntry's equity-below-minimum (risk/sizing.ts),
 * on the caps in effect for paper and approve.ts's sizing equity (the day's baseline when it is above
 * zero and below the equity, else the equity); the pool's own minimum plays no part (the pool is not
 * known here). Pure; an agreement property pins it to sizeEntry.
 */
export function lowEquityStopOf(dayStart: Lamports, equity: Lamports, t: Tunables): boolean {
  const start = lamports(dayStart);
  const now = lamports(equity);
  const caps = capsInEffect(buyCapsOf(t, lamports(0n)).sizing, 'paper', null);
  const sizingEquity = start > 0n && start < now ? start : now;
  return bpsOfFloor(sizingEquity, caps.perTradeBps) < tradeMinimum(lamports(0n), caps);
}
