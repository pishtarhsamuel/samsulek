// The plan re-check (RISK_POLICY.md s.6 step 5; limits 16-20; REVIEWS.md entries G and H): before a
// plan gets an approval token, risk re-derives everything that could hurt from the plan's own
// fields and the engine's context, never trusting the planner: the approved pool, minOut against
// risk's OWN quote, the CU and tip caps, the landing-spend cap (urgency from the exit intent), the
// attempts and worst-case fees, rent, mode and ownership, fresh inputs, the exit rules (run on the
// same snapshot) and the rules for closing the account. Only a plan that passes becomes a
// CheckedPlan. TEST_PLAN.md s.3 step 4. Written before the implementation.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bps, lamports, microLamportsPerCu, tokenUnits } from '../../../src/core/units.ts';
import { type OrderPlan } from '../../../src/risk/plan.ts';
import {
  checkPlan,
  isCheckedPlan,
  planProblems,
  type BuyPlanContext,
  type ExitPlanContext,
  type PlanCaps,
  type PlanContext,
} from '../../../src/risk/recheck.ts';
import { RiskError } from '../../../src/risk/reserve.ts';
import { CAPS, FREE_FEES, WSOL } from './fixtures.ts';

// One attempt: 5,000 base + 150,000 x 200,000 / 10^6 = 30,000 priority + 1,000 tip = 36,000; three
// attempts 108,000. Landing spend (priority + tip) per attempt: 31,000.
const BUY: OrderPlan = {
  orderId: 'order-1',
  intentId: 'intent-1',
  positionId: 'p1',
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
  minOut: 980_000_000n, // floor(1,000,000,000 x 9,800 / 10,000) at 2%
  slippageBps: bps(200),
  feeBps: bps(125),
  feeConfigSlot: 995n,
  cuLimit: 200_000,
  cuPrice: microLamportsPerCu(150_000n),
  tip: { path: 'jito', lamports: lamports(1_000n) },
  rentLamports: lamports(1_488_440n),
  attempts: 3,
  closeAccountAfter: false,
  quoteSlot: 990n,
  lastValidBlockHeight: null,
};

const SELL: OrderPlan = {
  ...BUY,
  kind: 'sell',
  inAmount: 400_000n, // token units
  expectedOut: 15_000_000n,
  minOut: 14_550_000n, // floor(15,000,000 x 9,700 / 10,000) at 3%
  slippageBps: bps(300),
  rentLamports: lamports(0n),
};

// A standalone close has no swap and, to pass the 0.6% landing cap on a rent-sized base, no priority fee.
const CLOSE: OrderPlan = {
  ...SELL,
  kind: 'close-account',
  inAmount: 0n,
  expectedOut: 0n,
  minOut: 0n,
  slippageBps: bps(0),
  feeBps: bps(0),
  ...FREE_FEES,
  attempts: 1,
};

const BUY_CTX: PlanContext = {
  currentSlot: 1_000n,
  position: { id: 'p1', mint: 'MintA', mode: 'paper', status: 'opening' },
  wallet: 'OurWallet',
  ownTokenAccount: 'AtaOfMintA',
  wsolMint: WSOL,
  pool: { id: 'PoolA', venue: 'pumpswap', quoteMint: WSOL },
  ledgerTokens: tokenUnits(0n),
  chainTokens: tokenUnits(0n),
  simulatedCu: 180_000, // 1.2 x = 216,000
  caps: CAPS,
  buy: {
    minInAmount: lamports(20_000_000n),
    sizedInAmount: lamports(55_000_000n),
    sizedAttemptFees: lamports(108_000n),
    rentRequired: lamports(1_488_440n),
    attemptsAllowed: 3,
    quotedOut: 1_000_000_000n,
  },
  exit: null,
};

const AUTOMATIC = { kind: 'automatic', budgetLeft: lamports(1_000_000n), automaticStopped: false, sellSimPassed: true } as const;

