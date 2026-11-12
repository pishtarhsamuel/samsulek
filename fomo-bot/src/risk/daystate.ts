// Equity and day state (RISK_POLICY.md s.4 and limits 9, 10, 12; invariants 14 and 22), ported from
// the root project's observe_equity. A pure state machine: every observation returns the next state
// and the trips it caused; the engine turns trips into flags (HALT, daily stop, peak halt).
// - Baseline = the higher of the last equity and the day's first observation: an overnight gap
//   down counts against today, a gap up is not credited as extra loss allowance.
// - Anomalies (zero equity, a sanity breach, a clock that went backwards, a +50% jump not yet
//   verified) never move the baseline, the peak or the last equity.
// - A confirmed jump (confirmEquityJump) records the verified equity (within the sanity limits):
//   for the next hour a rise is measured from the higher of the hour-ago snapshot and that
//   verified level, so the same rise cannot trip the hold again and again while the snapshot is
//   still from before it.
// - Two daily stops on consecutive days set a STICKY streak halt, reported on every observation
//   until the owner's resumeStreak: a quiet day or a gap in between cannot lift it.
// - The stops read a separate stop-equity (positions stale for over 5 min valued 0) and never move
//   anything (REVIEWS.md D, M3), so a dead price feed can trip a stop but cannot set a baseline.
// - The day is the Europe/Athens calendar day (core/day.ts), so the daily stop resets at local
//   midnight on 23- and 25-hour days too.
// The thresholds can only be tighter than their hard values (config/caps.ts moves them in step 5).
import { athensDay, isDay, previousDay } from '../core/day.ts';
import { isTimestamp } from '../core/time.ts';
import { U64_MAX, type Bps, type Lamports, type SignedLamports } from '../core/units.ts';
import { RiskError } from './reserve.ts';

const HOUR_MS = 3_600_000;
/** RISK_POLICY.md limits 9, 10 and 12: the H values. */
const HARD_DAILY_STOP_BPS = 3_000;
const HARD_PEAK_HALT_BPS = 5_000;
const HARD_SANITY_MAX = 2_000_000_000n;
const HARD_SANITY_MULTIPLE = 3;
const HARD_JUMP_BPS = 5_000;

export interface EquityPolicy {
  /** Limit 9: -30% from the day baseline (H; tunable down to 5%). */
  readonly dailyStopBps: Bps;
  /** Limit 10: -50% from the peak (H; tunable down to 10%). */
  readonly peakHaltBps: Bps;
  /** Limit 12: equity above this halts (2.0 SOL). */
  readonly sanityMaxLamports: Lamports;
  /** The configured bankroll; equity above sanityBankrollMultiple x this halts. */
  readonly bankrollLamports: Lamports;
  readonly sanityBankrollMultiple: number;
  /** Limit 12: +50% within an hour is held for verification. */
  readonly jumpBps: Bps;
}

export interface EquityState {
  /** The Athens date of the last accepted observation; null before the first. */
  readonly day: string | null;
  /** The day baseline; 0 means not observed yet today. */
  readonly dayStart: Lamports;
  readonly lastEquity: Lamports;
  readonly peak: Lamports | null;
  /** A +50% jump is waiting for the engine's verification; baseline and peak stay put. */
  readonly jumpPending: boolean;
  /**
   * The latest observation that was held as a jump (its equity and time); set exactly while
   * jumpPending. A confirmation must follow it closely and can never verify more than it saw.
   */
  readonly jumpHeld: { readonly equity: Lamports; readonly at: number } | null;
  /** The verified equity of a confirmed jump and when it was confirmed; a reference for the next hour. */
  readonly jumpAck: { readonly equity: Lamports; readonly at: number } | null;
  /** The Athens day a daily stop last tripped; entries are blocked for that day. */
  readonly dailyStopDay: string | null;
  /** Consecutive days with a daily stop. */
  readonly dailyStopStreak: number;
  /**
   * Two daily stops on consecutive days: entries wait for the owner. Sticky: set the moment the
   * streak reaches two and cleared only by resumeStreak, so a quiet day or a gap cannot lift it.
   */
  readonly streakHalt: boolean;
}

