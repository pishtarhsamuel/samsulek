// Capstone properties of the approval step (TEST_PLAN.md s.4, invariants 2, 3, 4, 17, 18 and 19), the
// piece that composes the entry blocks, sizing, the fee reserve, the plan re-check and the token:
// 1. for random portfolios, flags, wallets, equity, pools and plans (a valid base plus random
//    faults) approveBuy approves exactly when an independent model says so, and says why not;
// 2. every approval, checked with raw arithmetic and none of the parts: position count, one position
//    per mint, the exposure caps with the new position at its worst-case spend, the pool share, the
//    absolute size, and SOL left after the buy at least the fee reserve with every position counted;
// 3. over sequences of approvals, each applied to the snapshot the next one sees (what T1's
//    transaction does), no cap is ever exceeded: positions in flight count (invariant 17);
// 4. a valid reduce-only exit is approved whatever else is going on, a buy never gets a token from
//    approveExit, and every token verifies for exactly its plan.
// The raw checks use the policy's own numbers, so faults that configure every cap far above its hard
// value, 40 positions or 100 entries a day, and live entries (5%, EUR caps, 5 a day) are held to the
// hard and live limits whatever the config says (REVIEWS.md K, N1); sizing sets aside every attempt
// at the hard fee caps, never at the plan's own fees (N4).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { STRATEGY_IDS, type StrategyId } from '../../../src/core/ids.ts';
import { bps, lamports, microLamportsPerCu, type Lamports } from '../../../src/core/units.ts';
import { approveBuy, approveExit, type ActivePosition, type BuyApprovalInput, type BuyDecision, type EntryFlags } from '../../../src/risk/approve.ts';
import { createApprovalAuthority, type ApprovalAuthority } from '../../../src/risk/approval.ts';
import { entryBlocks } from '../../../src/risk/blocks.ts';
import { planMaxSpend, type OrderPlan } from '../../../src/risk/plan.ts';
import { checkPlan } from '../../../src/risk/recheck.ts';
import { feeReserve } from '../../../src/risk/reserve.ts';
import { sizeEntry, tradeMinimum } from '../../../src/risk/sizing.ts';
import { CAPS, RESERVE_CAPS, SIZING_CAPS, WSOL, passingContext } from '../../unit/risk/fixtures.ts';

fc.configureGlobal({ numRuns: 1_000 }); // TEST_PLAN.md s.4 (this file's process only)

const KEY = Uint8Array.from({ length: 32 }, (_v, i) => (i * 5 + 1) % 256);
const NOW = 1_800_000_000_000;
const SLOT = 1_005n;
const L = (n: bigint): Lamports => lamports(n);
const pick = <T>(...values: T[]) => fc.constantFrom(...values);
const PAPER: Readonly<Record<StrategyId, 'paper'>> = { crowdflow: 'paper', momentum: 'paper', launch: 'paper' };

const BASE_PLAN: OrderPlan = {
  orderId: 'order-1',
  intentId: 'intent-1',
  positionId: 'p-new',
  mode: 'paper',
  kind: 'buy',
  urgency: 'normal',
  venue: 'pumpswap',
  route: 'direct',
  mint: 'MintA',
  pool: 'PoolA',
  tokenAccount: 'AtaOfMintA',
  wallet: 'OurWallet',
  inAmount: 55_000_000n,
  expectedOut: 1_000_000_000n,
  minOut: 980_000_000n,
  slippageBps: bps(200),
  feeBps: bps(125),
  feeConfigSlot: 995n,
  cuLimit: 300_000,
  cuPrice: microLamportsPerCu(200_000n),
  tip: { path: 'jito', lamports: lamports(1_000n) },
  rentLamports: lamports(1_488_440n),
  attempts: 3,
  closeAccountAfter: false,
  quoteSlot: 1_000n,
  lastValidBlockHeight: null,
};

const CLEAN_FLAGS: EntryFlags = {
  kill: false,
  haltReasons: [],
  haltClearedAt: null,
  paused: false,
  dailyStop: false,
  entriesStopped: false,
  equityJumpPending: false,
  modes: PAPER,
  breakers: [],
  strategyPausedUntil: {},
  strategyOffUntil: {},
  tokenCooldownUntil: new Map(),
  bannedMints: new Set(),
  blockedCreators: new Set(),
  entriesToday: 0,
  entriesPerDay: 8,
  maxPositions: 4,
};

