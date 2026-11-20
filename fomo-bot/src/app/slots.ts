// The slot feed (STORAGE_DESIGN.md s.16.7.3 and s.16.14; reviews K, N and T): the bot's view of the
// chain's current slot, bound into the approval authority as its SlotSource, so no executor can pass a
// slot of its own. Channels report what they see (the stream, HTTP, a second provider in Phase 8).
// Once anchored, a higher reading is adopted when it fits the advance budget (at most toleranceSlots
// at once, refilled at maxSlotsPerSecond and never above toleranceSlots, so over any window W the
// slot moves at most toleranceSlots + rate x W: the tolerance does not compound, review T risk 1) and
// is no more than agreeSlots above another channel's fresh reading; or when another channel, also
// above the accepted slot, agrees within agreeSlots. At a cold start two channels must agree, or one
// channel must give two consistent readings 500 ms to 5 s apart while no other fresh channel
// disagrees, so a lone wild reading is never adopted. Equal or lower readings change nothing (they
// neither raise the slot nor refresh its age). The slot is unknown (null) before the first accepted
// reading, when the last one is older than maxAgeMs, and when it advanced by less than 1 slot a second
// over 5 s or more (a slow or lagging source would otherwise keep old tokens alive, review T security
// 1). A clock that steps back, and 15 s of unknown, restart the cold start (review T risk 2). Alerts:
// slot-malformed, slot-implausible, slot-disagree, slot-behind (a channel far below the accepted
// slot), slot-slow, slot-clock-back, at most once a minute each. report, currentSlot and
// unknownSinceMs never throw.
// Limits, written down: the feed trusts what its channels agree on. One channel alone, at a cold
// start, or two channels that lie together, can move it ahead; tokens then expire early, exits
// included, and the authority's ratchet keeps the higher slot until a restart: a loss of liveness
// that slot-behind reports, never a token that outlives its expiry. A source can also hold the slot
// back within the floor of 1 slot a second; T2 refuses a token used more than 15 s after its issue
// (storage/repo-redeem.ts), which bounds that.
import { HARD_CAPS } from '../config/caps.ts';
import type { SlotSource } from '../risk/approval.ts';
import type { AlertSink } from './faults.ts';

/** UTC milliseconds; the guarded clock of contract 8 comes later. */
export interface Clock {
  now(): number;
}

export type SlotChannel = 'stream' | 'http' | 'http-2';

export interface SlotFeedOptions {
  readonly clock: Clock;
  /** 1 to MAX_SLOT_AGE_MS. */
  readonly maxAgeMs: number;
  /** 1 to 50: the fastest the chain is believed to move (measured about 4.7, VERIFIED_FACTS s.4). */
  readonly maxSlotsPerSecond: number;
  /** 0 to 1,000: the advance budget's size, the most the slot moves at once. */
  readonly toleranceSlots: number;
  /** 0 to 1,000: two channels agree when this close; no reading leads a fresh channel by more. */
  readonly agreeSlots: number;
  readonly alerts: AlertSink;
}

export interface SlotFeed extends SlotSource {
  /** Never throws; a malformed or implausible reading is ignored and counted. */
  report(channel: SlotChannel, slot: unknown): void;
  /** Since when currentSlot() has been null, or null while it is known (review N risk 3). */
  unknownSinceMs(): number | null;
}

export const MAX_SLOT_AGE_MS = 2_500;
export const SLOT_FEED_DEFAULTS = Object.freeze({ maxAgeMs: 2_000, maxSlotsPerSecond: 10, toleranceSlots: 150, agreeSlots: 150 });
/** The feed's fixed rules (exported for the tests and the docs). */
export const SLOT_FEED_RULES = Object.freeze({
  /** A cold start from one channel: two consistent readings at least this far apart... */
  coldGapMs: 500,
  /** ...and at most this far apart: an older base no longer counts (review T risk 1d). */
  coldBaseMaxMs: 5_000,
  /** Unknown this long: back to a cold start, so one channel can recover the slot after an outage. */
  coldResetMs: 15_000,
  /** The floor: at least this many slots a second over each window... */
  minSlotsPerSecond: 1,
  /** ...of at least this long (review T security 1b). */
  rateWindowMs: 5_000,
  /** A channel this many slots below the accepted slot (a token's life)... */
  behindSlots: HARD_CAPS.planFreshSlots,
  /** ...for this long, or more than agreeSlots below at once: slot-behind (review T risk 1c, security 4). */
  behindMs: 10_000,
  alertEveryMs: 60_000,
});

