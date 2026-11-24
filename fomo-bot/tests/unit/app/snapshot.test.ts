// T1's snapshot (STORAGE_DESIGN.md s.16.5.1 phase R; conditions C10, C24, C57, C68; D5.4 and D8 of
// s.16.11): everything an entry decision needs, read inside the one transaction: the flags, every halt
// row of either mode, each mode's sticky streak halt, the pause, the day stop, the low-equity stop, the
// held equity jump, the strategy modes, the bans, cooldowns and pauses, the day's entry count, both
// day states and accounts, every active position of both modes and the active config. Equity is
// valued with the one freshness rule of portfolio/equity.ts: a stale or missing mark makes it
// unknown. A stuck row, a missing account or config, and any live position refuse (paper only).
// Written before src/app/snapshot.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buyCapsOf } from '../../../src/app/caps.ts';
import { AppError } from '../../../src/app/faults.ts';
import { DAY_STATE_MAX_AGE_MS, ledgerOf, readActiveConfig, readBuySnapshot, type BuySnapshot, type BuySnapshotInput } from '../../../src/app/snapshot.ts';
import { firstVersion, nextVersion } from '../../../src/config/changes.ts';
import { DEFAULT_TUNABLES, withValue } from '../../../src/config/tunables.ts';
import { athensDay } from '../../../src/core/day.ts';
import { lamports, tokenUnits } from '../../../src/core/units.ts';
import type { Mark } from '../../../src/portfolio/equity.ts';
import type { BreakerState } from '../../../src/risk/blocks.ts';
import { insertOpening, readBook } from '../../../src/storage/repo-book.ts';
import { insertSnapshot } from '../../../src/storage/repo-observe.ts';
import { addBan, countEntry, setEntriesStopped, setHalt, setKill, setPaused } from '../../../src/storage/repo-flags.ts';
import { setStrategyMode, writeOwnerConfig } from '../../../src/storage/repo-owner.ts';
import { clearKill, setUpConfig } from '../../../src/storage/repo-server.ts';
import type { Db } from '../../../src/storage/sqlite.ts';
import { migratedDb, removeDir, storageError, tamper, tempDir } from '../storage/helpers.ts';
import { T, setUpDb } from './world.ts';

const RENT = lamports(2_039_280n);
const BREAKER: BreakerState['name'] = 'RPC_ERRORS';
const DAY = athensDay(T);
const BANKROLL = 550_000_000n;

function snap(db: Db, over: Partial<BuySnapshotInput> = {}): BuySnapshot {
  return db.transaction((tx) =>
    readBuySnapshot(tx, { now: T, slot: 1_000n, mode: 'paper', marks: new Map(), breakers: [], wsolHelperRent: RENT, killSeen: false, ...over }),
  );
}

/** The money check of 6e: a fresh, valued paper snapshot at T (T1 refuses without one, s.17.6). */
function observed(db: Db, at = T): void {
  db.transaction((tx) => insertSnapshot(tx, 'paper', at, lamports(BANKROLL), lamports(BANKROLL)));
}

function withDb(fn: (db: Db) => void): void {
  const db = setUpDb();
  try {
    observed(db);
    fn(db);
  } finally {
    db.close();
  }
}

const opening = (id: string, mint: string, mode: 'paper' | 'live' = 'paper') => ({ id, mint, strategy: 'momentum' as const, mode, openedAt: T - 5_000, maxSpend: lamports(30_000_000n) });

/** What T3 will do (the buy settled, the position holds tokens), written by hand. */
function holdTokens(db: Db, id: string, units: bigint): void {
  db.transaction((tx) =>
    tx.run("UPDATE positions SET status = 'open', max_spend = NULL, token_units = ?, tokens_bought = ?, updated_at = ? WHERE id = ?", units.toString(), units.toString(), BigInt(T - 4_000), id),
  );
}

const markOf = (value: bigint, units: bigint, at: number): Mark => ({ value: lamports(value), tokenUnits: tokenUnits(units), at });

