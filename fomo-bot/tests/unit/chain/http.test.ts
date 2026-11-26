// The fetch transport (docs/CHAIN_DESIGN.md s.4 and s.9, step 7c), against a real in-process HTTP server
// on 127.0.0.1 (never the network): redirects refused, a JSON content type required, the decoded bytes
// capped (a gzip bomb stops at the cap), a content-length over the cap refused unread, strict UTF-8, a
// stalled body ended by the timeout or the shutdown signal, error bodies read at most 4 KiB, a request
// over 48 KiB never sent, and the provider URL checked (https only, no user, no fragment, every query
// value a registered secret). The transport is given the real fetch with the URL pointed at the local
// server, so the https check stays as it runs in production. Written before src/chain/http.ts.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { createHttpTransport, MAX_REQUEST_BYTES, type HttpOutcome } from '../../../src/chain/http.ts';
import { MAINNET_GENESIS_HASH, PUBLIC_MAINNET, type ProviderEndpoint } from '../../../src/chain/providers.ts';
import type { Timers } from '../../../src/core/clock.ts';
import { assertNoSecrets } from '../../../src/core/redact.ts';
import { address } from '../../../src/core/solana.ts';

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
let handler: Handler = (_req, _body, res) => res.end();
let calls = 0;
let server: Server;
let port = 0;

