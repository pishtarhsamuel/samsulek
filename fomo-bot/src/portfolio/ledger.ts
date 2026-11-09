// Portfolio ledger (TEST_PLAN.md s.3 step 3; RISK_POLICY.md invariants 5-7 and 10): SOL, positions,
// cost basis with every fee and rent, realized PnL (negative too), each position's cost lines,
// deposits and withdrawals. Pure and immutable: an operation validates first and returns a new
// ledger, so a refused operation leaves the old one untouched. Every operation ends with
// checkConservation, so an accounting bug stops the bot (PAPER_LEDGER halt) instead of drifting.
//
// Money model, in lamports (bigint only):
// - A landed buy costs quoteIn (venue fee included) + network fee + tip + token-account rent, all of
//   it added to the cost basis. The rent stays locked in the basis until the account is closed
//   after the last sell, and that close must refund exactly the rent locked.
// - An order that never lands costs only its network fee, which goes into the basis and into
//   failedFees; its other amounts are ignored. An order that lands after failed attempts reports
//   every network fee it paid in networkFee. Book an order as not landed only once it can no
//   longer land (its blockhash expired, then a final status check).
// - Each order id settles once; settling it again throws, so a fill can never count twice.
//   Callers skip an order already in settledOrders (a replayed event is dropped there).
// - Every event is dated at or after its position's openedAt.
// - A sell releases cost basis (locked rent excluded) in proportion to the tokens sold, rounded up,
//   so realized PnL is never flattering: realized += quoteOut (after the venue fee) + rent refunded
//   - network fee - tip - released basis. Selling the last tokens releases all of it.
// Status: opening (no tokens yet) -> open (holds tokens) -> exiting (every token sold, the account
// close pending, rent still locked) -> closed. 'stuck' (unsellable, valued 0) arrives with the
// exit engine.
// Malformed amounts throw AmountError (core/units); accounting refusals throw LedgerError.
import { isIdText, isStrategyId, type StrategyId } from '../core/ids.ts';
import { isMillis } from '../core/time.ts';
import {
  ceilDiv,
  lamports,
  signedLamports,
  tokenUnits,
  type Lamports,
  type SignedLamports,
  type TokenUnits,
} from '../core/units.ts';

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

export type LedgerMode = 'paper' | 'live';
export type PositionStatus = 'opening' | 'open' | 'exiting' | 'closed';

export interface Position {
  readonly id: string;
  readonly mint: string;
  readonly strategy: StrategyId;
  readonly status: PositionStatus;
  readonly openedAt: number;
  readonly closedAt: number | null;
  readonly tokenUnits: TokenUnits;
  /** Every cost not yet released by a sell: swap input, network fees, tips, rent, failed orders. */
  readonly costBasis: Lamports;
  /** Token-account rent paid and not yet refunded (part of costBasis). */
  readonly rentLocked: Lamports;
  readonly realized: SignedLamports;
  // Cost lines, cumulative over the position's life (reports and the conservation check).
  /** quoteIn of landed buys, venue fee included. */
  readonly bought: Lamports;
  /** quoteOut of landed sells, after the venue fee. */
  readonly sold: Lamports;
  /** Already inside bought and sold: reported, never subtracted a second time. */
  readonly venueFees: Lamports;
  /** Base and priority fees of landed transactions. */
  readonly networkFees: Lamports;
  /** Network fees of orders that never landed. */
  readonly failedFees: Lamports;
  readonly tips: Lamports;
  readonly rentPaid: Lamports;
  readonly rentRefunded: Lamports;
  /** Token units received by landed buys and given by landed sells: tokenUnits = bought - sold. */
  readonly tokensBought: TokenUnits;
  readonly tokensSold: TokenUnits;
  /** Network fees and tips of landed sells and closes (part of networkFees and tips): realized at once. */
  readonly exitFees: Lamports;
  /** Cost basis released so far by sells, the close and abandoning. */
  readonly basisReleased: Lamports;
}

export interface Ledger {
  readonly mode: LedgerMode;
  readonly sol: Lamports;
  readonly totalDeposits: Lamports;
  readonly totalWithdrawals: Lamports;
  readonly positions: ReadonlyMap<string, Position>;
  /** Every order id already settled. */
  readonly settledOrders: ReadonlySet<string>;
  /** Time of the last operation (UTC ms); null for a new ledger. */
  readonly updatedAt: number | null;
}

export interface NewPosition {
  readonly id: string;
  readonly mint: string;
  readonly strategy: StrategyId;
  readonly openedAt: number;
}

