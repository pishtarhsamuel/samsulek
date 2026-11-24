// The engine's config step and the shared config reads (STORAGE_DESIGN.md s.17.4 and s.17.5.3;
// C27, C60; RISK_POLICY.md s.12). readConfigState reads the stored versions, the waiting loosenings
// and the live strategies, and converts them for the pure planners of config/changes.ts: each
// version through decodeTunables, each waiting amount to its tunable's kind (a lamport amount stays a
// bigint; any other becomes a number only up to 2^53 - 1). A row it cannot convert throws ConfigError
// (classified error:config: entries latch as a bug), never a guess. commandTime dates an owner
// command no earlier than anything stored, so a clock fault cannot refuse a tightening (6e-4 uses it).
// applyDueTx is the engine's own step, in one locked transaction on one clock reading: on a reading
// the TimeGuard trusts, and only while no stored row is dated after it, each due loosening is applied
// exactly as the owner queued it (one chained version per row, by applyDueStep, which re-checks it),
// a due row that went stale or out of bounds is dropped (dropDuePending), and the live strategies the
// applied values touch are demoted, their gates restarted. Nothing here writes an owner row: the
// owner's commands are app/owner-tx.ts (restricted). In paper no strategy is live and nothing is
// armed (LIVE_ARMED_IN_PAPER), so no row ever waits and this step always answers nothing-due.
import { applyDuePending, nextVersion, type ConfigVersion, type PendingChange } from '../config/changes.ts';
import { ConfigError, boundsOf, decodeTunables, isTunablePath, type TunablePath, type TunableValue } from '../config/tunables.ts';
import { STRATEGY_IDS, type StrategyId } from '../core/ids.ts';
import { applyDueStep, dropDuePending, readConfigHistory, readPendingChanges, type StoredPending, type StoredVersion } from '../storage/repo-config.ts';
import { demote, readModes, restartGate } from '../storage/repo-flags.ts';
import type { Reader } from '../storage/sqlite.ts';
import { alertSafely, anchorAfter, type StoreDeps } from './approve-tx.ts';
import type { TimeGuard } from './day-tx.ts';
import { classify, type FaultScope } from './faults.ts';

/** C60: in paper nothing is armed for live. Phase 8 replaces this with the server's arm flag (never Telegram). */
export const LIVE_ARMED_IN_PAPER = false;

export interface ConfigState {
  /** Every stored version, decoded, oldest first. */
  readonly history: readonly ConfigVersion[];
  /** The newest version. */
  readonly active: ConfigVersion;
  /** The waiting loosenings, each amount in its tunable's kind. */
  readonly pending: readonly PendingChange[];
  /** The strategies in live mode, from the modes table. */
  readonly liveStrategies: readonly StrategyId[];
}

const LARGEST_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function versionOf(s: StoredVersion): ConfigVersion {
  const changed = s.changed.filter(isTunablePath);
  if (changed.length !== s.changed.length) {
    throw new ConfigError('a stored version lists a changed name that is no tunable');
  }
  return Object.freeze({ id: s.id, createdAt: s.createdAt, author: s.author, values: decodeTunables(s.valuesJson), changed: Object.freeze(changed), undoTo: s.undoTo });
}

/** A stored amount (a u64) in its tunable's kind. */
function amountOf(path: TunablePath, stored: bigint): TunableValue {
  if (typeof boundsOf(path)[0] === 'bigint') {
    return stored;
  }
  if (stored > LARGEST_SAFE) {
    throw new ConfigError('a stored amount of a whole-number tunable is past the largest safe number');
  }
  return Number(stored);
}

function pendingOf(s: StoredPending): PendingChange {
  const { path } = s;
  if (!isTunablePath(path)) {
    throw new ConfigError('a stored waiting change names no tunable');
  }
  return Object.freeze({ path, from: amountOf(path, s.from), to: amountOf(path, s.to), source: s.source, requestedAt: s.requestedAt, applyAt: s.applyAt });
}

/** Reads and converts; a malformed row throws ConfigError (latch, bug). No try: it runs inside transactions (C32). */
export function readConfigState(r: Reader): ConfigState {
  const history = Object.freeze(readConfigHistory(r).map(versionOf));
  const modes = readModes(r);
  return Object.freeze({
    history,
    // never empty (readConfigHistory throws without version 1), so reduce gives the newest
    active: history.reduce((_older, v) => v),
    pending: Object.freeze(readPendingChanges(r).map(pendingOf)),
    liveStrategies: Object.freeze(STRATEGY_IDS.filter((id) => modes[id].mode === 'live')),
  });
}

