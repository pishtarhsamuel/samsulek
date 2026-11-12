// Reduce-only exits (RISK_POLICY.md s.9; invariants 4, 5 and 19). Exits are approved under kill,
// halt, pause, the daily stop and every breaker, so this check reads no flag at all; it allows only
// plans that can only reduce risk: a sell of at most the sellable amount of the position's own
// token into SOL, or the close of our own empty token account, always from our own token account
// and with the proceeds or the rent going to our own wallet, one exit in flight per position, on a
// fresh quote and within the slippage cap. Pure; an empty list is the only "yes". Malformed input
// throws (RiskError or AmountError), which the engine treats as "refuse".
//
// NOT checked here, and required before any exit gets an approval token (the plan re-check of
// RISK_POLICY.md s.6 step 5, REVIEWS.md entry G): minOut against the expected output and the
// declared slippage; the exit fee caps of limit 18 (CU price, CU limit, tip); the failed-fee
// budget of s.3a; the plan's mode against the position's; a sell that also closes the account.
// The caller takes wallet, ownTokenAccount and wsolMint from config or derivation, never from
// the plan, and passes the highest slot it has seen as currentSlot.
import { isIdText } from '../core/ids.ts';
import { bps, tokenUnits, type Bps, type TokenUnits } from '../core/units.ts';
import { RiskError } from './reserve.ts';

/** RISK_POLICY.md limits 17 and 20 (H values and bounds; move to config/caps.ts in step 5). */
const HARD_PLAN_FRESH_SLOTS = 25;
const MIN_NORMAL_SLIPPAGE_BPS = 100;
const HARD_NORMAL_SLIPPAGE_BPS = 500;
const HARD_EMERGENCY_SLIPPAGE_BPS = 1_000;

export type ExitUrgency = 'normal' | 'protective' | 'emergency';
export type ExitPositionStatus = 'opening' | 'open' | 'exiting' | 'stuck' | 'closed';

/** The fields of an order plan that decide whether it only reduces risk. */
export interface ExitPlan {
  readonly kind: 'sell' | 'close-account';
  readonly positionId: string;
  readonly inputMint: string;
  readonly outputMint: string;
  /** Token units to sell; 0 for a close. */
  readonly inAmount: TokenUnits;
  readonly slippageBps: Bps;
  readonly urgency: ExitUrgency;
  readonly quoteSlot: bigint;
  /** The token account the tokens leave (a sell) or that is closed: our own, for this mint. */
  readonly account: string;
  /** Where the SOL goes (sale proceeds, or the rent of a close): our wallet. */
  readonly destination: string;
}

export interface ExitCaps {
  /** A plan's reserves at most this many slots old (limit 20, H 25). */
  readonly planFreshSlots: number;
  /** Normal exits (limit 17: default 3%, bounds 1% to 5%). */
  readonly normalSlippageBps: Bps;
  /** Protective and emergency exits: at least the normal cap, at most 10%. */
  readonly emergencySlippageBps: Bps;
}

export interface ExitContext {
  /** The highest slot seen, so a lagging provider cannot make a fresh quote look stale. */
  readonly currentSlot: bigint;
  readonly position: { readonly id: string; readonly mint: string; readonly status: ExitPositionStatus };
  readonly ledgerTokens: TokenUnits;
  /** The token account's balance read from the chain (paper: the paper chain). */
  readonly chainTokens: TokenUnits;
  /** Token units in sells already submitted and not yet settled. */
  readonly inFlightSellTokens: TokenUnits;
  /** Exit orders of this position already in flight. */
  readonly inFlightExits: number;
  readonly ownTokenAccount: string;
  readonly wallet: string;
  readonly wsolMint: string;
  readonly caps: ExitCaps;
}

export type ExitProblem =
  | 'not-reduce-only'
  | 'wrong-position'
  | 'wrong-mint'
  | 'not-into-sol'
  | 'foreign-account'
  | 'foreign-destination'
  | 'nothing-to-sell'
  | 'empty-sell'
  | 'above-sellable'
  | 'nothing-to-close'
  | 'close-with-amount'
  | 'account-not-empty'
  | 'sells-in-flight'
  | 'exit-in-flight'
  | 'stale-quote'
  | 'slippage-above-cap';

const STATUSES: readonly ExitPositionStatus[] = ['opening', 'open', 'exiting', 'stuck', 'closed'];
const URGENCIES: readonly ExitUrgency[] = ['normal', 'protective', 'emergency'];

