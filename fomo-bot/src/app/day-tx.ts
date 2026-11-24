// The equity observation (STORAGE_DESIGN.md s.17.5.1; conditions C20, C28, C33, C38, C39, C40, C42,
// C49): what the bot learns about its paper money on each tick, in one locked step. The marks are read
// once before BEGIN; inside, the clock is read once and every time in the step is that reading. Phase R
// reads the stored day state, both accounts, the active positions and the active config, values the
// book exactly as T1 does, takes the jump test's base from the stored snapshots at or before now, and
// runs risk/daystate.ts. Phase W writes the day state (one write per step), one snapshot and the prune
// (none after a clock that went back across midnight; an anomaly is stored as unknown), each new halt
// (its own engine:halt-set row first, C28) and the low-equity stop. Any throw rolls the whole step back;
// then, unless the database was only busy, the day-state-error halt is written in its own step and the
// owner is alerted (C40): never a retry with an edited state, the next tick observes the stored state
// again. Paper only: a live position refuses (the live day state is a Phase 8 step). Selling never
// reads any of this.
import { valueEquity } from '../portfolio/equity.ts';
import { observeEquity, type EquityTrip } from '../risk/daystate.ts';
import { readAccount, readActivePositions } from '../storage/repo-book.ts';
import { readDayState, snapshotNear } from '../storage/repo-day.ts';
import { insertSnapshot, pruneSnapshots, writeDayState } from '../storage/repo-observe.ts';
import { setEntriesStopped, setHalt } from '../storage/repo-flags.ts';
import { alertSafely, anchorAfter, persistHaltTx, type EngineDeps, type StoreDeps } from './approve-tx.ts';
import { MARK_POLICY, dayPolicyOf, lowEquityStopOf } from './caps.ts';
import { AppError, classify, type AlertSink, type EntryLatch, type FaultScope } from './faults.ts';
import { ledgerOf, readActiveConfig } from './snapshot.ts';

/** Contract 8's verdict on one clock reading. The guarded clock (core/clock.ts) is a later step; tests use fakes. */
export interface TimeGuard {
  trusted(now: number): boolean;
}

/** In memory, one per engine: rate-limited alerts about the observations. Never throws. */
export interface DayWatch {
  note(o: ObserveOutcome, now: number): void;
}

/** The small-write deps of 6d plus the marks, the clock guard and the watch. */
export type DayDeps = StoreDeps &
  Pick<EngineDeps, 'marks'> & {
    readonly time: TimeGuard;
    readonly watch: DayWatch;
  };

/** The trips that become a halt row `<trip>:paper` (contract 2); the daily stop and the jump hold live in day_state. */
export const DAY_HALT_TRIPS: readonly EquityTrip[] = Object.freeze(['equity-zero', 'sanity-max', 'sanity-bankroll', 'clock-backwards', 'peak-halt', 'daily-stop-twice'] as const);
/** The halt of a day transaction that failed (C40); only the server lifts it. */
export const DAY_STATE_ERROR_HALT = 'day-state-error:paper';
/** The jump test's base should be about an hour old; further than this from the target alerts (C42). */
export const JUMP_BASE_TOLERANCE_MS = 600_000;
/** Each rate-limited day-watch alert at most once in this time. */
export const DAY_ALERT_EVERY_MS = 600_000;

const HOUR_MS = 3_600_000;
/** Unknown equity this long is worth an alert (stale marks, a chain client down). */
const EQUITY_UNKNOWN_ALERT_MS = 300_000;
const HALTING: ReadonlySet<EquityTrip> = new Set(DAY_HALT_TRIPS);
/** Readings that cannot be the account's value: stored as unknown, never the base of a jump test. */
const ANOMALIES: ReadonlySet<EquityTrip> = new Set<EquityTrip>(['equity-zero', 'sanity-max', 'sanity-bankroll']);

export interface JumpBase {
  readonly state: 'ok' | 'missing' | 'far';
  /** The base row's own time. */
  readonly at: number | null;
}

export type ObserveOutcome =
  | {
      readonly kind: 'observed';
      readonly at: number;
      readonly trips: readonly EquityTrip[];
      /** The halts this step set (one already set is not repeated). */
      readonly haltsSet: readonly string[];
      /** The low-equity stop as written; null when left as stored (unknown equity, an anomaly or a held jump). */
      readonly entriesStopped: boolean | null;
      /** The stop changed in this step. */
      readonly stopChanged: boolean;
      readonly base: JumpBase;
      readonly equityKnown: boolean;
    }
  | { readonly kind: 'not-run'; readonly code: 'clock-untrusted' }
  | { readonly kind: 'error'; readonly code: string; readonly scope: FaultScope; readonly halt: 'set' | 'already' | 'failed' | 'not-tried' };

const NOT_RUN: ObserveOutcome = Object.freeze({ kind: 'not-run', code: 'clock-untrusted' });
const MISSING: JumpBase = Object.freeze({ state: 'missing', at: null });

