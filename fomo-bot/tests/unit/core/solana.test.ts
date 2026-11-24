// The Solana value types of core/solana.ts (docs/CHAIN_DESIGN.md s.3, step 7a): an Address is the
// canonical base58 of exactly 32 bytes, a Signature of exactly 64, a Slot and a BlockHeight are u63
// bigints that the types never mix (a token's slots against an expiry's block heights). A refusal is a
// TypeError that never echoes the value (an RPC answer may carry anything). Written before the file.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { base58Of } from '../../../src/core/encode.ts';
import { address, blockHeight, signature, slot, type Address, type BlockHeight, type Slot } from '../../../src/core/solana.ts';

const I63_MAX = (1n << 63n) - 1n;
const SECRETISH = 'SECRET-LOOKING-INPUT-1234567890';

/** The refusal is a TypeError whose message does not contain the value it refused. */
function refused(fn: () => unknown, value: unknown): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof TypeError, String(e));
    if (typeof value === 'string' && value.length > 0) {
      assert.ok(!e.message.includes(value), `the message echoes the value: ${e.message}`);
    }
    return true;
  });
}

describe('address and signature: canonical base58 of exactly 32 and 64 bytes', () => {
  it('accepts program ids, mints and the genesis hash, unchanged', () => {
    for (const text of ['11111111111111111111111111111111', 'So11111111111111111111111111111111111111112', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d']) {
      const a: Address = address(text);
      assert.equal(a, text);
    }
    const sig = base58Of(new Uint8Array(64).fill(200));
    assert.equal(signature(sig), sig);
    assert.equal(signature(base58Of(new Uint8Array(64))), '1'.repeat(64));
  });

  it('refuses another length, a padded short number, foreign characters and non-strings, without echoing them', () => {
    const shortNumber = base58Of(Uint8Array.from([0, ...Array.from({ length: 31 }, (_, i) => i + 1)])).slice(1);
    for (const bad of [
      '',
      shortNumber,
      base58Of(new Uint8Array(31).fill(5)),
      base58Of(new Uint8Array(33).fill(5)),
      base58Of(new Uint8Array(64).fill(5)), // a signature is not an address
      `0${'1'.repeat(31)}`,
      SECRETISH,
      ` ${'1'.repeat(32)}`,
    ]) {
      refused(() => address(bad), bad);
    }
    for (const bad of ['', base58Of(new Uint8Array(32).fill(5)), base58Of(new Uint8Array(63).fill(5)), base58Of(new Uint8Array(65).fill(5)), SECRETISH]) {
      refused(() => signature(bad), bad);
    }
    for (const notText of [undefined, null, 32, 1n, {}, ['1'.repeat(32)]] as unknown[]) {
      refused(() => address(notText), notText);
      refused(() => signature(notText), notText);
    }
  });
});

describe('slot and blockHeight: u63 bigints, never mixed', () => {
  it('accept 0 up to 2^63 - 1', () => {
    const s: Slot = slot(385_000_000n);
    const h: BlockHeight = blockHeight(363_000_000n);
    assert.equal(s, 385_000_000n);
    assert.equal(h, 363_000_000n);
    assert.equal(slot(0n), 0n);
    assert.equal(slot(I63_MAX), I63_MAX);
    assert.equal(blockHeight(I63_MAX), I63_MAX);
  });

  it('refuse numbers, negatives, 2^63 and anything else', () => {
    for (const bad of [-1n, 1n << 63n, 1n << 64n, 5, 5.5, '5', null, undefined, {}] as unknown[]) {
      refused(() => slot(bad), bad);
      refused(() => blockHeight(bad), bad);
    }
  });

  it('the types keep a slot and a block height apart (compile-time)', () => {
    const s = slot(10n);
    const h = blockHeight(10n);
    // @ts-expect-error: a block height is not a slot
    const wrong1: Slot = h;
    // @ts-expect-error: a slot is not a block height
    const wrong2: BlockHeight = s;
    // @ts-expect-error: a plain bigint is not a slot
    const wrong3: Slot = 10n;
    // @ts-expect-error: a plain string is not an address
    const wrong4: Address = 'So11111111111111111111111111111111111111112';
    assert.deepEqual([wrong1, wrong2, wrong3, wrong4].length, 4);
  });
});
