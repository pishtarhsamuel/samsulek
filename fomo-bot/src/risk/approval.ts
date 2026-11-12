// Approval tokens (ARCHITECTURE.md s.3; RISK_POLICY.md invariants 1 and 19). An order runs only with
// a token that risk issued for exactly that plan, and only a plan that passed the re-check
// (recheck.ts checkPlan) can be issued one. The token carries the plan hash, mode, kind,
// worst-case spend, minOut and an expiry slot, all under an HMAC-SHA256 with a per-boot key that
// only the authority holds. It works once, in one mode, for one intent, and expires at most
// planFreshSlots after the quote. createApprovalAuthority returns two capabilities: the issuer,
// which only risk's approval code receives, and a verifier for the executor, which can check and
// redeem tokens but can never make one. An authority serves one mode: a paper process never mints
// a live token. verify and redeem never throw, whatever they are given (hostile getters and
// Proxies included): anything malformed is refused with a problem. redeem hands back the frozen
// validated plan; the executor must build its transaction from that snapshot, never from the
// object it passed in. Single use is the TokenStore's job (T2 in SQLite, in the same transaction as
// the order); redeem verifies first and consumes last, so a bad token is never burned, and it
// accepts only an explicit `true` from the store. Issuing spends the plan's re-check
// (recheck.ts consumeCheckedPlan): one checked plan, at most one token.
// The store and the slot source are bound when the authority is created (in app/, the composition
// root) and never come from a caller (REVIEWS.md K, security findings 2 and 3): an executor cannot
// hand redeem a store that always says "first use", nor a slot that makes an expired token look
// fresh. The store receives the validated snapshot, so T2 records the order from it, never from the
// executor's objects. The slot only moves forward (a ratchet over what the source reports), and an
// unknown slot refuses every issue, verify and redeem.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { HARD_CAPS } from '../config/caps.ts';
import { isIdText } from '../core/ids.ts';
import { U64_MAX, type Lamports } from '../core/units.ts';
import {
  PLAN_KINDS,
  PLAN_MODES,
  canonicalJson,
  planHash,
  planMaxSpend,
  validatePlan,
  type OrderPlan,
  type PlanKind,
  type PlanMode,
} from './plan.ts';
import { consumeCheckedPlan, isCheckedPlan, type CheckedPlan } from './recheck.ts';
import { RiskError } from './reserve.ts';

declare const approvedBrand: unique symbol;

/** H 25 slots (RISK_POLICY.md limit 20, config/caps.ts); the caller may choose less. */
const HARD_PLAN_FRESH_SLOTS = HARD_CAPS.planFreshSlots;
const MIN_KEY_BYTES = 32;
const MAC_PURPOSE = 'fomo-bot approval token v1';
/** The newest token ids kept to catch a repeated id; older ones are forgotten so memory stays bounded. */
const MAX_REMEMBERED_IDS = 10_000;
/**
 * No real slot is above what the database's INTEGER columns can hold (2^63 - 1; the chain is near
 * 4 x 10^8): a reading above it is a parse bug or a lying RPC (u64::MAX, say), is unknown and is never
 * adopted, so it cannot stick in the ratchet (REVIEWS.md N). Plausibility against time and a second
 * provider is app/slots.ts's job: this pure code has no clock.
 */
const MAX_PLAUSIBLE_SLOT = (1n << 63n) - 1n;

export interface ApprovalToken {
  /** Only risk's issuer makes one: a literal cannot be built outside this module, and a forged one fails its MAC. */
  readonly [approvedBrand]: true;
  readonly id: string;
  readonly intentId: string;
  readonly mode: PlanMode;
  readonly kind: PlanKind;
  /** True for a sell or a close: such a token can only reduce risk. */
  readonly reduceOnly: boolean;
  readonly positionId: string;
  readonly planHash: string;
  readonly maxSpendLamports: Lamports;
  readonly minOut: bigint;
  readonly expiresAtSlot: bigint;
  readonly mac: string;
}

/** The highest slot seen, from the chain stream and HTTP; null when unknown or stale. */
export interface SlotSource {
  currentSlot(): bigint | null;
}

/** What redeem validated: the store records the order from this, never from the executor's objects. */
export interface RedeemSnapshot {
  readonly intentId: string;
  readonly positionId: string;
  readonly mode: PlanMode;
  readonly kind: PlanKind;
  readonly reduceOnly: boolean;
  readonly planHash: string;
  readonly maxSpendLamports: Lamports;
  readonly minOut: bigint;
  readonly expiresAtSlot: bigint;
  /** The slot redeem judged the expiry at (from the bound slot source). */
  readonly slot: bigint;
  /** The frozen, validated plan. */
  readonly plan: OrderPlan;
}

/** Records that a token was used. true: first use. false: already used. Anything else, or a throw: refused. */
export interface TokenStore {
  consume(tokenId: string, snapshot: RedeemSnapshot): boolean;
}