function object<T>(what: string, value: T): T {
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

/** The caps, read once: fresh slots 1-25; 1% <= normal <= 5%; normal <= emergency <= 10%. */
export function checkExitCaps(capsInput: ExitCaps): { fresh: bigint; normal: Bps; emergency: Bps } {
  const { planFreshSlots, normalSlippageBps, emergencySlippageBps } = object('caps', capsInput);
  if (
    typeof planFreshSlots !== 'number' ||
    !Number.isSafeInteger(planFreshSlots) ||
    planFreshSlots < 1 ||
    planFreshSlots > HARD_PLAN_FRESH_SLOTS
  ) {
    throw new RiskError(`planFreshSlots must be a whole number from 1 to ${HARD_PLAN_FRESH_SLOTS}`);
  }
  const normal = bps(normalSlippageBps);
  const emergency = bps(emergencySlippageBps);
  if (normal < MIN_NORMAL_SLIPPAGE_BPS || normal > HARD_NORMAL_SLIPPAGE_BPS) {
    throw new RiskError('the normal exit slippage cap must be from 1% to 5%');
  }
  if (emergency < normal || emergency > HARD_EMERGENCY_SLIPPAGE_BPS) {
    // An emergency cap below the normal one (or 0) would refuse the very sells /panic needs.
    throw new RiskError('the emergency exit slippage cap must be from the normal cap to 10%');
  }
  return { fresh: BigInt(planFreshSlots), normal, emergency };
}

/** Every reason this exit plan is refused; an empty list approves it, whatever the flags say. */
export function exitProblems(planInput: ExitPlan, contextInput: ExitContext): readonly ExitProblem[] {
  // Every field is read once into a local, so a value cannot change between check and use.
  const { kind, urgency, ...plan } = object('plan', planInput);
  const context = object('context', contextInput);
  if (kind !== 'sell' && kind !== 'close-account') {
    return Object.freeze(['not-reduce-only'] as ExitProblem[]); // a reduce-only path never buys or withdraws
  }
  const { id: heldId, mint: heldMint, status } = object('position', context.position);
  if (!STATUSES.includes(status)) {
    throw new RiskError('unknown position status');
  }
  if (!URGENCIES.includes(urgency)) {
    throw new RiskError('unknown exit urgency');
  }
  const caps = checkExitCaps(context.caps);
  const inAmount = tokenUnits(plan.inAmount);
  const slippage = bps(plan.slippageBps);
  const ledger = tokenUnits(context.ledgerTokens);
  const chain = tokenUnits(context.chainTokens);
  const inFlight = tokenUnits(context.inFlightSellTokens);
  const exits = context.inFlightExits;
  if (typeof exits !== 'number' || !Number.isSafeInteger(exits) || exits < 0) {
    throw new RiskError('inFlightExits must be a whole number of at least 0');
  }
  const current = slot('currentSlot', context.currentSlot);
  const quoted = slot('quoteSlot', plan.quoteSlot);
  // Every id is checked whatever the kind: a malformed field means a bug upstream.
  const positionId = id('positionId', plan.positionId);
  const inputMint = id('inputMint', plan.inputMint);
  const outputMint = id('outputMint', plan.outputMint);
  const account = id('account', plan.account);
  const destination = id('destination', plan.destination);

  const problems: ExitProblem[] = [];
  const add = (problem: ExitProblem, applies: boolean): void => {
    if (applies) {
      problems.push(problem);
    }
  };
  add('wrong-position', positionId !== id('position id', heldId));
  add('wrong-mint', inputMint !== id('position mint', heldMint));
  add('not-into-sol', outputMint !== id('wsolMint', context.wsolMint));
  // For sells too: this check runs under kill and halt, so proceeds must never leave to a stranger.
  add('foreign-account', account !== id('ownTokenAccount', context.ownTokenAccount));
  add('foreign-destination', destination !== id('wallet', context.wallet));

  if (kind === 'sell') {
    const held = ledger < chain ? ledger : chain;
    const sellable = held > inFlight ? held - inFlight : 0n;
    add('nothing-to-sell', status !== 'open' && status !== 'stuck');
    add('empty-sell', inAmount === 0n);
    add('above-sellable', inAmount > sellable);
  } else {
    // The ledger settles a close only from 'exiting' (every token sold): never for open or stuck.
    add('nothing-to-close', status !== 'exiting');
    add('close-with-amount', inAmount !== 0n);
    add('account-not-empty', ledger !== 0n || chain !== 0n);
    add('sells-in-flight', inFlight !== 0n);
  }
  add('exit-in-flight', exits > 0);
  add('stale-quote', quoted > current || current - quoted > caps.fresh);
  add('slippage-above-cap', slippage > (urgency === 'normal' ? caps.normal : caps.emergency));
  return Object.freeze(problems);
}