interface OrderResult {
  readonly orderId: string;
  readonly positionId: string;
  /** false: the order never landed; only its network fee counts, its other amounts are ignored. */
  readonly landed: boolean;
  /** Every base and priority fee the order paid, failed attempts before it landed included. */
  readonly networkFee: Lamports;
  readonly at: number;
}

export interface BuyFill extends OrderResult {
  /** Lamports into the swap, venue fee included. */
  readonly quoteIn: Lamports;
  readonly venueFee: Lamports;
  readonly tokensOut: TokenUnits;
  readonly tip: Lamports;
  /** Token-account rent; 0 if the account already existed. */
  readonly rentPaid: Lamports;
}

export interface SellFill extends OrderResult {
  readonly tokensIn: TokenUnits;
  /** Lamports out of the swap, after the venue fee. */
  readonly quoteOut: Lamports;
  readonly venueFee: Lamports;
  readonly tip: Lamports;
  /** The same transaction closes the token account (only with the last tokens). */
  readonly closeAccount: boolean;
  readonly rentRefunded: Lamports;
}

export interface CloseFill extends OrderResult {
  readonly rentRefunded: Lamports;
}

const ZERO = lamports(0n);

// ---------------------------------------------------------------- input checks

function checkId(what: string, value: unknown): string {
  if (!isIdText(value)) {
    throw new LedgerError(`${what} must be 1-128 characters of A-Z, a-z, 0-9, _ and -`);
  }
  return value;
}

function checkTime(what: string, value: unknown): number {
  if (!isMillis(value)) {
    throw new LedgerError(`${what} must be a UTC millisecond timestamp`);
  }
  return value;
}

function checkFlag(what: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new LedgerError(`${what} must be a boolean, got ${typeof value}`);
  }
  return value;
}

function positionOf(ledger: Ledger, positionId: unknown): Position {
  const id = checkId('positionId', positionId);
  const position = ledger.positions.get(id);
  if (position === undefined) {
    throw new LedgerError(`unknown position ${id}`);
  }
  return position;
}

function unsettledOrder(ledger: Ledger, orderId: unknown): string {
  const id = checkId('orderId', orderId);
  if (ledger.settledOrders.has(id)) {
    throw new LedgerError(`order ${id} is already settled`);
  }
  return id;
}

function requireStatus(position: Position, status: PositionStatus, action: string): void {
  if (position.status !== status) {
    throw new LedgerError(`position ${position.id} is ${position.status}: ${action} needs an ${status} position`);
  }
}

function eventTime(position: Position, at: unknown): number {
  const time = checkTime('at', at);
  if (time < position.openedAt) {
    throw new LedgerError(`an event at ${time} is earlier than position ${position.id} opened (${position.openedAt})`);
  }
  return time;
}

function requireSol(ledger: Ledger, amount: bigint, what: string): void {
  if (amount > ledger.sol) {
    throw new LedgerError(`insufficient SOL: ${what} needs ${amount} lamports, the wallet holds ${ledger.sol}`);
  }
}

/** A refund needs the account close, and a close refunds exactly the rent locked. */
function checkRefund(position: Position, closing: boolean, refund: bigint): void {
  const expected = closing ? position.rentLocked : 0n;
  if (refund !== expected) {
    const rule = closing ? 'the rent locked' : 'zero without an account close';
    throw new LedgerError(`position ${position.id}: rent refunded ${refund} must be ${rule} (${expected})`);
  }
}

// ---------------------------------------------------------------- building the next ledger

function verified(ledger: Ledger): Ledger {
  checkConservation(ledger);
  return Object.freeze(ledger);
}

function settle(ledger: Ledger, orderId: string, position: Position, sol: bigint, at: number): Ledger {
  const positions = new Map(ledger.positions);
  positions.set(position.id, Object.freeze(position));
  const settledOrders = new Set(ledger.settledOrders);
  settledOrders.add(orderId);
  return verified({ ...ledger, sol: lamports(sol), positions, settledOrders, updatedAt: at });
}

function settleFailed(ledger: Ledger, orderId: string, position: Position, networkFee: Lamports, at: number): Ledger {
  requireSol(ledger, networkFee, 'the failed order');
  const next: Position = {
    ...position,
    costBasis: lamports(position.costBasis + networkFee),
    failedFees: lamports(position.failedFees + networkFee),
  };
  return settle(ledger, orderId, next, ledger.sol - networkFee, at);
}

// ---------------------------------------------------------------- operations