export type TokenProblem =
  | 'malformed-token'
  | 'bad-mac'
  | 'malformed-plan'
  | 'slot-unknown'
  | 'kind-not-allowed'
  | 'plan-hash-mismatch'
  | 'wrong-mode'
  | 'wrong-kind'
  | 'wrong-intent'
  | 'wrong-position'
  | 'wrong-reduce-only'
  | 'max-spend-mismatch'
  | 'min-out-mismatch'
  | 'expired'
  | 'expiry-too-late'
  | 'already-consumed'
  | 'store-error';

/** The outcome of redeem: on success the frozen validated plan to build the transaction from. */
export type RedeemResult =
  | { readonly ok: true; readonly plan: OrderPlan }
  | { readonly ok: false; readonly problems: readonly TokenProblem[] };

export interface ApprovalIssuer {
  /** The current slot comes from the bound slot source, never from the caller. */
  issue(plan: CheckedPlan): ApprovalToken;
}

export interface ApprovalVerifier {
  /** The mode this verifier (and its authority) serves, so the composition root can assert its wiring. */
  readonly mode: PlanMode;
  verify(token: ApprovalToken, plan: OrderPlan): readonly TokenProblem[];
  /** verify, then consume in the bound store: ok means the order may run, once, from the returned plan. */
  redeem(token: ApprovalToken, plan: OrderPlan): RedeemResult;
}

/**
 * What the executor receives: redeem only. verify says "valid" without consuming, so an executor that
 * traded after verify would skip single use; it stays with the composition root for diagnostics
 * (REVIEWS.md N, security finding 2).
 */
export interface ApprovalRedeemer {
  readonly mode: PlanMode;
  redeem(token: ApprovalToken, plan: OrderPlan): RedeemResult;
}

export interface ApprovalAuthority {
  readonly issuer: ApprovalIssuer;
  /** verify and redeem, for the composition root. */
  readonly verifier: ApprovalVerifier;
  /** redeem only, for the executor. */
  readonly redeemer: ApprovalRedeemer;
}

export interface ApprovalOptions {
  /** The one mode this authority serves. */
  readonly mode: PlanMode;
  /** A per-boot random key of at least 32 bytes (core/rng.ts makes it); the authority keeps its own copy. */
  readonly key: Uint8Array;
  /** A fresh, unique id for every token (core/rng.ts). */
  readonly newTokenId: () => string;
  /** A token expires this many slots after its plan's quote (1 to 25). */
  readonly planFreshSlots: number;
  /** Where the current slot comes from (app/slots.ts); read on every issue, verify and redeem. */
  readonly slots: SlotSource;
  /** The single-use store (app/token-store.ts: T2 in SQLite). */
  readonly store: TokenStore;
}

// ---------------------------------------------------------------- token fields and MAC

interface TokenFields {
  readonly id: string;
  readonly intentId: string;
  readonly mode: PlanMode;
  readonly kind: PlanKind;
  readonly reduceOnly: boolean;
  readonly positionId: string;
  readonly planHash: string;
  readonly maxSpendLamports: bigint;
  readonly minOut: bigint;
  readonly expiresAtSlot: bigint;
}

interface ParsedToken extends TokenFields {
  readonly mac: string;
}

/** The names of a token's own fields, sorted: nothing missing, nothing extra. */
const TOKEN_FIELDS: readonly string[] = Object.freeze([
  'expiresAtSlot', 'id', 'intentId', 'kind', 'mac', 'maxSpendLamports', 'minOut', 'mode', 'planHash', 'positionId', 'reduceOnly',
]);
const HEX_32_BYTES = /^[0-9a-f]{64}$/;

const isU64 = (value: unknown): value is bigint => typeof value === 'bigint' && value >= 0n && value <= U64_MAX;
const reduceOnlyKind = (kind: PlanKind): boolean => kind === 'sell' || kind === 'close-account';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(text: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    bytes[i] = Number.parseInt(text.slice(2 * i, 2 * i + 2), 16);
  }
  return bytes;
}

