// The approval step (T1; ARCHITECTURE.md s.4, RISK_POLICY.md s.6): the one place where entry blocks,
// sizing, the fee reserve, the plan re-check and the approval token come together, in this order, on
// ONE snapshot of the world that the engine re-reads inside the SQLite transaction. Pure: the
// engine reads, this decides, and the engine writes what it returns in the same transaction (the
// opening position, the day's entry count and the token id). A throw of any kind is a refusal.
//
// What it adds to the parts (each tested on its own) is what only the composition can get wrong:
// - Every opening, open, exiting and stuck position is counted: for the position cap, for the
//   exposure caps (open at their value, opening at their worst-case spend), for one position per
//   mint, and in the fee reserve, where the NEW position joins them (N = positions after this buy).
// - SOL that buys in flight will still spend (the opening positions' worst-case spend) is held
//   back from the wallet before the free-SOL cap is computed, so two buys can never spend the same
//   lamport (RISK_POLICY.md invariant 17).
// - Size comes from the LOWER of start-of-day and current equity: a price spike never makes a
//   trade bigger. Unknown equity blocks the entry before anything is sized.
// - The plan is re-checked against what THIS snapshot sized (the same minimum trade, the same
//   attempt fees), and every fact about the position, pool and wallet comes from the engine's
//   side, never from the plan.
// - A last, independent check of the hard limits on the plan's own worst-case numbers
//   (buyLimitViolations) runs before the token exists. It cannot fire if the parts agree.
// - The token is made last, once, for the frozen CheckedPlan; a refusal at any stage makes none.
// Exits never come here for flags: approveExit has no kill, halt, pause, breaker or mode input, so
// no flag can stop a valid reduce-only exit (s.9). It issues tokens for sells and closes only. It is
// a thin wrapper: every exit fact (exits in flight, holdings, the intent id, the quote) comes from
// the caller, so the transaction around it must re-read them inside the transaction.
// The caps come from the engine's config. Until config/caps.ts clamps them against HARD_CAPS (and
// LIVE_CAPS in live) in step 5, only the backstops in recheck.ts are hard (0.06, 0.01 and 0.07 SOL
// per buy); the exposure, per-trade, pool-share and position caps are as good as the config
// (REVIEWS.md K, risk-guardian N1: clamping inside sizeEntry and buyLimitViolations is a gate for step 5).
import { isIdText, isStrategyId, type StrategyId } from '../core/ids.ts';
import { isTimestamp } from '../core/time.ts';
import { U64_MAX, bpsOfFloor, lamports, tokenUnits, type Lamports } from '../core/units.ts';
import { type ApprovalIssuer, type ApprovalToken } from './approval.ts';
import { entryBlocks, type EntryState } from './blocks.ts';
import { BASE_FEE_PER_SIGNATURE, planMaxSpend, validatePlan, type OrderPlan } from './plan.ts';
import { checkPlan, type ApprovedPool, type CheckedPlan, type PlanCaps, type PlanContext, type PlanProblem, type QuoteContext } from './recheck.ts';
import { RiskError, attemptCost, feeReserve, type ReserveCaps } from './reserve.ts';
import { sizeEntry, tradeMinimum, type SizeLimit, type SizingCap, type SizingCaps } from './sizing.ts';

/** More positions than this is not a portfolio, it is a bug; it also bounds the work done per call. */
const MAX_SNAPSHOT_POSITIONS = 1_000;
const ACTIVE_STATUSES: readonly ActiveStatus[] = ['opening', 'open', 'exiting', 'stuck'];

export type ActiveStatus = 'opening' | 'open' | 'exiting' | 'stuck';

interface ActivePositionBase {
  readonly id: string;
  readonly mint: string;
  readonly strategy: StrategyId;
  /** The exit cost the fee reserve plans for this position (RISK_POLICY.md s.3a). */
  readonly p95ExitCost: Lamports;
}

/**
 * A position that is not closed, as T1 re-reads it. The two kinds carry different numbers, so a
 * mark can never be passed where a worst-case spend belongs: an OPENING position (a buy in flight, no
 * tokens yet) carries its maxSpend, which counts in the exposure caps and is the SOL still held back
 * from the wallet for it; the others carry the value of their exit quote (a stuck one at 0).
 */
export type ActivePosition =
  | (ActivePositionBase & { readonly status: 'opening'; readonly maxSpend: Lamports })
  | (ActivePositionBase & { readonly status: 'open' | 'exiting' | 'stuck'; readonly value: Lamports });