const CHANNELS: readonly string[] = Object.freeze(['stream', 'http', 'http-2']);
const MAX_SLOT = (1n << 63n) - 1n;
const R = SLOT_FEED_RULES;

interface Reading {
  readonly slot: bigint;
  readonly at: number;
}

const wholeIn = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= lo && v <= hi;
const hasFn = (v: unknown, member: string): boolean => typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>)[member] === 'function';
const gap = (a: bigint, b: bigint): bigint => (a > b ? a - b : b - a);

export function createSlotFeed(o: SlotFeedOptions): SlotFeed {
  const { clock, alerts, maxAgeMs, maxSlotsPerSecond, toleranceSlots, agreeSlots } = o;
  if (
    !hasFn(clock, 'now') ||
    !hasFn(alerts, 'alert') ||
    !wholeIn(maxAgeMs, 1, MAX_SLOT_AGE_MS) ||
    !wholeIn(maxSlotsPerSecond, 1, 50) ||
    !wholeIn(toleranceSlots, 0, 1_000) ||
    !wholeIn(agreeSlots, 0, 1_000)
  ) {
    throw new TypeError(`a slot feed needs a clock, an alert sink, maxAgeMs 1 to ${MAX_SLOT_AGE_MS}, maxSlotsPerSecond 1 to 50, toleranceSlots and agreeSlots 0 to 1,000`);
  }
  const agree = BigInt(agreeSlots);
  const createdAt = clock.now();
  if (!Number.isSafeInteger(createdAt)) {
    throw new TypeError('a slot feed needs a clock that gives whole milliseconds');
  }
  let accepted: Reading | null = null;
  /** The advance budget, in slots: an adopted advance spends it; it refills at the rate, up to toleranceSlots. */
  let budget = toleranceSlots;
  let budgetAt = createdAt;
  /** The start of the current rate window (the floor). */
  let rateBase: Reading | null = null;
  let unknownSince: number | null = createdAt;
  let lastNow = createdAt;
  /** Each channel's newest reading: agreement, the lead cap and the behind alert use it. */
  const latest = new Map<string, Reading>();
  /** Cold start only: each channel's base reading for the two-reading rule. */
  const base = new Map<string, Reading>();
  const behindSince = new Map<string, number>();
  const lastAlert = new Map<string, number>();

  const warn = (code: string, now: number): void => {
    const last = lastAlert.get(code);
    // once a minute; and while the clock gives no whole milliseconds, not again at all
    if (last !== undefined && (!Number.isSafeInteger(now) || (now >= last && now - last < R.alertEveryMs))) {
      return;
    }
    lastAlert.set(code, now);
    try {
      alerts.alert(Object.freeze({ code, severity: 'warn' }));
    } catch {
      // the alert sink is outside the database and must not stop the feed
    }
  };

  const fresh = (r: Reading, now: number): boolean => now >= r.at && now - r.at <= maxAgeMs;

  /** The accepted slot rose by less than the floor over a window of at least 5 s. */
  const slowAt = (now: number): boolean =>
    accepted !== null && rateBase !== null && now - rateBase.at >= R.rateWindowMs && (accepted.slot - rateBase.slot) * 1_000n < BigInt(R.minSlotsPerSecond) * BigInt(Math.trunc(now - rateBase.at));

  const knownAt = (now: number): boolean => accepted !== null && fresh(accepted, now) && !slowAt(now);

  /** Back to a cold start: nothing accepted, every channel's reading dropped, a full budget. */
  const restart = (now: number): void => {
    accepted = null;
    rateBase = null;
    latest.clear();
    base.clear();
    behindSince.clear();
    budget = toleranceSlots;
    budgetAt = now;
  };

  /** First of every call: a clock that stepped back, the unknown time, and 15 s of unknown. */
  const tick = (now: number): void => {
    if (now < lastNow) {
      restart(now);
      unknownSince = now;
      warn('slot-clock-back', now);
    }
    lastNow = now;
    if (knownAt(now)) {
      unknownSince = null;
      return;
    }
    if (unknownSince === null) {
      unknownSince = accepted !== null && now - accepted.at > maxAgeMs ? accepted.at + maxAgeMs + 1 : now;
      if (slowAt(now)) {
        warn('slot-slow', now);
      }
    }
    if (accepted !== null && now - unknownSince >= R.coldResetMs) {
      restart(now);
    }
  };

  const adopt = (slot: bigint, now: number, spend: number): void => {
    accepted = Object.freeze({ slot, at: now });
    budget = Math.max(0, budget - spend);
    base.clear();
    if (rateBase === null || (now - rateBase.at >= R.rateWindowMs && !slowAt(now))) {
      rateBase = accepted;
    }
    if (knownAt(now)) {
      unknownSince = null;
    } else {
      warn('slot-slow', now);
    }
  };

  /** Another channel's fresh reading within agreeSlots (above `floor`, when anchored): the higher of the two. */
  const partner = (channel: string, slot: bigint, now: number, floor: bigint | null): bigint | null => {
    for (const [other, r] of latest) {
      if (other !== channel && fresh(r, now) && (floor === null || r.slot > floor) && gap(r.slot, slot) <= agree) {
        return r.slot > slot ? r.slot : slot;
      }
    }
    return null;
  };

  /** Another fresh channel this reading leads by more than agreeSlots, or disagrees with (a cold start). */
  const outpaces = (channel: string, slot: bigint, now: number): boolean => [...latest].some(([other, r]) => other !== channel && fresh(r, now) && slot > r.slot + agree);
  const contested = (channel: string, slot: bigint, now: number): boolean => [...latest].some(([other, r]) => other !== channel && fresh(r, now) && gap(r.slot, slot) > agree);

  const anchoredReport = (a: Reading, channel: string, slot: bigint, now: number): void => {
    if (fresh(a, now) && slot + BigInt(R.behindSlots) < a.slot) {
      const since = behindSince.get(channel) ?? now;
      behindSince.set(channel, since);
      if (slot + agree < a.slot || now - since >= R.behindMs) {
        warn('slot-behind', now);
      }
    } else {
      behindSince.delete(channel);
    }
    if (slot <= a.slot) {
      return;
    }
    budget = Math.min(toleranceSlots, budget + ((now - budgetAt) * maxSlotsPerSecond) / 1_000);
    budgetAt = now;
    const advance = slot - a.slot;
    if (advance <= BigInt(Math.floor(budget)) && !outpaces(channel, slot, now)) {
      adopt(slot, now, Number(advance));
      return;
    }
    const both = partner(channel, slot, now, a.slot);
    if (both !== null) {
      adopt(both, now, toleranceSlots); // two channels saw the jump: it spends the whole budget
      return;
    }
    warn('slot-implausible', now);
  };

  const coldReport = (channel: string, slot: bigint, now: number): void => {
    const both = partner(channel, slot, now, null);
    if (both !== null) {
      adopt(both, now, 0);
      return;
    }
    const disputed = contested(channel, slot, now);
    if (disputed) {
      warn('slot-disagree', now);
    }
    const b = base.get(channel);
    const usable = b !== undefined && now - b.at <= R.coldBaseMaxMs;
    const bound = b === undefined ? 0n : b.slot + BigInt(Math.ceil(((now - b.at) * maxSlotsPerSecond) / 1_000)) + BigInt(toleranceSlots);
    const consistent = usable && slot >= b.slot && slot <= bound;
    if (consistent && now - b.at >= R.coldGapMs && !disputed) {
      adopt(slot, now, 0);
    } else if (!consistent) {
      base.set(channel, Object.freeze({ slot, at: now })); // a first reading, or one the next sane one replaces
    }
  };

  return Object.freeze({
    report(channel: SlotChannel, slot: unknown): void {
      try {
        const now = clock.now();
        if (!CHANNELS.includes(channel) || typeof slot !== 'bigint' || slot < 1n || slot > MAX_SLOT || !Number.isSafeInteger(now)) {
          warn('slot-malformed', now);
          return;
        }
        tick(now);
        const a = accepted;
        latest.set(channel, Object.freeze({ slot, at: now }));
        if (a !== null) {
          anchoredReport(a, channel, slot, now);
        } else {
          coldReport(channel, slot, now);
        }
      } catch {
        // a clock that throws: the reading is ignored, and the slot goes stale on its own
      }
    },
    currentSlot(): bigint | null {
      try {
        const now = clock.now();
        tick(now);
        return knownAt(now) && accepted !== null ? accepted.slot : null;
      } catch {
        return null;
      }
    },
    unknownSinceMs(): number | null {
      try {
        const now = clock.now();
        tick(now); // sets the unknown time whenever the slot is not known
        return knownAt(now) ? null : unknownSince;
      } catch {
        return createdAt;
      }
    },
  });
}
