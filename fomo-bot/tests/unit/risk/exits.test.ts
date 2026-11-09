// Reduce-only exits (RISK_POLICY.md s.9; invariants 4, 5 and 19): an exit is approved under kill,
// halt, pause, the daily stop and every breaker, but only when it can only reduce risk: a sell of
// at most the sellable amount of its own position's token into SOL, or the close of our own empty
// token account to our wallet; one exit in flight per position; a fresh quote; the slippage cap.
// TEST_PLAN.md s.3 step 4. Written before the implementation.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bps, tokenUnits } from '../../../src/core/units.ts';
import { RiskError } from '../../../src/risk/reserve.ts';
import { exitProblems, type ExitContext, type ExitPlan } from '../../../src/risk/exits.ts';

const WSOL = 'So11111111111111111111111111111111111111112';

const CONTEXT: ExitContext = {
  currentSlot: 1_000n,
  position: { id: 'p1', mint: 'MintA', status: 'open' },
  ledgerTokens: tokenUnits(1_000_000n),
  chainTokens: tokenUnits(1_000_000n),
  inFlightSellTokens: tokenUnits(0n),
  inFlightExits: 0,
  ownTokenAccount: 'AtaOfMintA',
  wallet: 'OurWallet',
  wsolMint: WSOL,
  caps: { planFreshSlots: 25, normalSlippageBps: bps(300), emergencySlippageBps: bps(1_000) },
};

const SELL: ExitPlan = {
  kind: 'sell',
  positionId: 'p1',
  inputMint: 'MintA',
  outputMint: WSOL,
  inAmount: tokenUnits(400_000n),
  slippageBps: bps(300),
  urgency: 'normal',
  quoteSlot: 990n,
  account: 'AtaOfMintA',
  destination: 'OurWallet',
};

const CLOSE: ExitPlan = { ...SELL, kind: 'close-account', inAmount: tokenUnits(0n) };
const EXITING: ExitContext = { ...CONTEXT, position: { ...CONTEXT.position, status: 'exiting' }, ledgerTokens: tokenUnits(0n), chainTokens: tokenUnits(0n) };

const problems = (plan: Partial<ExitPlan>, context: Partial<ExitContext> = {}) =>
  exitProblems({ ...SELL, ...plan }, { ...CONTEXT, ...context });

describe('a valid exit is approved (no flags are even consulted)', () => {
  it('a normal sell of part of the holding', () => {
    assert.deepEqual(problems({}), []);
  });

  it('a sell of everything that is sellable', () => {
    assert.deepEqual(problems({ inAmount: tokenUnits(1_000_000n) }), []);
  });

  it('a protective or emergency sell with the wide 10% cap', () => {
    assert.deepEqual(problems({ urgency: 'protective', slippageBps: bps(1_000) }), []);
    assert.deepEqual(problems({ urgency: 'emergency', slippageBps: bps(1_000) }), []);
  });

  it('closing our own empty token account to our wallet', () => {
    assert.deepEqual(exitProblems(CLOSE, EXITING), []);
  });
});

describe('only risk-reducing plans', () => {
  it('a buy (or anything but sell and close-account) is never approved here', () => {
    assert.deepEqual(problems({ kind: 'buy' as 'sell' }), ['not-reduce-only']);
    assert.deepEqual(problems({ kind: 'withdraw' as 'sell' }), ['not-reduce-only']);
  });

  it("only the position's own token, only into SOL", () => {
    assert.deepEqual(problems({ inputMint: 'MintB' }), ['wrong-mint']);
    assert.deepEqual(problems({ outputMint: 'MintB' }), ['not-into-sol']);
    assert.deepEqual(problems({ positionId: 'p2' }), ['wrong-position']);
  });
});

