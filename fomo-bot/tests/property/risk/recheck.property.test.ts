// Property tests for the plan re-check (TEST_PLAN.md s.4; RISK_POLICY.md limits 16-20 and
// invariants 1 and 3): every case starts from a plan that passes, then up to two random faults are
// applied to the plan or the context. A plan passes IF AND ONLY IF an independent oracle, the plain
// rules written out here (the exit rules of s.9 included), says so: so no plan beyond a cap gets
// through and no valid plan is refused. The worst-case spend of every accepted buy fits what sizing
// reserved, only an accepted plan becomes a CheckedPlan, and any single changed field changes the
// plan hash.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { bps, lamports, microLamportsPerCu, tokenUnits } from '../../../src/core/units.ts';
import { planHash, planMaxSpend, type OrderPlan, type PlanMode, type PlanUrgency } from '../../../src/risk/plan.ts';
import { checkPlan, isCheckedPlan, planProblems, type PlanContext } from '../../../src/risk/recheck.ts';
import { FREE_FEES, WSOL, passingContext } from '../../unit/risk/fixtures.ts';

fc.configureGlobal({ numRuns: 1_000 }); // TEST_PLAN.md s.4 (this file's process only)

type Kind = 'buy' | 'sell' | 'close-account';
const pick = <T>(...values: T[]) => fc.constantFrom(...values);

const perAttempt = (p: OrderPlan): bigint => 5_000n + (p.cuPrice * BigInt(p.cuLimit) + 999_999n) / 1_000_000n + p.tip.lamports;

function basePlan(kind: Kind, mode: PlanMode, urgency: PlanUrgency, salt: number): OrderPlan {
  const close = kind === 'close-account';
  return {
    orderId: `order-${salt}`,
    intentId: `intent-${salt}`,
    positionId: 'p1',
    mode,
    kind,
    urgency: kind === 'buy' ? 'normal' : urgency,
    venue: 'pumpswap',
    route: 'direct',
    mint: 'MintA',
    pool: 'PoolA',
    tokenAccount: 'AtaOfMintA',
    wallet: 'OurWallet',
    inAmount: close ? 0n : 55_000_000n + BigInt(salt),
    expectedOut: close ? 0n : 1_000_000_000n,
    minOut: close ? 0n : 980_000_000n,
    slippageBps: bps(close ? 0 : 200),
    feeBps: bps(125),
    feeConfigSlot: 995n,
    cuLimit: 200_000,
    cuPrice: microLamportsPerCu(150_000n),
    tip: { path: 'jito', lamports: lamports(1_000n) },
    rentLamports: lamports(kind === 'buy' ? 1_488_440n : 0n),
    attempts: 3,
    closeAccountAfter: false,
    quoteSlot: 990n,
    lastValidBlockHeight: null,
    ...(close ? FREE_FEES : {}),
  };
}

function baseCase(kind: Kind, mode: PlanMode, urgency: PlanUrgency, automatic: boolean, salt: number): [OrderPlan, PlanContext] {
  const plan = basePlan(kind, mode, urgency, salt);
  let ctx = passingContext(plan);
  if (kind !== 'buy' && automatic) {
    const budgetLeft = lamports(BigInt(plan.attempts) * perAttempt(plan) + 1_000n);
    ctx = { ...ctx, exit: { ...ctx.exit!, origin: { kind: 'automatic', budgetLeft, automaticStopped: false, sellSimPassed: true } } };
  }
  return [plan, ctx];
}

type Case = [OrderPlan, PlanContext];
const onPlan = (f: (p: OrderPlan, c: PlanContext) => Partial<OrderPlan>) => ([p, c]: Case): Case => [{ ...p, ...f(p, c) }, c];
const onCtx = (f: (p: OrderPlan, c: PlanContext) => Partial<PlanContext>) => ([p, c]: Case): Case => [p, { ...c, ...f(p, c) }];
const onExit = (f: (e: NonNullable<PlanContext['exit']>) => Partial<NonNullable<PlanContext['exit']>>) => ([p, c]: Case): Case =>
  c.exit === null ? [p, c] : [p, { ...c, exit: { ...c.exit, ...f(c.exit) } }];
