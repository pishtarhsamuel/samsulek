// T1's snapshot (STORAGE_DESIGN.md s.16.5.1, phase R; conditions C10, C24, C57 and C68): everything
// an entry decision needs, read through the transaction's own handle, so the caps, the exposure and
// one position per mint are decided on what this BEGIN IMMEDIATE sees and nothing else can write in
// between. Every halt row blocks whatever mode it was set for, and so does each mode's sticky streak
// halt (D5.4, stricter); the recovery wait starts at the stored clear time, a cleared KILL's too (D6).
// Equity is valued with the one freshness rule of portfolio/equity.ts: a stale or missing mark makes
// it unknown, which blocks the entry before anything is sized. Paper only: a live mode or any live
// position refuses (live-not-built), and a stuck row, a missing account or config throws, never a
// default. Pure reads: nothing here writes, and nothing here catches (the no-catch rule, C32).
import { decodeTunables, type Tunables } from '../config/tunables.ts';
import { athensDay } from '../core/day.ts';
import { STRATEGY_IDS, type StrategyId } from '../core/ids.ts';
import { lamports, type Lamports } from '../core/units.ts';
import { valueEquity, type Mark } from '../portfolio/equity.ts';
import type { Ledger } from '../portfolio/ledger.ts';
import type { ActivePosition, BuyCaps, BuyWorld, EntryFlags } from '../risk/approve.ts';
import type { BreakerState, StrategyMode } from '../risk/blocks.ts';
import { dailyStopActive } from '../risk/daystate.ts';
import { readAccount, readActivePositions, type StoredBook, type StoredPosition } from '../storage/repo-book.ts';
import { readConfigHistory } from '../storage/repo-config.ts';
import { readDayState } from '../storage/repo-day.ts';
import { activeBans, entriesOn, readFlags, readHalts, readModes, type Ban } from '../storage/repo-flags.ts';
import type { Reader, Tx } from '../storage/sqlite.ts';
import { MARK_POLICY, buyCapsOf } from './caps.ts';
import { AppError } from './faults.ts';

export interface ActiveConfig {
  readonly versionId: number;
  readonly tunables: Tunables;
}

/** The newest config version, decoded; version 1 is required (repo-config.ts), and ids have no gap. */
export function readActiveConfig(r: Reader): ActiveConfig {
  // non-empty (readConfigHistory throws row-missing without version 1), so reduce gives the newest
  const newest = readConfigHistory(r).reduce((_older, v) => v);
  return Object.freeze({ versionId: newest.id, tunables: decodeTunables(newest.valuesJson) });
}

export interface BuySnapshotInput {
  readonly now: number;
  /** The slot T1 read once; it goes into the world as is. */
  readonly slot: bigint;
  readonly mode: 'paper';
  /** The exit loop's marks, keyed by position id, read once before BEGIN. */
  readonly marks: ReadonlyMap<string, Mark>;
  /** The breakers in memory (no table holds them), read once before BEGIN. */
  readonly breakers: readonly BreakerState[];
  /** The chain read of the RentSource. */
  readonly wsolHelperRent: Lamports;
  /** KILL seen anywhere this run (the latch). */
  readonly killSeen: boolean;
}

export interface BuySnapshot {
  readonly world: BuyWorld;
  readonly caps: BuyCaps;
  readonly configVersion: number;
  /** The Athens day of `now`: the day's entry count is this day's. */
  readonly day: string;
  /** The database holds KILL: the latch marks it after COMMIT, so T2 refuses buy tokens issued before. */
  readonly killStored: boolean;
}

/** A mode's account and its positions as portfolio/ledger.ts's Ledger; no settled orders until T3. */
export function ledgerOf(book: StoredBook): Ledger {
  const { account, positions } = book; // each read once
  if (positions.some((p) => p.mode !== account.mode)) {
    throw new AppError('bad-request', "a ledger holds its own mode's positions only");
  }
  return Object.freeze({
    mode: account.mode,
    sol: account.sol,
    totalDeposits: account.totalDeposits,
    totalWithdrawals: account.totalWithdrawals,
    positions: new Map(positions.map((p) => [p.id, p])),
    settledOrders: new Set<string>(),
    updatedAt: account.updatedAt,
  });
}

/**
 * The end of a cooldown or pause. The database's CHECK keeps it set for every kind that ends; were a
 * null to slip through, risk's own time check would refuse the entry (fail closed).
 */
const endOf = (b: Ban): number => b.until as number;

/** activeBans reads a strategy kind's key with cellOneOf(STRATEGY_IDS): it is a strategy id. */
const strategyOf = (b: Ban): StrategyId => b.key as StrategyId;

