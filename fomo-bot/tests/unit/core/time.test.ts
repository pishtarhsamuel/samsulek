// Millisecond values (UTC timestamps and durations): whole, non-negative, safe integers only, so a
// NaN, a fraction or a string can never reach a staleness or day-boundary comparison.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TIMESTAMP_MS, isMillis, isTimestamp } from '../../../src/core/time.ts';

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

describe('isTimestamp: an instant the bot can act on', () => {
  it('whole milliseconds from 1970 up to 2200-01-01', () => {
    assert.equal(MAX_TIMESTAMP_MS, Date.UTC(2200, 0, 1));
    for (const ok of [0, 1_762_000_000_000, MAX_TIMESTAMP_MS]) {
      assert.equal(isTimestamp(ok), true, String(ok));
    }
  });

  it('refuses a far-future clock (one lamport of time past the limit is a clock problem) and everything isMillis refuses', () => {
    for (const bad of [MAX_TIMESTAMP_MS + 1, Number.MAX_SAFE_INTEGER, 8_640_000_000_000_001, -1, 0.5, Number.NaN, '1', null]) {
      assert.equal(isTimestamp(bad), false, String(bad));
    }
  });
});
