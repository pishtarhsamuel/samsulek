// The book (STORAGE_DESIGN.md s.15.4, s.15.5 and s.15.9 as decided): each mode's ledger account,
// written once by the owner's setup at the server (never a default, never a migration: the paper
// bankroll as its one deposit, live at zero; nothing moves the totals afterwards until the transfers
// of Phase 8), and the positions in the Position shape of portfolio/ledger.ts. A 'stuck' row is
// refused on read until ledger.ts supports it, never mapped to another status. T1 opens a position;
// an exit intent uses up the position's sequence number; an opening position whose buy can no longer
// land is abandoned exactly as ledger.ts abandonOpening does. Written before src/storage/repo-book.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { HARD_CAPS } from '../../../src/config/caps.ts';
import { LAMPORTS_PER_SOL as SOL, lamports, type Lamports } from '../../../src/core/units.ts';
import { abandonOpening as ledgerAbandon, checkConservation, type Ledger } from '../../../src/portfolio/ledger.ts';
import { emptyEquityState } from '../../../src/risk/daystate.ts';
import type { OpeningPosition } from '../../../src/risk/approve.ts';
import * as bookFile from '../../../src/storage/repo-book.ts';
import { abandonOpening, advanceExitSeq, insertOpening, readAccount, readActivePositions, readBook, readPosition, type StoredBook } from '../../../src/storage/repo-book.ts';
import { verifyAuditChain } from '../../../src/storage/repo-audit.ts';
import { readDayState } from '../../../src/storage/repo-day.ts';
import { SERVER_AUDIT_ACTIONS, setUpLedger } from '../../../src/storage/repo-server.ts';
import type { Db } from '../../../src/storage/sqlite.ts';
import { TEST_NOW, count, dump, migratedDb, removeDir, storageError, tamper, tempDir } from './helpers.ts';

const T = TEST_NOW;
const BANKROLL = lamports(550_000_000n);
const STUCK = /a stuck position is not supported until portfolio\/ledger.ts has 'stuck'/;

const opening = (id: string, mint: string, patch: Partial<OpeningPosition> = {}): OpeningPosition =>
  Object.freeze({ id, mint, strategy: 'momentum', mode: 'paper', openedAt: T, maxSpend: lamports(60_000_000n), ...patch }) as OpeningPosition;

function withDb(fn: (db: Db) => void, setUp = true): void {
  const db = migratedDb();
  try {
    if (setUp) {
      db.transaction((tx) => setUpLedger(tx, T, BANKROLL));
    }
    fn(db);
  } finally {
    db.close();
  }
}

function withTampered(script: string, fn: (db: Db) => void): void {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'bot.sqlite');
    const seed = migratedDb(file);
    seed.transaction((tx) => {
      setUpLedger(tx, T, BANKROLL);
      insertOpening(tx, opening('p1', 'MintA'), lamports(2_000_000n));
      insertOpening(tx, opening('p2', 'MintB'), lamports(2_000_000n));
    });
    seed.close();
    tamper(file, script);
    const db = migratedDb(file);
    try {
      fn(db);
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
}

/** A careless caller that catches the refusal inside the transaction and commits: nothing of the call is written. */
function refusedInside(db: Db, fn: Parameters<Db['transaction']>[0], code: Parameters<typeof storageError>[1], why: RegExp = /./): void {
  const before = dump(db);
  db.transaction((tx) => {
    assert.match(storageError(() => fn(tx), code).detail, why);
  });
  assert.equal(dump(db), before);
}

/** What T3 will do (an open position holding tokens), written by hand: no writer in this step makes it. */
function holdTokens(db: Db, id: string): void {
  db.transaction((tx) => tx.run("UPDATE positions SET status = 'open', token_units = '100', tokens_bought = '100', updated_at = ? WHERE id = ?", BigInt(T + 1), id));
}

/** The book as portfolio/ledger.ts holds it (no order is settled in this step). */
function ledgerOf(book: StoredBook): Ledger {
  return {
    mode: book.account.mode,
    sol: book.account.sol,
    totalDeposits: book.account.totalDeposits,
    totalWithdrawals: book.account.totalWithdrawals,
    positions: new Map(book.positions.map((p) => [p.id, p])),
    settledOrders: new Set(),
    updatedAt: book.account.updatedAt,
  };
}

describe('the book file: only what it may do', () => {
  it('exports the account and position readers, the opening, the exit number and the abandon, and nothing else: a new export here is a reviewed change', () => {
    assert.deepEqual(Object.keys(bookFile).sort(), ['abandonOpening', 'advanceExitSeq', 'insertOpening', 'readAccount', 'readActivePositions', 'readBook', 'readPosition']);
  });
});

