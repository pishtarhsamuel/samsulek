// The fixture scan (docs/CHAIN_DESIGN.md s.13, A16, D13): fixtures are synthetic, so no FOMO user's or
// creator's address can get into the code or its tests. Every base58 text in src/ and tests/ that is the
// canonical form of exactly 32 or 64 bytes (an address, a hash, a signature) must be on this allowlist,
// each entry with what it is. Synthetic keys are built from bytes at run time and are not literals.
// A change to the allowlist is a reviewed change. What the scan cannot see: an address written as hex,
// base64 or a byte list; reviewers check fixtures for those.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { base58Exact, base58Of, base64Of } from '../../src/core/encode.ts';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** Public programs, mints and cluster hashes, and synthetic test vectors; never a user's account. */
const ALLOWED: Readonly<Record<string, string>> = Object.freeze({
  '11111111111111111111111111111111': 'the system program (32 zero bytes)',
  JEKNVnkbo3jma5nREBBJCDoXFVeKkD56V3xKrvRmWxFG: 'a synthetic vector: 32 bytes of 0xff',
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d': 'the mainnet-beta genesis hash (VERIFIED_FACTS s.9)',
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: 'the devnet genesis hash (VERIFIED_FACTS s.9; the wrong-cluster tests)',
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY': 'the testnet genesis hash (VERIFIED_FACTS s.9; the wrong-cluster tests)',
  So11111111111111111111111111111111111111112: 'the wrapped SOL mint',
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'the SPL Token program',
  BPFLoaderUpgradeab1e11111111111111111111111: 'the upgradeable BPF loader (the SPL Token program account\'s owner)',
});

/** A run of base58 characters that is not part of a longer one. */
const CANDIDATE = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,88}(?![1-9A-HJ-NP-Za-km-z])/g;

/**
 * A run of 64 or more base64 characters (padding included): a pasted live answer's account data holds raw
 * public keys, which no base58 scan can see (review Y, security 7). Hex (a hash) is not base64 data.
 */
const BASE64_RUN = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{64,}={0,2}(?![A-Za-z0-9+/=])/g;
const HEX = /^(?:[0-9a-f]+|[0-9A-F]+)$/;
const ALLOWED_BASE64: Readonly<Record<string, string>> = Object.freeze({
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/': 'the base64 alphabet itself (core/encode.ts)',
});

function base64Runs(text: string): string[] {
  return [...new Set([...text.matchAll(BASE64_RUN)].map((m) => m[0]).filter((t) => !HEX.test(t)))];
}

/** Every .ts file under the folder; any other file there fails the scan (a fixture in another format would hide). */
function files(dir: string, out: string[], others: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      files(p, out, others);
    } else if (e.name.endsWith('.ts')) {
      out.push(p);
    } else {
      others.push(relative(ROOT, p));
    }
  }
}

/** The 32- and 64-byte base58 texts in a text, with no duplicates. */
function base58Literals(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(CANDIDATE)) {
    if (base58Exact(m[0], 32) !== null || base58Exact(m[0], 64) !== null) {
      found.add(m[0]);
    }
  }
  return [...found];
}

/** What a text holds that neither allowlist names: base58 addresses, hashes and signatures, and long base64 runs. */
function unknownLiterals(text: string): string[] {
  const base58 = base58Literals(text).filter((t) => !Object.hasOwn(ALLOWED, t));
  const base64 = base64Runs(text).filter((t) => !Object.hasOwn(ALLOWED_BASE64, t));
  return [...base58, ...base64];
}

