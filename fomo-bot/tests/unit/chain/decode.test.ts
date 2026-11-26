// The strict decoders of the Phase 2 answers (docs/CHAIN_DESIGN.md s.5, R7, R8, step 7d): hand-written,
// exact keys on the small shapes, every integer a bigint in range (u64, a slot up to 2^63 - 1, a size up
// to 10 MiB), account data canonical base64 of exactly the expected length, fees at most 150 with
// distinct slots, sorted here. A refusal is 'shape' or 'count', never a default or partial value. The
// fixtures are synthetic, in the recorded shapes (VERIFIED_FACTS s.9), parsed from text as the client
// does. Written before src/chain/decode.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseLossless, type Json } from '../../../src/core/json.ts';
import { base64Of } from '../../../src/core/encode.ts';
import {
  decodeAccounts,
  decodeBlockHeight,
  decodeGenesisHash,
  decodePriorityFees,
  decodeRent,
  decodeSlot,
  MAX_FEE_ENTRIES,
  rentFormula,
  type Account,
  type Decoded,
} from '../../../src/chain/decode.ts';

const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const U64_MAX = 18_446_744_073_709_551_615n;
const I63_MAX = 9_223_372_036_854_775_807n;

const refusedAs = <T>(d: Decoded<T>, code: 'shape' | 'count', what = ''): void => {
  assert.deepEqual(d, { ok: false, code }, what);
  assert.ok(Object.isFrozen(d));
};
const valueOf = <T>(d: Decoded<T>): T => {
  assert.ok(d.ok, `expected a value, got ${d.ok ? '' : d.code}`);
  return d.value;
};

describe('bare values: the genesis hash, a slot, a block height, rent', () => {
  it('the genesis hash is the base58 of 32 bytes (the client compares it)', () => {
    assert.deepEqual(decodeGenesisHash(MAINNET), { ok: true, value: MAINNET, context: null });
    assert.deepEqual(decodeGenesisHash(DEVNET), { ok: true, value: DEVNET, context: null });
    // (MAINNET without its first character is still 32 bytes: base58 lengths are not fixed)
    for (const bad of ['', '1'.repeat(31), `${MAINNET}1`, MAINNET.slice(0, 20), `${MAINNET} `, `0${MAINNET.slice(1)}`, 5n, null, [MAINNET], { hash: MAINNET }] as Json[]) {
      refusedAs(decodeGenesisHash(bad), 'shape', String(bad));
    }
  });

  it('a slot and a block height are bigints from 0 to 2^63 - 1, nothing else', () => {
    for (const v of [0n, 473_300_561n, I63_MAX]) {
      assert.deepEqual(decodeSlot(v), { ok: true, value: v, context: null });
      assert.deepEqual(decodeBlockHeight(v), { ok: true, value: v, context: null });
    }
    for (const bad of [-1n, I63_MAX + 1n, U64_MAX, parseLossless('1e3'), parseLossless('5.0'), 5, '5', null, true, [5n], {}] as Json[]) {
      refusedAs(decodeSlot(bad), 'shape', String(bad));
      refusedAs(decodeBlockHeight(bad), 'shape', String(bad));
    }
  });

  it('rent is u64 lamports; the formula (128 + bytes) x 5,080 is only compared (the chain is the truth)', () => {
    assert.deepEqual(decodeRent(1_488_440n), { ok: true, value: 1_488_440n, context: null });
    assert.deepEqual(decodeRent(0n), { ok: true, value: 0n, context: null });
    assert.deepEqual(decodeRent(U64_MAX), { ok: true, value: U64_MAX, context: null });
    for (const bad of [-1n, U64_MAX + 1n, parseLossless('1488440.0'), '1488440', null] as Json[]) {
      refusedAs(decodeRent(bad), 'shape', String(bad));
    }
    assert.equal(rentFormula(165), 1_488_440n); // an SPL token account (VERIFIED_FACTS s.3)
    assert.equal(rentFormula(170), 1_513_840n); // a Token-2022 ATA
    assert.equal(rentFormula(0), 650_240n);
    assert.equal(rentFormula(10_485_760), (128n + 10_485_760n) * 5_080n);
    for (const bad of [-1, 1.5, 10_485_761, Number.NaN, 165n, '165'] as unknown[]) {
      assert.throws(() => rentFormula(bad as number), TypeError);
    }
  });
});

// ---- getMultipleAccounts

const MINT_DATA = Uint8Array.from({ length: 82 }, (_v, i) => (i * 7 + 1) & 255);
const PROGRAM_DATA = Uint8Array.from({ length: 36 }, (_v, i) => (i === 0 ? 2 : i));