const SELL_CTX: PlanContext = {
  ...BUY_CTX,
  position: { id: 'p1', mint: 'MintA', mode: 'paper', status: 'open' },
  ledgerTokens: tokenUnits(1_000_000n),
  chainTokens: tokenUnits(1_000_000n),
  buy: null,
  exit: {
    attemptsAllowed: 3,
    urgency: 'normal',
    costBasis: lamports(55_000_000n),
    quotedOut: lamports(15_000_000n),
    inFlightSellTokens: tokenUnits(0n),
    inFlightExits: 0,
    origin: AUTOMATIC,
  },
};

const CLOSE_CTX: PlanContext = {
  ...SELL_CTX,
  position: { id: 'p1', mint: 'MintA', mode: 'paper', status: 'exiting' },
  ledgerTokens: tokenUnits(0n),
  chainTokens: tokenUnits(0n),
  exit: { ...SELL_CTX.exit!, costBasis: lamports(1_488_440n), quotedOut: lamports(0n) },
};

const buy = (plan: Partial<OrderPlan> = {}, ctx: Partial<PlanContext> = {}) => planProblems({ ...BUY, ...plan }, { ...BUY_CTX, ...ctx });
const sell = (plan: Partial<OrderPlan> = {}, ctx: Partial<PlanContext> = {}) => planProblems({ ...SELL, ...plan }, { ...SELL_CTX, ...ctx });
const close = (plan: Partial<OrderPlan> = {}, ctx: Partial<PlanContext> = {}) => planProblems({ ...CLOSE, ...plan }, { ...CLOSE_CTX, ...ctx });
const buyCtx = (patch: Partial<BuyPlanContext>) => ({ buy: { ...BUY_CTX.buy!, ...patch } });
const exitCtx = (base: PlanContext) => (patch: Partial<ExitPlanContext>) => ({ exit: { ...base.exit!, ...patch } });
const sellExit = exitCtx(SELL_CTX);
const closeExit = exitCtx(CLOSE_CTX);
const tip = (path: OrderPlan['tip']['path'], amount: bigint): Partial<OrderPlan> => ({ tip: { path, lamports: lamports(amount) } });
// Sizing reserved plenty for fees: lets a test change one fee input without also tripping 'fees-above-sized'.
const ROOMY = buyCtx({ sizedAttemptFees: lamports(1_000_000n) });

describe('a valid plan passes', () => {
  it('a buy, a sell and a close', () => {
    assert.deepEqual(buy(), []);
    assert.deepEqual(sell(), []);
    assert.deepEqual(close(), []);
  });

  it('a withdraw never goes through this check (its own path, RISK_POLICY s.14)', () => {
    assert.deepEqual(buy({ kind: 'withdraw' }), ['kind-not-allowed']);
  });
});

describe('only a plan that passed becomes a CheckedPlan', () => {
  it('checkPlan returns a frozen snapshot that isCheckedPlan recognizes, and nothing else is checked', () => {
    const result = checkPlan(BUY, BUY_CTX);
    assert.ok(result.ok);
    assert.ok(isCheckedPlan(result.plan) && Object.isFrozen(result.plan));
    assert.deepEqual({ ...result.plan }, { ...BUY });
    assert.equal(isCheckedPlan(BUY), false);
    assert.equal(isCheckedPlan({ ...result.plan }), false, 'a copy is not the checked snapshot');
    assert.equal(isCheckedPlan(null), false);
    assert.equal(isCheckedPlan('plan'), false);
  });

  it('a refused plan gets its problems and no snapshot', () => {
    const result = checkPlan({ ...BUY, minOut: 0n }, BUY_CTX);
    assert.equal(result.ok, false);
    assert.deepEqual(!result.ok && result.problems, ['min-out-below-slippage']);
  });

  it('the snapshot cannot be changed through the caller\'s object afterwards', () => {
    const mine = { ...BUY };
    const result = checkPlan(mine, BUY_CTX);
    (mine as { wallet: string }).wallet = 'Attacker';
    assert.ok(result.ok && result.plan.wallet === 'OurWallet');
  });
});

