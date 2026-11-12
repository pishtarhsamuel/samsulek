// Changing the tunables (RISK_POLICY.md s.12; ARCHITECTURE.md s.7 and s.8): /set, AI proposals and
// their approval, /rollback and the pending live loosenings, as pure plans that the engine writes in
// one transaction (the new config version, the pending rows, the demotions and the gate restarts).
// - Every value stays inside its bounds; the whole set is checked before and after every plan.
// - /set moves a value either way inside its bounds, except the paper model: only more pessimistic.
//   No command can make the paper model less pessimistic: /rollback leaves such a value as it is.
// - The AI moves only its marked parameters (never the paper model), the safety ones only the safer
//   way, by at most a quarter of the current value, once in 7 days per parameter, 3 per review.
// - While live trading is possible (the bot armed for live, or any strategy live), a risk value or a
//   shared exit value (open live positions follow them) that moves any way but the safer one waits
//   24 hours: the owner is told at once and can cancel it. The rest applies at once. /rollback is
//   compared field by field the same way.
// - Changing a strategy's signal parameters restarts its go-live count (s.11) and demotes it if it is
//   live (its gate used the frozen config); the shared exit parameters do that for every strategy,
//   when they apply; the paper model restarts every count and demotes none.
// - Nothing here writes a mode: a mode lives only in the flags table (invariant 24).
// Malformed stored data (a version, a pending row, the context) throws ConfigError: the engine
// refuses the command and alerts. A refusal of a valid command is a result with a fixed reason.
import { STRATEGY_IDS, isStrategyId, type StrategyId } from '../core/ids.ts';
import { isTimestamp } from '../core/time.ts';
import {
  ConfigError,
  RULES,
  TUNABLE_PATHS,
  boundsOf,
  changeSafety,
  changedPaths,
  checkTunables,
  groupOf,
  inBounds,
  isTunablePath,
  parseTunableValue,
  plainFields,
  plainList,
  strategyOf,
  valueAt,
  withValue,
  type TunablePath,
  type TunableValue,
  type Tunables,
} from './tunables.ts';

/** A live loosening waits this long (RISK_POLICY.md s.12). */
export const LOOSENING_DELAY_MS = 24 * 3_600_000;
/** One approved AI change per parameter in this time (s.12). */
export const AI_COOLDOWN_MS = 7 * 24 * 3_600_000;
/** At most this many AI proposals per review (s.12). */
export const AI_MAX_PROPOSALS = 3;

export type ChangeSource = 'owner' | 'ai-approved' | 'rollback';
const SOURCES: readonly ChangeSource[] = ['owner', 'ai-approved', 'rollback'];

export interface ChangeContext {
  readonly now: number;
  /** The server's arm flag (never anything Telegram can change). A live strategy counts as armed too. */
  readonly liveArmed: boolean;
  /** The strategies in live mode now, from the flags table. */
  readonly liveStrategies: readonly StrategyId[];
}

export interface FieldChange {
  readonly path: TunablePath;
  readonly from: TunableValue;
  readonly to: TunableValue;
  readonly safety: 'safer' | 'riskier' | 'neutral';
}

/** A live loosening waiting for its 24 hours; at most one per tunable. */
export interface PendingChange {
  readonly path: TunablePath;
  readonly from: TunableValue;
  readonly to: TunableValue;
  readonly source: ChangeSource;
  readonly requestedAt: number;
  /** At least 24 hours after requestedAt. */
  readonly applyAt: number;
}

export interface Effects {
  /** Live strategies the engine demotes to paper now (their signal or exit values changed). */
  readonly demote: readonly StrategyId[];
  /** Strategies whose go-live count restarts. */
  readonly restartGate: readonly StrategyId[];
}

export interface ChangePlan extends Effects {
  /** The values to activate now (a new config version when `applied` is not empty). */
  readonly values: Tunables;
  readonly applied: readonly FieldChange[];
  /** New pending rows: risk and exit values that wait 24 hours. */
  readonly pending: readonly PendingChange[];
  /** Earlier pending rows this command replaces (it addressed their tunable); the owner is told. */
  readonly cancelled: readonly PendingChange[];
  /** Paper-model values the command would have made less pessimistic: left as they are, the owner is told. */
  readonly kept: readonly TunablePath[];
}