const onBuy = (f: (b: NonNullable<PlanContext['buy']>) => Partial<NonNullable<PlanContext['buy']>>) => ([p, c]: Case): Case =>
  c.buy === null ? [p, c] : [p, { ...c, buy: { ...c.buy, ...f(c.buy) } }];

const FAULTS: Readonly<Record<string, (c: Case) => Case>> = {
  mode: onPlan((p) => ({ mode: p.mode === 'paper' ? 'live' : 'paper' })),
  position: onPlan(() => ({ positionId: 'p9' })),
  mint: onPlan(() => ({ mint: 'MintZ' })),
  wallet: onPlan(() => ({ wallet: 'Attacker' })),
  account: onPlan(() => ({ tokenAccount: 'AtaOther' })),
  pool: onPlan(() => ({ pool: 'EvilPool' })),
  venue: onPlan(() => ({ venue: 'pump-curve' })),
  route: onPlan(() => ({ route: 'jupiter-order' })),
  feeConfigStale: onPlan((p) => ({ feeConfigSlot: p.feeConfigSlot - 30n })),
  quoteStale: onPlan((p) => ({ quoteSlot: p.quoteSlot - 30n })),
  quoteFuture: onPlan((p) => ({ quoteSlot: p.quoteSlot + 100n })),
  urgency: onPlan((p) => ({ urgency: p.urgency === 'normal' ? 'emergency' : 'normal' })),
  minOutLow: onPlan((p) => ({ minOut: p.minOut > 0n ? p.minOut - 1n : p.minOut })),
  minOutHigh: onPlan((p) => ({ minOut: p.expectedOut + 1n })),
  expectedUp: onPlan((p) => ({ expectedOut: p.expectedOut + 1n })),
  expectedZero: onPlan(() => ({ expectedOut: 0n, minOut: 0n })),
  quoteLower: ([p, c]) => onExit((e) => ({ quotedOut: lamports(e.quotedOut > 0n ? e.quotedOut - 1n : 0n) }))(onBuy((b) => ({ quotedOut: b.quotedOut > 0n ? b.quotedOut - 1n : 0n }))([p, c])),
  slippageUp: onPlan((p) => ({ slippageBps: bps(Math.min(p.slippageBps + 150, 10_000)) })),
  cuLimitUp: onPlan(() => ({ cuLimit: 300_001 })),
  cuPriceUp: onPlan((p) => ({ cuPrice: microLamportsPerCu(p.kind === 'buy' ? 200_001n : 400_001n) })),
  tipOff: onPlan(() => ({ tip: { path: 'jito', lamports: lamports(1_001n) } })),
  tipBig: onPlan(() => ({ tip: { path: 'helius-swqos', lamports: lamports(5_000n) } })),
  attemptsUp: onPlan((p) => ({ attempts: p.attempts + 1 })),
  inAmountUp: onPlan((p) => ({ inAmount: p.inAmount + 1n })),
  inAmountDown: onPlan((p) => ({ inAmount: p.inAmount > 0n ? p.inAmount - 1n : 1n })),
  inAmountHuge: onPlan((p) => ({ inAmount: p.kind === 'buy' ? p.inAmount : 5_000_000n })),
  rentOff: onPlan((p) => ({ rentLamports: lamports(p.rentLamports + 1n) })),
  closeAfter: onPlan((p) => ({ closeAccountAfter: !p.closeAccountAfter })),
  statusOff: onCtx((_p, c) => ({ position: { ...c.position, status: 'closed' } })),
  statusOpen: onCtx((_p, c) => ({ position: { ...c.position, status: 'open' } })),
  poolQuote: onCtx((_p, c) => ({ pool: { ...c.pool, quoteMint: 'UsdcMint' } })),
  simNull: onCtx(() => ({ simulatedCu: null })),
  simLow: onCtx(() => ({ simulatedCu: 100_000 })),
  chainMore: onCtx((_p, c) => ({ chainTokens: tokenUnits(c.chainTokens + 1n) })),
  ledgerMore: onCtx((_p, c) => ({ ledgerTokens: tokenUnits(c.ledgerTokens + 1n) })),
  stopped: onExit((e) => ({ origin: e.origin.kind === 'automatic' ? { ...e.origin, automaticStopped: true } : e.origin })),
  simFailed: onExit((e) => ({ origin: e.origin.kind === 'automatic' ? { ...e.origin, sellSimPassed: false } : e.origin })),
  budgetLow: onExit((e) => ({ origin: e.origin.kind === 'automatic' ? { ...e.origin, budgetLeft: lamports(e.origin.budgetLeft > 0n ? e.origin.budgetLeft - 1n : 0n) } : e.origin })),
  ownerOrdered: onExit(() => ({ origin: { kind: 'owner' } })),
  inFlightExit: onExit(() => ({ inFlightExits: 1 })),
  inFlightSell: onExit(() => ({ inFlightSellTokens: tokenUnits(10_000_000n) })),
  fewAttempts: onExit(() => ({ attemptsAllowed: 1 })),
  fewBuyAttempts: onBuy(() => ({ attemptsAllowed: 1 })),
  sizedFeesLow: onBuy((b) => ({ sizedAttemptFees: lamports(b.sizedAttemptFees - 1n) })),
  sizedInLow: onBuy((b) => ({ sizedInAmount: lamports(b.sizedInAmount - 1n) })),
  minInHigh: onBuy((b) => ({ minInAmount: lamports(b.minInAmount + 1n) })),
  rentRequiredOff: onBuy((b) => ({ rentRequired: lamports(b.rentRequired + 1n) })),
  costBasisLow: onExit(() => ({ costBasis: lamports(1n) })),
  // A small sale: 5,166,666 x 0.6% = 30,999 lamports, one short of one attempt's 31,000 landing spend,
  // so only protective or emergency exits pass the landing cap (the intent's urgency decides).
  smallSale: ([p, c]) => smallSale([p, c], 1n),
  // The same sale after a price collapse: the cost basis (5,166,667) keeps the cap alive.
  collapsedPrice: ([p, c]) => smallSale([p, c], 5_166_667n),
};
function smallSale([p, c]: Case, costBasis: bigint): Case {
  if (p.kind !== 'sell' || c.exit === null) {
    return [p, c];
  }
  const quoted = 5_166_666n;
  const minOut = (quoted * (10_000n - BigInt(p.slippageBps))) / 10_000n;
  return [{ ...p, expectedOut: quoted, minOut }, { ...c, exit: { ...c.exit, quotedOut: lamports(quoted), costBasis: lamports(costBasis) } }];
}
const FAULT_NAMES = Object.keys(FAULTS);