interface AccountText {
  data?: string;
  executable?: string;
  lamports?: string;
  owner?: string;
  rentEpoch?: string;
  space?: string;
  extra?: string;
}

/** An account object as JSON text, each field's text replaceable (so integers can be respelled). */
function accountText(over: AccountText = {}, bytes: Uint8Array = MINT_DATA, space = bytes.length): string {
  const fields: Record<string, string | undefined> = {
    data: `["${base64Of(bytes)}","base64"]`,
    executable: 'false',
    lamports: '1461600',
    owner: `"${TOKEN_PROGRAM}"`,
    rentEpoch: '18446744073709551615',
    space: String(space),
    ...over,
  };
  return `{${Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== 'DROP')
    .map(([k, v]) => `"${k}":${v as string}`)
    .join(',')}}`;
}

const answer = (values: readonly string[], context = '{"apiVersion":"4.4.0","slot":385000000}'): Json => parseLossless(`{"context":${context},"value":[${values.join(',')}]}`);

describe('decodeAccounts: the batch, its context and each account, exactly', () => {
  it('reads accounts in request order, null for a missing one, every integer exact, the data a fresh copy', () => {
    const programText = accountText({ executable: 'true', owner: `"${LOADER}"`, lamports: '1141440' }, PROGRAM_DATA);
    const d = decodeAccounts(answer([accountText(), 'null', programText]), 3, null);
    const v = valueOf(d);
    assert.deepEqual(d.ok && d.context, { slot: 385_000_000n, apiVersion: '4.4.0' });
    assert.equal(v.length, 3);
    const mint = v[0] as Account;
    assert.deepEqual({ ...mint, data: [...mint.data] }, { lamports: 1_461_600n, owner: TOKEN_PROGRAM, executable: false, rentEpoch: U64_MAX, space: 82, data: [...MINT_DATA] });
    assert.equal(v[1], null);
    const program = v[2] as Account;
    assert.equal(program.executable, true);
    assert.equal(program.owner, LOADER);
    assert.deepEqual([...program.data], [...PROGRAM_DATA]);
    assert.ok(Object.isFrozen(d) && Object.isFrozen(v) && Object.isFrozen(mint) && Object.isFrozen(d.ok && d.context));
    assert.ok(mint.data instanceof Uint8Array);
    const again = valueOf(decodeAccounts(answer([accountText()]), 1, null))[0] as Account;
    assert.notEqual(again.data, mint.data, 'each decode makes its own bytes');
    again.data[0] = 0;
    assert.equal(mint.data[0], MINT_DATA[0]);
  });

  it('an empty account and the largest numbers decode; lamports above 2^53 stay exact', () => {
    const empty = valueOf(decodeAccounts(answer([accountText({ data: '["","base64"]', space: '0', lamports: '18446744073709551615', rentEpoch: '0' }, new Uint8Array(0))]), 1, null))[0] as Account;
    assert.equal(empty.space, 0);
    assert.equal(empty.data.length, 0);
    assert.equal(empty.lamports, U64_MAX);
    assert.equal(empty.rentEpoch, 0n);
    const big = valueOf(decodeAccounts(answer([accountText({ lamports: '9007199254740993' })]), 1, null))[0] as Account;
    assert.equal(big.lamports, 9_007_199_254_740_993n);
  });

  it('the number of answers must equal the number of keys', () => {
    refusedAs(decodeAccounts(answer([accountText()]), 2, null), 'count');
    refusedAs(decodeAccounts(answer([accountText(), 'null']), 1, null), 'count');
    refusedAs(decodeAccounts(answer([]), 1, null), 'count');
    for (const bad of [0, 101, 1.5, Number.NaN, '1'] as unknown[]) {
      assert.throws(() => decodeAccounts(answer([accountText()]), bad as number, null), TypeError);
    }
  });

  it('refuses a missing, extra or mistyped key at the top, in the context and in the account (R7)', () => {
    const one = accountText();
    for (const top of [
      `{"value":[${one}]}`,
      `{"context":{"apiVersion":"4.4.0","slot":1},"value":[${one}],"extra":1}`,
      `{"context":{"apiVersion":"4.4.0","slot":1}}`,
      `{"context":{"apiVersion":"4.4.0","slot":1},"value":${one}}`,
      `{"context":{"apiVersion":"4.4.0","slot":1},"value":null}`,
      `[{"apiVersion":"4.4.0","slot":1},[${one}]]`,
      'null',
      `{"context":{"slot":1},"value":[${one}]}`,
      `{"context":{"apiVersion":"4.4.0"},"value":[${one}]}`,
      `{"context":{"apiVersion":"4.4.0","slot":1,"extra":1},"value":[${one}]}`,
      `{"context":{"apiVersion":4,"slot":1},"value":[${one}]}`,
      `{"context":{"apiVersion":"","slot":1},"value":[${one}]}`,
      `{"context":{"apiVersion":"${'4'.repeat(65)}","slot":1},"value":[${one}]}`,
      `{"context":{"apiVersion":"4.4.0","slot":-1},"value":[${one}]}`,
      `{"context":{"apiVersion":"4.4.0","slot":9223372036854775808},"value":[${one}]}`,
      `{"context":{"apiVersion":"4.4.0","slot":1.0},"value":[${one}]}`,
      `{"context":{"apiVersion":"4.4.0","slot":"1"},"value":[${one}]}`,
      `{"context":null,"value":[${one}]}`,
    ]) {
      refusedAs(decodeAccounts(parseLossless(top), 1, null), 'shape', top);
    }
    const accounts: readonly [string, AccountText][] = [
      ['data missing', { data: 'DROP' }],
      ['executable missing', { executable: 'DROP' }],
      ['lamports missing', { lamports: 'DROP' }],
      ['owner missing', { owner: 'DROP' }],
      ['rentEpoch missing', { rentEpoch: 'DROP' }],
      ['space missing', { space: 'DROP' }],
      ['an extra key', { extra: '1' }],
      ['lamports a float', { lamports: '1461600.0' }],
      ['lamports 1e3', { lamports: '1e3' }],
      ['lamports a string', { lamports: '"1461600"' }],
      ['lamports negative', { lamports: '-1' }],
      ['lamports over u64', { lamports: '18446744073709551616' }],
      ['rentEpoch over u64', { rentEpoch: '18446744073709551616' }],
      ['rentEpoch a float', { rentEpoch: '1.5' }],
      ['owner too short', { owner: '"1111111111111111111111111111111"' }],
      ['owner not base58', { owner: `"${TOKEN_PROGRAM.slice(0, -1)}0"` }],
      ['owner a number', { owner: '5' }],
      ['executable a number', { executable: '0' }],
      ['executable a string', { executable: '"false"' }],
      ['space over 10 MiB', { space: '10485761' }],
      ['space a float', { space: '82.0' }],
      ['space negative', { space: '-82' }],
      ['data a string', { data: `"${base64Of(MINT_DATA)}"` }],
      ['data with base58', { data: `["${base64Of(MINT_DATA)}","base58"]` }],
      ['data with three items', { data: `["${base64Of(MINT_DATA)}","base64",1]` }],
      ['data with one item', { data: `["${base64Of(MINT_DATA)}"]` }],
      ['data not canonical base64', { data: `["${base64Of(MINT_DATA).replace('=', '')}","base64"]` }],
      ['data with a space', { data: `[" ${base64Of(MINT_DATA)}","base64"]` }],
      ['data shorter than space', { space: '83' }],
      ['data longer than space', { space: '81' }],
    ];
    for (const [what, over] of accounts) {
      refusedAs(decodeAccounts(answer([accountText(over)]), 1, null), 'shape', what);
    }
    refusedAs(decodeAccounts(answer(['1']), 1, null), 'shape', 'an account a number');
    refusedAs(decodeAccounts(answer(['[]']), 1, null), 'shape', 'an account a list');
    refusedAs(decodeAccounts(answer(['{}']), 1, null), 'shape', 'an account empty');
  });

  it('with a slice, the data is min(length, max(0, space - offset)) bytes, and space stays the full length', () => {
    const sliced = (offset: number, length: number, bytes: Uint8Array): Decoded<readonly (Account | null)[]> =>
      decodeAccounts(answer([accountText({}, bytes, 82)]), 1, { offset, length });
    const head = valueOf(sliced(0, 8, MINT_DATA.slice(0, 8)))[0] as Account;
    assert.equal(head.space, 82);
    assert.deepEqual([...head.data], [...MINT_DATA.slice(0, 8)]);
    assert.equal((valueOf(sliced(80, 8, MINT_DATA.slice(80)))[0] as Account).data.length, 2);
    assert.equal((valueOf(sliced(82, 8, new Uint8Array(0)))[0] as Account).data.length, 0);
    assert.equal((valueOf(sliced(100, 8, new Uint8Array(0)))[0] as Account).data.length, 0);
    assert.equal((valueOf(sliced(0, 0, new Uint8Array(0)))[0] as Account).data.length, 0);
    refusedAs(sliced(0, 8, MINT_DATA.slice(0, 7)), 'shape', 'one byte short');
    refusedAs(sliced(0, 8, MINT_DATA.slice(0, 9)), 'shape', 'one byte over');
    refusedAs(sliced(80, 8, MINT_DATA.slice(80, 81)), 'shape', 'the tail one short');
    refusedAs(sliced(100, 8, MINT_DATA.slice(0, 1)), 'shape', 'bytes past the end');
    refusedAs(decodeAccounts(answer([accountText()]), 1, { offset: 0, length: 8 }), 'shape', 'the whole account where a slice was asked');
    // the size bounds on their own: with a slice the data length fits, so only the bound refuses
    refusedAs(decodeAccounts(answer([accountText({ space: '10485761' }, MINT_DATA.slice(0, 8))]), 1, { offset: 0, length: 8 }), 'shape', 'space over 10 MiB, the slice fitting');
    assert.ok(decodeAccounts(answer([accountText({ space: '10485760' }, MINT_DATA.slice(0, 8))]), 1, { offset: 0, length: 8 }).ok, 'space at 10 MiB');
    refusedAs(decodeAccounts(answer([accountText({ space: '-1' }, new Uint8Array(0))]), 1, { offset: 0, length: 8 }), 'shape', 'a negative space, the slice empty');
    for (const bad of [{ offset: -1, length: 8 }, { offset: 0, length: 10_485_761 }, { offset: 0.5, length: 8 }] as unknown[]) {
      assert.throws(() => decodeAccounts(answer([accountText()]), 1, bad as { offset: number; length: number }), TypeError);
    }
  });
});

