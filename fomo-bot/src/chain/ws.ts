// The live block feed (docs/CHAIN_DESIGN.md s.7, step 7f): one WebSocket to the provider, slotSubscribe
// first, and each slotNotification of our subscription reported to the slot feed on 'stream'. The state
// machine is pure: the socket comes from an injected factory (chain/ws-socket.ts makes the real one),
// timers and the clock are injected, so a test drives it by hand.
// - Generations: every socket is one generation, and the handlers of an older one do nothing, so a close
//   that never fires (VERIFIED_FACTS s.9: after a server close frame without a TCP close it never does),
//   or fires late, changes nothing. Request ids and the subscription id map belong to one generation.
// - Timeouts: 10 s to open, 5 s for the ack, and our own watchdog (the node never pings): checked every
//   second, 5 s without a slotNotification while live is a stall. Each ends the socket without waiting
//   for its close, then backs off: jitter in [1 s, min(60 s, 2^n s)], n the failures since 60 s live.
// - Incoming: every message's length is charged to the budget after receipt (its UTF-8 bytes; an
//   oversize one at three bytes a character); over 65,536 characters it is dropped and counted; binary
//   data ends the socket; anything but our ack, our refusal or a slotNotification of exactly the
//   recorded shape is dropped and counted; a notification for a subscription this generation did not
//   map is dropped and counted (ids are node-wide). The budget says when the stream is over its share
//   of the data bucket; that is counted, and 7h's logs subscriptions are what shed then.
// - Outgoing: a client message of 4,000 UTF-8 bytes or more is our bug, never sent (the node ends the
//   connection at 4,096), and the stream stops.
// - More than 6 reconnects in 10 minutes is flapping (an event each time it crosses; entries stay off,
//   the app's). stop() is final. Events carry codes only; a failing sink never stops the stream.
import type { MonoClock, Timers } from '../core/clock.ts';
import { parseLossless, type Json } from '../core/json.ts';
import type { BudgetGovernor } from './budget.ts';
import type { SlotReporter } from './client.ts';
import type { ChainEvent, ChainEventCode, ChainEvents } from './events.ts';
import type { ProviderEndpoint } from './providers.ts';

export const STREAM_RULES = Object.freeze({
  openTimeoutMs: 10_000,
  ackTimeoutMs: 5_000,
  /** No slotNotification this long while live is a stall (the most seen apart was 495 ms, VERIFIED_FACTS s.9). */
  stallMs: 5_000,
  watchdogEveryMs: 1_000,
  maxMessageChars: 65_536,
  /** The node ends the connection at 4,096 bytes; ours stop short of it. */
  maxClientMessageBytes: 4_000,
  backoffMinMs: 1_000,
  backoffMaxMs: 60_000,
  /** Live this long, and the backoff starts again from its first step. */
  stableLiveMs: 60_000,
  /** More reconnects than this within the window is flapping. */
  flappingCount: 6,
  flappingWindowMs: 600_000,
});

export interface SocketHandlers {
  open(): void;
  message(data: unknown): void;
  closed(): void;
  error(): void;
}

export interface SocketHandle {
  /** False when the socket could not take the message. */
  send(text: string): boolean;
  /** Close and detach: no handler is called after it. */
  terminate(): void;
}

export type SocketFactory = (url: string, h: SocketHandlers) => SocketHandle;

export type StreamState = 'idle' | 'connecting' | 'subscribing' | 'live' | 'backoff' | 'stopped';

export interface StreamStats {
  readonly state: StreamState;
  readonly generation: number;
  readonly reconnects: number;
  readonly lastSlotAtMs: number | null;
  /** Messages charged while the shared part of the data bucket was over its share. */
  readonly overShare: number;
  readonly dropped: { readonly oversize: number; readonly binary: number; readonly malformed: number; readonly unknownSub: number };
}

export interface StreamClient {
  start(): void;
  stop(): void;
  state(): StreamState;
  stats(): StreamStats;
}

export interface StreamClientOptions {
  readonly endpoint: ProviderEndpoint;
  readonly socket: SocketFactory;
  readonly timers: Timers;
  readonly mono: MonoClock;
  /** [0, 1); anything else is read as 1, the longest wait (core/rng.ts unitInterval in production). */
  readonly jitter: () => number;
  readonly slots: SlotReporter;
  readonly budget: Pick<BudgetGovernor, 'chargeStream'>;
  readonly events: ChainEvents;
  /** Only tighter than STREAM_RULES.maxClientMessageBytes (a test reaches the size check with it). */
  readonly tighten?: { readonly maxClientMessageBytes?: number };
}