function baseInput(strategy: StrategyId, sizeHint: 'min' | 'normal', ramp: boolean): BuyApprovalInput {
  return {
    intent: { strategy, mode: 'paper', mint: 'MintA', creator: 'CreatorA', sizeHint, positionId: 'p-new', intentId: 'intent-1' },
    plan: BASE_PLAN,
    world: {
      now: NOW,
      currentSlot: SLOT,
      flags: CLEAN_FLAGS,
      positions: [],
      equity: { current: L(1_000_000_000n), dayStart: L(1_000_000_000n) },
      walletSol: L(1_000_000_000n),
    },
    market: {
      pool: { id: 'PoolA', venue: 'pumpswap', quoteMint: WSOL },
      quote: { slot: 1_000n, feeBps: bps(125), feeConfigSlot: 995n },
      poolRealSolReserve: L(20_000_000_000n),
      poolMinTrade: L(20_000_000n),
      quotedOut: 1_000_000_000n,
      simulatedCu: null,
      attemptsAllowed: 3,
      rentRequired: L(1_488_440n),
      wallet: 'OurWallet',
      ownTokenAccount: 'AtaOfMintA',
      wsolMint: WSOL,
      newPositionP95ExitCost: L(125_000n),
      wsolHelper: false,
      liveRampHalf: ramp,
    },
    caps: { sizing: SIZING_CAPS, reserve: RESERVE_CAPS, plan: CAPS, liveSol: null },
  };
}

/** Every sizing ceiling far above its hard value. */
const LOOSE_SIZING = {
  ...SIZING_CAPS,
  perTradeBps: bps(10_000),
  maxPositionLamports: L(10_000_000_000n),
  exposureBps: bps(10_000),
  maxExposureLamports: L(100_000_000_000n),
  launchShareBps: bps(10_000),
  poolShareBps: bps(10_000),
};
const LIVE_MODES: Readonly<Record<StrategyId, 'live'>> = { crowdflow: 'live', momentum: 'live', launch: 'live' };

/** The case as a live entry: a 0.031-0.05 SOL plan (its landing spend stays under 0.2%), simulated, with or without today's EUR caps. */
function asLive(i: BuyApprovalInput, d: Dials, priced: boolean): BuyApprovalInput {
  return {
    ...i,
    intent: { ...i.intent, mode: 'live' },
    plan: { ...i.plan, mode: 'live', inAmount: BigInt(31 + (d.a % 20)) * 1_000_000n },
    world: { ...i.world, flags: { ...i.world.flags, modes: LIVE_MODES } },
    market: { ...i.market, simulatedCu: 250_000 },
    caps: {
      ...i.caps,
      liveSol: priced ? { positionLamports: L(BigInt(20 + (d.b % 60)) * 1_000_000n), exposureLamports: L(BigInt(60 + (d.a % 240)) * 1_000_000n) } : null,
    },
  };
}

const withFlags = (i: BuyApprovalInput, f: Partial<EntryFlags>): BuyApprovalInput => ({ ...i, world: { ...i.world, flags: { ...i.world.flags, ...f } } });
const withWorld = (i: BuyApprovalInput, w: Partial<Omit<BuyApprovalInput['world'], 'flags'>>): BuyApprovalInput => ({ ...i, world: { ...i.world, ...w } });
const withPlan = (i: BuyApprovalInput, p: Partial<OrderPlan>): BuyApprovalInput => ({ ...i, plan: { ...i.plan, ...p } });
const withMarket = (i: BuyApprovalInput, m: Partial<BuyApprovalInput['market']>): BuyApprovalInput => ({ ...i, market: { ...i.market, ...m } });
const pos = (n: number, status: ActivePosition['status'], value: bigint, strategy: StrategyId, mint = `M${n}`): ActivePosition => {
  const base = { id: `p${n}`, mint, strategy, p95ExitCost: L(125_000n + BigInt(n) * 20_000n) };
  return status === 'opening' ? { ...base, status, maxSpend: L(value) } : { ...base, status, value: L(value) };
};
/** What a position counts for in the exposure caps (an opening one at its worst-case spend) and what it holds back from the wallet. */
const worth = (p: ActivePosition): bigint => (p.status === 'opening' ? p.maxSpend : p.value);

/** Adds positions with ids and mints that cannot repeat, however many faults are stacked. */
const addPositions = (i: BuyApprovalInput, specs: ReadonlyArray<readonly [ActivePosition['status'], bigint, StrategyId]>): BuyApprovalInput => {
  const start = 100 + i.world.positions.length * 10;
  return withWorld(i, { positions: [...i.world.positions, ...specs.map(([status, value, strategy], k) => pos(start + k, status, value, strategy))] });
};

