// The lossless reader against random numbers and spellings (docs/CHAIN_DESIGN.md s.13): a bigint comes
// out exactly when the source is canonical digits, at most 20 of them (review X, security 4), and its
// value then equals BigInt(source); any other valid spelling stays a JS number. Inside arrays and
// objects too.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { parseLossless } from '../../../src/core/json.ts';

/** Plain digits, at most 20 of them: what becomes a bigint. */
const CANONICAL = /^-?(0|[1-9][0-9]{0,19})$/;

// integers of every size around the u64 and i64 edges, and valid JSON spellings that are not plain digits
const integerArb = fc.oneof(
  fc.bigInt({ min: -(1n << 70n), max: 1n << 70n }),
  fc.constantFrom(0n, -1n, (1n << 53n) - 1n, 1n << 53n, (1n << 53n) + 1n, (1n << 63n) - 1n, 1n << 63n, (1n << 64n) - 1n, 1n << 64n),
);
const spellingArb = fc.tuple(integerArb, fc.constantFrom('plain', '.0', '.50', 'e0', 'E1', 'e-2', 'E+3')).map(([n, form]) => {
  if (form === 'plain') {
    return n.toString();
  }
  return n.toString() + form;
});

describe('parseLossless against random numbers and spellings', () => {
  it('a bigint exactly when the source is canonical digits, equal to BigInt(source); otherwise a number', () => {
    fc.assert(
      fc.property(spellingArb, (source) => {
        const v = parseLossless(source);
        if (CANONICAL.test(source) && source !== '-0') {
          assert.equal(typeof v, 'bigint', source);
          assert.equal(v, BigInt(source));
        } else {
          assert.equal(typeof v, 'number', source);
        }
      }),
      { numRuns: 1_000 },
    );
  });

  it('the same inside arrays and objects, each value on its own', () => {
    fc.assert(
      fc.property(fc.array(spellingArb, { minLength: 1, maxLength: 8 }), (sources) => {
        const v = parseLossless(`{"a":[${sources.join(',')}]}`) as { readonly a: readonly unknown[] };
        sources.forEach((source, i) => {
          const canonical = CANONICAL.test(source) && source !== '-0';
          assert.equal(typeof v.a[i], canonical ? 'bigint' : 'number', source);
          if (canonical) {
            assert.equal(v.a[i], BigInt(source));
          }
        });
      }),
      { numRuns: 1_000 },
    );
  });
});
