// The strict decoders of core/encode.ts (docs/CHAIN_DESIGN.md s.2 and s.13, step 7a): base58 of exactly
// N bytes in its one canonical form (no padding of a short number, as lenient decoders do), and padded
// base64 in its one canonical form (no stray bits, no whitespace, no base64url), each with a size bound
// checked before decoding. Bad data is null; a call that is not a string is a TypeError. Checked against
// Node's Buffer, which the source itself may not use. Written before the decoders.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fc from 'fast-check';
import { base58Exact, base58Of, base64Of, base64Strict } from '../../../src/core/encode.ts';

const bytes = (...b: number[]): Uint8Array => Uint8Array.from(b);

describe('base58Exact: the canonical base58 of exactly N bytes, or null', () => {
  it('decodes known addresses and the mainnet genesis hash to 32 bytes that encode back', () => {
    for (const text of ['11111111111111111111111111111111', 'So11111111111111111111111111111111111111112', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d']) {
      const b = base58Exact(text, 32);
      assert.ok(b !== null && b.length === 32, text);
      assert.equal(base58Of(b), text);
    }
    assert.deepEqual(base58Exact('11111111111111111111111111111111', 32), new Uint8Array(32)); // the system program: 32 zero bytes
  });

  it('round-trips random 32- and 64-byte values, leading zero bytes included', () => {
    fc.assert(
      fc.property(fc.constantFrom(32, 64), fc.nat({ max: 5 }), fc.uint8Array({ minLength: 64, maxLength: 64 }), (n, zeros, raw) => {
        const value = raw.slice(0, n);
        value.fill(0, 0, Math.min(zeros, n));
        const text = base58Of(value);
        assert.deepEqual(base58Exact(text, n), value);
        assert.equal(base58Exact(text, n === 32 ? 64 : 32), null, 'never another length');
      }),
      { numRuns: 500 },
    );
  });

  it('refuses a short number without its leading "1"s (a lenient decoder pads it), extra "1"s, other lengths and foreign characters', () => {
    const value = bytes(0, ...Array.from({ length: 31 }, (_, i) => i + 1));
    const canonical = base58Of(value);
    assert.ok(canonical.startsWith('1'));
    assert.equal(base58Exact(canonical.slice(1), 32), null, 'the same number without its leading zero byte is 31 bytes');
    assert.equal(base58Exact(`1${canonical}`, 32), null, 'an extra leading zero byte makes 33');
    assert.equal(base58Exact(base58Of(new Uint8Array(31).fill(7)), 32), null);
    assert.equal(base58Exact(base58Of(new Uint8Array(33).fill(7)), 32), null);
    const mint = 'So11111111111111111111111111111111111111112';
    for (const ch of ['0', 'O', 'I', 'l', '+', '/', '=', ' ', '\n', 'é']) {
      assert.equal(base58Exact(`${ch}${canonical.slice(1)}`, 32), null, `"${ch}" first`);
      // anywhere in the text, where the decoded number would still be 32 bytes long
      for (const at of [1, 20, mint.length - 1]) {
        assert.equal(base58Exact(mint.slice(0, at) + ch + mint.slice(at + 1), 32), null, `"${ch}" at ${at}`);
      }
    }
    assert.equal(base58Exact('', 32), null);
    assert.equal(base58Exact('2'.repeat(65), 32), null, 'too long to be 32 bytes, refused before decoding');
    assert.equal(base58Exact('z'.repeat(10_000), 64), null);
    // refused by its length alone: decoding 200,000 characters first would take seconds
    const started = performance.now();
    assert.equal(base58Exact('z'.repeat(200_000), 32), null);
    assert.ok(performance.now() - started < 50, 'a text too long for its length is refused before any decoding');
  });

  it('a call that is not a string or a length that is not a positive whole number is a TypeError', () => {
    for (const notText of [undefined, null, 1, 1n, {}, ['1']] as unknown[]) {
      assert.throws(() => base58Exact(notText as string, 32), TypeError);
    }
    for (const n of [0, -1, 1.5, Number.NaN, 4097]) {
      assert.throws(() => base58Exact('1', n), TypeError);
    }
  });
});

describe('base64Strict: canonical padded base64 of at most N bytes, or null', () => {
  it('agrees with Buffer on random data of every length up to 300 bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 300 }), (value) => {
        const text = Buffer.from(value).toString('base64');
        assert.equal(base64Of(value), text);
        assert.deepEqual(base64Strict(text, 300), value);
      }),
      { numRuns: 500 },
    );
    assert.deepEqual(base64Strict('', 0), new Uint8Array(0), 'an account with no data');
  });

  it('refuses stray bits, bad padding, whitespace, base64url and foreign characters', () => {
    assert.deepEqual(base64Strict('QQ==', 10), bytes(0x41));
    assert.equal(base64Strict('QR==', 10), null, 'the same byte with stray low bits');
    assert.deepEqual(base64Strict('QUI=', 10), bytes(0x41, 0x42));
    assert.equal(base64Strict('QUJ=', 10), null);
    for (const bad of ['Q', 'QQ', 'QQ=', 'QQ===', 'Q===', '=QQ=', 'Q=Q=', 'QQ==QQ==', 'QUJD QUJD', 'QUJD\n', ' QUJD', 'QUJD\t', 'Pz8_', 'Pz8-', 'QUJé', 'QU*D']) {
      assert.equal(base64Strict(bad, 100), null, JSON.stringify(bad));
    }
    assert.deepEqual(base64Strict('Pz8/', 10), bytes(0x3f, 0x3f, 0x3f));
  });

  it('refuses more than N bytes before decoding, and exactly N passes', () => {
    const text = base64Of(new Uint8Array(30).fill(9));
    assert.deepEqual(base64Strict(text, 30), new Uint8Array(30).fill(9));
    assert.equal(base64Strict(text, 29), null);
    assert.deepEqual(base64Strict('QQ==', 1), bytes(0x41));
    assert.equal(base64Strict('QUI=', 1), null);
    assert.equal(base64Strict('A'.repeat(4_000_000), 10), null);
  });

  it('a call that is not a string or a bound that is not a whole number from 0 is a TypeError', () => {
    for (const notText of [undefined, null, 1, {}, ['QQ==']] as unknown[]) {
      assert.throws(() => base64Strict(notText as string, 10), TypeError);
    }
    for (const n of [-1, 1.5, Number.NaN]) {
      assert.throws(() => base64Strict('QQ==', n), TypeError);
    }
  });
});
