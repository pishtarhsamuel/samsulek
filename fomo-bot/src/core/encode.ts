// Byte encoders for the exact-value list of the bot's own secrets (core/redact.ts registerOwnSecret;
// STORAGE_DESIGN.md s.16.7.2): a secret written out in hex, base64, base64url or base58 must be
// recognized in any of those forms. Written by hand, because pure code may use neither Buffer nor
// node:crypto (the architecture test). Each takes a Uint8Array (a Buffer is one), never changes it,
// and returns a new string: hex in lower case, base64 with padding, base64url without (as Node's
// Buffer writes them), base58 in the Bitcoin alphabet that Solana uses. Pure.

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