/** What a position row is read as before it is checked (both numbers optional: the status decides). */
interface PositionFields extends ActivePositionBase {
  readonly status: ActiveStatus;
  readonly value: Lamports;
  readonly maxSpend: Lamports;
}

/** Everything in the entry state that T1 does not derive itself. */
export type EntryFlags = Omit<EntryState, 'now' | 'equityKnown' | 'activeMints' | 'activePositions'>;

export interface EquityInput {
  /** Fully valued equity now; null while any position lacks a fresh mark. */
  readonly current: Lamports | null;
  /** The day baseline (0: not observed yet today). */
  readonly dayStart: Lamports;
}

export interface BuyIntent {
  readonly strategy: StrategyId;
  /** The mode the strategy runs in; the plan must be in the same mode. */
  readonly mode: 'paper' | 'live';
  readonly mint: string;
  readonly creator: string | null;
  readonly sizeHint: 'min' | 'normal';
  /** The id the new position gets (made by the engine, never by the plan). */
  readonly positionId: string;
  /** The id of this buy intent (made by the engine): the plan must carry the same, and its token binds it. */
  readonly intentId: string;
}

/** The world, re-read inside the transaction. */
export interface BuyWorld {
  readonly now: number;
  /** The highest slot seen. */
  readonly currentSlot: bigint;
  readonly flags: EntryFlags;
  /** Every position opening, open, exiting or stuck. */
  readonly positions: readonly ActivePosition[];
  readonly equity: EquityInput;
  /** The wallet's SOL now (live: the lower of ledger and chain). */
  readonly walletSol: Lamports;
}

/** What the safety filter and the engine derived for this mint: never taken from the plan. */
export interface BuyMarket {
  /** The pool the safety filter approved. */
  readonly pool: ApprovedPool;
  /** Risk's own read of the quote and the fee config: the plan must be built from the same. */
  readonly quote: QuoteContext;
  /** Twice this is the pool's liquidity (RISK_POLICY.md limit 5). */
  readonly poolRealSolReserve: Lamports;
  /** The smallest size that meets the cost rule for this pool. */
  readonly poolMinTrade: Lamports;
  /** Risk's own quote for the plan's input (venues/math on the reserves at the quote slot). */
  readonly quotedOut: bigint;
  /** Units a simulation used; null only in paper. */
  readonly simulatedCu: number | null;
  readonly attemptsAllowed: number;
  /** The token-account rent this buy must pay (0 if the account exists). */
  readonly rentRequired: Lamports;
  readonly wallet: string;
  readonly ownTokenAccount: string;
  readonly wsolMint: string;
  /** The exit cost the reserve plans for the new position. */
  readonly newPositionP95ExitCost: Lamports;
  /** True when any exit needs the wSOL helper account. */
  readonly wsolHelper: boolean;
  /** A strategy's first 20 live trades are at half size. */
  readonly liveRampHalf: boolean;
}

export interface BuyCaps {
  readonly sizing: SizingCaps;
  readonly reserve: ReserveCaps;
  readonly plan: PlanCaps;
}

export interface BuyApprovalInput {
  readonly intent: BuyIntent;
  /** The planner's plan: untrusted until the re-check has passed. */
  readonly plan: OrderPlan;
  readonly world: BuyWorld;
  readonly market: BuyMarket;
  readonly caps: BuyCaps;
}

/** The position row T1 inserts, in the same transaction as the token. */
export interface OpeningPosition {
  readonly id: string;
  readonly mint: string;
  readonly strategy: StrategyId;
  readonly mode: 'paper' | 'live';
  readonly openedAt: number;
  /** Counted against every cap and held back from the wallet until the buy settles. */
  readonly maxSpend: Lamports;
}

export type BuyDecision =
  | {
      readonly approved: true;
      readonly token: ApprovalToken;
      /** The frozen snapshot the executor must build its transaction from. */
      readonly plan: CheckedPlan;
      readonly size: Lamports;
      readonly limitedBy: SizeLimit;
      readonly binding: SizingCap;
      readonly opening: OpeningPosition;
      /** The day's entry count after this entry; the engine stores it in the same transaction. */
      readonly entriesToday: number;
    }
  | {
      readonly approved: false;
      /** Where it stopped: the entry blocks, sizing, or the plan (the re-check). */
      readonly stage: 'blocked' | 'sizing' | 'plan';
      /** Block names, `sizing:<reason>` or `plan:<problem>`: fixed text only. */
      readonly reasons: readonly string[];
    };