export interface EquityObservation {
  /** UTC milliseconds (core/clock). */
  readonly now: number;
  /** Fully valued equity; null while any position lacks a fresh mark. */
  readonly equity: Lamports | null;
  /** For the stops only: stale positions valued 0 after 5 min; null if unknown. Never above equity. */
  readonly stopEquity: Lamports | null;
  /** The equity snapshot nearest one hour earlier; null if there is none. */
  readonly equityAnHourAgo: Lamports | null;
}

export type EquityTrip =
  | 'equity-zero'
  | 'sanity-max'
  | 'sanity-bankroll'
  | 'clock-backwards'
  | 'equity-jump'
  | 'daily-stop'
  | 'daily-stop-twice'
  | 'peak-halt';

export interface EquityResult {
  readonly state: EquityState;
  readonly trips: readonly EquityTrip[];
}

// ---------------------------------------------------------------- checks of the inputs

function object<T extends object>(what: string, value: T | null | undefined): T {
  if (typeof value !== 'object' || value === null) {
    throw new RiskError(`${what} must be an object`);
  }
  return value;
}

function amount(what: string, value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) {
    throw new RiskError(`${what} must be a bigint from 0 to 2^64 - 1`);
  }
  return value;
}

function optionalAmount(what: string, value: unknown): bigint | null {
  return value === null ? null : amount(what, value);
}

function flag(what: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new RiskError(`${what} must be a boolean`);
  }
  return value;
}

function optionalDay(what: string, value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (!isDay(value)) {
    throw new RiskError(`${what} must be a calendar date or null`);
  }
  return value;
}

function threshold(what: string, value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new RiskError(`${what} must be a whole number from 1 to ${max}`);
  }
  return value;
}

function checkAck(value: EquityState['jumpAck']): EquityState['jumpAck'] {
  if (value === null) {
    return null;
  }
  const ack = object('jumpAck', value);
  const equity = amount('jumpAck equity', ack.equity);
  const at = ack.at; // each field is read once
  // Above the hard sanity limit no equity is ever accepted, so no verified level can be higher.
  if (equity < 1n || equity > HARD_SANITY_MAX || !isTimestamp(at)) {
    throw new RiskError('jumpAck needs a verified equity from 1 lamport to 2.0 SOL and a timestamp');
  }
  return Object.freeze({ equity: equity as Lamports, at });
}

function checkHeld(value: EquityState['jumpHeld']): EquityState['jumpHeld'] {
  if (value === null) {
    return null;
  }
  const held = object('jumpHeld', value);
  const equity = amount('jumpHeld equity', held.equity);
  const at = held.at; // each field is read once
  // An observed equity that passed the sanity checks: never above the hard sanity limit.
  if (equity < 1n || equity > HARD_SANITY_MAX || !isTimestamp(at)) {
    throw new RiskError('jumpHeld needs an observed equity from 1 lamport to 2.0 SOL and a timestamp');
  }
  return Object.freeze({ equity: equity as Lamports, at });
}

function checkState(input: EquityState): EquityState {
  const s = object('state', input);
  const streak = s.dailyStopStreak;
  if (typeof streak !== 'number' || !Number.isSafeInteger(streak) || streak < 0) {
    throw new RiskError('dailyStopStreak must be a whole number of at least 0');
  }
  const jumpPending = flag('jumpPending', s.jumpPending);
  const jumpHeld = checkHeld(s.jumpHeld);
  if (jumpPending !== (jumpHeld !== null)) {
    throw new RiskError('a held jump needs its held observation, and an observation is held only while a jump is');
  }
  return Object.freeze({
    day: optionalDay('state day', s.day),
    dayStart: amount('dayStart', s.dayStart) as Lamports,
    lastEquity: amount('lastEquity', s.lastEquity) as Lamports,
    peak: optionalAmount('peak', s.peak) as Lamports | null,
    jumpPending,
    jumpHeld,
    jumpAck: checkAck(s.jumpAck),
    dailyStopDay: optionalDay('dailyStopDay', s.dailyStopDay),
    dailyStopStreak: streak,
    streakHalt: flag('streakHalt', s.streakHalt),
  });
}