/** An owner command's time: the latest of now, the active version's time and every waiting row's request time (C27, R5). */
export function commandTime(now: number, s: ConfigState): number {
  return s.pending.reduce((t, row) => Math.max(t, row.requestedAt), Math.max(now, s.active.createdAt));
}

export type DueDeps = StoreDeps & { readonly time: TimeGuard };

export type DueOutcome =
  | {
      readonly kind: 'applied';
      /** One new version per applied row, in order. */
      readonly versionIds: readonly number[];
      /** The tunables those versions moved, in the same order. */
      readonly applied: readonly TunablePath[];
      readonly dropped: readonly TunablePath[];
      readonly demoted: readonly StrategyId[];
      readonly restarted: readonly StrategyId[];
    }
  | { readonly kind: 'nothing-due' }
  | { readonly kind: 'not-run'; readonly code: 'clock-untrusted' | 'clock-behind-pending' }
  | { readonly kind: 'error'; readonly code: string; readonly scope: FaultScope };

const NOTHING_DUE: DueOutcome = Object.freeze({ kind: 'nothing-due' });
const UNTRUSTED: DueOutcome = Object.freeze({ kind: 'not-run', code: 'clock-untrusted' });
const BEHIND: DueOutcome = Object.freeze({ kind: 'not-run', code: 'clock-behind-pending' });

/**
 * The due loosenings, applied or dropped, in one locked step (s.17.5.3). Never throws. An untrusted
 * clock reading applies nothing (its alert is the day watch's, which judges the same guard every
 * tick); a stored row asked for after now means the clock stepped back: nothing applies, the owner is
 * warned, and nothing latches (a clock fault is no bug; without this check the planner would throw).
 */
export function applyDueTx(deps: DueDeps): DueOutcome {
  let outcome: DueOutcome;
  try {
    outcome = deps.db.transaction((tx) => {
      const now = deps.clock.now();
      if (!deps.time.trusted(now)) {
        return UNTRUSTED;
      }
      const s = readConfigState(tx);
      if (s.pending.length === 0) {
        return NOTHING_DUE;
      }
      if (s.pending.some((row) => row.requestedAt > now)) {
        return BEHIND;
      }
      const due = applyDuePending(s.active.values, s.pending, { now, liveArmed: LIVE_ARMED_IN_PAPER, liveStrategies: s.liveStrategies });
      if (due.steps.length === 0 && due.stale.length === 0) {
        return NOTHING_DUE;
      }
      // phase R ends with every version made: each one after the one before, never dated before it
      const versions: ConfigVersion[] = [];
      let active = s.active;
      for (const step of due.steps) {
        active = nextVersion(active, step.values, step.change.source, Math.max(now, active.createdAt));
        versions.push(active);
      }
      // phase W: storage re-checks each step against the stored row and the stored active version
      const versionIds = versions.map((v) => applyDueStep(tx, now, v));
      for (const row of due.stale) {
        dropDuePending(tx, now, row.path);
      }
      for (const strategy of due.demote) {
        demote(tx, strategy, now);
      }
      for (const strategy of due.restartGate) {
        restartGate(tx, strategy, now);
      }
      return Object.freeze({
        kind: 'applied',
        versionIds: Object.freeze(versionIds),
        applied: Object.freeze(due.steps.map((step) => step.change.path)),
        dropped: Object.freeze(due.stale.map((row) => row.path)),
        demoted: due.demote,
        restarted: due.restartGate,
      });
    });
  } catch (e) {
    const f = classify(e);
    deps.faults.report('config-due', f);
    return Object.freeze({ kind: 'error', code: f.code, scope: f.scope });
  }
  if (outcome.kind === 'applied') {
    anchorAfter(deps); // every applied outcome wrote an engine audit row
    if (outcome.applied.length > 0) {
      alertSafely(deps.alerts, deps.latch, { code: 'loosening-applied', severity: 'info', codes: outcome.applied });
    }
    if (outcome.dropped.length > 0) {
      alertSafely(deps.alerts, deps.latch, { code: 'loosening-dropped', severity: 'info', codes: outcome.dropped });
    }
    if (outcome.demoted.length > 0) {
      alertSafely(deps.alerts, deps.latch, { code: 'strategy-demoted', severity: 'warn', codes: outcome.demoted });
    }
  } else if (outcome === BEHIND) {
    alertSafely(deps.alerts, deps.latch, { code: 'config-clock-behind', severity: 'warn' });
  }
  return outcome;
}
