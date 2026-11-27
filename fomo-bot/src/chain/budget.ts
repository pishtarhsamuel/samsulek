// The budget governor (docs/CHAIN_DESIGN.md s.6; ARCHITECTURE s.6): every request to a provider asks it
// first, so the bot stays well under the public endpoint's limits and exits, prices, confirmations and
// reconciliation (P0) always find room. Sliding-window logs, not token buckets (R2): no window of any
// alignment holds more than its cap. Buckets: each method and the total per 10 s, decoded bytes per
// 30 s (a grant reserves its method's byte cap until it settles, R12), and requests in flight (R13).
// A non-P0 grant must leave every bucket's P0 reserve free; P0 may use the whole cap. Data has two parts:
// P0's own bytes, and the shared part (non-P0 bytes and the stream's, which arrive unasked). For P0 the
// shared part counts at most the cap minus P0's reserve, so no stream flood and no other priority can
// ever take P0's reserve (review Y, risk 1); `chargeStream` says when the stream is over its share, so
// the stream can shed. What the provider
// says is learned only downward: header limits lower a cap, a 429 closes a method for its Retry-After
// and raises the shed level, a 403 blocks the provider until one P0 probe succeeds. No timers: it reads
// the injected monotonic clock on each call (held at its last reading if it ever steps back), so a test
// drives time by hand. Events carry codes, the provider's code, a method and a priority only. Pure.
import type { MonoClock } from '../core/clock.ts';
import type { ChainEvent, ChainEventCode, ChainEvents } from './events.ts';
import { BUDGET_RULES, METHOD_TABLE, PRIORITIES, REFUSED_METHODS, type Priority, type ProviderId, type ReadMethod } from './limits.ts';

export type ShedLevel = 0 | 1 | 2 | 3;
export type DenyReason = 'refused-method' | 'shed' | 'method-cap' | 'total-cap' | 'data-cap' | 'connections' | 'retry-after' | 'blocked' | 'clock';

/** Opaque and single use: only the governor that gave it can settle it. */
export interface Ticket {
  readonly __ticket: 'budget-ticket';
}

export type Grant = { readonly ok: true; readonly ticket: Ticket } | { readonly ok: false; readonly reason: DenyReason; readonly retryAtMs: number };

/** Parsed by chain/http.ts from digits only (else null); the governor treats anything else as missing. */
export interface RateHeaders {
  readonly methodLimit: number | null;
  readonly methodRemaining: number | null;
  readonly retryAfterSec: number | null;
}

export interface Settlement {
  /** The bytes read after decoding (gzip included). */
  readonly decodedBytes: number;
  /** The HTTP status, or null when there was no answer (a timeout, a transport failure). */
  readonly status: number | null;
  readonly rate: RateHeaders | null;
}

export type BucketName = 'total' | 'data' | 'connections' | ReadMethod;

export interface BucketUsage {
  readonly bucket: BucketName;
  readonly used: number;
  readonly cap: number;
}

export interface BudgetGovernor {
  /** One request: one connection slot, the method's byte cap reserved. */
  acquire(method: ReadMethod, p: Priority): Grant;
  settle(t: Ticket, s: Settlement): void;
  /** WebSocket bytes, charged after receipt; true when the shared part is over its share (the stream should shed). */
  chargeStream(bytes: number): boolean;
  shedLevel(): ShedLevel;
  usage(): readonly BucketUsage[];
}

/** Only tighter than BUDGET_RULES (a test reaches the total and data caps with them). */
export interface Tightening {
  readonly totalCap?: number;
  readonly totalP0Reserve?: number;
  readonly dataCapBytes?: number;
  readonly dataP0ReserveBytes?: number;
}

const R = BUDGET_RULES;

function tightened(t: Tightening | undefined): { totalCap: number; totalP0Reserve: number; dataCapBytes: number; dataP0ReserveBytes: number } {
  const pick = (name: keyof Tightening, base: number): number => {
    const v = t?.[name];
    if (v === undefined) {
      return base;
    }
    if (!Number.isInteger(v) || v < 0 || v > base) {
      throw new TypeError(`${name} may only be tightened: a whole number from 0 to ${base}`);
    }
    return v;
  };
  const limits = {
    totalCap: pick('totalCap', R.totalCap),
    totalP0Reserve: pick('totalP0Reserve', R.totalP0Reserve),
    dataCapBytes: pick('dataCapBytes', R.dataCapBytes),
    dataP0ReserveBytes: pick('dataP0ReserveBytes', R.dataP0ReserveBytes),
  };
  if (limits.totalP0Reserve > limits.totalCap || limits.dataP0ReserveBytes > limits.dataCapBytes) {
    throw new TypeError('a P0 reserve is never above its cap');
  }
  return limits;
}

