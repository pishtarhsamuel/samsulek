// The decoders against random answers (docs/CHAIN_DESIGN.md s.13): a random valid getMultipleAccounts or
// fee answer decodes to exactly its values; a random structural mutation of one (a key removed, added or
// renamed, a value of another JSON type, an integer respelled as 1e0, 1.0 or a string) is always refused.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { parseLossless, stringifyLossless, type Json } from '../../../src/core/json.ts';
import { base58Of, base64Of } from '../../../src/core/encode.ts';
import { decodeAccounts, decodePriorityFees, type Account } from '../../../src/chain/decode.ts';

const U64_MAX = (1n << 64n) - 1n;
const I63_MAX = (1n << 63n) - 1n;
const RESPELL = '@@respell@@';

type Mutable = { [k: string]: Mutable } | Mutable[] | string | bigint | boolean | null;

interface AccountSpec {
  lamports: bigint;
  owner: string;
  executable: boolean;
  rentEpoch: bigint;
  data: Uint8Array;
}

const u64Arb = fc.oneof(fc.bigInt({ min: 0n, max: U64_MAX }), fc.constantFrom(0n, (1n << 53n) + 1n, U64_MAX));
const accountArb: fc.Arbitrary<AccountSpec> = fc.record({
  lamports: u64Arb,
  owner: fc.uint8Array({ minLength: 32, maxLength: 32 }).map((b) => base58Of(b)),
  executable: fc.boolean(),
  rentEpoch: u64Arb,
  data: fc.uint8Array({ minLength: 0, maxLength: 48 }),
});
const batchArb = fc.record({
  slot: fc.bigInt({ min: 0n, max: I63_MAX }),
  accounts: fc.array(fc.option(accountArb, { nil: null }), { minLength: 1, maxLength: 5 }),
});

const accountObject = (a: AccountSpec): Mutable => ({
  data: [base64Of(a.data), 'base64'],
  executable: a.executable,
  lamports: a.lamports,
  owner: a.owner,
  rentEpoch: a.rentEpoch,
  space: BigInt(a.data.length),
});

const batchObject = (b: { slot: bigint; accounts: (AccountSpec | null)[] }): { [k: string]: Mutable } => ({
  context: { apiVersion: '4.4.0', slot: b.slot },
  value: b.accounts.map((a) => (a === null ? null : accountObject(a))),
});

/** Writes the object, then puts the respelled integer where the marker is. */
const textOf = (o: Mutable, respelled: string | null): string => {
  const t = stringifyLossless(o as Json);
  return respelled === null ? t : t.replace(JSON.stringify(RESPELL), respelled);
};

/** A value of another JSON type than v. */
function otherType(v: Mutable, pick: number): Mutable {
  const pool: Mutable[] = typeof v === 'bigint' ? ['7', null, true, [], {}] : typeof v === 'string' ? [7n, null, true, [], {}] : typeof v === 'boolean' ? ['true', 0n, null, []] : Array.isArray(v) ? ['x', null, {}, 7n] : ['x', null, [], 7n];
  return pool[pick % pool.length] as Mutable;
}

interface Mutation {
  /** Which object in the answer: the top, the context, or the n-th present account. */
  target: 'top' | 'context' | 'account' | 'data';
  op: 'remove' | 'add' | 'rename' | 'retype' | 'respell';
  keyPick: number;
  valuePick: number;
  form: string;
}

const mutationArb: fc.Arbitrary<Mutation> = fc.record({
  target: fc.constantFrom('top', 'context', 'account', 'data'),
  op: fc.constantFrom('remove', 'add', 'rename', 'retype', 'respell'),
  keyPick: fc.nat(),
  valuePick: fc.nat(),
  form: fc.constantFrom('e0', '.0', 'string', 'E+0', '.00'),
});

