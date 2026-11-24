// The owner's commands as transactions (STORAGE_DESIGN.md s.17.5.4 and s.17.5.5; RISK_POLICY.md s.12;
// decision D4). /set, /rollback and /cancel: in one locked step the clock is read once, the stored
// config is read and converted (app/config-tx.ts), the command is dated commandTime (never before
// anything stored, so a clock fault cannot refuse a tightening, C27), the pure planner of
// config/changes.ts plans it, and the owner's writer stores the plan (the owner's row first, then the
// cancelled rows, the version, the new waiting rows), then the live strategies it touches are demoted
// and the go-live counts restarted. A refusal writes nothing. /resume lifts the paper peak or streak
// halt (the live ones only at the server, Phase 8): the peak only right after a money check that valued
// everything (contract 4), every expected refusal checked first, so it is a refusal and never a bug.
// These commands take no latch: a tightening or a /resume must work while entries are latched. Only
// app/owner.ts (Phase 3, after the Telegram owner check) and cli/ (Phase 7, at the server) may import
// this file (the architecture rule): the engine can never write an owner's row.
import {
  nextVersion,
  planCancel,
  planRollback,
  planSet,
  type ChangeContext,
  type ChangePlan,
  type ConfigVersion,
  type FieldChange,
  type PendingChange,
  type Refusal,
  type RefusalReason,
} from '../config/changes.ts';
import type { TunablePath } from '../config/tunables.ts';
import type { StrategyId } from '../core/ids.ts';
import { newestSnapshot, readDayState } from '../storage/repo-day.ts';
import { demote, readHalts, restartGate } from '../storage/repo-flags.ts';
import { OWNER_ACTORS, resumeHalt, writeOwnerConfig, type OwnerActor, type OwnerConfigAction } from '../storage/repo-owner.ts';
import { alertSafely, anchorAfter, type EngineDeps } from './approve-tx.ts';
import { LIVE_ARMED_IN_PAPER, commandTime, readConfigState, type ConfigState } from './config-tx.ts';
import { AppError, classify, type FaultScope } from './faults.ts';

export type OwnerDeps = Pick<EngineDeps, 'db' | 'clock' | 'latch' | 'faults' | 'alerts' | 'anchors'>;

export type OwnerConfigOutcome =
  | {
      readonly kind: 'done';
      /** The command's time (commandTime): every row it wrote carries it. */
      readonly at: number;
      /** The clock read earlier than something stored, so the command ran at that later time. */
      readonly clockBehind: boolean;
      /** The version that applies now; null when nothing applies now. */
      readonly versionId: number | null;
      readonly applied: readonly FieldChange[];
      /** New waiting loosenings: Phase 3 tells the owner at once, who can /cancel them. */
      readonly pending: readonly PendingChange[];
      readonly cancelled: readonly TunablePath[];
      /** Paper-model values left as they are (never made less pessimistic). */
      readonly kept: readonly TunablePath[];
      readonly demoted: readonly StrategyId[];
      readonly restarted: readonly StrategyId[];
    }
  | { readonly kind: 'refused'; readonly reason: RefusalReason }
  | { readonly kind: 'error'; readonly code: string; readonly scope: FaultScope };

/** Contract 4: the peak restarts only right after a money check that valued everything. */
export const RESUME_FRESH_MS = 60_000;

export type ResumeOutcome =
  | { readonly kind: 'resumed'; readonly which: 'peak' | 'streak'; readonly at: number }
  | { readonly kind: 'refused'; readonly reason: 'not-halted' | 'jump-held' | 'equity-unknown' | 'observe-first' }
  | { readonly kind: 'error'; readonly code: string; readonly scope: FaultScope };

/** What a command writes, from its planner. */
interface Planned {
  readonly ok: true;
  readonly version: ConfigVersion | null;
  readonly applied: readonly FieldChange[];
  readonly pending: readonly PendingChange[];
  readonly cancelled: readonly PendingChange[];
  readonly kept: readonly TunablePath[];
  readonly demote: readonly StrategyId[];
  readonly restartGate: readonly StrategyId[];
}

