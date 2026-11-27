// The WebSocket door (docs/CHAIN_DESIGN.md s.7, s.9 and s.13, step 7f): the real factory, against a
// hand-written WebSocket server inside this process (node:http's upgrade and RFC 6455 frames, test code
// only, 127.0.0.1, never the network). The provider's URL is checked once (wss only, no user, password or
// fragment, every query value a registered secret, never named in a refusal); binary comes as an
// ArrayBuffer; a message the client sends arrives intact; after terminate() no handler runs, even when the
// server sent a close frame and never closed the TCP connection (VERIFIED_FACTS s.9: then `close` never
// fires). The real stream client runs end to end over it once. Written before src/chain/ws-socket.ts.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { PUBLIC_MAINNET, type ProviderEndpoint } from '../../../src/chain/providers.ts';
import { createStreamClient, type SocketHandlers } from '../../../src/chain/ws.ts';
import { createWebSocketFactory } from '../../../src/chain/ws-socket.ts';
import { systemMono, systemTimers } from '../../../src/core/clock.ts';
import { assertNoSecrets } from '../../../src/core/redact.ts';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const SUBSCRIBE = '{"jsonrpc":"2.0","id":1,"method":"slotSubscribe"}';

/** A server frame: final, unmasked. */
function frame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]);
  return Buffer.concat([head, payload]);
}

/** The client's frames (always masked), from a buffer that may hold several. */
function clientFrames(buf: Buffer): { opcode: number; payload: Buffer }[] {
  const out: { opcode: number; payload: Buffer }[] = [];
  let i = 0;
  while (i + 2 <= buf.length) {
    const opcode = (buf[i] as number) & 0x0f;
    let n = (buf[i + 1] as number) & 0x7f;
    let p = i + 2;
    if (n === 126) {
      n = buf.readUInt16BE(p);
      p += 2;
    }
    const mask = buf.subarray(p, p + 4);
    p += 4;
    const payload = Buffer.from(buf.subarray(p, p + n));
    for (let k = 0; k < payload.length; k += 1) {
      payload[k] = (payload[k] as number) ^ (mask[k % 4] as number);
    }
    out.push({ opcode, payload });
    i = p + n;
  }
  return out;
}

interface Peer {
  readonly socket: Socket;
  readonly received: { opcode: number; text: string }[];
  closed: boolean;
}

let server: Server;
let port = 0;
let peers: Peer[] = [];
/** Every connection the server ever took, so the end of the file can close them all. */
const allSockets = new Set<Socket>();
let onPeer: (p: Peer) => void = () => undefined;

