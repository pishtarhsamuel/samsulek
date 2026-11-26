// The read client (docs/CHAIN_DESIGN.md s.3, s.4, s.5, s.8 and s.13, step 7e): the genesis lock, the
// commitment and encoding fixed on the wire, the minContextSlot mark that rises only with slots the feed
// accepts (review X, risk 1), went-back and staleness at 150 slots, slot reports to 'http' only, the
// request-size check before the budget, the settle in `finally` (a body 429 settled as 429), the events,
// the failure rules (review Y, risk 8) and the type that has no way to send. A fake transport answers
// from synthetic fixtures; the real budget governor runs on a hand clock. Written before src/chain/client.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBudgetGovernor } from '../../../src/chain/budget.ts';
import {
  createReadClient,
  FAILURE_RULES,
  STALE_SLOTS,
  type CallOpts,
  type ReadClient,
} from '../../../src/chain/client.ts';
import { rentFormula } from '../../../src/chain/decode.ts';
import type { ChainEvent } from '../../../src/chain/events.ts';
import type { HttpOutcome, HttpRequest, HttpTransport } from '../../../src/chain/http.ts';
import { METHOD_TABLE, type ReadMethod } from '../../../src/chain/limits.ts';
import { MAINNET_GENESIS_HASH, PUBLIC_MAINNET } from '../../../src/chain/providers.ts';
import type { ChainFailure, ChainResult } from '../../../src/chain/rpc.ts';
import { base58Of, base64Of } from '../../../src/core/encode.ts';
import { parseLossless, stringifyLossless, type Json } from '../../../src/core/json.ts';
import { address, type Address } from '../../../src/core/solana.ts';

const DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const FEED = 385_000_000n;
const NO_RATE = Object.freeze({ methodLimit: null, methodRemaining: null, retryAfterSec: null });
const P0: CallOpts = Object.freeze({ priority: 'P0', feature: 'exit-marks' });

// synthetic keys from bytes (the fixture scan allows no literal addresses)
const key = (n: number): Address => {
  const b = new Uint8Array(32);
  b[0] = 9;
  b[31] = n;
  return address(base58Of(b));
};

