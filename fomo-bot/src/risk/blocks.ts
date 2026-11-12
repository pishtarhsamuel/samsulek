// Entry blocks (RISK_POLICY.md s.6 step 1, s.4, s.7 and s.8): every reason a new buy is refused
// before it is sized. Pure: the engine reads flags, breakers, cooldowns and counters into an
// EntryState, and an empty answer is the only "yes". Every reason that applies is reported, so the
// owner sees all of them at once. Exits never pass through here: reduce-only exits are always
// allowed (s.9). A malformed state throws RiskError, which the engine treats as "refuse". The
// configured entries per day and position cap never count above their hard values (live: LIVE_CAPS).
import { HARD_CAPS, LIVE_CAPS } from '../config/caps.ts';
import { STRATEGY_IDS, isIdText, isStrategyId, type StrategyId } from '../core/ids.ts';
import { isMillis } from '../core/time.ts';
import { RiskError } from './reserve.ts';

/** s.7: entries wait for 15 minutes of clean data after a halt clears (a policy value; the tunables arrive in step 5b). */
const HALT_RECOVERY_MS = 15 * 60_000;

export type StrategyMode = 'off' | 'paper' | 'live';

/** Breakers that stop entries only (s.8); the HALT ones arrive as haltReasons. */
export const BREAKER_NAMES = Object.freeze([
  'DATA_STALE',
  'FOMO_SIGNAL',
  'DECODE',
  'RPC_ERRORS',
  'PROVIDER_BLOCKED',
  'PRICE_DIVERGENCE',
  'VENUE_CHANGED',
  'CLOCK',
  'SEND_FAILURES',
  'TELEGRAM_DOWN',
  'RESOURCES',
] as const);
export type BreakerName = (typeof BREAKER_NAMES)[number];

export type BreakerScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'strategy'; readonly strategy: StrategyId }
  | { readonly kind: 'mint'; readonly mint: string }
  | { readonly kind: 'venue'; readonly venue: string }
  | { readonly kind: 'live' };

export interface BreakerState {
  readonly name: BreakerName;
  readonly scope: BreakerScope;
  /** null while open; after it closes, the end of its quiet time (5 min, s.7). */
  readonly until: number | null;
}

export interface EntryState {
  readonly now: number;
  readonly kill: boolean;
  /** Non-empty means HALT. */
  readonly haltReasons: readonly string[];
  readonly haltClearedAt: number | null;
  readonly paused: boolean;
  readonly dailyStop: boolean;
  /** 10% of equity is below the minimum trade: all entries stop and the owner is told once. */
  readonly entriesStopped: boolean;
  /** False while any position lacks a fresh mark (marks over 30 s old, limit 20, included). */
  readonly equityKnown: boolean;
  /** The "+50% in 1 h" check of s.4 is still verifying the jump (not the owner's PAUSE). */
  readonly equityJumpPending: boolean;
  /** The flags table, the only place modes live. */
  readonly modes: Readonly<Record<StrategyId, StrategyMode>>;
  readonly breakers: readonly BreakerState[];
  /** 3 losing trades in a row: paused 2 h. */
  readonly strategyPausedUntil: Readonly<Partial<Record<StrategyId, number>>>;
  /** 6 losing trades in a day: off until 00:00 Athens. */
  readonly strategyOffUntil: Readonly<Partial<Record<StrategyId, number>>>;
  /** No re-entry into a token for 6 h after any exit. */
  readonly tokenCooldownUntil: ReadonlyMap<string, number>;
  /** Never again after an emergency or rug exit. */
  readonly bannedMints: ReadonlySet<string>;
  readonly blockedCreators: ReadonlySet<string>;
  /** Tokens with a position opening, open, exiting or stuck. */
  readonly activeMints: ReadonlySet<string>;
  readonly entriesToday: number;
  readonly entriesPerDay: number;
  /** Opening, open, exiting and stuck positions. */
  readonly activePositions: number;
  readonly maxPositions: number;
}

