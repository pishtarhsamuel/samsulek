// The live block feed (docs/CHAIN_DESIGN.md s.7 and s.13, step 7f): one WebSocket, slotSubscribe first,
// an ack within 5 s, a slotNotification at least every 5 s while live (our watchdog: the node never
// pings), generations so a close that never fires or comes late changes nothing, resubscription with new
// ids, unknown subscriptions and malformed messages dropped and counted, an oversize message dropped,
// binary data ending the socket, every length charged to the budget, a client message of 4,000 bytes or
// more never sent, backoff from 1 s to at most 60 s with jitter, flapping counted, and stop(). A fake
// socket factory and hand timers drive it. Written before src/chain/ws.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Timers } from '../../../src/core/clock.ts';
import type { ChainEvent } from '../../../src/chain/events.ts';
import { PUBLIC_MAINNET } from '../../../src/chain/providers.ts';
import { createStreamClient, STREAM_RULES, type SocketHandle, type SocketHandlers, type StreamClient } from '../../../src/chain/ws.ts';

const SLOT = 385_000_000n;
const SUBSCRIBE = '{"jsonrpc":"2.0","id":1,"method":"slotSubscribe"}';
const ack = (sub: bigint | number = 7, id = 1): string => `{"jsonrpc":"2.0","result":${sub},"id":${id}}`;
const note = (slot: bigint, sub: bigint | number = 7, parent = slot - 1n, root = slot - 32n): string =>
  `{"jsonrpc":"2.0","method":"slotNotification","params":{"result":{"parent":${parent},"root":${root},"slot":${slot}},"subscription":${sub}}}`;

interface FakeSocket {
  readonly url: string;
  readonly h: SocketHandlers;
  readonly sent: string[];
  terminated: boolean;
  sendResult: boolean;
  sendThrows: boolean;
  terminateThrows: boolean;
}

interface World {
  client: StreamClient;
  sockets: FakeSocket[];
  events: ChainEvent[];
  reports: [string, unknown][];
  charged: number[];
  now: number;
  jitter: number;
  overShare: boolean;
  factoryThrows: boolean;
  advance(ms: number): void;
  last(): FakeSocket;
  codes(): string[];
  pending(): number;
}

/** Timers that fire only when the test advances the clock, in time order. */
function world(o: { tighten?: { maxClientMessageBytes?: number }; throwingSink?: boolean } = {}): World {
  const w = { sockets: [], events: [], reports: [], charged: [], now: 1_000_000, jitter: 0, overShare: false, factoryThrows: false } as unknown as World;
  let timers: { at: number; fn: () => void; live: boolean }[] = [];
  const t: Timers = {
    timeoutSignal: () => new AbortController().signal,
    after: (ms, fn) => {
      const entry = { at: w.now + ms, fn, live: true };
      timers.push(entry);
      return () => {
        entry.live = false;
      };
    },
  };
  w.advance = (ms) => {
    const end = w.now + ms;
    for (;;) {
      const due = timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) {
        break;
      }
      w.now = due.at;
      due.live = false;
      due.fn();
    }
    w.now = end;
    timers = timers.filter((x) => x.live);
  };
  w.pending = () => timers.filter((x) => x.live).length;
  w.client = createStreamClient({
    endpoint: PUBLIC_MAINNET,
    socket: (url: string, h: SocketHandlers): SocketHandle => {
      if (w.factoryThrows) {
        throw new Error('the factory failed');
      }
      const s: FakeSocket = { url, h, sent: [], terminated: false, sendResult: true, sendThrows: false, terminateThrows: false };
      w.sockets.push(s);
      return {
        send: (text) => {
          if (s.sendThrows) {
            throw new Error('the socket failed');
          }
          s.sent.push(text);
          return s.sendResult;
        },
        terminate: () => {
          s.terminated = true;
          if (s.terminateThrows) {
            throw new Error('already closed');
          }
        },
      };
    },
    timers: t,
    mono: { nowMs: () => w.now },
    jitter: () => w.jitter,
    slots: { report: (channel, slot) => w.reports.push([channel, slot]) },
    budget: {
      chargeStream: (bytes) => {
        w.charged.push(bytes);
        return w.overShare;
      },
    },
    events: {
      event: (e) => {
        w.events.push(e);
        if (o.throwingSink === true) {
          throw new Error('the sink failed');
        }
      },
    },
    ...(o.tighten === undefined ? {} : { tighten: o.tighten }),
  });
  w.last = () => w.sockets[w.sockets.length - 1] as FakeSocket;
  w.codes = () => w.events.map((e) => e.code);
  return w;
}

