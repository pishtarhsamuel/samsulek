// Property-based tests for venue math (TEST_PLAN.md s.4): the pool never loses, the inverse is
// exact, the curve is constant product on virtual reserves capped by real tokens, a round trip
// never makes money, and slippage and impact are pessimistic. Ported from the root project.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { bps, lamports, tokenUnits } from '../../../src/core/units.ts';
import {
  cpAmountIn,
  cpAmountOut,
  curveBuy,
  curveSell,
  curveState,
  impactBpsCeil,
  minOut,
} from '../../../src/venues/math.ts';

const reserve = fc.bigInt({ min: 1n, max: 10n ** 18n });
const amount = fc.bigInt({ min: 0n, max: 10n ** 18n });
const fee = fc.integer({ min: 0, max: 9_999 });
const SOL = 1_000_000_000n;
const LAUNCH = curveState({
  virtualQuote: lamports(30_000_000_000n),
  virtualToken: tokenUnits(1_073_000_000_000_000n),
  realToken: tokenUnits(793_100_000_000_000n),
  complete: false,
});

describe('constant product properties', () => {
  it('the pool never loses (k never falls) and output is monotone in input', () => {
    fc.assert(
      fc.property(amount, reserve, reserve, fee, (a, rIn, rOut, f) => {
        const out = cpAmountOut(a, rIn, rOut, bps(f));
        assert.ok((rIn + a) * (rOut - out) >= rIn * rOut, 'k never falls');
        assert.ok(cpAmountOut(a + 1n, rIn, rOut, bps(f)) >= out, 'monotone');
      }),
    );
  });

  it('cpAmountIn is the smallest sufficient input', () => {
    fc.assert(
      fc.property(reserve, fc.bigInt({ min: 2n, max: 10n ** 18n }), fee, fc.double({ min: 0, max: 0.999, noNaN: true }), (rIn, rOut, f, share) => {
        const target = BigInt(Math.floor(Number(rOut - 1n) * share));
        const gross = cpAmountIn(target, rIn, rOut, bps(f));
        assert.ok(cpAmountOut(gross, rIn, rOut, bps(f)) >= target);
        if (gross > 0n) {
          assert.ok(cpAmountOut(gross - 1n, rIn, rOut, bps(f)) < target);
        }
      }),
    );
  });

  it('doubling the fee never lowers the price impact (the 2x-cost rerun is not optimistic)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 15n }), fc.bigInt({ min: 1n, max: 10n ** 18n }), fc.integer({ min: 0, max: 4_999 }), (a, r, f) => {
        const one = impactBpsCeil(a, r, r, bps(f));
        const two = impactBpsCeil(a, r, r, bps(2 * f));
        assert.ok(0n <= one && one <= two);
      }),
    );
  });

  it('minOut is the floor of the slippage cap', () => {
    fc.assert(
      fc.property(amount, fc.integer({ min: 0, max: 10_000 }), (expected, b) => {
        const floor = minOut(expected, bps(b));
        assert.ok(floor * 10_000n <= expected * BigInt(10_000 - b));
        assert.ok(expected * BigInt(10_000 - b) < (floor + 1n) * 10_000n);
      }),
    );
  });
});

describe('bonding curve properties', () => {
  it('is constant product on virtual reserves, capped by the real tokens', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        fc.bigInt({ min: 1n, max: 10n ** 16n }),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 500 }),
        (quoteIn, vq, vt, realShare, f) => {
          const state = curveState({
            virtualQuote: lamports(vq),
            virtualToken: tokenUnits(vt),
            realToken: tokenUnits((vt * BigInt(realShare)) / 100n),
            complete: false,
          });
          const expected = cpAmountOut(quoteIn, vq, vt, bps(f));
          const capped = expected < state.realToken ? expected : state.realToken;
          assert.equal(curveBuy(state, lamports(quoteIn), bps(f)), capped);
          const gross = cpAmountOut(quoteIn, vt, vq, bps(0));
          const sellFee = (gross * BigInt(f) + 9_999n) / 10_000n;
          assert.equal(curveSell(state, tokenUnits(quoteIn), bps(f)), gross - sellFee);
        },
      ),
    );
  });

  it('a round trip on the curve never makes money', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 50n * SOL }), fc.integer({ min: 0, max: 500 }), (quoteIn, f) => {
        const tokens = curveBuy(LAUNCH, lamports(quoteIn), bps(f));
        const paidNet = quoteIn - (quoteIn * BigInt(f) + 9_999n) / 10_000n;
        const after = curveState({
          virtualQuote: lamports(LAUNCH.virtualQuote + paidNet),
          virtualToken: tokenUnits(LAUNCH.virtualToken - tokens),
          realToken: tokenUnits(LAUNCH.realToken - tokens),
          complete: false,
        });
        assert.ok(curveSell(after, tokenUnits(tokens), bps(f)) <= quoteIn);
      }),
    );
  });
});