/** One equity observation of the paper account, in one transaction. Never throws. */
export function observeDayTx(deps: DayDeps): ObserveOutcome {
  const seen: { now: number | null } = { now: null };
  let outcome: ObserveOutcome;
  try {
    const marks = deps.marks.marks(); // read once, before BEGIN: now is read after the marks (contract 6)
    outcome = deps.db.transaction((tx) => {
      const at = deps.clock.now();
      seen.now = at;
      if (!deps.time.trusted(at)) {
        return NOT_RUN; // nothing written: the transaction commits nothing
      }
      // phase R: the reads and the pure step
      const state = readDayState(tx, 'paper');
      const paper = readAccount(tx, 'paper');
      readAccount(tx, 'live'); // required too: the owner's setup writes both
      const active = readActivePositions(tx);
      if (active.some((p) => p.mode !== 'paper')) {
        throw new AppError('live-not-built', 'a live position: the live day state is observed only from Phase 8');
      }
      const { tunables } = readActiveConfig(tx);
      const policy = dayPolicyOf('paper', tunables, paper); // C49: the bankroll is the stored deposit
      const { equity, stopEquity } = valueEquity(ledgerOf({ account: paper, positions: active }), marks, at, MARK_POLICY);
      const target = at - HOUR_MS;
      const near = snapshotNear(tx, 'paper', target, at); // C42: rows at or before now only
      const base: JumpBase = near === null ? MISSING : Object.freeze({ state: Math.abs(near.at - target) > JUMP_BASE_TOLERANCE_MS ? 'far' : 'ok', at: near.at });
      const r = observeEquity(state, { now: at, equity, stopEquity, equityAnHourAgo: near === null ? null : near.equity }, policy);
      const trips: readonly EquityTrip[] = Object.freeze([...r.trips]);
      const halts = [...new Set(trips.filter((t) => HALTING.has(t)))].map((t) => `${t}:paper`).sort();
      const backwards = trips.includes('clock-backwards');
      const anomaly = backwards || trips.some((t) => ANOMALIES.has(t));
      const low = equity !== null && !anomaly && !r.state.jumpPending ? lowEquityStopOf(r.state.dayStart, equity, tunables) : null;
      // phase W, in this order
      writeDayState(tx, 'paper', r.state, at); // the one day-state write of this step (C38)
      if (!backwards) {
        insertSnapshot(tx, 'paper', at, anomaly ? null : equity, anomaly ? null : stopEquity);
        pruneSnapshots(tx, at); // keeps a day (C20)
      }
      const haltsSet: string[] = [];
      for (const reason of halts) {
        if (setHalt(tx, reason, at)) {
          haltsSet.push(reason); // its engine:halt-set row first, forced by the schema (C28)
        }
      }
      const stopChanged = low !== null && setEntriesStopped(tx, low, at);
      return Object.freeze({ kind: 'observed', at, trips, haltsSet: Object.freeze(haltsSet), entriesStopped: low, stopChanged, base, equityKnown: equity !== null });
    });
  } catch (e) {
    const f = classify(e);
    deps.faults.report('day', f);
    // busy: the next tick observes again (the busy storm counts it); anything else halts (C40)
    outcome = Object.freeze({ kind: 'error', code: f.code, scope: f.scope, halt: f.busy ? 'not-tried' : persistHaltTx(deps, DAY_STATE_ERROR_HALT) });
  }
  if (outcome.kind === 'observed' && outcome.haltsSet.length > 0) {
    anchorAfter(deps);
  }
  deps.watch.note(outcome, seen.now ?? deps.clock.now());
  return outcome;
}

/** The day watch: codes only, each rate-limited code at most once per DAY_ALERT_EVERY_MS (again after the clock steps back). */
export function createDayWatch(o: { readonly alerts: AlertSink; readonly latch: EntryLatch; readonly startedAt: number }): DayWatch {
  const { alerts, latch, startedAt } = o;
  const last = new Map<string, number>();
  let jumpHeld = false;
  let unknownSince: number | null = null;
  const say = (code: string, severity: 'warn' | 'bug', codes?: readonly string[]): void =>
    alertSafely(alerts, latch, codes === undefined ? { code, severity } : { code, severity, codes: Object.freeze([...codes]) });
  const limited = (code: string, now: number, severity: 'warn' | 'bug', codes?: readonly string[]): void => {
    const prev = last.get(code);
    if (prev !== undefined && now >= prev && now - prev < DAY_ALERT_EVERY_MS) {
      return;
    }
    last.set(code, now);
    say(code, severity, codes);
  };
  return Object.freeze({
    note(outcome: ObserveOutcome, now: number): void {
      if (outcome.kind === 'not-run') {
        limited('day-clock-untrusted', now, 'warn');
        return;
      }
      if (outcome.kind === 'error') {
        if (outcome.halt !== 'not-tried') {
          limited('day-state-error', now, 'bug', [outcome.code]); // busy is the busy storm's to count
        }
        return;
      }
      if (outcome.haltsSet.length > 0) {
        say('day-halt-set', 'warn', outcome.haltsSet);
      }
      const holding = outcome.trips.includes('equity-jump');
      if (holding && !jumpHeld) {
        say('equity-jump-held', 'warn'); // the hold's first tick: the trip repeats while it lasts
      }
      jumpHeld = holding;
      if (outcome.stopChanged && outcome.entriesStopped === true) {
        say('equity-below-minimum', 'warn'); // "tell the owner once" per turn-on
      }
      if (outcome.equityKnown) {
        unknownSince = null;
      } else {
        unknownSince ??= now;
        if (now - unknownSince > EQUITY_UNKNOWN_ALERT_MS) {
          limited('equity-unknown', now, 'warn');
        }
      }
      if (outcome.base.state !== 'ok' && now - startedAt >= HOUR_MS) {
        limited(`jump-base-${outcome.base.state}`, now, 'warn'); // contract 6: no hour of history before the first hour
      }
    },
  });
}