export interface ExitApprovalInput {
  readonly plan: OrderPlan;
  readonly context: PlanContext;
}

export type ExitDecision =
  | { readonly approved: true; readonly token: ApprovalToken; readonly plan: CheckedPlan }
  | { readonly approved: false; readonly problems: readonly (PlanProblem | 'not-an-exit')[] };

// ---------------------------------------------------------------- checks of the input itself

/** An object whose named properties are still unchecked: read each once, then check it. */
function object<T>(what: string, value: unknown): { readonly [K in keyof T]?: unknown } {
  if (typeof value !== 'object' || value === null) {
    throw new RiskError(`${what} must be an object`);
  }
  return value as { readonly [K in keyof T]?: unknown };
}

function requireIssuer(issuer: unknown): ApprovalIssuer {
  if (typeof issuer !== 'object' || issuer === null || typeof (issuer as { issue?: unknown }).issue !== 'function') {
    throw new RiskError('an approval issuer is required');
  }
  return issuer as ApprovalIssuer;
}

function slot(what: string, value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) {
    throw new RiskError(`${what} must be a non-negative bigint slot`);
  }
  return value;
}

function wholeNumber(what: string, value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new RiskError(`${what} must be a whole number of at least ${min}`);
  }
  return value;
}

function boolean(what: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new RiskError(`${what} must be a boolean`);
  }
  return value;
}

function id(what: string, value: unknown): string {
  if (!isIdText(value)) {
    throw new RiskError(`${what} is not a valid id`);
  }
  return value;
}

interface CheckedIntent {
  readonly strategy: StrategyId;
  readonly mode: 'paper' | 'live';
  readonly mint: string;
  readonly creator: string | null;
  readonly sizeHint: 'min' | 'normal';
  readonly positionId: string;
  readonly intentId: string;
}

function checkIntent(input: unknown): CheckedIntent {
  const { strategy, mode, mint, creator, sizeHint, positionId, intentId } = object<BuyIntent>('intent', input);
  if (!isStrategyId(strategy)) {
    throw new RiskError('unknown strategy');
  }
  if (mode !== 'paper' && mode !== 'live') {
    throw new RiskError('an entry runs in paper or live mode');
  }
  if (sizeHint !== 'min' && sizeHint !== 'normal') {
    throw new RiskError("sizeHint must be 'min' or 'normal'");
  }
  return {
    strategy,
    mode,
    mint: id('mint', mint),
    creator: creator === null ? null : id('creator', creator),
    sizeHint,
    positionId: id('position id', positionId),
    intentId: id('intent id', intentId),
  };
}

interface Snapshot {
  readonly mints: ReadonlySet<string>;
  readonly count: number;
  /** Open positions at their value, opening ones at their worst-case spend. */
  readonly exposure: bigint;
  readonly launchExposure: bigint;
  /** What the opening positions still hold back from the wallet. */
  readonly held: bigint;
  readonly p95ExitCosts: readonly Lamports[];
}

/** The positions as one snapshot: nothing counted twice, nothing left out. */
function checkPositions(input: unknown, newPositionId: string): Snapshot {
  if (!Array.isArray(input)) {
    throw new RiskError('positions must be a list');
  }
  if (input.length > MAX_SNAPSHOT_POSITIONS) {
    throw new RiskError(`more than ${MAX_SNAPSHOT_POSITIONS} active positions: not a real portfolio`);
  }
  const ids = new Set<string>([newPositionId]);
  const mints = new Set<string>();
  const p95ExitCosts: Lamports[] = [];
  let exposure = 0n;
  let launchExposure = 0n;
  let held = 0n;
  for (const raw of input as readonly unknown[]) {
    const { id: positionId, mint, strategy, status, value, maxSpend: spend, p95ExitCost } = object<PositionFields>('position', raw);
    const checkedId = id('position id', positionId);
    const checkedMint = id('position mint', mint);
    if (!isStrategyId(strategy)) {
      throw new RiskError('a position has an unknown strategy');
    }
    if (!ACTIVE_STATUSES.includes(status as ActiveStatus)) {
      throw new RiskError('a position here must be opening, open, exiting or stuck');
    }
    if (ids.has(checkedId)) {
      throw new RiskError('two positions share an id, or the new position already exists');
    }
    if (mints.has(checkedMint)) {
      throw new RiskError('two active positions share a mint');
    }
    // An opening position carries its worst-case spend and no mark; every other one carries its value and no spend.
    if (status === 'opening' ? value !== undefined || spend === undefined : spend !== undefined || value === undefined) {
      throw new RiskError('an opening position carries its maxSpend and the others their value, never the other number');
    }
    const worth = lamports((status === 'opening' ? spend : value) as bigint);
    ids.add(checkedId);
    mints.add(checkedMint);
    p95ExitCosts.push(lamports(p95ExitCost as bigint));
    exposure += worth;
    if (strategy === 'launch') {
      launchExposure += worth;
    }
    if (status === 'opening') {
      held += worth;
    }
  }
  return { mints, count: ids.size - 1, exposure, launchExposure, held, p95ExitCosts };
}

