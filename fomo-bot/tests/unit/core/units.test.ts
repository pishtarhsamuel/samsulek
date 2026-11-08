// Tests for core/units: bigint money units, checked math, rounding direction, TEXT round trip.
// TEST_PLAN.md s.3 step 1. Written before the implementation (tests first).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AmountError,
  LAMPORTS_PER_SOL,
  U64_MAX,
  addLamports,
  bps,
  bpsOfCeil,
  bpsOfFloor,
  ceilDiv,
  floorDiv,
  formatSol,
  lamports,
  lamportsFromText,
  microLamportsPerCu,
  mulDivCeil,
  mulDivFloor,
  parseSolAmount,
  signedLamports,
  signedLamportsFromText,
  subLamports,
  sumLamports,
  toText,
  tokenUnits,
  tokenUnitsFromText,
} from '../../../src/core/units.ts';

const I64_MAX = (1n << 63n) - 1n;

describe('constructors validate (fail closed)', () => {
  it('accept 0 and U64_MAX for unsigned units', () => {
    assert.equal(lamports(0n), 0n);
    assert.equal(lamports(U64_MAX), U64_MAX);
    assert.equal(tokenUnits(U64_MAX), U64_MAX);
    assert.equal(microLamportsPerCu(400_000n), 400_000n);
  });

  it('reject negatives, values above u64 and non-bigints', () => {
    for (const bad of [-1n, U64_MAX + 1n]) {
      assert.throws(() => lamports(bad), AmountError);
      assert.throws(() => tokenUnits(bad), AmountError);
      assert.throws(() => microLamportsPerCu(bad), AmountError);
    }
    for (const bad of [1, 1.5, '1', null, undefined, Number.NaN]) {
      assert.throws(() => lamports(bad as unknown as bigint), AmountError);
    }
  });

  it('signed lamports allow negative PnL within +-U64_MAX', () => {
    assert.equal(signedLamports(-5n), -5n);
    assert.equal(signedLamports(-U64_MAX), -U64_MAX);
    assert.throws(() => signedLamports(-U64_MAX - 1n), AmountError);
    assert.throws(() => signedLamports(U64_MAX + 1n), AmountError);
  });

  it('bps accepts integers 0..10000 only', () => {
    assert.equal(bps(0), 0);
    assert.equal(bps(10_000), 10_000);
    for (const bad of [-1, 10_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => bps(bad), AmountError);
    }
  });
});

describe('checked arithmetic', () => {
  it('addition stays within u64', () => {
    assert.equal(addLamports(lamports(1n), lamports(2n)), 3n);
    assert.throws(() => addLamports(lamports(U64_MAX), lamports(1n)), AmountError);
  });

  it('subtraction never goes below zero', () => {
    assert.equal(subLamports(lamports(5n), lamports(5n)), 0n);
    assert.throws(() => subLamports(lamports(4n), lamports(5n)), AmountError);
  });

  it('sums a list and fails on overflow', () => {
    assert.equal(sumLamports([]), 0n);
    assert.equal(sumLamports([lamports(1n), lamports(2n), lamports(3n)]), 6n);
    assert.throws(() => sumLamports([lamports(U64_MAX), lamports(1n)]), AmountError);
  });

  it('floorDiv rounds down and ceilDiv rounds up', () => {
    assert.equal(floorDiv(7n, 2n), 3n);
    assert.equal(ceilDiv(7n, 2n), 4n);
    assert.equal(ceilDiv(8n, 2n), 4n);
    assert.equal(ceilDiv(0n, 3n), 0n);
  });

  it('division by zero or by a negative divisor throws', () => {
    assert.throws(() => floorDiv(1n, 0n), AmountError);
    assert.throws(() => ceilDiv(1n, 0n), AmountError);
    assert.throws(() => mulDivFloor(1n, 1n, -1n), AmountError);
  });

  it('negative operands are refused (unsigned math)', () => {
    assert.throws(() => floorDiv(-1n, 2n), AmountError);
    assert.throws(() => mulDivCeil(-1n, 2n, 3n), AmountError);
  });

  it('mulDiv keeps full precision before dividing', () => {
    // U64_MAX * 3 overflows u64, but the exact quotient is in range.
    assert.equal(mulDivFloor(U64_MAX, 3n, 4n), (U64_MAX * 3n) / 4n);
    assert.equal(mulDivCeil(10n, 1n, 3n), 4n);
    assert.equal(mulDivFloor(10n, 1n, 3n), 3n);
  });
});