export type RefusalReason =
  | 'unknown-parameter'
  | 'not-a-number'
  | 'out-of-bounds'
  | 'paper-only-more-pessimistic'
  | 'no-change'
  | 'not-ai-tunable'
  | 'stale-current'
  | 'wrong-direction'
  | 'change-too-large'
  | 'changed-recently'
  | 'duplicate-parameter'
  | 'too-many'
  | 'malformed'
  | 'nothing-to-roll-back';

export interface Refusal {
  readonly ok: false;
  readonly reason: RefusalReason;
}

export type PlanResult = ({ readonly ok: true } & ChangePlan) | Refusal;

const refuse = (reason: RefusalReason): Refusal => Object.freeze({ ok: false, reason });

// ---------------------------------------------------------------- checks of the input itself

interface Context {
  readonly now: number;
  readonly live: boolean;
  readonly liveStrategies: ReadonlySet<StrategyId>;
}

function time(what: string, value: unknown): number {
  if (!isTimestamp(value)) {
    throw new ConfigError(`${what} must be a UTC millisecond timestamp`);
  }
  return value;
}

function checkContext(input: unknown): Context {
  const { now, liveArmed, liveStrategies } = plainFields('the context', input, ['now', 'liveArmed', 'liveStrategies']);
  if (typeof liveArmed !== 'boolean') {
    throw new ConfigError('liveArmed must be a boolean');
  }
  const strategies = plainList('liveStrategies', liveStrategies);
  if (!strategies.every(isStrategyId)) {
    throw new ConfigError('liveStrategies must be a list of strategies');
  }
  const live = new Set(strategies as readonly StrategyId[]);
  return { now: time('now', now), live: liveArmed || live.size > 0, liveStrategies: live };
}

/** The right kind of number for the tunable (its bounds are checked where a value is used). */
function kindOf(path: TunablePath, what: string, value: unknown): TunableValue {
  const lamports = typeof boundsOf(path)[0] === 'bigint';
  const ok = lamports ? typeof value === 'bigint' && value >= 0n : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (!ok) {
    throw new ConfigError(`${what} of a pending change has the wrong kind of number`);
  }
  return value as TunableValue;
}

const PENDING_FIELDS = ['path', 'from', 'to', 'source', 'requestedAt', 'applyAt'] as const;

/** Stored pending rows, checked: exact fields, at most one per tunable, asked for by now, due 24 hours later at the earliest. */
function checkPending(input: unknown, now: number): readonly PendingChange[] {
  const seen = new Set<string>();
  const out: PendingChange[] = [];
  for (const raw of plainList('the pending changes', input)) {
    const { path, from, to, source, requestedAt, applyAt } = plainFields('a pending change', raw, PENDING_FIELDS);
    if (!isTunablePath(path)) {
      throw new ConfigError('a pending change names no tunable');
    }
    if (seen.has(path)) {
      throw new ConfigError('two pending changes for one tunable');
    }
    seen.add(path);
    if (!SOURCES.includes(source as ChangeSource)) {
      throw new ConfigError('a pending change has an unknown source');
    }
    const requested = time('requestedAt', requestedAt);
    const due = time('applyAt', applyAt);
    if (requested > now) {
      throw new ConfigError('a pending change was asked for after now'); // an edited row, or a clock that stepped back
    }
    if (due - requested < LOOSENING_DELAY_MS) {
      throw new ConfigError('a pending change waits at least 24 hours'); // never skip the wait, whatever the store says
    }
    out.push(Object.freeze({ path, from: kindOf(path, 'from', from), to: kindOf(path, 'to', to), source: source as ChangeSource, requestedAt: requested, applyAt: due }));
  }
  return Object.freeze(out);
}

// ---------------------------------------------------------------- versions

/** One stored config version (ARCHITECTURE.md s.7 `config_versions`). */
export interface ConfigVersion {
  /** 1, 2, 3, ... in the order they were made. */
  readonly id: number;
  readonly createdAt: number;
  /** 'default' for the first version only. */
  readonly author: 'default' | ChangeSource;
  readonly values: Tunables;
  /** The tunables this version changed from the version before it (empty only for the first). */
  readonly changed: readonly TunablePath[];
  /** The version /rollback returns to from this one; null when there is nothing to undo. */
  readonly undoTo: number | null;
}

const VERSION_FIELDS = ['id', 'createdAt', 'author', 'values', 'changed', 'undoTo'] as const;