describe('app/snapshot.ts: what a fresh setup reads', () => {
  it('reads every entry flag, the world and the caps from the rows of the owner setup', () => {
    withDb((db) => {
      const breakers: readonly BreakerState[] = [{ name: BREAKER, scope: { kind: 'all' }, until: null }];
      const s = snap(db, { breakers });
      assert.equal(s.configVersion, 1);
      assert.equal(s.day, DAY);
      assert.equal(s.killStored, false);
      assert.deepEqual(s.caps, buyCapsOf(DEFAULT_TUNABLES, RENT));
      const f = s.world.flags;
      assert.deepEqual(
        {
          kill: f.kill,
          haltReasons: [...f.haltReasons],
          haltClearedAt: f.haltClearedAt,
          paused: f.paused,
          dailyStop: f.dailyStop,
          entriesStopped: f.entriesStopped,
          equityJumpPending: f.equityJumpPending,
          modes: { ...f.modes },
          breakers: [...f.breakers],
          strategyPausedUntil: { ...f.strategyPausedUntil },
          strategyOffUntil: { ...f.strategyOffUntil },
          tokenCooldownUntil: [...f.tokenCooldownUntil],
          bannedMints: [...f.bannedMints],
          blockedCreators: [...f.blockedCreators],
          entriesToday: f.entriesToday,
          entriesPerDay: f.entriesPerDay,
          maxPositions: f.maxPositions,
        },
        {
          kill: false,
          haltReasons: [],
          haltClearedAt: null,
          paused: false,
          dailyStop: false,
          entriesStopped: false,
          equityJumpPending: false,
          modes: { crowdflow: 'off', momentum: 'off', launch: 'off' },
          breakers: [...breakers],
          strategyPausedUntil: {},
          strategyOffUntil: {},
          tokenCooldownUntil: [],
          bannedMints: [],
          blockedCreators: [],
          entriesToday: 0,
          entriesPerDay: DEFAULT_TUNABLES.risk.entriesPerDay,
          maxPositions: DEFAULT_TUNABLES.risk.openPositions,
        },
      );
      assert.deepEqual(
        { now: s.world.now, currentSlot: s.world.currentSlot, positions: [...s.world.positions], equity: { ...s.world.equity }, walletSol: s.world.walletSol },
        { now: T, currentSlot: 1_000n, positions: [], equity: { current: BANKROLL, dayStart: 0n }, walletSol: BANKROLL },
      );
      assert.ok(Object.isFrozen(s) && Object.isFrozen(s.world) && Object.isFrozen(f) && Object.isFrozen(s.world.equity));
    });
  });
});