export function emptyLedger(mode: LedgerMode): Ledger {
  if (mode !== 'paper' && mode !== 'live') {
    throw new LedgerError('ledger mode must be paper or live');
  }
  return verified({
    mode,
    sol: ZERO,
    totalDeposits: ZERO,
    totalWithdrawals: ZERO,
    positions: new Map(),
    settledOrders: new Set(),
    updatedAt: null,
  });
}

/** Paper: the paper bankroll. Live: a deposit confirmed on chain. */
export function deposit(ledger: Ledger, amount: Lamports, at: number): Ledger {
  const value = lamports(amount);
  const time = checkTime('at', at);
  if (value === 0n) {
    throw new LedgerError('a deposit must be positive');
  }
  return verified({
    ...ledger,
    sol: lamports(ledger.sol + value),
    totalDeposits: lamports(ledger.totalDeposits + value),
    updatedAt: time,
  });
}

/** Live only, to the owner's pinned address; the risk engine checks the reserve first. */
export function withdraw(ledger: Ledger, amount: Lamports, at: number): Ledger {
  if (ledger.mode === 'paper') {
    throw new LedgerError('withdrawals are impossible in paper mode');
  }
  const value = lamports(amount);
  const time = checkTime('at', at);
  if (value === 0n) {
    throw new LedgerError('a withdrawal must be positive');
  }
  requireSol(ledger, value, 'the withdrawal');
  return verified({
    ...ledger,
    sol: lamports(ledger.sol - value),
    totalWithdrawals: lamports(ledger.totalWithdrawals + value),
    updatedAt: time,
  });
}

/** Records an approved entry before its buy is sent. One active position per token. */
export function openPosition(ledger: Ledger, spec: NewPosition): Ledger {
  const id = checkId('position id', spec.id);
  const mint = checkId('mint', spec.mint);
  if (!isStrategyId(spec.strategy)) {
    throw new LedgerError('unknown strategy');
  }
  const openedAt = checkTime('openedAt', spec.openedAt);
  if (ledger.positions.has(id)) {
    throw new LedgerError(`position ${id} already exists`);
  }
  for (const p of ledger.positions.values()) {
    if (p.mint === mint && p.status !== 'closed') {
      throw new LedgerError(`one position per token: ${mint} already has position ${p.id}`);
    }
  }
  const position: Position = {
    id,
    mint,
    strategy: spec.strategy,
    status: 'opening',
    openedAt,
    closedAt: null,
    tokenUnits: tokenUnits(0n),
    costBasis: ZERO,
    rentLocked: ZERO,
    realized: signedLamports(0n),
    bought: ZERO,
    sold: ZERO,
    venueFees: ZERO,
    networkFees: ZERO,
    failedFees: ZERO,
    tips: ZERO,
    rentPaid: ZERO,
    rentRefunded: ZERO,
    tokensBought: tokenUnits(0n),
    tokensSold: tokenUnits(0n),
    exitFees: ZERO,
    basisReleased: ZERO,
  };
  const positions = new Map(ledger.positions);
  positions.set(id, Object.freeze(position));
  return verified({ ...ledger, positions, updatedAt: openedAt });
}

export function applyBuy(ledger: Ledger, fill: BuyFill): Ledger {
  const p = positionOf(ledger, fill.positionId);
  const orderId = unsettledOrder(ledger, fill.orderId);
  const landed = checkFlag('landed', fill.landed);
  const networkFee = lamports(fill.networkFee);
  const quoteIn = lamports(fill.quoteIn);
  const venueFee = lamports(fill.venueFee);
  const tokensOut = tokenUnits(fill.tokensOut);
  const tip = lamports(fill.tip);
  const rentPaid = lamports(fill.rentPaid);
  const at = eventTime(p, fill.at);
  requireStatus(p, 'opening', 'a buy');
  if (!landed) {
    return settleFailed(ledger, orderId, p, networkFee, at);
  }
  if (quoteIn === 0n || tokensOut === 0n) {
    throw new LedgerError(`a landed buy needs a positive input and output, got ${quoteIn} in and ${tokensOut} out`);
  }
  if (venueFee > quoteIn) {
    throw new LedgerError(`venue fee ${venueFee} exceeds the swap input ${quoteIn}`);
  }
  const cost = quoteIn + networkFee + tip + rentPaid;
  requireSol(ledger, cost, 'the buy');
  const next: Position = {
    ...p,
    status: 'open',
    tokenUnits: tokenUnits(p.tokenUnits + tokensOut),
    costBasis: lamports(p.costBasis + cost),
    rentLocked: lamports(p.rentLocked + rentPaid),
    bought: lamports(p.bought + quoteIn),
    venueFees: lamports(p.venueFees + venueFee),
    networkFees: lamports(p.networkFees + networkFee),
    tips: lamports(p.tips + tip),
    rentPaid: lamports(p.rentPaid + rentPaid),
    tokensBought: tokenUnits(p.tokensBought + tokensOut),
  };
  return settle(ledger, orderId, next, ledger.sol - cost, at);
}