export interface EntryCheck {
  readonly strategy: StrategyId;
  /** The mode this entry would run in; it must be its strategy's mode. */
  readonly mode: 'paper' | 'live';
  readonly mint: string;
  readonly venue: string;
  readonly creator: string | null;
}

export type BlockReason =
  | 'kill'
  | 'halt'
  | 'pause'
  | 'daily-stop'
  | 'entries-stopped'
  | 'equity-unknown'
  | 'equity-jump-check'
  | 'halt-recovery'
  | 'strategy-off'
  | 'mode-mismatch'
  | `breaker:${BreakerName}`
  | 'strategy-cooldown'
  | 'strategy-off-today'
  | 'token-cooldown'
  | 'token-banned'
  | 'creator-blocked'
  | 'token-active'
  | 'entries-per-day'
  | 'max-positions';

// ---------------------------------------------------------------- checks of the state itself

function flag(what: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new RiskError(`${what} must be a boolean`);
  }
  return value;
}

function time(what: string, value: unknown): number {
  if (!isMillis(value)) {
    throw new RiskError(`${what} must be a UTC millisecond timestamp`);
  }
  return value;
}

function counter(what: string, value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new RiskError(`${what} must be a whole number of at least ${min}`);
  }
  return value;
}

function object<T>(what: string, value: T): T {
  if (typeof value !== 'object' || value === null) {
    throw new RiskError(`${what} must be an object`);
  }
  return value;
}

function id(what: string, value: unknown): string {
  if (!isIdText(value)) {
    throw new RiskError(`${what} is not a valid id`);
  }
  return value;
}

function container<T>(what: string, value: T, kind: typeof Map | typeof Set): T {
  if (!(value instanceof kind)) {
    throw new RiskError(`${what} must be a ${kind.name}`);
  }
  return value;
}

/** A time in a per-strategy record (own properties only), or null when the strategy has none. */
function strategyTime(what: string, record: Readonly<Partial<Record<StrategyId, number>>>, strategy: StrategyId): number | null {
  object(what, record);
  return Object.hasOwn(record, strategy) ? time(what, record[strategy]) : null;
}

function checkModes(modes: unknown): Readonly<Record<StrategyId, StrategyMode>> {
  const record = object('modes', modes) as Record<string, unknown>;
  for (const strategy of STRATEGY_IDS) {
    const mode = Object.hasOwn(record, strategy) ? record[strategy] : undefined;
    if (mode !== 'off' && mode !== 'paper' && mode !== 'live') {
      throw new RiskError(`the mode of ${strategy} must be off, paper or live`);
    }
  }
  return modes as Readonly<Record<StrategyId, StrategyMode>>;
}

function inScope(scopeInput: BreakerScope, entry: EntryCheck): boolean {
  const scope = object('breaker scope', scopeInput);
  switch (scope.kind) {
    case 'all':
      return true;
    case 'strategy':
      if (!isStrategyId(scope.strategy)) {
        throw new RiskError('a breaker scope names an unknown strategy');
      }
      return scope.strategy === entry.strategy;
    case 'mint':
      return id('breaker mint', scope.mint) === entry.mint;
    case 'venue':
      return id('breaker venue', scope.venue) === entry.venue;
    case 'live':
      return entry.mode === 'live';
    default:
      throw new RiskError('unknown breaker scope');
  }
}

function checkEntry(entryInput: EntryCheck): EntryCheck {
  const entry = object('entry', entryInput);
  if (!isStrategyId(entry.strategy)) {
    throw new RiskError('unknown strategy');
  }
  if (entry.mode !== 'paper' && entry.mode !== 'live') {
    throw new RiskError('an entry runs in paper or live mode');
  }
  id('mint', entry.mint);
  id('venue', entry.venue);
  if (entry.creator !== null) {
    id('creator', entry.creator);
  }
  return entry;
}

