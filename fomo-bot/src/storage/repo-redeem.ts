// T2 (STORAGE_DESIGN.md s.15.7 and s.3.3): using an approval and recording its order, inside the
// token store bound into risk's verifier (app/token-store.ts is the only importer: an architecture
// rule, so no other code can use a token with a slot of its own choosing). The token is used once,
// and the order row comes from the verifier's validated snapshot and risk's own canonical text,
// never from the executor's objects. Everything is checked before the first write: the stored
// approval, the text (storage hashes it itself) and the snapshot agree field by field, the slot lies
// within the token's range, the clock is not behind the token's issue nor more than 15 s past it
// (review T), and the position still takes the order. The database adds a consumed, matching token for every order, one buy per position
// ever, and one exit in flight per position.
import type { RedeemSnapshot } from '../risk/approval.ts';
import { amountParam, boolCell, hex64Cell, idCell, idParam, lamportsCell, msCell, msCellOrNull, msParam, slotCell, slotParam } from './codec.ts';
import { ORDER_KINDS, planRecordOf } from './plan-text.ts';
import { readPosition } from './repo-book.ts';
import { cellOneOf, expectChanges, required } from './repo-util.ts';
import { StorageError, type Tx } from './sqlite.ts';

const MODES = Object.freeze(['paper', 'live'] as const);
const APPROVAL =
  'SELECT intent_id, position_id, mode, kind, reduce_only, plan_hash, max_spend, min_out, quote_slot, expires_at_slot, issued_at, consumed_at FROM approvals WHERE token_id = ?';
const CONSUME = 'UPDATE approvals SET consumed_at = ?, consumed_slot = ? WHERE token_id = ? AND consumed_at IS NULL';
const INSERT_ORDER =
  "INSERT INTO orders (id, intent_id, token_id, position_id, mode, kind, status, plan_hash, plan_json, in_amount, min_out, max_spend, quote_slot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?, ?)";

const disagree = (what: string): StorageError => new StorageError('bad-param', `expected ${what}`);
/**
 * The clock's backstop on a token's life (review T, security 1): a slot feed that lags behind the
 * chain, or a long wait for the database, could otherwise keep an old token usable. 15 s is the hard
 * 25 slots (config/caps.ts planFreshSlots) at Solana's 400 ms slot target, with half again of margin;
 * a test pins the arithmetic. Storage keeps its own copy: it imports core/ only at runtime (s.1).
 */
const MAX_USE_AFTER_ISSUE_MS = 15_000;

/**
 * T2 inside the bound token store: true when the token was used now and its order recorded; false,
 * with nothing written, when it was used already. Anything else throws, with nothing written.
 */
export function redeemApproval(tx: Tx, tokenId: string, snapshot: RedeemSnapshot, planText: string, at: number): boolean {
  const id = idParam(tokenId);
  const atParam = msParam(at);
  // each field read once; the plan object itself is not read: its canonical text is
  const { intentId, positionId, mode, kind, reduceOnly, planHash, maxSpendLamports, minOut, expiresAtSlot, slot } = snapshot;
  const slotValue = slotParam(slot);
  const row = required(tx.get(APPROVAL, id), 'the approval');
  if (msCellOrNull(row, 'consumed_at') !== null) {
    return false;
  }
  const stored = {
    intentId: idCell(row, 'intent_id'),
    positionId: idCell(row, 'position_id'),
    mode: cellOneOf(row, 'mode', MODES),
    kind: cellOneOf(row, 'kind', ORDER_KINDS),
    reduceOnly: boolCell(row, 'reduce_only'),
    planHash: hex64Cell(row, 'plan_hash'),
    maxSpend: lamportsCell(row, 'max_spend'),
    minOut: lamportsCell(row, 'min_out'),
    quoteSlot: slotCell(row, 'quote_slot'),
    expiresAtSlot: slotCell(row, 'expires_at_slot'),
    issuedAt: msCell(row, 'issued_at'),
  };
  const rec = planRecordOf(planText);
  if (rec.hash !== stored.planHash || planHash !== stored.planHash) {
    throw disagree('the plan text, the stored approval and the snapshot to name one plan');
  }
  const same =
    rec.intentId === stored.intentId &&
    intentId === stored.intentId &&
    rec.positionId === stored.positionId &&
    positionId === stored.positionId &&
    rec.mode === stored.mode &&
    mode === stored.mode &&
    rec.kind === stored.kind &&
    kind === stored.kind;
  if (!same) {
    throw disagree('the intent, position, mode and kind of the text, the approval and the snapshot to agree');
  }
  if (reduceOnly !== stored.reduceOnly || maxSpendLamports !== stored.maxSpend || minOut !== stored.minOut || rec.minOut !== stored.minOut || expiresAtSlot !== stored.expiresAtSlot || rec.quoteSlot !== stored.quoteSlot) {
    throw disagree("the snapshot's token fields to be the stored approval's");
  }
  if (slot < stored.quoteSlot || slot > stored.expiresAtSlot) {
    throw disagree("a slot within the token's range, from its plan's quote to its expiry");
  }
  if (at < stored.issuedAt) {
    throw disagree('a redeem at or after the token was issued (a clock behind it: a retry gets a new token)');
  }
  if (at - stored.issuedAt > MAX_USE_AFTER_ISSUE_MS) {
    throw disagree('a redeem within 15 s of the token issue (a slot feed behind the chain, or a long wait for the database: a retry gets a new token)');
  }
  const p = readPosition(tx, stored.positionId);
  const takes = p.mode === stored.mode && (stored.kind === 'buy' ? p.status === 'opening' : p.status === 'open' || p.status === 'exiting');
  if (!takes) {
    throw new StorageError('row-count', 'the position can no longer take the order');
  }
  // the plan trades its position's own mint (review S, risk 1 and security 3)
  if (rec.mint !== p.mint) {
    throw disagree("a plan for its position's mint");
  }
  if (stored.kind === 'buy' && rec.inAmount > stored.maxSpend) {
    throw disagree("a buy's input within its token's spend");
  }
  // every parameter before the first write (review S, security 5)
  const order = [idParam(rec.orderId), stored.intentId, id, stored.positionId, stored.mode, stored.kind, rec.hash, rec.text, amountParam(rec.inAmount), amountParam(rec.minOut), amountParam(stored.maxSpend), rec.quoteSlot, atParam, atParam] as const;
  expectChanges(tx.run(CONSUME, atParam, slotValue, id), 1, 'using the token');
  expectChanges(tx.run(INSERT_ORDER, ...order), 1, 'the order');
  return true;
}