// ---------------------------------------------------------------- the hard limits, recomputed

export interface BuyLimitCheck {
  readonly plan: OrderPlan;
  readonly strategy: StrategyId;
  readonly activePositions: number;
  readonly maxPositions: number;
  readonly sameMintActive: boolean;
  readonly sizingEquity: Lamports;
  readonly exposure: Lamports;
  readonly launchExposure: Lamports;
  readonly poolRealSolReserve: Lamports;
  readonly walletSol: Lamports;
  readonly held: Lamports;
  readonly reserveAfterBuy: Lamports;
  readonly caps: SizingCaps;
}

export type LimitViolation =
  | 'positions'
  | 'one-per-mint'
  | 'per-trade'
  | 'per-position'
  | 'exposure'
  | 'exposure-absolute'
  | 'launch'
  | 'pool-share'
  | 'reserve';

/**
 * The hard limits of RISK_POLICY.md s.3 (1, 2, 4, 5, 7, 8, 11) and the position rules, recomputed
 * from the plan's OWN worst-case numbers (planMaxSpend), not from what sizing returned. An empty
 * list is the only "yes". If sizing and the re-check agree it is always empty, so any entry is a
 * bug in the composition and T1 refuses to issue a token.
 */
export function buyLimitViolations(check: BuyLimitCheck): readonly LimitViolation[] {
  const plan = validatePlan(check.plan);
  const spend = planMaxSpend(plan);
  const equity = lamports(check.sizingEquity);
  const caps = check.caps;
  const exposureAfter = lamports(check.exposure) + spend;
  const exposureCap = bpsOfFloor(equity, caps.exposureBps);
  const maxExposure = lamports(caps.maxExposureLamports);
  const found: LimitViolation[] = [];
  const add = (violation: LimitViolation, applies: boolean): void => {
    if (applies) {
      found.push(violation);
    }
  };
  add('positions', check.activePositions + 1 > wholeNumber('maxPositions', check.maxPositions, 1));
  add('one-per-mint', check.sameMintActive);
  add('per-trade', plan.inAmount > bpsOfFloor(equity, caps.perTradeBps));
  add('per-position', plan.inAmount > lamports(caps.maxPositionLamports));
  add('exposure', exposureAfter > exposureCap);
  add('exposure-absolute', exposureAfter > maxExposure);
  if (check.strategy === 'launch') {
    const effective = exposureCap < maxExposure ? exposureCap : maxExposure;
    add('launch', lamports(check.launchExposure) + spend > bpsOfFloor(effective, caps.launchShareBps));
  }
  add('pool-share', plan.inAmount > bpsOfFloor(2n * lamports(check.poolRealSolReserve), caps.poolShareBps));
  add('reserve', lamports(check.walletSol) < lamports(check.held) + spend + lamports(check.reserveAfterBuy));
  return Object.freeze(found);
}

// ---------------------------------------------------------------- approving a buy

const refuse = (stage: 'blocked' | 'sizing' | 'plan', reasons: readonly string[]): BuyDecision =>
  Object.freeze({ approved: false, stage, reasons: Object.freeze([...reasons]) });

/**
 * The approval of one buy. The input is read once into checked copies; a malformed input throws
 * RiskError or AmountError (the engine refuses and alerts), a real refusal comes back as a decision.
 * The order is fixed: blocks, sizing, the plan re-check, the independent limit check, the token.
 */