export function firstVersion(values: Tunables, now: number): ConfigVersion {
  return Object.freeze({ id: 1, createdAt: time('now', now), author: 'default', values: checkTunables(values), changed: Object.freeze([]), undoTo: null });
}

/**
 * The version after `active`: never empty, never earlier than it. By default /rollback from it
 * returns to `active`; a rollback's own version passes its target's undoTo, so a second /rollback
 * goes one step further back instead of undoing the first.
 */
export function nextVersion(active: ConfigVersion, values: Tunables, author: ChangeSource, now: number, undoTo: number | null = active.id): ConfigVersion {
  const [previous] = checkHistory([active]);
  const checked = checkTunables(values);
  const changed = changedPaths(previous!.values, checked);
  if (changed.length === 0) {
    throw new ConfigError('a new version must change something');
  }
  if (!SOURCES.includes(author)) {
    throw new ConfigError('a version has an unknown author');
  }
  const at = time('now', now);
  if (at < previous!.createdAt) {
    throw new ConfigError('a new version cannot be older than the active one');
  }
  if (undoTo !== null && (!Number.isSafeInteger(undoTo) || undoTo < 1 || undoTo > previous!.id)) {
    throw new ConfigError('a version can only undo to an earlier one');
  }
  return Object.freeze({ id: previous!.id + 1, createdAt: at, author, values: checked, changed, undoTo });
}

/**
 * Stored versions, checked: exact fields; ids consecutive (a whole history or a recent stretch of it);
 * the first version ever is the default one; each version lists exactly what it changed from the one
 * before it, which is something, and it was made no earlier; undoTo points back.
 */
function checkHistory(input: unknown): readonly ConfigVersion[] {
  const rows = plainList('the history', input);
  if (rows.length === 0) {
    throw new ConfigError('the history must hold at least the active version');
  }
  const out: ConfigVersion[] = [];
  for (const raw of rows) {
    const { id, createdAt, author, values, changed, undoTo } = plainFields('a version', raw, VERSION_FIELDS);
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
      throw new ConfigError('a version id must be a whole number from 1');
    }
    const before = out.at(-1);
    if (before !== undefined && id !== before.id + 1) {
      throw new ConfigError('versions must come in order of their ids, without gaps');
    }
    if (id === 1 ? author !== 'default' : !SOURCES.includes(author as ChangeSource)) {
      throw new ConfigError('the first version is the default one, and every other has a known author');
    }
    const names = plainList('the changed tunables', changed);
    if (!names.every(isTunablePath)) {
      throw new ConfigError('a version lists its changed tunables by name');
    }
    if (undoTo !== null && (typeof undoTo !== 'number' || !Number.isSafeInteger(undoTo) || undoTo < 1 || undoTo >= id)) {
      throw new ConfigError('a version can only undo to an earlier one');
    }
    const version: ConfigVersion = Object.freeze({
      id,
      createdAt: time('createdAt', createdAt),
      author: author as ConfigVersion['author'],
      values: checkTunables(values),
      changed: Object.freeze([...(names as readonly TunablePath[])]),
      undoTo: undoTo as number | null,
    });
    if (id === 1 && (version.changed.length > 0 || version.undoTo !== null)) {
      throw new ConfigError('the first version changes nothing and undoes to nothing');
    }
    if (before !== undefined) {
      const actual = changedPaths(before.values, version.values);
      if (actual.length === 0 || actual.length !== version.changed.length || actual.some((path, i) => path !== version.changed[i])) {
        throw new ConfigError('a version must list exactly the tunables it changed');
      }
      if (version.createdAt < before.createdAt) {
        throw new ConfigError('a version cannot be older than the one before it');
      }
    }
    out.push(version);
  }
  return Object.freeze(out);
}

// ---------------------------------------------------------------- the plan every command shares

/** Who a set of applied changes touches: a strategy's own values that strategy, the exit values and the paper model every strategy. */
function effectsOf(paths: readonly TunablePath[], live: ReadonlySet<StrategyId>): Effects {
  const restart = new Set<StrategyId>();
  const demote = new Set<StrategyId>();
  for (const path of paths) {
    const strategy = strategyOf(path);
    const group = groupOf(path);
    const touched = strategy !== null ? [strategy] : group === 'exits' || group === 'paper' ? STRATEGY_IDS : [];
    for (const s of touched) {
      restart.add(s);
      // the paper model never changes a live strategy's trades: no demotion for it
      if (group !== 'paper' && live.has(s)) {
        demote.add(s);
      }
    }
  }
  return { demote: Object.freeze(STRATEGY_IDS.filter((s) => demote.has(s))), restartGate: Object.freeze(STRATEGY_IDS.filter((s) => restart.has(s))) };
}