/** Parameters a fault may use, drawn once per case so a failure shrinks to something readable. */
interface Dials {
  readonly a: number; // 0..1000
  readonly b: number; // 0..1000
  readonly status: ActivePosition['status'];
}

const FAULTS: Readonly<Record<string, (i: BuyApprovalInput, d: Dials) => BuyApprovalInput>> = {
  // entry blocks
  kill: (i) => withFlags(i, { kill: true }),
  halt: (i) => withFlags(i, { haltReasons: ['PAPER_LEDGER'] }),
  paused: (i) => withFlags(i, { paused: true }),
  dailyStop: (i) => withFlags(i, { dailyStop: true }),
  entriesStopped: (i) => withFlags(i, { entriesStopped: true }),
  jumpPending: (i) => withFlags(i, { equityJumpPending: true }),
  haltRecovery: (i) => withFlags(i, { haltClearedAt: NOW - 60_000 }),
  modeOff: (i) => withFlags(i, { modes: { ...PAPER, [i.intent.strategy]: 'off' } }),
  breaker: (i) => withFlags(i, { breakers: [{ name: 'RPC_ERRORS', scope: { kind: 'all' }, until: null }] }),
  breakerElsewhere: (i) => withFlags(i, { breakers: [{ name: 'VENUE_CHANGED', scope: { kind: 'venue', venue: 'raydium-cpmm' }, until: null }] }),
  cooldown: (i) => withFlags(i, { strategyPausedUntil: { [i.intent.strategy]: NOW + 1_000 } }),
  tokenCooldown: (i) => withFlags(i, { tokenCooldownUntil: new Map([[i.intent.mint, NOW + 1_000]]) }),
  banned: (i) => withFlags(i, { bannedMints: new Set([i.intent.mint]) }),
  creatorBlocked: (i) => withFlags(i, { blockedCreators: new Set(['CreatorA']) }),
  entriesDone: (i) => withFlags(i, { entriesToday: 8 }),
  equityUnknown: (i) => withWorld(i, { equity: { current: null, dayStart: i.world.equity.dayStart } }),
  // the portfolio
  sameMint: (i, d) =>
    i.world.positions.some((p) => p.mint === i.intent.mint)
      ? i
      : withWorld(i, { positions: [...i.world.positions, { ...pos(100 + i.world.positions.length * 10, d.status, 10_000_000n, 'crowdflow'), mint: i.intent.mint }] }),
  book: (i, d) =>
    addPositions(
      i,
      Array.from({ length: 1 + (d.a % 4) }, (_v, n) => [n % 2 === 0 ? 'open' : d.status, BigInt(5 + (d.b % 60)) * 1_000_000n, STRATEGY_IDS[n % 3]!] as const),
    ),
  heavyBook: (i, d) =>
    addPositions(i, [
      ['open', BigInt(100 + (d.a % 200)) * 1_000_000n, 'crowdflow'],
      ['opening', BigInt(10 + (d.b % 100)) * 1_000_000n, 'launch'],
    ]),
  openingHold: (i, d) => addPositions(i, [['opening', BigInt(20 + (d.a % 80)) * 1_000_000n, 'momentum']]),
  launchHeavy: (i, d) => addPositions(i, [['open', BigInt(30 + (d.a % 60)) * 1_000_000n, 'launch']]),
  // the money
  wallet: (i, d) => withWorld(i, { walletSol: L(BigInt(50 + (d.a % 250)) * 1_000_000n) }),
  walletEdge: (i, d) => withWorld(i, { walletSol: L(BigInt(60 + (d.a % 40)) * 1_000_000n + BigInt(d.b)) }),
  equityDayStart: (i, d) => withWorld(i, { equity: { current: i.world.equity.current, dayStart: L(BigInt(50 + (d.a % 1_500)) * 1_000_000n) } }),
  equityLow: (i, d) => withWorld(i, { equity: { current: L(BigInt(50 + (d.a % 600)) * 1_000_000n), dayStart: i.world.equity.dayStart } }),
  // the pool and the plan
  thinPool: (i, d) => withMarket(i, { poolRealSolReserve: L(BigInt(1 + (d.a % 10)) * 1_000_000_000n) }),
  poolMin: (i, d) => withMarket(i, { poolMinTrade: L(BigInt(10 + (d.a % 80)) * 1_000_000n) }),
  rampHalf: (i) => withMarket(i, { liveRampHalf: true }),
  planAmount: (i, d) => withPlan(i, { inAmount: BigInt(5 + (d.a % 80)) * 1_000_000n + BigInt(d.b) }),
  planBig: (i) => withPlan(i, { inAmount: 70_000_000n }),
  planMinOut: (i) => withPlan(i, { minOut: 1n }),
  planMint: (i) => withPlan(i, { mint: 'MintZ' }),
  planIntent: (i) => withPlan(i, { intentId: 'intent-other' }),
  planFee: (i) => withPlan(i, { feeBps: bps(0) }),
  planQuote: (i) => withPlan(i, { quoteSlot: 999n }),
  planAttempts: (i) => withPlan(i, { attempts: 4 }),
  planRent: (i) => withPlan(i, { rentLamports: L(0n) }),
  planPool: (i) => withPlan(i, { pool: 'PoolB' }),
  planFeesUp: (i) => withPlan(i, { tip: { path: 'helius-swqos', lamports: lamports(5_000n) } }),
  planSell: (i) => withPlan(i, { kind: 'sell' }),
  loosePositionCap: (i, d) => ({ ...i, plan: { ...i.plan, inAmount: BigInt(61 + (d.a % 40)) * 1_000_000n }, caps: { ...i.caps, sizing: { ...i.caps.sizing, maxPositionLamports: L(500_000_000n) } } }),
  // counts configured above the hard values (REVIEWS.md K, N1)
  entriesMany: (i) => withFlags(i, { entriesPerDay: 100, entriesToday: 12 }),
  entriesLoose: (i, d) => withFlags(i, { entriesPerDay: 100, entriesToday: 4 + (d.a % 9) }),
  positionsMany: (i, d) => addPositions(withFlags(i, { maxPositions: 40 }), Array.from({ length: 4 }, (_v, n) => ['open', BigInt(1 + (d.b % 5)) * 1_000_000n, STRATEGY_IDS[n % 3]!] as const)),
};
const FAULT_NAMES = Object.keys(FAULTS);
// Faults that decide at the sizing stage appear three times: the many block faults would otherwise end most cases at the blocks.
const SIZING_FAULTS = ['equityLow', 'poolMin', 'thinPool', 'heavyBook', 'wallet', 'walletEdge', 'equityDayStart', 'book', 'openingHold', 'launchHeavy'];
const WEIGHTED_NAMES = [...FAULT_NAMES, ...SIZING_FAULTS, ...SIZING_FAULTS];