describe('the pool and venue are the approved ones, never the planner\'s (REVIEWS.md H, M4)', () => {
  it('a plan naming another pool or venue for the same mint is refused', () => {
    assert.deepEqual(buy({ pool: 'AttackerPool' }), ['wrong-pool']);
    assert.deepEqual(buy({ venue: 'pump-curve' }), ['wrong-venue']);
    assert.deepEqual(sell({ pool: 'AttackerPool' }), ['wrong-pool']);
  });

  it('only SOL-quoted pools', () => {
    const other = { pool: { ...BUY_CTX.pool, quoteMint: 'UsdcMint' } };
    assert.deepEqual(buy({}, other), ['pool-not-sol']);
    assert.deepEqual(sell({}, { pool: other.pool }), ['pool-not-sol', 'not-into-sol']); // the exit check agrees
  });
});

describe('minOut against risk\'s own quote (limits 16 and 17; REVIEWS.md G, HIGH-2)', () => {
  it('a plan cannot declare 2% and accept anything: minOut must be at least the floor of the quote', () => {
    assert.deepEqual(buy({ minOut: 979_999_999n }), ['min-out-below-slippage']);
    assert.deepEqual(buy({ minOut: 0n }), ['min-out-below-slippage']);
    assert.deepEqual(buy({ minOut: 980_000_000n }), []);
    assert.deepEqual(buy({ minOut: 990_000_000n }), []); // tighter than declared is fine
    assert.deepEqual(sell({ minOut: 14_549_999n }), ['min-out-below-slippage']);
  });

  it('a planner that understates expectedOut cannot buy itself a low minOut', () => {
    // true quote 1,000,000,000; the plan claims 500,000,000 and a 2% minOut of 490,000,000: about 51% real slippage
    assert.deepEqual(buy({ expectedOut: 500_000_000n, minOut: 490_000_000n }), ['min-out-below-slippage']);
  });

  it('a plan cannot promise more than risk\'s own quote', () => {
    assert.deepEqual(buy({ expectedOut: 1_000_000_001n, minOut: 980_000_001n }), ['expected-out-above-quote']);
    assert.deepEqual(buy({}, buyCtx({ quotedOut: 900_000_000n })), ['expected-out-above-quote']);
    assert.deepEqual(buy({ expectedOut: 900_000_000n, minOut: 882_000_000n }, buyCtx({ quotedOut: 900_000_000n })), []);
  });

  it('minOut above the expected output could never fill', () => {
    assert.deepEqual(buy({ minOut: 1_000_000_001n }), ['min-out-above-expected']);
    assert.deepEqual(buy({ minOut: 1_000_000_000n }), []);
  });

  it('a buy needs an expected output; claiming none while risk\'s own quote is real also hides the price', () => {
    assert.deepEqual(buy({ expectedOut: 0n, minOut: 0n }, buyCtx({ quotedOut: 0n })), ['no-expected-output']);
    assert.deepEqual(buy({ expectedOut: 0n, minOut: 0n }), ['no-expected-output', 'min-out-below-slippage']);
  });

  it('buy slippage at most 3% (H); an exit\'s slippage is judged by the exit check', () => {
    assert.deepEqual(buy({ slippageBps: bps(300), minOut: 970_000_000n }), []);
    assert.deepEqual(buy({ slippageBps: bps(301), minOut: 969_900_000n }), ['slippage-above-cap']);
    assert.deepEqual(sell({ slippageBps: bps(301), minOut: 14_548_500n }), ['slippage-above-cap']);
    assert.deepEqual(sell({ slippageBps: bps(900), minOut: 13_650_000n, urgency: 'protective' }, sellExit({ urgency: 'protective' })), []);
  });
});

