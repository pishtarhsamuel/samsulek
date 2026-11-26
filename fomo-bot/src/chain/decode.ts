// The strict decoders of the Phase 2 answers (docs/CHAIN_DESIGN.md s.5, R7 and R8): written by hand, no
// zod. They take what chain/rpc.ts's readEnvelope returns as `result` (parsed losslessly: integers as
// bigints, frozen) and give a typed value or a refusal, never a default and never part of an answer:
// - an integer field is a bigint in range: u64 up to 2^64 - 1, a slot up to 2^63 - 1, a size up to
//   10 MiB; `1e3`, `1.0`, `-0` and strings are refused, because the parser kept them JS numbers;
// - the small fixed shapes have exactly their keys, no missing and no extra one: the envelope's result
//   `{context, value}`, `context` = `{apiVersion, slot}`, the account `{data, executable, lamports,
//   owner, rentEpoch, space}`, `data` = `[base64, "base64"]`, the fee entry `{slot, prioritizationFee}`;
// - account data is canonical base64 of exactly the expected length: `space`, or with a slice
//   `min(length, max(0, space - offset))` (the node reports the full `space` even with a slice);
// - a batch has exactly one answer per key, in request order ('count'); fees at most 150 entries with
//   distinct slots, sorted here (their order is UNVERIFIED, U13).
// What a refusal means for the caller (a 'chain-shape' event, nothing used) is the client's (7e). Pure.
import type { Json } from '../core/json.ts';
import { base58Exact, base64Strict } from '../core/encode.ts';
import { address, blockHeight, slot, type Address, type BlockHeight, type Slot } from '../core/solana.ts';
import { lamports, microLamportsPerCu, U64_MAX, type Lamports, type MicroLamportsPerCu } from '../core/units.ts';
import { MAX_ACCOUNT_BYTES, MAX_KEYS, type DataSlice } from './rpc.ts';

/** getRecentPrioritizationFees gives one entry per cached slot, at most 150 (MAX_NUM_RECENT_BLOCKS). */
export const MAX_FEE_ENTRIES = 150;
/** The rent-exempt minimum per byte, with the 128 bytes of account overhead (VERIFIED_FACTS s.3, live). */
const RENT_LAMPORTS_PER_BYTE = 5_080n;
const ACCOUNT_OVERHEAD_BYTES = 128n;
/** apiVersion is text of at most this many characters ("4.4.0" today); events take it only in its plain form. */
const MAX_API_VERSION_LENGTH = 64;
const I63_MAX = (1n << 63n) - 1n;

export interface RpcContext {
  readonly slot: Slot;
  readonly apiVersion: string;
}

export interface Account {
  readonly lamports: Lamports;
  readonly owner: Address;
  readonly executable: boolean;
  readonly rentEpoch: bigint;
  /** The account's full data length, even when only a slice was read. */
  readonly space: number;
  /** A fresh copy for each decode (a typed array cannot be frozen). */
  readonly data: Uint8Array;
}

export interface FeeEntry {
  readonly slot: Slot;
  readonly fee: MicroLamportsPerCu;
}

export type Decoded<T> = { readonly ok: true; readonly value: T; readonly context: RpcContext | null } | { readonly ok: false; readonly code: 'shape' | 'count' };

type Obj = Readonly<Record<string, Json>>;

const SHAPE: Decoded<never> = Object.freeze({ ok: false, code: 'shape' });
const COUNT: Decoded<never> = Object.freeze({ ok: false, code: 'count' });
const ok = <T>(value: T, context: RpcContext | null = null): Decoded<T> => Object.freeze({ ok: true, value, context });

function isList(v: Json | undefined): v is readonly Json[] {
  return Array.isArray(v);
}

/** The object when it has exactly these keys, else null. */
function exact(v: Json | undefined, keys: readonly string[]): Obj | null {
  if (typeof v !== 'object' || v === null || isList(v)) {
    return null;
  }
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(v, k)) ? v : null;
}

const isU64 = (v: Json | undefined): v is bigint => typeof v === 'bigint' && v >= 0n && v <= U64_MAX;
const isU63 = (v: Json | undefined): v is bigint => typeof v === 'bigint' && v >= 0n && v <= I63_MAX;
const isAddress = (v: Json | undefined): v is string => typeof v === 'string' && base58Exact(v, 32) !== null;

function checkedSlice(slice: DataSlice | null): DataSlice | null {
  if (slice === null) {
    return null;
  }
  const whole = (n: unknown): boolean => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= MAX_ACCOUNT_BYTES;
  if (!whole(slice.offset) || !whole(slice.length)) {
    throw new TypeError(`a data slice is whole numbers of bytes from 0 to ${MAX_ACCOUNT_BYTES}`);
  }
  return slice;
}

