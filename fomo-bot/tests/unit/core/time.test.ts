// Millisecond values (UTC timestamps and durations): whole, non-negative, safe integers only, so a
// NaN, a fraction or a string can never reach a staleness or day-boundary comparison.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isMillis } from '../../../src/core/time.ts';

describe('isMillis', () => {
  it('accepts whole non-negative safe integers', () => {
    for (const ok of [0, 1, 30_000, 1_762_000_000_000, Number.MAX_SAFE_INTEGER]) {
      assert.equal(isMillis(ok), true, String(ok));
    }
  });

  it('rejects negatives, fractions, NaN, infinities, unsafe integers, bigints and strings', () => {
    for (const bad of [-1, 0.5, Number.NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, 1n, '1', null, undefined]) {
      assert.equal(isMillis(bad), false, String(bad));
    }
  });
});