// ---- getRecentPrioritizationFees

const feeEntry = (s: bigint | string, fee: bigint | string): string => `{"slot":${s},"prioritizationFee":${fee}}`;
const fees = (entries: readonly string[]): Json => parseLossless(`[${entries.join(',')}]`);

describe('decodePriorityFees: at most 150 entries, distinct slots, sorted here (U13)', () => {
  it('reads 150 entries in any order and returns them by slot, fees exact', () => {
    assert.equal(MAX_FEE_ENTRIES, 150);
    const entries = Array.from({ length: 150 }, (_v, i) => feeEntry(BigInt(473_300_600 - i), BigInt(i === 0 ? 6_578_949 : i % 2 === 0 ? 0 : 26_041)));
    const d = decodePriorityFees(fees(entries));
    const v = valueOf(d);
    assert.equal(v.length, 150);
    assert.deepEqual(v[0], { slot: 473_300_451n, fee: 26_041n });
    assert.deepEqual(v[149], { slot: 473_300_600n, fee: 6_578_949n });
    for (let i = 1; i < v.length; i += 1) {
      assert.ok((v[i] as { slot: bigint }).slot > (v[i - 1] as { slot: bigint }).slot);
    }
    assert.ok(Object.isFrozen(d) && Object.isFrozen(v) && Object.isFrozen(v[0]));
    assert.deepEqual(decodePriorityFees(fees([])), { ok: true, value: [], context: null });
    assert.deepEqual(valueOf(decodePriorityFees(fees([feeEntry(5n, U64_MAX)]))), [{ slot: 5n, fee: U64_MAX }]);
  });

  it('refuses more than 150 entries, a slot twice, and any entry not exactly {slot, prioritizationFee} in range', () => {
    refusedAs(decodePriorityFees(fees(Array.from({ length: 151 }, (_v, i) => feeEntry(BigInt(i), 0n)))), 'count');
    refusedAs(decodePriorityFees(fees([feeEntry(5n, 1n), feeEntry(6n, 1n), feeEntry(5n, 2n)])), 'shape', 'a slot twice');
    for (const bad of [
      '{"slot":5}',
      '{"prioritizationFee":5}',
      '{"slot":5,"prioritizationFee":5,"extra":1}',
      feeEntry('5.0', '1'),
      feeEntry('5', '1e3'),
      feeEntry('"5"', '1'),
      feeEntry('-1', '1'),
      feeEntry('9223372036854775808', '1'),
      feeEntry('5', '-1'),
      feeEntry('5', '18446744073709551616'),
      'null',
      '[5,1]',
    ]) {
      refusedAs(decodePriorityFees(fees([bad])), 'shape', bad);
    }
    for (const bad of [null, {}, 5n, '[]'] as Json[]) {
      refusedAs(decodePriorityFees(bad), 'shape', String(bad));
    }
  });
});
