// The error rules of the app/ transactions (STORAGE_DESIGN.md s.16.5.6). A throw out of a
// transaction (after its rollback) is classified into a fixed code, never its message: a message can
// carry a value, and only codes are stored or alerted. Its scope says what follows: 'intent' (this
// intent is refused, and recorded by the caller), 'latch' (new entries stop until the restart) or
// 'fatal' (the database handle cannot be trusted: the run loop exits, and the restart runs the
// boot). The entry latch blocks entries before the database is touched and remembers KILL seen
// anywhere. The fault sink applies a fault: the latch, the alerts (outside the database), the
// disk-db halt on a full disk, an I/O error or a busy storm (three busy refusals in ten minutes),
// and onFatal once. classify and the sink never throw.
import { ConfigError } from '../config/tunables.ts';
import { AmountError } from '../core/units.ts';
import { RngError } from '../core/rng.ts';
import { LedgerError } from '../portfolio/ledger.ts';
import { RiskError } from '../risk/reserve.ts';
import { StorageError, type StorageErrorCode } from '../storage/sqlite.ts';
import type { Clock } from './slots.ts';

export const APP_ERROR_CODES = Object.freeze([
  'slot-unknown',
  'rent-unknown',
  'p95-below-base-fee',
  'entry-count-mismatch',
  'abandon-needs-settlement',
  'abandon-token-valid',
  'position-not-sellable',
  'entries-latched',
  'live-not-built',
  'bad-request',
  'stale-opening-has-order',
  'day-state-stale',
] as const);
export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

/** A refusal of the app/ layer itself: a fixed code and a fixed sentence (never a value). */
export class AppError extends Error {
  readonly code: AppErrorCode;