interface Sent {
  readonly id: bigint;
  readonly method: ReadMethod;
  readonly params: readonly Json[];
  readonly text: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

const ok200 = (bodyText: string, retryAfterSec: number | null = null): HttpOutcome => ({ kind: 'response', status: 200, rate: { ...NO_RATE, retryAfterSec }, bodyText, bytes: bodyText.length });
const result = (s: Sent, r: Json): HttpOutcome => ok200(`{"jsonrpc":"2.0","result":${stringifyLossless(r)},"id":${s.id}}`);
const nodeError = (s: Sent, code: number, data = ''): HttpOutcome => ok200(`{"jsonrpc":"2.0","error":{"code":${code},"message":"m"${data}},"id":${s.id}}`);

const ACCOUNT_DATA = Uint8Array.from({ length: 82 }, (_v, i) => i);
const accountJson = (): Json => ({ data: [base64Of(ACCOUNT_DATA), 'base64'], executable: false, lamports: 1_461_600n, owner: TOKEN_PROGRAM, rentEpoch: (1n << 64n) - 1n, space: 82n });

type Answer = (s: Sent, w: World) => HttpOutcome | Promise<HttpOutcome>;

interface World {
  client: ReadClient;
  sent: Sent[];
  events: ChainEvent[];
  reports: [string, unknown][];
  feed: bigint | null;
  contextSlot: bigint;
  apiVersion: string;
  mono: number;
  answer: Answer;
  codes(): string[];
  usage(bucket: string): number | undefined;
}

/** The fixture answers, method by method, at the world's context slot. */
const fixtures: Answer = (s, w) => {
  switch (s.method) {
    case 'getGenesisHash':
      return result(s, MAINNET_GENESIS_HASH);
    case 'getSlot':
      return result(s, w.contextSlot);
    case 'getBlockHeight':
      return result(s, 350_000_000n);
    case 'getMultipleAccounts': {
      const keys = s.params[0] as readonly Json[];
      return result(s, { context: { apiVersion: w.apiVersion, slot: w.contextSlot }, value: keys.map((_k, i) => (i === 1 ? null : accountJson())) });
    }
    case 'getRecentPrioritizationFees':
      return result(s, [{ slot: w.contextSlot - 1n, prioritizationFee: 26_041n }, { slot: w.contextSlot - 2n, prioritizationFee: 0n }]);
    case 'getMinimumBalanceForRentExemption':
      return result(s, rentFormula(Number(s.params[0] as bigint)));
    default:
      throw new Error(`no fixture for ${s.method}`);
  }
};

function world(o: { tighten?: { maxRequestBytes?: number }; throwingSink?: boolean } = {}): World {
  const w = {
    sent: [] as Sent[],
    events: [] as ChainEvent[],
    reports: [] as [string, unknown][],
    feed: FEED as bigint | null,
    contextSlot: FEED,
    apiVersion: '4.4.0',
    mono: 1_000_000,
    answer: fixtures,
  } as World;
  const sink = {
    event: (e: ChainEvent): void => {
      w.events.push(e);
      if (o.throwingSink === true) {
        throw new Error('the sink failed');
      }
    },
  };
  const mono = { nowMs: (): number => w.mono };
  const budget = createBudgetGovernor({ provider: 'public-mainnet', mono, events: sink });
  const transport: HttpTransport = {
    post: (r: HttpRequest) => {
      const body = parseLossless(r.bodyText) as { readonly id: bigint; readonly method: ReadMethod; readonly params: readonly Json[] };
      const s: Sent = { id: body.id, method: body.method, params: body.params, text: r.bodyText, timeoutMs: r.timeoutMs, maxBytes: r.maxBytes };
      w.sent.push(s);
      return Promise.resolve(w.answer(s, w));
    },
  };
  w.client = createReadClient({
    endpoint: PUBLIC_MAINNET,
    transport,
    budget,
    mono,
    slots: { report: (channel, s) => w.reports.push([channel, s]), currentSlot: () => w.feed },
    events: sink,
    ...(o.tighten === undefined ? {} : { tighten: o.tighten }),
  });
  w.codes = () => w.events.map((e) => e.code);
  w.usage = (bucket) => budget.usage().find((u) => u.bucket === bucket)?.used;
  return w;
}

async function verified(o: Parameters<typeof world>[0] = {}): Promise<World> {
  const w = world(o);
  assert.deepEqual(await w.client.verifyCluster(), { ok: true, value: 'mainnet-beta', contextSlot: null, latencyMs: 0 });
  w.sent.length = 0;
  return w;
}

function failed<T>(r: ChainResult<T>): ChainFailure {
  assert.ok(!r.ok, `expected a failure, got ${JSON.stringify(r, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v))}`);
  return r.failure;
}

function value<T>(r: ChainResult<T>): T {
  assert.ok(r.ok, `expected a value, got ${r.ok ? '' : JSON.stringify(r.failure)}`);
  return r.value;
}

describe('the genesis lock (s.8)', () => {
  it('every call is unverified, and sends nothing, until the genesis hash is mainnet-beta', async () => {
    const w = world();
    assert.equal(w.client.needsClusterCheck(), true);
    assert.deepEqual(failed(await w.client.slot(P0)), { kind: 'unverified' });
    assert.deepEqual(failed(await w.client.accounts([key(1)], P0)), { kind: 'unverified' });
    assert.deepEqual(failed(await w.client.rentExemptMinimum(165, P0)), { kind: 'unverified' });
    assert.equal(w.sent.length, 0);
    assert.equal(w.usage('total'), 0, 'not even the budget was asked');
    assert.equal(value(await w.client.verifyCluster()), 'mainnet-beta');
    assert.deepEqual(w.sent.map((s) => [s.method, s.params]), [['getGenesisHash', []]]);
    assert.equal(w.client.needsClusterCheck(), false);
    assert.equal(value(await w.client.slot(P0)), FEED);
  });

  it('a failed check leaves it unverified; another hash latches wrong-cluster until a restart, with one event and no more requests', async () => {
    const w = world();
    w.answer = () => ({ kind: 'timeout', bytes: 0 });
    assert.deepEqual(failed(await w.client.verifyCluster()), { kind: 'timeout' });
    assert.deepEqual(failed(await w.client.slot(P0)), { kind: 'unverified' });
    w.mono += 10_000; // getGenesisHash: one per 10 s
    w.answer = (s) => result(s, DEVNET);
    assert.deepEqual(failed(await w.client.verifyCluster()), { kind: 'wrong-cluster' });
    assert.deepEqual(failed(await w.client.slot(P0)), { kind: 'wrong-cluster' });
    w.mono += 10_000;
    w.answer = fixtures; // even a right answer later changes nothing
    const before = w.sent.length;
    assert.deepEqual(failed(await w.client.verifyCluster()), { kind: 'wrong-cluster' });
    assert.equal(w.sent.length, before, 'latched: no request');
    assert.equal(w.client.needsClusterCheck(), false);
    assert.deepEqual(w.events.filter((e) => e.code === 'chain-wrong-cluster'), [{ code: 'chain-wrong-cluster', provider: 'public-mainnet', method: 'getGenesisHash' }]);
    const v = world();
    v.answer = (s) => result(s, 5n);
    assert.deepEqual(failed(await v.client.verifyCluster()), { kind: 'bad-response', code: 'shape' }, 'not a hash at all: no latch');
    v.mono += 10_000;
    v.answer = fixtures;
    assert.equal(value(await v.client.verifyCluster()), 'mainnet-beta');
  });

  it('the check is due again after an hour; a wrong hash then latches too, while a failed re-check keeps the calls open', async () => {
    const w = await verified();
    w.mono += 3_599_999;
    assert.equal(w.client.needsClusterCheck(), false);
    w.mono += 1;
    assert.equal(w.client.needsClusterCheck(), true);
    w.answer = () => ({ kind: 'transport', bytes: 0 });
    assert.deepEqual(failed(await w.client.verifyCluster()), { kind: 'transport' });
    w.answer = fixtures;
    assert.equal(value(await w.client.slot(P0)), FEED, 'a re-check that could not run does not stop reads (exits)');
    assert.equal(w.client.needsClusterCheck(), true);
    w.mono += 10_000;
    w.answer = (s) => (s.method === 'getGenesisHash' ? result(s, DEVNET) : fixtures(s, w));
    assert.deepEqual(failed(await w.client.verifyCluster()), { kind: 'wrong-cluster' });
    assert.deepEqual(failed(await w.client.slot(P0)), { kind: 'wrong-cluster' });
  });
});

describe('the wire: fixed commitment, encoding and limits (R6)', () => {
  it('every request says confirmed and base64 where it applies, minContextSlot always, and uses its method\'s timeout and byte cap', async () => {
    const w = await verified();
    await w.client.slot(P0);
    await w.client.blockHeight(P0);
    await w.client.accounts([key(1), key(2)], { ...P0, slice: { offset: 0, length: 82 } });
    await w.client.priorityFees(key(3), { priority: 'P2', feature: 'fees' });
    await w.client.rentExemptMinimum(165, { priority: 'P0', feature: 'rent' }); // its one per 10 s is P0's (s.5)
    const m = FEED; // the mark after the first read
    assert.deepEqual(
      w.sent.map((s) => s.text.replace(/"id":[0-9]+/, '"id":N')),
      [
        '{"jsonrpc":"2.0","id":N,"method":"getSlot","params":[{"commitment":"confirmed","minContextSlot":0}]}',
        `{"jsonrpc":"2.0","id":N,"method":"getBlockHeight","params":[{"commitment":"confirmed","minContextSlot":${m}}]}`,
        `{"jsonrpc":"2.0","id":N,"method":"getMultipleAccounts","params":[["${key(1)}","${key(2)}"],{"commitment":"confirmed","encoding":"base64","dataSlice":{"offset":0,"length":82},"minContextSlot":${m}}]}`,
        `{"jsonrpc":"2.0","id":N,"method":"getRecentPrioritizationFees","params":[["${key(3)}"]]}`,
        '{"jsonrpc":"2.0","id":N,"method":"getMinimumBalanceForRentExemption","params":[165,{"commitment":"confirmed"}]}',
      ],
    );
    for (const s of w.sent) {
      assert.equal(s.timeoutMs, METHOD_TABLE[s.method].timeoutMs);
      assert.equal(s.maxBytes, METHOD_TABLE[s.method].maxResponseBytes);
    }
    const ids = w.sent.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, 'a fresh id for every request');
  });

  it('call options are checked: a priority P0 to P4 and a known feature', async () => {
    const w = await verified();
    for (const bad of [{ priority: 'P5', feature: 'exit-marks' }, { priority: 'P0', feature: 'nope' }, {}, null] as unknown[]) {
      await assert.rejects(w.client.slot(bad as CallOpts), TypeError);
    }
    assert.equal(w.sent.length, 0);
  });
});

