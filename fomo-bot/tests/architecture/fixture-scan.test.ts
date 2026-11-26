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
import { base58Exact, base58Of } from '../../src/core/encode.ts';

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

describe('the fixture scan: only allowlisted addresses, hashes and signatures in src/ and tests/', () => {
  it('every 32- or 64-byte base58 literal is on the allowlist', () => {
    const all: string[] = [];
    const others: string[] = [];
    files(join(ROOT, 'src'), all, others);
    files(join(ROOT, 'tests'), all, others);
    assert.deepEqual(others, [], 'only .ts files in src/ and tests/');
    assert.ok(all.length > 100, 'the scan sees the tree');
    const unknown: string[] = [];
    for (const f of all) {
      for (const t of base58Literals(readFileSync(f, 'utf8'))) {
        if (!Object.hasOwn(ALLOWED, t)) {
          unknown.push(`${relative(ROOT, f)}: ${t}`);
        }
      }
    }
    assert.deepEqual(unknown, [], 'add a real account only if it is a public program, mint or cluster hash, with its reason; use synthetic keys otherwise');
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
