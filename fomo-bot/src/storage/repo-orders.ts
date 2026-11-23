// The money path up to the token (STORAGE_DESIGN.md s.15.6 and s.15.8): what a strategy asked for
// (an entry or exit intent), what risk decided, and the one-time approval, as T1 writes them, each
// checked before its first write. Intents and decisions hold codes and numbers only, through
// jsonParam: no prose and no e.message, no addresses, no lists of numbers (s.12.1). An exit's mode
// and mint come from its position, and each exit intent uses up the position's next exit number. An
// approval is stored only for an approved decision of its own intent, from risk's own token and
// risk's own canonical plan text (plan-text.ts): storage hashes the text itself and requires the
// token's hash, and never reads or stores the MAC. The order itself is written only by T2
// (repo-redeem.ts). Only app/ may import this file (architecture rule).
import { types } from 'node:util';
import { STRATEGY_IDS, type StrategyId } from '../core/ids.ts';
import { tokenUnits, type Lamports, type TokenUnits } from '../core/units.ts';
import type { ApprovalToken } from '../risk/approval.ts';
import type { PlanUrgency } from '../risk/plan.ts';
import type { SizeLimit, SizingCap } from '../risk/sizing.ts';
import {
  amountParam,
  boolCell,
  boolParam,
  codeParam,
  hex64Cell,
  idCell,
  idParam,
  intCell,
  intParam,
  jsonParam,
  lamportsCell,
  msCell,
  msParam,
  signedParam,
  slotCell,
  slotParam,
  tokenUnitsCell,
} from './codec.ts';
import { ORDER_KINDS, planRecordOf, type OrderKind } from './plan-text.ts';
import { advanceExitSeq, readPosition } from './repo-book.ts';
import type { LedgerMode } from './repo-day.ts';
import { cellOneOf, expectChanges, oneOf, required } from './repo-util.ts';
import { SCHEMA_V1_COPIES } from './schema-v1.ts';
import { StorageError, type Reader, type Row, type Tx } from './sqlite.ts';

/** A flat record of named features: whole numbers, amounts, flags and codes. No lists, objects or addresses. */
export type IntentValue = number | bigint | boolean | string | null;
export type IntentInputs = Readonly<Record<string, IntentValue>>;

export interface NewEntryIntent {
  /** 6d: the entry hash (strategy, mint, side, window), at most 63 characters. */
  readonly id: string;
  readonly mode: LedgerMode;
  readonly strategy: StrategyId;
  readonly mint: string;
  /** The position this entry would open: a new one. */
  readonly positionId: string;
  readonly sizeHint: 'min' | 'normal';
  readonly confidenceBps: number | null;
  readonly createdAt: number;
  readonly inputsAsOf: number | null;
  /** 1 to 16 codes. */
  readonly reasons: readonly string[];
  readonly inputs: IntentInputs;
}

/** The exit's mode and mint are read from its position, never taken from the caller. */
export interface NewExitIntent {
  /** 6d: exitIntentId(positionId, exitSeq), at most 63 characters. */
  readonly id: string;
  readonly positionId: string;
  /** Must be the position's stored exit number. */
  readonly exitSeq: number;
  readonly fractionBps: number;
  readonly urgency: PlanUrgency;
  readonly createdAt: number;
  readonly inputsAsOf: number | null;
  /** 1 to 16 codes; s.3.2's `reason`. */
  readonly reasons: readonly string[];
  readonly inputs: IntentInputs;
}

export type RefusalStage = 'blocked' | 'sizing' | 'plan' | 'error';
interface DecisionBase {
  readonly intentId: string;
  readonly at: number;
  /** Must be the active (newest) config version. */
  readonly configVersion: number;
}
export type NewDecision =
  | (DecisionBase & { readonly outcome: 'entry-approved'; readonly slot: bigint; readonly size: Lamports; readonly limitedBy: SizeLimit; readonly binding: SizingCap })
  | (DecisionBase & { readonly outcome: 'exit-approved'; readonly slot: bigint })
  | (DecisionBase & {
      readonly outcome: 'refused';
      readonly stage: RefusalStage;
      /** 1 to 64 codes. */
      readonly reasons: readonly string[];
      /** null only for stage 'error' (the slot was unknown): stored as 0. */
      readonly slot: bigint | null;
    });

