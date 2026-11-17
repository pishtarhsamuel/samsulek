// The checks every repository shares (STORAGE_DESIGN.md s.1.4): the rows a write changed, a required
// row, and a value from a fixed list on the way in and on the way out.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_AUDIT_ID, cellOneOf, expectChanges, oneOf, required } from '../../../src/storage/repo-util.ts';
import { storageError } from './helpers.ts';

describe('repository checks', () => {
  it('expectChanges passes the exact count only, and names the write, never a value', () => {
    expectChanges(1, 1, 'the write');
    expectChanges(0, 0, 'the write');
    for (const [changes, want] of [[0, 1], [2, 1], [1, 0], [3, 2]] as const) {
      const e = storageError(() => expectChanges(changes, want, 'setting KILL'), 'row-count');
      assert.equal(e.detail, `setting KILL: ${changes} rows changed, ${want} expected`);
    }
  });

  it('required returns the row and throws row-missing for none (a default is never made up)', () => {
    const row = Object.freeze({ a: 1n });
    assert.equal(required(row, 'the flags row'), row);
    assert.equal(storageError(() => required(undefined, 'the flags row'), 'row-missing').detail, 'the flags row is missing');
  });

  it('oneOf takes a listed value only (bad-param); cellOneOf a stored one only (bad-cell)', () => {
    const LIST = ['cli', 'telegram'] as const;
    assert.equal(oneOf('cli', LIST, 'a source'), 'cli');
    for (const value of ['CLI', '', 'email', 1, null, undefined, ['cli']]) {
      storageError(() => oneOf(value, LIST, 'a source'), 'bad-param');
    }
    assert.equal(cellOneOf(Object.freeze({ s: 'telegram' }), 's', LIST), 'telegram');
    for (const cell of ['email', 5n, null]) {
      storageError(() => cellOneOf(Object.freeze({ s: cell }), 's', LIST), 'bad-cell');
    }
    storageError(() => cellOneOf(Object.freeze({}), 's', LIST), 'bad-cell');
    assert.equal(MAX_AUDIT_ID, Number.MAX_SAFE_INTEGER);
  });
});
