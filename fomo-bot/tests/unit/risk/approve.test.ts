// The approval step (T1; ARCHITECTURE.md s.4, RISK_POLICY.md s.6): the one place where entry blocks,
// sizing, the fee reserve, the plan re-check and the token come together, in this order, on ONE
// snapshot of the world. What it adds to the parts (tested on their own) is what only the
// composition can get wrong: counting EVERY opening, open, exiting and stuck position in the caps and
// in the reserve (the new one included), holding back the SOL that buys in flight will still spend,
// sizing from the lower of start-of-day and current equity, one position per mint, and issuing the
// token last, once, only if everything passed. Exits never pass through the blocks (s.9): their
// function has no flag input at all, so no flag can stop one. TEST_PLAN.md s.3 step 4, s.4
// invariants 2, 3, 4, 17 and 19.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGY_IDS, type StrategyId } from '../../../src/core/ids.ts';
import { AmountError, bps, lamports, microLamportsPerCu, type Lamports } from '../../../src/core/units.ts';
import {
  approveBuy,
  approveExit,
  buyLimitViolations,
  type ActivePosition,
  type BuyApprovalInput,
  type BuyDecision,
  type BuyLimitCheck,
  type EntryFlags,
} from '../../../src/risk/approve.ts';
import { createApprovalAuthority, type ApprovalAuthority, type TokenStore } from '../../../src/risk/approval.ts';
import { planMaxSpend, type OrderPlan } from '../../../src/risk/plan.ts';
import { RiskError, feeReserve } from '../../../src/risk/reserve.ts';
import { CAPS, RESERVE_CAPS, SIZING_CAPS, WSOL, passingContext } from './fixtures.ts';

const KEY = Uint8Array.from({ length: 32 }, (_v, i) => i + 1);
const NOW = 1_800_000_000_000;
const SLOT = 1_005n;
const L = (n: bigint): Lamports => lamports(n);