describe('app/snapshot.ts: each entry flag from its row', () => {
  it('KILL stored, or seen by the latch only', () => {
    withDb((db) => {
      assert.equal(snap(db, { killSeen: true }).world.flags.kill, true);
      assert.equal(snap(db, { killSeen: true }).killStored, false);
      db.transaction((tx) => setKill(tx, T, 'cli'));
      const s = snap(db);
      assert.equal(s.world.flags.kill, true);
      assert.equal(s.killStored, true);
    });
  });

  it('every halt row blocks, whatever mode it was set for, sorted (C24, D5.4)', () => {
    withDb((db) => {
      db.transaction((tx) => {
        setHalt(tx, 'peak-halt:live', T);
        setHalt(tx, 'disk-db', T);
      });
      assert.deepEqual([...snap(db).world.flags.haltReasons], ['disk-db', 'peak-halt:live']);
    });
  });

  it("a sticky streak halt of either mode's day state blocks, as a halt reason (D8 of s.16.11)", () => {
    withDb((db) => {
      const streak = (mode: string): void => {
        db.transaction((tx) => tx.run('UPDATE day_state SET daily_stop_streak = 2, streak_halt = 1, updated_at = ? WHERE mode = ?', BigInt(T), mode));
      };
      streak('live');
      assert.deepEqual([...snap(db).world.flags.haltReasons], ['daily-stop-twice:live']);
      streak('paper');
      db.transaction((tx) => setHalt(tx, 'disk-db', T));
      assert.deepEqual([...snap(db).world.flags.haltReasons], ['daily-stop-twice:live', 'daily-stop-twice:paper', 'disk-db']);
    });
  });

  it('the recovery wait starts at the stored clear time: a cleared KILL too (D6, C68)', () => {
    withDb((db) => {
      db.transaction((tx) => setKill(tx, T - 10_000, 'cli'));
      db.transaction((tx) => clearKill(tx, T - 1_000));
      const f = snap(db).world.flags;
      assert.equal(f.kill, false);
      assert.equal(f.haltClearedAt, T - 1_000);
    });
  });

  it('the pause and the low-equity stop', () => {
    withDb((db) => {
      db.transaction((tx) => setPaused(tx, T - 1));
      assert.equal(snap(db).world.flags.paused, true);
      assert.equal(snap(db).world.flags.entriesStopped, false);
      db.transaction((tx) => setEntriesStopped(tx, true, T - 1));
      assert.equal(snap(db).world.flags.entriesStopped, true);
    });
  });

  it("the daily stop and the held equity jump come from the paper day state, not the live one", () => {
    withDb((db) => {
      db.transaction((tx) => tx.run('UPDATE day_state SET daily_stop_day = ?, daily_stop_streak = 1, updated_at = ? WHERE mode = ?', DAY, BigInt(T), 'live'));
      db.transaction((tx) => tx.run("UPDATE day_state SET jump_pending = 1, jump_held_equity = '900000000', jump_held_at = ?, updated_at = ? WHERE mode = 'live'", BigInt(T - 1), BigInt(T)));
      assert.equal(snap(db).world.flags.dailyStop, false);
      assert.equal(snap(db).world.flags.equityJumpPending, false);
      db.transaction((tx) => tx.run('UPDATE day_state SET daily_stop_day = ?, daily_stop_streak = 1, day_start = ?, updated_at = ? WHERE mode = ?', DAY, '500000000', BigInt(T), 'paper'));
      db.transaction((tx) => tx.run("UPDATE day_state SET jump_pending = 1, jump_held_equity = '900000000', jump_held_at = ?, updated_at = ? WHERE mode = 'paper'", BigInt(T - 1), BigInt(T)));
      const s = snap(db);
      assert.equal(s.world.flags.dailyStop, true);
      assert.equal(s.world.flags.equityJumpPending, true);
      assert.equal(s.world.equity.dayStart, 500_000_000n);
    });
  });

  it('the strategy modes from their rows', () => {
    withDb((db) => {
      db.transaction((tx) => setStrategyMode(tx, T - 1, 'owner-telegram', 'momentum', 'paper'));
      assert.deepEqual({ ...snap(db).world.flags.modes }, { crowdflow: 'off', momentum: 'paper', launch: 'off' });
    });
  });

  it('bans, cooldowns and pauses that still run at now, each in its own place', () => {
    withDb((db) => {
      db.transaction((tx) => {
        addBan(tx, { kind: 'mint-cooldown', key: 'MintC', until: T + 1_000, reason: 'exit', at: T - 1 });
        addBan(tx, { kind: 'mint-cooldown', key: 'MintOld', until: T, reason: 'exit', at: T - 9 }); // ended at now
        addBan(tx, { kind: 'mint-ban', key: 'MintB', until: null, reason: 'rug', at: T - 1 });
        addBan(tx, { kind: 'creator-ban', key: 'CreatorX', until: null, reason: 'rug', at: T - 1 });
        addBan(tx, { kind: 'strategy-pause', key: 'momentum', until: T + 2_000, reason: 'losses', at: T - 1 });
        addBan(tx, { kind: 'strategy-off', key: 'launch', until: T + 3_000, reason: 'losses', at: T - 1 });
      });
      const f = snap(db).world.flags;
      assert.deepEqual([...f.tokenCooldownUntil], [['MintC', T + 1_000]]);
      assert.deepEqual([...f.bannedMints], ['MintB']);
      assert.deepEqual([...f.blockedCreators], ['CreatorX']);
      assert.deepEqual({ ...f.strategyPausedUntil }, { momentum: T + 2_000 });
      assert.deepEqual({ ...f.strategyOffUntil }, { launch: T + 3_000 });
    });
  });

  it("the day's entry count (Athens day), and the active config's limits", () => {
    withDb((db) => {
      db.transaction((tx) => {
        countEntry(tx, DAY);
        countEntry(tx, DAY);
        countEntry(tx, '2026-11-15');
      });
      assert.equal(snap(db).world.flags.entriesToday, 2);
      const v1 = firstVersion(DEFAULT_TUNABLES, T);
      const values = withValue(withValue(v1.values, 'risk.openPositions', 2), 'risk.entriesPerDay', 5);
      db.transaction((tx) => writeOwnerConfig(tx, T + 1, 'owner-telegram', 'owner:set', { version: nextVersion(v1, values, 'owner', T + 1), pending: [], cancelled: [] }));
      const s = snap(db, { now: T + 2 });
      assert.equal(s.configVersion, 2);
      assert.equal(s.world.flags.maxPositions, 2);
      assert.equal(s.world.flags.entriesPerDay, 5);
      assert.deepEqual(s.caps, buyCapsOf(values, RENT));
    });
  });
});

