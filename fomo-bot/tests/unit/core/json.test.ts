// The lossless JSON reader and writer (docs/CHAIN_DESIGN.md s.3 and s.13, step 7a): every integer of an
// RPC answer is read exactly, as a bigint, and only when its source text is plain digits; anything that
// only looks like an integer (1e3, 1.50, -0) stays a JS number, which no integer field accepts. Deep
// nesting is refused before the parse. Written before src/core/json.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSON_MAX_DEPTH, parseLossless, stringifyLossless, type Json } from '../../../src/core/json.ts';

describe('parseLossless: integers exactly, as bigints, only from plain digits', () => {
  it('reads u64 values above 2^53 exactly, where JSON.parse rounds them', () => {
    assert.equal(parseLossless('18446744073709551615'), 18_446_744_073_709_551_615n); // rentEpoch on most accounts
    assert.equal(parseLossless('9007199254740993'), 9_007_199_254_740_993n);
    assert.notEqual(BigInt(JSON.parse('9007199254740993') as number), 9_007_199_254_740_993n, 'the plain parse rounds it');
    assert.equal(parseLossless('0'), 0n);
    assert.equal(parseLossless('-32016'), -32_016n); // a node error code is an integer like any other
  });

  it('a run of more than 20 digits stays a JS number: a u64 needs at most 20, so a huge digit string costs nothing (review X, security 4)', () => {
    assert.equal(parseLossless('99999999999999999999'), 99_999_999_999_999_999_999n); // 20 digits: read
    assert.equal(parseLossless('-99999999999999999999'), -99_999_999_999_999_999_999n);
    assert.equal(typeof parseLossless('123456789012345678901'), 'number'); // 21 digits
    assert.equal(typeof parseLossless('-123456789012345678901'), 'number');
    const started = performance.now();
    assert.equal(typeof parseLossless('9'.repeat(1_000_000)), 'number');
    assert.ok(performance.now() - started < 1_000, 'a million digits are not turned into a bigint');
  });

  it('keeps every other number spelling a JS number (no integer field accepts one), -0 included', () => {
    assert.equal(parseLossless('1e3'), 1000);
    assert.equal(parseLossless('1E3'), 1000);
    assert.equal(parseLossless('1.50'), 1.5);
    assert.equal(parseLossless('1.0'), 1);
    assert.equal(parseLossless('2e-1'), 0.2);
    assert.ok(Object.is(parseLossless('-0'), -0));
    assert.equal(typeof parseLossless('1e400'), 'number'); // Infinity: still not an integer field's bigint
  });

  it('converts inside arrays and objects, leaves strings, booleans and null alone, and freezes what it builds', () => {
    const v = parseLossless('{"jsonrpc":"2.0","id":7,"result":{"context":{"slot":385000000,"apiVersion":"4.4.0"},"value":[null,{"lamports":5,"rentEpoch":18446744073709551615,"executable":false,"data":["","base64"]}]}}');
    assert.deepEqual(v, {
      jsonrpc: '2.0',
      id: 7n,
      result: {
        context: { slot: 385_000_000n, apiVersion: '4.4.0' },
        value: [null, { lamports: 5n, rentEpoch: 18_446_744_073_709_551_615n, executable: false, data: ['', 'base64'] }],
      },
    });
    const top = v as { readonly result: { readonly value: readonly Json[] } };
    assert.ok(Object.isFrozen(v) && Object.isFrozen(top.result) && Object.isFrozen(top.result.value) && Object.isFrozen(top.result.value[1]));
    assert.equal(parseLossless('"123"'), '123');
    assert.equal(parseLossless('true'), true);
    assert.equal(parseLossless('null'), null);
  });

  it('a duplicate key: the last one wins, as JSON.parse does (accepted, review Y, security 5)', () => {
    assert.deepEqual(parseLossless('{"id":8,"result":1,"id":7}'), { id: 7n, result: 1n });
  });

  it('a "__proto__" key is an own property, never the prototype', () => {
    const v = parseLossless('{"__proto__":{"polluted":1},"a":1}') as Record<string, Json>;
    assert.equal(Object.getPrototypeOf(v), Object.prototype);
    assert.ok(Object.hasOwn(v, '__proto__'));
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  });

  it(`refuses nesting deeper than ${JSON_MAX_DEPTH} as a SyntaxError, counting only brackets outside strings`, () => {
    const nested = (depth: number): string => '['.repeat(depth) + ']'.repeat(depth);
    assert.deepEqual(parseLossless(nested(JSON_MAX_DEPTH)), JSON.parse(nested(JSON_MAX_DEPTH)) as Json);
    assert.throws(() => parseLossless(nested(JSON_MAX_DEPTH + 1)), SyntaxError);
    assert.throws(() => parseLossless('{"a":'.repeat(JSON_MAX_DEPTH + 1) + '1' + '}'.repeat(JSON_MAX_DEPTH + 1)), SyntaxError);
    assert.throws(() => parseLossless(nested(200_000)), SyntaxError);
    // brackets inside strings, escaped quotes included, are text
    const text = JSON.stringify({ s: '['.repeat(500) + '\\"[' + '{'.repeat(500) });
    assert.deepEqual(parseLossless(text), JSON.parse(text) as Json);
  });

  it('refuses what is not JSON as a SyntaxError, and what is not a string as a TypeError', () => {
    for (const bad of ['', '{', '01', '+1', '.5', '1.', 'NaN', "{'a':1}", '[1,]', '"\\x41"', '{"a":1}x']) {
      assert.throws(() => parseLossless(bad), SyntaxError, bad);
    }
    for (const notText of [undefined, null, 1, 1n, {}, []] as unknown[]) {
      assert.throws(() => parseLossless(notText as string), TypeError);
    }
  });
});