const RANK: Readonly<Record<Priority, number>> = Object.freeze({ P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 });

/** Level 1 sheds P4, level 2 also P3, level 3 also P2; P0 and P1 never. */
const isShed = (p: Priority, level: ShedLevel): boolean => RANK[p] >= 2 && RANK[p] >= 5 - level;

interface MethodState {
  /** Grant times in the window, oldest first. */
  readonly log: number[];
  /** Only ever lowered (by a header limit), never raised within the process. */
  cap: number;
  reserve: number;
  /** Closed by a 429's Retry-After or a remaining count at zero, until this time. */
  closedUntil: number;
}

interface Outstanding {
  readonly method: ReadMethod;
  readonly reserved: number;
  readonly probe: boolean;
  /** Its bytes are P0's own (true) or the shared part's (false). */
  readonly p0: boolean;
}

/** Settled or streamed bytes in the data window: P0's own, or the shared part's. */
interface DataEntry {
  readonly at: number;
  readonly bytes: number;
  readonly p0: boolean;
}

/** The data window's two parts, reservations included. */
interface DataParts {
  readonly p0: number;
  readonly shared: number;
}

/** One governor per provider. */
export function createBudgetGovernor(o: { readonly provider: ProviderId; readonly mono: MonoClock; readonly events: ChainEvents; readonly tighten?: Tightening }): BudgetGovernor {
  const limits = tightened(o.tighten);
  const methods = new Map<ReadMethod, MethodState>(
    (Object.keys(METHOD_TABLE) as ReadMethod[]).map((m) => [m, { log: [], cap: METHOD_TABLE[m].capPer10s, reserve: METHOD_TABLE[m].p0Reserve, closedUntil: 0 }]),
  );
  const total: number[] = [];
  /** Settled and streamed bytes in the data window, oldest first. */
  const data: DataEntry[] = [];
  const reserved = { p0: 0, shared: 0 };
  /** The most the shared part may hold, and the most of it that counts against P0. */
  const sharedLimit = limits.dataCapBytes - limits.dataP0ReserveBytes;
  const outstanding = new Map<Ticket, Outstanding>();
  let blockedUntil = 0;
  let blocked = false;
  let probeInFlight = false;
  let level: ShedLevel = 0;
  let lastTriggerMs = 0;
  let busySince: number | null = null;
  let lastNow = Number.NEGATIVE_INFINITY;

  const emit = (code: ChainEventCode, extra: { readonly method?: ReadMethod; readonly priority?: Priority } = {}): void => {
    const e: ChainEvent = Object.freeze({ code, provider: o.provider, ...extra });
    try {
      o.events.event(e);
    } catch {
      // the sink's failure is the sink's: a read never stops for it
    }
  };

  /** The clock, held at its last reading if it steps back, so no grant ever ages out early. */
  const tick = (): number => {
    const raw = o.mono.nowMs();
    lastNow = Number.isFinite(raw) && raw > lastNow ? raw : lastNow;
    return lastNow;
  };

  const prune = (log: number[], now: number, windowMs: number): void => {
    while (log.length > 0 && (log[0] as number) <= now - windowMs) {
      log.shift();
    }
  };

  const dataParts = (now: number): DataParts => {
    while (data.length > 0 && (data[0] as DataEntry).at <= now - R.dataWindowMs) {
      data.shift();
    }
    let p0 = reserved.p0;
    let shared = reserved.shared;
    for (const d of data) {
      if (d.p0) {
        p0 += d.bytes;
      } else {
        shared += d.bytes;
      }
    }
    return { p0, shared };
  };

  const dataUsed = (now: number): number => {
    const d = dataParts(now);
    return d.p0 + d.shared;
  };

  /** What a grant at this priority sees as used: for P0, the shared part counts at most its share. */
  const dataSeen = (d: DataParts, p0: boolean): number => (p0 ? d.p0 + Math.min(d.shared, sharedLimit) : d.p0 + d.shared);

  const raise = (now: number): void => {
    lastTriggerMs = now;
    if (level < R.maxShed) {
      level = (level + 1) as ShedLevel;
      emit('chain-shed-up');
    }
  };

  /** The shed level's decay (one step per shedDecayMs without a trigger) and the 80% rule. */
  const housekeep = (now: number): void => {
    while (level > 0 && now - lastTriggerMs >= R.shedDecayMs) {
      level = (level - 1) as ShedLevel;
      lastTriggerMs += R.shedDecayMs;
      emit('chain-shed-down');
    }
    prune(total, now, R.windowMs);
    let busy = total.length > R.busyRatio * limits.totalCap || dataUsed(now) > R.busyRatio * limits.dataCapBytes || outstanding.size > R.busyRatio * R.maxInFlight;
    for (const [m, s] of methods) {
      prune(s.log, now, R.windowMs);
      // a method whose whole table cap is P0's (getSlot's 2 s polling, risk A) is busy by design: never a
      // reason to shed; one learned down to its reserve still counts (review Y, risk 5)
      const rule = METHOD_TABLE[m];
      busy ||= rule.capPer10s > rule.p0Reserve && s.log.length > R.busyRatio * s.cap;
    }
    if (!busy) {
      busySince = null;
    } else if (busySince === null) {
      busySince = now;
    } else if (now - busySince >= R.busyHoldMs) {
      emit('chain-budget-80');
      raise(now);
      busySince = now;
    }
  };

  /** When a log would have room for one more under `limit`, or never. */
  const roomAt = (log: readonly number[], limit: number): number => {
    if (limit <= 0) {
      return Number.POSITIVE_INFINITY;
    }
    return (log[log.length - limit] as number) + R.windowMs;
  };

  /** When a grant of `need` bytes would fit: entries age out oldest first; never if it cannot fit at all. */
  const dataRoomAt = (now: number, need: number, limit: number, p0: boolean): number => {
    if (need > limit) {
      return Number.POSITIVE_INFINITY;
    }
    const left = { ...dataParts(now) };
    for (const d of data) {
      if (d.p0) {
        left.p0 -= d.bytes;
      } else {
        left.shared -= d.bytes;
      }
      if (dataSeen(left, p0) + need <= limit) {
        return d.at + R.dataWindowMs;
      }
    }
    return now + 1_000; // only reservations stand in the way: a settle frees them
  };

  const deny = (reason: DenyReason, retryAtMs: number, method: ReadMethod, p: Priority): Grant => {
    if (p === 'P0') {
      emit('chain-p0-denied', { method, priority: p });
    }
    return Object.freeze({ ok: false, reason, retryAtMs });
  };

  const acquire = (method: ReadMethod, p: Priority): Grant => {
    if (!PRIORITIES.includes(p)) {
      throw new TypeError('a priority is P0 to P4');
    }
    const now = tick();
    if (!Number.isFinite(now)) {
      // no finite reading yet: no window can be counted, so nothing is granted (review Y, risk 7)
      return deny('clock', Number.POSITIVE_INFINITY, method, p);
    }
    housekeep(now);
    const s = Object.hasOwn(METHOD_TABLE, method) && !REFUSED_METHODS.includes(method) ? methods.get(method) : undefined;
    if (s === undefined || RANK[p] < RANK[METHOD_TABLE[method].mostUrgent] || s.cap === 0) {
      return deny('refused-method', Number.POSITIVE_INFINITY, method, p);
    }
    let probe = false;
    if (blocked) {
      if (now < blockedUntil) {
        return deny('blocked', blockedUntil, method, p);
      }
      if (p !== 'P0' || probeInFlight) {
        return deny('blocked', now + 1_000, method, p);
      }
      probe = true; // the one P0 request that may find the provider open again
    }
    if (s.closedUntil > now) {
      return deny('retry-after', s.closedUntil, method, p);
    }
    if (isShed(p, level)) {
      return deny('shed', lastTriggerMs + R.shedDecayMs, method, p);
    }
    const p0 = p === 'P0';
    const methodLimit = p0 ? s.cap : s.cap - s.reserve;
    if (s.log.length + 1 > methodLimit) {
      return deny('method-cap', roomAt(s.log, methodLimit), method, p);
    }
    const totalLimit = p0 ? limits.totalCap : limits.totalCap - limits.totalP0Reserve;
    if (total.length + 1 > totalLimit) {
      return deny('total-cap', roomAt(total, totalLimit), method, p);
    }
    const need = METHOD_TABLE[method].maxResponseBytes;
    const dataLimit = p0 ? limits.dataCapBytes : sharedLimit;
    if (dataSeen(dataParts(now), p0) + need > dataLimit) {
      return deny('data-cap', dataRoomAt(now, need, dataLimit, p0), method, p);
    }
    const inFlightLimit = p0 ? R.maxInFlight : R.maxInFlight - R.inFlightP0Reserve;
    if (outstanding.size + 1 > inFlightLimit) {
      return deny('connections', now + 1_000, method, p);
    }
    s.log.push(now);
    total.push(now);
    if (p0) {
      reserved.p0 += need;
    } else {
      reserved.shared += need;
    }
    if (probe) {
      probeInFlight = true;
    }
    const ticket: Ticket = Object.freeze({ __ticket: 'budget-ticket' });
    outstanding.set(ticket, Object.freeze({ method, reserved: need, probe, p0 }));
    return Object.freeze({ ok: true, ticket });
  };

  const wholeFrom = (v: number | null | undefined, min: number): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= min ? v : null);

  const settle = (t: Ticket, st: Settlement): void => {
    if (!Number.isInteger(st.decodedBytes) || st.decodedBytes < 0) {
      throw new TypeError('decodedBytes is a whole number from 0');
    }
    if (st.status !== null && (!Number.isInteger(st.status) || st.status < 100 || st.status > 599)) {
      throw new TypeError('status is an HTTP status from 100 to 599, or null');
    }
    const now = tick();
    const out = outstanding.get(t);
    if (out === undefined) {
      emit('chain-ticket-bug');
      return;
    }
    outstanding.delete(t);
    if (out.p0) {
      reserved.p0 -= out.reserved;
    } else {
      reserved.shared -= out.reserved;
    }
    data.push({ at: now, bytes: st.decodedBytes, p0: out.p0 });
    const s = methods.get(out.method) as MethodState;
    const limit = wholeFrom(st.rate?.methodLimit, 0);
    if (limit !== null) {
      // half the provider's limit, and only ever downward: a higher limit later changes nothing
      const cap = Math.min(METHOD_TABLE[out.method].capPer10s, Math.floor(limit / 2));
      if (cap < s.cap) {
        s.cap = cap;
        s.reserve = Math.min(s.reserve, cap);
        emit('chain-limit-learned', { method: out.method });
        if (cap === 0 && METHOD_TABLE[out.method].mostUrgent === 'P0') {
          emit('chain-p0-blind', { method: out.method });
        }
      }
    }
    const remaining = st.rate?.methodRemaining;
    if (typeof remaining === 'number' && remaining <= 0) {
      const newest = s.log[s.log.length - 1];
      s.closedUntil = Math.max(s.closedUntil, (newest ?? now) + R.windowMs);
    }
    if (st.status === 429) {
      const after = wholeFrom(st.rate?.retryAfterSec, 0);
      const waitMs = after === null ? R.retryAfterDefaultMs : Math.min(Math.max(after * 1_000, R.retryAfterMinMs), R.retryAfterMaxMs);
      s.closedUntil = Math.max(s.closedUntil, now + waitMs);
      emit('chain-429', { method: out.method });
      raise(now);
    }
    if (st.status === 403) {
      blocked = true;
      blockedUntil = now + R.blockMs;
      probeInFlight = false;
      emit('chain-blocked');
    } else if (out.probe) {
      probeInFlight = false;
      if (st.status === 200) {
        blocked = false;
        emit('chain-unblocked');
      }
    }
    housekeep(now);
  };

  const chargeStream = (bytes: number): boolean => {
    if (!Number.isInteger(bytes) || bytes < 0) {
      throw new TypeError('stream bytes are a whole number from 0');
    }
    const now = tick();
    data.push({ at: now, bytes, p0: false }); // the shared part: never P0's reserve
    housekeep(now);
    return dataParts(now).shared > sharedLimit;
  };

  const shedLevel = (): ShedLevel => {
    housekeep(tick());
    return level;
  };

  const usage = (): readonly BucketUsage[] => {
    const now = tick();
    housekeep(now);
    const rows: BucketUsage[] = [
      { bucket: 'total', used: total.length, cap: limits.totalCap },
      { bucket: 'data', used: dataUsed(now), cap: limits.dataCapBytes },
      { bucket: 'connections', used: outstanding.size, cap: R.maxInFlight },
    ];
    for (const [m, s] of methods) {
      rows.push({ bucket: m, used: s.log.length, cap: s.cap });
    }
    return Object.freeze(rows.map((r) => Object.freeze(r)));
  };

  return Object.freeze({ acquire, settle, chargeStream, shedLevel, usage });
}