describe('the sellable amount: min(ledger, chain) minus sells in flight (invariant 5)', () => {
  it('never more than the ledger or the chain holds', () => {
    assert.deepEqual(problems({ inAmount: tokenUnits(600_001n) }, { chainTokens: tokenUnits(600_000n) }), ['above-sellable']);
    assert.deepEqual(problems({ inAmount: tokenUnits(600_000n) }, { chainTokens: tokenUnits(600_000n) }), []);
    assert.deepEqual(problems({ inAmount: tokenUnits(600_001n) }, { ledgerTokens: tokenUnits(600_000n) }), ['above-sellable']);
  });

  it('sells already in flight count against it, and a zero sell is refused', () => {
    assert.deepEqual(problems({ inAmount: tokenUnits(700_001n) }, { inFlightSellTokens: tokenUnits(300_000n) }), ['above-sellable']);
    // More in flight than held (the chain fell behind a sell): nothing is sellable, never negative.
    assert.deepEqual(problems({ inAmount: tokenUnits(1n) }, { inFlightSellTokens: tokenUnits(1_000_001n) }), ['above-sellable']);
    assert.deepEqual(problems({ inAmount: tokenUnits(0n) }), ['empty-sell']);
  });

  it('one exit in flight per position', () => {
    assert.deepEqual(problems({}, { inFlightExits: 1 }), ['exit-in-flight']);
  });
});

describe('the position must be in a state that has something to exit', () => {
  it('a sell needs an open position; a close needs one whose tokens are all sold', () => {
    assert.deepEqual(problems({}, { position: { ...CONTEXT.position, status: 'opening' } }), ['nothing-to-sell']);
    assert.deepEqual(problems({}, { position: { ...CONTEXT.position, status: 'closed' } }), ['nothing-to-sell']);
    assert.deepEqual(exitProblems(CLOSE, CONTEXT), ['nothing-to-close', 'account-not-empty']);
  });
});

describe('proceeds and tokens never go to or come from a stranger (this check runs under kill and halt)', () => {
  it('a sell must use our own token account and pay our own wallet, like a close', () => {
    assert.deepEqual(problems({ destination: 'Attacker' }), ['foreign-destination']);
    assert.deepEqual(problems({ account: 'SomeoneElse' }), ['foreign-account']);
    assert.deepEqual(problems({ account: 'SomeoneElse', destination: 'Attacker' }), ['foreign-account', 'foreign-destination']);
  });

  it('a look-alike address is still a foreign one (address poisoning)', () => {
    assert.deepEqual(problems({ destination: 'OurWa11et' }), ['foreign-destination']);
    assert.deepEqual(problems({ destination: 'ourwallet' }), ['foreign-destination']);
    assert.deepEqual(problems({ account: 'AtaOfMintB' }), ['foreign-account']);
  });
});

describe('closing the token account', () => {
  it('only our own account for this token, empty on chain, refunded to our wallet', () => {
    assert.deepEqual(exitProblems({ ...CLOSE, account: 'SomeoneElse' }, EXITING), ['foreign-account']);
    assert.deepEqual(exitProblems({ ...CLOSE, destination: 'Attacker' }, EXITING), ['foreign-destination']);
    assert.deepEqual(exitProblems(CLOSE, { ...EXITING, chainTokens: tokenUnits(1n) }), ['account-not-empty']);
    assert.deepEqual(exitProblems({ ...CLOSE, inAmount: tokenUnits(5n) }, EXITING), ['close-with-amount']);
  });

  it('only a position whose tokens are all sold (exiting) can be closed: the ledger settles a close from no other state', () => {
    for (const status of ['opening', 'open', 'stuck', 'closed'] as const) {
      assert.deepEqual(exitProblems(CLOSE, { ...EXITING, position: { ...EXITING.position, status } }), ['nothing-to-close']);
    }
  });

  it('no close while a sell is still in flight', () => {
    assert.deepEqual(exitProblems(CLOSE, { ...EXITING, inFlightSellTokens: tokenUnits(1n) }), ['sells-in-flight']);
  });

  it('a stuck position may still try to sell (RISK_POLICY s.3a retries)', () => {
    assert.deepEqual(problems({}, { position: { ...CONTEXT.position, status: 'stuck' } }), []);
  });
});

