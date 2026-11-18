// The tunables in their stored form (STORAGE_DESIGN.md s.14): the plain JSON trees storage checks
// without the config module. Written with src/storage/config-tree.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TUNABLES, encodeTunables } from '../../../src/config/tunables.ts';
import { changedPathsOf, holds, isConfigPath, pathsOf, treeOf, valueAt, withAmount } from '../../../src/storage/config-tree.ts';
import { storageError } from './helpers.ts';

const TREE = treeOf(DEFAULT_TUNABLES, 'bad-param');

describe('the stored tunables as trees', () => {
  it('a tree is exactly the stored form: groups of named whole numbers or decimal text, in the stored order', () => {
    assert.equal(JSON.stringify(TREE), encodeTunables(DEFAULT_TUNABLES));
    assert.equal(valueAt(TREE, 'momentum.minLiquidityLamports'), '50000000000'); // lamports as decimal text
    assert.equal(valueAt(TREE, 'risk.dailyStopBps'), 3_000);
    assert.equal(pathsOf(TREE)[0], 'risk.tradePctBps');
    assert.equal(pathsOf(TREE).length, 36);
  });

  it('refuses anything else, as the caller\'s fault or the stored row\'s', () => {
    const bad: readonly unknown[] = [
      null, 1, 'x', [], [{ risk: { a: 1 } }],
      { risk: 1 },
      { risk: [] },
      { risk: {} }, // an empty group
      { risk: { a: -1 } },
      { risk: { a: 1.5 } },
      { risk: { a: '01' } },
      { risk: { a: '1e3' } },
      { risk: { a: true } },
      { Risk: { a: 1 } }, // not a tunable name
      { risk: { 'a.b': 1 } },
    ];
    for (const value of bad) {
      storageError(() => treeOf(value, 'bad-param'), 'bad-param');
    }
    storageError(() => treeOf({ risk: { a: 1 }, x: undefined }, 'bad-cell'), 'bad-cell'); // not plain data
    assert.deepEqual(treeOf({ risk: { a: 1n << 70n } }, 'bad-param'), { risk: { a: (1n << 70n).toString() } });
  });

  it('names: group.name of letters and digits, 3 to 64 characters', () => {
    for (const ok of ['risk.a', 'a.B', 'crowdflow.minDistinctBuyers5m']) {
      assert.equal(isConfigPath(ok), true, ok);
    }
    for (const bad of ['', 'risk', 'risk.', '.a', 'Risk.a', 'risk.a.b', 'risk.1a', 'risk.a-b', 'r.', `risk.${'a'.repeat(60)}`, 1]) {
      assert.equal(isConfigPath(bad), false, String(bad));
    }
  });

  it('reads, compares and moves one value in its own kind; a missing tunable is no value', () => {
    assert.equal(valueAt(TREE, 'risk.noSuch'), undefined);
    assert.equal(valueAt(TREE, 'nosuch.dailyStopBps'), undefined);
    assert.equal(holds(TREE, 'risk.dailyStopBps', 3_000n), true);
    assert.equal(holds(TREE, 'momentum.minLiquidityLamports', 50_000_000_000n), true);
    assert.equal(holds(TREE, 'risk.dailyStopBps', 2_999n), false);
    assert.equal(holds(TREE, 'risk.noSuch', 0n), false);
    const moved = withAmount(TREE, 'risk.dailyStopBps', 2_000n);
    assert.equal(moved === null ? null : valueAt(moved, 'risk.dailyStopBps'), 2_000); // a number stays a number
    const lamports = withAmount(TREE, 'momentum.minLiquidityLamports', 7n);
    assert.equal(lamports === null ? null : valueAt(lamports, 'momentum.minLiquidityLamports'), '7'); // text stays text
    assert.equal(withAmount(TREE, 'risk.noSuch', 1n), null);
    assert.equal(withAmount(TREE, 'risk.dailyStopBps', 1n << 60n), null); // a number tunable cannot hold it exactly
    assert.equal(valueAt(TREE, 'risk.dailyStopBps'), 3_000); // the tree itself is untouched
  });

  it('lists what changed between two trees in the stored order; trees that hold other tunables, or in another order, are not comparable', () => {
    const moved = withAmount(TREE, 'risk.dailyStopBps', 2_000n);
    assert.ok(moved !== null);
    assert.deepEqual(changedPathsOf(TREE, TREE), []);
    assert.deepEqual(changedPathsOf(TREE, moved), ['risk.dailyStopBps']);
    // the same text in another kind is a change (a number tunable stored as text is not the same value)
    const retyped = { ...TREE, risk: { ...TREE['risk'], dailyStopBps: '3000' } };
    assert.deepEqual(changedPathsOf(TREE, retyped), ['risk.dailyStopBps']);
    const fewer = { ...TREE, paper: { pFailBps: 2_000 } };
    assert.equal(changedPathsOf(TREE, fewer), null);
    const { risk, ...rest } = TREE;
    assert.ok(risk !== undefined);
    assert.equal(changedPathsOf(TREE, { ...rest, risk }), null); // another order
  });
});