const baseArb = fc.record({
  kind: pick<Kind>('buy', 'sell', 'close-account'),
  mode: pick<PlanMode>('paper', 'live'),
  urgency: pick<PlanUrgency>('normal', 'protective', 'emergency'),
  automatic: fc.boolean(),
  salt: fc.integer({ min: 0, max: 1_000 }),
});
const faultsArb = fc.oneof(
  { weight: 3, arbitrary: fc.constant<string[]>([]) },
  { weight: 7, arbitrary: fc.array(pick(...FAULT_NAMES), { minLength: 1, maxLength: 2 }) },
);
const caseArb = fc.tuple(baseArb, faultsArb).map(([b, faults]) => {
  const start = baseCase(b.kind, b.mode, b.urgency, b.automatic, b.salt);
  return { base: start, faults, final: faults.reduce<Case>((c, name) => FAULTS[name]!(c), start) };
});

/** The plain rules of RISK_POLICY.md limits 16-20, s.3a, s.6 step 5 and s.9, independent of the implementation. */
function acceptable(plan: OrderPlan, c: PlanContext): boolean {
  const buy = plan.kind === 'buy';
  const close = plan.kind === 'close-account';
  const priority = (plan.cuPrice * BigInt(plan.cuLimit) + 999_999n) / 1_000_000n;
  const landing = priority + plan.tip.lamports;
  const worst = BigInt(plan.attempts) * perAttempt(plan);
  const tipOk =
    (plan.tip.path === 'none' && plan.tip.lamports === 0n) ||
    (plan.tip.path === 'jito' && plan.tip.lamports === 1_000n) ||
    (plan.tip.path === 'helius-swqos' && plan.tip.lamports === 5_000n);
  const fresh = (slot: bigint) => slot <= c.currentSlot && c.currentSlot - slot <= 25n;
  const b = c.buy;
  const e = c.exit;
  const quoted = buy ? b!.quotedOut : e!.quotedOut;
  const floor = (quoted * (10_000n - BigInt(plan.slippageBps))) / 10_000n;
  const urgency = buy ? 'normal' : e!.urgency;
  const base = buy ? plan.inAmount : e!.quotedOut > e!.costBasis ? e!.quotedOut : e!.costBasis;
  const landingBps = buy ? 20n : 60n;

  const common =
    plan.mode === c.position.mode &&
    plan.pool === c.pool.id &&
    plan.venue === c.pool.venue &&
    c.pool.quoteMint === WSOL &&
    plan.route === 'direct' &&
    fresh(plan.feeConfigSlot) &&
    (plan.mode !== 'live' || c.simulatedCu !== null) &&
    plan.cuLimit <= 300_000 &&
    (c.simulatedCu === null || BigInt(plan.cuLimit) <= (BigInt(c.simulatedCu) * 12n + 9n) / 10n) &&
    plan.cuPrice <= (buy ? 200_000n : 400_000n) &&
    tipOk &&
    (!(buy || urgency === 'normal') || landing <= (base * landingBps) / 10_000n) &&
    (close || (plan.expectedOut <= quoted && plan.minOut >= floor && plan.minOut <= plan.expectedOut));

  if (buy) {
    return (
      common &&
      plan.urgency === 'normal' &&
      plan.positionId === c.position.id &&
      plan.mint === c.position.mint &&
      plan.wallet === c.wallet &&
      plan.tokenAccount === c.ownTokenAccount &&
      fresh(plan.quoteSlot) &&
      c.position.status === 'opening' &&
      plan.expectedOut > 0n &&
      plan.slippageBps <= 300 &&
      plan.attempts <= b!.attemptsAllowed &&
      worst <= b!.sizedAttemptFees &&
      plan.inAmount >= b!.minInAmount &&
      plan.inAmount <= b!.sizedInAmount &&
      plan.rentLamports === b!.rentRequired &&
      !plan.closeAccountAfter
    );
  }

  const held = c.ledgerTokens < c.chainTokens ? c.ledgerTokens : c.chainTokens;
  const sellable = held > e!.inFlightSellTokens ? held - e!.inFlightSellTokens : 0n;
  const origin = e!.origin;
  const originOk =
    origin.kind === 'owner' ||
    (!origin.automaticStopped && (close || origin.sellSimPassed) && worst <= origin.budgetLeft && !(!close && plan.expectedOut === 0n));
  const closingOk = close
    ? plan.inAmount === 0n && plan.expectedOut === 0n && plan.minOut === 0n && !plan.closeAccountAfter
    : !plan.closeAccountAfter || (plan.inAmount === c.ledgerTokens && c.ledgerTokens === c.chainTokens);
  const reduceOnlyOk =
    plan.positionId === c.position.id &&
    plan.mint === c.position.mint &&
    plan.tokenAccount === c.ownTokenAccount &&
    plan.wallet === c.wallet &&
    (close
      ? c.position.status === 'exiting' && plan.inAmount === 0n && c.ledgerTokens === 0n && c.chainTokens === 0n && e!.inFlightSellTokens === 0n
      : (c.position.status === 'open' || c.position.status === 'stuck') && plan.inAmount > 0n && plan.inAmount <= sellable) &&
    e!.inFlightExits === 0 &&
    fresh(plan.quoteSlot) &&
    plan.slippageBps <= (urgency === 'normal' ? 300 : 1_000);
  return (
    common &&
    plan.urgency === e!.urgency &&
    plan.attempts <= e!.attemptsAllowed &&
    originOk &&
    plan.rentLamports === 0n &&
    closingOk &&
    reduceOnlyOk
  );
}

