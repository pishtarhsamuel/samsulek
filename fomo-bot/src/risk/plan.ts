// The order plan and its fingerprint (ARCHITECTURE.md s.3; RISK_POLICY.md invariant 1). The risk
// engine approves one exact plan: planHash is sha256 over a canonical text of EVERY field (keys
// sorted, bigints as decimal strings), so changing anything, mode and kind included, changes the
// hash. A plan with a missing, extra, inherited or malformed field has no hash at all (fail
// closed), and each field is read exactly once, so a value cannot differ between the check and
// the hash. Every field has its own validator in VALIDATORS, a type that must list all of them:
// adding a field to OrderPlan is a compile error until it is validated, and so hashed.
// Structure only: the limits (spend, fees, tips, slippage) are the plan re-check's job.
import { createHash } from 'node:crypto';
import { isIdText } from '../core/ids.ts';
import { U64_MAX, echoText, lamports, type Bps, type Lamports, type MicroLamportsPerCu } from '../core/units.ts';
import { RiskError, attemptCost, maxSpend } from './reserve.ts';

export const PLAN_MODES = Object.freeze(['paper', 'live'] as const);
export const PLAN_KINDS = Object.freeze(['buy', 'sell', 'close-account', 'withdraw'] as const);
export const PLAN_URGENCIES = Object.freeze(['normal', 'protective', 'emergency'] as const);
export const VENUES = Object.freeze(['pump-curve', 'pumpswap', 'raydium-cpmm'] as const);
export const ROUTES = Object.freeze(['direct', 'jupiter-build', 'jupiter-order'] as const);
export const TIP_PATHS = Object.freeze(['none', 'jito', 'helius-swqos'] as const);

export type PlanMode = (typeof PLAN_MODES)[number];
export type PlanKind = (typeof PLAN_KINDS)[number];
export type PlanUrgency = (typeof PLAN_URGENCIES)[number];
export type Venue = (typeof VENUES)[number];
export type Route = (typeof ROUTES)[number];
export type TipPath = (typeof TIP_PATHS)[number];

export interface OrderPlan {
  readonly orderId: string;
  readonly intentId: string;
  readonly positionId: string;
  readonly mode: PlanMode;
  readonly kind: PlanKind;
  readonly urgency: PlanUrgency;
  readonly venue: Venue;
  readonly route: Route;
  readonly mint: string;
  readonly pool: string;
  /** Our token account for the mint: the one a sell spends from and a close empties. */
  readonly tokenAccount: string;
  /** Our wallet: the signer and the only place proceeds or rent may go. */
  readonly wallet: string;
  readonly inAmount: bigint;
  readonly expectedOut: bigint;
  readonly minOut: bigint;
  readonly slippageBps: Bps;
  readonly feeBps: Bps;
  readonly feeConfigSlot: bigint;
  readonly cuLimit: number;
  readonly cuPrice: MicroLamportsPerCu;
  readonly tip: { readonly path: TipPath; readonly lamports: Lamports };
  readonly rentLamports: Lamports;
  /** Attempts the plan may make (each pays fees); maxSpend counts all of them. */
  readonly attempts: number;
  readonly closeAccountAfter: boolean;
  readonly quoteSlot: bigint;
  readonly lastValidBlockHeight: bigint | null;
}

// ---------------------------------------------------------------- field validators

type Check<T> = (value: unknown) => T;

function fail(what: string, rule: string): never {
  throw new RiskError(`plan field ${what} ${rule}`);
}

const id =
  (what: string): Check<string> =>
  (value) => {
    if (!isIdText(value)) {
      fail(what, 'must be 1-128 characters of A-Z, a-z, 0-9, _ and -');
    }
    return value;
  };

const oneOf =
  <T extends string>(what: string, allowed: readonly T[]): Check<T> =>
  (value) => {
    if (typeof value !== 'string' || !allowed.includes(value as T)) {
      fail(what, `must be one of ${allowed.join(', ')}`);
    }
    return value as T;
  };

const u64 =
  <T extends bigint = bigint>(what: string): Check<T> =>
  (value) => {
    if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) {
      fail(what, 'must be a bigint from 0 to 2^64 - 1');
    }
    return value as T;
  };

const bpsField =
  (what: string): Check<Bps> =>
  (value) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10_000) {
      fail(what, 'must be a whole number from 0 to 10000');
    }
    return value as Bps;
  };

const count =
  (what: string, max: number): Check<number> =>
  (value) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
      fail(what, `must be a whole number from 1 to ${max}`);
    }
    return value;
  };

const flag =
  (what: string): Check<boolean> =>
  (value) => {
    if (typeof value !== 'boolean') {
      fail(what, 'must be a boolean');
    }
    return value;
  };

/** Own properties exactly as listed: nothing missing, nothing extra, nothing hidden or inherited. */
function exactKeys(what: string, value: object, expected: readonly string[]): void {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new RiskError(`${what} must not have symbol keys`);
  }
  const names = Object.getOwnPropertyNames(value);
  for (const name of names) {
    if (!expected.includes(name)) {
      throw new RiskError(`${what} has the unknown field ${echoText(name)}`);
    }
  }
  for (const name of expected) {
    if (!names.includes(name)) {
      throw new RiskError(`${what} is missing the field ${name}`);
    }
  }
}

