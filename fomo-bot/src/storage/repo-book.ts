// The book (STORAGE_DESIGN.md s.15.4 and s.15.5): each mode's ledger account and the positions, in
// the Position shape of portfolio/ledger.ts plus what only the book stores (the mode, the spend held
// back while a buy is in flight, the p95 exit cost and the next exit number). Read back typed,
// checked and frozen: a missing account or a bad cell throws, never a default (contract 1). A
// 'stuck' row is refused on every read until ledger.ts supports it, never mapped to another status
// (s.12.1). T1 opens a position (insertOpening); an exit intent uses up the position's next exit
// number (advanceExitSeq, through repo-orders.ts); an opening position whose buy can no longer land
// is abandoned exactly as ledger.ts abandonOpening does. The accounts are written once by the
// owner's setup at the server (repo-server.ts); nothing here moves SOL or the totals: T3's
// settlement and the transfers of Phase 8 come later, each with its own reviewed writer.
import { STRATEGY_IDS } from '../core/ids.ts';
import type { Lamports } from '../core/units.ts';
import type { Position } from '../portfolio/ledger.ts';
import type { OpeningPosition } from '../risk/approve.ts';
import {
  amountParam,
  idCell,
  idParam,
  intCell,
  intParam,
  lamportsCell,
  lamportsCellOrNull,
  msCell,
  msCellOrNull,
  msParam,
  signedCell,
  signedParam,
  tokenUnitsCell,
} from './codec.ts';
import type { LedgerMode } from './repo-day.ts';
import { cellOneOf, expectChanges, oneOf, required } from './repo-util.ts';
import { SCHEMA_V1_COPIES } from './schema-v1.ts';
import { StorageError, type Reader, type Row, type Tx } from './sqlite.ts';

const MODES = Object.freeze(['paper', 'live'] as const);
const STATUSES = Object.freeze(['opening', 'open', 'exiting', 'closed', 'stuck'] as const);
/** The order statuses of migration 1 (repo-orders.ts exports the same list; a test pins both to the schema). */
const ORDER_STATUSES = Object.freeze(['approved', 'submitted', 'landed', 'failed', 'expired'] as const);
/** The exit column takes up to 1,000,000, so the last number an exit intent may take is one below. */
const MAX_EXIT_SEQ = 999_999;

export interface StoredAccount {
  readonly mode: LedgerMode;
  readonly sol: Lamports;
  readonly totalDeposits: Lamports;
  readonly totalWithdrawals: Lamports;
  readonly updatedAt: number;
}

/** The Position of portfolio/ledger.ts (never 'stuck'), plus what only the book stores. */
export interface StoredPosition extends Position {
  readonly mode: LedgerMode;
  /** The worst-case spend held back while the buy is in flight: set while opening. */
  readonly maxSpend: Lamports | null;
  readonly p95ExitCost: Lamports;
  /** The number the next exit intent takes. */
  readonly exitSeq: number;
  readonly updatedAt: number;
}

export interface StoredBook {
  readonly account: StoredAccount;
  /** Every position of the mode, closed ones included, by id. */
  readonly positions: readonly StoredPosition[];
}

const ACCOUNT = 'SELECT mode, sol, total_deposits, total_withdrawals, updated_at FROM ledger_accounts WHERE mode = ?';
const POSITION_BY_ID =
  'SELECT id, mint, strategy, mode, status, opened_at, closed_at, max_spend, p95_exit_cost, exit_seq, token_units, cost_basis, rent_locked, realized, bought, sold, venue_fees, network_fees, failed_fees, tips, rent_paid, rent_refunded, tokens_bought, tokens_sold, exit_fees, basis_released, updated_at FROM positions WHERE id = ?';
// 'stuck' is selected on purpose: left out, a stuck position would count one active position too few
const ACTIVE_POSITIONS =
  "SELECT id, mint, strategy, mode, status, opened_at, closed_at, max_spend, p95_exit_cost, exit_seq, token_units, cost_basis, rent_locked, realized, bought, sold, venue_fees, network_fees, failed_fees, tips, rent_paid, rent_refunded, tokens_bought, tokens_sold, exit_fees, basis_released, updated_at FROM positions WHERE status IN ('opening', 'open', 'exiting', 'stuck') ORDER BY id";