before(async () => {
  server = createServer((req, res) => {
    calls += 1;
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => handler(req, Buffer.concat(parts).toString('utf8'), res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Timers whose timeout signals fire only when the test says so. */
function handTimers(): Timers & { fire(): void } {
  const controllers: AbortController[] = [];
  return {
    timeoutSignal: () => {
      const c = new AbortController();
      controllers.push(c);
      return c.signal;
    },
    after: () => () => undefined,
    fire: () => controllers.forEach((c) => c.abort()),
  };
}

function transport(o: { endpoint?: ProviderEndpoint; timers?: Timers; shutdown?: AbortSignal; path?: string } = {}) {
  const timers = o.timers ?? handTimers();
  return createHttpTransport({
    endpoint: o.endpoint ?? PUBLIC_MAINNET,
    timers,
    shutdown: o.shutdown ?? new AbortController().signal,
    fetchImpl: (_url, init) => fetch(`http://127.0.0.1:${port}${o.path ?? '/'}`, init),
  });
}

const BODY = '{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[{"commitment":"confirmed"}]}';
const post = (t: ReturnType<typeof transport>, maxBytes = 1024, bodyText = BODY): Promise<HttpOutcome> => t.post({ bodyText, timeoutMs: 5_000, maxBytes });
/** An answer with its content-length, as a real server sends one. */
const json = (res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), ...headers });
  res.end(text);
};

describe('the fetch transport: one POST, and what comes back', () => {
  it('posts the body as JSON and returns a 200\'s text with its rate headers', async () => {
    let seen: { method?: string | undefined; type?: string | undefined; accept?: string | undefined; body?: string } = {};
    handler = (req, body, res) => {
      seen = { method: req.method, type: req.headers['content-type'], accept: req.headers.accept, body };
      json(res, 200, '{"jsonrpc":"2.0","result":385000000,"id":1}', { 'x-ratelimit-method-limit': '150', 'x-ratelimit-method-remaining': '-3', 'retry-after': '10' });
    };
    const o = await post(transport());
    assert.deepEqual(seen, { method: 'POST', type: 'application/json', accept: 'application/json', body: BODY });
    assert.deepEqual(o, { kind: 'response', status: 200, rate: { methodLimit: 150, methodRemaining: -3, retryAfterSec: 10 }, bodyText: '{"jsonrpc":"2.0","result":385000000,"id":1}', bytes: 43 });
  });

  it('reads the rate headers from digits only: anything else is missing', async () => {
    for (const [limit, remaining, retry] of [['abc', '1.5', 'Wed, 21 Oct 2026 07:28:00 GMT'], ['10, 20', '+4', '-1'], ['1e3', ' ', '99999999999'], ['-5', '--1', '1.0']]) {
      handler = (_req, _body, res) => json(res, 200, '{}', { 'x-ratelimit-method-limit': limit as string, 'x-ratelimit-method-remaining': remaining as string, 'retry-after': retry as string });
      const o = await post(transport());
      assert.equal(o.kind, 'response');
      assert.deepEqual(o.kind === 'response' ? o.rate : null, { methodLimit: null, methodRemaining: null, retryAfterSec: null }, `${limit} ${remaining} ${retry}`);
    }
    handler = (_req, _body, res) => json(res, 200, '{}');
    const o = await post(transport());
    assert.deepEqual(o.kind === 'response' ? o.rate : null, { methodLimit: null, methodRemaining: null, retryAfterSec: null });
  });

  it('an error status comes back with its headers, its body read at most 4 KiB and dropped', async () => {
    handler = (_req, _body, res) => json(res, 429, `{"error":{"code":429,"message":"${'x'.repeat(20_000)}"},"id":1}`, { 'retry-after': '10' });
    const o = await post(transport(), 1024 * 1024);
    assert.equal(o.kind, 'response');
    if (o.kind === 'response') {
      assert.equal(o.status, 429);
      assert.equal(o.bodyText, null);
      assert.equal(o.rate.retryAfterSec, 10);
      assert.equal(o.bytes, 0, 'its content-length is over 4 KiB: not read at all');
    }
    // without a content-length, reading stops at the first chunk that passes 4 KiB
    handler = (_req, _body, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.write('x'.repeat(3_000));
      setTimeout(() => res.end('y'.repeat(3_000)), 20);
    };
    const chunked = await post(transport(), 1024 * 1024);
    assert.ok(chunked.kind === 'response' && chunked.status === 500 && chunked.bodyText === null && chunked.bytes > 4096 && chunked.bytes <= 6_000, JSON.stringify(chunked));
    handler = (_req, _body, res) => json(res, 403, 'blocked');
    assert.deepEqual(await post(transport()), { kind: 'response', status: 403, rate: { methodLimit: null, methodRemaining: null, retryAfterSec: null }, bodyText: null, bytes: 7 });
  });
});

describe('the fetch transport refuses what it must not read', () => {
  it('a redirect is refused, and its target never reached', async () => {
    let reachedTarget = false;
    handler = (req, _body, res) => {
      if (req.url === '/elsewhere') {
        reachedTarget = true;
        json(res, 200, '{}');
        return;
      }
      res.writeHead(307, { location: `http://127.0.0.1:${port}/elsewhere` });
      res.end();
    };
    assert.deepEqual(await post(transport()), { kind: 'transport', bytes: 0 });
    assert.equal(reachedTarget, false);
  });

  it('a 200 that is not JSON is refused unread', async () => {
    for (const type of ['text/html', 'application/jsonp', 'text/plain; charset=utf-8', '']) {
      handler = (_req, _body, res) => {
        res.writeHead(200, type === '' ? {} : { 'content-type': type });
        res.end('<html>hello</html>');
      };
      assert.deepEqual(await post(transport()), { kind: 'content-type', bytes: 0 }, type);
    }
    handler = (_req, _body, res) => json(res, 200, '{}', { 'content-type': 'APPLICATION/JSON' });
    assert.equal((await post(transport())).kind, 'response', 'the type is case-insensitive');
  });

  it('a content-length over the cap is refused before reading', async () => {
    handler = (_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '2000' });
      res.end('x'.repeat(2000));
    };
    assert.deepEqual(await post(transport(), 1999), { kind: 'too-large', bytes: 0 });
  });

  it('a gzip bomb stops at the cap, counted in decoded bytes', async () => {
    const bomb = gzipSync(Buffer.alloc(20 * 1024 * 1024, 0x20)); // 20 MiB of spaces in about 20 KiB
    assert.ok(bomb.length < 64 * 1024);
    handler = (_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(bomb);
    };
    const o = await post(transport(), 64 * 1024);
    assert.equal(o.kind, 'too-large');
    assert.ok(o.bytes > 64 * 1024 && o.bytes < 2 * 1024 * 1024, `decoded ${o.bytes} bytes before stopping`);
  });

  it('a body of exactly the cap is read; one byte more is too large', async () => {
    handler = (_req, _body, res) => json(res, 200, `"${'a'.repeat(98)}"`);
    assert.equal((await post(transport(), 100)).kind, 'response');
    assert.deepEqual(await post(transport(), 99), { kind: 'too-large', bytes: 0 }); // the content-length already says 100
    // without a content-length, the bytes are counted as they come and reading stops past the cap
    handler = (_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(`"${'a'.repeat(98)}"`);
    };
    assert.equal((await post(transport(), 100)).kind, 'response');
    assert.deepEqual(await post(transport(), 99), { kind: 'too-large', bytes: 100 });
  });

  it('invalid UTF-8 is refused', async () => {
    handler = (_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(Buffer.from([0x22, 0xc3, 0x28, 0x22])); // a broken two-byte sequence
    };
    assert.deepEqual(await post(transport()), { kind: 'utf8', bytes: 4 });
    handler = (_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(Buffer.from([0x22, 0x61, 0x22, 0xc3])); // a two-byte sequence cut off at the very end
    };
    assert.deepEqual(await post(transport()), { kind: 'utf8', bytes: 4 });
  });

  it('a request over 48 KiB is never sent', async () => {
    const before = calls;
    const o = await post(transport(), 1024, `"${'a'.repeat(MAX_REQUEST_BYTES)}"`);
    assert.deepEqual(o, { kind: 'request-too-large', bytes: 0 });
    assert.equal(calls, before);
    assert.equal(MAX_REQUEST_BYTES, 49_152);
    handler = (_req, _body, res) => json(res, 200, '{}');
    assert.equal((await post(transport(), 1024, `"${'é'.repeat((MAX_REQUEST_BYTES - 2) / 2)}"`)).kind, 'response', 'exactly 48 KiB of UTF-8 goes');
    // counted in UTF-8 bytes, not characters: 24,578 characters are 49,154 bytes
    assert.deepEqual(await post(transport(), 1024, `"${'é'.repeat(MAX_REQUEST_BYTES / 2)}"`), { kind: 'request-too-large', bytes: 0 });
  });
});

