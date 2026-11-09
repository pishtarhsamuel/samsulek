// Property tests for reduce-only exits (TEST_PLAN.md s.4, invariants 4, 5 and 19). For random
// plans and positions an exit is approved IF AND ONLY IF an independent oracle, written here as
// the plain rules, says it only reduces risk: so no risky plan gets through, and no valid exit
// (stuck, protective, emergency, a close) is ever refused. A plan of any other kind is never
// approved.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { bps, tokenUnits } from '../../../src/core/units.ts';
import { exitProblems, type ExitContext, type ExitPlan } from '../../../src/risk/exits.ts';

fc.configureGlobal({ numRuns: 1_000 }); // TEST_PLAN.md s.4 (this file's process only)

const WSOL = 'So11111111111111111111111111111111111111112';
const tokens = fc.bigInt({ min: 0n, max: 2_000_000n }).map(tokenUnits);
const pick = <T>(...values: T[]) => fc.constantFrom(...values);

const contextArb: fc.Arbitrary<ExitContext> = fc.record({
  currentSlot: fc.bigInt({ min: 100n, max: 200n }),
  position: fc.record({
    id: pick('p1', 'p2'),
    mint: pick('MintA', 'MintB'),
    status: pick('opening' as const, 'open' as const, 'exiting' as const, 'stuck' as const, 'closed' as const),
  }),
  ledgerTokens: tokens,
  chainTokens: tokens,
  inFlightSellTokens: fc.oneof(fc.constant(tokenUnits(0n)), tokens),
  inFlightExits: fc.integer({ min: 0, max: 2 }),
  ownTokenAccount: pick('AtaA'),
  wallet: pick('OurWallet'),
  wsolMint: pick(WSOL),
  caps: fc.record({
    planFreshSlots: fc.integer({ min: 1, max: 25 }),
    normalSlippageBps: fc.integer({ min: 100, max: 500 }).map(bps),
    emergencySlippageBps: fc.integer({ min: 500, max: 1_000 }).map(bps),
  }),
});

const planArb: fc.Arbitrary<ExitPlan> = fc.record({
  kind: pick('sell' as const, 'close-account' as const),
  positionId: pick('p1', 'p2'),
  inputMint: pick('MintA', 'MintB'),
  outputMint: pick(WSOL, 'MintA'),
  inAmount: tokens,
  slippageBps: fc.integer({ min: 0, max: 1_200 }).map(bps),
  urgency: pick('normal' as const, 'protective' as const, 'emergency' as const),
  quoteSlot: fc.bigInt({ min: 60n, max: 210n }),
  account: pick('AtaA', 'AtaOther'),
  destination: pick('OurWallet', 'Attacker'),
});

// Mostly valid plans (each field fixed with probability ~85%), so approvals are frequent; the raw
// generators still supply every kind of wrong field.
const often = fc.integer({ min: 0, max: 19 }).map((n) => n > 2);
const caseArb = fc
  .tuple(contextArb, planArb, fc.array(often, { minLength: 10, maxLength: 10 }), fc.bigInt({ min: 0n, max: 25n }))
  .map(([c, p, fix, age]): [ExitPlan, ExitContext] => {
    let context: ExitContext = fix[0] ? { ...c, inFlightExits: 0 } : c;
    if (fix[9]) {
      const status = p.kind === 'sell' ? pickStatus(age) : ('exiting' as const);
      context = { ...context, position: { ...context.position, status } };
      if (p.kind === 'close-account') {
        const none = tokenUnits(0n);
        context = { ...context, ledgerTokens: none, chainTokens: none, inFlightSellTokens: none };
      }
    }
    const held = context.ledgerTokens < context.chainTokens ? context.ledgerTokens : context.chainTokens;
    const room = held > context.inFlightSellTokens ? held - context.inFlightSellTokens : 0n;
    let inAmount = p.inAmount;
    if (fix[6]) {
      inAmount = p.kind === 'close-account' ? tokenUnits(0n) : room > 0n ? tokenUnits(1n + (p.inAmount % room)) : p.inAmount;
    }
    const cap = p.urgency === 'normal' ? context.caps.normalSlippageBps : context.caps.emergencySlippageBps;
    const plan: ExitPlan = {
      ...p,
      positionId: fix[1] ? context.position.id : p.positionId,
      inputMint: fix[2] ? context.position.mint : p.inputMint,
      outputMint: fix[3] ? context.wsolMint : p.outputMint,
      quoteSlot: fix[4] ? context.currentSlot - (age % BigInt(context.caps.planFreshSlots + 1)) : p.quoteSlot,
      slippageBps: fix[5] ? bps(Math.min(p.slippageBps, cap)) : p.slippageBps,
      inAmount,
      account: fix[7] ? context.ownTokenAccount : p.account,
      destination: fix[8] ? context.wallet : p.destination,
    };
    return [plan, context];
  });