export const ORDER_STATUSES = Object.freeze(['approved', 'submitted', 'landed', 'failed', 'expired'] as const);
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface StoredOrder {
  readonly id: string;
  readonly intentId: string;
  readonly tokenId: string;
  readonly positionId: string;
  readonly mode: LedgerMode;
  readonly kind: OrderKind;
  readonly status: OrderStatus;
  readonly planHash: string;
  readonly inAmount: bigint;
  readonly minOut: bigint;
  readonly maxSpend: Lamports;
  readonly quoteSlot: bigint;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ExitsInFlight {
  /** Sells and closes, approved or submitted. */
  readonly count: number;
  /** The sum of those sells' input. */
  readonly sellTokens: TokenUnits;
}

const MODES = Object.freeze(['paper', 'live'] as const);
// risk/sizing.ts has these lists as types only: a Record over each union must name every member
const CAP_SET: Readonly<Record<SizingCap, true>> = {
  'per-trade': true,
  'per-position': true,
  exposure: true,
  'exposure-absolute': true,
  launch: true,
  'pool-share': true,
  'free-sol': true,
};
const LIMIT_SET: Readonly<Record<SizeLimit, true>> = { ...CAP_SET, 'live-ramp': true, 'min-hint': true };
const SIZING_CAPS = Object.freeze(Object.keys(CAP_SET) as SizingCap[]);
const SIZE_LIMITS = Object.freeze(Object.keys(LIMIT_SET) as SizeLimit[]);
const OUTCOMES = Object.freeze(['entry-approved', 'exit-approved', 'refused'] as const);
const STAGES = Object.freeze(['blocked', 'sizing', 'plan', 'error'] as const);
const INTENT_KINDS = Object.freeze(['entry', 'exit'] as const);
const MAX_INTENT_REASONS = 16;
const MAX_DECISION_REASONS = 64;
const MAX_INPUTS = 32;
const MAX_EXIT_SEQ = 999_999;
const INPUT_NAME = /^[a-z][A-Za-z0-9]{0,31}$/;

const INTENT_COUNT = 'SELECT count(*) AS n FROM intents WHERE id = ?';
const POSITION_COUNT = 'SELECT count(*) AS n FROM positions WHERE id = ?';
const INSERT_ENTRY =
  "INSERT INTO intents (id, kind, mode, strategy, mint, position_id, size_hint, confidence_bps, created_at, inputs_as_of, reasons_json, inputs_json) VALUES (?, 'entry', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const INSERT_EXIT =
  "INSERT INTO intents (id, kind, mode, mint, position_id, exit_seq, fraction_bps, urgency, created_at, inputs_as_of, reasons_json, inputs_json) VALUES (?, 'exit', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const INTENT_KIND = 'SELECT kind FROM intents WHERE id = ?';
const NEWEST_VERSION = 'SELECT id FROM config_versions ORDER BY id DESC LIMIT 1';
const INSERT_DECISION =
  'INSERT INTO risk_decisions (intent_id, at, approved, stage, reasons_json, size, limited_by, binding, slot, config_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const DECISION_APPROVED = 'SELECT approved FROM risk_decisions WHERE intent_id = ?';
const INSERT_APPROVAL =
  'INSERT INTO approvals (token_id, intent_id, position_id, mode, kind, reduce_only, plan_hash, max_spend, min_out, quote_slot, expires_at_slot, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const EXITS_IN_FLIGHT = "SELECT kind, in_amount FROM orders WHERE position_id = ? AND kind IN ('sell', 'close-account') AND status IN ('approved', 'submitted')";
const BUY_ORDER =
  "SELECT id, intent_id, token_id, position_id, mode, kind, status, plan_hash, in_amount, min_out, max_spend, quote_slot, created_at, updated_at FROM orders WHERE position_id = ? AND kind = 'buy'";
const OUTSTANDING_EXITS =
  "SELECT count(*) AS n FROM approvals WHERE position_id = ? AND kind IN ('sell', 'close-account') AND consumed_at IS NULL AND expires_at_slot >= ?";
const BUY_TOKEN_EXPIRY = "SELECT expires_at_slot FROM approvals WHERE position_id = ? AND kind = 'buy'";
/** More exit tokens of one position than exit numbers exist is not a book, it is a broken database. */
const MAX_EXIT_TOKENS = MAX_EXIT_SEQ + 1;

const badParam = (what: string): StorageError => new StorageError('bad-param', `expected ${what}`);
const mode = (m: LedgerMode): LedgerMode => oneOf(m, MODES, 'a ledger mode (paper or live)');
const intentCount = (r: Reader, id: string): number => intCell(required(r.get(INTENT_COUNT, id), 'the intent count'), 'n', 0, 1);
const positionCount = (r: Reader, id: string): number => intCell(required(r.get(POSITION_COUNT, id), 'the position count'), 'n', 0, 1);

function wholeParam(v: number, min: number, max: number, what: string): bigint {
  if (!Number.isSafeInteger(v) || v < min || v > max) {
    throw badParam(`${what}: a whole number from ${min} to ${max}`);
  }
  return intParam(v);
}

function exitSeqParam(v: number): bigint {
  return wholeParam(v, 0, MAX_EXIT_SEQ, 'an exit number');
}

/** A decision's slot when it is known: at least 1, so a stored 0 can only mean unknown (review S). */
function knownSlot(v: bigint): bigint {
  const s = slotParam(v);
  if (s === 0n) {
    throw badParam('a known slot of at least 1 (a stored 0 stands for an unknown slot, only with an error)');
  }
  return s;
}

/** `{"reasons":[codes]}`: each a code (no prose, no message), each once. */
function reasonsJson(reasons: readonly string[], min: number, max: number): string {
  // a plain list, read element by element from its descriptors: a list with its own `map`, a proxy,
  // a subclass or a getter element could otherwise hand back text that never met codeParam (review S,
  // security 1)
  if (!Array.isArray(reasons) || types.isProxy(reasons) || Object.getPrototypeOf(reasons) !== Array.prototype) {
    throw badParam('a plain list of reason codes');
  }
  const count = reasons.length;
  if (Object.getOwnPropertySymbols(reasons).length > 0 || Object.getOwnPropertyNames(reasons).length !== count + 1) {
    throw badParam('a plain list of reason codes (no holes or extra properties)');
  }
  if (count < min || count > max) {
    throw badParam(`${min} to ${max} reason codes`);
  }
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const element = Object.getOwnPropertyDescriptor(reasons, String(i));
    if (element === undefined || !element.enumerable || !('value' in element)) {
      throw badParam('plain reason codes (no getters)');
    }
    codes.push(codeParam(element.value as string));
  }
  if (new Set(codes).size !== codes.length) {
    throw badParam('each reason once');
  }
  return jsonParam({ reasons: codes });
}