before(async () => {
  server = createServer();
  server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    const key = String(req.headers['sec-websocket-key']);
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const peer: Peer = { socket, received: [], closed: false };
    socket.on('data', (d: Buffer) => {
      for (const f of clientFrames(d)) {
        peer.received.push({ opcode: f.opcode, text: f.payload.toString('utf8') });
      }
    });
    socket.on('close', () => {
      peer.closed = true;
    });
    socket.on('error', () => undefined);
    allSockets.add(socket);
    peers.push(peer);
    onPeer(peer);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  for (const sock of allSockets) {
    sock.destroy();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const until = async (what: string, ok: () => boolean, ms = 2_000): Promise<void> => {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > ms) {
      assert.fail(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
};
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const local = (): WebSocket => new WebSocket(`ws://127.0.0.1:${port}/`);

interface Seen {
  readonly calls: string[];
  readonly messages: unknown[];
  readonly h: SocketHandlers;
}
const seen = (): Seen => {
  const calls: string[] = [];
  const messages: unknown[] = [];
  return {
    calls,
    messages,
    h: {
      open: () => calls.push('open'),
      message: (d) => {
        calls.push('message');
        messages.push(d);
      },
      closed: () => calls.push('closed'),
      error: () => calls.push('error'),
    },
  };
};

describe('the real WebSocket factory against an in-process server', () => {
  it('connects, sends a message intact, and hands text as strings and binary as ArrayBuffers', async () => {
    peers = [];
    const factory = createWebSocketFactory({ endpoint: PUBLIC_MAINNET, open: local });
    const s = seen();
    const handle = factory(PUBLIC_MAINNET.wsUrl, s.h);
    await until('open', () => s.calls.includes('open'));
    assert.equal(handle.send(SUBSCRIBE), true);
    await until('the subscribe frame', () => (peers[0]?.received.length ?? 0) > 0);
    assert.deepEqual(peers[0]?.received[0], { opcode: 1, text: SUBSCRIBE });
    const peer = peers[0] as Peer;
    peer.socket.write(frame(1, Buffer.from('{"jsonrpc":"2.0","result":7,"id":1}')));
    peer.socket.write(frame(2, Buffer.from([1, 2, 3])));
    await until('two messages', () => s.messages.length === 2);
    assert.equal(s.messages[0], '{"jsonrpc":"2.0","result":7,"id":1}');
    assert.ok(s.messages[1] instanceof ArrayBuffer);
    assert.deepEqual([...new Uint8Array(s.messages[1] as ArrayBuffer)], [1, 2, 3]);
    handle.terminate();
  });

  it('after terminate() no handler runs: a close frame without the TCP close, then the server hangs up', async () => {
    peers = [];
    const factory = createWebSocketFactory({ endpoint: PUBLIC_MAINNET, open: local });
    const s = seen();
    const handle = factory(PUBLIC_MAINNET.wsUrl, s.h);
    await until('open', () => s.calls.includes('open'));
    const peer = peers[0] as Peer;
    peer.socket.write(frame(8, Buffer.from([0x03, 0xf0]))); // close 1008, and the TCP stays open
    await pause(200);
    handle.terminate(); // whether or not `close` fired, nothing after this reaches us
    const before = s.calls.length;
    peer.socket.write(frame(1, Buffer.from('"late"')));
    peer.socket.destroy();
    await pause(200);
    assert.equal(s.calls.length, before, `no handler after terminate: ${s.calls.slice(before).join(',')}`);
    assert.equal(handle.send('x'), false, 'and nothing is sent');
    handle.terminate(); // twice is harmless
  });

  it('a refused connection reaches the error or closed handler, and send is false before open', async () => {
    const factory = createWebSocketFactory({ endpoint: PUBLIC_MAINNET, open: () => new WebSocket('ws://127.0.0.1:1/') });
    const s = seen();
    const handle = factory(PUBLIC_MAINNET.wsUrl, s.h);
    assert.equal(handle.send('x'), false);
    await until('a failure', () => s.calls.includes('error') || s.calls.includes('closed'));
    handle.terminate();
  });

  it('without an opener it uses the real WebSocket (here at a closed local wss port: a failure, no network)', async () => {
    const endpoint: ProviderEndpoint = { ...PUBLIC_MAINNET, wsUrl: 'wss://127.0.0.1:1/' };
    const s = seen();
    const handle = createWebSocketFactory({ endpoint })(endpoint.wsUrl, s.h);
    await until('a failure', () => s.calls.includes('error') || s.calls.includes('closed'));
    assert.ok(!s.calls.includes('open'));
    handle.terminate();
  });

  it('the real stream client runs end to end: subscribes, goes live, reports a slot, stops', async () => {
    peers = [];
    onPeer = (p) => {
      p.socket.on('data', () => {
        if (p.received.some((r) => r.text === SUBSCRIBE)) {
          p.socket.write(frame(1, Buffer.from('{"jsonrpc":"2.0","result":42,"id":1}')));
          p.socket.write(frame(1, Buffer.from('{"jsonrpc":"2.0","method":"slotNotification","params":{"result":{"parent":384999999,"root":384999968,"slot":385000000},"subscription":42}}')));
        }
      });
    };
    const reports: [string, unknown][] = [];
    const stream = createStreamClient({
      endpoint: PUBLIC_MAINNET,
      socket: createWebSocketFactory({ endpoint: PUBLIC_MAINNET, open: local }),
      timers: systemTimers,
      mono: systemMono,
      jitter: () => 0,
      slots: { report: (c, slot) => reports.push([c, slot]) },
      budget: { chargeStream: () => false },
      events: { event: () => undefined },
    });
    stream.start();
    await until('a slot', () => reports.length > 0);
    assert.deepEqual(reports, [['stream', 385_000_000n]]);
    assert.equal(stream.state(), 'live');
    stream.stop();
    onPeer = () => undefined;
    await until('the server sees the socket end', () => (peers[0] as Peer).closed || (peers[0] as Peer).received.some((r) => r.opcode === 8));
  });
});

describe('the provider URL (s.9)', () => {
  const at = (wsUrl: string, secretParts: readonly string[] = []): ProviderEndpoint => ({ ...PUBLIC_MAINNET, wsUrl, secretParts });

  it('the public endpoint is wss with no key; another scheme, a user, a fragment or an unlisted query value is refused without naming the URL', () => {
    assert.equal(PUBLIC_MAINNET.wsUrl, 'wss://api.mainnet-beta.solana.com/');
    createWebSocketFactory({ endpoint: PUBLIC_MAINNET });
    for (const bad of ['ws://api.mainnet-beta.solana.com/', 'https://api.mainnet-beta.solana.com/', 'wss://user@example.com/', 'wss://u:p@example.com/', 'wss://example.com/#frag', 'wss://example.com/?api-key=QUERYVALUE0123456789', 'not a url']) {
      let message = '';
      try {
        createWebSocketFactory({ endpoint: at(bad) });
      } catch (e) {
        assert.ok(e instanceof TypeError, bad);
        message = e.message;
      }
      assert.notEqual(message, '', `refused: ${bad}`);
      assert.ok(!message.includes('example.com') && !message.includes('QUERYVALUE'), `the refusal names no URL: ${message}`);
    }
  });

  it("a key in the query is registered as the bot's own secret; the factory opens only its checked URL", () => {
    const key = 'WSKEY-4f9d2c7a1b3e5d6f8a9b';
    const endpoint = at(`wss://rpc.example.com/?api-key=${key}`, [key]);
    const factory = createWebSocketFactory({ endpoint, open: () => assert.fail('no socket for another URL') });
    assert.throws(() => assertNoSecrets(`the stream url had ${key}`, 'a test line'), 'the key is refused wherever it could leak');
    assert.throws(() => factory('wss://other.example.com/', seen().h), TypeError);
    assert.throws(() => createWebSocketFactory({ endpoint: at('wss://rpc.example.com/?k=short', ['short']) }), TypeError, 'a part too short to register');
  });
});