const tip: Check<OrderPlan['tip']> = (value) => {
  if (typeof value !== 'object' || value === null) {
    fail('tip', 'must be an object');
  }
  exactKeys('tip', value, ['lamports', 'path']);
  const raw = value as Record<string, unknown>;
  return Object.freeze({
    path: oneOf('tip.path', TIP_PATHS)(raw['path']),
    lamports: u64<Lamports>('tip.lamports')(raw['lamports']),
  });
};

const heightOrNull: Check<bigint | null> = (value) =>
  value === null ? null : u64('lastValidBlockHeight')(value);

type Validators = { readonly [K in keyof OrderPlan]: Check<OrderPlan[K]> };

// SetComputeUnitLimit takes a u32.
const MAX_CU_LIMIT = 4_294_967_295;

const VALIDATORS: Validators = {
  orderId: id('orderId'),
  intentId: id('intentId'),
  positionId: id('positionId'),
  mode: oneOf('mode', PLAN_MODES),
  kind: oneOf('kind', PLAN_KINDS),
  urgency: oneOf('urgency', PLAN_URGENCIES),
  venue: oneOf('venue', VENUES),
  route: oneOf('route', ROUTES),
  mint: id('mint'),
  pool: id('pool'),
  tokenAccount: id('tokenAccount'),
  wallet: id('wallet'),
  inAmount: u64('inAmount'),
  expectedOut: u64('expectedOut'),
  minOut: u64('minOut'),
  slippageBps: bpsField('slippageBps'),
  feeBps: bpsField('feeBps'),
  feeConfigSlot: u64('feeConfigSlot'),
  cuLimit: count('cuLimit', MAX_CU_LIMIT),
  cuPrice: u64<MicroLamportsPerCu>('cuPrice'),
  tip,
  rentLamports: u64<Lamports>('rentLamports'),
  attempts: count('attempts', Number.MAX_SAFE_INTEGER),
  closeAccountAfter: flag('closeAccountAfter'),
  quoteSlot: u64('quoteSlot'),
  lastValidBlockHeight: heightOrNull,
};

/** Every field of a plan, sorted: the keys of the canonical text. */
export const PLAN_FIELDS: readonly (keyof OrderPlan)[] = Object.freeze(
  (Object.keys(VALIDATORS) as (keyof OrderPlan)[]).sort(),
);

/**
 * A frozen, plain copy of a valid plan, each field read exactly once; throws RiskError for
 * anything else. Take one snapshot and use it for every check and derived value, so nothing can
 * differ between two reads of the caller's object.
 */
export function validatePlan(planInput: OrderPlan): OrderPlan {
  if (typeof planInput !== 'object' || planInput === null) {
    throw new RiskError('a plan must be an object');
  }
  const plan = planInput as unknown as Record<string, unknown>;
  exactKeys('plan', plan, PLAN_FIELDS);
  const snapshot: Record<string, unknown> = {};
  for (const field of PLAN_FIELDS) {
    snapshot[field] = VALIDATORS[field](plan[field]);
  }
  return Object.freeze(snapshot) as unknown as OrderPlan;
}

// ---------------------------------------------------------------- canonical text and hash

/** Bigints become decimal strings; objects get sorted keys. Everything else is already plain. */
function encode(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString(10);
  }
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = encode(source[key]);
    }
    return sorted;
  }
  return value;
}

/** Canonical JSON of a plain value: keys sorted, bigints as decimal strings. Shared by plans and tokens. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(encode(value));
}

/** The canonical JSON of a valid plan; throws RiskError for anything else. */
export function canonicalPlan(plan: OrderPlan): string {
  return canonicalJson(validatePlan(plan));
}

/** sha256 of the canonical plan, lowercase hex: what an approval token is bound to. */
export function planHash(plan: OrderPlan): string {
  return createHash('sha256').update(canonicalPlan(plan), 'utf8').digest('hex');
}

// ---------------------------------------------------------------- worst-case spend

/** The Solana base fee per signature (a protocol constant). Plans carry one signature: ours. */
export const BASE_FEE_PER_SIGNATURE: Lamports = lamports(5_000n);

/**
 * The most SOL a plan can cost: a buy's swap input plus the rent plus every allowed attempt at its
 * full fee, the tip counted on every attempt (conservative). A sell's or a close's input is tokens,
 * so only its fees count. ARCHITECTURE.md s.3 maxSpendLamports; the approval token carries it.
 */
export function planMaxSpend(planInput: OrderPlan): Lamports {
  const plan = validatePlan(planInput);
  const attempt = attemptCost(
    { signatures: 1, cuPrice: plan.cuPrice, cuLimit: plan.cuLimit, tip: plan.tip.lamports },
    BASE_FEE_PER_SIGNATURE,
  );
  return maxSpend(lamports(plan.kind === 'buy' ? plan.inAmount : 0n), plan.rentLamports, plan.attempts, attempt);
}
