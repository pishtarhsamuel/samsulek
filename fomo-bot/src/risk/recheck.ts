// The plan re-check (RISK_POLICY.md s.6 step 5; limits 16-20; REVIEWS.md entries G and H). Before a
// plan gets an approval token, risk re-derives everything that could hurt from the plan's own
// fields and the engine's context, never trusting the planner:
// - the pool and venue the safety filter approved (not the planner's), SOL-quoted;
// - minOut against risk's OWN quote of the plan's input (quotedOut, from venues/math on the
//   reserves at the quote slot): a planner that understates expectedOut cannot buy a low minOut;
// - the CU, tip and landing-spend caps (the urgency comes from the exit intent, not the plan);
// - attempts, and the worst-case fees against what sizing reserved (buys) or the failed-fee
//   budget (automatic exits), rent, mode, ownership, fresh inputs and the rules for closing.
// Exits run through exits.ts as well, on the very same plan snapshot, so the two checks cannot
// disagree about what they looked at. Pure; an empty list is the only "yes". A malformed plan or
// context throws RiskError (the engine treats any throw as "refuse").
//
// checkPlan is the only way to get a CheckedPlan, and only a CheckedPlan can be given an approval
// token (approval.ts), so no plan can skip the re-check. Judgement calls (REVIEWS.md entry H):
// - The landing-spend cap (limit 18) applies to buys and to NORMAL exits; a protective or emergency
//   exit keeps only the absolute caps ("exits are always allowed"). The urgency is the exit
//   intent's (context), never the plan's.
// - An exit's percentage base is the larger of risk's quote and the position's cost basis from the
//   ledger, computed here, so no caller can inflate it.
// - An exit's origin is 'owner' only for an authenticated /panic or /sell; every other exit is
//   'automatic' and bound by the failed-fee budget, the 2-day stop and the sell simulation.
// Withdraw plans never come here (their own path, RISK_POLICY.md s.14).
import { HARD_CAPS } from '../config/caps.ts';
import { isIdText } from '../core/ids.ts';
import {
  bps,
  bpsOfFloor,
  ceilDiv,
  lamports,
  microLamportsPerCu,
  tokenUnits,
  type Bps,
  type Lamports,
  type MicroLamportsPerCu,
  type TokenUnits,
} from '../core/units.ts';
import { checkExitCaps, exitProblems, type ExitContext, type ExitPlan, type ExitPositionStatus, type ExitProblem } from './exits.ts';
import {
  BASE_FEE_PER_SIGNATURE,
  PLAN_MODES,
  PLAN_URGENCIES,
  ROUTES,
  VENUES,
  validatePlan,
  type OrderPlan,
  type PlanMode,
  type PlanUrgency,
  type Route,
  type Venue,
} from './plan.ts';
import { RiskError, attemptCost } from './reserve.ts';

declare const checkedBrand: unique symbol;

/** RISK_POLICY.md limits 16-20: the H values, from config/caps.ts (the one place they live). */
const HARD_BUY_SLIPPAGE_BPS = HARD_CAPS.buySlippageBps;
const HARD_CU_LIMIT = HARD_CAPS.cuLimit;
const HARD_CU_PRICE_BUY = HARD_CAPS.cuPriceMicroLamports;
const HARD_CU_PRICE_EXIT = HARD_CAPS.exitCuPriceMicroLamports;
const HARD_LANDING_BUY_BPS = HARD_CAPS.landingSpendBps;
const HARD_LANDING_EXIT_BPS = HARD_CAPS.exitLandingSpendBps;
/** Limit 19: 0, 1,000 (Jito) or 5,000 (Helius SWQOS-only) lamports; never a 0.001 SOL service. */
const ALLOWED_TIPS = [
  ['none', HARD_CAPS.tipLamports[0]],
  ['jito', HARD_CAPS.tipLamports[1]],
  ['helius-swqos', HARD_CAPS.tipLamports[2]],
] as const;
/** The CU limit is at most this many tenths of the simulated units (1.2 x), compared exactly. */
const CU_SIMULATED_TENTHS = BigInt(HARD_CAPS.cuSimulatedTenths);
/**
 * Backstops that hold whatever sizing says (RISK_POLICY.md limit 2 "holds even if equity is
 * misread"): a buy's swap input is at most 0.06 SOL (limit 2) and at least 0.01 SOL (the floor of
 * limit 15), and its worst-case spend (input + rent + every attempt) at most 0.07 SOL, a margin
 * above limit 2's 0.0617. They never loosen anything.
 */