describe('the fetch transport ends what hangs', () => {
  it('a body that stalls ends as a timeout when the timeout fires, or as shutdown when the bot stops', { timeout: 10_000 }, async () => {
    const stall: Handler = (_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"jsonrpc":"2.0",');
    };
    handler = stall;
    const timers = handTimers();
    const pending = post(transport({ timers }));
    await new Promise((r) => setTimeout(r, 50));
    timers.fire();
    assert.deepEqual(await pending, { kind: 'timeout', bytes: 17 });
    const stop = new AbortController();
    const pending2 = post(transport({ shutdown: stop.signal }));
    await new Promise((r) => setTimeout(r, 50));
    stop.abort();
    assert.deepEqual(await pending2, { kind: 'shutdown', bytes: 17 });
  });

  it('no answer at all ends as a timeout; a refused connection is a transport failure', { timeout: 10_000 }, async () => {
    handler = () => undefined; // never answers
    const timers = handTimers();
    const pending = post(transport({ timers }));
    await new Promise((r) => setTimeout(r, 50));
    timers.fire();
    assert.deepEqual(await pending, { kind: 'timeout', bytes: 0 });
    const closed = createHttpTransport({
      endpoint: PUBLIC_MAINNET,
      timers: handTimers(),
      shutdown: new AbortController().signal,
      fetchImpl: (_url, init) => fetch('http://127.0.0.1:1/', init), // nothing listens on port 1
    });
    assert.deepEqual(await closed.post({ bodyText: BODY, timeoutMs: 5_000, maxBytes: 1024 }), { kind: 'transport', bytes: 0 });
  });

  it('without a fetchImpl it uses the real fetch (here at a closed local https port: a transport failure, no network)', async () => {
    const real = createHttpTransport({ endpoint: { ...PUBLIC_MAINNET, httpUrl: 'https://127.0.0.1:1/' }, timers: handTimers(), shutdown: new AbortController().signal });
    assert.deepEqual(await real.post({ bodyText: BODY, timeoutMs: 5_000, maxBytes: 1024 }), { kind: 'transport', bytes: 0 });
  });

  it('an answer with no body at all comes back with its status and no text', async () => {
    handler = (_req, _body, res) => {
      res.writeHead(204);
      res.end();
    };
    assert.deepEqual(await post(transport()), { kind: 'response', status: 204, rate: { methodLimit: null, methodRemaining: null, retryAfterSec: null }, bodyText: null, bytes: 0 });
  });

  it('a stopped bot sends nothing', async () => {
    const before = calls;
    const stop = new AbortController();
    stop.abort();
    assert.deepEqual(await post(transport({ shutdown: stop.signal })), { kind: 'shutdown', bytes: 0 });
    assert.equal(calls, before);
  });

  it('a call that cannot be right is a TypeError, before anything is sent', () => {
    const t = transport();
    for (const bad of [{ bodyText: 1, timeoutMs: 5_000, maxBytes: 1 }, { bodyText: BODY, timeoutMs: 0, maxBytes: 1 }, { bodyText: BODY, timeoutMs: 1.5, maxBytes: 1 }, { bodyText: BODY, timeoutMs: 5_000, maxBytes: 0 }, { bodyText: BODY, timeoutMs: 5_000, maxBytes: -1 }]) {
      assert.throws(() => t.post(bad as unknown as Parameters<typeof t.post>[0]), TypeError, JSON.stringify(bad));
    }
  });
});