const R = STREAM_RULES;
const I63_MAX = (1n << 63n) - 1n;
const ENCODER = new TextEncoder();
const SUBSCRIBE_ID = 1n;
const SUBSCRIBE = '{"jsonrpc":"2.0","id":1,"method":"slotSubscribe"}';

type Obj = Readonly<Record<string, Json>>;

/** Where no socket is: takes nothing, ends nothing (one function for both). */
const nothing = (): false => false;
const NO_SOCKET: SocketHandle = Object.freeze({ send: nothing, terminate: nothing });

function exact(v: Json | undefined, keys: readonly string[]): Obj | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return null;
  }
  const o = v as Obj;
  return Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k)) ? o : null;
}

const isSlot = (v: Json | undefined): v is bigint => typeof v === 'bigint' && v >= 0n && v <= I63_MAX;

/** A slotNotification's slot and subscription, or null when it is not exactly that shape. */
function readNotification(o: Obj): { readonly slot: bigint; readonly subscription: bigint } | null {
  const top = exact(o, ['jsonrpc', 'method', 'params']);
  if (top === null || top['method'] !== 'slotNotification') {
    return null;
  }
  const params = exact(top['params'], ['result', 'subscription']);
  const result = params === null ? null : exact(params['result'], ['parent', 'root', 'slot']);
  if (params === null || result === null || typeof params['subscription'] !== 'bigint') {
    return null;
  }
  const slot = result['slot'];
  const parent = result['parent'];
  const root = result['root'];
  if (!isSlot(slot) || !isSlot(parent) || !isSlot(root) || parent >= slot || root > slot) {
    return null;
  }
  return { slot, subscription: params['subscription'] };
}