describe('stringifyLossless: bigints as digits, nothing JSON would write silently wrong', () => {
  it('writes bigints as plain digits and everything else as JSON.stringify does', () => {
    assert.equal(stringifyLossless(18_446_744_073_709_551_615n), '18446744073709551615');
    assert.equal(stringifyLossless(-32_016n), '-32016');
    assert.equal(
      stringifyLossless({ jsonrpc: '2.0', id: 1n, method: 'getMultipleAccounts', params: [['So11111111111111111111111111111111111111112'], { commitment: 'confirmed', encoding: 'base64', minContextSlot: 385_000_000n }] }),
      '{"jsonrpc":"2.0","id":1,"method":"getMultipleAccounts","params":[["So11111111111111111111111111111111111111112"],{"commitment":"confirmed","encoding":"base64","minContextSlot":385000000}]}',
    );
    assert.equal(stringifyLossless([true, false, null, 1.5, 'a"b\\c\n']), '[true,false,null,1.5,"a\\"b\\\\c\\n"]');
    assert.equal(stringifyLossless({}), '{}');
    assert.equal(stringifyLossless([]), '[]');
  });

  it('round-trips through parseLossless', () => {
    const v: Json = { a: [1n, 2n, { b: null, c: 'x', d: [true] }], e: 18_446_744_073_709_551_615n, f: -7n, g: 0.25 };
    assert.deepEqual(parseLossless(stringifyLossless(v)), v);
  });

  it('refuses NaN, the infinities, undefined, functions, symbols and nesting past the limit (JSON.stringify would drop or rewrite them)', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, undefined, () => 1, Symbol('s')] as unknown[]) {
      assert.throws(() => stringifyLossless(bad as Json), TypeError);
      assert.throws(() => stringifyLossless([bad] as unknown as Json), TypeError);
      assert.throws(() => stringifyLossless({ k: bad } as unknown as Json), TypeError);
    }
    // a hole on purpose: JSON.stringify would write null there, and a map would write ",,"
    assert.throws(() => stringifyLossless([1n, , 2n] as unknown as Json), TypeError);
    // only plain objects: a Date, a Map or a class instance would be written wrong (or as {})
    for (const notPlain of [new Date(0), new Map([['a', 1]]), Object.create({ inherited: 1 }) as object, new Uint8Array(2)] as unknown[]) {
      assert.throws(() => stringifyLossless(notPlain as Json), TypeError);
    }
    const bare = Object.create(null) as Record<string, Json>;
    bare['k'] = 1n;
    assert.equal(stringifyLossless(bare), '{"k":1}', 'an object without a prototype is plain');
    assert.equal(stringifyLossless(parseLossless('{"a":[1,{"b":2}]}')), '{"a":[1,{"b":2}]}', 'what parseLossless builds (frozen) writes back');
    let deep: Json = 1n;
    for (let i = 0; i < JSON_MAX_DEPTH; i += 1) {
      deep = [deep];
    }
    assert.equal(stringifyLossless(deep).length, 2 * JSON_MAX_DEPTH + 1);
    assert.throws(() => stringifyLossless([deep]), TypeError);
  });
});