/**
 * The inputs record: at most 32 names of a lower-case letter and up to 31 letters or digits, each a
 * safe whole number, an amount (bigint within +-(2^64-1), stored as decimal text), a flag, null or a
 * code. No list, no nested object, no fraction, no address (an address is not a code).
 */
function inputsJson(inputs: IntentInputs): string {
  if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) {
    throw badParam('the inputs as a flat record');
  }
  const proto: unknown = Object.getPrototypeOf(inputs);
  if ((proto !== Object.prototype && proto !== null) || Object.getOwnPropertySymbols(inputs).length > 0) {
    throw badParam('the inputs as a plain record');
  }
  const names = Object.getOwnPropertyNames(inputs);
  if (names.length > MAX_INPUTS) {
    throw badParam(`at most ${MAX_INPUTS} inputs`);
  }
  const out = Object.create(null) as Record<string, IntentValue>;
  for (const name of names) {
    if (!INPUT_NAME.test(name)) {
      throw badParam('input names of a lower-case letter and up to 31 letters or digits');
    }
    const property = Object.getOwnPropertyDescriptor(inputs, name);
    if (property === undefined || !property.enumerable || !('value' in property)) {
      throw badParam('plain input values (no getters or hidden properties)');
    }
    const v: unknown = property.value;
    if (v === null || typeof v === 'boolean') {
      out[name] = v;
    } else if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) {
        throw badParam('whole-number inputs (scale a fraction to a whole number)');
      }
      out[name] = v;
    } else if (typeof v === 'bigint') {
      signedParam(v);
      out[name] = v;
    } else if (typeof v === 'string') {
      out[name] = codeParam(v);
    } else {
      throw badParam('inputs that are whole numbers, amounts, flags, null or codes');
    }
  }
  return jsonParam(out);
}

/**
 * T1 buy: the entry a strategy asked for, before risk decides (s.3.1 step 2). Refused before any
 * write when a field is outside its form, or when its position id exists already (an entry opens a
 * new position); a second intent with the same id is the database's refusal.
 */