const PLAN: OrderPlan = {
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
/** One attempt at the plan's fees: 5,000 + ceil(200,000 x 300,000 / 10^6) + 1,000. */
const ATTEMPT = 66_000n;
/** What sizing sets aside beyond the size: the rent and every allowed attempt (3). */
const OVERHEAD = 1_488_440n + 3n * ATTEMPT;

const SELL: OrderPlan = { ...PLAN, orderId: 'order-2', kind: 'sell', inAmount: 400_000n, rentLamports: lamports(0n) };
const PAPER_MODES: Readonly<Record<StrategyId, 'paper'>> = { crowdflow: 'paper', momentum: 'paper', launch: 'paper' };

const FLAGS: EntryFlags = {
  kill: false,
  haltReasons: [],
  haltClearedAt: null,
  paused: false,
  dailyStop: false,
  entriesStopped: false,
  equityJumpPending: false,
  modes: PAPER_MODES,
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

interface Patch {
  intent?: Partial<BuyApprovalInput['intent']>;
  plan?: Partial<OrderPlan>;
  world?: Partial<Omit<BuyApprovalInput['world'], 'flags'>>;
  flags?: Partial<EntryFlags>;
  market?: Partial<BuyApprovalInput['market']>;
  caps?: Partial<BuyApprovalInput['caps']>;
}

/** A buy that passes everything: 1 SOL of equity and wallet, no positions, size 0.06 SOL, a 0.055 SOL plan. */
function scenario(patch: Patch = {}): BuyApprovalInput {
  return {
    intent: { strategy: 'crowdflow', mode: 'paper', mint: 'MintA', creator: 'CreatorA', sizeHint: 'normal', positionId: 'p-new', intentId: 'intent-1', ...patch.intent },
    plan: { ...PLAN, ...patch.plan },
    world: {
      now: NOW,
      currentSlot: SLOT,
      flags: { ...FLAGS, ...patch.flags },
      positions: [],
      equity: { current: L(1_000_000_000n), dayStart: L(1_000_000_000n) },
      walletSol: L(1_000_000_000n),
      ...patch.world,
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
      liveRampHalf: false,
      ...patch.market,
    },
    caps: { sizing: SIZING_CAPS, reserve: RESERVE_CAPS, plan: CAPS, ...patch.caps },
  };
}

/** An opening position carries its worst-case spend, the others their value (what each counts for in the caps). */
function pos(id: string, mint: string, status: ActivePosition['status'], value: bigint, strategy: StrategyId = 'crowdflow', p95 = 125_000n): ActivePosition {
  const base = { id, mint, strategy, p95ExitCost: L(p95) };
  return status === 'opening' ? { ...base, status, maxSpend: L(value) } : { ...base, status, value: L(value) };
}

/** An authority that counts the tokens it mints. */
function authority(mode: 'paper' | 'live' = 'paper'): { a: ApprovalAuthority; minted: () => number } {
  let n = 0;
  const a = createApprovalAuthority({ mode, key: KEY, newTokenId: () => `tok-${(n += 1)}`, planFreshSlots: 25 });
  return { a, minted: () => n };
}

class MemoryStore implements TokenStore {
  readonly seen = new Set<string>();
  consume(tokenId: string): boolean {
    if (this.seen.has(tokenId)) {
      return false;
    }
    this.seen.add(tokenId);
    return true;
  }
}

function decide(patch: Patch = {}): { decision: BuyDecision; minted: number; a: ApprovalAuthority } {
  const { a, minted } = authority();
  const decision = approveBuy(scenario(patch), a.issuer);
  return { decision, minted: minted(), a };
}

function refused(decision: BuyDecision): { stage: 'blocked' | 'sizing' | 'plan'; reasons: readonly string[] } {
  assert.equal(decision.approved, false);
  if (decision.approved) {
    throw new Error('unreachable');
  }
  return decision;
}

describe('approveBuy: a buy that passes everything', () => {
  it('approves with a token for exactly that plan, the size, and what the engine must record', () => {
    const { decision, minted, a } = decide();
    assert.equal(decision.approved, true);
    if (!decision.approved) {
      return;
    }
    assert.equal(minted, 1);
    assert.equal(decision.size, 60_000_000n);
    assert.equal(decision.binding, 'per-position');
    assert.equal(decision.limitedBy, 'per-position');
    assert.deepEqual(decision.opening, {
      id: 'p-new',
      mint: 'MintA',
      strategy: 'crowdflow',
      mode: 'paper',
      openedAt: NOW,
      maxSpend: planMaxSpend(PLAN), // the opening position counts at its worst-case spend
    });
    assert.equal(decision.opening.maxSpend, 55_000_000n + OVERHEAD);
    assert.equal(decision.entriesToday, 1);
    assert.equal(decision.token.kind, 'buy');
    assert.equal(decision.token.intentId, 'intent-1'); // the engine's intent, which the plan had to carry
    assert.equal(decision.token.reduceOnly, false);
    assert.equal(decision.token.maxSpendLamports, decision.opening.maxSpend);
    assert.deepEqual(a.verifier.verify(decision.token, PLAN, { currentSlot: SLOT, mode: 'paper' }), []);
    // the executor redeems it once, from the frozen plan
    const store = new MemoryStore();
    const first = a.verifier.redeem(decision.token, PLAN, { currentSlot: SLOT, mode: 'paper' }, store);
    assert.equal(first.ok, true);
    assert.deepEqual(a.verifier.redeem(decision.token, PLAN, { currentSlot: SLOT, mode: 'paper' }, store), { ok: false, problems: ['already-consumed'] });
  });

  it('the decision is frozen and the input is never changed', () => {
    const input = scenario({ world: { positions: [pos('p1', 'MintX', 'open', 10_000_000n)] } });
    const frozen = JSON.stringify(input, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v instanceof Map ? [...v] : v instanceof Set ? [...v] : v));
    const decision = approveBuy(input, authority().a.issuer);
    assert.ok(Object.isFrozen(decision));
    assert.equal(JSON.stringify(input, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v instanceof Map ? [...v] : v instanceof Set ? [...v] : v)), frozen);
  });

  it('a launch entry needs launch mode, and sizes against the launch room (25% of the exposure cap)', () => {
    const ok = decide({ intent: { strategy: 'launch' } });
    assert.equal(ok.decision.approved, true);
    // a crowdflow position does not use the launch room; a launch position does
    const other = decide({ intent: { strategy: 'launch' }, world: { positions: [pos('p1', 'MintX', 'open', 60_000_000n, 'crowdflow')] } });
    assert.equal(other.decision.approved, true);
    const used = refused(decide({ intent: { strategy: 'launch' }, world: { positions: [pos('p1', 'MintX', 'open', 60_000_000n, 'launch')] } }).decision);
    assert.equal(used.stage, 'sizing'); // room 75M - 60M - 1.7M = 13.3M, below the 20M minimum
    assert.deepEqual(used.reasons, ['sizing:below-minimum']);
  });
});