describe('rounding direction: caps round down, costs round up', () => {
  it('a cap is the floor of the percentage', () => {
    assert.equal(bpsOfFloor(999n, bps(1_000)), 99n); // 99.9 -> 99
  });

  it('a cost is the ceiling of the percentage', () => {
    assert.equal(bpsOfCeil(999n, bps(1_000)), 100n); // 99.9 -> 100
    assert.equal(bpsOfCeil(1_000n, bps(1_000)), 100n); // exact stays exact
  });

  it('priority fee is the ceiling of CU price x CU limit / 10^6 (RISK_POLICY s.3a)', () => {
    assert.equal(mulDivCeil(400_000n, 300_000n, 1_000_000n), 120_000n);
    assert.equal(mulDivCeil(1n, 1n, 1_000_000n), 1n);
  });
});

describe('TEXT round trip for SQLite', () => {
  it('round-trips the boundaries exactly', () => {
    for (const v of [0n, 1n, I64_MAX, I64_MAX + 1n, U64_MAX]) {
      assert.equal(lamportsFromText(toText(lamports(v))), v);
      assert.equal(tokenUnitsFromText(toText(tokenUnits(v))), v);
    }
  });

  it('rejects non-canonical or unsafe text', () => {
    const bad = ['', ' 1', '1 ', '+1', '01', '1e3', '1.0', '0x10', '-1', '１', '1_000', '9'.repeat(25)];
    for (const s of bad) {
      assert.throws(() => lamportsFromText(s), AmountError, `should reject ${JSON.stringify(s)}`);
    }
    assert.throws(() => lamportsFromText((U64_MAX + 1n).toString()), AmountError);
  });

  it('signed text keeps negatives and rejects -0 and +1', () => {
    assert.equal(signedLamportsFromText('-42'), -42n);
    assert.equal(signedLamportsFromText('0'), 0n);
    for (const s of ['-0', '+1', '--1', '-01', '']) {
      assert.throws(() => signedLamportsFromText(s), AmountError, `should reject ${JSON.stringify(s)}`);
    }
  });
});

describe('SOL text for display and owner input', () => {
  it('formats lamports as SOL without floating point', () => {
    assert.equal(formatSol(lamports(0n)), '0');
    assert.equal(formatSol(lamports(1_500_000_000n)), '1.5');
    assert.equal(formatSol(lamports(30_000_000n)), '0.03');
    assert.equal(formatSol(lamports(1n)), '0.000000001');
    assert.equal(formatSol(lamports(LAMPORTS_PER_SOL)), '1');
  });

  it('parses decimal SOL strings exactly (at most 9 decimals)', () => {
    assert.equal(parseSolAmount('0.03'), 30_000_000n);
    assert.equal(parseSolAmount('1'), LAMPORTS_PER_SOL);
    assert.equal(parseSolAmount('0.000000001'), 1n);
    assert.equal(parseSolAmount('12.5'), 12_500_000_000n);
  });

  it('rejects floats with too many decimals, exponents, signs and junk', () => {
    for (const s of ['', '.5', '5.', '0.0000000001', '1e-3', '-1', '+1', ' 1', '1,5', '0x1', '01', 'NaN']) {
      assert.throws(() => parseSolAmount(s), AmountError, `should reject ${JSON.stringify(s)}`);
    }
  });
});