function pickStatus(n: bigint): 'open' | 'stuck' {
  return n % 2n === 0n ? 'open' : 'stuck';
}

/** The plain rules of RISK_POLICY.md s.9, written independently of the implementation. */
function onlyReducesRisk(plan: ExitPlan, c: ExitContext): boolean {
  const own =
    plan.positionId === c.position.id &&
    plan.inputMint === c.position.mint &&
    plan.outputMint === c.wsolMint &&
    plan.account === c.ownTokenAccount &&
    plan.destination === c.wallet;
  const fresh = plan.quoteSlot <= c.currentSlot && c.currentSlot - plan.quoteSlot <= BigInt(c.caps.planFreshSlots);
  const cap = plan.urgency === 'normal' ? c.caps.normalSlippageBps : c.caps.emergencySlippageBps;
  const common = own && fresh && plan.slippageBps <= cap && c.inFlightExits === 0;
  if (plan.kind === 'sell') {
    const held = c.ledgerTokens < c.chainTokens ? c.ledgerTokens : c.chainTokens;
    const hasTokens = c.position.status === 'open' || c.position.status === 'stuck';
    return common && hasTokens && plan.inAmount > 0n && plan.inAmount + c.inFlightSellTokens <= held;
  }
  const empty = c.ledgerTokens === 0n && c.chainTokens === 0n && c.inFlightSellTokens === 0n;
  return common && c.position.status === 'exiting' && plan.inAmount === 0n && empty;
}

describe('reduce-only exit properties', () => {
  it('an exit is approved if and only if it only reduces risk (both directions, with many of each)', () => {
    let approved = 0;
    let refused = 0;
    const byKind = { sell: 0, 'close-account': 0 };
    const byUrgency = { normal: 0, protective: 0, emergency: 0 };
    let stuck = 0;
    fc.assert(
      fc.property(caseArb, ([plan, c]) => {
        const ok = exitProblems(plan, c).length === 0;
        assert.equal(ok, onlyReducesRisk(plan, c));
        if (ok) {
          approved += 1;
          byKind[plan.kind] += 1;
          byUrgency[plan.urgency] += 1;
          stuck += c.position.status === 'stuck' ? 1 : 0;
        } else {
          refused += 1;
        }
      }),
    );
    // Never vacuous: plenty of approvals and refusals, of every kind and urgency, stuck included.
    assert.ok(approved >= 100 && refused >= 100, `approved ${approved}, refused ${refused}`);
    for (const [name, count] of Object.entries({ ...byKind, ...byUrgency, stuck })) {
      assert.ok(count >= 5, `only ${count} approved exits of kind or urgency "${name}"`);
    }
  });

  it('a plan that is neither a sell nor a close is always refused', () => {
    fc.assert(
      fc.property(caseArb, pick('buy', 'withdraw', 'SELL', ''), ([plan, c], kind) => {
        assert.deepEqual([...exitProblems({ ...plan, kind: kind as unknown as 'sell' }, c)], ['not-reduce-only']);
      }),
    );
  });
});