describe('reads never go backwards (s.5; review X, risk 1)', () => {
  it('the mark rises only with slots the feed accepts: one wild answer cannot make every honest node look behind', async () => {
    const w = await verified();
    w.contextSlot = FEED + 1_000_000n; // a buggy, forked or lying node
    assert.ok(value(await w.client.accounts([key(1)], P0)));
    w.contextSlot = FEED; // honest nodes, at the feed's slot
    assert.ok(value(await w.client.accounts([key(1)], P0)), 'an honest read still succeeds');
    assert.ok(w.sent[1]?.text.includes(`"minContextSlot":${FEED}}`), 'the mark stopped at the feed');
    w.feed = null; // the feed lost the slot: the mark does not move at all
    w.contextSlot = FEED + 50n;
    await w.client.slot(P0);
    await w.client.blockHeight(P0);
    assert.ok(w.sent[3]?.text.includes(`"minContextSlot":${FEED}}`));
    w.feed = FEED + 60n; // the feed moved on: the next context slot raises the mark, up to it
    w.contextSlot = FEED + 55n;
    await w.client.slot(P0);
    await w.client.blockHeight(P0);
    assert.ok(w.sent[5]?.text.includes(`"minContextSlot":${FEED + 55n}}`));
  });

  it('an answer below the minContextSlot sent is went-back, for a context and for getSlot itself (review Y, risk 8d); it is not used or reported', async () => {
    const w = await verified();
    await w.client.slot(P0); // mark: FEED
    w.reports.length = 0;
    w.contextSlot = FEED - 1n;
    assert.deepEqual(failed(await w.client.accounts([key(1)], P0)), { kind: 'bad-response', code: 'went-back' });
    assert.deepEqual(failed(await w.client.slot(P0)), { kind: 'bad-response', code: 'went-back' });
    assert.deepEqual(w.reports, []);
    assert.deepEqual(w.events.filter((e) => e.code === 'chain-stale').map((e) => e.method), ['getMultipleAccounts', 'getSlot']);
    w.contextSlot = FEED; // equal to the mark: fine
    assert.ok(value(await w.client.accounts([key(1)], P0)));
  });

  it(`a context more than ${STALE_SLOTS} slots behind the feed is stale, never used or reported; exactly ${STALE_SLOTS} is fresh`, async () => {
    assert.equal(STALE_SLOTS, 150n);
    const w = await verified();
    w.feed = FEED + 151n;
    assert.deepEqual(failed(await w.client.accounts([key(1)], P0)), { kind: 'stale', contextSlot: FEED });
    assert.deepEqual(failed(await w.client.slot(P0)), { kind: 'stale', contextSlot: FEED });
    assert.deepEqual(w.reports, []);
    assert.ok(w.codes().includes('chain-stale'));
    w.feed = FEED + 150n;
    const r = await w.client.accounts([key(1)], P0);
    assert.ok(r.ok && r.contextSlot === FEED);
    w.feed = null; // no feed slot: staleness cannot be judged here (DATA_STALE is the app's)
    assert.ok((await w.client.slot(P0)).ok);
  });

  it("reports go to 'http' only, never 'http-2' (R4): every slot() result and every read's context slot, and nothing else", async () => {
    const w = await verified();
    await w.client.slot(P0);
    await w.client.accounts([key(1)], P0);
    await w.client.blockHeight(P0);
    await w.client.priorityFees(key(2), P0);
    await w.client.rentExemptMinimum(0, P0);
    await w.client.verifyCluster();
    assert.deepEqual(w.reports, [['http', FEED], ['http', FEED]]);
  });
});

