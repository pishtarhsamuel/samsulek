// T1, the approval transactions (STORAGE_DESIGN.md s.16.5; ARCHITECTURE.md s.4; RISK_POLICY.md s.6
// and s.9). Every buy or sell decision is one BEGIN IMMEDIATE transaction: phase R reads everything
// and runs the pure decision (risk issues the token last, inside it), phase W writes the intent, the
// position, the day's count, the decision and the approval, in that order; any throw rolls all of it
// back, and the token is returned only after COMMIT. A callback is written in place and catches
// nothing (the no-catch rule, C32): errors are caught around the whole transaction call, after the
// rollback, classified to a fixed code (app/faults.ts), and a refusal is recorded in a second small
// transaction with `inputs: {}` and that code (C46).
//
// Buys stop before the database is touched while new entries are latched, and the KILL file makes
// KILL stored and seen first. Exits read no flag at all: a valid reduce-only exit is always approved
// (s.9). Every exit fact (the position, its exit number, the exits in flight, the unused exit tokens,
// the fee budget) is re-read inside the transaction (C5, C51, C55), and on the exit path nothing is
// written before the position is read: an unknown slot uses up no exit number (review T, risk 5).
// The exit watch alerts every exit that does not approve, per position (review T, risk 4 and 8).
// Paper only: a live request, a live position or a live mode refuses (C57).
import { createHash } from 'node:crypto';
import { STRATEGY_IDS, isIdText, type StrategyId } from '../core/ids.ts';
import { isTimestamp } from '../core/time.ts';
import { lamports, type Lamports } from '../core/units.ts';
import type { Mark } from '../portfolio/equity.ts';
import type { ApprovalIssuer, ApprovalToken, SlotSource } from '../risk/approval.ts';
import { approveBuy, approveExit, type BuyMarket } from '../risk/approve.ts';
import type { BreakerState } from '../risk/blocks.ts';
import { canonicalPlan, type OrderPlan, type PlanUrgency } from '../risk/plan.ts';
import type { ApprovedPool, CheckedPlan, PlanContext, PlanProblem, QuoteContext } from '../risk/recheck.ts';
import { BASE_FEE_PER_SIGNATURE } from '../risk/reserve.ts';
import { abandonOpening, insertOpening, readPosition, type StoredPosition } from '../storage/repo-book.ts';
import { countEntry, setHalt, setKill } from '../storage/repo-flags.ts';
import {
  buyOrderOf,
  buyTokenExpiry,
  exitsInFlight,
  insertApproval,
  insertDecision,
  insertEntryIntent,
  insertExitIntent,
  intentExists,
  outstandingExitApprovals,
  type IntentInputs,
} from '../storage/repo-orders.ts';
import type { Db } from '../storage/sqlite.ts';
import { FAILED_FEE_BUDGET, exitPlanCapsOf } from './caps.ts';
import type { ExitWatch } from './exit-watch.ts';
import { AppError, classify, isSecretRefusal, type Alert, type AlertSink, type EntryLatch, type FaultScope, type FaultSink, type KillSentinel, type LatchReason } from './faults.ts';
import type { Clock } from './slots.ts';
import { readActiveConfig, readBuySnapshot } from './snapshot.ts';

/** The exit loop's mark cache, keyed by position id (portfolio/equity.ts's Mark). */
export interface MarkReader {
  marks(): ReadonlyMap<string, Mark>;
}
/** getMinimumBalanceForRentExemption(165), cached by the chain client; null until it is known. */
export interface RentSource {
  wsolHelperRent(): Lamports | null;
}
/** The breakers in memory (no table holds them). */
export interface BreakerSource {
  breakers(): readonly BreakerState[];
}
/** Paper's fixed placeholder addresses: never a key, never from a plan or a market. */
export interface PaperIdentity {
  readonly wallet: string;
  readonly wsolMint: string;
  tokenAccountOf(mint: string): string;
}

export interface EngineDeps {
  readonly mode: 'paper';
  readonly db: Db;
  readonly clock: Clock;
  /** The same slot feed the authority is bound to. */
  readonly slots: SlotSource;
  /** From app/authority.ts. */
  readonly issuer: ApprovalIssuer;
  readonly marks: MarkReader;
  readonly rent: RentSource;
  readonly breakers: BreakerSource;
  readonly identity: PaperIdentity;
  readonly sentinel: KillSentinel;
  readonly latch: EntryLatch;
  readonly faults: FaultSink;
  readonly alerts: AlertSink;
  readonly exitWatch: ExitWatch;
}

