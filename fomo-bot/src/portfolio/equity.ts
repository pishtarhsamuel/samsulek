// Equity valuation (RISK_POLICY.md s.4). Equity = SOL + every position that holds tokens at its
// mark: the exact full-size sell quote after the venue fee and the exit network fee, never a mid
// price. Locked token-account rent never counts, and marks for anything that is not one of our
// positions (spam tokens, address-poisoning dust) are ignored.
// - A mark is fresh when it quotes exactly the tokens the position holds now (a mark taken before
//   a partial sell would count the sold tokens twice) and is at most staleAfterMs old.
// - Any position without a fresh mark makes equity unknown (null): entries are blocked and the
//   stops are not evaluated on a guess.
// - For the stops only, a position whose last mark is older than stopZeroAfterMs is valued 0, so
//   a dead price feed can trip a stop but never hide a loss. A position with no mark at all (just
//   bought, or right after a restart) or with a mark from the future (a clock problem) is unknown
//   for the stops too, never 0: a stop must not trip on a price that was never there.
// - Contract: marks are stamped by core/clock when they are received, and `now` is read after the
//   marks were collected.
// - Live: SOL is the lower of the ledger and the chain, so an unexplained inflow never raises equity.
import { isMillis } from '../core/time.ts';
import { lamports, tokenUnits, type Lamports, type TokenUnits } from '../core/units.ts';
import { LedgerError, type Ledger } from './ledger.ts';

export interface Mark {
  /** Full-size sell quote after the venue fee and the exit network fee, in lamports. */
  readonly value: Lamports;
  /** The token amount the quote is for: it must equal the position's holding to count. */
  readonly tokenUnits: TokenUnits;
  /** When the quote was received (UTC ms, core/clock). */
  readonly at: number;
}

export interface EquityPolicy {
  /** A mark older than this is stale: equity is unknown and entries are blocked. */
  readonly staleAfterMs: number;
  /** For the stops, a position stale for longer than this is valued 0. */
  readonly stopZeroAfterMs: number;
}

export interface EquityValue {
  readonly sol: Lamports;
  /** The positions with a fresh mark. */
  readonly positionsValue: Lamports;
  /** null while any position lacks a fresh mark. */
  readonly equity: Lamports | null;
  /** Equity for the stops; null while a position is stale but not yet for stopZeroAfterMs. */
  readonly stopEquity: Lamports | null;
  /** Mints of the positions without a fresh mark. */
  readonly staleMints: readonly string[];
}

function walletSol(ledger: Ledger, chainSol: Lamports | null): Lamports {
  if (ledger.mode === 'paper') {
    if (chainSol !== null) {
      throw new LedgerError('paper equity uses the paper balance, not a chain balance');
    }
    return ledger.sol;
  }
  if (chainSol === null) {
    throw new LedgerError('live equity needs the wallet balance read from the chain');
  }
  const chain = lamports(chainSol);
  return chain < ledger.sol ? chain : ledger.sol;
}

/** Values the ledger at `now`. Marks are keyed by position id; chainSol is required in live mode only. */
export function valueEquity(
  ledger: Ledger,
  marks: ReadonlyMap<string, Mark>,
  now: number,
  policy: EquityPolicy,
  chainSol: Lamports | null = null,
): EquityValue {
  if (!isMillis(now)) {
    throw new LedgerError('now must be a UTC millisecond timestamp');
  }
  const { staleAfterMs, stopZeroAfterMs } = policy;
  if (!isMillis(staleAfterMs) || !isMillis(stopZeroAfterMs) || staleAfterMs > stopZeroAfterMs) {
    throw new LedgerError('equity policy needs whole milliseconds with staleAfterMs <= stopZeroAfterMs');
  }
  const sol = walletSol(ledger, chainSol);
  let fresh = 0n;
  let stopsUnknown = false;
  const staleMints: string[] = [];
  for (const p of ledger.positions.values()) {
    if (p.tokenUnits === 0n) {
      continue; // opening, exiting or closed: worth 0 and needs no mark
    }
    const mark = marks.get(p.id);
    if (mark === undefined) {
      staleMints.push(p.mint);
      stopsUnknown = true;
      continue;
    }
    const value = lamports(mark.value);
    const quoted = tokenUnits(mark.tokenUnits);
    if (!isMillis(mark.at)) {
      throw new LedgerError(`the mark of position ${p.id} has no valid time`);
    }
    if (mark.at > now) {
      staleMints.push(p.mint); // a clock problem: neither fresh nor ever 0
      stopsUnknown = true;
      continue;
    }
    const age = now - mark.at;
    if (quoted === p.tokenUnits && age <= staleAfterMs) {
      fresh += value;
      continue;
    }
    staleMints.push(p.mint); // too old, or quotes a holding that has changed since
    if (age <= stopZeroAfterMs) {
      stopsUnknown = true;
    }
  }
  const total = lamports(sol + fresh);
  return Object.freeze({
    sol,
    positionsValue: lamports(fresh),
    equity: staleMints.length === 0 ? total : null,
    stopEquity: stopsUnknown ? null : total,
    staleMints: Object.freeze(staleMints),
  });
}