const BOOK_POSITIONS =
  'SELECT id, mint, strategy, mode, status, opened_at, closed_at, max_spend, p95_exit_cost, exit_seq, token_units, cost_basis, rent_locked, realized, bought, sold, venue_fees, network_fees, failed_fees, tips, rent_paid, rent_refunded, tokens_bought, tokens_sold, exit_fees, basis_released, updated_at FROM positions WHERE mode = ? ORDER BY id';
const POSITION_COUNT = 'SELECT count(*) AS n FROM positions WHERE id = ?';
const INSERT_OPENING =
  "INSERT INTO positions (id, mint, strategy, mode, status, opened_at, max_spend, p95_exit_cost, updated_at) VALUES (?, ?, ?, ?, 'opening', ?, ?, ?, ?)";
const ADVANCE_EXIT_SEQ = "UPDATE positions SET exit_seq = exit_seq + 1, updated_at = ? WHERE id = ? AND exit_seq = ? AND status IN ('open', 'exiting')";
const BUY_ORDER_STATUS = "SELECT status FROM orders WHERE position_id = ? AND kind = 'buy'";
const ABANDON =
  "UPDATE positions SET status = 'closed', closed_at = ?, cost_basis = '0', realized = ?, basis_released = ?, updated_at = ? WHERE id = ? AND status = 'opening' AND cost_basis = ? AND realized = ? AND basis_released = ?";

const mode = (m: LedgerMode): LedgerMode => oneOf(m, MODES, 'a ledger mode (paper or live)');

function accountOf(r: Row): StoredAccount {
  return Object.freeze({
    mode: cellOneOf(r, 'mode', MODES),
    sol: lamportsCell(r, 'sol'),
    totalDeposits: lamportsCell(r, 'total_deposits'),
    totalWithdrawals: lamportsCell(r, 'total_withdrawals'),
    updatedAt: msCell(r, 'updated_at'),
  });
}

function positionOf(r: Row): StoredPosition {
  const status = cellOneOf(r, 'status', STATUSES);
  if (status === 'stuck') {
    throw new StorageError('bad-cell', "a stuck position is not supported until portfolio/ledger.ts has 'stuck'");
  }
  const closedAt = msCellOrNull(r, 'closed_at');
  if ((status === 'closed') !== (closedAt !== null)) {
    throw new StorageError('bad-cell', 'column closed_at is set exactly when the position is closed');
  }
  const maxSpend = lamportsCellOrNull(r, 'max_spend');
  if (status === 'opening' && maxSpend === null) {
    throw new StorageError('bad-cell', 'column max_spend holds the spend back while the buy is in flight');
  }
  return Object.freeze({
    id: idCell(r, 'id'),
    mint: idCell(r, 'mint'),
    strategy: cellOneOf(r, 'strategy', STRATEGY_IDS),
    mode: cellOneOf(r, 'mode', MODES),
    status,
    openedAt: msCell(r, 'opened_at'),
    closedAt,
    maxSpend,
    p95ExitCost: lamportsCell(r, 'p95_exit_cost'),
    exitSeq: intCell(r, 'exit_seq', 0, MAX_EXIT_SEQ + 1),
    tokenUnits: tokenUnitsCell(r, 'token_units'),
    costBasis: lamportsCell(r, 'cost_basis'),
    rentLocked: lamportsCell(r, 'rent_locked'),
    realized: signedCell(r, 'realized'),
    bought: lamportsCell(r, 'bought'),
    sold: lamportsCell(r, 'sold'),
    venueFees: lamportsCell(r, 'venue_fees'),
    networkFees: lamportsCell(r, 'network_fees'),
    failedFees: lamportsCell(r, 'failed_fees'),
    tips: lamportsCell(r, 'tips'),
    rentPaid: lamportsCell(r, 'rent_paid'),
    rentRefunded: lamportsCell(r, 'rent_refunded'),
    tokensBought: tokenUnitsCell(r, 'tokens_bought'),
    tokensSold: tokenUnitsCell(r, 'tokens_sold'),
    exitFees: lamportsCell(r, 'exit_fees'),
    basisReleased: lamportsCell(r, 'basis_released'),
    updatedAt: msCell(r, 'updated_at'),
  });
}

/** A mode's ledger account; it is required (the owner's setup writes both). */
export function readAccount(r: Reader, m: LedgerMode): StoredAccount {
  const checked = mode(m);
  return accountOf(required(r.get(ACCOUNT, checked), `the ledger account of ${checked}`));
}

/** One position by id; an unknown one is a missing row, a stuck one is refused. */
export function readPosition(r: Reader, id: string): StoredPosition {
  return positionOf(required(r.get(POSITION_BY_ID, idParam(id)), 'the position'));
}