const NONE: readonly never[] = Object.freeze([]);

/** A programming error of the caller (only the owner's paths call these): thrown before anything is read. */
function ownerActor(actor: unknown): OwnerActor {
  if (!(OWNER_ACTORS as readonly unknown[]).includes(actor)) {
    throw new TypeError('an owner command comes from the owner (owner-telegram or owner-server)');
  }
  return actor as OwnerActor;
}

function errorOf(deps: OwnerDeps, e: unknown): { readonly kind: 'error'; readonly code: string; readonly scope: FaultScope } {
  const f = classify(e);
  deps.faults.report('owner', f);
  return Object.freeze({ kind: 'error', code: f.code, scope: f.scope });
}

/** A config command as the owner gave it: the planner parses its raw parts. */
type Command =
  | { readonly kind: 'set'; readonly path: unknown; readonly value: unknown }
  | { readonly kind: 'rollback' }
  | { readonly kind: 'cancel'; readonly path: unknown };

const ACTION_OF: Readonly<Record<Command['kind'], OwnerConfigAction>> = Object.freeze({ set: 'owner:set', rollback: 'owner:rollback', cancel: 'owner:cancel-pending' });
const ROLLBACK: Command = Object.freeze({ kind: 'rollback' });

/**
 * The command planned on the stored config at the command's time, by the pure planners; a version only
 * when something applies now (/set by the owner; /rollback by rollback, undoing to its target's
 * undoTo, as planRollback's contract says). A named function, not a closure handed in, so the no-catch
 * rule follows it: it runs inside the transaction (C32). No try.
 */
function planOf(c: Command, s: ConfigState, ctx: ChangeContext): Planned | Refusal {
  const planned = (p: ChangePlan, version: ConfigVersion | null): Planned =>
    Object.freeze({ ok: true, version, applied: p.applied, pending: p.pending, cancelled: p.cancelled, kept: p.kept, demote: p.demote, restartGate: p.restartGate });
  if (c.kind === 'set') {
    const p = planSet(s.active.values, c.path, c.value, ctx, s.pending);
    if (!p.ok) {
      return p;
    }
    return planned(p, p.applied.length > 0 ? nextVersion(s.active, p.values, 'owner', ctx.now) : null);
  }
  if (c.kind === 'rollback') {
    const p = planRollback(s.history, s.active.id, ctx, s.pending);
    if (!p.ok) {
      return p;
    }
    return planned(p, p.applied.length > 0 ? nextVersion(s.active, p.values, 'rollback', ctx.now, p.undoTo) : null);
  }
  const p = planCancel(s.pending, c.path, ctx);
  if (!p.ok) {
    return p;
  }
  return Object.freeze({ ok: true, version: null, applied: NONE, pending: NONE, cancelled: Object.freeze([p.cancelled]), kept: NONE, demote: NONE, restartGate: NONE });
}

/** One config command in one locked step (s.17.5.4). Never throws, except the actor's TypeError. */
function configCommand(deps: OwnerDeps, actorRaw: unknown, command: Command): OwnerConfigOutcome {
  const actor = ownerActor(actorRaw);
  let outcome: OwnerConfigOutcome;
  try {
    outcome = deps.db.transaction((tx) => {
      const now = deps.clock.now();
      const s = readConfigState(tx);
      const t = commandTime(now, s);
      const p = planOf(command, s, { now: t, liveArmed: LIVE_ARMED_IN_PAPER, liveStrategies: s.liveStrategies });
      if (!p.ok) {
        return Object.freeze({ kind: 'refused', reason: p.reason });
      }
      // phase W: the owner's row first (writeOwnerConfig), then what the applied values touch
      const cancelled = Object.freeze(p.cancelled.map((row) => row.path));
      const versionId = writeOwnerConfig(tx, t, actor, ACTION_OF[command.kind], { version: p.version, pending: p.pending, cancelled });
      for (const strategy of p.demote) {
        demote(tx, strategy, t);
      }
      for (const strategy of p.restartGate) {
        restartGate(tx, strategy, t);
      }
      return Object.freeze({ kind: 'done', at: t, clockBehind: t > now, versionId, applied: p.applied, pending: p.pending, cancelled, kept: p.kept, demoted: p.demote, restarted: p.restartGate });
    });
  } catch (e) {
    return errorOf(deps, e);
  }
  if (outcome.kind === 'done') {
    anchorAfter(deps);
    if (outcome.clockBehind) {
      alertSafely(deps.alerts, deps.latch, { code: 'config-clock-behind', severity: 'warn' });
    }
  }
  return outcome;
}