/** What the small writes need: the boot (6d-3) calls them before the issuer exists. */
export type StoreDeps = Pick<EngineDeps, 'db' | 'clock' | 'slots' | 'latch' | 'faults' | 'alerts'>;

/** What a strategy asks for (Phase 4 makes it); app derives the intent id and fills the identity. */
export interface EntryRequest {
  readonly strategy: StrategyId;
  readonly mode: 'paper';
  readonly mint: string;
  /** To the entry blocks only; never stored (s.15.16 question 2). */
  readonly creator: string | null;
  readonly sizeHint: 'min' | 'normal';
  /** The strategy's signal window: one entry per (strategy, mint, window). */
  readonly windowStartMs: number;
  /** From the engine's Rng, before the plan is built. */
  readonly positionId: string;
  readonly confidenceBps: number | null;
  readonly inputsAsOf: number | null;
  /** 1 to 16 codes. */
  readonly reasons: readonly string[];
  readonly inputs: IntentInputs;
  /** Untrusted until the re-check passed. */
  readonly plan: OrderPlan;
  /** The engine's own read; the wallet, token account and wSOL mint come from the identity. */
  readonly market: Omit<BuyMarket, 'wallet' | 'ownTokenAccount' | 'wsolMint'>;
}

export type EntryOutcome =
  | { readonly kind: 'approved'; readonly intentId: string; readonly positionId: string; readonly token: ApprovalToken; readonly plan: CheckedPlan }
  | { readonly kind: 'refused'; readonly intentId: string; readonly stage: 'blocked' | 'sizing' | 'plan'; readonly reasons: readonly string[] }
  /** The intent exists already: nothing written. */
  | { readonly kind: 'duplicate'; readonly intentId: string }
  /** Entries are latched: nothing written, the database not touched. */
  | { readonly kind: 'not-run'; readonly latched: readonly LatchReason[] }
  | { readonly kind: 'error'; readonly code: string; readonly scope: FaultScope; readonly recorded: boolean };

/** The owner's /sell and /panic come with Phase 3 (s.16.11 D7). */
export interface ExitOrigin6d {
  readonly kind: 'automatic';
  readonly sellSimPassed: boolean;
}
export interface ExitMarket {
  readonly quote: QuoteContext;
  readonly quotedOut: bigint;
  readonly pool: ApprovedPool;
  readonly attemptsAllowed: number;
  readonly simulatedCu: number | null;
}
export interface ExitRequest {
  readonly positionId: string;
  readonly fractionBps: number;
  readonly urgency: PlanUrgency;
  /** 1 to 16 codes. */
  readonly reasons: readonly string[];
  readonly inputs: IntentInputs;
  readonly inputsAsOf: number | null;
  readonly origin: ExitOrigin6d;
  /** Untrusted; built for peekExitIntent's intent id. */
  readonly plan: OrderPlan;
  readonly market: ExitMarket;
}

export type ExitOutcome =
  | { readonly kind: 'approved'; readonly intentId: string; readonly exitSeq: number; readonly token: ApprovalToken; readonly plan: CheckedPlan }
  | { readonly kind: 'refused'; readonly intentId: string; readonly exitSeq: number; readonly problems: readonly (PlanProblem | 'not-an-exit')[] }
  /** Nothing was read or written (the slot was unknown, the request or the position unreadable): no exit number used. */
  | { readonly kind: 'not-run'; readonly code: string }
  | { readonly kind: 'error'; readonly code: string; readonly scope: FaultScope; readonly recorded: boolean };

export type AbandonOutcome = { readonly kind: 'abandoned'; readonly at: number } | { readonly kind: 'error'; readonly code: string };

export type RefusalSubject = { readonly kind: 'entry'; readonly req: EntryRequest } | { readonly kind: 'exit'; readonly req: ExitRequest };

/** An exit number this high warns: storage refuses exits of the position at 999,999 (C53). */
export const EXIT_SEQ_ALERT = 10_000;
const MAX_EXIT_SEQ = 999_999;
/** The fixed reason of an exit retried without its inputs (review T, security on D1). */
const INPUTS_REFUSED = 'inputs-refused';

const hash40 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 40);