export function createStreamClient(o: StreamClientOptions): StreamClient {
  const maxClient = o.tighten?.maxClientMessageBytes ?? R.maxClientMessageBytes;
  if (!Number.isInteger(maxClient) || maxClient < 1 || maxClient > R.maxClientMessageBytes) {
    throw new TypeError(`the client message cap may only be tightened: a whole number from 1 to ${R.maxClientMessageBytes}`);
  }
  const provider = o.endpoint.id;
  let state: StreamState = 'idle';
  let generation = 0;
  let handle: SocketHandle = NO_SOCKET;
  let subscriptions = new Set<bigint>();
  let cancels: (() => void)[] = [];
  let attempt = 0;
  let liveSinceMs = 0;
  let lastSlotAtMs: number | null = null;
  /** The watchdog's reference: the ack, then each slotNotification. */
  let beatAtMs = 0;
  let reconnects = 0;
  let reconnectTimes: number[] = [];
  let flapping = false;
  let overShare = 0;
  const dropped = { oversize: 0, binary: 0, malformed: 0, unknownSub: 0 };

  const emit = (code: ChainEventCode): void => {
    const e: ChainEvent = Object.freeze({ code, provider });
    try {
      o.events.event(e);
    } catch {
      // the sink's failure is the sink's: the stream never stops for it
    }
  };

  const later = (ms: number, fn: () => void): void => {
    cancels.push(o.timers.after(ms, fn));
  };

  const clearTimers = (): void => {
    for (const c of cancels) {
      c();
    }
    cancels = [];
  };

  const endSocket = (): void => {
    const h = handle;
    handle = NO_SOCKET;
    try {
      h.terminate();
    } catch {
      // already gone: nothing left to end
    }
  };

  const backoffMs = (): number => {
    const j = o.jitter();
    const f = typeof j === 'number' && j >= 0 && j < 1 ? j : 1; // a bad jitter waits the longest
    const top = Math.min(R.backoffMaxMs, 1_000 * 2 ** Math.min(attempt, 30));
    return R.backoffMinMs + f * (top - R.backoffMinMs);
  };

  /** This generation's socket failed: end it, then back off (a late event of an older one does nothing). */
  const fail = (g: number): void => {
    if (g !== generation || state === 'backoff' || state === 'stopped' || state === 'idle') {
      return;
    }
    const now = o.mono.nowMs();
    const wasLive = state === 'live';
    clearTimers();
    endSocket();
    generation += 1; // its handlers are dead from here
    if (wasLive) {
      emit('chain-ws-down');
      if (now - liveSinceMs >= R.stableLiveMs) {
        attempt = 0;
      }
    }
    attempt += 1;
    state = 'backoff';
    later(backoffMs(), () => connect(true));
  };

  const stopNow = (): void => {
    state = 'stopped';
    generation += 1;
    clearTimers();
    endSocket();
  };

  /** On the current socket (only a handler of the current generation sends). */
  const send = (text: string): boolean => {
    if (ENCODER.encode(text).byteLength >= maxClient) {
      emit('chain-our-bug'); // never sent: the node would end the connection
      stopNow();
      return false;
    }
    try {
      return handle.send(text);
    } catch {
      return false;
    }
  };

  const goLive = (g: number): void => {
    clearTimers();
    state = 'live';
    const now = o.mono.nowMs();
    liveSinceMs = now;
    beatAtMs = now; // the watchdog's grace starts with the ack
    emit('chain-ws-up');
    // its timer is cancelled whenever this generation ends, so it only ever runs while live
    const watch = (): void => {
      if (o.mono.nowMs() - beatAtMs >= R.stallMs) {
        emit('chain-ws-stall');
        fail(g);
        return;
      }
      later(R.watchdogEveryMs, watch);
    };
    later(R.watchdogEveryMs, watch);
  };

  const onText = (g: number, text: string): void => {
    const bytes = text.length > R.maxMessageChars ? text.length * 3 : ENCODER.encode(text).byteLength;
    if (o.budget.chargeStream(bytes)) {
      overShare += 1;
    }
    if (text.length > R.maxMessageChars) {
      dropped.oversize += 1;
      emit('chain-ws-oversize');
      return;
    }
    let v: Json;
    try {
      v = parseLossless(text);
    } catch {
      dropped.malformed += 1;
      return;
    }
    const msg = exact(v, Object.keys(typeof v === 'object' && v !== null ? v : {}));
    if (msg === null || msg['jsonrpc'] !== '2.0') {
      dropped.malformed += 1;
      return;
    }
    if (Object.hasOwn(msg, 'method')) {
      const n = readNotification(msg);
      if (n === null) {
        dropped.malformed += 1;
      } else if (!subscriptions.has(n.subscription)) {
        // only this generation's ack fills the map, at the moment it goes live: before that it is empty
        dropped.unknownSub += 1; // ids are node-wide: not one this generation mapped
        emit('chain-ws-unknown-sub');
      } else {
        lastSlotAtMs = o.mono.nowMs();
        beatAtMs = lastSlotAtMs;
        o.slots.report('stream', n.slot);
      }
      return;
    }
    // an answer: only the one to our slotSubscribe, while we wait for it
    if (state !== 'subscribing' || msg['id'] !== SUBSCRIBE_ID) {
      dropped.malformed += 1;
      return;
    }
    const answer = exact(msg, ['jsonrpc', 'id', 'result']);
    const sub = answer?.['result'];
    if (typeof sub === 'bigint' && sub >= 0n) {
      subscriptions.add(sub);
      goLive(g);
    } else {
      fail(g); // refused (an error) or no subscription id: this socket cannot feed slots
    }
  };

  const handlers = (g: number): SocketHandlers => ({
    open: () => {
      if (g !== generation || state !== 'connecting') {
        return;
      }
      clearTimers();
      state = 'subscribing';
      if (!send(SUBSCRIBE)) {
        fail(g); // a refused send; after our bug the stream is stopped and this does nothing
        return;
      }
      later(R.ackTimeoutMs, () => fail(g));
    },
    message: (data) => {
      if (g !== generation || state === 'backoff' || state === 'stopped') {
        return;
      }
      if (typeof data === 'string') {
        onText(g, data);
        return;
      }
      if (data instanceof ArrayBuffer && o.budget.chargeStream(data.byteLength)) {
        overShare += 1;
      }
      dropped.binary += 1; // the node sends text only: binary ends the socket
      fail(g);
    },
    closed: () => fail(g),
    error: () => fail(g),
  });

  /** Called by start() when idle, and by the backoff timer (which stop() cancels). */
  function connect(again: boolean): void {
    generation += 1;
    const g = generation;
    subscriptions = new Set();
    state = 'connecting';
    if (again) {
      reconnects += 1;
      const now = o.mono.nowMs();
      reconnectTimes = reconnectTimes.filter((t) => now - t < R.flappingWindowMs);
      reconnectTimes.push(now);
      const over = reconnectTimes.length > R.flappingCount;
      if (over && !flapping) {
        emit('chain-ws-flapping');
      }
      flapping = over;
    }
    try {
      handle = o.socket(o.endpoint.wsUrl, handlers(g));
    } catch {
      handle = NO_SOCKET;
      fail(g); // the factory refused: back off as for any failed socket
      return;
    }
    later(R.openTimeoutMs, () => fail(g));
  }

  const client: StreamClient = {
    start: () => {
      if (state === 'idle') {
        connect(false);
      }
    },
    stop: stopNow,
    state: () => state,
    stats: () =>
      Object.freeze({
        state,
        generation,
        reconnects,
        lastSlotAtMs,
        overShare,
        dropped: Object.freeze({ ...dropped }),
      }),
  };
  return Object.freeze(client);
}