describe('the fixture scan: only allowlisted addresses, hashes, signatures and base64 in src/ and tests/', () => {
  it('every 32- or 64-byte base58 literal and every run of 64 or more base64 characters is on its allowlist (review Y, security 7)', () => {
    const all: string[] = [];
    const others: string[] = [];
    files(join(ROOT, 'src'), all, others);
    files(join(ROOT, 'tests'), all, others);
    assert.deepEqual(others, [], 'only .ts files in src/ and tests/');
    assert.ok(all.length > 100, 'the scan sees the tree');
    const unknown = all.flatMap((f) => unknownLiterals(readFileSync(f, 'utf8')).map((t) => `${relative(ROOT, f)}: ${t.slice(0, 24)}... (${t.length} characters)`));
    assert.deepEqual(unknown, [], 'use synthetic keys and bytes built at run time (base58Of, base64Of); add a real value only if it is a public program, mint or cluster hash, with its reason; never paste a recorded answer');
  });

  it('CANARY: the allowlists let their own entries through and nothing else', () => {
    const user = base58Of(Uint8Array.from({ length: 32 }, (_v, i) => 200 - i));
    const data = base64Of(Uint8Array.from({ length: 82 }, (_v, i) => (i * 37) & 255));
    for (const allowed of [...Object.keys(ALLOWED), ...Object.keys(ALLOWED_BASE64)]) {
      assert.deepEqual(unknownLiterals(`x = '${allowed}';`), [], allowed);
    }
    assert.deepEqual(unknownLiterals(`{"owner":"${user}","data":["${data}","base64"]}`), [user, data]);
    assert.deepEqual(unknownLiterals(`So11111111111111111111111111111111111111112 ${user}`), [user]);
  });

  it('CANARY: the base64 scan finds account data however it is written, and leaves hex hashes and short runs alone', () => {
    const data = base64Of(Uint8Array.from({ length: 82 }, (_v, i) => (i * 37) & 255)); // 112 characters
    assert.deepEqual(base64Runs(`data: ["${data}","base64"]`), [data]);
    assert.deepEqual(base64Runs(`'${data}' + '${data}'`), [data], 'once');
    const unpadded = data.replace(/=+$/, '');
    assert.deepEqual(base64Runs(unpadded), [unpadded], 'without its padding too');
    const exact64 = base64Of(new Uint8Array(48).fill(0xab)); // 48 bytes: exactly 64 characters
    assert.equal(exact64.length, 64);
    assert.deepEqual(base64Runs(exact64), [exact64], 'from 64 characters');
    assert.deepEqual(base64Runs('a'.repeat(63)), []);
    assert.deepEqual(base64Runs('0123456789abcdef'.repeat(4)), [], 'a sha256 in hex');
    assert.deepEqual(base64Runs('0123456789ABCDEF'.repeat(4)), []);
    assert.deepEqual(base64Runs(`x-${data}_y`), [data], 'a hyphen or an underscore ends a run, it does not hide one');
  });

  it('every allowlist entry is itself 32 bytes of canonical base58', () => {
    for (const t of Object.keys(ALLOWED)) {
      assert.ok(base58Exact(t, 32) !== null, t);
    }
  });

  it('CANARY: the scan finds an address and a signature in any text, once each, and no other length', () => {
    // built from bytes, never written here (a literal would be scanned, and could be someone's account)
    const user = base58Of(Uint8Array.from({ length: 32 }, (_v, i) => 200 - i));
    const sig = base58Of(Uint8Array.from({ length: 64 }, (_v, i) => 255 - i));
    const hash33 = base58Of(Uint8Array.from({ length: 33 }, (_v, i) => 100 + i));
    assert.deepEqual(base58Literals(`const a = '${user}';`), [user]);
    assert.deepEqual(base58Literals(`{"owner":"${user}","x":"${user}"}`), [user], 'once, however often it appears');
    assert.deepEqual(base58Literals(`sig: ${sig}\n`), [sig]);
    assert.deepEqual(base58Literals(`${user} ${sig}`), [user, sig]);
    assert.deepEqual(base58Literals(user.slice(0, 20)), [], 'too short to be 32 bytes');
    assert.deepEqual(base58Literals(hash33), [], '33 bytes is no address');
    assert.deepEqual(base58Literals(`${user}${user}`), [], 'one run of base58 is read as one value');
    assert.deepEqual(base58Literals(`x_${user}_y`), [user], 'a separator that is not base58 ends the run');
  });
});