/**
 * From the current values toward the target, field by field: a paper-model value that would become
 * less pessimistic stays (kept); while live trading is possible, a risk or exit value moving any way
 * but the safer one waits 24 hours; everything else applies now. Pending rows for every tunable the
 * command addressed are replaced, so the owner's latest word on a value wins.
 */
function plan(current: Tunables, target: Tunables, addressed: readonly TunablePath[], source: ChangeSource, ctx: Context, pending: readonly PendingChange[]): ChangePlan {
  const applied: FieldChange[] = [];
  const waiting: PendingChange[] = [];
  const kept: TunablePath[] = [];
  let values = current;
  for (const path of changedPaths(current, target)) {
    const from = valueAt(current, path);
    const to = valueAt(target, path);
    const safety = changeSafety(path, from, to);
    const group = groupOf(path);
    if (RULES[path].set === 'safer' && safety === 'riskier') {
      kept.push(path); // the paper model only ever becomes more pessimistic, whatever the command
    } else if (ctx.live && (group === 'risk' || group === 'exits') && safety !== 'safer') {
      waiting.push(Object.freeze({ path, from, to, source, requestedAt: ctx.now, applyAt: ctx.now + LOOSENING_DELAY_MS }));
    } else {
      applied.push(Object.freeze({ path, from, to, safety }));
      values = withValue(values, path, to);
    }
  }
  const addressedSet = new Set<string>(addressed);
  return Object.freeze({
    values,
    applied: Object.freeze(applied),
    pending: Object.freeze(waiting),
    cancelled: Object.freeze(pending.filter((row) => addressedSet.has(row.path))),
    kept: Object.freeze(kept),
    ...effectsOf(
      applied.map((change) => change.path),
      ctx.liveStrategies,
    ),
  });
}

// ---------------------------------------------------------------- /set

/**
 * /set <tunable> <value>, as the owner typed it. Refused: an unknown name (a mode, a hard cap, an
 * address or anything else not tunable), a value that is not digits, a value outside the bounds, a
 * paper-model value less pessimistic than now, and a value equal to the current one unless a pending
 * change for it is then replaced (setting the current value cancels a waiting loosening).
 */
export function planSet(currentRaw: Tunables, pathRaw: unknown, valueRaw: unknown, contextRaw: ChangeContext, pendingRaw: readonly PendingChange[]): PlanResult {
  const current = checkTunables(currentRaw);
  const ctx = checkContext(contextRaw);
  const pending = checkPending(pendingRaw, ctx.now);
  if (!isTunablePath(pathRaw)) {
    return refuse('unknown-parameter');
  }
  const path = pathRaw;
  const parsed = parseTunableValue(path, valueRaw);
  if (!parsed.ok) {
    return refuse(parsed.reason);
  }
  const from = valueAt(current, path);
  if (RULES[path].set === 'safer' && changeSafety(path, from, parsed.value) === 'riskier') {
    return refuse('paper-only-more-pessimistic');
  }
  if (parsed.value === from && !pending.some((row) => row.path === path)) {
    return refuse('no-change');
  }
  return Object.freeze({ ok: true as const, ...plan(current, withValue(current, path, parsed.value), [path], 'owner', ctx, pending) });
}

// ---------------------------------------------------------------- AI proposals

/** One AI proposal, as the review step validated it: a tunable, the value the AI saw, its proposal. */
export interface AiProposal {
  readonly param: TunablePath;
  readonly current: TunableValue;
  readonly proposed: TunableValue;
}

export interface AiReview {
  readonly valid: readonly AiProposal[];
  /** Each dropped proposal by its position in the AI's list, with the reason. */
  readonly dropped: readonly { readonly index: number; readonly reason: RefusalReason }[];
}

/** When the AI last changed this tunable: an approved AI version, or an AI change still pending. */
function lastAiChange(history: readonly ConfigVersion[], pending: readonly PendingChange[], path: TunablePath): number | null {
  let last: number | null = null;
  for (const version of history) {
    if (version.author === 'ai-approved' && version.changed.includes(path) && (last === null || version.createdAt > last)) {
      last = version.createdAt;
    }
  }
  for (const row of pending) {
    if (row.source === 'ai-approved' && row.path === path && (last === null || row.requestedAt > last)) {
      last = row.requestedAt;
    }
  }
  return last;
}