/** Every opening, open and exiting position of both modes, by id: the caps and one position per mint are global. */
export function readActivePositions(r: Reader): readonly StoredPosition[] {
  return Object.freeze(r.all(ACTIVE_POSITIONS).map(positionOf));
}

/** A mode's account and every position of the mode, closed ones included, by id (portfolio/ledger.ts checks it). */
export function readBook(r: Reader, m: LedgerMode): StoredBook {
  const account = readAccount(r, m);
  return Object.freeze({ account, positions: Object.freeze(r.all(BOOK_POSITIONS, account.mode).map(positionOf)) });
}

function spendParam(v: Lamports): string {
  const text = amountParam(v);
  if (v < 1n || v > SCHEMA_V1_COPIES.buyMaxSpendLamports) {
    throw new StorageError('bad-param', 'expected a held-back spend from 1 lamport to 0.07 SOL');
  }
  return text;
}

/**
 * T1, once approveBuy approved: the position is born opening, every amount at zero, its spend held
 * back. Refused before any write without the mode's ledger account, or when the id exists; the
 * database adds one active position per mint and at most four active positions.
 */
export function insertOpening(tx: Tx, opening: OpeningPosition, p95ExitCost: Lamports): void {
  const { id, mint, strategy, mode: m, openedAt, maxSpend } = opening; // each field read once
  const idText = idParam(id);
  const params = [idText, idParam(mint), oneOf(strategy, STRATEGY_IDS, 'a strategy'), mode(m), msParam(openedAt), spendParam(maxSpend), amountParam(p95ExitCost), msParam(openedAt)] as const;
  required(tx.get(ACCOUNT, params[3]), 'the ledger account of the mode');
  if (intCell(required(tx.get(POSITION_COUNT, idText), 'the position count'), 'n', 0, 1) !== 0) {
    throw new StorageError('row-count', 'a position with this id exists already');
  }
  expectChanges(tx.run(INSERT_OPENING, ...params), 1, 'the opening position');
}

/** An exit intent takes the position's next number: from the number read, only while the position can exit. */
export function advanceExitSeq(tx: Tx, positionId: string, seq: number, at: number): void {
  const idText = idParam(positionId);
  if (!Number.isSafeInteger(seq) || seq < 0 || seq > MAX_EXIT_SEQ) {
    throw new StorageError('bad-param', `expected an exit number from 0 to ${MAX_EXIT_SEQ}`);
  }
  const atParam = msParam(at);
  expectChanges(tx.run(ADVANCE_EXIT_SEQ, atParam, idText, intParam(seq)), 1, 'the next exit number (a position that can exit, at the number read)');
}

/**
 * s.3.2's abandonOpeningTx: an opening position that holds no tokens and no rent, whose buy order is
 * absent, failed or expired, is closed at `at` (at or after it opened: app/ passes max(now, openedAt))
 * exactly as ledger.ts abandonOpening does: its cost basis is released as realized loss, and no SOL
 * moves. Returns the closed row. An approved, submitted or landed buy is refused: it may still land.
 */
export function abandonOpening(tx: Tx, positionId: string, at: number): StoredPosition {
  const idText = idParam(positionId);
  const atParam = msParam(at);
  const p = readPosition(tx, idText);
  if (p.status !== 'opening') {
    throw new StorageError('row-count', 'only an opening position is abandoned');
  }
  if (p.tokenUnits > 0n || p.rentLocked > 0n) {
    throw new StorageError('row-count', 'a position that holds tokens or rent is sold and closed, never abandoned');
  }
  if (at < p.openedAt) {
    throw new StorageError('bad-param', 'an abandon is booked at or after the time the position opened');
  }
  const buy = tx.get(BUY_ORDER_STATUS, idText);
  if (buy !== undefined) {
    const status = cellOneOf(buy, 'status', ORDER_STATUSES);
    if (status !== 'failed' && status !== 'expired') {
      throw new StorageError('row-count', 'the buy may still land, or has landed: a position is abandoned only once its buy failed or expired');
    }
  }
  const realized = signedParam(p.realized - p.costBasis);
  const released = amountParam(p.basisReleased + p.costBasis);
  expectChanges(
    tx.run(ABANDON, atParam, realized, released, atParam, idText, amountParam(p.costBasis), signedParam(p.realized), amountParam(p.basisReleased)),
    1,
    'abandoning the position',
  );
  return readPosition(tx, idText);
}