describe('the entry blocks stop a buy before sizing and before any token (s.6 step 1)', () => {
  const cases: ReadonlyArray<readonly [string, Patch, string]> = [
    ['kill', { flags: { kill: true } }, 'kill'],
    ['halt', { flags: { haltReasons: ['PAPER_LEDGER'] } }, 'halt'],
    ['pause', { flags: { paused: true } }, 'pause'],
    ['daily stop', { flags: { dailyStop: true } }, 'daily-stop'],
    ['all entries stopped', { flags: { entriesStopped: true } }, 'entries-stopped'],
    ['a held equity jump', { flags: { equityJumpPending: true } }, 'equity-jump-check'],
    ['clean data after a halt', { flags: { haltClearedAt: NOW - 60_000 } }, 'halt-recovery'],
    ['strategy off', { flags: { modes: { ...PAPER_MODES, crowdflow: 'off' } } }, 'strategy-off'],
    ['mode mismatch', { flags: { modes: { ...PAPER_MODES, crowdflow: 'live' } } }, 'mode-mismatch'],
    ['a breaker', { flags: { breakers: [{ name: 'DATA_STALE', scope: { kind: 'all' }, until: null }] } }, 'breaker:DATA_STALE'],
    ['a breaker for this venue', { flags: { breakers: [{ name: 'VENUE_CHANGED', scope: { kind: 'venue', venue: 'pumpswap' }, until: null }] } }, 'breaker:VENUE_CHANGED'],
    ['strategy cooldown', { flags: { strategyPausedUntil: { crowdflow: NOW + 1 } } }, 'strategy-cooldown'],
    ['strategy off for the day', { flags: { strategyOffUntil: { crowdflow: NOW + 1 } } }, 'strategy-off-today'],
    ['token cooldown', { flags: { tokenCooldownUntil: new Map([['MintA', NOW + 1]]) } }, 'token-cooldown'],
    ['banned token', { flags: { bannedMints: new Set(['MintA']) } }, 'token-banned'],
    ['blocked creator', { flags: { blockedCreators: new Set(['CreatorA']) } }, 'creator-blocked'],
    ['entries per day reached', { flags: { entriesToday: 8 } }, 'entries-per-day'],
    ['unknown equity', { world: { equity: { current: null, dayStart: L(1_000_000_000n) } } }, 'equity-unknown'],
  ];
  for (const [name, patch, reason] of cases) {
    it(`${name}: refused as ${reason}, nothing minted`, () => {
      const { decision, minted } = decide(patch);
      const r = refused(decision);
      assert.equal(r.stage, 'blocked');
      assert.ok(r.reasons.includes(reason), r.reasons.join());
      assert.equal(minted, 0);
    });
  }

  it('every reason that applies is listed', () => {
    const r = refused(decide({ flags: { kill: true, paused: true, dailyStop: true } }).decision);
    assert.deepEqual(r.reasons, ['kill', 'pause', 'daily-stop']);
  });

  it('one position per token: an opening, open, exiting or stuck position in the same mint blocks it', () => {
    for (const status of ['opening', 'open', 'exiting', 'stuck'] as const) {
      const r = refused(decide({ world: { positions: [pos('p1', 'MintA', status, 10_000_000n)] } }).decision);
      assert.deepEqual(r.reasons, ['token-active'], status);
    }
  });

  it('the position cap counts every opening, open, exiting and stuck position in the snapshot (not a flag)', () => {
    const four = [pos('p1', 'M1', 'opening', 10_000_000n), pos('p2', 'M2', 'open', 10_000_000n), pos('p3', 'M3', 'exiting', 10_000_000n), pos('p4', 'M4', 'stuck', 0n)];
    assert.deepEqual(refused(decide({ world: { positions: four } }).decision).reasons, ['max-positions']);
    assert.equal(decide({ world: { positions: four.slice(0, 3) } }).decision.approved, true); // the fourth is the new one
  });
});