/** The rules of one proposal against the values now (s.12). */
function checkProposal(current: Tunables, raw: unknown, history: readonly ConfigVersion[], pending: readonly PendingChange[], now: number): AiProposal | RefusalReason {
  if (typeof raw !== 'object' || raw === null) {
    return 'malformed';
  }
  const { param, current: seenRaw, proposed: proposedRaw } = raw as { readonly param?: unknown; readonly current?: unknown; readonly proposed?: unknown };
  if (!isTunablePath(param)) {
    return 'unknown-parameter';
  }
  if (RULES[param].ai === 'never') {
    return 'not-ai-tunable';
  }
  const seen = parseTunableValue(param, seenRaw);
  const proposed = parseTunableValue(param, proposedRaw);
  if (!proposed.ok) {
    return proposed.reason;
  }
  const value = valueAt(current, param);
  if (!seen.ok || seen.value !== value) {
    return 'stale-current'; // the AI looked at other numbers than the bot runs with
  }
  if (proposed.value === value) {
    return 'no-change';
  }
  if (RULES[param].ai === 'safer' && changeSafety(param, value, proposed.value) !== 'safer') {
    return 'wrong-direction';
  }
  // at most a quarter of the current value, exactly: |proposed - current| x 4 <= current
  const tooLarge =
    typeof value === 'bigint'
      ? ((proposed.value as bigint) > value ? (proposed.value as bigint) - value : value - (proposed.value as bigint)) * 4n > value
      : Math.abs((proposed.value as number) - value) * 4 > value;
  if (tooLarge) {
    return 'change-too-large';
  }
  const last = lastAiChange(history, pending, param);
  if (last !== null && now - last < AI_COOLDOWN_MS) {
    return 'changed-recently';
  }
  return Object.freeze({ param, current: value, proposed: proposed.value });
}

/**
 * The proposals of one AI review, validated against the values now: at most 3 are considered, at
 * most one per tunable; everything invalid is dropped with its reason ("validate against bounds and
 * drop anything invalid", BUILD_PROMPT s.13). Never throws for a bad proposal: the AI is untrusted.
 * The engine stores the valid ones by id and approves each stored id at most once (planAiApproval).
 */
export function checkAiProposals(currentRaw: Tunables, proposalsRaw: unknown, historyRaw: readonly ConfigVersion[], pendingRaw: readonly PendingChange[], now: number): AiReview {
  const current = checkTunables(currentRaw);
  const history = checkHistory(historyRaw);
  const at = time('now', now);
  const pending = checkPending(pendingRaw, at);
  if (!Array.isArray(proposalsRaw)) {
    return Object.freeze({ valid: Object.freeze([]), dropped: Object.freeze([Object.freeze({ index: 0, reason: 'malformed' as const })]) });
  }
  const valid: AiProposal[] = [];
  const dropped: { readonly index: number; readonly reason: RefusalReason }[] = [];
  (proposalsRaw as readonly unknown[]).forEach((raw, index) => {
    if (index >= AI_MAX_PROPOSALS) {
      dropped.push(Object.freeze({ index, reason: 'too-many' }));
      return;
    }
    const checked = checkProposal(current, raw, history, pending, at);
    if (typeof checked === 'string') {
      dropped.push(Object.freeze({ index, reason: checked }));
    } else if (valid.some((p) => p.param === checked.param)) {
      dropped.push(Object.freeze({ index, reason: 'duplicate-parameter' }));
    } else {
      valid.push(checked);
    }
  });
  return Object.freeze({ valid: Object.freeze(valid), dropped: Object.freeze(dropped) });
}

/**
 * The owner approved an AI proposal (/approve <id>): the rules are checked again against the values
 * and the history at approval time (another change may have come first), then it is planned like
 * /set. Engine contract: the proposal is one the engine stored from a review, approved at most once.
 */