/** The token as a typed copy, each field read once; null for anything that is not exactly a token. */
function parseToken(input: unknown): ParsedToken | null {
  if (typeof input !== 'object' || input === null || Object.getOwnPropertySymbols(input).length > 0) {
    return null;
  }
  const names = Object.getOwnPropertyNames(input).sort();
  if (names.length !== TOKEN_FIELDS.length || names.some((name, i) => name !== TOKEN_FIELDS[i])) {
    return null;
  }
  const { id, intentId, mode, kind, reduceOnly, positionId, planHash: hash, maxSpendLamports, minOut, expiresAtSlot, mac } =
    input as Record<string, unknown>;
  if (
    !isIdText(id) ||
    !isIdText(intentId) ||
    !isIdText(positionId) ||
    !(PLAN_MODES as readonly unknown[]).includes(mode) ||
    !(PLAN_KINDS as readonly unknown[]).includes(kind) ||
    typeof reduceOnly !== 'boolean' ||
    typeof hash !== 'string' ||
    !HEX_32_BYTES.test(hash) ||
    typeof mac !== 'string' ||
    !HEX_32_BYTES.test(mac) ||
    !isU64(maxSpendLamports) ||
    !isU64(minOut) ||
    !isU64(expiresAtSlot)
  ) {
    return null;
  }
  return { id, intentId, mode: mode as PlanMode, kind: kind as PlanKind, reduceOnly, positionId, planHash: hash, maxSpendLamports, minOut, expiresAtSlot, mac };
}

/** A capability's method, read once at creation and bound, so a later change to the object changes nothing. */
function boundMethod(what: string, owner: unknown, name: string): (...args: unknown[]) => unknown {
  if (typeof owner !== 'object' || owner === null) {
    throw new RiskError(`${what} must be an object`);
  }
  let method: unknown;
  try {
    method = (owner as Record<string, unknown>)[name];
  } catch {
    method = undefined;
  }
  if (typeof method !== 'function') {
    throw new RiskError(`${what}.${name} must be a function`);
  }
  return (method as (...args: unknown[]) => unknown).bind(owner);
}

interface Checked {
  readonly problems: readonly TokenProblem[];
  readonly token: ParsedToken | null;
  readonly plan: OrderPlan | null;
  readonly slot: bigint | null;
}

const refuse = (problem: TokenProblem): Checked => ({ problems: Object.freeze([problem]), token: null, plan: null, slot: null });

// ---------------------------------------------------------------- the authority