interface CheckedPolicy {
  readonly dailyStopBps: bigint;
  readonly peakHaltBps: bigint;
  readonly sanityMax: bigint;
  readonly bankrollCap: bigint;
  readonly jumpBps: bigint;
}

function checkPolicy(input: EquityPolicy): CheckedPolicy {
  const p = object('policy', input);
  const sanityMax = amount('sanityMaxLamports', p.sanityMaxLamports);
  const bankroll = amount('bankrollLamports', p.bankrollLamports);
  if (sanityMax < 1n || sanityMax > HARD_SANITY_MAX) {
    throw new RiskError('sanityMaxLamports must be from 1 lamport to 2.0 SOL');
  }
  if (bankroll < 1n) {
    throw new RiskError('bankrollLamports must be positive');
  }
  return {
    dailyStopBps: BigInt(threshold('dailyStopBps', p.dailyStopBps, HARD_DAILY_STOP_BPS)),
    peakHaltBps: BigInt(threshold('peakHaltBps', p.peakHaltBps, HARD_PEAK_HALT_BPS)),
    sanityMax,
    bankrollCap: bankroll * BigInt(threshold('sanityBankrollMultiple', p.sanityBankrollMultiple, HARD_SANITY_MULTIPLE)),
    jumpBps: BigInt(threshold('jumpBps', p.jumpBps, HARD_JUMP_BPS)),
  };
}

interface CheckedObservation {
  readonly now: number;
  readonly equity: bigint | null;
  readonly stopEquity: bigint | null;
  readonly anHourAgo: bigint | null;
}

function checkObservation(input: EquityObservation): CheckedObservation {
  const o = object('observation', input);
  const now = o.now; // each field is read once
  if (!isTimestamp(now)) {
    throw new RiskError('now must be a UTC millisecond timestamp up to the year 2200');
  }
  const equity = optionalAmount('equity', o.equity);
  const stopEquity = optionalAmount('stopEquity', o.stopEquity);
  const anHourAgo = optionalAmount('equityAnHourAgo', o.equityAnHourAgo);
  if (equity !== null && stopEquity !== null && stopEquity > equity) {
    throw new RiskError('the stop equity cannot be above the equity');
  }
  return { now, equity, stopEquity, anHourAgo };
}

// ---------------------------------------------------------------- the state machine

const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/** The state before anything was observed. */
export function emptyEquityState(): EquityState {
  return Object.freeze({
    day: null,
    dayStart: 0n as Lamports,
    lastEquity: 0n as Lamports,
    peak: null,
    jumpPending: false,
    jumpHeld: null,
    jumpAck: null,
    dailyStopDay: null,
    dailyStopStreak: 0,
    streakHalt: false,
  });
}

/**
 * The equity a rise is measured from in the jump test: the snapshot from an hour ago, or, for one
 * hour after the engine confirmed a jump, the higher of that and the verified level. An ack from
 * the future (the clock stepped back) is ignored, which only makes the test stricter.
 */
function jumpReference(ack: EquityState['jumpAck'], now: number, anHourAgo: bigint | null): bigint | null {
  const verified = ack !== null && now >= ack.at && now - ack.at < HOUR_MS ? ack.equity : null;
  if (verified === null) {
    return anHourAgo;
  }
  return anHourAgo === null ? verified : max(anHourAgo, verified);
}

/** current is at least `rate` bps below `base`: exact integer math, no rounding in the bot's favour. */
const fellBy = (base: bigint, current: bigint, rate: bigint): boolean => current < base && (base - current) * 10_000n >= rate * base;

