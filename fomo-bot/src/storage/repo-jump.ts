// The jump confirmation's write (STORAGE_DESIGN.md s.17.5.2 and s.17.16; contract 3 of RISK_POLICY.md;
// review W1, security 1): the only writer that clears a held +50% jump. Only app/jump-tx.ts may import
// this file (the architecture rule), and app/jump-tx.ts only cli/, so no strategy, Telegram or AI path
// can clear a hold, not even by calling storage directly. The write sets the jump columns and nothing
// else, from the stored hold: the acknowledgement's time is the write's own clock reading (never a time
// the caller names), at most 5 minutes after the hold and never before it, and its equity is never above
// what the hold saw (risk/daystate.ts confirmEquityJump decides the level; this re-checks it).
import type { Lamports } from '../core/units.ts';
import { amountParam, msParam } from './codec.ts';
import { readDayState, type LedgerMode } from './repo-day.ts';
import { expectChanges, oneOf } from './repo-util.ts';
import { StorageError, type Tx } from './sqlite.ts';

const MODES = Object.freeze(['paper', 'live'] as const);

/** risk/daystate.ts: a confirmation follows its held observation by at most 5 minutes (a test pins the two together). */
const CONFIRM_WINDOW_MS = 5 * 60_000;

const CLEAR_HOLD =
  'UPDATE day_state SET jump_pending = 0, jump_held_equity = NULL, jump_held_at = NULL, jump_ack_equity = ?, jump_ack_at = ?, updated_at = ? WHERE mode = ? AND jump_pending = 1';

/**
 * A held jump confirmed at `at` (the confirmation's one clock reading): the hold cleared and the
 * acknowledgement set to `ackEquity` at `at`. Refused, with nothing written, when no jump is held, when
 * `at` is before the hold or more than 5 minutes after it, or when `ackEquity` is above the held level.
 */
export function confirmHeldJump(tx: Tx, m: LedgerMode, ackEquity: Lamports, at: number): void {
  const checked = oneOf(m, MODES, 'a ledger mode (paper or live)');
  const atParam = msParam(at);
  const equityParam = amountParam(ackEquity);
  const held = readDayState(tx, checked).jumpHeld;
  if (held === null) {
    throw new StorageError('bad-param', 'there is no held jump to confirm');
  }
  if (at < held.at || at - held.at > CONFIRM_WINDOW_MS) {
    throw new StorageError('bad-param', "a held jump is confirmed at the write's own time, at most 5 minutes after the hold and never before it");
  }
  if (ackEquity > held.equity) {
    throw new StorageError('bad-param', 'a confirmation never vouches for more than the hold saw');
  }
  expectChanges(tx.run(CLEAR_HOLD, equityParam, atParam, atParam, checked), 1, 'the confirmed jump');
}