/** Applies the mutation in place; returns the respelled text for the marker, or null. */
function mutate(top: { [k: string]: Mutable }, m: Mutation): string | null {
  const present = (top['value'] as Mutable[]).filter((a) => a !== null) as { [k: string]: Mutable }[];
  if ((m.target === 'account' || m.target === 'data') && present.length === 0) {
    m = { ...m, target: 'top' };
  }
  const account = present[m.keyPick % Math.max(1, present.length)];
  if (m.target === 'data') {
    const data = (account as { [k: string]: Mutable })['data'] as Mutable[];
    switch (m.op) {
      case 'remove':
        data.pop();
        return null;
      case 'add':
        data.push('base64');
        return null;
      default: {
        const i = m.valuePick % 2;
        data[i] = otherType(data[i] as Mutable, m.keyPick);
        return null;
      }
    }
  }
  const obj = m.target === 'top' ? top : m.target === 'context' ? (top['context'] as { [k: string]: Mutable }) : (account as { [k: string]: Mutable });
  const keys = Object.keys(obj);
  const k = keys[m.keyPick % keys.length] as string;
  switch (m.op) {
    case 'remove':
      delete obj[k];
      return null;
    case 'add':
      obj[`extra${m.valuePick % 3}`] = 1n;
      return null;
    case 'rename':
      obj[`${k}X`] = obj[k] as Mutable;
      delete obj[k];
      return null;
    case 'retype':
      obj[k] = otherType(obj[k] as Mutable, m.valuePick);
      return null;
    case 'respell': {
      const ints = keys.filter((x) => typeof obj[x] === 'bigint');
      if (ints.length === 0) {
        obj[k] = otherType(obj[k] as Mutable, m.valuePick); // nothing to respell here: retype instead
        return null;
      }
      const name = ints[m.valuePick % ints.length] as string;
      const n = obj[name] as bigint;
      obj[name] = RESPELL;
      return m.form === 'string' ? `"${n}"` : `${n}${m.form}`;
    }
  }
}

describe('decodeAccounts against random answers', () => {
  it('a valid answer decodes to exactly its values, in order', () => {
    fc.assert(
      fc.property(batchArb, (b) => {
        const d = decodeAccounts(parseLossless(textOf(batchObject(b), null)), b.accounts.length, null);
        assert.ok(d.ok);
        assert.deepEqual(d.context, { slot: b.slot, apiVersion: '4.4.0' });
        b.accounts.forEach((a, i) => {
          const got = d.value[i] as Account | null;
          if (a === null) {
            assert.equal(got, null);
          } else {
            assert.ok(got !== null);
            assert.deepEqual({ ...got, data: [...got.data] }, { lamports: a.lamports, owner: a.owner, executable: a.executable, rentEpoch: a.rentEpoch, space: a.data.length, data: [...a.data] });
          }
        });
      }),
      { numRuns: 1_000 },
    );
  });

  it('a structural mutation is always refused, as shape (or count, when a list lost or gained an item)', () => {
    fc.assert(
      fc.property(batchArb, mutationArb, (b, m) => {
        const top = batchObject(b);
        const respelled = mutate(top, m);
        const d = decodeAccounts(parseLossless(textOf(top, respelled)), b.accounts.length, null);
        assert.equal(d.ok, false, JSON.stringify(m));
      }),
      { numRuns: 1_000 },
    );
  });
});

const feesArb = fc.uniqueArray(fc.bigInt({ min: 0n, max: I63_MAX }), { minLength: 1, maxLength: 150 }).chain((slots) =>
  fc.tuple(fc.constant(slots), fc.array(u64Arb, { minLength: slots.length, maxLength: slots.length })),
);

describe('decodePriorityFees against random answers', () => {
  it('distinct slots in any order decode to the same entries, sorted by slot', () => {
    fc.assert(
      fc.property(feesArb, ([slots, values]) => {
        const entries = slots.map((s, i) => ({ slot: s, prioritizationFee: values[i] as bigint }));
        const d = decodePriorityFees(parseLossless(stringifyLossless(entries)));
        assert.ok(d.ok);
        const expected = entries.map((e) => ({ slot: e.slot, fee: e.prioritizationFee })).sort((x, y) => (x.slot < y.slot ? -1 : 1));
        assert.deepEqual(d.value, expected);
      }),
      { numRuns: 1_000 },
    );
  });

  it('one entry mutated (a key removed, added or renamed, retyped, respelled) refuses the whole answer', () => {
    fc.assert(
      fc.property(feesArb, fc.nat(), mutationArb, ([slots, values], which, m) => {
        const entries: { [k: string]: Mutable }[] = slots.map((s, i) => ({ slot: s, prioritizationFee: values[i] as bigint }));
        const e = entries[which % entries.length] as { [k: string]: Mutable };
        const keys = Object.keys(e);
        const k = keys[m.keyPick % keys.length] as string;
        let respelled: string | null = null;
        switch (m.op) {
          case 'remove':
            delete e[k];
            break;
          case 'add':
            e['extra'] = 1n;
            break;
          case 'rename':
            e[`${k}X`] = e[k] as Mutable;
            delete e[k];
            break;
          case 'retype':
            e[k] = otherType(e[k] as Mutable, m.valuePick);
            break;
          case 'respell': {
            const n = e[k] as bigint;
            e[k] = RESPELL;
            respelled = m.form === 'string' ? `"${n}"` : `${n}${m.form}`;
            break;
          }
        }
        const d = decodePriorityFees(parseLossless(textOf(entries, respelled)));
        assert.equal(d.ok, false, JSON.stringify(m));
      }),
      { numRuns: 1_000 },
    );
  });
});