/** Accepts an observation: rolls the day, sets the baseline, raises the peak, follows the last equity. */
function accept(s: EquityState, equity: bigint, today: string): EquityState {
  let dayStart: bigint;
  if (s.day === null) {
    dayStart = equity;
  } else if (s.day < today) {
    dayStart = s.lastEquity > 0n ? max(s.lastEquity, equity) : equity;
  } else if (s.dayStart > 0n) {
    dayStart = s.dayStart;
  } else {
    dayStart = s.lastEquity > 0n ? max(s.lastEquity, equity) : equity; // an exit was counted first
  }
  return Object.freeze({
    ...s,
    day: today,
    dayStart: dayStart as Lamports,
    lastEquity: equity as Lamports,
    peak: (s.peak === null ? equity : max(s.peak, equity)) as Lamports,
  });
}

/** Records one observation and returns the next state and the trips it caused. */
export function observeEquity(stateInput: EquityState, observation: EquityObservation, policyInput: EquityPolicy): EquityResult {
  const state = checkState(stateInput);
  const policy = checkPolicy(policyInput);
  const { now, equity, stopEquity, anHourAgo } = checkObservation(observation);
  const today = athensDay(now);
  const trips: EquityTrip[] = [];

  if (state.day !== null && state.day > today) {
    return Object.freeze({ state, trips: Object.freeze(['clock-backwards'] as EquityTrip[]) });
  }

  let next = state;
  if (equity !== null) {
    const anomalies: EquityTrip[] = [];
    if (equity === 0n) {
      anomalies.push('equity-zero');
    }
    if (equity > policy.sanityMax) {
      anomalies.push('sanity-max');
    }
    if (equity > policy.bankrollCap) {
      anomalies.push('sanity-bankroll');
    }
    if (anomalies.length > 0) {
      return Object.freeze({ state, trips: Object.freeze(anomalies) });
    }
    const reference = jumpReference(state.jumpAck, now, anHourAgo);
    const jumped = state.jumpPending || (reference !== null && equity * 10_000n > reference * (10_000n + policy.jumpBps));
    if (jumped) {
      trips.push('equity-jump'); // held: nothing moves until the engine verifies the rise
      // the latest held observation is remembered: a confirmation is tied to it
      next = Object.freeze({ ...state, jumpPending: true, jumpHeld: Object.freeze({ equity: equity as Lamports, at: now }) });
    } else {
      next = accept(state, equity, today);
    }
  }

  const stop = stopEquity ?? equity;
  if (stop !== null && next.day === today && next.dayStart > 0n && fellBy(next.dayStart, stop, policy.dailyStopBps)) {
    trips.push('daily-stop');
    if (next.dailyStopDay !== today) {
      const consecutive = next.dailyStopDay !== null && next.dailyStopDay === previousDay(today);
      const streak = consecutive ? next.dailyStopStreak + 1 : 1;
      // Two days in a row is a halt for the owner. It is sticky: the streak itself restarts on a
      // gap, but only the owner lifts the halt.
      next = Object.freeze({ ...next, dailyStopDay: today, dailyStopStreak: streak, streakHalt: next.streakHalt || streak >= 2 });
    }
  }
  if (next.streakHalt) {
    trips.push('daily-stop-twice'); // level-triggered: on every observation until the owner resumes
  }
  if (stop !== null && next.peak !== null && next.peak > 0n && fellBy(next.peak, stop, policy.peakHaltBps)) {
    trips.push('peak-halt');
  }
  return Object.freeze({ state: next, trips: Object.freeze(trips) });
}

/** A confirmation must come this soon after the latest held observation (else observe again first). */
const CONFIRM_WINDOW_MS = 5 * 60_000;

/**
 * The engine verified a held +50% jump against the chain, from a fresh, fully valued read (never
 * the held observation itself). The recorded reference is the LOWER of the verified level and what
 * the latest held observation saw, so a confirmation can never vouch for more than was observed
 * (it still clears after a pump that collapses: the verified level is then the lower one). It is the
 * reference for the next hour, so the same rise cannot hold again while the hour-ago snapshot is
 * still from before it; from the next observation the baseline and the peak may move. The verified
 * level must be one the sanity limits accept, and the confirmation must follow the latest held
 * observation by at most 5 minutes (never precede it): otherwise observe again first. A
 * confirmation with no held jump is an engine bug. All of these fail closed.
 */