/** One entry per (strategy, mint, signal window): 'en_' + 40 hex. */
export function entryIntentId(strategy: StrategyId, mint: string, windowStartMs: number): string {
  if (!(STRATEGY_IDS as readonly unknown[]).includes(strategy) || !isIdText(mint) || !isTimestamp(windowStartMs)) {
    throw new AppError('bad-request', 'an entry is named by its strategy, its mint and the start of its signal window');
  }
  return `en_${hash40(`entry|${strategy}|${mint}|${windowStartMs}`)}`;
}

/** An exit is named by its position and the position's exit number, never by the caller (C54): 'ex_' + 40 hex. */
export function exitIntentId(positionId: string, exitSeq: number): string {
  if (!isIdText(positionId) || !Number.isSafeInteger(exitSeq) || exitSeq < 0 || exitSeq > MAX_EXIT_SEQ) {
    throw new AppError('bad-request', 'an exit is named by its position and an exit number from 0 to 999,999');
  }
  return `ex_${hash40(`exit|${positionId}|${exitSeq}`)}`;
}

/** An alert outside the database; a sink that throws latches entries as a bug instead of escaping. */
function alertSafely(alerts: AlertSink, latch: EntryLatch, a: Alert): void {
  try {
    alerts.alert(Object.freeze(a));
  } catch {
    latch.set('bug');
  }
}

const notObject = (v: unknown): boolean => typeof v !== 'object' || v === null;

interface EntryParts extends EntryRequest {
  readonly intentId: string;
}

/** The request, each field read once into a frozen copy; the id parts are checked here, the rest by risk and storage. */
function readEntry(req: EntryRequest): EntryParts {
  if (notObject(req)) {
    throw new AppError('bad-request', 'an entry request is an object');
  }
  const { strategy, mode, mint, creator, sizeHint, windowStartMs, positionId, confidenceBps, inputsAsOf, reasons, inputs, plan, market } = req;
  const intentId = entryIntentId(strategy, mint, windowStartMs);
  if ((mode as string) !== 'paper' && (mode as string) !== 'live') {
    throw new AppError('bad-request', 'an entry runs in paper or live mode');
  }
  if (notObject(market)) {
    throw new AppError('bad-request', "an entry carries the engine's own market read");
  }
  return Object.freeze({ strategy, mode, mint, creator, sizeHint, windowStartMs, positionId, confidenceBps, inputsAsOf, reasons, inputs, plan, market: Object.freeze({ ...market }), intentId });
}

/** The exit request, each field read once into a frozen copy; only an automatic exit exists in 6d. */
function readExit(req: ExitRequest): ExitRequest {
  if (notObject(req)) {
    throw new AppError('bad-request', 'an exit request is an object');
  }
  const { positionId, fractionBps, urgency, reasons, inputs, inputsAsOf, origin, plan, market } = req;
  if (notObject(origin) || notObject(market)) {
    throw new AppError('bad-request', "an exit carries its origin and the engine's own market read");
  }
  const { kind, sellSimPassed } = origin;
  if ((kind as string) !== 'automatic') {
    throw new AppError('bad-request', "only automatic exits exist until the owner's /sell and /panic arrive with Phase 3");
  }
  const { quote, quotedOut, pool, attemptsAllowed, simulatedCu } = market;
  return Object.freeze({
    positionId,
    fractionBps,
    urgency,
    reasons,
    inputs,
    inputsAsOf,
    origin: Object.freeze({ kind, sellSimPassed }),
    plan,
    market: Object.freeze({ quote, quotedOut, pool, attemptsAllowed, simulatedCu }),
  });
}

// ---------------------------------------------------------------- the small writes

/**
 * KILL stored with its engine audit row (repo-flags.ts setKill). KILL is marked seen first, whatever
 * the write does; a failed write latches entries and alerts outside the database (C25).
 */
export function persistKillTx(deps: StoreDeps, source: 'sentinel' | 'cli'): 'set' | 'already' | 'failed' {
  deps.latch.markKill();
  try {
    return deps.db.transaction((tx) => setKill(tx, deps.clock.now(), source)) ? 'set' : 'already';
  } catch (e) {
    deps.faults.report('kill', classify(e));
    deps.latch.set('kill-write-failed');
    alertSafely(deps.alerts, deps.latch, { code: 'kill-write-failed', severity: 'fatal', codes: [source] });
    return 'failed';
  }
}