describe('sizing sees every position and the SOL buys in flight still hold (s.6 steps 2-4)', () => {
  it('open positions count at their value and opening ones at their worst-case spend, in the exposure caps', () => {
    // 290M of exposure leaves 300M - 290M - 1.69M = 8.3M under the absolute cap: below the 20M minimum
    const r = refused(
      decide({ world: { positions: [pos('p1', 'M1', 'opening', 100_000_000n), pos('p2', 'M2', 'open', 100_000_000n), pos('p3', 'M3', 'open', 90_000_000n)] } }).decision,
    );
    assert.equal(r.stage, 'sizing');
    assert.deepEqual(r.reasons, ['sizing:below-minimum']);
  });

  it('a plan above what is left under a cap is refused by the re-check, to the lamport', () => {
    const exposed = (used: bigint) => decide({ world: { positions: [pos('p1', 'M1', 'open', used)] } }).decision;
    // room = 300M - used - overhead; the plan needs 55M
    const exact = 300_000_000n - 55_000_000n - OVERHEAD;
    assert.equal(exposed(exact).approved, true);
    assert.deepEqual(refused(exposed(exact + 1n)).reasons, ['plan:in-amount-above-sized']);
  });

  it('SOL held back for buys in flight: the free SOL is the wallet minus the opening positions\' spend, minus the reserve after this buy', () => {
    // one opening position holding 20M; N = 2 positions after this buy, so the reserve is the 10M floor
    const opening = [pos('p1', 'M1', 'opening', 20_000_000n)];
    const need = 20_000_000n + 55_000_000n + 10_000_000n + OVERHEAD;
    assert.equal(decide({ world: { positions: opening, walletSol: L(need) } }).decision.approved, true);
    assert.deepEqual(refused(decide({ world: { positions: opening, walletSol: L(need - 1n) } }).decision).reasons, ['plan:in-amount-above-sized']);
    // the same wallet with an OPEN position of that value holds nothing back
    const open = [pos('p1', 'M1', 'open', 20_000_000n)];
    assert.equal(decide({ world: { positions: open, walletSol: L(need - 20_000_000n) } }).decision.approved, true);
  });

  it('SOL left after the buy covers the fee reserve with every position, the new one included, to the lamport', () => {
    const three = [pos('p1', 'M1', 'open', 10_000_000n), pos('p2', 'M2', 'open', 10_000_000n), pos('p3', 'M3', 'open', 10_000_000n)];
    const reserve4 = feeReserve({ p95ExitCosts: [L(125_000n), L(125_000n), L(125_000n), L(125_000n)], wsolHelper: false }, RESERVE_CAPS);
    assert.equal(reserve4, 13_520_000n); // 4 x 3,380,000: above the 10M floor, so the count of positions matters
    const need = 55_000_000n + reserve4 + OVERHEAD;
    assert.equal(decide({ world: { positions: three, walletSol: L(need) } }).decision.approved, true);
    assert.deepEqual(refused(decide({ world: { positions: three, walletSol: L(need - 1n) } }).decision).reasons, ['plan:in-amount-above-sized']);
  });

  it('the wSOL helper rent is held back when any exit needs it', () => {
    const three = [pos('p1', 'M1', 'open', 10_000_000n), pos('p2', 'M2', 'open', 10_000_000n), pos('p3', 'M3', 'open', 10_000_000n)];
    const need = 55_000_000n + 13_520_000n + 1_488_440n + OVERHEAD;
    assert.equal(decide({ world: { positions: three, walletSol: L(need) }, market: { wsolHelper: true } }).decision.approved, true);
    assert.equal(refused(decide({ world: { positions: three, walletSol: L(need - 1n) }, market: { wsolHelper: true } }).decision).stage, 'plan');
  });

  it('the new position\'s own exit cost joins the reserve (2 x the sum of the p95 costs can be the larger)', () => {
    const big = L(10_000_000n); // a p95 exit cost of 0.01 SOL: 2 x (0 + 10M) = 20M > the 10M floor
    const need = 55_000_000n + 20_000_000n + OVERHEAD;
    assert.equal(decide({ world: { walletSol: L(need) }, market: { newPositionP95ExitCost: big } }).decision.approved, true);
    assert.equal(refused(decide({ world: { walletSol: L(need - 1n) }, market: { newPositionP95ExitCost: big } }).decision).stage, 'plan');
  });

  it('size comes from the LOWER of start-of-day and current equity: a price spike never makes a trade bigger', () => {
    // 10% of 300M = 30M, below the 55M plan
    const low = refused(decide({ world: { equity: { current: L(1_000_000_000n), dayStart: L(300_000_000n) } } }).decision);
    assert.deepEqual(low.reasons, ['plan:in-amount-above-sized']);
    const lowNow = refused(decide({ world: { equity: { current: L(300_000_000n), dayStart: L(1_000_000_000n) } } }).decision);
    assert.deepEqual(lowNow.reasons, ['plan:in-amount-above-sized']);
    // no baseline yet today (0): the current equity is used; a higher baseline changes nothing
    assert.equal(decide({ world: { equity: { current: L(1_000_000_000n), dayStart: L(0n) } } }).decision.approved, true);
    assert.equal(decide({ world: { equity: { current: L(1_000_000_000n), dayStart: L(5_000_000_000n) } } }).decision.approved, true);
  });

  it('equity too small for the minimum trade stops the entry at the sizing stage and says so', () => {
    const r = refused(decide({ world: { equity: { current: L(100_000_000n), dayStart: L(100_000_000n) } } }).decision);
    assert.equal(r.stage, 'sizing');
    assert.deepEqual(r.reasons, ['sizing:equity-below-minimum']);
  });

  it('a pool whose cost rule asks for more than the size left refuses this entry only', () => {
    const r = refused(decide({ market: { poolMinTrade: L(70_000_000n) } }).decision); // size 60M < 70M
    assert.equal(r.stage, 'sizing');
    assert.deepEqual(r.reasons, ['sizing:below-minimum']);
  });

  it('the live ramp halves the size, the min hint trades the minimum, pool share caps it', () => {
    assert.deepEqual(refused(decide({ market: { liveRampHalf: true } }).decision).reasons, ['plan:in-amount-above-sized']); // 30M < 55M
    // (a cheaper CU limit keeps the landing spend, priority + tip, inside 0.2% of a 20M swap)
    const small = decide({ plan: { inAmount: 20_000_000n, expectedOut: 400_000_000n, minOut: 392_000_000n, cuLimit: 100_000 }, intent: { sizeHint: 'min' }, market: { quotedOut: 400_000_000n } });
    assert.equal(small.decision.approved && small.decision.size, 20_000_000n);
    // pool share: 0.5% of a pool of 2 x 5 SOL real reserve = 50M
    const thin = refused(decide({ market: { poolRealSolReserve: L(5_000_000_000n) } }).decision);
    assert.deepEqual(thin.reasons, ['plan:in-amount-above-sized']);
  });
});