export function confirmEquityJump(stateInput: EquityState, verifiedEquity: Lamports, now: number, policyInput: EquityPolicy): EquityState {
  const state = checkState(stateInput);
  const policy = checkPolicy(policyInput);
  const held = state.jumpHeld;
  if (!state.jumpPending || held === null) {
    throw new RiskError('there is no held equity jump to confirm');
  }
  const level = amount('verifiedEquity', verifiedEquity);
  if (level > policy.sanityMax || level > policy.bankrollCap) {
    throw new RiskError('the verified equity is above the sanity limits');
  }
  if (!isTimestamp(now) || now < held.at || now - held.at > CONFIRM_WINDOW_MS) {
    throw new RiskError('a confirmation must follow the latest held observation by at most 5 minutes: observe again first');
  }
  const ack = checkAck({ equity: (level < held.equity ? level : held.equity) as Lamports, at: now });
  return Object.freeze({ ...state, jumpPending: false, jumpHeld: null, jumpAck: ack });
}

/**
 * A confirmed deposit (positive) or withdrawal (negative): baseline, peak and last equity move by
 * exactly that amount (RISK_POLICY.md s.4). A withdrawal larger than the last known equity cannot
 * be real and would wipe the baseline, so it fails closed; so does a result beyond 2^64 - 1. A
 * baseline or peak a withdrawal takes to zero is reset; a peak at zero is no peak.
 */
export function applyTransfer(stateInput: EquityState, delta: SignedLamports): EquityState {
  const state = checkState(stateInput);
  if (typeof delta !== 'bigint' || delta > U64_MAX || delta < -U64_MAX) {
    throw new RiskError('a transfer must be a signed bigint within 2^64 - 1');
  }
  if (delta < 0n && -delta > state.lastEquity) {
    throw new RiskError('a withdrawal larger than the last known equity: reconcile before going on');
  }
  const move = (value: bigint): bigint => {
    const moved = value + delta;
    if (moved > U64_MAX) {
      throw new RiskError('a deposit would take the equity beyond 2^64 - 1');
    }
    return moved > 0n ? moved : 0n;
  };
  const peak = state.peak === null ? null : move(state.peak);
  return Object.freeze({
    ...state,
    dayStart: move(state.dayStart) as Lamports,
    lastEquity: move(state.lastEquity) as Lamports,
    peak: (peak === null || peak === 0n ? null : peak) as Lamports | null,
  });
}

/**
 * The owner's /resume after a peak halt: the peak restarts at the last accepted equity, which is
 * fully valued and sanity-checked by construction. No caller can supply a value of its own (a tiny
 * wrong one would weaken the halt). It needs a known equity above zero and no held jump (a hold
 * means the last equity is in doubt). Nothing else changes.
 */
export function resumePeak(stateInput: EquityState): EquityState {
  const state = checkState(stateInput);
  if (state.jumpPending) {
    throw new RiskError('resolve the held equity jump before restarting the peak');
  }
  if (state.lastEquity < 1n) {
    throw new RiskError('the peak can only restart at a known equity above zero');
  }
  return Object.freeze({ ...state, peak: state.lastEquity });
}

/**
 * The owner's /resume after two daily stops in a row: the halt is lifted and the streak starts
 * again. Nothing else changes (today's daily stop still holds until midnight).
 */
export function resumeStreak(stateInput: EquityState): EquityState {
  return Object.freeze({ ...checkState(stateInput), dailyStopStreak: 0, streakHalt: false });
}

/**
 * Entries are blocked for the rest of the Athens day on which a daily stop tripped. If the clock
 * reads earlier than that (it stepped back), the stop still holds; and while the clock reads
 * earlier than the last observation's day entries stay blocked too, until the next observation
 * reports the clock problem.
 */
export function dailyStopActive(stateInput: EquityState, now: number): boolean {
  const state = checkState(stateInput);
  if (!isTimestamp(now)) {
    throw new RiskError('now must be a UTC millisecond timestamp up to the year 2200');
  }
  const today = athensDay(now);
  return (state.dailyStopDay !== null && state.dailyStopDay >= today) || (state.day !== null && state.day > today);
}