export function insertEntryIntent(tx: Tx, intent: NewEntryIntent): void {
  const { id, mode: m, strategy, mint, positionId, sizeHint, confidenceBps, createdAt, inputsAsOf, reasons, inputs } = intent; // each read once
  const position = idParam(positionId);
  const params = [
    idParam(id),
    mode(m),
    oneOf(strategy, STRATEGY_IDS, 'a strategy'),
    idParam(mint),
    position,
    oneOf(sizeHint, ['min', 'normal'] as const, 'a size hint (min or normal)'),
    confidenceBps === null ? null : wholeParam(confidenceBps, 0, 10_000, 'a confidence in bps'),
    msParam(createdAt),
    inputsAsOf === null ? null : msParam(inputsAsOf),
    reasonsJson(reasons, 1, MAX_INTENT_REASONS),
    inputsJson(inputs),
  ] as const;
  if (positionCount(tx, position) !== 0) {
    throw new StorageError('row-count', 'an entry intent opens a new position: its position id exists already');
  }
  expectChanges(tx.run(INSERT_ENTRY, ...params), 1, 'the entry intent');
}

/**
 * T1 exit: the exit asked for, with the mode and the mint of its position. It takes the position's
 * next exit number and uses it up, approved or refused: refused before any write for a position that
 * is missing, cannot exit, or holds another number; a second intent with the same id or number is
 * the database's refusal.
 */
export function insertExitIntent(tx: Tx, intent: NewExitIntent): void {
  const { id, positionId, exitSeq, fractionBps, urgency, createdAt, inputsAsOf, reasons, inputs } = intent; // each read once
  const idText = idParam(id);
  const position = idParam(positionId);
  const seq = exitSeqParam(exitSeq);
  const fraction = wholeParam(fractionBps, 1, 10_000, 'a fraction in bps');
  const checkedUrgency = oneOf(urgency, SCHEMA_V1_COPIES.urgencies, 'an urgency (normal, protective or emergency)');
  const created = msParam(createdAt);
  const asOf = inputsAsOf === null ? null : msParam(inputsAsOf);
  const reasonsText = reasonsJson(reasons, 1, MAX_INTENT_REASONS);
  const inputsText = inputsJson(inputs);
  const p = readPosition(tx, position);
  if (p.status !== 'open' && p.status !== 'exiting') {
    throw new StorageError('row-count', 'an exit intent needs a position that is open or exiting');
  }
  if (exitSeq !== p.exitSeq) {
    throw new StorageError('row-count', "an exit intent takes the position's next exit number");
  }
  const params = [idText, mode(p.mode), idParam(p.mint), position, seq, fraction, checkedUrgency, created, asOf, reasonsText, inputsText] as const; // every check before the first write
  // the number first: had the insert come first, a refused bump would leave an intent behind
  advanceExitSeq(tx, position, exitSeq, createdAt);
  expectChanges(tx.run(INSERT_EXIT, ...params), 1, 'the exit intent');
}

/** Whether an intent with this id exists (T1's duplicate check: a duplicate writes nothing). */
export function intentExists(r: Reader, id: string): boolean {
  return intentCount(r, idParam(id)) === 1;
}

const fits = (outcome: (typeof OUTCOMES)[number], stage: RefusalStage | null, kind: 'entry' | 'exit'): boolean => {
  if (outcome === 'entry-approved') {
    return kind === 'entry';
  }
  if (outcome === 'exit-approved') {
    return kind === 'exit';
  }
  return kind === 'entry' || (stage !== 'blocked' && stage !== 'sizing');
};

/**
 * What risk decided about an intent, under the active config version: one decision per intent (the
 * primary key). An approved entry carries its size and what limited it; an approved exit none; a
 * refusal its stage and 1 to 64 reason codes. The slot is unknown (null, stored as 0) only for an
 * error. Refused before any write otherwise; 'duplicate' is never written (s.3.1).
 */