describe('the plan is re-checked against what sizing decided (s.6 step 5)', () => {
  const planCases: ReadonlyArray<readonly [string, Patch, string]> = [
    ['a plan above the size', { plan: { inAmount: 60_000_001n } }, 'plan:in-amount-above-sized'],
    ['a plan below the minimum', { plan: { inAmount: 19_999_999n } }, 'plan:in-amount-below-minimum'],
    ['another mint than the intent', { plan: { mint: 'MintB' } }, 'plan:wrong-mint'],
    ['another position than the one being opened', { plan: { positionId: 'p-other' } }, 'plan:wrong-position'],
    ['a pool the safety filter did not approve', { market: { pool: { id: 'PoolB', venue: 'pumpswap', quoteMint: WSOL } } }, 'plan:wrong-pool'],
    ['a pool not quoted in SOL', { market: { pool: { id: 'PoolA', venue: 'pumpswap', quoteMint: 'UsdcMint' } } }, 'plan:pool-not-sol'],
    ['a minOut under the declared slippage', { plan: { minOut: 1n } }, 'plan:min-out-below-slippage'],
    ['rent that is not what the account needs', { market: { rentRequired: L(0n) } }, 'plan:rent-mismatch'],
    ['more attempts than allowed', { plan: { attempts: 4 } }, 'plan:attempts-above-allowed'],
    ['another mode than the entry', { plan: { mode: 'live' } }, 'plan:wrong-mode'],
    ['a foreign wallet', { market: { wallet: 'Someone' } }, 'plan:foreign-wallet'],
    ['a foreign token account', { market: { ownTokenAccount: 'AtaOther' } }, 'plan:foreign-token-account'],
    ['a CU price above the cap', { plan: { cuPrice: microLamportsPerCu(200_001n) } }, 'plan:cu-price-above-cap'],
    ['another intent than the engine\'s', { plan: { intentId: 'intent-9' } }, 'plan:wrong-intent'],
    ['a cheaper fee than risk read (paper would look better)', { plan: { feeBps: bps(0) } }, 'plan:fee-config-mismatch'],
    ['a quote from another slot than risk\'s', { plan: { quoteSlot: 999n } }, 'plan:quote-slot-mismatch'],
    // caps misconfigured far above the hard limits: sizing lets 70M through, the re-check's backstop does not (REVIEWS.md K, finding 5)
    ['a buy above 0.06 SOL under misconfigured caps', { plan: { inAmount: 70_000_000n }, caps: { sizing: { ...SIZING_CAPS, maxPositionLamports: L(500_000_000n) } } }, 'plan:in-amount-above-hard-max'],
  ];
  for (const [name, patch, reason] of planCases) {
    it(`${name}: refused as ${reason}, nothing minted`, () => {
      const { decision, minted } = decide(patch);
      const r = refused(decision);
      assert.equal(r.stage, 'plan');
      assert.ok(r.reasons.includes(reason), r.reasons.join());
      assert.equal(minted, 0);
    });
  }

  it('only a buy plan: a sell or a withdraw is refused here, whatever else is true', () => {
    for (const kind of ['sell', 'close-account', 'withdraw'] as const) {
      const r = refused(decide({ plan: { kind } }).decision);
      assert.deepEqual(r, { approved: false, stage: 'plan', reasons: ['plan:not-a-buy'] });
    }
  });

  it('the blocks come first: a blocked buy never reaches sizing or the plan', () => {
    const r = refused(decide({ flags: { paused: true }, plan: { inAmount: 999_999_999n, mint: 'MintB' } }).decision);
    assert.deepEqual(r.reasons, ['pause']);
  });
});

