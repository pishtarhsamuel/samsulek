// The test world of the day transactions (STORAGE_DESIGN.md s.17.8): the owner's setup (0.55 SOL paper),
// a clock the test moves, a TimeGuard the test switches, the day watch on recording alerts, the real
// fault sink wired to the disk-db halt, the audit anchor in memory, and a marks map the test fills.
// Open positions come from tx-world's openPosition (400,000 tokens each), marked here.
import { persistHaltTx, type StoreDeps } from '../../../src/app/approve-tx.ts';
import { createDayWatch, type DayDeps, type TimeGuard } from '../../../src/app/day-tx.ts';
import { createEntryLatch, createFaultSink, type EntryLatch } from '../../../src/app/faults.ts';
import { lamports, tokenUnits } from '../../../src/core/units.ts';
import type { Mark } from '../../../src/portfolio/equity.ts';
import type { EquityState } from '../../../src/risk/daystate.ts';
import type { Db } from '../../../src/storage/sqlite.ts';
import { memoryAnchors, openPosition, type MemoryAnchors } from './tx-world.ts';
import { T, recordingAlerts, setUpDb, testClock, type RecordingAlerts, type TestClock } from './world.ts';

export const SOL = 1_000_000_000n;
/** The paper bankroll of the owner's setup in world.ts. */
export const PAPER = 550_000_000n;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export interface DayWorld {
  readonly db: Db;
  readonly clock: TestClock;
  readonly alerts: RecordingAlerts;
  readonly latch: EntryLatch;
  readonly anchors: MemoryAnchors;
  readonly marks: Map<string, Mark>;
  readonly guard: { trusted: boolean };
  readonly fatal: string[];
  readonly deps: DayDeps;
}

/** `startedAt` is the watch's start (its jump-base alerts wait an hour from it). */
export function dayWorld(db: Db = setUpDb(), start = T, startedAt = start): DayWorld {
  const clock = testClock(start);
  const alerts = recordingAlerts();
  const latch = createEntryLatch();
  const anchors = memoryAnchors();
  const marks = new Map<string, Mark>();
  const guard = { trusted: true };
  const fatal: string[] = [];
  const late: { store: StoreDeps | null } = { store: null };
  const faults = createFaultSink({
    latch,
    alerts,
    clock,
    onFatal: (code) => void fatal.push(code),
    onDiskTrouble: () => {
      if (late.store !== null) {
        persistHaltTx(late.store, 'disk-db');
      }
    },
  });
  const time: TimeGuard = { trusted: () => guard.trusted };
  const watch = createDayWatch({ alerts, latch, startedAt });
  const deps: DayDeps = Object.freeze({ db, clock, slots: { currentSlot: () => null }, latch, faults, alerts, anchors, marks: { marks: () => marks }, time, watch });
  late.store = deps;
  return { db, clock, alerts, latch, anchors, marks, guard, fatal, deps };
}

/** A mark of the whole holding (400,000 tokens) at `value`, received at `at` (the clock's now by default). */
export function mark(w: DayWorld, id: string, value: bigint, at = w.clock.now()): void {
  w.marks.set(id, Object.freeze({ value: lamports(value), tokenUnits: tokenUnits(400_000n), at }));
}

/** An open paper position of 400,000 tokens, marked at `value` now. */
export function holding(w: DayWorld, id: string, value: bigint): void {
  openPosition(w.db, id, `Mint${id}`);
  mark(w, id, value);
}

/** The paper account's SOL set by hand (the deposit stays 0.55 SOL): the books do not conserve, which no day transaction checks. */
export function setPaperSol(w: DayWorld, sol: bigint): void {
  w.db.transaction((tx) => tx.run("UPDATE ledger_accounts SET sol = ? WHERE mode = 'paper'", sol.toString()));
}

/** A day state written by hand, past repo-day.ts's guard: a stand-in for an edited or damaged row. */
export function plantDayState(db: Db, s: EquityState, at = T): void {
  const b = (v: boolean): bigint => (v ? 1n : 0n);
  db.transaction((tx) =>
    tx.run(
      "UPDATE day_state SET day = ?, day_start = ?, last_equity = ?, peak = ?, jump_pending = ?, jump_held_equity = ?, jump_held_at = ?, jump_ack_equity = ?, jump_ack_at = ?, daily_stop_day = ?, daily_stop_streak = ?, streak_halt = ?, updated_at = ? WHERE mode = 'paper'",
      s.day,
      s.dayStart.toString(),
      s.lastEquity.toString(),
      s.peak === null ? null : s.peak.toString(),
      b(s.jumpPending),
      s.jumpHeld === null ? null : s.jumpHeld.equity.toString(),
      s.jumpHeld === null ? null : BigInt(s.jumpHeld.at),
      s.jumpAck === null ? null : s.jumpAck.equity.toString(),
      s.jumpAck === null ? null : BigInt(s.jumpAck.at),
      s.dailyStopDay,
      BigInt(s.dailyStopStreak),
      b(s.streakHalt),
      BigInt(at),
    ),
  );
}