/** Started, opened, subscribed and acknowledged: live. */
function live(o: Parameters<typeof world>[0] = {}): World {
  const w = world(o);
  w.client.start();
  w.last().h.open();
  w.last().h.message(ack());
  assert.equal(w.client.state(), 'live');
  return w;
}

describe('connecting and subscribing', () => {
  it('start connects to the endpoint; on open the first message is slotSubscribe; its ack makes it live', () => {
    const w = world();
    assert.equal(w.client.state(), 'idle');
    w.client.start();
    assert.equal(w.client.state(), 'connecting');
    assert.equal(w.sockets.length, 1);
    assert.equal(w.last().url, 'wss://api.mainnet-beta.solana.com/');
    assert.deepEqual(w.last().sent, []);
    w.last().h.open();
    assert.equal(w.client.state(), 'subscribing');
    assert.deepEqual(w.last().sent, [SUBSCRIBE]);
    w.last().h.message(ack(306_547_577));
    assert.equal(w.client.state(), 'live');
    assert.deepEqual(w.events.filter((e) => e.code === 'chain-ws-up'), [{ code: 'chain-ws-up', provider: 'public-mainnet' }]);
    w.client.start(); // a second start changes nothing
    assert.equal(w.sockets.length, 1);
  });

  it('no open within 10 s, or no ack within 5 s, ends the socket and backs off', () => {
    const w = world();
    w.client.start();
    w.advance(9_999);
    assert.equal(w.client.state(), 'connecting');
    w.advance(1);
    assert.equal(w.client.state(), 'backoff');
    assert.ok(w.sockets[0]?.terminated);
    w.advance(1_000); // jitter 0: the shortest backoff, 1 s
    assert.equal(w.sockets.length, 2);
    w.last().h.open();
    w.advance(4_999);
    assert.equal(w.client.state(), 'subscribing');
    w.advance(1);
    assert.equal(w.client.state(), 'backoff');
    assert.ok(w.sockets[1]?.terminated);
  });

  it('a refused subscription, an answer to another id, error, close, a failed send or a throwing factory each end the socket and back off', () => {
    const cases: [string, (w: World) => void][] = [
      ['refused', (w) => w.last().h.message('{"jsonrpc":"2.0","error":{"code":-32603,"message":"Subscription refused. Node subscription limit reached"},"id":1}')],
      ['error', (w) => w.last().h.error()],
      ['closed', (w) => w.last().h.closed()],
    ];
    for (const [what, act] of cases) {
      const w = world();
      w.client.start();
      w.last().h.open();
      act(w);
      assert.equal(w.client.state(), 'backoff', what);
      assert.ok(w.last().terminated, what);
    }
    const other = world();
    other.client.start();
    other.last().h.open();
    other.last().h.message(ack(7, 2)); // an answer to a request we never made: dropped, still waiting
    assert.equal(other.client.state(), 'subscribing');
    assert.equal(other.client.stats().dropped.malformed, 1);
    const unsent = world();
    unsent.client.start();
    unsent.last().sendResult = false;
    unsent.last().h.open();
    assert.equal(unsent.client.state(), 'backoff', 'a send the socket refused');
    const sendThrows = world();
    sendThrows.client.start();
    sendThrows.last().sendThrows = true;
    sendThrows.last().h.open();
    assert.equal(sendThrows.client.state(), 'backoff', 'a send that threw');
    const endThrows = live();
    endThrows.last().terminateThrows = true;
    endThrows.last().h.closed();
    assert.equal(endThrows.client.state(), 'backoff', 'a terminate that threw changes nothing');
    endThrows.advance(1_000);
    assert.equal(endThrows.sockets.length, 2);
    const thrown = world();
    thrown.factoryThrows = true;
    thrown.client.start();
    assert.equal(thrown.client.state(), 'backoff', 'the factory threw');
    thrown.factoryThrows = false;
    thrown.advance(1_000);
    assert.equal(thrown.sockets.length, 1, 'and the next attempt connects');
  });
});