describe('the ledger accounts: written once by the owner\'s setup at the server, never a default', () => {
  it('there is no account before the setup: reading one is a missing row (contract 1)', () => {
    withDb((db) => {
      storageError(() => readAccount(db, 'paper'), 'row-missing');
      storageError(() => readBook(db, 'live'), 'row-missing');
    }, false);
  });

  it('the setup writes the server\'s row, then paper with its bankroll as its one deposit and live at zero; the day state stays as the migration made it', () => {
    withDb((db) => {
      assert.ok(SERVER_AUDIT_ACTIONS.includes('server:setup-ledger'));
      db.transaction((tx) => setUpLedger(tx, T, BANKROLL));
      assert.deepEqual(readAccount(db, 'paper'), { mode: 'paper', sol: BANKROLL, totalDeposits: BANKROLL, totalWithdrawals: 0n, updatedAt: T });
      assert.deepEqual(readAccount(db, 'live'), { mode: 'live', sol: 0n, totalDeposits: 0n, totalWithdrawals: 0n, updatedAt: T });
      assert.ok(Object.isFrozen(readAccount(db, 'paper')));
      const audit = db.all('SELECT actor, action, detail_json FROM audit_log ORDER BY id');
      assert.deepEqual(audit.map((r) => [r['actor'], r['action'], r['detail_json']]), [['owner-server', 'server:setup-ledger', '{"paper":"550000000"}']]);
      assert.equal(verifyAuditChain(db).rows, 1);
      for (const m of ['paper', 'live'] as const) {
        assert.deepEqual(readDayState(db, m), emptyEquityState()); // the first accepted observation sets it
      }
    }, false);
  });

  it('the setup runs once: a second run is refused with nothing written, and so is a bankroll that is not a positive amount', () => {
    withDb((db) => {
      refusedInside(db, (tx) => setUpLedger(tx, T + 1, BANKROLL), 'row-count', /set up already/);
    });
    withDb((db) => {
      for (const bad of [0n, -1n, 1, null] as unknown as Lamports[]) {
        storageError(() => db.transaction((tx) => setUpLedger(tx, T, bad)), 'bad-param');
      }
      storageError(() => db.transaction((tx) => setUpLedger(tx, Number.NaN, BANKROLL)), 'bad-param');
      assert.equal(count(db, 'ledger_accounts'), 0n);
      assert.equal(count(db, 'audit_log'), 0n);
    }, false);
  });

  it('the paper bankroll is at most the hard equity sanity limit (2.0 SOL, config/caps.ts): one lamport more is refused with nothing written (review S, risk 4)', () => {
    const limit = HARD_CAPS.equitySanityLamports;
    assert.equal(limit, 2n * SOL); // storage keeps its own copy of this number: this pins the two together
    withDb((db) => {
      for (const bad of [limit + 1n, 2n ** 63n, 2n ** 64n - 1n]) {
        assert.match(storageError(() => db.transaction((tx) => setUpLedger(tx, T, lamports(bad))), 'bad-param').detail, /2\.0 SOL sanity limit/);
      }
      assert.equal(count(db, 'ledger_accounts'), 0n);
      assert.equal(count(db, 'audit_log'), 0n);
      db.transaction((tx) => setUpLedger(tx, T, lamports(limit)));
      assert.equal(readAccount(db, 'paper').totalDeposits, limit);
    }, false);
    withDb((db) => {
      db.transaction((tx) => setUpLedger(tx, T, lamports(1n)));
      assert.equal(readAccount(db, 'paper').sol, 1n);
    }, false);
  });

  it('an account changed behind the bot\'s back is refused, never repaired: each bad cell names its column, and a missing row throws', () => {
    for (const [col, value] of [['sol', "'-1'"], ['total_deposits', "'1.5'"], ['total_withdrawals', "'x'"], ['updated_at', '-1']] as const) {
      withTampered(`PRAGMA ignore_check_constraints = 1;\nUPDATE ledger_accounts SET ${col} = ${value} WHERE mode = 'paper';`, (db) => {
        assert.match(storageError(() => readAccount(db, 'paper'), 'bad-cell').detail, new RegExp(`column ${col}`));
        assert.equal(readAccount(db, 'live').sol, 0n);
      });
    }
    withTampered("DROP TRIGGER ledger_accounts_no_delete;\nDELETE FROM ledger_accounts WHERE mode = 'live';", (db) => {
      storageError(() => readAccount(db, 'live'), 'row-missing');
      storageError(() => readBook(db, 'live'), 'row-missing');
    });
  });
});