describe('fee caps (limit 18) and tips (limit 19)', () => {
  it('CU limit at most 300,000 and at most 1.2 x the simulated units', () => {
    assert.deepEqual(buy({ cuLimit: 216_000 }, ROOMY), []);
    assert.deepEqual(buy({ cuLimit: 216_001 }, ROOMY), ['cu-limit-above-simulated']);
    assert.deepEqual(buy({ cuLimit: 300_001 }, { ...ROOMY, simulatedCu: null }), ['cu-limit-above-cap']);
    assert.deepEqual(buy({ cuLimit: 300_000 }, { ...ROOMY, simulatedCu: null }), []);
    assert.deepEqual(buy({ cuLimit: 300_001 }, ROOMY), ['cu-limit-above-cap', 'cu-limit-above-simulated']);
  });

  it('a live plan needs a simulation: without one the CU check would be skipped (REVIEWS.md G)', () => {
    const live = { position: { ...BUY_CTX.position, mode: 'live' as const }, simulatedCu: null };
    assert.deepEqual(buy({ mode: 'live' }, live), ['cu-not-simulated']);
    assert.deepEqual(buy({ mode: 'live' }, { ...live, simulatedCu: 180_000 }), []);
  });

  it('CU price at most 200,000 for a buy and 400,000 for an exit', () => {
    const cheapLimit = { cuLimit: 100_000 }; // keeps the landing spend inside its cap
    assert.deepEqual(buy({ ...cheapLimit, cuPrice: microLamportsPerCu(200_000n) }), []);
    assert.deepEqual(buy({ ...cheapLimit, cuPrice: microLamportsPerCu(200_001n) }), ['cu-price-above-cap']);
    assert.deepEqual(sell({ ...cheapLimit, cuPrice: microLamportsPerCu(400_000n) }), []);
    assert.deepEqual(sell({ ...cheapLimit, cuPrice: microLamportsPerCu(400_001n) }), ['cu-price-above-cap']);
    assert.deepEqual(close({ cuLimit: 20_000, cuPrice: microLamportsPerCu(400_001n) }, closeExit({ costBasis: lamports(50_000_000n) })), ['cu-price-above-cap']);
  });

  it('tips only as 0 (none), 1,000 (Jito) or 5,000 (Helius SWQOS-only), never anything else', () => {
    assert.deepEqual(buy(tip('none', 0n), ROOMY), []);
    assert.deepEqual(buy(tip('jito', 1_000n), ROOMY), []);
    assert.deepEqual(buy(tip('helius-swqos', 5_000n), ROOMY), []);
    for (const [path, amount] of [['none', 1n], ['jito', 0n], ['jito', 1_001n], ['jito', 999n], ['helius-swqos', 1_000n], ['helius-swqos', 5_001n]] as const) {
      assert.deepEqual(buy(tip(path, amount), ROOMY), ['tip-not-allowed'], `${path} ${amount}`);
    }
    // a huge tip is also a landing-spend and a fee problem (0.001 SOL services are never allowed)
    assert.deepEqual(buy(tip('jito', 1_000_000n), ROOMY), ['tip-not-allowed', 'landing-spend-above-cap', 'fees-above-sized']);
  });

  it('landing spend (priority + tip) at most 0.2% of the swap for a buy, exact to the lamport', () => {
    // 31,000 per attempt: the cap is exactly 31,000 at an input of 15,500,000 and 30,999 one lamport below.
    assert.deepEqual(buy({ inAmount: 15_500_000n }, buyCtx({ sizedInAmount: lamports(15_500_000n), minInAmount: lamports(10_000_000n) })), []);
    assert.deepEqual(buy({ inAmount: 15_499_999n }, buyCtx({ sizedInAmount: lamports(15_499_999n), minInAmount: lamports(10_000_000n) })), ['landing-spend-above-cap']);
  });

  // A small sale: the plan expects 5,166,666 and keeps its 3% floor (5,011,666) against that quote.
  const small = { expectedOut: 5_166_666n, minOut: 5_011_666n };

  it('an exit: 0.6% of the larger of risk\'s quote and the cost basis, for normal urgency', () => {
    // 5,166,667 x 0.6% = 31,000 (passes); 5,166,666 gives 30,999 (refused)
    const sale = (quoted: bigint, basis: bigint) => sellExit({ quotedOut: lamports(quoted), costBasis: lamports(basis) });
    assert.deepEqual(sell(small, sale(5_166_666n, 1n)), ['landing-spend-above-cap']);
    assert.deepEqual(sell(small, sale(5_166_667n, 1n)), []);
    // a collapsed price cannot make the cap forbid every priority fee: the cost basis counts too
    assert.deepEqual(sell(small, sale(5_166_666n, 5_166_667n)), []);
  });

  it('a protective or emergency exit keeps only the absolute caps, by the INTENT\'s urgency', () => {
    const tight = { quotedOut: lamports(5_166_666n), costBasis: lamports(1n) };
    assert.deepEqual(sell({ ...small, urgency: 'protective' }, sellExit({ ...tight, urgency: 'protective' })), []);
    assert.deepEqual(sell({ ...small, urgency: 'emergency' }, sellExit({ ...tight, urgency: 'emergency' })), []);
    assert.deepEqual(
      sell({ ...small, urgency: 'emergency', cuPrice: microLamportsPerCu(400_001n) }, sellExit({ ...tight, urgency: 'emergency' })),
      ['cu-price-above-cap'],
    );
  });

  it('the plan cannot upgrade itself: a normal exit labelled emergency keeps the landing cap and is refused (HIGH-1)', () => {
    const tight = sellExit({ quotedOut: lamports(5_166_666n), costBasis: lamports(1n), urgency: 'normal' });
    assert.deepEqual(sell({ ...small, urgency: 'emergency' }, tight), ['wrong-urgency', 'landing-spend-above-cap']);
    assert.deepEqual(sell({ urgency: 'protective' }), ['wrong-urgency']);
  });

  it('a buy is always normal', () => {
    assert.deepEqual(buy({ urgency: 'emergency' }), ['urgency-on-buy']);
    assert.deepEqual(buy({ urgency: 'protective' }), ['urgency-on-buy']);
  });
});