export function insertDecision(tx: Tx, decision: NewDecision): void {
  const { outcome, intentId, at, configVersion } = decision; // each read once
  const idText = idParam(intentId);
  const atParam = msParam(at);
  const version = intParam(configVersion);
  const checkedOutcome = oneOf(outcome, OUTCOMES, 'a decision outcome');
  let stage: RefusalStage | null = null;
  let reasonsText = jsonParam({ reasons: [] });
  let size: string | null = null;
  let limitedBy: SizeLimit | null = null;
  let binding: SizingCap | null = null;
  let slot: bigint;
  // the branch follows the outcome read once above, never a second read (review S, security 2)
  if (checkedOutcome === 'entry-approved') {
    const { slot: s, size: z, limitedBy: l, binding: b } = decision as Extract<NewDecision, { readonly outcome: 'entry-approved' }>;
    slot = knownSlot(s);
    size = amountParam(z);
    if (z < 1n) {
      throw badParam('an approved size of at least 1 lamport');
    }
    limitedBy = oneOf(l, SIZE_LIMITS, 'what limited the size');
    binding = oneOf(b, SIZING_CAPS, 'the binding cap');
  } else if (checkedOutcome === 'exit-approved') {
    const { slot: s } = decision as Extract<NewDecision, { readonly outcome: 'exit-approved' }>;
    slot = knownSlot(s);
  } else {
    const { stage: st, reasons, slot: s } = decision as Extract<NewDecision, { readonly outcome: 'refused' }>;
    stage = oneOf(st, STAGES, 'a refusal stage (blocked, sizing, plan or error)');
    reasonsText = reasonsJson(reasons, 1, MAX_DECISION_REASONS);
    if (s === null) {
      if (stage !== 'error') {
        throw badParam('a slot: it is unknown (null) only for an error');
      }
      slot = 0n; // 0 stands for unknown: the column is NOT NULL (s.15.13)
    } else {
      slot = knownSlot(s);
    }
  }
  const kind = cellOneOf(required(tx.get(INTENT_KIND, idText), 'the intent of the decision'), 'kind', INTENT_KINDS);
  if (!fits(checkedOutcome, stage, kind)) {
    throw badParam('an entry outcome for an entry intent and an exit outcome for an exit intent (blocks and sizing refuse entries only)');
  }
  const newest = intCell(required(tx.get(NEWEST_VERSION), "config version 1 (the owner's setup writes it)"), 'id', 1, Number.MAX_SAFE_INTEGER);
  if (configVersion !== newest) {
    throw badParam('the active config version');
  }
  expectChanges(tx.run(INSERT_DECISION, idText, atParam, boolParam(stage === null), stage, reasonsText, size, limitedBy, binding, slot, version), 1, 'the decision');
}

/**
 * T1, after the approved decision (and, for a buy, after its position): risk's token, bound to the
 * plan text storage hashed itself. Refused before any write when the text is not the token's plan,
 * a token field disagrees with the text, the decision is missing or refused, or the position cannot
 * take the order (a buy needs it opening with the same held-back spend; an exit needs it open or
 * exiting). The MAC is never read: it is the verifier's, never the database's.
 */
export function insertApproval(tx: Tx, token: ApprovalToken, planText: string, at: number): void {
  const { id, intentId, mode: m, kind, reduceOnly, positionId, planHash, maxSpendLamports, minOut, expiresAtSlot } = token; // each read once
  const params = {
    tokenId: idParam(id),
    intentId: idParam(intentId),
    positionId: idParam(positionId),
    mode: mode(m),
    kind: oneOf(kind, ORDER_KINDS, 'an order kind (buy, sell or close-account)'),
    reduceOnly: boolParam(reduceOnly),
    maxSpend: amountParam(maxSpendLamports),
    minOut: amountParam(minOut),
    expiresAtSlot: slotParam(expiresAtSlot),
    at: msParam(at),
  };
  const rec = planRecordOf(planText);
  if (rec.hash !== planHash) {
    throw badParam('a plan text: this one is not the plan the token was issued for');
  }
  if (rec.intentId !== intentId || rec.positionId !== positionId || rec.mode !== m || rec.kind !== kind || rec.minOut !== minOut) {
    throw badParam("a token whose fields are its plan's");
  }
  if (reduceOnly !== (kind !== 'buy')) {
    throw badParam('a reduce-only sell or close, and a buy that is not');
  }
  if (expiresAtSlot < rec.quoteSlot || expiresAtSlot - rec.quoteSlot > BigInt(SCHEMA_V1_COPIES.planFreshSlots)) {
    throw badParam(`a token that expires within ${SCHEMA_V1_COPIES.planFreshSlots} slots after its plan's quote`);
  }
  const decided = required(tx.get(DECISION_APPROVED, params.intentId), "the decision of the token's intent");
  if (!boolCell(decided, 'approved')) {
    throw badParam('a token only for an approved decision');
  }
  const p = readPosition(tx, params.positionId);
  if (p.mode !== m) {
    throw badParam("a token in its position's mode");
  }
  // the plan trades its position's own mint: risk checks it too, storage is the last line (review S, risk 1 and security 3)
  if (rec.mint !== p.mint) {
    throw badParam("a plan for its position's mint");
  }
  const takes = kind === 'buy' ? p.status === 'opening' && p.maxSpend === maxSpendLamports : p.status === 'open' || p.status === 'exiting';
  if (!takes) {
    throw badParam("a buy's token for a position that is opening with the same held-back spend, an exit's for one that is open or exiting");
  }
  expectChanges(
    tx.run(INSERT_APPROVAL, params.tokenId, params.intentId, params.positionId, params.mode, params.kind, params.reduceOnly, rec.hash, params.maxSpend, params.minOut, rec.quoteSlot, params.expiresAtSlot, params.at),
    1,
    'the approval',
  );
}