/**
 * A halt stored with its engine audit row (repo-flags.ts setHalt); 6d asks for 'disk-db' only (the
 * fault sink's onDiskTrouble). Its own failure latches and alerts with the fault's code, and is never
 * reported back to the fault sink: a full disk would otherwise ask for this halt again, without end.
 */
export function persistHaltTx(deps: StoreDeps, reason: string): 'set' | 'already' | 'failed' {
  try {
    return deps.db.transaction((tx) => setHalt(tx, reason, deps.clock.now())) ? 'set' : 'already';
  } catch (e) {
    deps.latch.set('halt-write-failed');
    alertSafely(deps.alerts, deps.latch, { code: 'halt-write-failed', severity: 'fatal', codes: [classify(e).code] });
    return 'failed';
  }
}

/**
 * The refusal of an intent whose transaction threw: its intent with the error code as its one reason
 * and no inputs (C46), and an error decision with the slot T1 read, or 0 only when it was unknown
 * (C47). An entry answers duplicate when its intent exists; an exit uses up the position's number.
 * Its own failure latches entries and alerts; it never calls itself again.
 */
export function recordRefusalTx(deps: EngineDeps, s: RefusalSubject, code: string, slot: bigint | null): 'recorded' | 'duplicate' | 'failed' {
  try {
    if (s.kind === 'entry') {
      const e = readEntry(s.req);
      return deps.db.transaction((tx) => {
        if (intentExists(tx, e.intentId)) {
          return 'duplicate';
        }
        const now = deps.clock.now();
        const { versionId } = readActiveConfig(tx);
        insertEntryIntent(tx, { id: e.intentId, mode: e.mode, strategy: e.strategy, mint: e.mint, positionId: e.positionId, sizeHint: e.sizeHint, confidenceBps: e.confidenceBps, createdAt: now, inputsAsOf: e.inputsAsOf, reasons: [code], inputs: {} });
        insertDecision(tx, { outcome: 'refused', intentId: e.intentId, at: now, configVersion: versionId, stage: 'error', reasons: [code], slot });
        return 'recorded';
      });
    }
    const x = readExit(s.req);
    return deps.db.transaction((tx) => {
      const now = deps.clock.now();
      const p = readPosition(tx, x.positionId);
      const intentId = exitIntentId(p.id, p.exitSeq);
      const { versionId } = readActiveConfig(tx);
      insertExitIntent(tx, { id: intentId, positionId: p.id, exitSeq: p.exitSeq, fractionBps: x.fractionBps, urgency: x.urgency, createdAt: now, inputsAsOf: x.inputsAsOf, reasons: [code], inputs: {} });
      insertDecision(tx, { outcome: 'refused', intentId, at: now, configVersion: versionId, stage: 'error', reasons: [code], slot });
      return 'recorded';
    });
  } catch (e) {
    deps.faults.report('refusal', classify(e));
    deps.latch.set('refusal-write-failed');
    alertSafely(deps.alerts, deps.latch, { code: 'refusal-write-failed', severity: 'warn', codes: [code] });
    return 'failed';
  }
}

// ---------------------------------------------------------------- T1 buy

type BuyResult =
  | { readonly kind: 'duplicate'; readonly intentId: string }
  | { readonly kind: 'refused'; readonly intentId: string; readonly stage: 'blocked' | 'sizing' | 'plan'; readonly reasons: readonly string[]; readonly killStored: boolean }
  | { readonly kind: 'approved'; readonly intentId: string; readonly positionId: string; readonly token: ApprovalToken; readonly plan: CheckedPlan; readonly killStored: boolean };

