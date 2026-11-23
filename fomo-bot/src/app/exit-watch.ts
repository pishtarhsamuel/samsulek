// The exit path's own alerts (review T, risk 4, 5 and 8; STORAGE_DESIGN.md s.16.14). A refused exit
// is not a fault, so the fault sink never sees it; this watch makes sure the owner hears of every exit
// that does not go through: a refusal warns with the position and its codes (at most once a minute per
// position and codes), a refusal for the fee budget, or because automatic exits stopped, says so, and
// five exits in a row that did not approve for one position (refused, failed or not run) raise
// exit-blocked, at most once in ten minutes per position. An approved exit ends the run. Faults
// (errors, an unknown slot) are alerted by the fault sink and count here too. In memory, per process;
// it never throws: an alert sink that throws latches entries as a bug, as the fault sink does.
import type { Alert, AlertSink, EntryLatch } from './faults.ts';
import type { Clock } from './slots.ts';

export const EXIT_WATCH_RULES = Object.freeze({
  /** Exits in a row for one position that did not approve before exit-blocked. */
  blockedAfter: 5,
  refusedEveryMs: 60_000,
  blockedEveryMs: 600_000,
});

export interface ExitWatch {
  /** A T1 exit approved: the position's run of exits that did not approve ends. */
  approved(positionId: string): void;
  /** risk refused the exit, with its problems (stored as plan:<problem>). */
  refused(positionId: string, problems: readonly string[]): void;
  /** The exit failed or did not run (the fault sink has alerted the fault). */
  failed(positionId: string): void;
}

export interface ExitWatchOptions {
  readonly alerts: AlertSink;
  readonly clock: Clock;
  readonly latch: EntryLatch;
}

const FEE_BUDGET_PROBLEMS: ReadonlySet<string> = new Set(['exit-fee-budget', 'auto-exits-stopped']);
const isFn = (v: unknown): boolean => typeof v === 'function';
const objectWith = (v: unknown, ...members: string[]): boolean => typeof v === 'object' && v !== null && members.every((m) => isFn((v as Record<string, unknown>)[m]));

export function createExitWatch(o: ExitWatchOptions): ExitWatch {
  const { alerts, clock, latch } = o;
  if (!objectWith(alerts, 'alert') || !objectWith(clock, 'now') || !objectWith(latch, 'set')) {
    throw new TypeError('the exit watch needs the alert sink, the clock and the entry latch');
  }
  const runs = new Map<string, number>();
  const lastSent = new Map<string, number>();
  /** Sends the alert unless the same key was sent less than `everyMs` ago (a clock that stepped back sends). */
  const send = (key: string, everyMs: number, a: Alert): void => {
    try {
      const now = clock.now();
      const last = lastSent.get(key);
      if (last !== undefined && now >= last && now - last < everyMs) {
        return;
      }
      lastSent.set(key, now);
      alerts.alert(Object.freeze(a));
    } catch {
      latch.set('bug');
    }
  };
  const count = (positionId: string): void => {
    const n = (runs.get(positionId) ?? 0) + 1;
    runs.set(positionId, n);
    if (n >= EXIT_WATCH_RULES.blockedAfter) {
      send(`blocked|${positionId}`, EXIT_WATCH_RULES.blockedEveryMs, { code: 'exit-blocked', severity: 'warn', codes: Object.freeze([positionId]) });
    }
  };
  return Object.freeze({
    approved(positionId: string): void {
      runs.delete(positionId);
    },
    refused(positionId: string, problems: readonly string[]): void {
      const codes = Object.freeze(problems.map((p) => `plan:${p}`));
      send(`refused|${positionId}|${codes.join(',')}`, EXIT_WATCH_RULES.refusedEveryMs, { code: 'exit-refused', severity: 'warn', codes: Object.freeze([positionId, ...codes]) });
      if (problems.some((p) => FEE_BUDGET_PROBLEMS.has(p))) {
        send(`fee-budget|${positionId}`, EXIT_WATCH_RULES.refusedEveryMs, { code: 'exit-fee-budget', severity: 'warn', codes: Object.freeze([positionId]) });
      }
      count(positionId);
    },
    failed(positionId: string): void {
      count(positionId);
    },
  });
}