describe('the budget: asked first, always settled', () => {
  it('a request over the size cap is our bug, refused before the budget is asked (s.4)', async () => {
    const w = await verified({ tighten: { maxRequestBytes: 120 } });
    assert.deepEqual(failed(await w.client.accounts([key(1), key(2)], P0)), { kind: 'our-bug', code: 413 });
    assert.equal(w.sent.length, 0);
    assert.equal(w.usage('getMultipleAccounts'), 0);
    assert.deepEqual(w.events.filter((e) => e.code === 'chain-our-bug'), [{ code: 'chain-our-bug', provider: 'public-mainnet', method: 'getMultipleAccounts' }]);
    assert.ok((await w.client.slot(P0)).ok, 'a small request still goes');
    for (const bad of [0, 49_153, 1.5]) {
      assert.throws(() => world({ tighten: { maxRequestBytes: bad } }), TypeError, 'only tightened, to a whole number');
    }
  });

  it('a denial is returned as denied, with its reason and time, and nothing is sent', async () => {
    const w = await verified();
    w.answer = () => ({ kind: 'response', status: 403, rate: NO_RATE, bodyText: null, bytes: 0 });
    assert.deepEqual(failed(await w.client.slot(P0)), { kind: 'blocked' });
    const before = w.sent.length;
    const f = failed(await w.client.accounts([key(1)], P0));
    assert.equal(f.kind, 'denied');
    assert.ok(f.kind === 'denied' && f.reason === 'blocked' && f.retryAtMs === w.mono + 900_000);
    assert.equal(w.sent.length, before);
  });

  it('a body 429 closes the method like a status 429 (s.20): settled as 429', async () => {
    const w = await verified();
    w.answer = (s) => (s.method === 'getMultipleAccounts' ? nodeError(s, 429) : fixtures(s, w));
    assert.deepEqual(failed(await w.client.accounts([key(1)], P0)), { kind: 'rate-limited', retryAtMs: w.mono + 60_000 });
    const f = failed(await w.client.accounts([key(1)], P0));
    assert.ok(f.kind === 'denied' && f.reason === 'retry-after', 'the governor closed the method');
    assert.ok(w.codes().includes('chain-429'));
    assert.ok((await w.client.slot(P0)).ok, 'other methods stay open');
  });

  it('the ticket is settled even when the transport throws or rejects (a bug): the connection slot comes back', async () => {
    const w = await verified();
    w.answer = () => {
      throw new Error('transport bug');
    };
    await assert.rejects(w.client.slot(P0), /transport bug/);
    w.answer = () => Promise.reject(new Error('transport bug 2'));
    await assert.rejects(w.client.accounts([key(1)], P0), /transport bug 2/);
    assert.equal(w.usage('connections'), 0);
    w.answer = fixtures;
    assert.ok((await w.client.slot(P0)).ok);
  });

  it('latency is the monotonic time the request took', async () => {
    const w = await verified();
    w.answer = (s) => {
      w.mono += 37;
      return fixtures(s, w);
    };
    const r = await w.client.slot(P0);
    assert.ok(r.ok && r.latencyMs === 37);
  });
});