describe('positions: born opening by T1, read in the Position shape of portfolio/ledger.ts', () => {
  it('opens a position with every amount at zero, its spend held back, its p95 exit cost and exit number 0', () => {
    withDb((db) => {
      db.transaction((tx) => insertOpening(tx, opening('p1', 'MintA'), lamports(2_500_000n)));
      const p = readPosition(db, 'p1');
      assert.deepEqual(p, {
        id: 'p1',
        mint: 'MintA',
        strategy: 'momentum',
        mode: 'paper',
        status: 'opening',
        openedAt: T,
        closedAt: null,
        maxSpend: 60_000_000n,
        p95ExitCost: 2_500_000n,
        exitSeq: 0,
        tokenUnits: 0n,
        costBasis: 0n,
        rentLocked: 0n,
        realized: 0n,
        bought: 0n,
        sold: 0n,
        venueFees: 0n,
        networkFees: 0n,
        failedFees: 0n,
        tips: 0n,
        rentPaid: 0n,
        rentRefunded: 0n,
        tokensBought: 0n,
        tokensSold: 0n,
        exitFees: 0n,
        basisReleased: 0n,
        updatedAt: T,
      });
      assert.ok(Object.isFrozen(p));
      checkConservation(ledgerOf(readBook(db, 'paper')));
    });
  });

  it('the held-back spend is 1 lamport to 0.07 SOL (the schema\'s cap), ids are at most 63 characters, and the mode needs its account', () => {
    withDb((db) => {
      for (const bad of [0n, 70_000_001n]) {
        refusedInside(db, (tx) => insertOpening(tx, opening('p1', 'MintA', { maxSpend: lamports(bad) }), lamports(0n)), 'bad-param');
      }
      db.transaction((tx) => insertOpening(tx, opening('p1', 'MintA', { maxSpend: lamports(1n) }), lamports(0n)));
      db.transaction((tx) => insertOpening(tx, opening('p2', 'MintB', { maxSpend: lamports(70_000_000n) }), lamports(0n)));
      refusedInside(db, (tx) => insertOpening(tx, opening('q'.repeat(64), 'MintC'), lamports(0n)), 'bad-param');
      db.transaction((tx) => insertOpening(tx, opening('q'.repeat(63), 'MintC'), lamports(0n)));
      refusedInside(db, (tx) => insertOpening(tx, opening('p4', 'MintD', { strategy: 'copy' as unknown as 'momentum' }), lamports(0n)), 'bad-param');
      refusedInside(db, (tx) => insertOpening(tx, opening('p4', 'MintD', { mode: 'demo' as unknown as 'paper' }), lamports(0n)), 'bad-param');
      refusedInside(db, (tx) => insertOpening(tx, opening('p4', 'MintD'), -1n as Lamports), 'bad-param');
      refusedInside(db, (tx) => insertOpening(tx, opening('p4', 'MintD', { openedAt: Number.NaN }), lamports(0n)), 'bad-param');
    });
    withDb((db) => {
      refusedInside(db, (tx) => insertOpening(tx, opening('p1', 'MintA'), lamports(0n)), 'row-missing', /ledger account/);
    }, false);
  });

  it('an id that exists is refused before any write; a second active position on a mint, or a fifth active one, is the database\'s refusal, and nothing is written', () => {
    withDb((db) => {
      db.transaction((tx) => insertOpening(tx, opening('p1', 'MintA'), lamports(0n)));
      refusedInside(db, (tx) => insertOpening(tx, opening('p1', 'MintZ'), lamports(0n)), 'row-count', /exists/);
      const before = dump(db);
      storageError(() => db.transaction((tx) => insertOpening(tx, opening('p2', 'MintA'), lamports(0n))), 'constraint');
      assert.equal(dump(db), before);
      db.transaction((tx) => {
        for (const n of [2, 3, 4]) {
          insertOpening(tx, opening(`p${n}`, `Mint${n}`), lamports(0n));
        }
      });
      const four = dump(db);
      storageError(() => db.transaction((tx) => insertOpening(tx, opening('p5', 'Mint5'), lamports(0n))), 'constraint');
      assert.equal(dump(db), four);
    });
  });

  it('the active list holds opening, open and exiting positions of both modes, by id, and leaves closed ones out', () => {
    withDb((db) => {
      db.transaction((tx) => {
        insertOpening(tx, opening('p3', 'MintC'), lamports(0n));
        insertOpening(tx, opening('p1', 'MintA', { mode: 'live' }), lamports(0n));
        insertOpening(tx, opening('p2', 'MintB'), lamports(0n));
      });
      holdTokens(db, 'p2');
      db.transaction((tx) => abandonOpening(tx, 'p3', T + 5));
      assert.deepEqual(readActivePositions(db).map((p) => [p.id, p.mode, p.status]), [['p1', 'live', 'opening'], ['p2', 'paper', 'open']]);
      assert.deepEqual(readBook(db, 'paper').positions.map((p) => [p.id, p.status]), [['p2', 'open'], ['p3', 'closed']]);
      assert.deepEqual(readBook(db, 'live').positions.map((p) => p.id), ['p1']);
      assert.ok(Object.isFrozen(readActivePositions(db)));
    });
  });

  it('a stuck row is refused on every read with a fixed sentence, never mapped to another status, and other positions still read one by one', () => {
    withTampered("UPDATE positions SET status = 'stuck', max_spend = NULL WHERE id = 'p1';", (db) => {
      assert.match(storageError(() => readPosition(db, 'p1'), 'bad-cell').detail, STUCK);
      assert.match(storageError(() => readActivePositions(db), 'bad-cell').detail, STUCK); // never left out: the cap would count one too few
      assert.match(storageError(() => readBook(db, 'paper'), 'bad-cell').detail, STUCK);
      assert.equal(readPosition(db, 'p2').status, 'opening');
    });
  });

  it('a position changed behind the bot\'s back is refused, never repaired: each bad cell names its column, an unknown id is a missing row', () => {
    const cells: readonly (readonly [string, string])[] = [
      ['mint', "'Mint A'"],
      ['strategy', "'copy'"],
      ['status', "'gone'"],
      ['opened_at', '-1'],
      ['p95_exit_cost', "'-5'"],
      ['exit_seq', '-1'],
      ['token_units', "'x'"],
      ['realized', "'1.5'"],
      ['basis_released', "''"],
      ['updated_at', '-1'], // a STRICT table keeps an INTEGER an integer even without its CHECKs
    ];
    for (const [col, value] of cells) {
      // behind the bot's back: no CHECK and no identity trigger stops a raw handle
      withTampered(`PRAGMA ignore_check_constraints = 1;\nDROP TRIGGER positions_identity;\nUPDATE positions SET ${col} = ${value} WHERE id = 'p1';`, (db) => {
        assert.match(storageError(() => readPosition(db, 'p1'), 'bad-cell').detail, new RegExp(`column ${col}`));
      });
    }
    withTampered("PRAGMA ignore_check_constraints = 1;\nUPDATE positions SET max_spend = NULL WHERE id = 'p1';", (db) => {
      assert.match(storageError(() => readPosition(db, 'p1'), 'bad-cell').detail, /max_spend/); // an opening position holds its spend back
    });
    withTampered("PRAGMA ignore_check_constraints = 1;\nUPDATE positions SET closed_at = 5 WHERE id = 'p1';", (db) => {
      assert.match(storageError(() => readPosition(db, 'p1'), 'bad-cell').detail, /closed_at/); // closed exactly when closed_at is set
    });
    withDb((db) => {
      storageError(() => readPosition(db, 'nope'), 'row-missing');
      storageError(() => readPosition(db, 'bad id' as string), 'bad-param');
    });
  });
});

