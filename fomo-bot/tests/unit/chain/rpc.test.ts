// The request encoder and the envelope reader (docs/CHAIN_DESIGN.md s.4, step 7d): requests are written
// losslessly, only for read methods, getTransaction always with maxSupportedTransactionVersion 1;
// every transport outcome, status and node error maps to one failure kind, never a default value, and no
// failure carries the node's message (it may echo our parameters). Written before src/chain/rpc.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HttpOutcome } from '../../../src/chain/http.ts';
import type { Json } from '../../../src/core/json.ts';
import type { ReadMethod } from '../../../src/chain/limits.ts';
import { calls, COMMITMENT, encodeRequest, MAX_ACCOUNT_BYTES, MAX_KEYS, readEnvelope, type ChainFailure, type DataSlice, type RpcCall } from '../../../src/chain/rpc.ts';
import { base58Of } from '../../../src/core/encode.ts';
import { address, slot, type Address } from '../../../src/core/solana.ts';

const NOW = 1_800_000_000_000;
const NO_RATE = Object.freeze({ methodLimit: null, methodRemaining: null, retryAfterSec: null });
const ok200 = (bodyText: string): HttpOutcome => ({ kind: 'response', status: 200, rate: NO_RATE, bodyText, bytes: bodyText.length });
const status = (s: number, retryAfterSec: number | null = null): HttpOutcome => ({ kind: 'response', status: s, rate: { ...NO_RATE, retryAfterSec }, bodyText: null, bytes: 0 });

function failure(o: HttpOutcome, id = 7n): ChainFailure {
  const e = readEnvelope(o, id, NOW);
  assert.ok(!e.ok, `expected a failure, got ${JSON.stringify(e, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v))}`);
  return e.failure;
}

const nodeError = (code: number, data?: string, message = 'a node message'): string =>
  `{"jsonrpc":"2.0","error":{"code":${code},"message":"${message}"${data === undefined ? '' : `,"data":${data}`}},"id":7}`;

describe('encodeRequest: read methods only, losslessly', () => {
  it('writes the JSON-RPC request with bigints as digits', () => {
    assert.equal(
      encodeRequest(7n, 'getSlot', [{ commitment: 'confirmed', minContextSlot: 385_000_000n }]),
      '{"jsonrpc":"2.0","id":7,"method":"getSlot","params":[{"commitment":"confirmed","minContextSlot":385000000}]}',
    );
    assert.equal(encodeRequest(1n, 'getGenesisHash', []), '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash","params":[]}');
  });

  it('getTransaction always carries maxSupportedTransactionVersion 1, written here whatever the caller passed', () => {
    const sig = '1'.repeat(64);
    assert.equal(
      encodeRequest(2n, 'getTransaction', [sig, { commitment: 'confirmed', encoding: 'base64', maxSupportedTransactionVersion: 0n }]),
      `{"jsonrpc":"2.0","id":2,"method":"getTransaction","params":["${sig}",{"commitment":"confirmed","encoding":"base64","maxSupportedTransactionVersion":1}]}`,
    );
    assert.equal(encodeRequest(3n, 'getTransaction', [sig]), `{"jsonrpc":"2.0","id":3,"method":"getTransaction","params":["${sig}",{"maxSupportedTransactionVersion":1}]}`);
    assert.throws(() => encodeRequest(4n, 'getTransaction', [sig, 'not an object']), TypeError);
    assert.throws(() => encodeRequest(4n, 'getTransaction', [sig, [1n]]), TypeError);
    assert.throws(() => encodeRequest(4n, 'getTransaction', [sig, null]), TypeError);
    assert.throws(() => encodeRequest(4n, 'getTransaction', [sig, new Date(0) as unknown as Json]), TypeError, 'a config with another prototype');
    assert.throws(() => encodeRequest(4n, 'getTransaction', []), TypeError, 'no signature');
    assert.throws(() => encodeRequest(4n, 'getTransaction', [sig, {}, {}]), TypeError, 'a third param');
  });

  it('refuses a sending, refused or unknown method, an id that is not a positive bigint, and params that are not a list', () => {
    for (const m of ['sendTransaction', 'getTokenLargestAccounts', 'requestAirdrop', 'toString', ''] as unknown as ReadMethod[]) {
      assert.throws(() => encodeRequest(1n, m, []), TypeError, m);
    }
    for (const id of [0n, -1n, 1n << 63n, 1] as unknown[]) {
      assert.throws(() => encodeRequest(id as bigint, 'getSlot', []), TypeError);
    }
    assert.throws(() => encodeRequest(1n, 'getSlot', {} as unknown as []), TypeError);
  });
});

