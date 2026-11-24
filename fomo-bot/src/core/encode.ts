// Byte encoders for the exact-value list of the bot's own secrets (core/redact.ts registerOwnSecret;
// STORAGE_DESIGN.md s.16.7.2): a secret written out in hex, base64, base64url or base58 must be
// recognized in any of those forms. Written by hand, because pure code may use neither Buffer nor
// node:crypto (the architecture test). Each takes a Uint8Array (a Buffer is one), never changes it,
// and returns a new string: hex in lower case, base64 with padding, base64url without (as Node's
// Buffer writes them), base58 in the Bitcoin alphabet that Solana uses. And two strict decoders for
// the chain clients (docs/CHAIN_DESIGN.md s.2, step 7a): base58 of exactly N bytes and padded base64 of
// at most N bytes, each in its one canonical form only, with the size bound checked before decoding.
// Bad data is null; a call that is not a string is a TypeError. Pure.

const HEX = '0123456789abcdef';
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function bytesOf(bytes: Uint8Array): Uint8Array {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('the encoders take a Uint8Array');
  }
  return bytes;
}

/** Lower-case hex, two characters per byte. */
export function hexOf(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytesOf(bytes)) {
    out += HEX.charAt(b >> 4) + HEX.charAt(b & 15);
  }
  return out;
}

/** The byte at k, or 0 past the end (the tail of the last group of three). */
const byteAt = (bytes: Uint8Array, k: number): number => (k < bytes.length ? (bytes[k] as number) : 0);

function base64With(alphabet: string, input: Uint8Array, pad: boolean): string {
  const bytes = bytesOf(input);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const triple = (byteAt(bytes, i) << 16) | (byteAt(bytes, i + 1) << 8) | byteAt(bytes, i + 2);
    out += alphabet.charAt((triple >> 18) & 63) + alphabet.charAt((triple >> 12) & 63);
    if (has1) {
      out += alphabet.charAt((triple >> 6) & 63);
    } else if (pad) {
      out += '=';
    }
    if (has2) {
      out += alphabet.charAt(triple & 63);
    } else if (pad) {
      out += '=';
    }
  }
  return out;
}

/** Standard base64 with padding (RFC 4648 s.4), as Buffer's 'base64'. */
export function base64Of(bytes: Uint8Array): string {
  return base64With(BASE64, bytes, true);
}

/** URL-safe base64 without padding (RFC 4648 s.5), as Buffer's 'base64url'. */
export function base64UrlOf(bytes: Uint8Array): string {
  return base64With(BASE64URL, bytes, false);
}

/** Base58 (the Bitcoin alphabet): one '1' per leading zero byte, then the number in base 58. */
export function base58Of(input: Uint8Array): string {
  const bytes = bytesOf(input);
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) {
    zeros += 1;
  }
  let value = 0n;
  for (const b of bytes) {
    value = (value << 8n) | BigInt(b);
  }
  let digits = '';
  while (value > 0n) {
    digits = BASE58.charAt(Number(value % 58n)) + digits;
    value /= 58n;
  }
  return '1'.repeat(zeros) + digits;
}

/** The longest byte string base58Exact decodes: a signature is 64 bytes. */
const BASE58_MAX_BYTES = 4096;

/**
 * The bytes of `text` when it is the canonical base58 of exactly `length` bytes: one '1' per leading
 * zero byte, then the number with no padding, so a number that is short of `length` bytes is refused,
 * never padded as lenient decoders do. Anything else is null (base58 needs at most two characters per
 * byte, so a longer text is refused before decoding).
 */
export function base58Exact(text: string, length: number): Uint8Array | null {
  if (typeof text !== 'string') {
    throw new TypeError('base58Exact takes a string');
  }
  if (!Number.isInteger(length) || length < 1 || length > BASE58_MAX_BYTES) {
    throw new TypeError(`base58Exact takes a byte length from 1 to ${BASE58_MAX_BYTES}`);
  }
  if (text.length === 0 || text.length > 2 * length) {
    return null;
  }
  let zeros = 0;
  while (zeros < text.length && text.charAt(zeros) === '1') {
    zeros += 1;
  }
  let value = 0n;
  for (let i = zeros; i < text.length; i += 1) {
    const digit = BASE58.indexOf(text.charAt(i));
    if (digit < 0) {
      return null;
    }
    value = value * 58n + BigInt(digit);
  }
  const body: number[] = [];
  while (value > 0n) {
    body.unshift(Number(value & 255n));
    value >>= 8n;
  }
  if (zeros + body.length !== length) {
    return null;
  }
  const out = new Uint8Array(length);
  out.set(body, zeros);
  // canonical by construction: the leading '1's are the leading zero bytes, and the digits after them
  // start with a non-zero digit, so base58Of(out) is the text itself (the tests check the round trip)
  return out;
}

/**
 * The bytes of `text` when it is canonical padded base64 (RFC 4648 s.4, as Buffer writes it) of at most
 * `maxBytes` bytes: no whitespace, no base64url characters, padding only at the end and only as needed,
 * and no stray bits in the last character. Anything else is null; the size is checked before decoding.
 */
export function base64Strict(text: string, maxBytes: number): Uint8Array | null {
  if (typeof text !== 'string') {
    throw new TypeError('base64Strict takes a string');
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('base64Strict takes a byte bound, a whole number from 0');
  }
  if (text.length % 4 !== 0) {
    return null;
  }
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const size = (text.length / 4) * 3 - pad;
  if (size > maxBytes) {
    return null;
  }
  const out = new Uint8Array(size);
  let acc = 0;
  let bits = 0;
  let k = 0;
  for (let i = 0; i < text.length - pad; i += 1) {
    const sextet = BASE64.indexOf(text.charAt(i)); // '=' is not in the alphabet: padding inside is refused
    if (sextet < 0) {
      return null;
    }
    acc = ((acc << 6) | sextet) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[k] = (acc >> bits) & 255; // a group of 2, 3 or 4 characters gives exactly size bytes in all
      k += 1;
    }
  }
  return base64Of(out) === text ? out : null; // the re-encoding refuses stray bits in the last character
}