// ---------------------------------------------------------------- the blocks

/** Every reason this entry is refused; an empty list is the only "yes". */
export function entryBlocks(state: EntryState, entryInput: EntryCheck): readonly BlockReason[] {
  const entry = checkEntry(entryInput);
  object('state', state);
  const now = time('now', state.now);
  const reasons: BlockReason[] = [];
  const add = (reason: BlockReason, applies: boolean): void => {
    if (applies && !reasons.includes(reason)) {
      reasons.push(reason); // the same breaker in two scopes is reported once
    }
  };

  if (!Array.isArray(state.haltReasons) || !state.haltReasons.every((r) => typeof r === 'string')) {
    throw new RiskError('haltReasons must be a list of strings');
  }
  add('kill', flag('kill', state.kill));
  add('halt', state.haltReasons.length > 0);
  add('pause', flag('paused', state.paused));
  add('daily-stop', flag('dailyStop', state.dailyStop));
  add('entries-stopped', flag('entriesStopped', state.entriesStopped));
  add('equity-unknown', !flag('equityKnown', state.equityKnown));
  add('equity-jump-check', flag('equityJumpPending', state.equityJumpPending));
  const cleared = state.haltClearedAt === null ? null : time('haltClearedAt', state.haltClearedAt);
  add('halt-recovery', cleared !== null && now < cleared + HALT_RECOVERY_MS);

  const mode = checkModes(state.modes)[entry.strategy];
  add('strategy-off', mode === 'off');
  add('mode-mismatch', mode !== 'off' && mode !== entry.mode);

  const breakers: readonly BreakerState[] = state.breakers;
  if (!Array.isArray(breakers as unknown)) {
    throw new RiskError('breakers must be a list');
  }
  for (const breakerInput of breakers) {
    const breaker = object('breaker', breakerInput);
    if (!(BREAKER_NAMES as readonly string[]).includes(breaker.name)) {
      throw new RiskError('unknown breaker');
    }
    const until = breaker.until === null ? null : time('breaker until', breaker.until);
    add(`breaker:${breaker.name}`, inScope(breaker.scope, entry) && (until === null || now < until));
  }

  const paused = strategyTime('strategyPausedUntil', state.strategyPausedUntil, entry.strategy);
  add('strategy-cooldown', paused !== null && now < paused);
  const off = strategyTime('strategyOffUntil', state.strategyOffUntil, entry.strategy);
  add('strategy-off-today', off !== null && now < off);
  const cooldown = container('tokenCooldownUntil', state.tokenCooldownUntil, Map).get(entry.mint);
  add('token-cooldown', cooldown !== undefined && now < time('token cooldown', cooldown));
  add('token-banned', container('bannedMints', state.bannedMints, Set).has(entry.mint));
  // A null creator only for venues without one; the safety filter rejects an unreadable creator.
  const creators = container('blockedCreators', state.blockedCreators, Set);
  add('creator-blocked', entry.creator !== null && creators.has(entry.creator));
  add('token-active', container('activeMints', state.activeMints, Set).has(entry.mint));
  // The configured counts, never above the hard ones (limits 3 and 13; a live entry: 5 a day). The
  // day's count is every entry of the day, paper and live, so a busy paper strategy can only use up
  // live entries, never add to them.
  const hardPerDay = entry.mode === 'live' ? Math.min(HARD_CAPS.entriesPerDay, LIVE_CAPS.entriesPerDay) : HARD_CAPS.entriesPerDay;
  const perDay = Math.min(counter('entriesPerDay', state.entriesPerDay, 1), hardPerDay);
  const positionCap = Math.min(counter('maxPositions', state.maxPositions, 1), HARD_CAPS.openPositions);
  add('entries-per-day', counter('entriesToday', state.entriesToday, 0) >= perDay);
  add('max-positions', counter('activePositions', state.activePositions, 0) >= positionCap);
  return Object.freeze(reasons);
}