describe('attempts, worst-case spend and rent', () => {
  it('attempts at most what the engine allows', () => {
    assert.deepEqual(buy({ attempts: 4 }), ['attempts-above-allowed', 'fees-above-sized']);
    assert.deepEqual(sell({ attempts: 4 }), ['attempts-above-allowed']);
    assert.deepEqual(sell({ attempts: 2 }), []);
  });

  it('a buy\'s fees are at most what sizing reserved for them', () => {
    assert.deepEqual(buy({}, buyCtx({ sizedAttemptFees: lamports(108_000n) })), []);
    assert.deepEqual(buy({}, buyCtx({ sizedAttemptFees: lamports(107_999n) })), ['fees-above-sized']);
  });

  it('a buy\'s input between the minimum trade and the sized amount', () => {
    assert.deepEqual(buy({ inAmount: 55_000_001n }), ['in-amount-above-sized']);
    assert.deepEqual(buy({ inAmount: 54_999_999n }), []);
    assert.deepEqual(buy({ inAmount: 20_000_000n }), []);
    assert.deepEqual(buy({ inAmount: 19_999_999n }), ['in-amount-below-minimum']);
  });

  it('rent exactly as required for a buy (0 if the account exists) and 0 for every exit', () => {
    assert.deepEqual(buy({ rentLamports: lamports(1_488_441n) }), ['rent-mismatch']);
    assert.deepEqual(buy({ rentLamports: lamports(1_488_439n) }), ['rent-mismatch']);
    assert.deepEqual(buy({ rentLamports: lamports(0n) }, buyCtx({ rentRequired: lamports(0n) })), []);
    assert.deepEqual(sell({ rentLamports: lamports(1n) }), ['rent-mismatch']);
    assert.deepEqual(close({ rentLamports: lamports(1n) }), ['rent-mismatch']);
  });
});

