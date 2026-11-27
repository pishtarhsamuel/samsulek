// The live block feed against random event sequences (docs/CHAIN_DESIGN.md s.13, step 7f): opens,
// acks, notifications, junk, errors and closes delivered to the current socket or to any older one (a
// close that never fired, events that come late), and clock steps. After every event: a reported slot
// came from the current socket, live, on a subscription that socket's ack mapped; every socket that went
// live sent slotSubscribe first and nothing else before its ack; nothing is sent on a terminated socket;
// the stream is live on at most one socket.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import type { Timers } from '../../../src/core/clock.ts';
import { PUBLIC_MAINNET } from '../../../src/chain/providers.ts';
import { createStreamClient, type SocketHandlers } from '../../../src/chain/ws.ts';

const SUBSCRIBE = '{"jsonrpc":"2.0","id":1,"method":"slotSubscribe"}';

type Ev =
  | { readonly kind: 'open' | 'error' | 'closed' | 'junk'; readonly which: number }
  | { readonly kind: 'ack'; readonly which: number; readonly sub: number }
  | { readonly kind: 'note'; readonly which: number; readonly sub: number; readonly slot: number }
  | { readonly kind: 'advance'; readonly ms: number };

const which = fc.oneof(fc.constant(-1), fc.nat({ max: 6 })); // -1: the newest socket; n: the n-th newest
const evArb: fc.Arbitrary<Ev> = fc.oneof(
  fc.record({ kind: fc.constantFrom('open' as const, 'error' as const, 'closed' as const, 'junk' as const), which }),
  fc.record({ kind: fc.constant('ack' as const), which, sub: fc.nat({ max: 4 }) }),
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('note' as const), which, sub: fc.nat({ max: 4 }), slot: fc.integer({ min: 1_000, max: 1_100 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('advance' as const), ms: fc.oneof(fc.nat({ max: 2_000 }), fc.constantFrom(5_000, 10_000, 61_000)) }) },
);

interface Sock {
  readonly h: SocketHandlers;
  readonly sent: string[];
  terminated: boolean;
  sentAfterTerminate: boolean;
  /** The subscription ids the stream accepted from this socket's acks. */
  readonly mapped: Set<number>;
  wentLive: boolean;
}

function run(events: readonly Ev[]): void {
  let now = 1_000_000;
  let timers: { at: number; fn: () => void; live: boolean }[] = [];
  const t: Timers = {
    timeoutSignal: () => new AbortController().signal,
    after: (ms, fn) => {
      const e = { at: now + ms, fn, live: true };
      timers.push(e);
      return () => {
        e.live = false;
      };
    },
  };
  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) {
        break;
      }
      now = due.at;
      due.live = false;
      due.fn();
    }
    now = end;
    timers = timers.filter((x) => x.live);
  };
  const sockets: Sock[] = [];
  const reports: bigint[] = [];
  const stream = createStreamClient({
    endpoint: PUBLIC_MAINNET,
    socket: (_url, h) => {
      const s: Sock = { h, sent: [], terminated: false, sentAfterTerminate: false, mapped: new Set(), wentLive: false };
      sockets.push(s);
      return {
        send: (text) => {
          if (s.terminated) {
            s.sentAfterTerminate = true;
          }
          s.sent.push(text);
          return true;
        },
        terminate: () => {
          s.terminated = true;
        },
      };
    },
    timers: t,
    mono: { nowMs: () => now },
    jitter: () => 0.5,
    slots: { report: (_c, slot) => reports.push(slot as bigint) },
    budget: { chargeStream: () => false },
    events: { event: () => undefined },
  });
  stream.start();
  for (const ev of events) {
    if (ev.kind === 'advance') {
      advance(ev.ms);
      continue;
    }
    const index = ev.which === -1 ? sockets.length - 1 : sockets.length - 1 - ev.which;
    const s = sockets[index];
    if (s === undefined) {
      continue;
    }
    const isNewest = index === sockets.length - 1;
    const before = reports.length;
    const wasLive = stream.state() === 'live';
    switch (ev.kind) {
      case 'open':
        s.h.open();
        break;
      case 'error':
        s.h.error();
        break;
      case 'closed':
        s.h.closed();
        break;
      case 'junk':
        s.h.message('{"jsonrpc":"2.0","method":"logsNotification","params":{}}');
        break;
      case 'ack':
        s.h.message(`{"jsonrpc":"2.0","result":${ev.sub},"id":1}`);
        if (!wasLive && stream.state() === 'live') {
          assert.ok(isNewest && !s.terminated, 'only the current socket can go live');
          assert.deepEqual(s.sent, [SUBSCRIBE], 'slotSubscribe first, and alone, before the ack');
          s.mapped.add(ev.sub);
          s.wentLive = true;
        }
        break;
      case 'note':
        s.h.message(`{"jsonrpc":"2.0","method":"slotNotification","params":{"result":{"parent":${ev.slot - 1},"root":${ev.slot - 32},"slot":${ev.slot}},"subscription":${ev.sub}}}`);
        if (reports.length > before) {
          assert.ok(isNewest && !s.terminated, 'a slot only from the current socket');
          assert.ok(s.mapped.has(ev.sub), 'a slot only from a subscription this socket mapped');
          assert.equal(stream.state(), 'live');
        }
        break;
    }
    assert.ok(reports.length <= before + 1);
    assert.ok(sockets.every((x) => !x.sentAfterTerminate), 'nothing sent on a terminated socket');
    const liveOn = sockets.filter((x) => x.wentLive && !x.terminated);
    assert.ok(liveOn.length <= 1, 'live on at most one socket');
    if (stream.state() === 'live') {
      assert.equal(liveOn[0], sockets[sockets.length - 1], 'and that is the current one');
    }
  }
  stream.stop();
  assert.ok(sockets.every((x) => x.terminated || x === sockets[sockets.length - 1]));
}

describe('the live block feed under random events', () => {
  it('slots only from the current, subscribed socket; slotSubscribe first; nothing sent on an ended socket; live on one socket at most', () => {
    fc.assert(fc.property(fc.array(evArb, { minLength: 5, maxLength: 120 }), (events) => run(events)), { numRuns: 1_000 });
  });
});