/**
 * A position as the entry rules count it: an opening one at its held-back spend (repo-book.ts keeps
 * it set while opening), the others at their mark. A value only counts while equity is known: then
 * every position that holds tokens has a fresh mark (valueEquity's rule); otherwise equity is null,
 * which blocks the entry before any value is used, and the value is 0.
 */
function activeOf(p: StoredPosition, marks: ReadonlyMap<string, Mark>, valued: boolean): ActivePosition {
  const base = { id: p.id, mint: p.mint, strategy: p.strategy, p95ExitCost: p.p95ExitCost };
  if (p.status === 'opening') {
    return Object.freeze({ ...base, status: 'opening', maxSpend: p.maxSpend as Lamports });
  }
  const value = valued && p.tokenUnits > 0n ? (marks.get(p.id) as Mark).value : 0n;
  // readActivePositions selects opening, open, exiting and stuck rows only, and a stuck one throws
  return Object.freeze({ ...base, status: p.status as 'open' | 'exiting', value: lamports(value) });
}

/** Everything an entry decision needs, read inside T1's transaction (16.5.1 phase R step 3). */
export function readBuySnapshot(tx: Tx, s: BuySnapshotInput): BuySnapshot {
  const { now, slot, mode, marks, breakers, wsolHelperRent, killSeen } = s; // each read once
  if (mode !== 'paper') {
    throw new AppError('live-not-built', 'only paper entries exist until Phase 8');
  }
  const day = athensDay(now);
  const flags = readFlags(tx);
  const halts = readHalts(tx);
  const modeRows = readModes(tx);
  const bans = activeBans(tx, now);
  const entriesToday = entriesOn(tx, day);
  const days = { paper: readDayState(tx, 'paper'), live: readDayState(tx, 'live') };
  const paper = readAccount(tx, 'paper');
  readAccount(tx, 'live'); // required too: the owner's setup writes both, and a missing one is a broken book
  const active = readActivePositions(tx);
  const { versionId, tunables } = readActiveConfig(tx);
  if (active.some((p) => p.mode !== 'paper')) {
    throw new AppError('live-not-built', 'a live position exists, and live trading is not built (Phase 8)');
  }

  const equity = valueEquity(ledgerOf({ account: paper, positions: active }), marks, now, MARK_POLICY).equity;
  const positions = Object.freeze(active.map((p) => activeOf(p, marks, equity !== null)));

  const streakHalts = (['paper', 'live'] as const).filter((m) => days[m].streakHalt).map((m) => `daily-stop-twice:${m}`);
  const haltReasons = Object.freeze([...new Set([...halts.map((h) => h.reason), ...streakHalts])].sort());
  const modes = {} as Record<StrategyId, StrategyMode>;
  for (const id of STRATEGY_IDS) {
    modes[id] = modeRows[id].mode;
  }
  const pausedUntil: Partial<Record<StrategyId, number>> = {};
  const offUntil: Partial<Record<StrategyId, number>> = {};
  const cooldowns = new Map<string, number>();
  const bannedMints = new Set<string>();
  const blockedCreators = new Set<string>();
  for (const b of bans) {
    switch (b.kind) {
      case 'mint-cooldown':
        cooldowns.set(b.key, endOf(b));
        break;
      case 'mint-ban':
        bannedMints.add(b.key);
        break;
      case 'creator-ban':
        blockedCreators.add(b.key);
        break;
      case 'strategy-pause':
        pausedUntil[strategyOf(b)] = endOf(b);
        break;
      case 'strategy-off':
        offUntil[strategyOf(b)] = endOf(b);
        break;
    }
  }

  const entryFlags: EntryFlags = Object.freeze({
    kill: flags.kill !== null || killSeen,
    haltReasons,
    haltClearedAt: flags.haltClearedAt,
    paused: flags.pausedAt !== null,
    dailyStop: dailyStopActive(days[mode], now),
    entriesStopped: flags.entriesStopped,
    equityJumpPending: days[mode].jumpPending,
    modes: Object.freeze(modes),
    breakers: Object.freeze([...breakers]),
    strategyPausedUntil: Object.freeze(pausedUntil),
    strategyOffUntil: Object.freeze(offUntil),
    tokenCooldownUntil: cooldowns,
    bannedMints,
    blockedCreators,
    entriesToday,
    entriesPerDay: tunables.risk.entriesPerDay,
    maxPositions: tunables.risk.openPositions,
  });
  const world: BuyWorld = Object.freeze({
    now,
    currentSlot: slot,
    flags: entryFlags,
    positions,
    equity: Object.freeze({ current: equity, dayStart: days[mode].dayStart }),
    walletSol: paper.sol,
  });
  return Object.freeze({ world, caps: buyCapsOf(tunables, wsolHelperRent), configVersion: versionId, day, killStored: flags.kill !== null });
}