const HARD_MAX_BUY_IN = HARD_CAPS.positionLamports;
const HARD_MIN_BUY_IN = HARD_CAPS.minTradeFloorLamports;
const HARD_MAX_BUY_SPEND = HARD_CAPS.buyMaxSpendLamports;
const STATUSES: readonly ExitPositionStatus[] = ['opening', 'open', 'exiting', 'stuck', 'closed'];

export interface PlanCaps {
  /** Plan inputs (quote, fee config) at most this many slots old (limit 20, H 25). */
  readonly planFreshSlots: number;
  /** Limit 16, H 3%. */
  readonly buySlippageMaxBps: Bps;
  /** Limit 17: normal exits (bounds 1% to 5%) and protective or emergency exits (normal cap to 10%). */
  readonly exitSlippageNormalBps: Bps;
  readonly exitSlippageEmergencyBps: Bps;
  /** Limit 18, H 300,000. */
  readonly cuLimitMax: number;
  readonly cuPriceMaxBuy: MicroLamportsPerCu;
  readonly cuPriceMaxExit: MicroLamportsPerCu;
  /** Priority + tip per attempt, as a share of the base (H 0.3%; exits H 0.6%). */
  readonly landingSpendBuyBps: Bps;
  readonly landingSpendExitBps: Bps;
  readonly allowedRoutes: readonly Route[];
}

/** The pool the safety filter approved for this mint: never taken from the plan. */
export interface ApprovedPool {
  readonly id: string;
  readonly venue: Venue;
  readonly quoteMint: string;
}

/** What sizing decided and assumed for this buy. */
export interface BuyPlanContext {
  /** The smallest input that meets the cost rule. */
  readonly minInAmount: Lamports;
  readonly sizedInAmount: Lamports;
  /** The attempt fees sizing reserved (allowed attempts x one attempt). */
  readonly sizedAttemptFees: Lamports;
  /** The token-account rent this buy must pay (0 if the account exists). */
  readonly rentRequired: Lamports;
  readonly attemptsAllowed: number;
  /** Risk's own quote for the plan's input: tokens out, from venues/math on the reserves at the quote slot. */
  readonly quotedOut: bigint;
  /** Buy orders already made for this position (must be 0): one buy per position, ever. */
  readonly buyOrdersForPosition: number;
}

/** Risk's own read of the quote: the plan must be built from the same reserves and fee config. */
export interface QuoteContext {
  /** The slot of the reserves risk quoted against. */
  readonly slot: bigint;
  /** The pool's fee in bps and the slot of the fee config risk read. */
  readonly feeBps: Bps;
  readonly feeConfigSlot: bigint;
}

export type ExitOrigin =
  /** An authenticated /panic or /sell by the owner: not budget-limited, but its fees are still recorded. */
  | { readonly kind: 'owner' }
  /** Everything else: bound by the failed-fee budget, the 2-day stop and the sell simulation (s.3a). */
  | {
      readonly kind: 'automatic';
      readonly budgetLeft: Lamports;
      readonly automaticStopped: boolean;
      readonly sellSimPassed: boolean;
    };

export interface ExitPlanContext {
  readonly attemptsAllowed: number;
  /** The urgency of the ExitIntent: the plan must carry the same. */
  readonly urgency: PlanUrgency;
  /** The position's cost basis from the ledger. */
  readonly costBasis: Lamports;
  /** Risk's own quote for the plan's input: SOL out, from venues/math (0 for a close). */
  readonly quotedOut: bigint;
  /** Token units in sells already submitted and not yet settled. */
  readonly inFlightSellTokens: TokenUnits;
  /** Exit orders of this position already in flight. */
  readonly inFlightExits: number;
  readonly origin: ExitOrigin;
}

