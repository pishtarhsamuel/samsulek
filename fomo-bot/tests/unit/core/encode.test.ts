// Byte encoders for the exact-value list of the bot's own secrets (STORAGE_DESIGN.md s.16.7.2):
// hex, base64, base64url and base58, written by hand because pure code may not use Buffer. Each is
// checked against Node's Buffer (hex, base64, base64url) and against vectors computed by an
// independent implementation (base58: Python's integer arithmetic, 2026-11-19), and on random
// byte strings against a second, carry-based base58 written here. Written before src/core/encode.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import * as encodeFile from '../../../src/core/encode.ts';
import { base58Of, base64Of, base64UrlOf, hexOf } from '../../../src/core/encode.ts';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 the way Bitcoin Core's EncodeBase58 does it (digit by digit, with a carry): a second algorithm. */
function base58ByCarry(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) {
    zeros += 1;
  }
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i] ?? 0;
    for (let j = 0; j < digits.length; j += 1) {
      carry += (digits[j] ?? 0) * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  return '1'.repeat(zeros) + digits.reverse().map((d) => B58[d]).join('');
}

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('the encoders file: only what it may do', () => {
  it('exports the four encoders and nothing else', () => {
    assert.deepEqual(Object.keys(encodeFile).sort(), ['base58Of', 'base64Of', 'base64UrlOf', 'hexOf']);
  });
});

describe('hex, base64 and base64url: equal to Buffer', () => {
  it('the RFC 4648 vectors, and the characters that differ between base64 and base64url', () => {
    const vectors: readonly (readonly [string, string, string])[] = [
      ['', '', ''],
      ['f', 'Zg==', 'Zg'],
      ['fo', 'Zm8=', 'Zm8'],
      ['foo', 'Zm9v', 'Zm9v'],
      ['foob', 'Zm9vYg==', 'Zm9vYg'],
      ['fooba', 'Zm9vYmE=', 'Zm9vYmE'],
      ['foobar', 'Zm9vYmFy', 'Zm9vYmFy'],
    ];
    for (const [plain, b64, b64url] of vectors) {
      assert.equal(base64Of(text(plain)), b64);
      assert.equal(base64UrlOf(text(plain)), b64url);
    }
    assert.equal(base64Of(Uint8Array.from([251, 255, 191])), '+/+/');
    assert.equal(base64UrlOf(Uint8Array.from([251, 255, 191])), '-_-_');
    assert.equal(hexOf(Uint8Array.from([0, 1, 15, 16, 171, 255])), '00010f10abff');
    assert.equal(hexOf(new Uint8Array(0)), '');
  });

  it('1,000 random byte strings of 0 to 96 bytes: the same text as Buffer gives', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 96 }), (bytes) => {
        const buffer = Buffer.from(bytes);
        assert.equal(hexOf(bytes), buffer.toString('hex'));
        assert.equal(base64Of(bytes), buffer.toString('base64'));
        assert.equal(base64UrlOf(bytes), buffer.toString('base64url'));
      }),
      { numRuns: 1_000 },
    );
  });
});

describe('base58: the Bitcoin alphabet, one "1" per leading zero byte', () => {
  it('vectors from an independent implementation: text, leading zeros, a Solana address of 32 zero bytes, 32 bytes of 0xff', () => {
    assert.equal(base58Of(text('Hello World!')), '2NEpo7TZRRrLZSi2U');
    assert.equal(base58Of(Uint8Array.from([0, 0, 0x28, 0x7f, 0xb4, 0xcd])), '11233QC4');
    assert.equal(base58Of(new Uint8Array(32)), '1'.repeat(32)); // the system program's address
    assert.equal(base58Of(new Uint8Array(32).fill(255)), 'JEKNVnkbo3jma5nREBBJCDoXFVeKkD56V3xKrvRmWxFG');
    assert.equal(base58Of(new Uint8Array(0)), '');
    assert.equal(base58Of(Uint8Array.from([0])), '1');
    assert.equal(base58Of(Uint8Array.from([0, 1])), '12');
  });

  it('1,000 random byte strings of 0 to 96 bytes, many with leading zeros: the same as the carry algorithm', () => {
    const withZeros = fc.tuple(fc.integer({ min: 0, max: 4 }), fc.uint8Array({ minLength: 0, maxLength: 92 })).map(([n, rest]) => Uint8Array.from([...new Array<number>(n).fill(0), ...rest]));
    fc.assert(
      fc.property(withZeros, (bytes) => {
        assert.equal(base58Of(bytes), base58ByCarry(bytes));
      }),
      { numRuns: 1_000 },
    );
  });
});

describe('the encoders take bytes only, and leave them as they were', () => {
  it('a Buffer is bytes too; the input is not changed; anything else is refused', () => {
    const bytes = Uint8Array.from([0, 9, 200, 255]);
    for (const f of [hexOf, base64Of, base64UrlOf, base58Of]) {
      assert.equal(f(Buffer.from(bytes)), f(bytes));
      f(bytes);
      assert.deepEqual([...bytes], [0, 9, 200, 255]);
      for (const bad of ['00ff', [0, 255], null, undefined, new Uint16Array(2), { length: 1, 0: 1 }]) {
        assert.throws(() => f(bad as unknown as Uint8Array), TypeError);
      }
    }
  });
});