/** T1 for an entry (s.16.5.1). The token is returned only after COMMIT; a refusal or an error makes none that counts. */
export function approveBuyTx(deps: EngineDeps, req: EntryRequest): EntryOutcome {
  const latched = deps.latch.blocked();
  if (latched.length > 0) {
    return Object.freeze({ kind: 'not-run', latched });
  }
  if (deps.sentinel.present()) {
    persistKillTx(deps, 'sentinel'); // its own transaction; T1 then records this entry as blocked: kill
  }
  let parts: EntryParts | null = null;
  const read = { slot: null as bigint | null };
  try {
    const e = readEntry(req);
    parts = e;
    if (e.mode !== 'paper') {
      throw new AppError('live-not-built', 'only paper entries exist until Phase 8');
    }
    // everything from outside is read once, before BEGIN; inside, only the clock and the slot
    const p95 = lamports(e.market.newPositionP95ExitCost);
    const rent = deps.rent.wsolHelperRent();
    if (rent === null) {
      throw new AppError('rent-unknown', 'the wSOL helper rent is not known yet: no entry without the chain read');
    }
    if (p95 < BASE_FEE_PER_SIGNATURE) {
      throw new AppError('p95-below-base-fee', 'an exit costs at least the 5,000-lamport base fee');
    }
    const marks = deps.marks.marks();
    const breakers = deps.breakers.breakers();
    const killSeen = deps.latch.killSeen();
    const market: BuyMarket = Object.freeze({ ...e.market, wallet: deps.identity.wallet, ownTokenAccount: deps.identity.tokenAccountOf(e.mint), wsolMint: deps.identity.wsolMint });
    const intent = Object.freeze({ strategy: e.strategy, mode: 'paper' as const, mint: e.mint, creator: e.creator, sizeHint: e.sizeHint, positionId: e.positionId, intentId: e.intentId });

    const result: BuyResult = deps.db.transaction((tx) => {
      // phase R
      const now = deps.clock.now();
      const slot = deps.slots.currentSlot();
      read.slot = slot;
      if (slot === null) {
        throw new AppError('slot-unknown', 'no fresh slot: no token without a known slot');
      }
      if (intentExists(tx, e.intentId)) {
        return { kind: 'duplicate', intentId: e.intentId };
      }
      const snap = readBuySnapshot(tx, { now, slot, mode: 'paper', marks, breakers, wsolHelperRent: rent, killSeen });
      const decision = approveBuy({ intent, plan: e.plan, world: snap.world, market, caps: snap.caps }, deps.issuer);
      const planText = decision.approved ? canonicalPlan(decision.plan) : '';
      // phase W
      insertEntryIntent(tx, { id: e.intentId, mode: 'paper', strategy: e.strategy, mint: e.mint, positionId: e.positionId, sizeHint: e.sizeHint, confidenceBps: e.confidenceBps, createdAt: now, inputsAsOf: e.inputsAsOf, reasons: e.reasons, inputs: e.inputs });
      if (!decision.approved) {
        insertDecision(tx, { outcome: 'refused', intentId: e.intentId, at: now, configVersion: snap.configVersion, stage: decision.stage, reasons: decision.reasons, slot });
        return { kind: 'refused', intentId: e.intentId, stage: decision.stage, reasons: decision.reasons, killStored: snap.killStored };
      }
      insertOpening(tx, decision.opening, p95); // the same p95 approveBuy sized with (C50), in the token's transaction (C6)
      if (countEntry(tx, snap.day) !== decision.entriesToday) {
        throw new AppError('entry-count-mismatch', "the day's entry count moved inside one BEGIN IMMEDIATE");
      }
      insertDecision(tx, { outcome: 'entry-approved', intentId: e.intentId, at: now, configVersion: snap.configVersion, slot, size: decision.size, limitedBy: decision.limitedBy, binding: decision.binding });
      insertApproval(tx, decision.token, planText, now);
      return { kind: 'approved', intentId: e.intentId, positionId: e.positionId, token: decision.token, plan: decision.plan, killStored: snap.killStored };
    });

    // after COMMIT
    if (result.kind === 'duplicate') {
      return Object.freeze({ kind: 'duplicate', intentId: result.intentId });
    }
    if (result.killStored) {
      deps.latch.markKill(); // T2 then refuses buy tokens issued before the KILL
    }
    return result.kind === 'refused'
      ? Object.freeze({ kind: 'refused', intentId: result.intentId, stage: result.stage, reasons: result.reasons })
      : Object.freeze({ kind: 'approved', intentId: result.intentId, positionId: result.positionId, token: result.token, plan: result.plan });
  } catch (err) {
    const f = classify(err);
    deps.faults.report('t1-buy', f);
    if (f.busy || parts === null) {
      return Object.freeze({ kind: 'error', code: f.code, scope: f.scope, recorded: false });
    }
    const answer = recordRefusalTx(deps, { kind: 'entry', req: parts }, f.code, read.slot);
    return Object.freeze({ kind: 'error', code: f.code, scope: f.scope, recorded: answer === 'recorded' });
  }
}