describe('who ordered the exit: owner or automatic (s.3a; REVIEWS.md G)', () => {
  const origin = (left: bigint, stopped = false, simPassed = true) =>
    sellExit({ origin: { kind: 'automatic', budgetLeft: lamports(left), automaticStopped: stopped, sellSimPassed: simPassed } });

  it('an automatic exit stays within the failed-fee budget left (3 x 36,000 = 108,000)', () => {
    assert.deepEqual(sell({}, origin(108_000n)), []);
    assert.deepEqual(sell({}, origin(107_999n)), ['exit-fee-budget']);
  });

  it('automatic exits stop after 2 days without a successful exit, and need a passing sell simulation', () => {
    assert.deepEqual(sell({}, origin(1_000_000n, true)), ['auto-exits-stopped']);
    assert.deepEqual(sell({}, origin(1_000_000n, false, false)), ['sell-sim-not-passed']);
    assert.deepEqual(close({}, closeExit({ origin: { kind: 'automatic', budgetLeft: lamports(5_000n), automaticStopped: false, sellSimPassed: false } })), []); // a close has no sell to simulate
  });

  it('an owner-ordered exit (an authenticated /panic or /sell) is not budget-limited', () => {
    const owner = sellExit({ origin: { kind: 'owner' } });
    assert.deepEqual(sell({ attempts: 3 }, owner), []);
    const worthless = { quotedOut: lamports(0n) }; // the pool is empty: risk's own quote is 0 too
    assert.deepEqual(sell({ expectedOut: 0n, minOut: 0n }, sellExit({ origin: { kind: 'owner' }, ...worthless })), []); // the owner may dump a worthless token
  });

  it('an automatic sell that expects nothing only burns fees', () => {
    assert.deepEqual(sell({ expectedOut: 0n, minOut: 0n }, sellExit({ quotedOut: lamports(0n) })), ['worthless-exit']);
  });
});

describe('closing the account', () => {
  it('only a sell of the whole holding, the same in the ledger and on chain, may close it in the same transaction', () => {
    assert.deepEqual(sell({ closeAccountAfter: true, inAmount: 1_000_000n }), []);
    assert.deepEqual(sell({ closeAccountAfter: true, inAmount: 999_999n }), ['close-after-partial']);
    // an unsolicited deposit makes the chain hold more than the ledger: the close would fail on chain
    assert.deepEqual(sell({ closeAccountAfter: true, inAmount: 1_000_000n }, { chainTokens: tokenUnits(1_000_001n) }), ['close-after-partial']);
    assert.deepEqual(buy({ closeAccountAfter: true }), ['close-after-buy']);
    assert.deepEqual(close({ closeAccountAfter: true }), ['close-after-close']);
  });

  it('a standalone close has no swap at all', () => {
    assert.deepEqual(close({ inAmount: 1n }), ['close-with-swap', 'close-with-amount']); // the exit check agrees
    assert.deepEqual(close({ expectedOut: 1n }), ['close-with-swap']);
    assert.deepEqual(close({ minOut: 1n, expectedOut: 1n }), ['close-with-swap']);
  });
});

