// The secret filter (STORAGE_DESIGN.md s.6 "Never in the database"; THREAT_MODEL.md "Redaction").
// Text bound for the database (and later a log line, a Telegram message or an AI prompt) is
// scanned for anything that looks like a key, a seed phrase, a bot token, an API credential or a
// URL (which can carry a key). assertNoSecrets refuses: the write or the message is not made (fail
// closed). It never masks, and an error never repeats any part of the text it refused.
// Limits, written down (review P, security 5): a 32-byte seed written as 44 characters of base58 or
// base64 looks exactly like an address, and an API key shaped like a UUID looks like a random id, so
// no pattern can tell them apart (the exact-value list of the bot's own secrets in step 6d covers
// those); a seed phrase in capitals, numbered or comma-separated waits for the BIP39 word check of
// Phase 3; split or escaped secrets are not reassembled. Pure.

export type SecretKind =
  | 'key-like-run'
  | 'byte-array'
  | 'pem'
  | 'credential-word'
  | 'bot-token'
  | 'anthropic-key'
  | 'url'
  | 'seed-phrase';

/** In this order; each pattern is linear or close to it on any input (tested on long hostile text). */
const PATTERNS: readonly (readonly [SecretKind, RegExp])[] = Object.freeze([
  // 64+ characters of base58, base64, base64url or hex: 48-byte and longer keys, 32-byte values in hex,
  // signatures; an address is at most 44 characters, and hashes belong in typed hex64 columns
  ['key-like-run', /[A-Za-z0-9+/_-]{64,}/],
  // 32 or more bytes: a JSON array of numbers of up to three digits, quoted or not (a seed, a keypair
  // file, or bigints after jsonParam), or hex pairs split by spaces or colons (a Buffer as printed)
  ['byte-array', /\[(?:\s*"?\d{1,3}"?\s*,){31,}\s*"?\d{1,3}"?\s*\]|(?:[0-9A-Fa-f]{2}[ :]){31,}[0-9A-Fa-f]{2}/],
  ['pem', /-----BEGIN /],
  [
    'credential-word',
    /api[-_ ]?key|secret|passw(?:or)?d|passphrase|private[-_ ]?key|mnemonic|seed[-_ ]?phrase|authorization|bearer\s|token=|access[-_ ]?token|refresh[-_ ]?token/i,
  ],
  // Telegram: the bot id (6-12 digits), a colon, 30+ token characters
  ['bot-token', /\d{6,12}:[A-Za-z0-9_-]{30,}/],
  ['anthropic-key', /sk-ant-/i],
  // a scheme of at most 32 characters (an unbounded one backtracks over every long word: quadratic),
  // the slashes as written in JSON too ("https:\/\/..."), and "://" percent-encoded
  ['url', /[A-Za-z][A-Za-z0-9+.-]{0,31}:(?:\\?\/){2}|%3a%2f%2f/i],
  // twelve or more short lower-case words in a row: a recovery phrase (stored text is codes, not prose)
  ['seed-phrase', /\b(?:[a-z]{3,8}\s+){11,}[a-z]{3,8}\b/],
] as const);

/** The kinds of secret the text seems to hold, each once, in a fixed order; [] when clean. */
export function secretKinds(text: string): readonly SecretKind[] {
  if (typeof text !== 'string') {
    throw new TypeError('the secret filter reads text only');
  }
  return Object.freeze(PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind));
}

export class SecretError extends Error {
  readonly kinds: readonly SecretKind[];

  constructor(what: string, kinds: readonly SecretKind[]) {
    super(`${what} looks like it holds a secret (${kinds.join(', ')}): refused`);
    this.name = 'SecretError';
    this.kinds = kinds;
  }
}

/** Throws a SecretError naming `what` (a fixed label of the caller) and the kinds, never the text. */
export function assertNoSecrets(text: string, what: string): void {
  const kinds = secretKinds(text);
  if (kinds.length > 0) {
    throw new SecretError(what, kinds);
  }
}