export function planAiApproval(
  currentRaw: Tunables,
  proposal: AiProposal,
  historyRaw: readonly ConfigVersion[],
  contextRaw: ChangeContext,
  pendingRaw: readonly PendingChange[],
): PlanResult {
  const current = checkTunables(currentRaw);
  const ctx = checkContext(contextRaw);
  const history = checkHistory(historyRaw);
  const pending = checkPending(pendingRaw, ctx.now);
  const checked = checkProposal(current, proposal, history, pending, ctx.now);
  if (typeof checked === 'string') {
    return refuse(checked);
  }
  return Object.freeze({ ok: true as const, ...plan(current, withValue(current, checked.param, checked.proposed), [checked.param], 'ai-approved', ctx, pending) });
}

// ---------------------------------------------------------------- /rollback

export type RollbackResult = ({ readonly ok: true; readonly target: number; readonly undoTo: number | null } & ChangePlan) | Refusal;

/**
 * /rollback: back to the version the active one undoes to, compared field by field like /set: while
 * live, a riskier risk or exit value waits 24 hours and the safer ones apply at once; a paper-model
 * value it would make less pessimistic stays as it is (`kept`). It addresses every tunable, so it
 * replaces every pending change. Once its pending rows apply, the values equal the target's exactly,
 * except the kept ones (invariant 11). Engine contract: make the new version with
 * nextVersion(active, values, 'rollback', now, undoTo) only when `applied` is not empty; when every
 * field waits, store only the pending rows.
 */
export function planRollback(historyRaw: readonly ConfigVersion[], activeId: number, contextRaw: ChangeContext, pendingRaw: readonly PendingChange[]): RollbackResult {
  const history = checkHistory(historyRaw);
  const ctx = checkContext(contextRaw);
  const pending = checkPending(pendingRaw, ctx.now);
  const active = history.find((version) => version.id === activeId);
  if (active === undefined) {
    throw new ConfigError('the active version is not in the history');
  }
  if (active.undoTo === null) {
    return refuse('nothing-to-roll-back');
  }
  const target = history.find((version) => version.id === active.undoTo);
  if (target === undefined) {
    throw new ConfigError('the version to roll back to is not in the history');
  }
  const planned = plan(active.values, target.values, TUNABLE_PATHS, 'rollback', ctx, pending);
  if (planned.applied.length === 0 && planned.pending.length === 0 && planned.cancelled.length === 0) {
    return refuse(planned.kept.length > 0 ? 'paper-only-more-pessimistic' : 'no-change');
  }
  return Object.freeze({ ok: true as const, target: target.id, undoTo: target.undoTo, ...planned });
}

// ---------------------------------------------------------------- pending live loosenings

export interface DueResult extends Effects {
  /** One step per applied row, in order: the engine makes a version for each (author: the row's source). */
  readonly steps: readonly { readonly change: PendingChange; readonly values: Tunables }[];
  /** Due rows whose tunable no longer holds the value they were made from, or whose value is now out of bounds: dropped, the owner is told. */
  readonly stale: readonly PendingChange[];
  readonly waiting: readonly PendingChange[];
}

/**
 * The pending rows that are due now, applied one by one in the order they fall due, with what the
 * applied ones demote and restart (a due exit value demotes every live strategy). Engine contract:
 * `now` is the guarded clock (RISK_POLICY.md s.4 contract 8); a clock stepped forward would apply a
 * loosening early.
 */
export function applyDuePending(currentRaw: Tunables, pendingRaw: readonly PendingChange[], contextRaw: ChangeContext): DueResult {
  let values = checkTunables(currentRaw);
  const ctx = checkContext(contextRaw);
  const pending = checkPending(pendingRaw, ctx.now);
  const order = (row: PendingChange): number => TUNABLE_PATHS.indexOf(row.path);
  const due = pending.filter((row) => row.applyAt <= ctx.now).sort((a, b) => a.applyAt - b.applyAt || order(a) - order(b));
  const steps: { readonly change: PendingChange; readonly values: Tunables }[] = [];
  const stale: PendingChange[] = [];
  for (const row of due) {
    if (valueAt(values, row.path) !== row.from || !inBounds(row.path, row.to)) {
      stale.push(row);
      continue;
    }
    values = withValue(values, row.path, row.to);
    steps.push(Object.freeze({ change: row, values }));
  }
  return Object.freeze({
    steps: Object.freeze(steps),
    stale: Object.freeze(stale),
    waiting: Object.freeze(pending.filter((row) => row.applyAt > ctx.now)),
    ...effectsOf(
      steps.map((step) => step.change.path),
      ctx.liveStrategies,
    ),
  });
}