// ---------------------------------------------------------------- T1 exit

type ExitResult =
  | { readonly kind: 'refused'; readonly positionId: string; readonly intentId: string; readonly exitSeq: number; readonly problems: readonly (PlanProblem | 'not-an-exit')[] }
  | { readonly kind: 'approved'; readonly positionId: string; readonly intentId: string; readonly exitSeq: number; readonly token: ApprovalToken; readonly plan: CheckedPlan };

/** T1 for an exit (s.16.5.2): no flag is read, every exit fact is re-read inside the transaction. */
export function approveExitTx(deps: EngineDeps, req: ExitRequest): ExitOutcome {
  return exitOnce(deps, req, false);
}

function exitOnce(deps: EngineDeps, req: ExitRequest, retried: boolean): ExitOutcome {
  let parts: ExitRequest | null = null;
  const read = { slot: null as bigint | null, position: null as StoredPosition | null };
  try {
    const x = readExit(req);
    parts = x;
    const result: ExitResult = deps.db.transaction((tx) => {
      // phase R: nothing is written before the position is read (review T, risk 5)
      const now = deps.clock.now();
      const slot = deps.slots.currentSlot();
      if (slot === null) {
        throw new AppError('slot-unknown', 'no fresh slot: no exit token without a known slot');
      }
      read.slot = slot;
      const p = readPosition(tx, x.positionId);
      if (p.status !== 'open' && p.status !== 'exiting') {
        // an opening or closed position takes no exit number (repo-book.ts): nothing is written, and
        // an exit loop that raced a settlement or asked too early is told, never latched as a bug
        throw new AppError('position-not-sellable', 'only an open or exiting position is sold');
      }
      read.position = p;
      if (p.mode !== 'paper') {
        throw new AppError('live-not-built', 'only paper positions exist until Phase 8');
      }
      const seq = p.exitSeq;
      const intentId = exitIntentId(p.id, seq);
      const inFlight = exitsInFlight(tx, p.id);
      const outstanding = outstandingExitApprovals(tx, p.id, slot); // an unused token can still become an order (C51)
      const { versionId, tunables } = readActiveConfig(tx);
      // until T3: failed_fees is lifetime, so this budget never resets (C55, D5 of s.16.11)
      const budgetLeft = lamports(FAILED_FEE_BUDGET > p.failedFees ? FAILED_FEE_BUDGET - p.failedFees : 0n);
      const context: PlanContext = Object.freeze({
        currentSlot: slot,
        intentId,
        quote: x.market.quote,
        position: Object.freeze({ id: p.id, mint: p.mint, mode: p.mode, status: p.status }),
        wallet: deps.identity.wallet,
        ownTokenAccount: deps.identity.tokenAccountOf(p.mint), // paper's fixed mapping of the mint this transaction read
        wsolMint: deps.identity.wsolMint,
        pool: x.market.pool,
        ledgerTokens: p.tokenUnits,
        chainTokens: p.tokenUnits, // paper: the ledger is the chain; live reads the reconciler (Phase 8)
        simulatedCu: x.market.simulatedCu,
        caps: exitPlanCapsOf(tunables),
        buy: null,
        exit: Object.freeze({
          attemptsAllowed: x.market.attemptsAllowed,
          urgency: x.urgency,
          costBasis: p.costBasis,
          quotedOut: x.market.quotedOut,
          inFlightSellTokens: inFlight.sellTokens,
          inFlightExits: inFlight.count + outstanding,
          origin: Object.freeze({ kind: 'automatic' as const, budgetLeft, automaticStopped: budgetLeft === 0n, sellSimPassed: x.origin.sellSimPassed }),
        }),
      });
      const decision = approveExit({ plan: x.plan, context }, deps.issuer);
      const planText = decision.approved ? canonicalPlan(decision.plan) : '';
      // phase W: the intent uses up the exit number, approved or refused
      insertExitIntent(tx, { id: intentId, positionId: p.id, exitSeq: seq, fractionBps: x.fractionBps, urgency: x.urgency, createdAt: now, inputsAsOf: x.inputsAsOf, reasons: x.reasons, inputs: x.inputs });
      if (!decision.approved) {
        insertDecision(tx, { outcome: 'refused', intentId, at: now, configVersion: versionId, stage: 'plan', reasons: decision.problems.map((q) => `plan:${q}`), slot });
        return { kind: 'refused', positionId: p.id, intentId, exitSeq: seq, problems: decision.problems };
      }
      insertDecision(tx, { outcome: 'exit-approved', intentId, at: now, configVersion: versionId, slot });
      insertApproval(tx, decision.token, planText, now);
      return { kind: 'approved', positionId: p.id, intentId, exitSeq: seq, token: decision.token, plan: decision.plan };
    });

    // after COMMIT
    if (result.exitSeq + 1 >= EXIT_SEQ_ALERT) {
      alertSafely(deps.alerts, deps.latch, { code: 'exit-seq-high', severity: 'warn', codes: [result.positionId] });
    }
    if (result.kind === 'refused') {
      deps.exitWatch.refused(result.positionId, result.problems);
      return Object.freeze({ kind: 'refused', intentId: result.intentId, exitSeq: result.exitSeq, problems: result.problems });
    }
    deps.exitWatch.approved(result.positionId);
    return Object.freeze({ kind: 'approved', intentId: result.intentId, exitSeq: result.exitSeq, token: result.token, plan: result.plan });
  } catch (err) {
    const f = classify(err);
    deps.faults.report('t1-exit', f);
    const p = read.position;
    if (parts === null || p === null) {
      // nothing was read, so nothing is written and no exit number is used (review T, risk 5)
      if (parts !== null && isIdText(parts.positionId)) {
        deps.exitWatch.failed(parts.positionId);
      }
      return Object.freeze({ kind: 'not-run', code: f.code });
    }
    if (!retried && isSecretRefusal(err)) {
      // the exit planner's own text looked like a secret: a bug (C31), and the sale goes ahead without it
      alertSafely(deps.alerts, deps.latch, { code: 'exit-inputs-refused', severity: 'bug', codes: [p.id] });
      return exitOnce(deps, { ...parts, reasons: [INPUTS_REFUSED], inputs: {} }, true);
    }
    deps.exitWatch.failed(p.id);
    if (f.busy) {
      return Object.freeze({ kind: 'error', code: f.code, scope: f.scope, recorded: false }); // a retry may succeed: no number used
    }
    const answer = recordRefusalTx(deps, { kind: 'exit', req: parts }, f.code, read.slot);
    return Object.freeze({ kind: 'error', code: f.code, scope: f.scope, recorded: answer === 'recorded' });
  }
}