describe('readEnvelope: what the transport and the status say', () => {
  it('a transport outcome keeps its kind; a body that was not JSON text is a bad response; an oversize request is our bug', () => {
    for (const kind of ['timeout', 'shutdown', 'transport', 'too-large'] as const) {
      assert.deepEqual(failure({ kind, bytes: 3 }), { kind });
    }
    assert.deepEqual(failure({ kind: 'content-type', bytes: 0 }), { kind: 'bad-response', code: 'content-type' });
    assert.deepEqual(failure({ kind: 'utf8', bytes: 4 }), { kind: 'bad-response', code: 'utf8' });
    assert.deepEqual(failure({ kind: 'request-too-large', bytes: 0 }), { kind: 'our-bug', code: 413 });
  });

  it('429 is rate-limited until its Retry-After (60 s missing, 600 s at most); 403 is blocked; 400, 405, 413 and 415 are our bug; any other status is http', () => {
    assert.deepEqual(failure(status(429, 10)), { kind: 'rate-limited', retryAtMs: NOW + 10_000 });
    assert.deepEqual(failure(status(429)), { kind: 'rate-limited', retryAtMs: NOW + 60_000 });
    assert.deepEqual(failure(status(429, 5_000)), { kind: 'rate-limited', retryAtMs: NOW + 600_000 });
    assert.deepEqual(failure(status(403)), { kind: 'blocked' });
    for (const s of [400, 405, 413, 415]) {
      assert.deepEqual(failure(status(s)), { kind: 'our-bug', code: s });
    }
    for (const s of [204, 404, 500, 502, 503]) {
      assert.deepEqual(failure(status(s)), { kind: 'http', status: s });
    }
    // the transport gives a 200 text only with a JSON type; a 200 without one is not an answer either
    assert.deepEqual(failure(status(200)), { kind: 'bad-response', code: 'json' });
  });
});

describe('readEnvelope: the JSON-RPC envelope', () => {
  it('a result comes back exactly, integers as bigints', () => {
    assert.deepEqual(readEnvelope(ok200('{"jsonrpc":"2.0","result":18446744073709551615,"id":7}'), 7n, NOW), { ok: true, result: 18_446_744_073_709_551_615n });
    assert.deepEqual(readEnvelope(ok200('{"jsonrpc":"2.0","result":null,"id":7}'), 7n, NOW), { ok: true, result: null });
    assert.deepEqual(readEnvelope(ok200('{"id":7,"result":{"a":[1]},"jsonrpc":"2.0"}'), 7n, NOW), { ok: true, result: { a: [1n] } });
  });

  it('refuses what is not a JSON-RPC 2.0 answer to our request', () => {
    assert.deepEqual(failure(ok200('{"jsonrpc":"2.0","result":1,"id":7')), { kind: 'bad-response', code: 'json' });
    for (const bad of [
      '[]',
      '"text"',
      '{"result":1,"id":7}',
      '{"jsonrpc":"1.0","result":1,"id":7}',
      '{"jsonrpc":"2.0","id":7}',
      '{"jsonrpc":"2.0","result":1,"error":{"code":-32603,"message":"x"},"id":7}',
      '{"jsonrpc":"2.0","result":1,"id":7,"extra":true}',
      '{"jsonrpc":"2.0","result":1}',
      '{"jsonrpc":"2.0","error":{"code":-32603},"id":7}',
      '{"jsonrpc":"2.0","error":{"code":-32603,"message":1},"id":7}',
      '{"jsonrpc":"2.0","error":{"code":"-32603","message":"x"},"id":7}',
      '{"jsonrpc":"2.0","error":{"code":-32603.5,"message":"x"},"id":7}',
      '{"jsonrpc":"2.0","error":{"code":-32603,"message":"x","other":1},"id":7}',
      `{"jsonrpc":"2.0","error":{"code":-32603,"message":"${'m'.repeat(1_025)}"},"id":7}`,
      '{"jsonrpc":"2.0","error":"text","id":7}',
    ]) {
      assert.deepEqual(failure(ok200(bad)), { kind: 'bad-response', code: 'envelope' }, bad);
    }
    for (const bad of ['{"jsonrpc":"2.0","result":1,"id":8}', '{"jsonrpc":"2.0","result":1,"id":"7"}', '{"jsonrpc":"2.0","result":1,"id":7.0}', '{"jsonrpc":"2.0","result":1,"id":null}']) {
      assert.deepEqual(failure(ok200(bad)), { kind: 'bad-response', code: 'id' }, bad);
    }
  });
});

