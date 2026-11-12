// Shared fixtures for the risk tests: the caps, and a context built from a plan so that the plan
// passes the re-check. Approval tests use `checked(plan)` because only a plan that passed the
// re-check can be given a token; the re-check tests build their own explicit contexts.
import { bps, lamports, microLamportsPerCu, tokenUnits } from '../../../src/core/units.ts';
import { type OrderPlan } from '../../../src/risk/plan.ts';
import { checkPlan, type CheckedPlan, type PlanCaps, type PlanContext } from '../../../src/risk/recheck.ts';
import { type ReserveCaps } from '../../../src/risk/reserve.ts';
import { type SizingCaps } from '../../../src/risk/sizing.ts';

export const WSOL = 'So11111111111111111111111111111111111111112';

/** The HARD_CAPS of RISK_POLICY.md s.3 and s.3a (paper); config/caps.ts replaces these in step 5. */
export const SIZING_CAPS: SizingCaps = {
  perTradeBps: bps(1_000),
  maxPositionLamports: lamports(60_000_000n),
  exposureBps: bps(5_000),
  maxExposureLamports: lamports(300_000_000n),
  launchShareBps: bps(2_500),
  poolShareBps: bps(50),
  minTradeLamports: lamports(20_000_000n),
  minTradeFloorLamports: lamports(10_000_000n),
};

export const RESERVE_CAPS: ReserveCaps = {
  baseFeePerSignature: lamports(5_000n),
  exitSignatures: 1,
  exitCuPriceMax: microLamportsPerCu(400_000n),
  cuLimitMax: 300_000,
  retryWindows: 9,
  attemptsPerWindow: 3,
  landedTipMax: lamports(5_000n),
  reserveFloor: lamports(10_000_000n),
  p95Multiplier: 2,
  wsolHelperRent: lamports(1_488_440n),
};

export const CAPS: PlanCaps = {
  planFreshSlots: 25,
  buySlippageMaxBps: bps(300),
  exitSlippageNormalBps: bps(300),
  exitSlippageEmergencyBps: bps(1_000),
  cuLimitMax: 300_000,
  cuPriceMaxBuy: microLamportsPerCu(200_000n),
  cuPriceMaxExit: microLamportsPerCu(400_000n),
  landingSpendBuyBps: bps(20),
  landingSpendExitBps: bps(60),
  allowedRoutes: ['direct'],
};

/** A context under which `plan` passes every re-check rule (its own numbers are the sized, quoted and owned ones). */
export function passingContext(plan: OrderPlan): PlanContext {
  const buy = plan.kind === 'buy';
  const close = plan.kind === 'close-account';
  const perAttempt = 5_000n + (plan.cuPrice * BigInt(plan.cuLimit) + 999_999n) / 1_000_000n + plan.tip.lamports;
  const held = tokenUnits(plan.kind === 'sell' ? plan.inAmount * 2n : 0n);
  return {
    currentSlot: plan.quoteSlot + 5n,
    intentId: plan.intentId,
    quote: { slot: plan.quoteSlot, feeBps: plan.feeBps, feeConfigSlot: plan.feeConfigSlot },
    position: { id: plan.positionId, mint: plan.mint, mode: plan.mode, status: buy ? 'opening' : close ? 'exiting' : 'open' },
    wallet: plan.wallet,
    ownTokenAccount: plan.tokenAccount,
    wsolMint: WSOL,
    pool: { id: plan.pool, venue: plan.venue, quoteMint: WSOL },
    ledgerTokens: held,
    chainTokens: held,
    simulatedCu: plan.mode === 'live' ? Math.ceil((plan.cuLimit * 10) / 12) : null,
    caps: CAPS,
    buy: buy
      ? {
          minInAmount: lamports(plan.inAmount),
          sizedInAmount: lamports(plan.inAmount),
          sizedAttemptFees: lamports(BigInt(plan.attempts) * perAttempt),
          rentRequired: plan.rentLamports,
          attemptsAllowed: plan.attempts,
          quotedOut: plan.expectedOut,
          buyOrdersForPosition: 0,
        }
      : null,
    exit: buy
      ? null
      : {
          attemptsAllowed: plan.attempts,
          urgency: plan.urgency,
          costBasis: lamports(close ? 1_488_440n : 55_000_000n),
          quotedOut: plan.expectedOut,
          inFlightSellTokens: tokenUnits(0n),
          inFlightExits: 0,
          origin: { kind: 'owner' },
        },
  };
}

/** The plan as a CheckedPlan snapshot; throws if the fixture does not actually pass the re-check. */
export function checked(plan: OrderPlan): CheckedPlan {
  const result = checkPlan(plan, passingContext(plan));
  if (!result.ok) {
    throw new Error(`the fixture plan does not pass the re-check: ${result.problems.join(', ')}`);
  }
  return result.plan;
}

/** A plan with every fee field at its minimum, so a close can pass the 0.6% landing cap on a ~0.0015 SOL base. */
export const FREE_FEES = { cuLimit: 20_000, cuPrice: microLamportsPerCu(0n), tip: { path: 'none', lamports: lamports(0n) } } as const;