/** For the exit planner: the intent id its plan must carry. It decides nothing (T1 re-reads the number). */
export function peekExitIntent(deps: Pick<EngineDeps, 'db'>, positionId: string): { readonly intentId: string; readonly exitSeq: number } {
  const p = readPosition(deps.db, positionId);
  return Object.freeze({ intentId: exitIntentId(p.id, p.exitSeq), exitSeq: p.exitSeq });
}

// ---------------------------------------------------------------- abandoning an opening

/**
 * An opening position whose buy can no longer land is closed (s.16.5.3; repo-book.ts abandonOpening):
 * only with no buy order at all until T3 settles one (C48), and only after its buy token expired
 * (review T, security 3), so a token that could still be redeemed never meets a closed position. It is
 * booked at max(now, opened_at); no SOL moves and the entry still counts.
 */
export function abandonOpeningTx(deps: StoreDeps, positionId: string): AbandonOutcome {
  try {
    const at = deps.db.transaction((tx) => {
      const now = deps.clock.now();
      const slot = deps.slots.currentSlot();
      if (slot === null) {
        throw new AppError('slot-unknown', 'no known slot: the buy token may still be valid');
      }
      const p = readPosition(tx, positionId);
      if (buyOrderOf(tx, p.id) !== null) {
        throw new AppError('abandon-needs-settlement', 'a position with a buy order is abandoned only after T3 settles the order');
      }
      const expiry = buyTokenExpiry(tx, p.id);
      if (expiry !== null && slot <= expiry) {
        throw new AppError('abandon-token-valid', 'its buy token can still be used: an opening is abandoned only after the expiry slot');
      }
      const when = Math.max(now, p.openedAt);
      abandonOpening(tx, p.id, when);
      return when;
    });
    return Object.freeze({ kind: 'abandoned', at });
  } catch (e) {
    const f = classify(e);
    deps.faults.report('abandon', f);
    return Object.freeze({ kind: 'error', code: f.code });
  }
}