describe('live: slots, the watchdog and the messages', () => {
  it("each slotNotification of our subscription is reported on 'stream'", () => {
    const w = live();
    w.last().h.message(note(SLOT));
    w.last().h.message(note(SLOT + 1n));
    assert.deepEqual(w.reports, [['stream', SLOT], ['stream', SLOT + 1n]]);
    assert.equal(w.client.stats().lastSlotAtMs, w.now);
  });

  it('5 s without a slotNotification while live is a stall: the socket ends, and a notification in time keeps it', () => {
    const w = live();
    w.advance(4_000);
    w.last().h.message(note(SLOT));
    w.advance(4_900);
    assert.equal(w.client.state(), 'live', 'the notification reset the watchdog');
    w.advance(1_000); // the watchdog's look 5 s after the last notification finds the stall
    assert.equal(w.client.state(), 'backoff');
    assert.ok(w.codes().includes('chain-ws-stall') && w.codes().includes('chain-ws-down'));
    assert.ok(w.sockets[0]?.terminated);
  });

  it('a socket whose close never fires is left behind: its late events change nothing (generations)', () => {
    const w = live();
    const old = w.last();
    w.advance(6_000); // stall: terminated, and its close never came
    w.advance(1_000);
    assert.equal(w.sockets.length, 2);
    old.h.message(note(SLOT)); // late events of the old generation
    old.h.open();
    old.h.closed();
    old.h.error();
    assert.deepEqual(w.reports, []);
    assert.equal(w.client.state(), 'connecting');
    assert.deepEqual(old.sent, [SUBSCRIBE], 'nothing more was sent on it');
    w.last().h.open();
    w.last().h.message(ack(8));
    assert.equal(w.client.state(), 'live');
  });

  it('the new generation subscribes again; a notification for the old id is an unknown subscription', () => {
    const w = live();
    w.last().h.closed();
    w.advance(1_000);
    w.last().h.open();
    assert.deepEqual(w.last().sent, [SUBSCRIBE], 'slotSubscribe first, again');
    w.last().h.message(ack(9));
    w.last().h.message(note(SLOT, 7)); // the old generation's id: not ours any more
    w.last().h.message(note(SLOT, 12345));
    assert.deepEqual(w.reports, []);
    assert.equal(w.client.stats().dropped.unknownSub, 2);
    assert.equal(w.events.filter((e) => e.code === 'chain-ws-unknown-sub').length, 2);
    w.last().h.message(note(SLOT, 9));
    assert.deepEqual(w.reports, [['stream', SLOT]]);
  });

  it('a message over 65,536 characters is dropped and counted; binary data ends the socket', () => {
    const w = live();
    w.last().h.message(`${note(SLOT)}${' '.repeat(65_537)}`);
    assert.deepEqual(w.reports, []);
    assert.equal(w.client.stats().dropped.oversize, 1);
    assert.ok(w.codes().includes('chain-ws-oversize'));
    assert.equal(w.client.state(), 'live');
    w.last().h.message(new ArrayBuffer(8));
    assert.equal(w.client.state(), 'backoff');
    assert.equal(w.client.stats().dropped.binary, 1);
  });

  it('every message is charged to the budget after receipt, in UTF-8 bytes (an oversize one at three bytes a character); the over-share answer is counted', () => {
    const w = live();
    const n = note(SLOT);
    w.last().h.message(n);
    w.last().h.message('"é"');
    w.overShare = true;
    w.last().h.message('x'.repeat(70_000));
    w.last().h.message(new ArrayBuffer(10));
    assert.deepEqual(w.charged, [ack().length, n.length, 4, 210_000, 10]);
    assert.equal(w.client.stats().overShare, 2);
  });

  it('malformed messages are dropped and counted, never reported', () => {
    const w = live();
    for (const bad of [
      'not json',
      '[]',
      '"text"',
      note(SLOT).replace('"jsonrpc":"2.0",', ''),
      note(SLOT).replace('slotNotification', 'logsNotification'),
      note(SLOT, 7, SLOT), // parent must be below slot
      note(SLOT, 7, SLOT - 1n, SLOT + 1n), // root at most slot
      note(1n << 63n, 7, (1n << 63n) - 1n, 0n), // not a slot
      note(SLOT).replace(`"slot":${SLOT}`, `"slot":${SLOT}.0`),
      note(SLOT).replace(`"slot":${SLOT}`, `"slot":"${SLOT}"`),
      note(SLOT).replace('"subscription":7', '"subscription":7,"extra":1'),
      note(SLOT).replace(`,"root":${SLOT - 32n}`, ''),
      note(SLOT).replace('"subscription":7', '"subscription":-7'),
      '{"jsonrpc":"2.0","result":true,"id":5}',
    ]) {
      w.last().h.message(bad);
    }
    assert.deepEqual(w.reports, []);
    assert.equal(w.client.stats().dropped.malformed, 13);
    assert.equal(w.client.stats().dropped.unknownSub, 1, 'a negative id is no subscription of ours');
    assert.equal(w.client.state(), 'live');
  });
});