/**
 * T1 exit (s.3.2 step 3): the position's sells and closes in flight, and the token units those sells
 * spend. The schema keeps one exit in flight per position, so the sum is one cell at most; a sum
 * past 2^64-1 (only a database changed behind the bot's back) throws rather than wraps.
 */
export function exitsInFlight(r: Reader, positionId: string): ExitsInFlight {
  let count = 0;
  let sold = 0n;
  for (const row of r.all(EXITS_IN_FLIGHT, idParam(positionId))) {
    count += 1;
    if (cellOneOf(row, 'kind', ['sell', 'close-account'] as const) === 'sell') {
      sold += tokenUnitsCell(row, 'in_amount');
    }
  }
  return Object.freeze({ count, sellTokens: tokenUnits(sold) });
}

function orderOf(r: Row): StoredOrder {
  return Object.freeze({
    id: idCell(r, 'id'),
    intentId: idCell(r, 'intent_id'),
    tokenId: idCell(r, 'token_id'),
    positionId: idCell(r, 'position_id'),
    mode: cellOneOf(r, 'mode', MODES),
    kind: cellOneOf(r, 'kind', ORDER_KINDS),
    status: cellOneOf(r, 'status', ORDER_STATUSES),
    planHash: hex64Cell(r, 'plan_hash'),
    inAmount: lamportsCell(r, 'in_amount'),
    minOut: lamportsCell(r, 'min_out'),
    maxSpend: lamportsCell(r, 'max_spend'),
    quoteSlot: slotCell(r, 'quote_slot'),
    createdAt: msCell(r, 'created_at'),
    updatedAt: msCell(r, 'updated_at'),
  });
}

/** The one buy order of a position, or null: abandonOpeningTx and the boot ask whether it may still land. */
export function buyOrderOf(r: Reader, positionId: string): StoredOrder | null {
  const row = r.get(BUY_ORDER, idParam(positionId));
  return row === undefined ? null : orderOf(row);
}

/**
 * T1 exit (review S, risk 3b; STORAGE_DESIGN s.16.3): the position's sell and close tokens not yet
 * used and still usable at `slot` (its expiry slot included). An unused token can still be redeemed
 * and become an order, so with exitsInFlight it counts as an exit in flight: a second exit waits
 * until the first token is used or has expired.
 */
export function outstandingExitApprovals(r: Reader, positionId: string, slot: bigint): number {
  return intCell(required(r.get(OUTSTANDING_EXITS, idParam(positionId), slotParam(slot)), 'the outstanding exit tokens'), 'n', 0, MAX_EXIT_TOKENS);
}

/**
 * The slot a position's buy token expires at, used or not, or null when the position has none (step
 * 6d-2, review T security 3): an opening position is abandoned only after its buy token expired, so
 * a token that can still be redeemed never meets a closed position.
 */
export function buyTokenExpiry(r: Reader, positionId: string): bigint | null {
  const rows = r.all(BUY_TOKEN_EXPIRY, idParam(positionId));
  if (rows.length > 1) {
    throw new StorageError('row-count', 'a position has one buy token at most');
  }
  const row = rows[0];
  return row === undefined ? null : slotCell(row, 'expires_at_slot');
}