describe('app/snapshot.ts: positions and equity (one freshness rule)', () => {
  it('an opening position counts its held-back spend; an open one its fresh mark, and equity adds it', () => {
    withDb((db) => {
      db.transaction((tx) => {
        insertOpening(tx, opening('p1', 'MintA'), lamports(2_000_000n));
        insertOpening(tx, opening('p2', 'MintB'), lamports(3_000_000n));
      });
      holdTokens(db, 'p2', 400_000n);
      const marks = new Map([['p2', markOf(45_000_000n, 400_000n, T - 1_000)]]);
      const s = snap(db, { marks });
      assert.deepEqual(
        s.world.positions.map((p) => ({ ...p })),
        [
          { id: 'p1', mint: 'MintA', strategy: 'momentum', p95ExitCost: 2_000_000n, status: 'opening', maxSpend: 30_000_000n },
          { id: 'p2', mint: 'MintB', strategy: 'momentum', p95ExitCost: 3_000_000n, status: 'open', value: 45_000_000n },
        ],
      );
      assert.equal(s.world.equity.current, BANKROLL + 45_000_000n);
      assert.equal(s.world.walletSol, BANKROLL);
    });
  });

  it('a stale mark, a missing one or one for another holding makes equity unknown, and the value 0', () => {
    withDb((db) => {
      db.transaction((tx) => insertOpening(tx, opening('p2', 'MintB'), lamports(3_000_000n)));
      holdTokens(db, 'p2', 400_000n);
      for (const marks of [new Map(), new Map([['p2', markOf(45_000_000n, 400_000n, T - 30_001)]]), new Map([['p2', markOf(45_000_000n, 399_999n, T)]])]) {
        const s = snap(db, { marks });
        assert.equal(s.world.equity.current, null);
        assert.deepEqual(s.world.positions.map((p) => (p.status === 'opening' ? null : p.value)), [0n]);
      }
      // exactly 30 s old is still fresh
      assert.equal(snap(db, { marks: new Map([['p2', markOf(1n, 400_000n, T - 30_000)]]) }).world.equity.current, BANKROLL + 1n);
    });
  });

  it('refuses any live position: live trading is not built (C57)', () => {
    withDb((db) => {
      db.transaction((tx) => insertOpening(tx, opening('p9', 'MintL', 'live'), lamports(2_000_000n)));
      assert.throws(() => snap(db), (e: unknown) => e instanceof AppError && e.code === 'live-not-built');
    });
  });

  it('refuses a live mode', () => {
    withDb((db) => {
      assert.throws(() => snap(db, { mode: 'live' as 'paper' }), (e: unknown) => e instanceof AppError && e.code === 'live-not-built');
    });
  });

  it('a stuck row throws: every entry is refused until ledger.ts supports it (C56)', () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, 'bot.sqlite');
      const seed = setUpDb(file);
      seed.transaction((tx) => insertOpening(tx, opening('p1', 'MintA'), lamports(2_000_000n)));
      seed.close();
      tamper(file, "UPDATE positions SET status = 'stuck', max_spend = NULL WHERE id = 'p1';");
      const db = migratedDb(file);
      try {
        storageError(() => snap(db), 'bad-cell');
      } finally {
        db.close();
      }
    } finally {
      removeDir(dir);
    }
  });

  it('a missing ledger account or config version 1 throws, never a default', () => {
    const noLedger = migratedDb();
    try {
      noLedger.transaction((tx) => setUpConfig(tx, T, firstVersion(DEFAULT_TUNABLES, T)));
      storageError(() => snap(noLedger), 'row-missing');
    } finally {
      noLedger.close();
    }
    const nothing = migratedDb();
    try {
      storageError(() => snap(nothing), 'row-missing');
      storageError(() => readActiveConfig(nothing), 'row-missing');
    } finally {
      nothing.close();
    }
  });
});