export function applySell(ledger: Ledger, fill: SellFill): Ledger {
  const p = positionOf(ledger, fill.positionId);
  const orderId = unsettledOrder(ledger, fill.orderId);
  const landed = checkFlag('landed', fill.landed);
  const networkFee = lamports(fill.networkFee);
  const tokensIn = tokenUnits(fill.tokensIn);
  const quoteOut = lamports(fill.quoteOut);
  const venueFee = lamports(fill.venueFee);
  const tip = lamports(fill.tip);
  const closeAccount = checkFlag('closeAccount', fill.closeAccount);
  const rentRefunded = lamports(fill.rentRefunded);
  const at = eventTime(p, fill.at);
  requireStatus(p, 'open', 'a sell');
  if (!landed) {
    return settleFailed(ledger, orderId, p, networkFee, at);
  }
  if (tokensIn === 0n || tokensIn > p.tokenUnits) {
    throw new LedgerError(`cannot sell ${tokensIn} token units: position ${p.id} holds ${p.tokenUnits}`);
  }
  const left = p.tokenUnits - tokensIn;
  if (closeAccount && left > 0n) {
    throw new LedgerError(`cannot close the token account of position ${p.id} with ${left} tokens left`);
  }
  checkRefund(p, closeAccount, rentRefunded);
  requireSol(ledger, networkFee + tip, 'the sell fees');
  const tradeBasis = p.costBasis - p.rentLocked;
  let released: bigint;
  let status: PositionStatus;
  if (left > 0n) {
    released = ceilDiv(tradeBasis * tokensIn, p.tokenUnits);
    status = 'open';
  } else if (closeAccount) {
    released = p.costBasis;
    status = 'closed';
  } else {
    released = tradeBasis;
    status = 'exiting';
  }
  const next: Position = {
    ...p,
    status,
    closedAt: status === 'closed' ? at : null,
    tokenUnits: tokenUnits(left),
    costBasis: lamports(p.costBasis - released),
    rentLocked: lamports(p.rentLocked - rentRefunded),
    realized: signedLamports(p.realized + quoteOut + rentRefunded - networkFee - tip - released),
    sold: lamports(p.sold + quoteOut),
    venueFees: lamports(p.venueFees + venueFee),
    networkFees: lamports(p.networkFees + networkFee),
    tips: lamports(p.tips + tip),
    rentRefunded: lamports(p.rentRefunded + rentRefunded),
    tokensSold: tokenUnits(p.tokensSold + tokensIn),
    exitFees: lamports(p.exitFees + networkFee + tip),
    basisReleased: lamports(p.basisReleased + released),
  };
  return settle(ledger, orderId, next, ledger.sol + quoteOut + rentRefunded - networkFee - tip, at);
}

/** Closes the token account of an exiting position (every token sold) and books the rent refund. */
export function applyClose(ledger: Ledger, fill: CloseFill): Ledger {
  const p = positionOf(ledger, fill.positionId);
  const orderId = unsettledOrder(ledger, fill.orderId);
  const landed = checkFlag('landed', fill.landed);
  const networkFee = lamports(fill.networkFee);
  const rentRefunded = lamports(fill.rentRefunded);
  const at = eventTime(p, fill.at);
  requireStatus(p, 'exiting', 'an account close');
  if (!landed) {
    return settleFailed(ledger, orderId, p, networkFee, at);
  }
  checkRefund(p, true, rentRefunded);
  requireSol(ledger, networkFee, 'the account close');
  const next: Position = {
    ...p,
    status: 'closed',
    closedAt: at,
    costBasis: ZERO,
    rentLocked: ZERO,
    realized: signedLamports(p.realized + rentRefunded - networkFee - p.costBasis),
    networkFees: lamports(p.networkFees + networkFee),
    rentRefunded: lamports(p.rentRefunded + rentRefunded),
    exitFees: lamports(p.exitFees + networkFee),
    basisReleased: lamports(p.basisReleased + p.costBasis),
  };
  return settle(ledger, orderId, next, ledger.sol + rentRefunded - networkFee, at);
}