describe('readEnvelope: the node\'s error codes (s.4\'s table)', () => {
  it('maps each code to its kind, and the node\'s slot when it gives one', () => {
    for (const code of [-32700, -32600, -32601, -32602, -32015]) {
      assert.deepEqual(failure(ok200(nodeError(code))), { kind: 'our-bug', code });
    }
    assert.deepEqual(failure(ok200(nodeError(-32016, '{"contextSlot":385000000}'))), { kind: 'node-behind', code: -32016, nodeSlot: 385_000_000n });
    assert.deepEqual(failure(ok200(nodeError(-32016))), { kind: 'node-behind', code: -32016, nodeSlot: null });
    assert.deepEqual(failure(ok200(nodeError(-32016, '{"contextSlot":-1}'))), { kind: 'node-behind', code: -32016, nodeSlot: null }); // not a slot: none
    assert.deepEqual(failure(ok200(nodeError(-32005, '{"numSlotsBehind":42}'))), { kind: 'node-behind', code: -32005, nodeSlot: null });
    for (const code of [-32004, -32014, -32001, -32011, -32019]) {
      assert.deepEqual(failure(ok200(nodeError(code))), { kind: 'not-readable', code, permanent: false });
    }
    for (const code of [-32007, -32009]) {
      assert.deepEqual(failure(ok200(nodeError(code))), { kind: 'not-readable', code, permanent: true });
    }
    for (const code of [-32603, -32000, 1, -32099]) {
      assert.deepEqual(failure(ok200(nodeError(code))), { kind: 'rpc', code });
    }
  });

  it('a body error code 429 in an answer to our request is rate-limited, as the status 429 is; without "jsonrpc" it is no answer', () => {
    // the recorded limiter body (VERIFIED_FACTS s.9) comes with HTTP 429, whose body the transport drops;
    // the same body in a 200 must close the method too
    const limiterBody = '{"jsonrpc":"2.0","error":{"code":429,"message":"Too many requests for a specific RPC call"},"id":7}';
    const in200: HttpOutcome = { kind: 'response', status: 200, rate: { ...NO_RATE, retryAfterSec: 10 }, bodyText: limiterBody, bytes: limiterBody.length };
    assert.deepEqual(failure(in200), { kind: 'rate-limited', retryAtMs: NOW + 10_000 });
    assert.deepEqual(failure(ok200(nodeError(429))), { kind: 'rate-limited', retryAtMs: NOW + 60_000 });
    assert.deepEqual(failure(ok200('{"error":{"code":429,"message":"x"},"id":7}')), { kind: 'bad-response', code: 'envelope' });
  });

  it('"id": null is accepted only with a parse error or an invalid request (the node could not read our id)', () => {
    assert.deepEqual(failure(ok200('{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error"},"id":null}')), { kind: 'our-bug', code: -32700 });
    assert.deepEqual(failure(ok200('{"jsonrpc":"2.0","error":{"code":-32600,"message":"Invalid request"},"id":null}')), { kind: 'our-bug', code: -32600 });
    for (const code of [-32602, -32603, 429, -32016]) {
      assert.deepEqual(failure(ok200(`{"jsonrpc":"2.0","error":{"code":${code},"message":"x"},"id":null}`)), { kind: 'bad-response', code: 'id' }, String(code));
    }
  });

  it('an error code outside the 32-bit range is no answer (it would not survive as a number)', () => {
    assert.deepEqual(failure(ok200(nodeError(-2_147_483_648))), { kind: 'rpc', code: -2_147_483_648 });
    assert.deepEqual(failure(ok200(nodeError(2_147_483_647))), { kind: 'rpc', code: 2_147_483_647 });
    for (const code of ['-2147483649', '2147483648', '18446744073709551615']) {
      assert.deepEqual(failure(ok200(`{"jsonrpc":"2.0","error":{"code":${code},"message":"x"},"id":7}`)), { kind: 'bad-response', code: 'envelope' }, code);
    }
  });

  it('no failure carries the node\'s message, and every answer is frozen', () => {
    const secretish = 'echo of our params ABCDEFGH';
    for (const code of [-32602, -32016, -32004, -32603]) {
      const f = failure(ok200(nodeError(code, undefined, secretish)));
      assert.ok(!JSON.stringify(f).includes(secretish));
      assert.ok(Object.isFrozen(f));
    }
    assert.ok(Object.isFrozen(readEnvelope(ok200('{"jsonrpc":"2.0","result":1,"id":7}'), 7n, NOW)));
  });
});

// synthetic keys: 32 bytes counting up from 1, never a real account (the fixture scan allows these)
const key = (n: number): Address => {
  const b = new Uint8Array(32);
  b[31] = n & 255;
  b[30] = (n >> 8) & 255;
  b[0] = 7;
  return address(base58Of(b));
};
const wire = (c: RpcCall): string => encodeRequest(1n, c.method, c.params);
const S = slot(385_000_000n);