describe('malformed input fails closed (any throw is a refusal for the engine)', () => {
  const bad = (patch: Patch, what: string): void => {
    assert.throws(
      () => approveBuy(scenario(patch), authority().a.issuer),
      (e: unknown) => e instanceof RiskError || e instanceof AmountError,
      what,
    );
  };

  it('a snapshot of positions that cannot be real', () => {
    bad({ world: { positions: 'none' as unknown as ActivePosition[] } }, 'not a list');
    bad({ world: { positions: [null as unknown as ActivePosition] } }, 'not an object');
    bad({ world: { positions: [pos('p1', 'M1', 'closed' as ActivePosition['status'], 0n)] } }, 'a closed position is not active');
    bad({ world: { positions: [pos('p1', 'M1', 'open', 1n), pos('p2', 'M1', 'open', 1n)] } }, 'two positions in one mint');
    bad({ world: { positions: [pos('p1', 'M1', 'open', 1n), pos('p1', 'M2', 'open', 1n)] } }, 'two positions with one id');
    bad({ world: { positions: [pos('p-new', 'M1', 'open', 1n)] } }, 'the new position already exists');
    bad({ world: { positions: [{ ...pos('p1', 'M1', 'open', 1n), value: -1n as Lamports } as ActivePosition] } }, 'a negative value');
    bad({ world: { positions: [{ ...pos('p1', 'M1', 'opening', 1n), maxSpend: -1n as Lamports } as ActivePosition] } }, 'a negative worst-case spend');
    bad({ world: { positions: [{ ...pos('p1', 'M1', 'opening', 1n), value: L(1n) } as unknown as ActivePosition] } }, 'an opening position carrying a mark');
    bad({ world: { positions: [{ ...pos('p1', 'M1', 'opening', 1n), maxSpend: undefined } as unknown as ActivePosition] } }, 'an opening position without its maxSpend');
    bad({ world: { positions: [{ ...pos('p1', 'M1', 'open', 1n), maxSpend: L(1n) } as unknown as ActivePosition] } }, 'an open position carrying a worst-case spend');
    bad({ world: { positions: [{ ...pos('p1', 'M1', 'open', 1n), value: undefined } as unknown as ActivePosition] } }, 'an open position without its value');
    bad({ world: { positions: [{ ...pos('p1', 'M1', 'open', 1n), strategy: 'other' as StrategyId }] } }, 'an unknown strategy');
    bad({ world: { positions: [{ ...pos('p1', 'bad id!', 'open', 1n) }] } }, 'a bad id');
    bad({ world: { positions: Array.from({ length: 1_001 }, (_v, i) => pos(`p${i}`, `M${i}`, 'open', 1n)) } }, 'not a portfolio');
  });

  it('more positions than the cap (a cap lowered after they opened) blocks the entry, it is not an error', () => {
    const five = Array.from({ length: 5 }, (_v, i) => pos(`p${i}`, `M${i}`, 'open', 1_000_000n));
    assert.deepEqual(refused(decide({ world: { positions: five } }).decision).reasons, ['max-positions']);
    assert.deepEqual(refused(decide({ world: { positions: five.slice(0, 2) }, flags: { maxPositions: 2 } }).decision).reasons, ['max-positions']);
  });

  it('bad amounts, slots, times and shapes', () => {
    bad({ world: { walletSol: -1n as Lamports } }, 'negative SOL');
    bad({ world: { walletSol: 5 as unknown as Lamports } }, 'SOL as a number');
    bad({ world: { currentSlot: -1n } }, 'a negative slot');
    bad({ world: { now: Number.NaN } }, 'now');
    bad({ world: { equity: null as unknown as BuyApprovalInput['world']['equity'] } }, 'no equity object');
    bad({ world: { equity: { current: 5 as unknown as Lamports, dayStart: L(1n) } } }, 'equity as a number');
    bad({ intent: { strategy: 'copy' as StrategyId } }, 'an unknown strategy');
    bad({ intent: { sizeHint: 'big' as 'min' } }, 'a bad size hint');
    bad({ intent: { mode: 'both' as 'paper' } }, 'a bad mode');
    bad({ intent: { positionId: 'bad id!' } }, 'a bad position id');
    bad({ market: { attemptsAllowed: 0 } }, 'zero attempts');
    bad({ market: { wsolHelper: 1 as unknown as boolean } }, 'a helper flag that is not a boolean');
    bad({ market: { liveRampHalf: 'yes' as unknown as boolean } }, 'a ramp flag that is not a boolean');
    bad({ market: { simulatedCu: 1.5 } }, 'fractional CU');
    bad({ plan: { inAmount: -1n } }, 'a malformed plan');
    bad({ flags: { entriesPerDay: 0 } }, 'a malformed flag set');
  });

  it('a missing issuer is refused, and a paper authority cannot approve a live entry', () => {
    assert.throws(() => approveBuy(scenario(), null as unknown as ApprovalAuthority['issuer']), RiskError);
    assert.throws(() => approveBuy(scenario(), {} as ApprovalAuthority['issuer']), RiskError);
    // live entry, live plan, paper authority: the issuer refuses (one mode per authority)
    const live = scenario({ intent: { mode: 'live' }, plan: { mode: 'live' }, flags: { modes: { ...FLAGS.modes, crowdflow: 'live' } }, market: { simulatedCu: 250_000 } });
    assert.throws(() => approveBuy(live, authority('paper').a.issuer), RiskError);
    assert.equal(approveBuy(live, authority('live').a.issuer).approved, true);
  });
});