export function createApprovalAuthority(options: ApprovalOptions): ApprovalAuthority {
  const { mode, key, newTokenId, planFreshSlots, slots, store } = options as Partial<ApprovalOptions>;
  if (!(PLAN_MODES as readonly unknown[]).includes(mode)) {
    throw new RiskError('the authority needs a mode: paper or live');
  }
  if (!(key instanceof Uint8Array)) {
    throw new RiskError('the approval key must be a Uint8Array');
  }
  // Copy first, validate the copy: a subclass cannot hand the check one thing and the MAC another.
  const secret = Uint8Array.from(key);
  if (secret.length < MIN_KEY_BYTES || secret.every((byte) => byte === 0)) {
    throw new RiskError(`the approval key must be at least ${MIN_KEY_BYTES} random bytes`);
  }
  if (typeof newTokenId !== 'function') {
    throw new RiskError('newTokenId must be a function');
  }
  if (typeof planFreshSlots !== 'number' || !Number.isSafeInteger(planFreshSlots) || planFreshSlots < 1 || planFreshSlots > HARD_PLAN_FRESH_SLOTS) {
    throw new RiskError(`planFreshSlots must be a whole number from 1 to ${HARD_PLAN_FRESH_SLOTS}`);
  }
  const readSlot = boundMethod('slots', slots, 'currentSlot');
  const consume = boundMethod('store', store, 'consume');
  const authorityMode = mode as PlanMode;
  const fresh = BigInt(planFreshSlots);
  const issued = new Set<string>();

  // The highest slot the source has reported: a source that goes backwards never lengthens a token's
  // life. A throw, null or anything but a u64 slot means unknown (null), and an unknown slot refuses.
  let highest: bigint | null = null;
  const slotNow = (): bigint | null => {
    let reported: unknown;
    try {
      reported = readSlot();
    } catch {
      return null;
    }
    if (!isU64(reported) || reported > MAX_PLAUSIBLE_SLOT) {
      return null;
    }
    if (highest === null || reported > highest) {
      highest = reported;
    }
    return highest;
  };

  // A purpose and version tag in front of the canonical text: this key's MAC can only ever mean "approval token".
  const macOf = (fields: TokenFields): Uint8Array =>
    createHmac('sha256', secret).update(`${MAC_PURPOSE}\n${canonicalJson(fields)}`, 'utf8').digest();

  const issuer: ApprovalIssuer = {
    issue(plan: CheckedPlan): ApprovalToken {
      if (!isCheckedPlan(plan)) {
        throw new RiskError('the plan has not passed the re-check, or its token was already issued');
      }
      if (plan.mode !== authorityMode) {
        throw new RiskError('this authority issues tokens for its own mode only');
      }
      const currentSlot = slotNow();
      if (currentSlot === null) {
        throw new RiskError('the current slot is unknown: no token is issued');
      }
      const expiresAtSlot = plan.quoteSlot + fresh;
      if (plan.quoteSlot > currentSlot) {
        throw new RiskError('the plan quote is from the future');
      }
      if (currentSlot > expiresAtSlot) {
        throw new RiskError('the plan has expired');
      }
      const id: unknown = newTokenId();
      if (!isIdText(id)) {
        throw new RiskError('newTokenId must return a plain id');
      }
      if (issued.has(id)) {
        throw new RiskError('that token id was already issued');
      }
      const fields: TokenFields = {
        id,
        intentId: plan.intentId,
        mode: plan.mode,
        kind: plan.kind,
        reduceOnly: reduceOnlyKind(plan.kind),
        positionId: plan.positionId,
        planHash: planHash(plan),
        maxSpendLamports: planMaxSpend(plan),
        minOut: plan.minOut,
        expiresAtSlot,
      };
      // Spend the re-check last, after the only callback (newTokenId) has run: one checked plan gives
      // at most one token, even if that callback came back into issue with the same plan.
      if (!consumeCheckedPlan(plan)) {
        throw new RiskError('the plan already has a token');
      }
      const token = Object.freeze({ ...fields, mac: toHex(macOf(fields)) }) as unknown as ApprovalToken;
      issued.add(id);
      if (issued.size > MAX_REMEMBERED_IDS) {
        for (const oldest of issued) {
          issued.delete(oldest); // the Set iterates oldest first
          break;
        }
      }
      return token;
    },
  };

  /** Everything but the single-use consumption. Never throws: any surprise is a refusal. */
  const check = (tokenInput: unknown, planInput: unknown): Checked => {
    let token: ParsedToken | null;
    try {
      token = parseToken(tokenInput);
    } catch {
      token = null; // a hostile getter or Proxy
    }
    if (token === null) {
      return refuse('malformed-token');
    }
    const { mac, ...fields } = token;
    if (!timingSafeEqual(macOf(fields), fromHex(mac))) {
      return refuse('bad-mac');
    }
    let plan: OrderPlan;
    try {
      plan = validatePlan(planInput as OrderPlan);
    } catch {
      return refuse('malformed-plan');
    }
    const slot = slotNow();
    if (slot === null) {
      return refuse('slot-unknown');
    }
    let spend: bigint | null;
    try {
      spend = planMaxSpend(plan);
    } catch {
      spend = null; // an overflowing plan can never match a token's spend
    }
    const problems: TokenProblem[] = [];
    const add = (problem: TokenProblem, applies: boolean): void => {
      if (applies) {
        problems.push(problem);
      }
    };
    add('kind-not-allowed', token.kind === 'withdraw' || plan.kind === 'withdraw'); // withdraws have their own path
    add('plan-hash-mismatch', token.planHash !== planHash(plan));
    add('wrong-mode', token.mode !== plan.mode || token.mode !== authorityMode);
    add('wrong-kind', token.kind !== plan.kind);
    add('wrong-intent', token.intentId !== plan.intentId);
    add('wrong-position', token.positionId !== plan.positionId);
    add('wrong-reduce-only', token.reduceOnly !== reduceOnlyKind(plan.kind));
    add('max-spend-mismatch', token.maxSpendLamports !== spend);
    add('min-out-mismatch', token.minOut !== plan.minOut);
    add('expired', slot > token.expiresAtSlot);
    add('expiry-too-late', token.expiresAtSlot > plan.quoteSlot + fresh);
    return { problems: Object.freeze(problems), token, plan, slot };
  };

  const verifier: ApprovalVerifier = {
    mode: authorityMode,
    verify: (token, plan) => check(token, plan).problems,
    redeem(tokenInput, planInput): RedeemResult {
      const { problems, token, plan, slot } = check(tokenInput, planInput);
      if (problems.length > 0 || token === null || plan === null || slot === null) {
        return Object.freeze({ ok: false, problems });
      }
      // What the store records: the token as verified and the frozen plan, never the caller's objects.
      const snapshot: RedeemSnapshot = Object.freeze({
        intentId: token.intentId,
        positionId: token.positionId,
        mode: token.mode,
        kind: token.kind,
        reduceOnly: token.reduceOnly,
        planHash: token.planHash,
        maxSpendLamports: token.maxSpendLamports as Lamports,
        minOut: token.minOut,
        expiresAtSlot: token.expiresAtSlot,
        slot,
        plan,
      });
      let consumed: unknown;
      try {
        consumed = consume(token.id, snapshot);
      } catch {
        consumed = undefined; // no proof of single use: never approve
      }
      if (consumed === true) {
        return Object.freeze({ ok: true, plan });
      }
      const problem: TokenProblem = consumed === false ? 'already-consumed' : 'store-error';
      return Object.freeze({ ok: false, problems: Object.freeze([problem]) });
    },
  };

  const redeemer: ApprovalRedeemer = { mode: authorityMode, redeem: verifier.redeem };
  return Object.freeze({ issuer: Object.freeze(issuer), verifier: Object.freeze(verifier), redeemer: Object.freeze(redeemer) });
}