describe('the provider URL (s.9)', () => {
  const at = (httpUrl: string, secretParts: readonly string[] = []): ProviderEndpoint => ({ ...PUBLIC_MAINNET, httpUrl, secretParts });

  it('the public endpoint is https with no key; another scheme, a user, a fragment or a query value that is not a registered secret is refused', () => {
    assert.deepEqual(PUBLIC_MAINNET, { id: 'public-mainnet', httpUrl: 'https://api.mainnet-beta.solana.com', wsUrl: 'wss://api.mainnet-beta.solana.com/', secretParts: [] });
    assert.ok(Object.isFrozen(PUBLIC_MAINNET) && Object.isFrozen(PUBLIC_MAINNET.secretParts));
    // the mainnet-beta genesis hash (VERIFIED_FACTS s.9, two sources), a canonical 32-byte value
    assert.equal(MAINNET_GENESIS_HASH, '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
    assert.equal(address(MAINNET_GENESIS_HASH), MAINNET_GENESIS_HASH);
    transport();
    for (const bad of ['http://api.mainnet-beta.solana.com', 'ftp://x.example', 'https://user:pw@rpc.example', 'https://rpc.example/#frag', 'https://rpc.example/?api-key=not-listed-but-long-enough', 'not a url']) {
      assert.throws(() => transport({ endpoint: at(bad) }), (e: unknown) => e instanceof TypeError && !e.message.includes('example') && !e.message.includes('not-listed'), bad);
    }
    assert.throws(() => transport({ endpoint: at('https://rpc.example/?api-key=short1', ['short1']) }), TypeError, 'a secret too short to register is refused');
  });

  it('a key in the query is registered as the bot\'s own secret, so it is refused wherever it could leak, and no outcome names the URL', async () => {
    const key = 'fake-key-0123456789abcdef';
    handler = (_req, _body, res) => json(res, 200, '{"ok":true}');
    const t = transport({ endpoint: at(`https://rpc.example/?api-key=${key}`, [key]) });
    assert.throws(() => assertNoSecrets(`the url was https://rpc.example/?api-key=${key}`, 'a test line'));
    assert.throws(() => assertNoSecrets(`just ${key}`, 'a test line'));
    const o = await post(t);
    assert.ok(!JSON.stringify(o).includes('rpc.example') && !JSON.stringify(o).includes(key));
    handler = (_req, _body, res) => {
      res.writeHead(302, { location: `https://rpc.example/?api-key=${key}` });
      res.end();
    };
    assert.deepEqual(await post(t), { kind: 'transport', bytes: 0 }); // the error (which names the URL) is dropped
  });
});
