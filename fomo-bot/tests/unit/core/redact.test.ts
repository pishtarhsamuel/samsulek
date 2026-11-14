// The secret filter (STORAGE_DESIGN.md s.6 "Never in the database"; THREAT_MODEL.md "Redaction"):
// text that looks like a key, a seed phrase, a bot token, an API credential or a URL is refused,
// never masked, and the refusal never repeats what it found. Every canary below is fake.
// Written before src/core/redact.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretError, assertNoSecrets, secretKinds } from '../../../src/core/redact.ts';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Base58 text of a given length that looks random enough (fake). */
const base58 = (n: number): string => Array.from({ length: n }, (_v, i) => B58[(i * 7 + 3) % 58]).join('');
const byteValues = (n: number): number[] => Array.from({ length: n }, (_v, i) => (i * 37 + 11) % 256);
const bytes = (n: number): string => JSON.stringify(byteValues(n));
const hexPairs = (n: number, sep: string): string => byteValues(n).map((b) => b.toString(16).padStart(2, '0')).join(sep);

describe('secretKinds: what looks like a secret', () => {
  const canaries: [string, string, string][] = [
    ['a 64-byte key in base58 (88 characters)', base58(88), 'key-like-run'],
    ['a transaction signature (87 characters, typed columns only)', base58(87), 'key-like-run'],
    ['a 32-byte value in hex (64 characters)', 'ab'.repeat(32), 'key-like-run'],
    ['48 bytes in base64', `${'QUJD+/'.repeat(11)}ab==`, 'key-like-run'],
    ['base64url', `${'Ab_-'.repeat(16)}`, 'key-like-run'],
    ['a keypair file: 64 numbers', bytes(64), 'byte-array'],
    ['a seed: 32 numbers with spaces', bytes(32).replaceAll(',', ', '), 'byte-array'],
    ['a keypair as quoted numbers (or bigints after jsonParam)', JSON.stringify(byteValues(64).map(String)), 'byte-array'],
    ['32 bytes as printed by a Buffer', `<Buffer ${hexPairs(32, ' ')}>`, 'byte-array'],
    ['32 bytes in hex split by colons', hexPairs(32, ':').toUpperCase(), 'byte-array'],
    ['a percent-encoded URL', '{"u":"https%3A%2F%2Frpc.example.invalid"}', 'url'],
    ['a percent-encoded URL in lower case', 'wss%3a%2f%2fstream.example.invalid', 'url'],
    ['a PEM header', '-----BEGIN PRIVATE KEY-----', 'pem'],
    ['api_key', 'x api_key y', 'credential-word'],
    ['api-key', 'url?api-key=abc', 'credential-word'],
    ['ApiKey', '{"ApiKey":1}', 'credential-word'],
    ['secret', '{"clientSecret":"x"}', 'credential-word'],
    ['password', 'Password: hunter2', 'credential-word'],
    ['passwd', 'passwd', 'credential-word'],
    ['passphrase', 'passphrase', 'credential-word'],
    ['private key', '{"private_key":1}', 'credential-word'],
    ['privateKey', '{"privateKey":1}', 'credential-word'],
    ['mnemonic', 'mnemonic', 'credential-word'],
    ['seed phrase', 'my seed phrase is', 'credential-word'],
    ['authorization', 'Authorization: x', 'credential-word'],
    ['bearer', 'Bearer abc', 'credential-word'],
    ['token=', 'hc?token=abc', 'credential-word'],
    ['a Telegram bot token', `123456789:${'AAH'.repeat(12)}`, 'bot-token'],
    ['a bot token with a 7-digit id', `1234567:${'AAH'.repeat(12)}`, 'bot-token'],
    ['an access token field', '{"access_token":"x"}', 'credential-word'],
    ['a refresh token', 'refresh-token', 'credential-word'],
    ['a URL with JSON-escaped slashes', '{"rpc":"https:\\/\\/rpc.example.invalid"}', 'url'],
    ['an Anthropic key prefix', 'sk-ant-api03-x', 'anthropic-key'],
    ['an https URL', 'https://rpc.example.invalid/v1', 'url'],
    ['a wss URL', 'wss://stream.example.invalid', 'url'],
    ['an http URL in JSON', '{"rpc":"http://127.0.0.1:8899"}', 'url'],
    ['twelve seed words', 'abandon ability able about above absent absorb abstract absurd abuse access accident', 'seed-phrase'],
    ['twenty-four seed words, other spacing', `${'zoo '.repeat(23)}wrong`, 'seed-phrase'],
  ];

  for (const [name, text, kind] of canaries) {
    it(`finds ${name}`, () => {
      assert.ok(secretKinds(text).includes(kind as never), `${name}: ${JSON.stringify(secretKinds(text))}`);
    });
  }

  it('finds a secret inside larger JSON, and lists each kind once, in a fixed order', () => {
    const text = JSON.stringify({ reasons: ['blocked:kill'], key: base58(88), again: base58(88), url: 'https://x.invalid' });
    assert.deepEqual(secretKinds(text), ['key-like-run', 'url']);
  });

  it('does not flag what the bot really stores: codes, ids, addresses, amounts, short arrays, field names', () => {
    const clean = [
      'blocked:kill',
      'sizing:no-live-price',
      'plan:min-out-below-slippage',
      'So11111111111111111111111111111111111111112', // a 43-character address
      base58(44), // the longest address
      '3f2b6c1e-9a4d-4c8e-8f1a-2b3c4d5e6f70', // a UUID
      'a'.repeat(63), // just under the run length
      '18446744073709551615',
      bytes(31), // just under the array length
      JSON.stringify(byteValues(31).map(String)),
      hexPairs(31, ' '),
      '{"at":"12:30","ratio":"3:2","pct":"%3A"}',
      '[1000,2000,3000,4000,5000,6000,7000,8000,9000,10000,1100,1200,1300,1400,1500,1600,1700,1800,1900,2000,2100,2200,2300,2400,2500,2600,2700,2800,2900,3000,3100,3200]', // 32 numbers, not bytes
      'abandon ability able about above absent absorb abstract absurd abuse access', // eleven words
      JSON.stringify({ tokenAccount: base58(44), keys: ['mint', 'pool'], monkey: 1, token: 'abc', tokens: 5, keyed: true }),
      JSON.stringify({ reasons: ['blocked:pause', 'blocked:daily-stop'], equity: '123456789012345678', bps: [100, 200, 300], at: 1_700_000_000_000 }),
      '',
    ];
    for (const text of clean) {
      assert.deepEqual(secretKinds(text), [], text);
    }
  });

  it('takes text only (anything else is a bug upstream)', () => {
    assert.throws(() => secretKinds(5 as unknown as string), TypeError);
    assert.throws(() => secretKinds(null as unknown as string), TypeError);
  });

  it('stays fast on long hostile text (no catastrophic backtracking)', () => {
    const hostile = [
      `${'1,'.repeat(4_000)}x`,
      `[${'1, '.repeat(4_000)}`,
      `${'abc '.repeat(4_000)}1`,
      `${'a'.repeat(40_000)}!`,
      `${'1'.repeat(9)}:${'A'.repeat(29)} `.repeat(500),
      `["1",${'"1", '.repeat(4_000)}`,
      `${'ab '.repeat(30)}x`.repeat(300),
      `${'ab:'.repeat(4_000)}`,
      `${'http%3a%2f'.repeat(4_000)}`,
    ];
    for (const text of hostile) {
      const started = Date.now();
      secretKinds(text);
      assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms on ${text.slice(0, 20)}...`);
    }
  });
});

describe('assertNoSecrets: refuses, never masks, never repeats the value', () => {
  it('passes clean text', () => {
    assert.doesNotThrow(() => assertNoSecrets('{"reasons":["blocked:kill"]}', 'the reasons'));
  });

  it('throws a SecretError naming the place and the kinds, without any part of the text', () => {
    const fake = base58(88);
    let caught: unknown = null;
    try {
      assertNoSecrets(`{"x":"${fake}","rpc":"https://example.invalid/?api-key=QWERTY"}`, 'the intent inputs');
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof SecretError);
    assert.equal(caught.name, 'SecretError');
    assert.deepEqual(caught.kinds, ['key-like-run', 'credential-word', 'url']);
    assert.ok(Object.isFrozen(caught.kinds));
    assert.match(caught.message, /the intent inputs/);
    for (const piece of [fake.slice(0, 10), 'QWERTY', 'example.invalid']) {
      assert.ok(!caught.message.includes(piece), piece);
      assert.ok(!String(caught.stack).includes(piece), piece);
    }
  });

  it('refuses text it cannot read', () => {
    assert.throws(() => assertNoSecrets(undefined as unknown as string, 'x'), TypeError);
  });
});
