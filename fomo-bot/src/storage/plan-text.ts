// The canonical plan text, as storage reads it (STORAGE_DESIGN.md s.15.3). Storage may not import
// risk/plan.ts at runtime (architecture rule), so app/ passes risk's own canonicalPlan(plan): this
// file checks that the text is exactly that canonical form, reads the fields the token and order rows
// bind, and computes the sha256 of those exact bytes itself, as planHash does. Both callers then
// require that hash to equal the one risk sealed in the token (T1) or stored with it (T2): an equal
// sha256 is the same text, so the stored plan is the plan risk validated and approved. Nothing else
// of the plan is re-validated here; risk did that before it hashed. A refusal never repeats the text.
import { createHash } from 'node:crypto';
import { isIdText } from '../core/ids.ts';
import { U64_MAX } from '../core/units.ts';
import { jsonParam } from './codec.ts';
import type { LedgerMode } from './repo-day.ts';
import { StorageError } from './sqlite.ts';

/** risk/plan.ts PLAN_FIELDS (a test pins the two): the keys of a plan's canonical text, sorted as risk sorts them. */
export const PLAN_FIELD_NAMES: readonly string[] = Object.freeze([
  'attempts',
  'closeAccountAfter',
  'cuLimit',
  'cuPrice',
  'expectedOut',
  'feeBps',
  'feeConfigSlot',
  'inAmount',
  'intentId',
  'kind',
  'lastValidBlockHeight',
  'minOut',
  'mint',
  'mode',
  'orderId',
  'pool',
  'positionId',
  'quoteSlot',
  'rentLamports',
  'route',
  'slippageBps',
  'tip',
  'tokenAccount',
  'urgency',
  'venue',
  'wallet',
]);
const TIP_FIELD_NAMES = Object.freeze(['lamports', 'path']);

/** The kinds an order row takes (SCHEMA_V1_COPIES.orderKinds): a withdraw has its own path. */
export const ORDER_KINDS = Object.freeze(['buy', 'sell', 'close-account'] as const);
export type OrderKind = (typeof ORDER_KINDS)[number];

/** One canonical plan text, checked, with the fields storage binds and the hash it computed. */
export interface PlanRecord {
  /** The exact text, in jsonParam's form: what orders.plan_json stores. */
  readonly text: string;
  /** sha256 of `text`, lower-case hex: computed here, never taken from a caller. */
  readonly hash: string;
  readonly orderId: string;
  readonly intentId: string;
  readonly positionId: string;
  readonly mode: LedgerMode;
  readonly kind: OrderKind;
  readonly mint: string;
  readonly inAmount: bigint;
  readonly minOut: bigint;
  readonly quoteSlot: bigint;
}

const MAX_PLAN_TEXT = 8_192;
const MAX_SLOT = 2n ** 63n - 1n;
const U64_TEXT = /^(0|[1-9][0-9]{0,19})$/;

const refuse = (rule: string): StorageError => new StorageError('bad-param', `expected one plan's canonical text: ${rule}`);

/** A parsed JSON object whose own keys are exactly `names`, in that order (the canonical text is sorted). */
function hasKeys(value: unknown, names: readonly string[]): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length === names.length && keys.every((k, i) => k === names[i]);
}

function amountOf(value: unknown): bigint {
  if (typeof value !== 'string' || !U64_TEXT.test(value) || BigInt(value) > U64_MAX) {
    throw refuse("its amounts and slots are decimal text from 0 to 2^64-1");
  }
  return BigInt(value);
}

/** bad-param, never echoing the text, for anything but one buy, sell or close plan's canonical text. */
export function planRecordOf(planText: string): PlanRecord {
  if (typeof planText !== 'string' || planText.length === 0 || planText.length > MAX_PLAN_TEXT) {
    throw refuse(`a string of 1 to ${MAX_PLAN_TEXT} characters`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(planText);
  } catch {
    throw refuse('JSON');
  }
  // the key order is the proof that the text is sorted: jsonParam keeps a text's own order
  if (!hasKeys(parsed, PLAN_FIELD_NAMES) || !hasKeys(parsed['tip'], TIP_FIELD_NAMES)) {
    throw refuse('every field once, with its keys sorted as risk sorts them (canonical)');
  }
  let again: string;
  try {
    again = jsonParam(parsed); // printable ASCII, at most 8 KiB, and the secret filter over the whole text
  } catch {
    throw refuse("plain data that passes the secret filter (canonical)");
  }
  if (again !== planText) {
    throw refuse('no spaces or escapes: the canonical text itself');
  }
  const id = (name: string): string => {
    const value = parsed[name];
    if (!isIdText(value)) {
      throw refuse(`${name} is an id`);
    }
    return value;
  };
  const mode = parsed['mode'];
  if (mode !== 'paper' && mode !== 'live') {
    throw refuse('its mode is paper or live');
  }
  const kind = parsed['kind'];
  if (kind !== 'buy' && kind !== 'sell' && kind !== 'close-account') {
    throw refuse('its kind is buy, sell or close-account (a withdraw has its own path)');
  }
  const quoteSlot = amountOf(parsed['quoteSlot']);
  if (quoteSlot > MAX_SLOT) {
    throw refuse('its quoteSlot is a slot (at most 2^63-1)');
  }
  return Object.freeze({
    text: planText,
    hash: createHash('sha256').update(planText, 'utf8').digest('hex'),
    orderId: id('orderId'),
    intentId: id('intentId'),
    positionId: id('positionId'),
    mode,
    kind,
    mint: id('mint'),
    inAmount: amountOf(parsed['inAmount']),
    minOut: amountOf(parsed['minOut']),
    quoteSlot,
  });
}