describe('fresh quote and slippage cap', () => {
  it('the quote at most 25 slots old, and never from the future', () => {
    assert.deepEqual(problems({ quoteSlot: 975n }), []);
    assert.deepEqual(problems({ quoteSlot: 974n }), ['stale-quote']);
    assert.deepEqual(problems({ quoteSlot: 1_001n }), ['stale-quote']);
  });

  it('a protective or emergency exit still needs a fresh quote: it sells at the next one, with the wide cap', () => {
    assert.deepEqual(problems({ urgency: 'protective', slippageBps: bps(1_000), quoteSlot: 974n }), ['stale-quote']);
    assert.deepEqual(problems({ urgency: 'emergency', slippageBps: bps(1_000), quoteSlot: 974n }), ['stale-quote']);
  });

  it('normal exits within 3%; protective and emergency within 10%', () => {
    assert.deepEqual(problems({ slippageBps: bps(301) }), ['slippage-above-cap']);
    assert.deepEqual(problems({ urgency: 'protective', slippageBps: bps(1_001) }), ['slippage-above-cap']);
    assert.deepEqual(problems({ urgency: 'emergency', slippageBps: bps(1_001) }), ['slippage-above-cap']);
  });
});

describe('fail closed on malformed input', () => {
  it('refuses bad slots, counts, urgencies, statuses, ids and caps', () => {
    assert.throws(() => problems({ quoteSlot: -1n }), RiskError);
    assert.throws(() => problems({ quoteSlot: 5 as unknown as bigint }), RiskError);
    assert.throws(() => problems({}, { inFlightExits: -1 }), RiskError);
    assert.throws(() => problems({ urgency: 'panic' as 'normal' }), RiskError);
    assert.throws(() => problems({}, { position: { ...CONTEXT.position, status: 'gone' as 'open' } }), RiskError);
    assert.throws(() => problems({ account: '../x' }), RiskError);
    assert.throws(() => problems({}, { caps: { ...CONTEXT.caps, planFreshSlots: 0 } }), RiskError);
    assert.throws(() => problems({}, { caps: { ...CONTEXT.caps, normalSlippageBps: bps(1_200) } }), RiskError);
    assert.throws(() => exitProblems(null as unknown as ExitPlan, CONTEXT), RiskError);
    assert.throws(() => exitProblems(SELL, null as unknown as ExitContext), RiskError);
  });

  it('refuses slippage caps that would block the sells they exist for', () => {
    const caps = (normal: number, emergency: number) => ({ caps: { planFreshSlots: 25, normalSlippageBps: bps(normal), emergencySlippageBps: bps(emergency) } });
    assert.throws(() => problems({}, caps(300, 0)), /emergency/); // /panic could never sell
    assert.throws(() => problems({}, caps(300, 299)), /emergency/); // emergency tighter than normal
    assert.throws(() => problems({}, caps(300, 1_001)), /emergency/);
    assert.throws(() => problems({}, caps(99, 1_000)), /normal/);
    assert.throws(() => problems({}, caps(501, 1_000)), /normal/);
    assert.deepEqual(problems({ slippageBps: bps(100) }, caps(100, 100)), []);
    assert.deepEqual(problems({ slippageBps: bps(500) }, caps(500, 1_000)), []);
  });

  it('reads each plan field once, so a value cannot change between check and use', () => {
    let reads = 0;
    const plan = {
      ...SELL,
      get destination(): string {
        reads += 1;
        return reads === 1 ? 'OurWallet' : 'Attacker';
      },
    };
    assert.deepEqual(exitProblems(plan, CONTEXT), []);
    assert.equal(reads, 1);
  });
});
