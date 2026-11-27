// Randomness, in one audited place (ARCHITECTURE.md s.2; STORAGE_DESIGN.md s.16.7.1): the per-boot
// approval key, the random ids of tokens, positions and orders, and the stream's reconnect jitter
// (unitInterval, CHAIN_DESIGN R14: chain/ cannot import this file, so cli/ hands it in). Only
// randomBytes is used. Ids
// come from their own random bytes, so they are independent of the key and of every MAC; each is a
// prefix and 32 lower-case hex characters (35 in all: the secret filter refuses runs of 64), drawn
// again while the filter refuses it (a registered own secret inside it), at most 8 times, then the
// draw fails closed. Only cli/ (the process entry) hands systemRng on; app/ code takes an Rng, so
// tests inject their own (the architecture test: only app/ and cli/ may import this file). Pure,
// apart from randomBytes.
import { randomBytes } from 'node:crypto';
import { hexOf } from './encode.ts';
import { isIdText } from './ids.ts';
import { secretKinds } from './redact.ts';

/** What app/ code draws from; tests pass their own (a counter, a fixed key). */
export interface Rng {
  /** 32 bytes, a new array each call (the authority copies it, then the caller wipes it). */
  approvalKey(): Uint8Array;
  tokenId(): string;
  positionId(): string;
  orderId(): string;
}

export type IdKind = 'token' | 'position' | 'order';

const PREFIX: Readonly<Record<IdKind, string>> = Object.freeze({ token: 'tk', position: 'ps', order: 'or' });
const KEY_BYTES = 32;
const ID_BYTES = 16;
const KEY_DRAWS = 2;
const ID_DRAWS = 8;

export type RngErrorCode = 'rng-zero-key' | 'rng-filter' | 'rng-bad-bytes';

export class RngError extends Error {
  readonly code: RngErrorCode;

  constructor(code: RngErrorCode, message: string) {
    super(message);
    this.name = 'RngError';
    this.code = code;
  }
}

/** A key from exactly 32 bytes that are not all zero, as a new plain array; null otherwise. */
export function keyFromBytes(bytes: Uint8Array): Uint8Array | null {
  if (!(bytes instanceof Uint8Array) || bytes.length !== KEY_BYTES || bytes.every((b) => b === 0)) {
    return null;
  }
  return Uint8Array.from(bytes);
}

/**
 * A key from a byte source: an unusable draw (all zero, or not 32 bytes) is drawn once more, then
 * this throws rng-zero-key. Each array the source returned is wiped once it is copied.
 */
export function drawKey(nextBytes: () => Uint8Array): Uint8Array {
  for (let i = 0; i < KEY_DRAWS; i += 1) {
    const raw = nextBytes();
    const key = keyFromBytes(raw);
    if (raw instanceof Uint8Array) {
      raw.fill(0);
    }
    if (key !== null) {
      return key;
    }
  }
  throw new RngError('rng-zero-key', 'the random source gave no usable 32-byte key twice');
}

/** The per-boot approval key: 32 random bytes. */
export function newApprovalKey(): Uint8Array {
  return drawKey(() => randomBytes(KEY_BYTES));
}

/** The id of these 16 bytes, or null when the secret filter refuses it. */
export function idFromBytes(kind: IdKind, bytes: Uint8Array): string | null {
  if (!Object.hasOwn(PREFIX, kind) || !(bytes instanceof Uint8Array) || bytes.length !== ID_BYTES) {
    throw new RngError('rng-bad-bytes', 'an id kind (token, position or order) and exactly 16 bytes');
  }
  const id = `${PREFIX[kind]}_${hexOf(bytes)}`;
  return isIdText(id) && secretKinds(id).length === 0 ? id : null;
}

/** The first of at most 8 draws whose id the filter passes; rng-filter when all 8 are refused. */
export function drawId(kind: IdKind, nextBytes: () => Uint8Array): string {
  for (let i = 0; i < ID_DRAWS; i += 1) {
    const id = idFromBytes(kind, nextBytes());
    if (id !== null) {
      return id;
    }
  }
  throw new RngError('rng-filter', `the secret filter refused ${ID_DRAWS} random ids in a row`);
}

/** A random id of this kind. */
export function newId(kind: IdKind): string {
  return drawId(kind, () => randomBytes(ID_BYTES));
}

const UNIT_BYTES = 6;
const UNIT_SCALE = 2 ** 48;

/** Exactly 6 bytes, big-endian, as a fraction of 2^48: from 0 up to just under 1. */
export function unitFromBytes(bytes: Uint8Array): number {
  if (!(bytes instanceof Uint8Array) || bytes.length !== UNIT_BYTES) {
    throw new RngError('rng-bad-bytes', 'exactly 6 bytes for a number in [0, 1)');
  }
  let v = 0;
  for (const b of bytes) {
    v = v * 256 + b; // at most 2^48 - 1: exact in a double
  }
  return v / UNIT_SCALE;
}

/** A random number in [0, 1): the reconnect jitter of chain/ws.ts, handed in by cli/. */
export function unitInterval(): number {
  return unitFromBytes(randomBytes(UNIT_BYTES));
}

/** The process's own randomness: only cli/ passes it on. */
export const systemRng: Rng = Object.freeze({
  approvalKey: newApprovalKey,
  tokenId: () => newId('token'),
  positionId: () => newId('position'),
  orderId: () => newId('order'),
});