export function approveBuy(inputRaw: BuyApprovalInput, issuerRaw: ApprovalIssuer): BuyDecision {
  const issuer = requireIssuer(issuerRaw);
  // Every field of the input, the world and the market is read exactly once, into a local.
  const { plan: planRaw, intent: intentRaw, world: worldRaw, market: marketRaw, caps: capsRaw } = object<BuyApprovalInput>('input', inputRaw);
  const plan = validatePlan(planRaw as OrderPlan); // a frozen snapshot: all later reads are of this
  if (plan.kind !== 'buy') {
    return refuse('plan', ['plan:not-a-buy']);
  }
  const intent = checkIntent(intentRaw);

  const { now, currentSlot: slotRaw, flags: flagsRaw, positions, equity: equityRaw, walletSol: walletRaw } = object<BuyWorld>('world', worldRaw);
  if (!isTimestamp(now)) {
    throw new RiskError('now must be a UTC millisecond timestamp up to the year 2200');
  }
  const currentSlot = slot('currentSlot', slotRaw);
  const flags = { ...object<EntryFlags>('flags', flagsRaw) };
  const book = checkPositions(positions, intent.positionId);
  const { current, dayStart: dayStartRaw } = object<EquityInput>('equity', equityRaw);
  const equityNow = current === null ? null : lamports(current as bigint);
  const dayStart = lamports(dayStartRaw as bigint);
  const walletSol = lamports(walletRaw as bigint);

  const {
    pool: poolRaw,
    quote: quoteRaw,
    poolRealSolReserve: reserveRaw,
    poolMinTrade: minTradeRaw,
    quotedOut,
    simulatedCu,
    attemptsAllowed: attemptsRaw,
    rentRequired: rentRaw,
    wallet,
    ownTokenAccount,
    wsolMint,
    newPositionP95ExitCost: p95Raw,
    wsolHelper: helperRaw,
    liveRampHalf: rampRaw,
  } = object<BuyMarket>('market', marketRaw);
  const { id: poolId, venue: poolVenue, quoteMint } = object<ApprovedPool>('pool', poolRaw);
  const approvedPool: ApprovedPool = { id: poolId as string, venue: poolVenue as ApprovedPool['venue'], quoteMint: quoteMint as string };
  const { slot: quoteSlot, feeBps, feeConfigSlot } = object<QuoteContext>('quote', quoteRaw);
  const quote: QuoteContext = { slot: quoteSlot as bigint, feeBps: feeBps as QuoteContext['feeBps'], feeConfigSlot: feeConfigSlot as bigint };
  const poolRealSolReserve = lamports(reserveRaw as bigint);
  const poolMinTrade = lamports(minTradeRaw as bigint);
  const rentRequired = lamports(rentRaw as bigint);
  const attemptsAllowed = wholeNumber('attemptsAllowed', attemptsRaw, 1);
  const newP95 = lamports(p95Raw as bigint);
  const wsolHelper = boolean('wsolHelper', helperRaw);
  const liveRampHalf = boolean('liveRampHalf', rampRaw);
  // The caps are copied once: sizing, the minimum trade and the independent limit check all see the same ones.
  const { sizing: sizingCaps, reserve: reserveCaps, plan: planCaps } = object<BuyCaps>('caps', capsRaw) as BuyCaps;

  // 1. the entry blocks, on the state derived from the snapshot
  const state: EntryState = {
    ...(flags as unknown as EntryFlags),
    now,
    equityKnown: equityNow !== null,
    activeMints: book.mints,
    activePositions: book.count,
  };
  const blocks = entryBlocks(state, {
    strategy: intent.strategy,
    mode: intent.mode,
    mint: intent.mint,
    venue: approvedPool.venue,
    creator: intent.creator,
  });
  if (blocks.length > 0 || equityNow === null) {
    return refuse('blocked', blocks);
  }

  // 2. sizing: from the lower of start-of-day and current equity, with every position counted
  const sizingEquity = dayStart > 0n && dayStart < equityNow ? dayStart : equityNow;
  const sol = lamports(walletSol > book.held ? walletSol - book.held : 0n);
  const reserveAfterBuy = feeReserve({ p95ExitCosts: [...book.p95ExitCosts, newP95], wsolHelper }, reserveCaps);
  const onePlannedAttempt = attemptCost(
    { signatures: 1, cuPrice: plan.cuPrice, cuLimit: plan.cuLimit, tip: plan.tip.lamports },
    BASE_FEE_PER_SIGNATURE,
  );
  // Sizing reserves the attempt fees at the plan's own fee fields, every allowed attempt. The re-check
  // caps those fields (CU price, CU limit, tip, landing spend), so this is the cap in disguise; the
  // plan cannot make itself larger by choosing cheaper fees except by the few thousand lamports of
  // difference. Reserving at the hard caps instead is stricter by about 12,000 lamports and is left
  // for the config step (REVIEWS.md K, risk-guardian N4).
  const buyAttemptFees = lamports(BigInt(attemptsAllowed) * onePlannedAttempt);
  const sized = sizeEntry(
    {
      strategy: intent.strategy,
      sizeHint: intent.sizeHint,
      sizingEquity,
      exposure: lamports(book.exposure),
      launchExposure: lamports(book.launchExposure),
      poolRealSolReserve,
      sol,
      reserveAfterBuy,
      rent: rentRequired,
      buyAttemptFees,
      minTrade: poolMinTrade,
      liveRampHalf,
    },
    sizingCaps,
  );
  if (!sized.ok) {
    return refuse('sizing', [`sizing:${sized.reason}`]);
  }

  // 3. the plan re-check, against what this snapshot sized and what the engine knows
  const checked = checkPlan(plan, {
    currentSlot,
    intentId: intent.intentId,
    quote,
    position: { id: intent.positionId, mint: intent.mint, mode: intent.mode, status: 'opening' },
    wallet: wallet as string,
    ownTokenAccount: ownTokenAccount as string,
    wsolMint: wsolMint as string,
    pool: approvedPool,
    ledgerTokens: tokenUnits(0n),
    chainTokens: tokenUnits(0n),
    simulatedCu: simulatedCu as number | null,
    caps: planCaps,
    buy: {
      minInAmount: tradeMinimum(poolMinTrade, sizingCaps),
      sizedInAmount: sized.size,
      sizedAttemptFees: buyAttemptFees,
      rentRequired,
      attemptsAllowed,
      quotedOut: quotedOut as bigint,
      buyOrdersForPosition: 0, // a new position: its one buy order is made in this transaction
    },
    exit: null,
  });
  if (!checked.ok) {
    return refuse('plan', checked.problems.map((problem) => `plan:${problem}`));
  }

  // 4. the hard limits again, from the plan's own numbers: they must agree with 1-3
  const violations = buyLimitViolations({
    plan,
    strategy: intent.strategy,
    activePositions: book.count,
    maxPositions: state.maxPositions,
    sameMintActive: book.mints.has(intent.mint),
    sizingEquity,
    exposure: lamports(book.exposure),
    launchExposure: lamports(book.launchExposure),
    poolRealSolReserve,
    walletSol,
    held: lamports(book.held),
    reserveAfterBuy,
    caps: sizingCaps,
  });
  if (violations.length > 0) {
    throw new RiskError(`the approval would break a hard limit (${violations.join(', ')}): refusing`);
  }

  // 5. the token, last
  const token = issuer.issue(checked.plan, currentSlot);
  return Object.freeze({
    approved: true,
    token,
    plan: checked.plan,
    size: sized.size,
    limitedBy: sized.limitedBy,
    binding: sized.binding,
    opening: Object.freeze({
      id: intent.positionId,
      mint: intent.mint,
      strategy: intent.strategy,
      mode: intent.mode,
      openedAt: now,
      maxSpend: planMaxSpend(checked.plan),
    }),
    entriesToday: state.entriesToday + 1,
  });
}

// ---------------------------------------------------------------- approving an exit

/**
 * The approval of one reduce-only exit (a sell or an account close). Valid exits are always
 * approved (s.9): there is no flag input, so kill, halt, pause, a breaker or a mode cannot stop one.
 * Everything else about it is the plan re-check, which includes the reduce-only rules.
 */
export function approveExit(inputRaw: ExitApprovalInput, issuerRaw: ApprovalIssuer): ExitDecision {
  const issuer = requireIssuer(issuerRaw);
  const { plan: planRaw, context: contextRaw } = object<ExitApprovalInput>('input', inputRaw);
  const plan = validatePlan(planRaw as OrderPlan);
  if (plan.kind !== 'sell' && plan.kind !== 'close-account') {
    return Object.freeze({ approved: false, problems: Object.freeze(['not-an-exit' as const]) });
  }
  const context = { ...object<PlanContext>('context', contextRaw) } as unknown as PlanContext; // read once
  const checked = checkPlan(plan, context);
  if (!checked.ok) {
    return Object.freeze({ approved: false, problems: checked.problems });
  }
  const token = issuer.issue(checked.plan, slot('currentSlot', context.currentSlot));
  return Object.freeze({ approved: true, token, plan: checked.plan });
}