const caseArb = fc
  .record({
    strategy: pick<StrategyId>('crowdflow', 'momentum', 'launch'),
    sizeHint: fc.oneof({ weight: 5, arbitrary: fc.constant<'min' | 'normal'>('normal') }, { weight: 1, arbitrary: fc.constant<'min' | 'normal'>('min') }),
    faults: fc.oneof({ weight: 3, arbitrary: fc.constant<string[]>([]) }, { weight: 7, arbitrary: fc.array(pick(...WEIGHTED_NAMES), { minLength: 1, maxLength: 3 }) }),
    dials: fc.record({ a: fc.integer({ min: 0, max: 1_000 }), b: fc.integer({ min: 0, max: 1_000 }), status: pick<ActivePosition['status']>('opening', 'open', 'exiting', 'stuck') }),
    // a quarter of the cases are live entries, one in ten of those without today's EUR caps
    account: fc.oneof({ weight: 30, arbitrary: fc.constant('paper' as const) }, { weight: 9, arbitrary: fc.constant('live' as const) }, { weight: 1, arbitrary: fc.constant('live-no-price' as const) }),
    // a quarter of the cases run under a config far above every hard value (REVIEWS.md K, N1)
    config: fc.oneof({ weight: 3, arbitrary: fc.constant('policy' as const) }, { weight: 1, arbitrary: fc.constant('loose' as const) }),
  })
  .map((c) => {
    const paper = baseInput(c.strategy, c.sizeHint, false);
    const account = c.account === 'paper' ? paper : asLive(paper, c.dials, c.account === 'live');
    const start = c.config === 'loose' ? withFlags({ ...account, caps: { ...account.caps, sizing: LOOSE_SIZING } }, { maxPositions: 40, entriesPerDay: 100 }) : account;
    return { ...c, input: c.faults.reduce((i, name) => FAULTS[name]!(i, c.dials), start) };
  });

function authority(): ApprovalAuthority {
  let n = 0;
  return createApprovalAuthority({ mode: 'paper', key: KEY, newTokenId: () => `tok-${(n += 1)}`, planFreshSlots: 25 });
}

// ---------------------------------------------------------------- the independent model

interface Verdict {
  readonly approved: boolean;
  readonly stage?: 'blocked' | 'sizing' | 'plan';
  readonly reasons?: readonly string[];
}