describe('the call builders: commitment confirmed and encoding base64, fixed here (R6)', () => {
  it('genesis hash, slot and block height', () => {
    assert.equal(COMMITMENT, 'confirmed');
    assert.equal(wire(calls.genesisHash()), '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash","params":[]}');
    assert.equal(wire(calls.slot(S)), '{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[{"commitment":"confirmed","minContextSlot":385000000}]}');
    assert.equal(wire(calls.blockHeight(slot(0n))), '{"jsonrpc":"2.0","id":1,"method":"getBlockHeight","params":[{"commitment":"confirmed","minContextSlot":0}]}');
    for (const bad of [-1n, 1n << 63n, 5, '5', null] as unknown[]) {
      assert.throws(() => calls.slot(bad as typeof S), TypeError);
      assert.throws(() => calls.blockHeight(bad as typeof S), TypeError);
    }
  });

  it('accounts: 1 to 100 distinct keys in order, base64, an optional slice inside 10 MiB, minContextSlot last', () => {
    const k1 = key(1);
    const k2 = key(2);
    assert.equal(
      wire(calls.accounts([k1, k2], null, S)),
      `{"jsonrpc":"2.0","id":1,"method":"getMultipleAccounts","params":[["${k1}","${k2}"],{"commitment":"confirmed","encoding":"base64","minContextSlot":385000000}]}`,
    );
    assert.equal(
      wire(calls.accounts([k2], { offset: 0, length: 8 }, S)),
      `{"jsonrpc":"2.0","id":1,"method":"getMultipleAccounts","params":[["${k2}"],{"commitment":"confirmed","encoding":"base64","dataSlice":{"offset":0,"length":8},"minContextSlot":385000000}]}`,
    );
    const hundred = Array.from({ length: MAX_KEYS }, (_v, i) => key(i + 1));
    assert.equal(MAX_KEYS, 100);
    assert.ok(wire(calls.accounts(hundred, null, S)).length < 49_152, 'a full batch fits the request cap');
    assert.throws(() => calls.accounts([], null, S), TypeError);
    assert.throws(() => calls.accounts([...hundred, key(101)], null, S), TypeError);
    assert.throws(() => calls.accounts([k1, k2, k1], null, S), TypeError);
    assert.throws(() => calls.accounts([k1, 'not an address' as Address], null, S), TypeError);
    assert.throws(() => calls.accounts(k1 as unknown as Address[], null, S), TypeError);
    assert.throws(() => calls.accounts([k1], null, -1n as typeof S), TypeError);
    assert.equal(MAX_ACCOUNT_BYTES, 10_485_760);
    assert.ok(wire(calls.accounts([k1], { offset: MAX_ACCOUNT_BYTES, length: MAX_ACCOUNT_BYTES }, S)).includes('"dataSlice":{"offset":10485760,"length":10485760}'));
    for (const slice of [{ offset: -1, length: 8 }, { offset: 0, length: MAX_ACCOUNT_BYTES + 1 }, { offset: 1.5, length: 8 }, { offset: 0, length: Number.NaN }, { offset: 0 }, { offset: 0, length: 8, extra: 1 }, [0, 8]] as unknown[]) {
      assert.throws(() => calls.accounts([k1], slice as DataSlice, S), TypeError, JSON.stringify(slice));
    }
  });

  it('priority fees for one writable account; rent for a size inside 10 MiB', () => {
    const k = key(3);
    assert.equal(wire(calls.priorityFees(k)), `{"jsonrpc":"2.0","id":1,"method":"getRecentPrioritizationFees","params":[["${k}"]]}`);
    assert.throws(() => calls.priorityFees('x' as Address), TypeError);
    assert.equal(wire(calls.rentExemptMinimum(165)), '{"jsonrpc":"2.0","id":1,"method":"getMinimumBalanceForRentExemption","params":[165,{"commitment":"confirmed"}]}');
    assert.equal(wire(calls.rentExemptMinimum(0)), '{"jsonrpc":"2.0","id":1,"method":"getMinimumBalanceForRentExemption","params":[0,{"commitment":"confirmed"}]}');
    for (const bad of [-1, MAX_ACCOUNT_BYTES + 1, 1.5, Number.NaN, 165n, '165'] as unknown[]) {
      assert.throws(() => calls.rentExemptMinimum(bad as number), TypeError);
    }
  });

  it('what they build is frozen, so no caller can change the commitment afterwards', () => {
    const c = calls.accounts([key(1)], { offset: 0, length: 8 }, S);
    assert.ok(Object.isFrozen(c) && Object.isFrozen(c.params) && Object.isFrozen(c.params[0]) && Object.isFrozen(c.params[1]));
    const cfg = c.params[1] as { readonly dataSlice: object };
    assert.ok(Object.isFrozen(cfg.dataSlice));
    assert.ok(Object.isFrozen(calls.slot(S).params[0]));
    assert.ok(Object.isFrozen(calls));
  });
});