  constructor(code: AppErrorCode, message: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}

export type FaultScope = 'intent' | 'latch' | 'fatal';

export interface Fault {
  /** The fixed code stored and alerted, e.g. 'error:storage-full': a code, never a message. */
  readonly code: string;
  readonly scope: FaultScope;
  /** "Cannot happen if the parts agree": alert as a bug. */
  readonly bug: boolean;
  /** Alert although it is no bug: a fault of the environment, or data the bot was given. */
  readonly warn: boolean;
  /** SQLite was busy: the busy window counts it. */
  readonly busy: boolean;
  /** A full disk or an I/O error: the disk-db halt is tried. */
  readonly disk: boolean;
}

/**
 * Where the fault happened (an alert names it). t2 is a buy token's use, t2-exit an exit token's; day
 * is the equity observation, jump its confirmation, config-due the engine's config step and owner the
 * owner's commands (6e).
 */
export type FaultSite = 't1-buy' | 't1-exit' | 't2' | 't2-exit' | 'abandon' | 'refusal' | 'kill' | 'halt' | 'boot' | 'day' | 'jump' | 'config-due' | 'owner';
/** A fault here stopped a sale: it always alerts (review T, risk 4). */
const EXIT_SITES: ReadonlySet<FaultSite> = new Set<FaultSite>(['t1-exit', 't2-exit']);

export type AlertSeverity = 'info' | 'warn' | 'bug' | 'fatal';

/** What reaches the owner outside the database (Telegram later): codes only. */
export interface Alert {
  readonly code: string;
  readonly severity: AlertSeverity;
  readonly codes?: readonly string[];
}

/** Outside the database; must never throw (the sink contains it if it does). */
export interface AlertSink {
  alert(a: Alert): void;
}

/** The KILL file at the server (app/run-files.ts makes the real one in step 6d-3): any doubt reads as present. */
export interface KillSentinel {
  present(): boolean;
}

const fault = (code: string, scope: FaultScope, flags: Partial<Omit<Fault, 'code' | 'scope'>> = {}): Fault =>
  Object.freeze({ code, scope, bug: false, warn: false, busy: false, disk: false, ...flags });

/** Errors the bot's own code makes: an impossible state, a broken rule of the caller. */
const STORAGE_BUGS: ReadonlySet<StorageErrorCode> = new Set<StorageErrorCode>([
  'row-missing',
  'row-count',
  'bad-cell',
  'tx-failed',
  'denied',
  'bad-sql',
  'audit-broken',
  'bad-option',
  'other',
]);
/** The file, the disk or the setup: the environment, not the code. */
const STORAGE_ENVIRONMENT: ReadonlySet<StorageErrorCode> = new Set<StorageErrorCode>([
  'corrupt',
  'not-a-database',
  'readonly',
  'pragma',
  'closed',
  'missing',
  'foreign-file',
  'schema-edited',
  'schema-newer',
  'schema-broken',
]);
/** The handle's transaction state is unknown or misused: nothing more may run on it. */
const STORAGE_FATAL_BUGS: ReadonlySet<StorageErrorCode> = new Set<StorageErrorCode>(['async-in-transaction', 'nested-transaction', 'tx-closed']);
const ALL_STORAGE_CODES: ReadonlySet<string> = new Set<string>([
  ...STORAGE_BUGS,
  ...STORAGE_ENVIRONMENT,
  ...STORAGE_FATAL_BUGS,
  'busy',
  'constraint',
  'bad-param',
  'full',
  'io',
  'poisoned',
]);
/** codec.ts noSecret's own words: the secret filter refused text the bot was given. */
const SECRET_REFUSAL = 'looks like one:';
/** repo-redeem.ts's words for a token used too late or with a clock behind its issue: timing, not a bug. */
const RETRY_WITH_NEW_TOKEN = 'a retry gets a new token';
const HARD_LIMIT = 'the approval would break a hard limit';
/**
 * risk/approve.ts's words for a position list that the database and the snapshot make impossible
 * (one position per mint, at most four, ids unique, each row's own number): a bug, not a refusal of
 * this intent alone (review T, risk 4). The approve-tx tests pin these words against risk's throws.
 */
const IMPOSSIBLE_POSITIONS: readonly string[] = Object.freeze([
  'active positions: not a real portfolio',
  'a position has an unknown strategy',
  'a position here must be opening, open, exiting or stuck',
  'two positions share an id',
  'two active positions share a mint',
  'an opening position carries its maxSpend',
]);
const UNEXPECTED = fault('error:unexpected', 'latch', { bug: true });

/** An own data property (a getter on a look-alike object is not read), or undefined. */
function ownValue(e: object, key: string): unknown {
  const d = Object.getOwnPropertyDescriptor(e, key);
  return d !== undefined && 'value' in d ? d.value : undefined;
}

function storageFault(code: StorageErrorCode, detail: unknown): Fault {
  const name = `error:storage-${code}`;
  if (code === 'busy') {
    return fault(name, 'intent', { busy: true });
  }
  if (code === 'constraint') {
    return fault(name, 'intent', { bug: true });
  }
  if (code === 'bad-param') {
    // thrown before any write of its function, so the intent alone is refused (16.1, D1)
    const expected = typeof detail === 'string' && (detail.includes(SECRET_REFUSAL) || detail.includes(RETRY_WITH_NEW_TOKEN));
    return expected ? fault(name, 'intent', { warn: true }) : fault(name, 'intent', { bug: true });
  }
  if (code === 'full' || code === 'io') {
    return fault(name, 'latch', { warn: true, disk: true });
  }
  if (code === 'poisoned') {
    return fault(name, 'fatal', { warn: true });
  }
  if (STORAGE_FATAL_BUGS.has(code)) {
    return fault(name, 'fatal', { bug: true });
  }
  return STORAGE_ENVIRONMENT.has(code) ? fault(name, 'latch', { warn: true }) : fault(name, 'latch', { bug: true });
}

function appFault(code: AppErrorCode): Fault {
  const name = `error:${code}`;
  switch (code) {
    case 'entry-count-mismatch':
      return fault(name, 'latch', { bug: true });
    case 'live-not-built':
    case 'bad-request':
      return fault(name, 'intent', { bug: true });
    case 'rent-unknown':
    case 'p95-below-base-fee':
    case 'stale-opening-has-order':
      return fault(name, 'intent', { warn: true });
    default:
      return fault(name, 'intent');
  }
}

function classifyKnown(e: unknown): Fault {
  if (typeof e !== 'object' || e === null) {
    return UNEXPECTED;
  }
  if (e instanceof StorageError) {
    const code = ownValue(e, 'code');
    return typeof code === 'string' && ALL_STORAGE_CODES.has(code) ? storageFault(code as StorageErrorCode, ownValue(e, 'detail')) : UNEXPECTED;
  }
  if (e instanceof AppError) {
    const code = ownValue(e, 'code');
    return typeof code === 'string' && (APP_ERROR_CODES as readonly string[]).includes(code) ? appFault(code as AppErrorCode) : UNEXPECTED;
  }
  if (e instanceof RiskError) {
    const message = ownValue(e, 'message');
    const bug = typeof message === 'string' && (message.startsWith(HARD_LIMIT) || IMPOSSIBLE_POSITIONS.some((words) => message.includes(words)));
    return fault('error:risk', 'intent', { bug });
  }
  if (e instanceof AmountError) {
    return fault('error:amount', 'intent');
  }
  if (e instanceof LedgerError) {
    return fault('error:ledger', 'intent');
  }
  if (e instanceof ConfigError) {
    // a stored config that does not decode cannot be trusted for any intent (6e names it)
    return fault('error:config', 'latch', { bug: true });
  }
  if (e instanceof RngError) {
    const code = ownValue(e, 'code');
    if (code === 'rng-filter' || code === 'rng-zero-key') {
      return fault(`error:${code}`, 'intent', { warn: true });
    }
    return code === 'rng-bad-bytes' ? fault('error:rng-bad-bytes', 'intent', { bug: true }) : UNEXPECTED;
  }
  return UNEXPECTED;
}

/** Total: whatever was thrown (a hostile object included) gets a fault; never throws. */
export function classify(e: unknown): Fault {
  try {
    return classifyKnown(e);
  } catch {
    return UNEXPECTED;
  }
}

/**
 * True when the secret filter refused text the bot was given (storage's bad-param in the filter's own
 * words, read from own data properties): the exit path then retries at once without its inputs, so
 * no secret-looking text can keep a position from being sold (review T, security on D1). Never throws.
 */
export function isSecretRefusal(e: unknown): boolean {
  try {
    if (!(e instanceof StorageError) || ownValue(e, 'code') !== 'bad-param') {
      return false;
    }
    const detail = ownValue(e, 'detail');
    return typeof detail === 'string' && detail.includes(SECRET_REFUSAL);
  } catch {
    return false;
  }
}

export const LATCH_REASONS = Object.freeze(['storage', 'storage-busy', 'refusal-write-failed', 'kill-write-failed', 'halt-write-failed', 'bug'] as const);
export type LatchReason = (typeof LATCH_REASONS)[number];

export interface EntryLatch {
  /** Entries blocked before the database is touched. Sticky until the restart. */
  set(reason: LatchReason): void;
  blocked(): readonly LatchReason[];
  /** KILL seen anywhere (the flag, the sentinel, a failed KILL write). Sticky until the restart. */
  markKill(): void;
  killSeen(): boolean;
}

export function createEntryLatch(): EntryLatch {
  const reasons = new Set<LatchReason>();
  let kill = false;
  return Object.freeze({
    set(reason: LatchReason): void {
      if (!(LATCH_REASONS as readonly string[]).includes(reason)) {
        throw new TypeError('a latch reason from the list');
      }
      reasons.add(reason);
    },
    blocked: (): readonly LatchReason[] => Object.freeze([...reasons].sort()),
    markKill(): void {
      kill = true;
    },
    killSeen: (): boolean => kill,
  });
}

export interface FaultSink {
  /** Applies the fault; never throws. */
  report(site: FaultSite, f: Fault): void;
}

export interface FaultSinkOptions {
  readonly latch: EntryLatch;
  readonly alerts: AlertSink;
  readonly clock: Clock;
  /** The run loop's exit (a later step); called once, for the first fatal fault. */
  readonly onFatal: (code: string) => void;
  /** Tries the disk-db halt (app/approve-tx.ts persistHaltTx, step 6d-2). */
  readonly onDiskTrouble: (code: string) => void;
}

const BUSY_WINDOW_MS = 10 * 60_000;
const BUSY_STORM = 3;
/** Bug-class faults of single intents that repeat: entries latch as a bug (review T, security on D1). */
const BUG_WINDOW_MS = 10 * 60_000;
const BUG_STORM = 5;
const EXIT_ALERT_EVERY_MS = 60_000;
const isFn = (v: unknown): boolean => typeof v === 'function';

export function createFaultSink(o: FaultSinkOptions): FaultSink {
  const { latch, alerts, clock, onFatal, onDiskTrouble } = o;
  const objectWith = (v: unknown, ...members: string[]): boolean => typeof v === 'object' && v !== null && members.every((m) => isFn((v as Record<string, unknown>)[m]));
  if (!objectWith(latch, 'set', 'blocked', 'markKill', 'killSeen') || !objectWith(alerts, 'alert') || !objectWith(clock, 'now') || !isFn(onFatal) || !isFn(onDiskTrouble)) {
    throw new TypeError('a fault sink needs the latch, the alert sink, the clock, onFatal and onDiskTrouble');
  }
  let busyTimes: readonly number[] = [];
  let bugTimes: readonly number[] = [];
  let bugStorm = false;
  let fatalCalled = false;
  /** Runs an outside call; a throw latches entries as a bug instead of escaping. */
  const contained = (fn: () => void): void => {
    try {
      fn();
    } catch {
      latch.set('bug');
    }
  };
  const alert = (a: Alert): void => contained(() => alerts.alert(Object.freeze(a)));
  /** An exit that failed quietly still alerts, at most once a minute per site and code (an exit loop retries often). */
  const exitAlerted = new Map<string, number>();
  const exitAlert = (code: string, where: readonly FaultSite[]): void =>
    contained(() => {
      const now = clock.now();
      const key = `${where.join(',')}:${code}`;
      const last = exitAlerted.get(key);
      if (last !== undefined && now >= last && now - last < EXIT_ALERT_EVERY_MS) {
        return;
      }
      exitAlerted.set(key, now);
      alert({ code, severity: 'warn', codes: where });
    });
  return Object.freeze({
    report(site: FaultSite, f: Fault): void {
      const where = Object.freeze([site]);
      const exit = EXIT_SITES.has(site);
      if (f.busy && exit) {
        exitAlert(f.code, where);
      }
      if (f.busy) {
        contained(() => {
          const now = clock.now();
          busyTimes = [...busyTimes, now].filter((t) => now - t <= BUSY_WINDOW_MS);
          if (busyTimes.length >= BUSY_STORM && !latch.blocked().includes('storage-busy')) {
            latch.set('storage-busy');
            alert({ code: 'storage-busy-storm', severity: 'warn', codes: where });
            contained(() => onDiskTrouble('storage-busy-storm'));
          }
        });
        return;
      }
      if (f.scope === 'fatal') {
        latch.set(f.bug ? 'bug' : 'storage');
        alert({ code: f.code, severity: 'fatal', codes: where });
        if (!fatalCalled) {
          fatalCalled = true;
          contained(() => onFatal(f.code));
        }
        return;
      }
      if (f.scope === 'latch') {
        latch.set(f.bug ? 'bug' : 'storage');
      }
      if (f.bug || f.warn) {
        alert({ code: f.code, severity: f.bug ? 'bug' : 'warn', codes: where });
      } else if (exit) {
        exitAlert(f.code, where);
      }
      if (f.bug && f.scope === 'intent') {
        // one bug may be one bad request; five in ten minutes is code that cannot be trusted to enter.
        // A fault the clock now puts in the future (it stepped back) is recent in real time: it stays.
        contained(() => {
          const now = clock.now();
          bugTimes = [...bugTimes, now].filter((t) => now - t <= BUG_WINDOW_MS);
          if (bugTimes.length >= BUG_STORM && !bugStorm) {
            bugStorm = true;
            latch.set('bug');
            alert({ code: 'bug-storm', severity: 'bug', codes: where });
          }
        });
      }
      if (f.disk) {
        contained(() => onDiskTrouble(f.code));
      }
    },
  });
}