/** /set <tunable> <value>, as the owner typed it: the planner parses both (s.12). */
export function setTx(deps: OwnerDeps, actor: OwnerActor, path: unknown, value: unknown): OwnerConfigOutcome {
  return configCommand(deps, actor, Object.freeze({ kind: 'set', path, value }));
}

/** /rollback: back to the version the active one undoes to; a second /rollback goes one further back. */
export function rollbackTx(deps: OwnerDeps, actor: OwnerActor): OwnerConfigOutcome {
  return configCommand(deps, actor, ROLLBACK);
}

/** /cancel <tunable>: its waiting loosening is removed, which leaves the config as strict as it is. */
export function cancelPendingTx(deps: OwnerDeps, actor: OwnerActor, path: unknown): OwnerConfigOutcome {
  return configCommand(deps, actor, Object.freeze({ kind: 'cancel', path }));
}

const REFUSED = Object.freeze({
  'not-halted': Object.freeze({ kind: 'refused', reason: 'not-halted' } as const),
  'jump-held': Object.freeze({ kind: 'refused', reason: 'jump-held' } as const),
  'equity-unknown': Object.freeze({ kind: 'refused', reason: 'equity-unknown' } as const),
  'observe-first': Object.freeze({ kind: 'refused', reason: 'observe-first' } as const),
});

/**
 * /resume after the paper peak halt ('peak') or the paper streak halt ('streak'), at once (D4). The
 * conditions checkPeakRestart refuses on are checked first, with the freshness of contract 4: a
 * refusal writes nothing and is never classified. Never throws, except the TypeErrors of a wrong actor
 * or kind.
 */
export function resumeTx(deps: OwnerDeps, actorRaw: OwnerActor, whichRaw: 'peak' | 'streak'): ResumeOutcome {
  const actor = ownerActor(actorRaw);
  if (whichRaw !== 'peak' && whichRaw !== 'streak') {
    throw new TypeError('a resume lifts the peak halt or the streak halt');
  }
  const which = whichRaw;
  let outcome: ResumeOutcome;
  try {
    outcome = deps.db.transaction((tx) => {
      const now = deps.clock.now();
      const reason = which === 'peak' ? 'peak-halt:paper' : 'daily-stop-twice:paper';
      if (!readHalts(tx).some((h) => h.reason === reason)) {
        return REFUSED['not-halted'];
      }
      if (which === 'peak') {
        const state = readDayState(tx, 'paper');
        if (state.jumpPending) {
          return REFUSED['jump-held'];
        }
        if (state.lastEquity < 1n) {
          return REFUSED['equity-unknown'];
        }
        const newest = newestSnapshot(tx, 'paper', now);
        if (newest === null || newest.equity === null || now - newest.at > RESUME_FRESH_MS) {
          return REFUSED['observe-first'];
        }
      }
      if (!resumeHalt(tx, now, actor, which)) {
        // the halt was read above, in this same step: storage disagreeing with itself is a bug
        throw new AppError('bad-request', 'the halt read in this step was not there to lift');
      }
      return Object.freeze({ kind: 'resumed', which, at: now });
    });
  } catch (e) {
    return errorOf(deps, e);
  }
  if (outcome.kind === 'resumed') {
    anchorAfter(deps);
  }
  return outcome;
}