describe('answers: values exactly, failures with their events', () => {
  it('accounts come back in key order, null for a missing one (never a zero account; review Y, risk 8a), with the context slot', async () => {
    const w = await verified();
    const r = await w.client.accounts([key(1), key(2), key(3)], P0);
    assert.ok(r.ok);
    assert.equal(r.contextSlot, FEED);
    assert.equal(r.value.length, 3);
    assert.equal(r.value[1], null);
    assert.equal(r.value[0]?.lamports, 1_461_600n);
    assert.deepEqual([...(r.value[2]?.data ?? [])], [...ACCOUNT_DATA]);
  });

  it('an empty fee list comes back empty, never as a fee of 0 (review Y, risk 8a); fees come back sorted', async () => {
    const w = await verified();
    assert.deepEqual(value(await w.client.priorityFees(key(1), P0)), [{ slot: FEED - 2n, fee: 0n }, { slot: FEED - 1n, fee: 26_041n }]);
    w.answer = (s) => result(s, []);
    assert.deepEqual(value(await w.client.priorityFees(key(1), P0)), []);
  });

  it("rent: the chain's value always wins; a value off the formula fires chain-rent-formula", async () => {
    const w = await verified();
    assert.equal(value(await w.client.rentExemptMinimum(165, P0)), 1_488_440n);
    assert.ok(!w.codes().includes('chain-rent-formula'));
    w.mono += 10_000; // one per 10 s
    w.answer = (s) => result(s, 2_039_280n); // the old rate
    assert.equal(value(await w.client.rentExemptMinimum(165, P0)), 2_039_280n);
    assert.deepEqual(w.events.filter((e) => e.code === 'chain-rent-formula'), [{ code: 'chain-rent-formula', provider: 'public-mainnet', method: 'getMinimumBalanceForRentExemption' }]);
  });

  it('a shape refused is chain-shape; our bug is chain-our-bug; a node behind and a missing block are plain failures', async () => {
    const w = await verified();
    w.answer = (s) => result(s, { context: { apiVersion: '4.4.0', slot: FEED }, value: [] });
    assert.deepEqual(failed(await w.client.accounts([key(1)], P0)), { kind: 'bad-response', code: 'count' });
    w.answer = (s) => result(s, 1.5 as unknown as Json);
    assert.deepEqual(failed(await w.client.blockHeight(P0)), { kind: 'bad-response', code: 'shape' });
    w.answer = (s) => ok200(`{"jsonrpc":"2.0","result":1,"id":${s.id + 1n}}`);
    assert.deepEqual(failed(await w.client.blockHeight(P0)), { kind: 'bad-response', code: 'id' });
    assert.deepEqual(w.events.filter((e) => e.code === 'chain-shape').map((e) => e.method), ['getMultipleAccounts', 'getBlockHeight', 'getBlockHeight']);
    w.answer = (s) => nodeError(s, -32602);
    assert.deepEqual(failed(await w.client.slot(P0)), { kind: 'our-bug', code: -32602 });
    assert.ok(w.codes().includes('chain-our-bug'));
    w.answer = (s) => result(s, -5n);
    assert.deepEqual(failed(await w.client.slot(P0)), { kind: 'bad-response', code: 'shape' }, 'a slot that is no slot');
    assert.equal(w.events.at(-1)?.code, 'chain-shape');
    assert.deepEqual(w.reports, [], 'and nothing reported');
    const before = w.events.length;
    w.answer = (s) => nodeError(s, -32016, ',"data":{"contextSlot":384999999}');
    assert.deepEqual(failed(await w.client.slot(P0)), { kind: 'node-behind', code: -32016, nodeSlot: 384_999_999n });
    w.answer = () => ({ kind: 'timeout', bytes: 0 });
    assert.deepEqual(failed(await w.client.slot(P0)), { kind: 'timeout' });
    assert.equal(w.events.length, before, 'no event: the app counts these toward its breakers');
  });

  it('apiVersion: the first one is kept, each change fires one event, the version only in its plain form (review Y, security 8)', async () => {
    const w = await verified();
    await w.client.accounts([key(1)], P0);
    await w.client.accounts([key(1)], P0);
    assert.ok(!w.codes().includes('chain-api-version'));
    w.apiVersion = '4.5.0';
    await w.client.accounts([key(1)], P0);
    await w.client.accounts([key(1)], P0);
    w.apiVersion = '4.5.0-beta <script>';
    await w.client.accounts([key(1)], P0);
    assert.deepEqual(w.events.filter((e) => e.code === 'chain-api-version'), [
      { code: 'chain-api-version', provider: 'public-mainnet', method: 'getMultipleAccounts', apiVersion: '4.5.0' },
      { code: 'chain-api-version', provider: 'public-mainnet', method: 'getMultipleAccounts' },
    ]);
  });

  it('a sink that throws never stops a read', async () => {
    const w = await verified({ throwingSink: true });
    w.answer = (s) => result(s, 2_039_280n);
    assert.equal(value(await w.client.rentExemptMinimum(165, P0)), 2_039_280n);
    assert.ok(w.events.length > 0);
  });

  it('every result is frozen', async () => {
    const w = await verified();
    const r = await w.client.accounts([key(1)], P0);
    assert.ok(Object.isFrozen(r) && r.ok && Object.isFrozen(r.value));
    assert.ok(Object.isFrozen(await w.client.verifyCluster()));
    assert.ok(Object.isFrozen(w.client));
  });
});