function readContext(v: Json | undefined): RpcContext | null {
  const c = exact(v, ['apiVersion', 'slot']);
  if (c === null) {
    return null;
  }
  const apiVersion = c['apiVersion'];
  const s = c['slot'];
  if (typeof apiVersion !== 'string' || apiVersion.length < 1 || apiVersion.length > MAX_API_VERSION_LENGTH || !isU63(s)) {
    return null;
  }
  return Object.freeze({ slot: slot(s), apiVersion });
}

/** One account, or null when it is not exactly an account (a missing account is JSON null, handled by the caller). */
function readAccount(v: Json, slice: DataSlice | null): Account | null {
  const a = exact(v, ['data', 'executable', 'lamports', 'owner', 'rentEpoch', 'space']);
  if (a === null) {
    return null;
  }
  const lam = a['lamports'];
  const owner = a['owner'];
  const executable = a['executable'];
  const rentEpoch = a['rentEpoch'];
  const space = a['space'];
  const data = a['data'];
  if (!isU64(lam) || !isAddress(owner) || typeof executable !== 'boolean' || !isU64(rentEpoch) || typeof space !== 'bigint' || space < 0n || space > BigInt(MAX_ACCOUNT_BYTES)) {
    return null;
  }
  if (!isList(data) || data.length !== 2 || data[1] !== 'base64' || typeof data[0] !== 'string') {
    return null;
  }
  const full = Number(space);
  const expected = slice === null ? full : Math.min(slice.length, Math.max(0, full - slice.offset));
  const bytes = base64Strict(data[0], expected);
  if (bytes === null || bytes.length !== expected) {
    return null;
  }
  return Object.freeze({ lamports: lamports(lam), owner: address(owner), executable, rentEpoch, space: full, data: bytes });
}

export function decodeGenesisHash(r: Json): Decoded<string> {
  return isAddress(r) ? ok(r) : SHAPE;
}

export function decodeSlot(r: Json): Decoded<Slot> {
  return isU63(r) ? ok(slot(r)) : SHAPE;
}

export function decodeBlockHeight(r: Json): Decoded<BlockHeight> {
  return isU63(r) ? ok(blockHeight(r)) : SHAPE;
}

export function decodeRent(r: Json): Decoded<Lamports> {
  return isU64(r) ? ok(lamports(r)) : SHAPE;
}

/** What the rent should be by the recorded formula: the client compares, and the chain's value wins (s.5). */
export function rentFormula(dataBytes: number): Lamports {
  if (typeof dataBytes !== 'number' || !Number.isSafeInteger(dataBytes) || dataBytes < 0 || dataBytes > MAX_ACCOUNT_BYTES) {
    throw new TypeError(`an account size is a whole number of bytes from 0 to ${MAX_ACCOUNT_BYTES}`);
  }
  return lamports((ACCOUNT_OVERHEAD_BYTES + BigInt(dataBytes)) * RENT_LAMPORTS_PER_BYTE);
}

/** getMultipleAccounts for keyCount keys (1 to 100), read with this slice or none: one answer per key, in order. */
export function decodeAccounts(r: Json, keyCount: number, slice: DataSlice | null): Decoded<readonly (Account | null)[]> {
  if (typeof keyCount !== 'number' || !Number.isInteger(keyCount) || keyCount < 1 || keyCount > MAX_KEYS) {
    throw new TypeError(`a batch has 1 to ${MAX_KEYS} keys`);
  }
  const s = checkedSlice(slice);
  const top = exact(r, ['context', 'value']);
  if (top === null) {
    return SHAPE;
  }
  const context = readContext(top['context']);
  const value = top['value'];
  if (context === null || !isList(value)) {
    return SHAPE;
  }
  if (value.length !== keyCount) {
    return COUNT;
  }
  const out: (Account | null)[] = [];
  for (const v of value) {
    if (v === null) {
      out.push(null);
    } else {
      const account = readAccount(v, s);
      if (account === null) {
        return SHAPE;
      }
      out.push(account);
    }
  }
  return ok(Object.freeze(out), context);
}

/** getRecentPrioritizationFees: at most 150 entries, each slot once, returned by slot (ascending). */
export function decodePriorityFees(r: Json): Decoded<readonly FeeEntry[]> {
  if (!isList(r)) {
    return SHAPE;
  }
  if (r.length > MAX_FEE_ENTRIES) {
    return COUNT;
  }
  const out: FeeEntry[] = [];
  const seen = new Set<bigint>();
  for (const v of r) {
    const e = exact(v, ['slot', 'prioritizationFee']);
    if (e === null) {
      return SHAPE;
    }
    const s = e['slot'];
    const fee = e['prioritizationFee'];
    if (!isU63(s) || !isU64(fee) || seen.has(s)) {
      return SHAPE;
    }
    seen.add(s);
    out.push(Object.freeze({ slot: slot(s), fee: microLamportsPerCu(fee) }));
  }
  out.sort((a, b) => (a.slot < b.slot ? -1 : 1)); // distinct slots: never equal
  return ok(Object.freeze(out));
}