/** What the plain rules say, derived with simple loops from the same input, calling the parts only on those derived numbers. */
function model(i: BuyApprovalInput): Verdict {
  const w = i.world;
  let exposure = 0n;
  let launch = 0n;
  let held = 0n;
  const mints = new Set<string>();
  const p95s: Lamports[] = [];
  for (const p of w.positions) {
    exposure += worth(p);
    launch += p.strategy === 'launch' ? worth(p) : 0n;
    held += p.status === 'opening' ? worth(p) : 0n;
    mints.add(p.mint);
    p95s.push(p.p95ExitCost);
  }
  const plan = i.plan;
  if (plan.kind !== 'buy') {
    return { approved: false, stage: 'plan', reasons: ['plan:not-a-buy'] };
  }
  const blocks = entryBlocks(
    { ...w.flags, now: w.now, equityKnown: w.equity.current !== null, activeMints: mints, activePositions: w.positions.length },
    { strategy: i.intent.strategy, mode: i.intent.mode, mint: i.intent.mint, venue: i.market.pool.venue, creator: i.intent.creator },
  );
  if (blocks.length > 0) {
    return { approved: false, stage: 'blocked', reasons: blocks };
  }
  if (i.intent.mode === 'live' && i.caps.liveSol === null) {
    return { approved: false, stage: 'sizing', reasons: ['sizing:no-live-price'] }; // no price today, no live entries
  }
  const current = w.equity.current!;
  const day = w.equity.dayStart;
  const sizingEquity = day === 0n ? current : day < current ? day : current;
  // every allowed attempt at the hard fee caps: 5,000 + 200,000 x 300,000 / 10^6 + the 5,000 tip (N4)
  const fees = BigInt(i.market.attemptsAllowed) * 70_000n;
  const reserve = feeReserve({ p95ExitCosts: [...p95s, i.market.newPositionP95ExitCost], wsolHelper: i.market.wsolHelper }, i.caps.reserve);
  const sized = sizeEntry(
    {
      strategy: i.intent.strategy,
      mode: i.intent.mode,
      liveSol: i.caps.liveSol,
      sizeHint: i.intent.sizeHint,
      sizingEquity,
      exposure: L(exposure),
      launchExposure: L(launch),
      poolRealSolReserve: i.market.poolRealSolReserve,
      sol: L(w.walletSol > held ? w.walletSol - held : 0n),
      reserveAfterBuy: reserve,
      rent: i.market.rentRequired,
      buyAttemptFees: L(fees),
      minTrade: i.market.poolMinTrade,
      liveRampHalf: i.market.liveRampHalf,
    },
    i.caps.sizing,
  );
  if (!sized.ok) {
    return { approved: false, stage: 'sizing', reasons: [`sizing:${sized.reason}`] };
  }
  const problems = checkPlan(plan, {
    ...passingContext(plan),
    currentSlot: w.currentSlot,
    intentId: i.intent.intentId,
    quote: i.market.quote,
    position: { id: i.intent.positionId, mint: i.intent.mint, mode: i.intent.mode, status: 'opening' },
    wallet: i.market.wallet,
    ownTokenAccount: i.market.ownTokenAccount,
    wsolMint: i.market.wsolMint,
    pool: i.market.pool,
    simulatedCu: i.market.simulatedCu,
    caps: i.caps.plan,
    buy: {
      minInAmount: tradeMinimum(i.market.poolMinTrade, i.caps.sizing),
      sizedInAmount: sized.size,
      sizedAttemptFees: L(fees),
      rentRequired: i.market.rentRequired,
      attemptsAllowed: i.market.attemptsAllowed,
      quotedOut: i.market.quotedOut,
      buyOrdersForPosition: 0,
    },
    exit: null,
  });
  return problems.ok ? { approved: true } : { approved: false, stage: 'plan', reasons: problems.problems.map((p) => `plan:${p}`) };
}

function mustApprove(decision: BuyDecision): Extract<BuyDecision, { approved: true }> {
  assert.equal(decision.approved, true);
  if (!decision.approved) {
    throw new Error('unreachable');
  }
  return decision;
}