describe('the exit number: each exit intent takes the position\'s next one, once', () => {
  it('moves up by one from the number it was read at, only for a position that can exit', () => {
    withDb((db) => {
      db.transaction((tx) => insertOpening(tx, opening('p1', 'MintA'), lamports(0n)));
      refusedInside(db, (tx) => advanceExitSeq(tx, 'p1', 0, T + 1), 'row-count'); // an opening position cannot exit
      holdTokens(db, 'p1');
      db.transaction((tx) => advanceExitSeq(tx, 'p1', 0, T + 2));
      assert.deepEqual([readPosition(db, 'p1').exitSeq, readPosition(db, 'p1').updatedAt], [1, T + 2]);
      refusedInside(db, (tx) => advanceExitSeq(tx, 'p1', 0, T + 3), 'row-count'); // the number read is stale
      refusedInside(db, (tx) => advanceExitSeq(tx, 'p1', 2, T + 3), 'row-count');
      refusedInside(db, (tx) => advanceExitSeq(tx, 'nope', 1, T + 3), 'row-count');
      for (const bad of [-1, 1.5, 1_000_000, Number.NaN]) {
        refusedInside(db, (tx) => advanceExitSeq(tx, 'p1', bad, T + 3), 'bad-param');
      }
      refusedInside(db, (tx) => advanceExitSeq(tx, 'p1', 1, Number.NaN), 'bad-param');
    });
  });

  it('the last number a position can take is 999,999 (the column stops at 1,000,000)', () => {
    withDb((db) => {
      db.transaction((tx) => insertOpening(tx, opening('p1', 'MintA'), lamports(0n)));
      holdTokens(db, 'p1');
      db.transaction((tx) => tx.run("UPDATE positions SET exit_seq = 999999 WHERE id = 'p1'"));
      db.transaction((tx) => advanceExitSeq(tx, 'p1', 999_999, T + 2));
      assert.equal(readPosition(db, 'p1').exitSeq, 1_000_000);
      refusedInside(db, (tx) => advanceExitSeq(tx, 'p1', 1_000_000, T + 3), 'bad-param');
    });
  });
});

