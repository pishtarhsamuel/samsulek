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
import { createHmac, timingSafeEqual } from 'node:crypto';
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

/** H 25 slots (RISK_POLICY.md limit 20); the caller may choose less. Moves to config/caps.ts in step 5. */
const HARD_PLAN_FRESH_SLOTS = 25;
const MIN_KEY_BYTES = 32;
const MAC_PURPOSE = 'fomo-bot approval token v1';
/** The newest token ids kept to catch a repeated id; older ones are forgotten so memory stays bounded. */
const MAX_REMEMBERED_IDS = 10_000;

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

export interface VerifyContext {
  /** The highest slot seen. */
  readonly currentSlot: bigint;
  /** The mode the executor runs in; it must be the authority's mode. */
  readonly mode: PlanMode;
}

/** Records that a token was used. true: first use. false: already used. Anything else, or a throw: refused. */
export interface TokenStore {
  consume(tokenId: string): boolean;
}

export type TokenProblem =
  | 'malformed-token'
  | 'bad-mac'
  | 'malformed-plan'
  | 'malformed-context'
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
  issue(plan: CheckedPlan, currentSlot: bigint): ApprovalToken;
}

export interface ApprovalVerifier {
  verify(token: ApprovalToken, plan: OrderPlan, context: VerifyContext): readonly TokenProblem[];
  /** verify, then consume: ok means the order may run, once, from the returned plan. */
  redeem(token: ApprovalToken, plan: OrderPlan, context: VerifyContext, store: TokenStore): RedeemResult;
}

export interface ApprovalAuthority {
  readonly issuer: ApprovalIssuer;
  readonly verifier: ApprovalVerifier;
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

function parseContext(input: unknown): VerifyContext | null {
  if (typeof input !== 'object' || input === null) {
    return null;
  }
  const { currentSlot, mode } = input as Record<string, unknown>;
  if (!isU64(currentSlot) || !(PLAN_MODES as readonly unknown[]).includes(mode)) {
    return null;
  }
  return { currentSlot, mode: mode as PlanMode };
}

interface Checked {
  readonly problems: readonly TokenProblem[];
  readonly id: string | null;
  readonly plan: OrderPlan | null;
}

const refuse = (problem: TokenProblem): Checked => ({ problems: Object.freeze([problem]), id: null, plan: null });

// ---------------------------------------------------------------- the authority

export function createApprovalAuthority(options: ApprovalOptions): ApprovalAuthority {
  const { mode, key, newTokenId, planFreshSlots } = options as Partial<ApprovalOptions>;
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
  const authorityMode = mode as PlanMode;
  const fresh = BigInt(planFreshSlots);
  const issued = new Set<string>();

  // A purpose and version tag in front of the canonical text: this key's MAC can only ever mean "approval token".
  const macOf = (fields: TokenFields): Uint8Array =>
    createHmac('sha256', secret).update(`${MAC_PURPOSE}\n${canonicalJson(fields)}`, 'utf8').digest();

  const issuer: ApprovalIssuer = {
    issue(plan: CheckedPlan, currentSlot: bigint): ApprovalToken {
      if (!isCheckedPlan(plan)) {
        throw new RiskError('the plan has not passed the re-check, or its token was already issued');
      }
      if (plan.mode !== authorityMode) {
        throw new RiskError('this authority issues tokens for its own mode only');
      }
      if (!isU64(currentSlot)) {
        throw new RiskError('currentSlot must be a non-negative bigint slot');
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
  const check = (tokenInput: unknown, planInput: unknown, contextInput: unknown): Checked => {
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
    let context: VerifyContext | null;
    try {
      context = parseContext(contextInput);
    } catch {
      context = null;
    }
    if (context === null) {
      return refuse('malformed-context');
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
    add('wrong-mode', token.mode !== plan.mode || token.mode !== context.mode || token.mode !== authorityMode);
    add('wrong-kind', token.kind !== plan.kind);
    add('wrong-intent', token.intentId !== plan.intentId);
    add('wrong-position', token.positionId !== plan.positionId);
    add('wrong-reduce-only', token.reduceOnly !== reduceOnlyKind(plan.kind));
    add('max-spend-mismatch', token.maxSpendLamports !== spend);
    add('min-out-mismatch', token.minOut !== plan.minOut);
    add('expired', context.currentSlot > token.expiresAtSlot);
    add('expiry-too-late', token.expiresAtSlot > plan.quoteSlot + fresh);
    return { problems: Object.freeze(problems), id: token.id, plan };
  };

  const verifier: ApprovalVerifier = {
    verify: (token, plan, context) => check(token, plan, context).problems,
    redeem(token, plan, context, store): RedeemResult {
      const { problems, id, plan: snapshot } = check(token, plan, context);
      if (problems.length > 0 || id === null || snapshot === null) {
        return Object.freeze({ ok: false, problems });
      }
      let consumed: unknown;
      try {
        consumed = store.consume(id);
      } catch {
        consumed = undefined; // no proof of single use: never approve
      }
      if (consumed === true) {
        return Object.freeze({ ok: true, plan: snapshot });
      }
      const problem: TokenProblem = consumed === false ? 'already-consumed' : 'store-error';
      return Object.freeze({ ok: false, problems: Object.freeze([problem]) });
    },
  };

  return Object.freeze({ issuer: Object.freeze(issuer), verifier: Object.freeze(verifier) });
}