/** Raw-arithmetic checks of one approval: no sizing, no re-check, no blocks, only the limits of RISK_POLICY.md. */
function assertLimits(i: BuyApprovalInput, d: Extract<BuyDecision, { approved: true }>): void {
  const w = i.world;
  const plan = i.plan;
  const flags = w.flags;
  // blocks (invariant 4): none of these can hold for an approved entry
  assert.equal(flags.kill, false);
  assert.equal(flags.haltReasons.length, 0);
  assert.equal(flags.paused, false);
  assert.equal(flags.dailyStop, false);
  assert.equal(flags.entriesStopped, false);
  assert.equal(flags.equityJumpPending, false);
  assert.notEqual(w.equity.current, null);
  assert.equal(flags.modes[i.intent.strategy], i.intent.mode);
  assert.equal(flags.bannedMints.has(i.intent.mint), false);
  // the limits in force, from the policy's own numbers: hard, and for a live entry LIVE_CAPS and today's EUR caps
  const live = i.intent.mode === 'live' ? i.caps.liveSol : null;
  assert.ok(i.intent.mode === 'paper' || live !== null, 'a live entry only with today\'s EUR caps');
  assert.equal(i.plan.mode, i.intent.mode);
  const perTradeBps = live ? 500n : 1_000n;
  const exposureBps = live ? 2_000n : 5_000n;
  const positionCap = live && live.positionLamports < 60_000_000n ? live.positionLamports : 60_000_000n;
  const exposureCapAbs = live && live.exposureLamports < 300_000_000n ? live.exposureLamports : 300_000_000n;
  assert.ok(flags.entriesToday < Math.min(flags.entriesPerDay, live ? 5 : 12), 'entries per day: 12 at most, live 5');
  assert.equal(d.entriesToday, flags.entriesToday + 1);
  // positions: at most the cap, one per mint (limits 3 and 6)
  assert.ok(w.positions.length + 1 <= Math.min(flags.maxPositions, 4), 'open plus opening positions at most the cap, never above 4');
  assert.equal(w.positions.some((p) => p.mint === i.intent.mint), false, 'one position per mint');
  // the new position at its worst-case spend
  const attempt = 5_000n + (plan.cuPrice * BigInt(plan.cuLimit) + 999_999n) / 1_000_000n + plan.tip.lamports;
  const spend = plan.inAmount + plan.rentLamports + BigInt(plan.attempts) * attempt;
  assert.equal(d.opening.maxSpend, spend);
  assert.equal(d.token.maxSpendLamports, spend);
  assert.equal(d.opening.id, i.intent.positionId);
  assert.equal(d.opening.mint, i.intent.mint);
  assert.equal(d.token.intentId, i.intent.intentId);
  // sizing equity: the lower of start-of-day and current
  const current = w.equity.current!;
  const equity = w.equity.dayStart > 0n && w.equity.dayStart < current ? w.equity.dayStart : current;
  // limits 1 and 2 and the minimum (15)
  assert.ok(plan.inAmount <= (equity * perTradeBps) / 10_000n, 'at most 10% (live 5%) of the lower equity');
  assert.ok(plan.inAmount <= positionCap, 'at most 0.06 SOL (live: and EUR 5)');
  assert.ok(plan.inAmount >= 20_000_000n && plan.inAmount >= i.market.poolMinTrade, 'at least the minimum trade');
  // limits 4 and 5: exposure with every position counted, the new one at its worst case
  let exposure = 0n;
  let launch = 0n;
  let held = 0n;
  for (const p of w.positions) {
    exposure += worth(p);
    launch += i.intent.strategy === 'launch' && p.strategy === 'launch' ? worth(p) : 0n;
    held += p.status === 'opening' ? worth(p) : 0n;
  }
  assert.ok(exposure + spend <= (equity * exposureBps) / 10_000n, 'total exposure at most 50% (live 20%) of equity');
  assert.ok(exposure + spend <= exposureCapAbs, 'total exposure at most 0.30 SOL (live: and EUR 10)');
  // limit 7: pool share, and limit 8: the launch strategy's share of the exposure cap
  assert.ok(plan.inAmount <= (2n * i.market.poolRealSolReserve * 50n) / 10_000n, 'at most 0.5% of pool liquidity');
  if (i.intent.strategy === 'launch') {
    const percent = (equity * exposureBps) / 10_000n;
    const cap = percent < exposureCapAbs ? percent : exposureCapAbs;
    assert.ok(launch + spend <= (cap * 2_500n) / 10_000n, 'launch positions at most 25% of the exposure cap');
  }
  // invariant 3: SOL left after the buy (the wallet minus what buys in flight still hold minus this one's worst case) covers the reserve with the new position counted
  const reserve = feeReserve({ p95ExitCosts: [...w.positions.map((p) => p.p95ExitCost), i.market.newPositionP95ExitCost], wsolHelper: i.market.wsolHelper }, i.caps.reserve);
  assert.ok(w.walletSol >= held + spend + reserve, 'SOL after the buy covers the fee reserve');
}