describe('app/snapshot.ts: the money check is fresh (6e-2, s.17.6, R2)', () => {
  const stale = (fn: () => unknown, why: string): void => {
    assert.throws(fn, (e: unknown) => e instanceof AppError && e.code === 'day-state-stale', why);
  };
  /** A set-up database with exactly these paper snapshots (and a live one at T, which never counts). */
  const withRows = (rows: readonly (readonly [number, bigint | null])[], fn: (db: Db) => void): void => {
    const db = setUpDb();
    try {
      db.transaction((tx) => {
        insertSnapshot(tx, 'live', T, lamports(BANKROLL), null);
        for (const [at, equity] of rows) {
          insertSnapshot(tx, 'paper', at, equity === null ? null : lamports(equity), null);
        }
      });
      fn(db);
    } finally {
      db.close();
    }
  };

  it('refuses entries with no snapshot, one 30,001 ms old, one with unknown equity or one only after now; 30,000 ms passes', () => {
    assert.equal(DAY_STATE_MAX_AGE_MS, 30_000);
    withRows([], (db) => stale(() => snap(db), 'no paper snapshot (the live one does not count)'));
    withRows([[T - 30_001, BANKROLL]], (db) => stale(() => snap(db), '30,001 ms old'));
    withRows([[T, null]], (db) => stale(() => snap(db), 'unknown equity'));
    withRows([[T + 1, BANKROLL]], (db) => stale(() => snap(db), 'only after now'));
    withRows([[T - 10_000, BANKROLL], [T - 5_000, null]], (db) => stale(() => snap(db), 'a valued older one does not rescue an unvalued newest one'));
    withRows([[T - 30_000, BANKROLL]], (db) => assert.equal(snap(db).world.equity.current, BANKROLL));
  });
});

describe('app/snapshot.ts: readActiveConfig and ledgerOf', () => {
  it('the newest config version, decoded', () => {
    withDb((db) => {
      assert.deepEqual(readActiveConfig(db), { versionId: 1, tunables: DEFAULT_TUNABLES });
      assert.ok(Object.isFrozen(readActiveConfig(db)));
    });
  });

  it("a book's ledger: its account, its positions by id, no settled orders yet (T3)", () => {
    withDb((db) => {
      db.transaction((tx) => insertOpening(tx, opening('p1', 'MintA'), lamports(2_000_000n)));
      const book = readBook(db, 'paper');
      const ledger = ledgerOf(book);
      assert.equal(ledger.mode, 'paper');
      assert.equal(ledger.sol, BANKROLL);
      assert.equal(ledger.totalDeposits, BANKROLL);
      assert.equal(ledger.totalWithdrawals, 0n);
      assert.equal(ledger.updatedAt, book.account.updatedAt);
      assert.deepEqual([...ledger.positions.keys()], ['p1']);
      assert.equal(ledger.positions.get('p1'), book.positions[0]);
      assert.equal(ledger.settledOrders.size, 0);
      assert.ok(Object.isFrozen(ledger));
      assert.throws(
        () => ledgerOf({ account: readBook(db, 'live').account, positions: book.positions }),
        (e: unknown) => e instanceof AppError && e.code === 'bad-request',
      );
    });
  });
});
