// The exact-value list of the bot's own secrets (STORAGE_DESIGN.md s.16.7.2; review P, security 5):
// a secret the bot holds (the approval key now; the bot token, the RPC key and the Anthropic key in
// later steps) is registered once at its start, and from then on the secret filter refuses any text
// that contains it in hex, base64, base64url or base58, in any letter case. The registry only ever
// grows, so registering can only make the filter stricter. It is per process: this file runs in its
// own process (node:test), so nothing registered here reaches another test file. Every value below
// is fake. Written before the registry in src/core/redact.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { base58Of, base64Of, base64UrlOf, hexOf } from '../../../src/core/encode.ts';
import * as redactFile from '../../../src/core/redact.ts';
import { MAX_OWN_FORMS, SecretError, assertNoSecrets, registerOwnSecret, secretKinds } from '../../../src/core/redact.ts';

/** A fake 32-byte key, different for each seed. */
const fakeKey = (seed: number): Uint8Array => Uint8Array.from({ length: 32 }, (_v, i) => (i * 29 + seed * 53 + 7) % 256);
/** A fake key whose base64 holds '+' and '/' (it starts 0xfb 0xff 0xbf: '+/+/'), so its base64 and base64url differ. */
const SIGNED_KEY = Uint8Array.from({ length: 32 }, (_v, i) => [251, 255, 191][i % 3] ?? 0);

describe('the secret filter file: only what it may do', () => {
  it('exports the filter, its error, the registry and its limit, and nothing else', () => {
    assert.deepEqual(Object.keys(redactFile).sort(), ['MAX_OWN_FORMS', 'SecretError', 'assertNoSecrets', 'registerOwnSecret', 'secretKinds']);
    assert.equal(MAX_OWN_FORMS, 32);
  });
});

describe('registerOwnSecret: the forms of a registered secret are refused, in any case, anywhere in a text', () => {
  it('a 32-byte key: hex, base64 (padded or not), base64url and base58, upper and lower case, inside JSON; nothing before it is registered', () => {
    const key = fakeKey(1);
    const forms = [hexOf(key), base64Of(key), base64Of(key).replace(/=+$/, ''), base64UrlOf(key), base58Of(key)];
    for (const form of forms) {
      assert.ok(!secretKinds(JSON.stringify({ note: form.slice(0, 20) })).includes('own-secret'));
    }
    registerOwnSecret(key);
    for (const form of forms) {
      for (const shown of [form, form.toUpperCase(), form.toLowerCase(), JSON.stringify({ k: `x${form}y` })]) {
        assert.ok(secretKinds(shown).includes('own-secret'), shown);
      }
    }
    // a part of a form is not the secret (a split or truncated secret is a written-down limit)
    assert.ok(!secretKinds(base58Of(key).slice(0, 20)).includes('own-secret'));
  });

  it('base64 and base64url are two forms: a key whose base64 holds + and / is found in both, padded or not', () => {
    const b64 = base64Of(SIGNED_KEY);
    assert.ok(b64.includes('+') && b64.includes('/') && b64.endsWith('='));
    assert.notEqual(b64.replace(/=+$/, ''), base64UrlOf(SIGNED_KEY));
    registerOwnSecret(SIGNED_KEY);
    for (const form of [b64, b64.replace(/=+$/, ''), base64UrlOf(SIGNED_KEY), `${base64UrlOf(SIGNED_KEY)}=`]) {
      assert.ok(secretKinds(`{"k":"${form}"}`).includes('own-secret'), form);
    }
  });

  it('a text secret (a bot token, say): the text itself and the encodings of its UTF-8 bytes', () => {
    const token = 'FAKE-own-secret-0123456789';
    const bytes = new TextEncoder().encode(token);
    registerOwnSecret(token);
    for (const form of [token, hexOf(bytes), base64UrlOf(bytes), base58Of(bytes), base64Of(bytes)]) {
      assert.ok(secretKinds(`{"m":"${form}"}`).includes('own-secret'), form);
    }
  });

  it("'own-secret' comes last among the kinds; a refusal never repeats the text", () => {
    const key = fakeKey(2);
    registerOwnSecret(key);
    const text = `secret ${hexOf(key)}`;
    assert.deepEqual(secretKinds(text), ['key-like-run', 'credential-word', 'own-secret']);
    let caught: unknown = null;
    try {
      assertNoSecrets(`{"k":"${base58Of(key)}"}`, 'the test field');
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof SecretError);
    assert.deepEqual(caught.kinds, ['own-secret']);
    assert.ok(!caught.message.includes(base58Of(key)) && !caught.message.toLowerCase().includes(base58Of(key).toLowerCase()));
  });

  it('text with no registered form passes as before', () => {
    assert.deepEqual(secretKinds('{"reasons":["flow-up"],"n":12}'), []);
    assert.deepEqual(secretKinds(base58Of(fakeKey(9))), []); // an address-like run of another key
  });
});

describe('registerOwnSecret refuses what it cannot hold, and the registry only grows', () => {
  it('fewer than 16 bytes or characters, more than 1,024, or anything but bytes and text: refused, nothing registered', () => {
    for (const bad of [new Uint8Array(15), 'x'.repeat(15), new Uint8Array(1_025), 'y'.repeat(1_025), 7, null, undefined, [1, 2, 3], new Uint16Array(16), { length: 16 }]) {
      assert.throws(() => registerOwnSecret(bad as unknown as string), TypeError);
    }
    assert.deepEqual(secretKinds('x'.repeat(15)), []);
  });

  it('the same secret twice adds nothing; the forms past 32 are refused whole, and what was there stays', () => {
    const again = fakeKey(1);
    for (let i = 0; i < 40; i += 1) {
      registerOwnSecret(again); // already registered above: no new form, however often (40 x 4 would pass the limit)
    }
    // fill the registry up to its limit with fresh keys (4 forms each), then one more is refused
    let seed = 100;
    let refused: unknown = null;
    for (; seed < 120; seed += 1) {
      try {
        registerOwnSecret(fakeKey(seed));
      } catch (e) {
        refused = e;
        break;
      }
    }
    assert.ok(refused instanceof RangeError, 'the 33rd form is refused');
    assert.ok(!secretKinds(hexOf(fakeKey(seed))).includes('own-secret'), 'a refused secret registers none of its forms');
    assert.ok(secretKinds(hexOf(fakeKey(seed - 1))).includes('own-secret'), 'the last one that fitted stays');
    assert.ok(secretKinds(hexOf(fakeKey(1))).includes('own-secret'), 'the first one stays');
  });
});