describe('approval step properties', () => {
  it('approveBuy approves if and only if the independent model does, and says why not (many of each stage)', () => {
    const stages: Record<string, number> = { approved: 0, blocked: 0, sizing: 0, plan: 0 };
    const refusedBy: Record<string, number> = {};
    let liveApproved = 0;
    let looseApproved = 0;
    fc.assert(
      fc.property(caseArb, ({ input, faults, config }) => {
        const expected = model(input);
        const mode = input.intent.mode;
        const { a, minted } = (() => {
          let n = 0;
          const auth = createApprovalAuthority({ mode, key: KEY, newTokenId: () => `tok-${(n += 1)}`, planFreshSlots: 25 });
          return { a: auth, minted: () => n };
        })();
        const decision = approveBuy(input, a.issuer);
        assert.equal(decision.approved, expected.approved, faults.join('+'));
        if (decision.approved) {
          stages['approved'] = (stages['approved'] ?? 0) + 1;
          liveApproved += mode === 'live' ? 1 : 0;
          looseApproved += config === 'loose' ? 1 : 0;
          assert.equal(minted(), 1);
          assertLimits(input, decision);
          assert.deepEqual(a.verifier.verify(decision.token, decision.plan, { currentSlot: SLOT, mode }), []);
        } else {
          assert.equal(minted(), 0, 'a refusal never mints a token');
          assert.equal(decision.stage, expected.stage, faults.join('+'));
          assert.deepEqual(decision.reasons, expected.reasons, faults.join('+'));
          stages[decision.stage] = (stages[decision.stage] ?? 0) + 1;
          for (const f of faults) {
            refusedBy[f] = (refusedBy[f] ?? 0) + 1;
          }
        }
      }),
    );
    for (const stage of ['approved', 'blocked', 'sizing', 'plan']) {
      assert.ok((stages[stage] ?? 0) >= 50, `only ${stages[stage] ?? 0} cases ended at ${stage}: ${JSON.stringify(stages)}`);
    }
    assert.ok(liveApproved >= 10, `only ${liveApproved} live entries were approved`);
    assert.ok(looseApproved >= 10, `only ${looseApproved} entries under a loose config were approved`);
    assert.deepEqual(
      FAULT_NAMES.filter(
        (name) =>
          (refusedBy[name] ?? 0) === 0 &&
          !['breakerElsewhere', 'planAmount', 'wallet', 'walletEdge', 'equityDayStart', 'equityLow', 'thinPool', 'poolMin', 'rampHalf', 'book', 'openingHold', 'launchHeavy', 'entriesLoose'].includes(name),
      ),
      [],
      'faults that never caused a refusal',
    );
  });

  it('sequences of approvals, each seen by the next as T1 would see it, never exceed a cap (invariants 3 and 17)', () => {
    let approvals = 0;
    let fullBooks = 0;
    fc.assert(
      fc.property(
        fc.record({
          strategies: fc.array(pick<StrategyId>('crowdflow', 'momentum', 'launch'), { minLength: 2, maxLength: 7 }),
          amounts: fc.array(fc.integer({ min: 20, max: 60 }), { minLength: 7, maxLength: 7 }),
          wallet: fc.integer({ min: 100, max: 1_000 }),
          equity: fc.integer({ min: 300, max: 1_500 }),
        }),
        (r) => {
          const a = authority();
          let input = withWorld(baseInput('crowdflow', 'normal', false), {
            walletSol: L(BigInt(r.wallet) * 1_000_000n),
            equity: { current: L(BigInt(r.equity) * 1_000_000n), dayStart: L(BigInt(r.equity) * 1_000_000n) },
          });
          r.strategies.forEach((strategy, n) => {
            const mint = `Mint${n}`;
            const amount = BigInt(r.amounts[n]!) * 1_000_000n;
            const candidate: BuyApprovalInput = {
              ...input,
              intent: { ...input.intent, strategy, mint, positionId: `pos-${n}`, intentId: `intent-${n}` },
              plan: { ...input.plan, intentId: `intent-${n}`, positionId: `pos-${n}`, orderId: `order-${n}`, mint, inAmount: amount, cuLimit: 100_000 },
              market: { ...input.market, ownTokenAccount: `Ata${n}` },
            };
            const planned = { ...candidate, plan: { ...candidate.plan, tokenAccount: `Ata${n}` } };
            const decision = approveBuy(planned, a.issuer);
            if (!decision.approved) {
              return;
            }
            approvals += 1;
            assertLimits(planned, decision);
            // what T1 writes in the same transaction: the opening position at its worst-case spend and the day's count
            input = {
              ...planned,
              world: {
                ...planned.world,
                flags: { ...planned.world.flags, entriesToday: decision.entriesToday },
                positions: [...planned.world.positions, { id: `pos-${n}`, mint, strategy, status: 'opening', maxSpend: decision.opening.maxSpend, p95ExitCost: planned.market.newPositionP95ExitCost }],
              },
            };
            // after every approval, with all the positions in flight counted: the caps and the reserve still hold
            const book = input.world.positions;
            const exposure = book.reduce((sum, p) => sum + worth(p), 0n);
            const equity = r.equity * 1_000_000;
            assert.ok(book.length <= 4, 'at most four positions');
            assert.equal(new Set(book.map((p) => p.mint)).size, book.length, 'one position per mint');
            assert.ok(exposure <= 300_000_000n && exposure * 2n <= BigInt(equity), 'exposure caps with positions in flight counted');
            const held = book.reduce((sum, p) => sum + (p.status === 'opening' ? worth(p) : 0n), 0n);
            const reserve = feeReserve({ p95ExitCosts: book.map((p) => p.p95ExitCost), wsolHelper: false }, RESERVE_CAPS);
            assert.ok(input.world.walletSol >= held + reserve, 'the SOL still free covers the fee reserve');
            fullBooks += book.length === 4 ? 1 : 0;
          });
        },
      ),
    );
    assert.ok(approvals >= 300, `only ${approvals} approvals in the sequences`);
    assert.ok(fullBooks >= 20, `only ${fullBooks} sequences reached the position cap`);
  });

  it('approveExit approves a valid sell or close whatever else is going on, and a token verifies for exactly its plan', () => {
    const exits = fc.record({
      kind: pick<'sell' | 'close-account'>('sell', 'close-account'),
      urgency: pick<'normal' | 'protective' | 'emergency'>('normal', 'protective', 'emergency'),
      amount: fc.integer({ min: 1, max: 900_000 }),
      salt: fc.integer({ min: 0, max: 1_000 }),
      faulty: fc.oneof({ weight: 3, arbitrary: fc.constant(false) }, { weight: 2, arbitrary: fc.constant(true) }),
    });
    let approved = 0;
    let refused = 0;
    fc.assert(
      fc.property(exits, (e) => {
        const close = e.kind === 'close-account';
        const plan: OrderPlan = {
          ...BASE_PLAN,
          orderId: `order-${e.salt}`,
          intentId: `intent-${e.salt}`,
          kind: e.kind,
          urgency: e.urgency,
          inAmount: close ? 0n : BigInt(e.amount),
          expectedOut: close ? 0n : 15_000_000n,
          minOut: close ? 0n : 14_550_000n,
          slippageBps: bps(close ? 0 : 300),
          feeBps: bps(close ? 0 : 125),
          rentLamports: L(0n),
          ...(close ? { cuLimit: 20_000, cuPrice: microLamportsPerCu(0n), tip: { path: 'none' as const, lamports: lamports(0n) }, attempts: 1 } : {}),
        };
        const context = passingContext(plan);
        const input = { plan: e.faulty ? { ...plan, wallet: 'Someone' } : plan, context };
        const a = authority();
        const decision = approveExit(input, a.issuer);
        if (decision.approved) {
          approved += 1;
          assert.equal(e.faulty, false);
          assert.equal(decision.token.reduceOnly, true);
          assert.equal(decision.token.kind, e.kind);
          assert.deepEqual(a.verifier.verify(decision.token, plan, { currentSlot: context.currentSlot, mode: 'paper' }), []);
          // the token is for exactly this plan: any other plan is refused
          assert.notDeepEqual(a.verifier.verify(decision.token, { ...plan, inAmount: plan.inAmount + 1n }, { currentSlot: context.currentSlot, mode: 'paper' }), []);
          assert.equal(planMaxSpend(plan), decision.token.maxSpendLamports);
        } else {
          refused += 1;
          assert.ok(decision.problems.length > 0);
        }
      }),
    );
    assert.ok(approved >= 100 && refused >= 100, `approved ${approved}, refused ${refused}`);
  });

  it('approveExit never issues a token for a buy or a withdraw, however it is dressed', () => {
    fc.assert(
      fc.property(pick<'buy' | 'withdraw'>('buy', 'withdraw'), fc.integer({ min: 0, max: 100 }), (kind, salt) => {
        const plan: OrderPlan = { ...BASE_PLAN, kind, orderId: `order-${salt}`, positionId: 'p1' };
        const a = authority();
        const decision = approveExit({ plan, context: passingContext(plan) }, a.issuer);
        assert.deepEqual(decision, { approved: false, problems: ['not-an-exit'] });
      }),
      { numRuns: 100 },
    );
  });
});