describe('abandoning an opening position whose buy can no longer land (s.3.2): exactly ledger.ts abandonOpening', () => {
  it('closes it at the given time, releases its basis as realized, moves no SOL, and the book still balances', () => {
    withDb((db) => {
      db.transaction((tx) => insertOpening(tx, opening('p1', 'MintA'), lamports(2_000_000n)));
      const before = readBook(db, 'paper');
      const closed = db.transaction((tx) => abandonOpening(tx, 'p1', T + 60_000));
      const expected = ledgerAbandon(ledgerOf(before), 'p1', T + 60_000).positions.get('p1');
      assert.deepEqual({ ...closed, mode: undefined, maxSpend: undefined, p95ExitCost: undefined, exitSeq: undefined, updatedAt: undefined }, { ...expected, mode: undefined, maxSpend: undefined, p95ExitCost: undefined, exitSeq: undefined, updatedAt: undefined });
      assert.deepEqual(readPosition(db, 'p1'), closed);
      assert.deepEqual([closed.status, closed.closedAt, closed.updatedAt], ['closed', T + 60_000, T + 60_000]);
      assert.deepEqual(readAccount(db, 'paper'), before.account);
      checkConservation(ledgerOf(readBook(db, 'paper')));
    });
  });

  it('a failed attempt\'s fee in its basis (what T3 books) becomes realized loss when abandoned, as ledger.ts does it', () => {
    withDb((db) => {
      db.transaction((tx) => insertOpening(tx, opening('p1', 'MintA'), lamports(0n)));
      // T3 (later) books a failed buy attempt's network fee into the opening position's basis
      db.transaction((tx) => tx.run("UPDATE positions SET failed_fees = '5000', cost_basis = '5000' WHERE id = 'p1'"));
      db.transaction((tx) => tx.run("UPDATE ledger_accounts SET sol = '549995000' WHERE mode = 'paper'"));
      const before = readBook(db, 'paper');
      checkConservation(ledgerOf(before));
      const closed = db.transaction((tx) => abandonOpening(tx, 'p1', T + 1));
      const expected = ledgerAbandon(ledgerOf(before), 'p1', T + 1).positions.get('p1');
      assert.deepEqual([closed.costBasis, closed.realized, closed.basisReleased], [0n, -5_000n, 5_000n]);
      assert.deepEqual([closed.costBasis, closed.realized, closed.basisReleased], [expected?.costBasis, expected?.realized, expected?.basisReleased]);
      checkConservation(ledgerOf(readBook(db, 'paper')));
    });
  });

  it('refused, with nothing written: a missing position, one that is not opening, a time before it opened; a closed position is final', () => {
    withDb((db) => {
      db.transaction((tx) => {
        insertOpening(tx, opening('p1', 'MintA'), lamports(0n));
        insertOpening(tx, opening('p2', 'MintB'), lamports(0n));
      });
      refusedInside(db, (tx) => abandonOpening(tx, 'nope', T + 1), 'row-missing');
      refusedInside(db, (tx) => abandonOpening(tx, 'p1', T - 1), 'bad-param', /opened/);
      refusedInside(db, (tx) => abandonOpening(tx, 'p1', Number.NaN), 'bad-param');
      holdTokens(db, 'p2');
      refusedInside(db, (tx) => abandonOpening(tx, 'p2', T + 1), 'row-count', /opening/);
      db.transaction((tx) => abandonOpening(tx, 'p1', T));
      refusedInside(db, (tx) => abandonOpening(tx, 'p1', T + 2), 'row-count', /opening/);
    });
  });

  it('a position holding tokens or rent is never abandoned, even if it still reads as opening', () => {
    withDb((db) => {
      db.transaction((tx) => insertOpening(tx, opening('p1', 'MintA'), lamports(0n)));
      db.transaction((tx) => tx.run("UPDATE positions SET rent_locked = '5', rent_paid = '5', cost_basis = '5' WHERE id = 'p1'"));
      refusedInside(db, (tx) => abandonOpening(tx, 'p1', T + 1), 'row-count', /tokens or rent/);
    });
  });
});