describe('ownership, position state, mode, route and fresh inputs', () => {
  it('a buy belongs to the position, our wallet and our own token account, which must still be opening', () => {
    assert.deepEqual(buy({ positionId: 'p2' }), ['wrong-position']);
    assert.deepEqual(buy({ mint: 'MintB' }), ['wrong-mint']);
    assert.deepEqual(buy({ wallet: 'Attacker' }), ['foreign-wallet']);
    assert.deepEqual(buy({ tokenAccount: 'AtaOther' }), ['foreign-token-account']);
    assert.deepEqual(buy({}, { position: { ...BUY_CTX.position, status: 'open' } }), ['position-not-opening']); // no adding to a position
  });

  it('an exit is judged by the reduce-only rules, on the same snapshot: own account, own wallet, own token', () => {
    assert.deepEqual(sell({ wallet: 'OurWa11et' }), ['foreign-destination']); // a look-alike is a stranger
    assert.deepEqual(sell({ tokenAccount: 'AtaOther' }), ['foreign-account']);
    assert.deepEqual(sell({ mint: 'MintB' }), ['wrong-mint']);
    assert.deepEqual(sell({ positionId: 'p2' }), ['wrong-position']);
    assert.deepEqual(sell({}, { position: { ...SELL_CTX.position, status: 'opening' } }), ['nothing-to-sell']);
    assert.deepEqual(close({}, { position: { ...CLOSE_CTX.position, status: 'open' } }), ['nothing-to-close']);
  });

  it('a sell cannot exceed the sellable amount or run beside another exit', () => {
    assert.deepEqual(sell({ inAmount: 1_000_001n }), ['above-sellable']);
    assert.deepEqual(sell({}, sellExit({ inFlightSellTokens: tokenUnits(700_000n) })), ['above-sellable']);
    assert.deepEqual(sell({}, sellExit({ inFlightExits: 1 })), ['exit-in-flight']);
  });

  it('the plan is in the position\'s mode', () => {
    assert.deepEqual(buy({ mode: 'live' }), ['wrong-mode']);
    assert.deepEqual(sell({ mode: 'live' }), ['wrong-mode']);
  });

  it('only allowed routes', () => {
    assert.deepEqual(buy({ route: 'jupiter-order' }), ['route-not-allowed']);
    assert.deepEqual(buy({ route: 'jupiter-build' }, { caps: { ...CAPS, allowedRoutes: ['direct', 'jupiter-build'] } }), []);
  });

  it('quote and fee config at most 25 slots old, and never from the future', () => {
    assert.deepEqual(buy({ quoteSlot: 975n }), []);
    assert.deepEqual(buy({ quoteSlot: 974n }), ['stale-plan']);
    assert.deepEqual(buy({ quoteSlot: 1_001n }), ['stale-plan']);
    assert.deepEqual(buy({ feeConfigSlot: 975n }), []);
    assert.deepEqual(buy({ feeConfigSlot: 974n }), ['stale-fee-config']);
    assert.deepEqual(buy({ feeConfigSlot: 1_001n }), ['stale-fee-config']);
    assert.deepEqual(sell({ quoteSlot: 974n }), ['stale-quote']); // the exit check's name for the same fault
  });

  it('every problem is reported, in a fixed order', () => {
    const all = buy({ mode: 'live', positionId: 'p2', wallet: 'X', quoteSlot: 1n, minOut: 0n, rentLamports: lamports(0n) });
    assert.deepEqual(all, ['wrong-mode', 'wrong-position', 'foreign-wallet', 'stale-plan', 'min-out-below-slippage', 'rent-mismatch']);
  });
});