describe('plan re-check properties', () => {
  it('every base case passes (the fixtures and the base plans are valid for every kind, mode, urgency and origin)', () => {
    fc.assert(fc.property(baseArb, (b) => assert.deepEqual(planProblems(...baseCase(b.kind, b.mode, b.urgency, b.automatic, b.salt)), [])));
  });

  it('a plan passes if and only if the independent oracle accepts it (many of each kind, with and without faults)', () => {
    const accepted: Record<string, number> = { buy: 0, sell: 0, 'close-account': 0 };
    const refusedBy: Record<string, number> = {};
    let refused = 0;
    fc.assert(
      fc.property(caseArb, ({ faults, final: [plan, c] }) => {
        const ok = planProblems(plan, c).length === 0;
        assert.equal(ok, acceptable(plan, c), faults.join('+'));
        if (ok) {
          accepted[plan.kind] = (accepted[plan.kind] ?? 0) + 1;
        } else {
          refused += 1;
          for (const f of faults) {
            refusedBy[f] = (refusedBy[f] ?? 0) + 1;
          }
        }
      }),
    );
    assert.ok(refused >= 100, `only ${refused} refused: the property would be vacuous`);
    for (const [kind, count] of Object.entries(accepted)) {
      assert.ok(count >= 20, `only ${count} accepted plans of kind ${kind}`);
    }
    // every fault actually led to a refusal somewhere, so none of them is dead weight
    const never = FAULT_NAMES.filter((name) => (refusedBy[name] ?? 0) === 0);
    assert.deepEqual(never, [], 'faults that never caused a refusal');
  });

  it('only an accepted plan becomes a CheckedPlan, and an accepted buy never spends more than sizing allowed', () => {
    let checkedBuys = 0;
    fc.assert(
      fc.property(caseArb, ({ final: [plan, c] }) => {
        const result = checkPlan(plan, c);
        assert.equal(result.ok, planProblems(plan, c).length === 0);
        assert.equal(isCheckedPlan(result.ok ? result.plan : plan), result.ok);
        if (result.ok && plan.kind === 'buy') {
          checkedBuys += 1;
          const b = c.buy!;
          assert.ok(planMaxSpend(plan) <= b.sizedInAmount + b.rentRequired + b.sizedAttemptFees);
        }
      }),
    );
    assert.ok(checkedBuys >= 20, `only ${checkedBuys} accepted buys were checked`);
  });

  it('changing any single field of an accepted plan changes its hash', () => {
    const changes: ReadonlyArray<(p: OrderPlan) => OrderPlan> = [
      (p) => ({ ...p, inAmount: p.inAmount + 1n }),
      (p) => ({ ...p, minOut: p.minOut + 1n }),
      (p) => ({ ...p, wallet: `${p.wallet}x` }),
      (p) => ({ ...p, tokenAccount: `${p.tokenAccount}x` }),
      (p) => ({ ...p, mode: p.mode === 'paper' ? 'live' : 'paper' }),
      (p) => ({ ...p, quoteSlot: p.quoteSlot + 1n }),
      (p) => ({ ...p, attempts: p.attempts + 1 }),
      (p) => ({ ...p, cuPrice: microLamportsPerCu(p.cuPrice + 1n) }),
      (p) => ({ ...p, urgency: p.urgency === 'normal' ? 'protective' : 'normal' }),
      (p) => ({ ...p, pool: `${p.pool}x` }),
    ];
    fc.assert(
      fc.property(baseArb, fc.integer({ min: 0, max: changes.length - 1 }), (b, i) => {
        const [plan] = baseCase(b.kind, b.mode, b.urgency, b.automatic, b.salt);
        assert.notEqual(planHash(changes[i]!(plan)), planHash(plan));
      }),
    );
  });
});