export interface PlanContext {
  /** The highest slot seen. */
  readonly currentSlot: bigint;
  /** The engine's id of the intent this order serves (buy or exit); the plan must carry the same, never its own. */
  readonly intentId: string;
  /** Risk's own read of the quote and the fee config. */
  readonly quote: QuoteContext;
  readonly position: { readonly id: string; readonly mint: string; readonly mode: PlanMode; readonly status: ExitPositionStatus };
  /** From config; never from the plan. */
  readonly wallet: string;
  /** Derived for the position's mint; never from the plan. */
  readonly ownTokenAccount: string;
  readonly wsolMint: string;
  readonly pool: ApprovedPool;
  /** The position's tokens in the ledger and on chain. */
  readonly ledgerTokens: TokenUnits;
  readonly chainTokens: TokenUnits;
  /** Units a simulation used; null where none exists (paper only: live needs one). */
  readonly simulatedCu: number | null;
  readonly caps: PlanCaps;
  readonly buy: BuyPlanContext | null;
  readonly exit: ExitPlanContext | null;
}

export type RecheckProblem =
  | 'kind-not-allowed'
  | 'wrong-mode'
  | 'wrong-intent'
  | 'wrong-pool'
  | 'wrong-venue'
  | 'pool-not-sol'
  | 'route-not-allowed'
  | 'stale-fee-config'
  | 'quote-slot-mismatch'
  | 'fee-config-mismatch'
  | 'buy-already-ordered'
  | 'in-amount-above-hard-max'
  | 'in-amount-below-hard-min'
  | 'spend-above-hard-max'
  | 'urgency-on-buy'
  | 'wrong-urgency'
  | 'wrong-position'
  | 'wrong-mint'
  | 'foreign-wallet'
  | 'foreign-token-account'
  | 'stale-plan'
  | 'position-not-opening'
  | 'no-expected-output'
  | 'expected-out-above-quote'
  | 'slippage-above-cap'
  | 'min-out-below-slippage'
  | 'min-out-above-expected'
  | 'cu-not-simulated'
  | 'cu-limit-above-cap'
  | 'cu-limit-above-simulated'
  | 'cu-price-above-cap'
  | 'tip-not-allowed'
  | 'landing-spend-above-cap'
  | 'attempts-above-allowed'
  | 'fees-above-sized'
  | 'in-amount-below-minimum'
  | 'in-amount-above-sized'
  | 'auto-exits-stopped'
  | 'sell-sim-not-passed'
  | 'exit-fee-budget'
  | 'worthless-exit'
  | 'rent-mismatch'
  | 'close-after-buy'
  | 'close-with-swap'
  | 'close-after-close'
  | 'close-after-partial';

export type PlanProblem = RecheckProblem | ExitProblem;

/** A frozen plan snapshot that passed the re-check; only checkPlan makes one. */
export type CheckedPlan = OrderPlan & { readonly [checkedBrand]: true };

export type PlanCheck =
  | { readonly ok: true; readonly plan: CheckedPlan }
  | { readonly ok: false; readonly problems: readonly PlanProblem[] };

const CHECKED = new WeakSet<object>();

/** True only for a snapshot that checkPlan returned and that has not been spent: the approval issuer requires it. */
export function isCheckedPlan(value: unknown): value is CheckedPlan {
  return typeof value === 'object' && value !== null && CHECKED.has(value);
}

/**
 * Spends a snapshot's checked status: true the first time, false after. The approval issuer calls it
 * when it makes the token, so one re-check yields at most one token; a second order for the same
 * plan needs its own re-check against fresh inputs.
 */
export function consumeCheckedPlan(value: unknown): boolean {
  return typeof value === 'object' && value !== null && CHECKED.delete(value);
}

// ---------------------------------------------------------------- checks of the context itself

function object<T extends object>(what: string, value: T | null | undefined): T {
  if (typeof value !== 'object' || value === null) {
    throw new RiskError(`${what} must be an object`);
  }
  return value;
}

function id(what: string, value: unknown): string {
  if (!isIdText(value)) {
    throw new RiskError(`${what} is not a valid id`);
  }
  return value;
}