describe('fail closed on a malformed plan or context', () => {
  it('a malformed plan throws RiskError, never a verdict', () => {
    assert.throws(() => planProblems({ ...BUY, attempts: 0 }, BUY_CTX), RiskError);
    assert.throws(() => planProblems({ ...BUY, memo: 'x' } as unknown as OrderPlan, BUY_CTX), RiskError);
    assert.throws(() => planProblems(null as unknown as OrderPlan, BUY_CTX), RiskError);
    assert.throws(() => checkPlan(null as unknown as OrderPlan, BUY_CTX), RiskError);
  });

  it('a missing part of the context throws: a buy needs the sizing figures, an exit its figures', () => {
    assert.throws(() => planProblems(BUY, { ...BUY_CTX, buy: null }), /buy context/);
    assert.throws(() => planProblems(SELL, { ...SELL_CTX, exit: null }), /exit context/);
    assert.throws(() => planProblems(CLOSE, { ...CLOSE_CTX, exit: null }), /exit context/);
    assert.throws(() => planProblems(BUY, null as unknown as PlanContext), RiskError);
    assert.throws(() => checkPlan(BUY, null as unknown as PlanContext), RiskError);
  });

  it('caps above their hard values are refused, so a bad config cannot loosen a check', () => {
    const bad: ReadonlyArray<Partial<PlanCaps>> = [
      { planFreshSlots: 0 },
      { planFreshSlots: 26 },
      { buySlippageMaxBps: bps(301) },
      { exitSlippageNormalBps: bps(99) },
      { exitSlippageNormalBps: bps(501) },
      { exitSlippageEmergencyBps: bps(299) }, // below the normal cap: /panic could never sell
      { exitSlippageEmergencyBps: bps(1_001) },
      { cuLimitMax: 300_001 },
      { cuLimitMax: 0 },
      { cuPriceMaxBuy: microLamportsPerCu(200_001n) },
      { cuPriceMaxExit: microLamportsPerCu(400_001n) },
      { landingSpendBuyBps: bps(31) },
      { landingSpendExitBps: bps(61) },
      { allowedRoutes: [] },
      { allowedRoutes: ['teleport' as 'direct'] },
    ];
    for (const caps of bad) {
      assert.throws(() => planProblems(BUY, { ...BUY_CTX, caps: { ...CAPS, ...caps } }), RiskError, JSON.stringify(caps, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v)));
    }
  });

  it('bad context values throw: slots, counts, simulated units, ids, states and origins', () => {
    assert.throws(() => buy({}, { currentSlot: -1n }), RiskError);
    assert.throws(() => buy({}, { currentSlot: 5 as unknown as bigint }), RiskError);
    assert.throws(() => buy({}, { simulatedCu: 0 }), RiskError);
    assert.throws(() => buy({}, { simulatedCu: 1.5 }), RiskError);
    assert.throws(() => buy({}, buyCtx({ attemptsAllowed: 0 })), RiskError);
    assert.throws(() => sell({}, sellExit({ attemptsAllowed: -1 })), RiskError);
    assert.throws(() => sell({}, sellExit({ inFlightExits: -1 })), RiskError);
    assert.throws(() => sell({}, sellExit({ urgency: 'panic' as 'normal' })), RiskError);
    assert.throws(() => sell({}, sellExit({ origin: { kind: 'robot' } as unknown as ExitPlanContext['origin'] })), RiskError);
    assert.throws(() => sell({}, sellExit({ origin: null as unknown as ExitPlanContext['origin'] })), RiskError);
    assert.throws(() => sell({}, sellExit({ origin: { ...AUTOMATIC, sellSimPassed: 'yes' as unknown as boolean } })), RiskError);
    assert.throws(() => sell({}, sellExit({ origin: { ...AUTOMATIC, automaticStopped: 1 as unknown as boolean } })), RiskError);
    assert.throws(() => buy({}, { wallet: 'a b' }), RiskError);
    assert.throws(() => buy({}, { position: { id: '', mint: 'MintA', mode: 'paper', status: 'opening' } }), RiskError);
    assert.throws(() => buy({}, { position: { id: 'p1', mint: 'MintA', mode: 'demo' as 'paper', status: 'opening' } }), RiskError);
    assert.throws(() => buy({}, { position: { id: 'p1', mint: 'MintA', mode: 'paper', status: 'gone' as 'opening' } }), RiskError);
    assert.throws(() => buy({}, { pool: { id: 'PoolA', venue: 'orca' as 'pumpswap', quoteMint: WSOL } }), RiskError);
    assert.throws(() => buy({}, { pool: null as unknown as PlanContext['pool'] }), RiskError);
    assert.throws(() => buy({}, { ledgerTokens: -1n as ReturnType<typeof tokenUnits> }), Error);
  });
});
