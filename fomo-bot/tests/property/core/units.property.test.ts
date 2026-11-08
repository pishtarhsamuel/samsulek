// Property-based tests for core/units (TEST_PLAN.md s.4): rounding direction, exactness and
// TEXT round trips hold for random values across the whole u64 range. fast-check prints the
// seed and the shrunk counterexample on failure, so any failure is reproducible.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  AmountError,
  U64_MAX,
  addLamports,
  bps,
  bpsOfCeil,
  bpsOfFloor,
  formatSol,
  lamports,
  lamportsFromText,
  mulDivCeil,
  mulDivFloor,
  parseSolAmount,
  signedLamports,
  signedLamportsFromText,
  subLamports,
  toText,
} from '../../../src/core/units.ts';

const u64 = fc.bigInt({ min: 0n, max: U64_MAX });
const divisor = fc.bigInt({ min: 1n, max: U64_MAX });
const rate = fc.integer({ min: 0, max: 10_000 });

describe('rounding properties', () => {
  it('mulDivFloor is the exact floor and mulDivCeil the exact ceiling', () => {
    fc.assert(
      fc.property(u64, u64, divisor, (a, b, d) => {
        const lo = mulDivFloor(a, b, d);
        const hi = mulDivCeil(a, b, d);
        assert.ok(lo * d <= a * b && a * b < (lo + 1n) * d, 'floor bound');
        assert.ok((hi - 1n) * d < a * b && a * b <= hi * d, 'ceiling bound');
        assert.equal(hi - lo, (a * b) % d === 0n ? 0n : 1n);
      }),
    );
  });

  it('a cap (floor) never exceeds a cost (ceiling) of the same rate', () => {
    fc.assert(
      fc.property(u64, rate, (amount, r) => {
        const cap = bpsOfFloor(amount, bps(r));
        const cost = bpsOfCeil(amount, bps(r));
        assert.ok(cap <= cost && cost - cap <= 1n);
        assert.ok(cap <= amount, 'a percentage cap never exceeds the amount');
      }),
    );
  });
});

describe('checked arithmetic properties', () => {
  it('addition succeeds exactly when the sum fits u64', () => {
    fc.assert(
      fc.property(u64, u64, (a, b) => {
        if (a + b <= U64_MAX) {
          assert.equal(addLamports(lamports(a), lamports(b)), a + b);
        } else {
          assert.throws(() => addLamports(lamports(a), lamports(b)), AmountError);
        }
      }),
    );
  });

  it('subtraction succeeds exactly when it does not go below zero', () => {
    fc.assert(
      fc.property(u64, u64, (a, b) => {
        if (a >= b) {
          assert.equal(subLamports(lamports(a), lamports(b)), a - b);
        } else {
          assert.throws(() => subLamports(lamports(a), lamports(b)), AmountError);
        }
      }),
    );
  });
});

describe('text round trips', () => {
  it('lamports survive TEXT storage exactly', () => {
    fc.assert(fc.property(u64, (v) => assert.equal(lamportsFromText(toText(lamports(v))), v)));
  });

  it('signed PnL survives TEXT storage exactly', () => {
    const signed = fc.bigInt({ min: -U64_MAX, max: U64_MAX });
    fc.assert(fc.property(signed, (v) => assert.equal(signedLamportsFromText(toText(signedLamports(v))), v)));
  });

  it('SOL display text parses back to the same lamports', () => {
    fc.assert(fc.property(u64, (v) => assert.equal(parseSolAmount(formatSol(lamports(v))), v)));
  });
});