function slot(what: string, value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new RiskError(`${what} must be a non-negative bigint slot`);
  }
  return value;
}

/** A whole number from 1 to max. */
function wholeNumber(what: string, value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RiskError(`${what} must be a whole number from 1 to ${max}`);
  }
  return value;
}

function count(what: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RiskError(`${what} must be a whole number of at least 0`);
  }
  return value;
}

function flag(what: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new RiskError(`${what} must be a boolean`);
  }
  return value;
}

function oneOf<T extends string>(what: string, allowed: readonly T[], value: unknown): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new RiskError(`${what} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

interface CheckedCaps {
  readonly freshSlots: number;
  readonly fresh: bigint;
  readonly buySlippage: Bps;
  readonly exitNormal: Bps;
  readonly exitEmergency: Bps;
  readonly cuLimit: number;
  readonly cuPriceBuy: bigint;
  readonly cuPriceExit: bigint;
  readonly landingBuyBps: Bps;
  readonly landingExitBps: Bps;
  readonly routes: readonly Route[];
}

/** The caps, read once, none above its hard value (a bad config can only tighten a check). */
function checkCaps(capsInput: PlanCaps): CheckedCaps {
  const caps = object('caps', capsInput);
  const buySlippage = bps(caps.buySlippageMaxBps);
  const landingBuyBps = bps(caps.landingSpendBuyBps);
  const landingExitBps = bps(caps.landingSpendExitBps);
  const cuPriceBuy = microLamportsPerCu(caps.cuPriceMaxBuy);
  const cuPriceExit = microLamportsPerCu(caps.cuPriceMaxExit);
  if (buySlippage > HARD_BUY_SLIPPAGE_BPS) {
    throw new RiskError('the buy slippage cap is above its hard cap (3%)');
  }
  if (landingBuyBps > HARD_LANDING_BUY_BPS || landingExitBps > HARD_LANDING_EXIT_BPS) {
    throw new RiskError('a landing-spend cap is above its hard cap (0.3% buys, 0.6% exits)');
  }
  if (cuPriceBuy > HARD_CU_PRICE_BUY || cuPriceExit > HARD_CU_PRICE_EXIT) {
    throw new RiskError('a CU price cap is above its hard cap (200,000 buys, 400,000 exits)');
  }
  const routes: unknown = caps.allowedRoutes;
  if (!Array.isArray(routes) || routes.length === 0 || !routes.every((r) => (ROUTES as readonly unknown[]).includes(r))) {
    throw new RiskError('allowedRoutes must be a non-empty list of known routes');
  }
  // The exit slippage caps and the freshness window are validated by the exit check's own rules.
  const exit = checkExitCaps({
    planFreshSlots: caps.planFreshSlots,
    normalSlippageBps: caps.exitSlippageNormalBps,
    emergencySlippageBps: caps.exitSlippageEmergencyBps,
  });
  return {
    freshSlots: caps.planFreshSlots,
    fresh: exit.fresh,
    buySlippage,
    exitNormal: exit.normal,
    exitEmergency: exit.emergency,
    cuLimit: wholeNumber('cuLimitMax', caps.cuLimitMax, HARD_CU_LIMIT),
    cuPriceBuy,
    cuPriceExit,
    landingBuyBps,
    landingExitBps,
    routes: Object.freeze([...(routes as Route[])]),
  };
}

type CheckedOrigin =
  | { readonly kind: 'owner' }
  | { readonly kind: 'automatic'; readonly budgetLeft: bigint; readonly automaticStopped: boolean; readonly sellSimPassed: boolean };

type KindContext =
  | {
      readonly type: 'buy';
      readonly attempts: number;
      readonly quotedOut: bigint;
      readonly min: bigint;
      readonly sized: bigint;
      readonly sizedFees: bigint;
      readonly rent: bigint;
      readonly orders: number;
    }
  | {
      readonly type: 'exit';
      readonly attempts: number;
      readonly quotedOut: bigint;
      readonly urgency: PlanUrgency;
      readonly costBasis: bigint;
      readonly inFlightSellTokens: TokenUnits;
      readonly inFlightExits: number;
      readonly origin: CheckedOrigin;
    };

function checkBuy(input: BuyPlanContext | null): KindContext {
  const buy = object('buy context', input);
  return {
    type: 'buy',
    attempts: wholeNumber('buy attemptsAllowed', buy.attemptsAllowed, Number.MAX_SAFE_INTEGER),
    quotedOut: lamports(buy.quotedOut),
    min: lamports(buy.minInAmount),
    sized: lamports(buy.sizedInAmount),
    sizedFees: lamports(buy.sizedAttemptFees),
    rent: lamports(buy.rentRequired),
    orders: count('buyOrdersForPosition', buy.buyOrdersForPosition),
  };
}

function checkOrigin(input: ExitOrigin): CheckedOrigin {
  const origin = object('exit origin', input);
  if (origin.kind === 'owner') {
    return { kind: 'owner' };
  }
  if (origin.kind !== 'automatic') {
    throw new RiskError('the exit origin must be owner or automatic');
  }
  return {
    kind: 'automatic',
    budgetLeft: lamports(origin.budgetLeft),
    automaticStopped: flag('automaticStopped', origin.automaticStopped),
    sellSimPassed: flag('sellSimPassed', origin.sellSimPassed),
  };
}

function checkExit(input: ExitPlanContext | null): KindContext {
  const exit = object('exit context', input);
  return {
    type: 'exit',
    attempts: wholeNumber('exit attemptsAllowed', exit.attemptsAllowed, Number.MAX_SAFE_INTEGER),
    quotedOut: lamports(exit.quotedOut),
    urgency: oneOf('exit urgency', PLAN_URGENCIES, exit.urgency),
    costBasis: lamports(exit.costBasis),
    inFlightSellTokens: tokenUnits(exit.inFlightSellTokens),
    inFlightExits: count('inFlightExits', exit.inFlightExits),
    origin: checkOrigin(exit.origin),
  };
}

// ---------------------------------------------------------------- the re-check

function findProblems(plan: OrderPlan, contextInput: PlanContext): PlanProblem[] {
  const context = object('context', contextInput);
  if (plan.kind === 'withdraw') {
    return ['kind-not-allowed'];
  }
  const current = slot('currentSlot', context.currentSlot);
  const intentId = id('intentId', context.intentId);
  const quote = object('quote', context.quote);
  const quoteSlot = slot('quote slot', quote.slot);
  const quoteFeeBps = bps(quote.feeBps);
  const quoteFeeSlot = slot('quote feeConfigSlot', quote.feeConfigSlot);
  const position = object('position', context.position);
  const positionId = id('position id', position.id);
  const positionMint = id('position mint', position.mint);
  const positionMode = oneOf('position mode', PLAN_MODES, position.mode);
  const positionStatus = oneOf('position status', STATUSES, position.status);
  const wallet = id('wallet', context.wallet);
  const ownAccount = id('ownTokenAccount', context.ownTokenAccount);
  const wsolMint = id('wsolMint', context.wsolMint);
  const pool = object('pool', context.pool);
  const poolId = id('pool id', pool.id);
  const poolVenue = oneOf('pool venue', VENUES, pool.venue);
  const poolQuote = id('pool quoteMint', pool.quoteMint);
  const ledger = tokenUnits(context.ledgerTokens);
  const chain = tokenUnits(context.chainTokens);
  const simulated = context.simulatedCu === null ? null : wholeNumber('simulatedCu', context.simulatedCu, Number.MAX_SAFE_INTEGER);
  const caps = checkCaps(context.caps);
  // Exactly one kind of figures, matching the plan: a buy has no exit context and an exit no buy context.
  const other = plan.kind === 'buy' ? context.exit : context.buy;
  if (other !== null && other !== undefined) {
    throw new RiskError('a buy has a buy context and no exit context, and an exit the reverse');
  }
  const k = plan.kind === 'buy' ? checkBuy(context.buy) : checkExit(context.exit);

  // One attempt pays the base fee, the priority fee and (conservatively) the tip; the landing
  // spend of the cap is priority + tip.
  const perAttempt = attemptCost(
    { signatures: 1, cuPrice: plan.cuPrice, cuLimit: plan.cuLimit, tip: plan.tip.lamports },
    BASE_FEE_PER_SIGNATURE,
  );
  const worstFees = BigInt(plan.attempts) * perAttempt;
  const landing = ceilDiv(plan.cuPrice * BigInt(plan.cuLimit), 1_000_000n) + plan.tip.lamports;

  const problems: PlanProblem[] = [];
  const add = (problem: PlanProblem, applies: boolean): void => {
    if (applies && !problems.includes(problem)) {
      problems.push(problem);
    }
  };

  add('wrong-mode', plan.mode !== positionMode);
  add('wrong-intent', plan.intentId !== intentId); // the id comes from the engine's intent, never from the plan
  add('wrong-pool', plan.pool !== poolId);
  add('wrong-venue', plan.venue !== poolVenue);
  add('pool-not-sol', poolQuote !== wsolMint);
  add('route-not-allowed', !caps.routes.includes(plan.route));
  add('stale-fee-config', plan.feeConfigSlot > current || current - plan.feeConfigSlot > caps.fresh);
  // The plan must be built from the reserves and the fee config risk itself read: a planner that
  // declares a cheaper fee (so paper results look better) or another slot is refused.
  add('quote-slot-mismatch', plan.quoteSlot !== quoteSlot);
  add('fee-config-mismatch', plan.feeBps !== quoteFeeBps || plan.feeConfigSlot !== quoteFeeSlot);
  if (k.type === 'buy') {
    add('urgency-on-buy', plan.urgency !== 'normal');
    add('wrong-position', plan.positionId !== positionId);
    add('wrong-mint', plan.mint !== positionMint);
    add('foreign-wallet', plan.wallet !== wallet);
    add('foreign-token-account', plan.tokenAccount !== ownAccount);
    add('stale-plan', plan.quoteSlot > current || current - plan.quoteSlot > caps.fresh);
    add('position-not-opening', positionStatus !== 'opening');
  } else {
    add('wrong-urgency', plan.urgency !== k.urgency);
  }

  if (plan.kind !== 'close-account') {
    // The floor the declared slippage implies on risk's own quote: a plan cannot declare 2% and
    // accept anything, and cannot hide a bad price by understating its expected output. Compared
    // exactly (cross-multiplied): a floor is a lower bound, so it must never round in the plan's favour.
    add('no-expected-output', k.type === 'buy' && plan.expectedOut === 0n);
    add('expected-out-above-quote', plan.expectedOut > k.quotedOut);
    add('slippage-above-cap', k.type === 'buy' && plan.slippageBps > caps.buySlippage);
    add('min-out-below-slippage', plan.minOut * 10_000n < k.quotedOut * (10_000n - BigInt(plan.slippageBps)));
    add('min-out-above-expected', plan.minOut > plan.expectedOut);
  }

  add('cu-not-simulated', plan.mode === 'live' && simulated === null);
  add('cu-limit-above-cap', plan.cuLimit > caps.cuLimit);
  // 1.2 x the simulated units is a cap, so it is compared exactly and never rounds up.
  add('cu-limit-above-simulated', simulated !== null && BigInt(plan.cuLimit) * 10n > BigInt(simulated) * CU_SIMULATED_TENTHS);
  add('cu-price-above-cap', plan.cuPrice > (k.type === 'buy' ? caps.cuPriceBuy : caps.cuPriceExit));
  add('tip-not-allowed', !ALLOWED_TIPS.some(([path, amount]) => path === plan.tip.path && amount === plan.tip.lamports));
  // The percentage cap: buys and normal exits (the intent's urgency decides). A buy's base is its
  // swap input; an exit's is the larger of risk's quote and the cost basis.
  const landingBase = k.type === 'buy' ? plan.inAmount : k.quotedOut > k.costBasis ? k.quotedOut : k.costBasis;
  const landingCap = bpsOfFloor(landingBase, k.type === 'buy' ? caps.landingBuyBps : caps.landingExitBps);
  add('landing-spend-above-cap', (k.type === 'buy' || k.urgency === 'normal') && landing > landingCap);
  add('attempts-above-allowed', plan.attempts > k.attempts);

  if (k.type === 'buy') {
    add('buy-already-ordered', k.orders > 0); // one buy order per position, ever
    add('fees-above-sized', worstFees > k.sizedFees);
    add('in-amount-below-minimum', plan.inAmount < k.min);
    add('in-amount-above-sized', plan.inAmount > k.sized);
    // Backstops that do not depend on what sizing says (limits 2 and 15): a wrong sizing context
    // cannot make a 1.5 SOL buy, or a buy of nothing that pays rent and fees, pass.
    add('in-amount-above-hard-max', plan.inAmount > HARD_MAX_BUY_IN);
    add('in-amount-below-hard-min', plan.inAmount < HARD_MIN_BUY_IN);
    add('spend-above-hard-max', plan.inAmount + plan.rentLamports + worstFees > HARD_MAX_BUY_SPEND);
    add('rent-mismatch', plan.rentLamports !== k.rent);
    add('close-after-buy', plan.closeAccountAfter);
  } else {
    if (k.origin.kind === 'automatic') {
      add('auto-exits-stopped', k.origin.automaticStopped);
      add('sell-sim-not-passed', plan.kind === 'sell' && !k.origin.sellSimPassed);
      add('exit-fee-budget', worstFees > k.origin.budgetLeft);
      add('worthless-exit', plan.kind === 'sell' && plan.expectedOut === 0n); // only burns fees
    }
    add('rent-mismatch', plan.rentLamports !== 0n);
    add('close-with-swap', plan.kind === 'close-account' && (plan.inAmount !== 0n || plan.expectedOut !== 0n || plan.minOut !== 0n));
    add('close-after-close', plan.kind === 'close-account' && plan.closeAccountAfter);
    // Closing in the same transaction needs the whole holding, the same in the ledger and on chain
    // (an unsolicited deposit would make the close fail and burn budget).
    add('close-after-partial', plan.kind === 'sell' && plan.closeAccountAfter && (plan.inAmount !== ledger || ledger !== chain));

    // The reduce-only rules, on the same snapshot: own token only, own account, own wallet, SOL out.
    const exitPlan: ExitPlan = {
      kind: plan.kind as 'sell' | 'close-account', // an exit context exists only for these two kinds
      positionId: plan.positionId,
      inputMint: plan.mint,
      outputMint: poolQuote,
      inAmount: tokenUnits(plan.inAmount),
      slippageBps: plan.slippageBps,
      urgency: k.urgency,
      quoteSlot: plan.quoteSlot,
      account: plan.tokenAccount,
      destination: plan.wallet,
    };
    const exitContext: ExitContext = {
      currentSlot: current,
      position: { id: positionId, mint: positionMint, status: positionStatus },
      ledgerTokens: ledger,
      chainTokens: chain,
      inFlightSellTokens: k.inFlightSellTokens,
      inFlightExits: k.inFlightExits,
      ownTokenAccount: ownAccount,
      wallet,
      wsolMint,
      caps: { planFreshSlots: caps.freshSlots, normalSlippageBps: caps.exitNormal, emergencySlippageBps: caps.exitEmergency },
    };
    for (const problem of exitProblems(exitPlan, exitContext)) {
      add(problem, true);
    }
  }
  return problems;
}

/** Every reason this plan is refused; an empty list means it would pass checkPlan. */
export function planProblems(planInput: OrderPlan, contextInput: PlanContext): readonly PlanProblem[] {
  return Object.freeze(findProblems(validatePlan(planInput), contextInput));
}

/**
 * The re-check. On success the plan comes back as a frozen CheckedPlan snapshot, the only thing an
 * approval token can be issued for; use that snapshot, never the caller's object, from here on.
 */
export function checkPlan(planInput: OrderPlan, contextInput: PlanContext): PlanCheck {
  const plan = validatePlan(planInput);
  const problems = findProblems(plan, contextInput);
  if (problems.length > 0) {
    return Object.freeze({ ok: false, problems: Object.freeze(problems) });
  }
  CHECKED.add(plan);
  return Object.freeze({ ok: true, plan: plan as CheckedPlan });
}