/** Closes an opening position whose buy never landed; its failed fees become realized loss. */
export function abandonOpening(ledger: Ledger, positionId: string, at: number): Ledger {
  const p = positionOf(ledger, positionId);
  const time = eventTime(p, at);
  if (p.tokenUnits > 0n || p.rentLocked > 0n) {
    throw new LedgerError(`position ${p.id} still holds tokens or rent: sell and close it instead`);
  }
  requireStatus(p, 'opening', 'abandoning');
  const next: Position = {
    ...p,
    status: 'closed',
    closedAt: time,
    costBasis: ZERO,
    realized: signedLamports(p.realized - p.costBasis),
    basisReleased: lamports(p.basisReleased + p.costBasis),
  };
  const positions = new Map(ledger.positions);
  positions.set(p.id, Object.freeze(next));
  return verified({ ...ledger, positions, updatedAt: time });
}

// ---------------------------------------------------------------- conservation

/** A position's net SOL flow from its cost lines: what it has paid out and got back. */
export function cashFlow(p: Position): bigint {
  return p.sold + p.rentRefunded - p.bought - p.networkFees - p.failedFees - p.tips - p.rentPaid;
}

function statusHolds(p: Position): boolean {
  switch (p.status) {
    case 'opening':
      return p.tokenUnits === 0n && p.bought === 0n && p.rentPaid === 0n && p.closedAt === null;
    case 'open':
      return p.tokenUnits > 0n && p.closedAt === null;
    case 'exiting':
      return p.tokenUnits === 0n && p.closedAt === null;
    case 'closed':
      return p.tokenUnits === 0n && p.costBasis === 0n && p.closedAt !== null;
    default:
      return false;
  }
}

/**
 * The identities that must hold after every operation (RISK_POLICY.md invariant 6), checked from
 * independent fields so one bookkeeping error cannot hide another:
 * - per position: costBasis = bought + entry fees and tips + rent paid + failed fees - basis
 *   released; realized = sold + rent refunded - exit fees - basis released; rentLocked = rent paid
 *   - rent refunded <= costBasis; tokens = bought - sold; the status matches the holdings
 *   (venueFees is a breakdown inside bought and sold, so no identity checks it);
 * - for the wallet: SOL = deposits - withdrawals + the sum of every position's cash flow;
 * - at most one active (not closed) position per token.
 */
export function checkConservation(ledger: Ledger): void {
  const problems: string[] = [];
  const activeMints = new Set<string>();
  let flows = 0n;
  for (const [key, p] of ledger.positions) {
    const flow = cashFlow(p);
    flows += flow;
    if (key !== p.id) {
      problems.push(`position ${p.id} is stored under ${key}`);
    }
    // Basis and realized PnL each against the cost lines, so an amount moved from one to the
    // other is caught too (together they give realized - basis = cash flow).
    const basisFromLines = p.bought + p.networkFees + p.tips - p.exitFees + p.rentPaid + p.failedFees - p.basisReleased;
    if (p.costBasis !== basisFromLines) {
      problems.push(`position ${p.id}: cost basis is ${p.costBasis}, its cost lines say ${basisFromLines}`);
    }
    const realizedFromLines = p.sold + p.rentRefunded - p.exitFees - p.basisReleased;
    if (p.realized !== realizedFromLines) {
      problems.push(`position ${p.id}: realized is ${p.realized}, its cost lines say ${realizedFromLines}`);
    }
    if (p.rentLocked !== p.rentPaid - p.rentRefunded || p.rentLocked > p.costBasis) {
      problems.push(`position ${p.id}: rent locked ${p.rentLocked} does not match rent paid, refunded and the basis`);
    }
    if (p.tokenUnits !== p.tokensBought - p.tokensSold) {
      problems.push(`position ${p.id}: tokens held ${p.tokenUnits} differ from bought - sold`);
    }
    if (!statusHolds(p)) {
      problems.push(`position ${p.id} is ${String(p.status)} with ${p.tokenUnits} tokens and basis ${p.costBasis}`);
    }
    if (p.status !== 'closed') {
      if (activeMints.has(p.mint)) {
        problems.push(`two active positions on ${p.mint}`);
      }
      activeMints.add(p.mint);
    }
  }
  const expected = ledger.totalDeposits - ledger.totalWithdrawals + flows;
  if (ledger.sol !== expected) {
    problems.push(`SOL is ${ledger.sol}, deposits - withdrawals + position cash flows say ${expected}`);
  }
  if (problems.length > 0) {
    throw new LedgerError(`ledger conservation failed: ${problems.join('; ')}`);
  }
}