describe('buyLimitViolations: the last, independent check of the hard limits, from the plan\'s own numbers', () => {
  const ok: BuyLimitCheck = {
    plan: PLAN,
    strategy: 'crowdflow',
    activePositions: 0,
    maxPositions: 4,
    sameMintActive: false,
    sizingEquity: L(1_000_000_000n),
    exposure: L(0n),
    launchExposure: L(0n),
    poolRealSolReserve: L(20_000_000_000n),
    walletSol: L(1_000_000_000n),
    held: L(0n),
    reserveAfterBuy: L(10_000_000n),
    caps: SIZING_CAPS,
  };
  const spend = 55_000_000n + OVERHEAD;

  it('nothing for a plan within every limit', () => {
    assert.deepEqual(buyLimitViolations(ok), []);
  });

  it('each limit is detected on its own, to the lamport', () => {
    assert.deepEqual(buyLimitViolations({ ...ok, activePositions: 4 }), ['positions']);
    assert.deepEqual(buyLimitViolations({ ...ok, activePositions: 3 }), []);
    assert.deepEqual(buyLimitViolations({ ...ok, sameMintActive: true }), ['one-per-mint']);
    assert.deepEqual(buyLimitViolations({ ...ok, sizingEquity: L(549_999_999n) }), ['per-trade']); // 10% of equity is 54,999,999
    assert.deepEqual(buyLimitViolations({ ...ok, sizingEquity: L(550_000_000n) }), []);
    assert.deepEqual(buyLimitViolations({ ...ok, caps: { ...SIZING_CAPS, maxPositionLamports: L(54_999_999n) } }), ['per-position']);
    assert.deepEqual(buyLimitViolations({ ...ok, caps: { ...SIZING_CAPS, exposureBps: bps(500) } }), ['exposure']); // 5% of 1 SOL = 50M < 56.7M
    assert.deepEqual(buyLimitViolations({ ...ok, caps: { ...SIZING_CAPS, maxExposureLamports: L(spend - 1n) } }), ['exposure-absolute']);
    assert.deepEqual(buyLimitViolations({ ...ok, caps: { ...SIZING_CAPS, maxExposureLamports: L(spend) } }), []);
    assert.deepEqual(buyLimitViolations({ ...ok, poolRealSolReserve: L(4_999_999_999n) }), ['pool-share']); // 0.5% of 2 x the reserve: 49,999,999
    assert.deepEqual(buyLimitViolations({ ...ok, poolRealSolReserve: L(5_500_000_000n) }), []);
    assert.deepEqual(buyLimitViolations({ ...ok, walletSol: L(spend + 10_000_000n - 1n) }), ['reserve']);
    assert.deepEqual(buyLimitViolations({ ...ok, walletSol: L(spend + 10_000_000n) }), []);
    assert.deepEqual(buyLimitViolations({ ...ok, held: L(20_000_000n), walletSol: L(spend + 30_000_000n - 1n) }), ['reserve']); // buys in flight still hold their spend
  });

  it('the launch strategy has its own share of the exposure cap (25%): only for launch', () => {
    // 25% of the 300M absolute cap is 75M: 20M already in launch positions + 56.7M > 75M
    const launch = { ...ok, strategy: 'launch' as const, launchExposure: L(20_000_000n) };
    assert.deepEqual(buyLimitViolations(launch), ['launch']);
    assert.deepEqual(buyLimitViolations({ ...launch, strategy: 'crowdflow' }), []);
    assert.deepEqual(buyLimitViolations({ ...launch, launchExposure: L(75_000_000n - spend) }), []);
    assert.deepEqual(buyLimitViolations({ ...launch, launchExposure: L(75_000_000n - spend + 1n) }), ['launch']);
    // the effective cap is the lower of the percentage and the absolute one: 50% of 400M = 200M, so 25% of it is 50M < 56.7M
    const small = { ...launch, launchExposure: L(0n), sizingEquity: L(400_000_000n), caps: { ...SIZING_CAPS, perTradeBps: bps(2_000) } };
    assert.deepEqual(buyLimitViolations(small), ['launch']);
    assert.deepEqual(buyLimitViolations({ ...small, strategy: 'momentum' }), []);
  });

  it('several violations are all reported, in a fixed order', () => {
    assert.deepEqual(buyLimitViolations({ ...ok, activePositions: 4, sameMintActive: true, walletSol: L(0n) }), ['positions', 'one-per-mint', 'reserve']);
  });

  it('a malformed check fails closed', () => {
    assert.throws(() => buyLimitViolations({ ...ok, walletSol: -1n as Lamports }), Error);
    assert.throws(() => buyLimitViolations({ ...ok, maxPositions: 0 }), RiskError);
    assert.throws(() => buyLimitViolations({ ...ok, plan: { ...PLAN, attempts: 0 } }), RiskError);
  });
});