describe('backoff, flapping and stop', () => {
  it('backoff waits 1 s to min(60 s, 2^n s) with jitter, growing with each failure and reset after 60 s live', () => {
    const w = world();
    const waitFor = (): number => {
      const before = w.sockets.length;
      let waited = 0;
      while (w.sockets.length === before) {
        w.advance(100);
        waited += 100;
        assert.ok(waited <= 60_000, 'never more than 60 s');
      }
      return waited;
    };
    w.jitter = 0.999;
    w.client.start();
    const waits: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      w.last().h.error();
      waits.push(waitFor());
    }
    // 2^n seconds with jitter just under 1: 2, 4, 8, 16, 32, then 60 (the cap) twice
    assert.deepEqual(waits, [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    w.jitter = 0;
    w.last().h.error();
    assert.equal(waitFor(), 1_000, 'jitter 0: the shortest, 1 s');
    w.jitter = 0.999;
    w.last().h.open();
    w.last().h.message(ack());
    for (let i = 0; i < 60; i += 1) {
      w.last().h.message(note(SLOT + BigInt(i)));
      w.advance(1_000);
    }
    w.last().h.error(); // after 60 s live: the backoff starts again from the first step
    assert.equal(waitFor(), 2_000);
    for (const bad of [Number.NaN, -0.5, 1, 7]) {
      const v = world();
      v.jitter = bad;
      v.client.start();
      v.last().h.error();
      v.advance(1_999);
      assert.equal(v.sockets.length, 1, `jitter ${bad} is read as the longest wait`);
      v.advance(1);
      assert.equal(v.sockets.length, 2);
    }
  });

  it('more than 6 reconnects in 10 minutes is flapping (one event each time it crosses)', () => {
    const w = world();
    w.client.start();
    for (let i = 0; i < 7; i += 1) {
      w.last().h.error();
      w.advance(1_000);
    }
    assert.equal(w.events.filter((e) => e.code === 'chain-ws-flapping').length, 1);
    assert.equal(w.client.stats().reconnects, 7);
    w.last().h.error(); // an 8th while still flapping: no second event
    w.advance(1_000);
    assert.equal(w.events.filter((e) => e.code === 'chain-ws-flapping').length, 1);
    w.last().h.open(); // then 10 minutes live, a slot every second
    w.last().h.message(ack());
    for (let i = 0; i < 600; i += 1) {
      w.last().h.message(note(SLOT + BigInt(i)));
      w.advance(1_000);
    }
    w.last().h.error();
    w.advance(1_000);
    assert.equal(w.events.filter((e) => e.code === 'chain-ws-flapping').length, 1, 'the old reconnects aged out');
    for (let i = 0; i < 6; i += 1) {
      w.last().h.error(); // a new burst: 7 in the window again, so it crosses again
      w.advance(60_000);
    }
    assert.equal(w.events.filter((e) => e.code === 'chain-ws-flapping').length, 2);
  });

  it('stop ends the socket, cancels every timer, and nothing after it does anything', () => {
    const w = live();
    const s = w.last();
    w.client.stop();
    assert.equal(w.client.state(), 'stopped');
    assert.ok(s.terminated);
    assert.equal(w.pending(), 0, 'no timer left');
    s.h.message(note(SLOT));
    s.h.closed();
    w.advance(120_000);
    w.client.start();
    assert.equal(w.sockets.length, 1);
    assert.deepEqual(w.reports, []);
    assert.equal(w.client.state(), 'stopped');
    const b = world(); // stopped while backing off
    b.client.start();
    b.last().h.error();
    b.client.stop();
    b.advance(120_000);
    assert.equal(b.sockets.length, 1);
  });

  it('a client message of 4,000 UTF-8 bytes or more is our bug: never sent, the stream stops (s.7)', () => {
    assert.equal(STREAM_RULES.maxClientMessageBytes, 4_000);
    const w = world({ tighten: { maxClientMessageBytes: 40 } });
    w.client.start();
    w.last().h.open();
    assert.deepEqual(w.last().sent, []);
    assert.equal(w.client.state(), 'stopped');
    assert.deepEqual(w.events.filter((e) => e.code === 'chain-our-bug'), [{ code: 'chain-our-bug', provider: 'public-mainnet' }]);
    for (const bad of [0, 4_001, 1.5]) {
      assert.throws(() => world({ tighten: { maxClientMessageBytes: bad } }), TypeError);
    }
    // at the edge: slotSubscribe is 50 bytes, refused at a cap of 50 ("or more"), sent at 51
    const at50 = world({ tighten: { maxClientMessageBytes: SUBSCRIBE.length } });
    at50.client.start();
    at50.last().h.open();
    assert.equal(at50.client.state(), 'stopped');
    const at51 = world({ tighten: { maxClientMessageBytes: SUBSCRIBE.length + 1 } });
    at51.client.start();
    at51.last().h.open();
    assert.deepEqual(at51.last().sent, [SUBSCRIBE]);
  });

  it('a sink that throws never stops the stream; stats are frozen', () => {
    const w = live({ throwingSink: true });
    w.last().h.message(note(SLOT));
    assert.deepEqual(w.reports, [['stream', SLOT]]);
    const st = w.client.stats();
    assert.ok(Object.isFrozen(st) && Object.isFrozen(st.dropped));
    assert.equal(st.state, 'live');
    assert.equal(st.generation, 1);
    assert.ok(Object.isFrozen(w.client));
  });

  it('the rules are as designed', () => {
    assert.deepEqual(STREAM_RULES, {
      openTimeoutMs: 10_000,
      ackTimeoutMs: 5_000,
      stallMs: 5_000,
      watchdogEveryMs: 1_000,
      maxMessageChars: 65_536,
      maxClientMessageBytes: 4_000,
      backoffMinMs: 1_000,
      backoffMaxMs: 60_000,
      stableLiveMs: 60_000,
      flappingCount: 6,
      flappingWindowMs: 600_000,
    });
    assert.ok(Object.isFrozen(STREAM_RULES));
  });
});