describe('what each failure means to the app (review Y, risk 8b)', () => {
  it('every failure kind has its rule: a breaker of RISK_POLICY s.8 or a named latch', () => {
    assert.deepEqual(FAILURE_RULES, {
      unverified: 'CLUSTER',
      'wrong-cluster': 'CLUSTER',
      blocked: 'PROVIDER_BLOCKED',
      shutdown: 'STOPPING',
      timeout: 'RPC_ERRORS',
      transport: 'RPC_ERRORS',
      'too-large': 'RPC_ERRORS',
      denied: 'RPC_ERRORS',
      'rate-limited': 'RPC_ERRORS',
      http: 'RPC_ERRORS',
      'bad-response': 'RPC_ERRORS',
      'our-bug': 'BUG',
      'node-behind': 'DATA_STALE',
      'not-readable': 'RPC_ERRORS',
      stale: 'DATA_STALE',
      rpc: 'RPC_ERRORS',
    });
    assert.ok(Object.isFrozen(FAILURE_RULES));
  });
});

describe('the type has no way to send (s.3)', () => {
  it('no send, sign or generic rpc member; ReadMethod has no sending method', () => {
    type NoSendMember = Extract<keyof ReadClient, `send${string}` | `sign${string}` | 'rpc' | 'request'>;
    type NoSendMethod = Extract<ReadMethod, `send${string}` | 'requestAirdrop'>;
    const members: [NoSendMember] extends [never] ? true : false = true;
    const methods: [NoSendMethod] extends [never] ? true : false = true;
    assert.ok(members && methods);
    const w = world();
    // @ts-expect-error: the read client cannot send
    assert.equal(w.client.sendTransaction, undefined);
    // @ts-expect-error: and has no generic door a send could pass through
    assert.equal(w.client.rpc, undefined);
    assert.deepEqual(Object.keys(w.client).sort(), ['accounts', 'blockHeight', 'needsClusterCheck', 'priorityFees', 'provider', 'rentExemptMinimum', 'slot', 'verifyCluster']);
    assert.equal(w.client.provider, 'public-mainnet');
  });
});