describe('approveExit: reduce-only exits have no flag to be blocked by (s.9)', () => {
  const exit = (plan: OrderPlan, mode: 'paper' | 'live' = 'paper') => {
    const { a, minted } = authority(mode);
    return { decision: approveExit({ plan, context: passingContext(plan) }, a.issuer), minted, a };
  };

  it('a valid sell or close gets a reduce-only token, whatever the flags: it has no flag input', () => {
    assert.equal(approveExit.length, 2); // (input, issuer): there is no place to pass kill, halt, pause or a breaker
    const { decision, minted, a } = exit(SELL);
    assert.equal(decision.approved, true);
    assert.equal(minted(), 1);
    if (decision.approved) {
      assert.equal(decision.token.reduceOnly, true);
      assert.equal(decision.token.kind, 'sell');
      assert.deepEqual(a.verifier.verify(decision.token, SELL, { currentSlot: SELL.quoteSlot + 5n, mode: 'paper' }), []);
      assert.ok(Object.isFrozen(decision));
    }
  });

  it('a plan that fails the reduce-only rules is refused with every problem, nothing minted', () => {
    const plan: OrderPlan = { ...SELL, wallet: 'Someone' };
    const context = { ...passingContext(SELL) };
    const { a, minted } = authority();
    const decision = approveExit({ plan, context }, a.issuer);
    assert.equal(decision.approved, false);
    if (!decision.approved) {
      assert.ok(decision.problems.length > 0);
    }
    assert.equal(minted(), 0);
  });

  it('only a sell or a close: a buy or a withdraw never gets a token from here', () => {
    for (const kind of ['buy', 'withdraw'] as const) {
      const { decision, minted } = exit({ ...SELL, kind });
      assert.deepEqual(decision, { approved: false, problems: ['not-an-exit'] });
      assert.equal(minted(), 0);
    }
  });

  it('the exit context is required, and the issuer is too', () => {
    const { a } = authority();
    assert.throws(() => approveExit({ plan: SELL, context: { ...passingContext(SELL), exit: null } }, a.issuer), RiskError);
    assert.throws(() => approveExit({ plan: SELL, context: passingContext(SELL) }, null as unknown as ApprovalAuthority['issuer']), RiskError);
  });
});

describe('the token is made last, once, and only for a plan that passed (invariant 1)', () => {
  it('every refusal leaves the authority untouched: the next approval gets the first id', () => {
    const { a } = authority();
    const refusedOnce = approveBuy(scenario({ flags: { kill: true } }), a.issuer);
    assert.equal(refusedOnce.approved, false);
    const ok = approveBuy(scenario(), a.issuer);
    assert.equal(ok.approved && ok.token.id, 'tok-1');
  });

  it('the strategies are all sized, in their own mode', () => {
    for (const strategy of STRATEGY_IDS) {
      assert.equal(decide({ intent: { strategy } }).decision.approved, true, strategy);
    }
  });
});
