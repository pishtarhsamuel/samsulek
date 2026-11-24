// Solana's value types (docs/CHAIN_DESIGN.md s.3): an Address is the canonical base58 of exactly 32
// bytes and a Signature of exactly 64 (core/encode.ts base58Exact), a Slot and a BlockHeight are whole
// numbers from 0 to 2^63 - 1 that the types never mix: a token lives a number of slots, a blockhash a
// number of block heights. The makers throw a TypeError that never echoes the value: an RPC answer can
// carry anything, and a refusal's message goes to the logs. Pure.
import { base58Exact } from './encode.ts';

export type Address = string & { readonly __kind: 'address' };
export type Signature = string & { readonly __kind: 'signature' };
export type Slot = bigint & { readonly __unit: 'slot' };
export type BlockHeight = bigint & { readonly __unit: 'block-height' };

const I63_MAX = (1n << 63n) - 1n;

function base58Of(what: string, v: unknown, bytes: number): string {
  if (typeof v !== 'string' || base58Exact(v, bytes) === null) {
    throw new TypeError(`expected ${what}: the canonical base58 of exactly ${bytes} bytes`);
  }
  return v;
}

function u63(what: string, v: unknown): bigint {
  if (typeof v !== 'bigint' || v < 0n || v > I63_MAX) {
    throw new TypeError(`expected ${what}: a bigint from 0 to 2^63 - 1`);
  }
  return v;
}

export function address(v: unknown): Address {
  return base58Of('an address', v, 32) as Address;
}

export function signature(v: unknown): Signature {
  return base58Of('a signature', v, 64) as Signature;
}

export function slot(v: unknown): Slot {
  return u63('a slot', v) as Slot;
}

export function blockHeight(v: unknown): BlockHeight {
  return u63('a block height', v) as BlockHeight;
}
