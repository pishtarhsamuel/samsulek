// The snapshot readers of step 6e (STORAGE_DESIGN.md s.17.3, C42) against a brute-force oracle on
// random rows: snapshotNear is the known equity nearest the target among the rows of its mode at or
// before now (the older one on a tie), with the row's own time; newestSnapshot is the newest row of its
// mode at or before now, unknown equity included. Times are drawn from a small range so that ties, rows
// after now, a target after now and unknown rows are all common.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { lamports } from '../../../src/core/units.ts';
import { insertSnapshot, newestSnapshot, snapshotNear } from '../../../src/storage/repo-day.ts';
import { TEST_NOW, migratedDb } from '../../unit/storage/helpers.ts';

interface Snap {
  readonly mode: 'paper' | 'live';
  readonly at: number;
  readonly equity: bigint | null;
}

const T = TEST_NOW;
const SPAN = 40;
const snap = fc.record({
  mode: fc.constantFrom('paper' as const, 'live' as const),
  at: fc.integer({ min: 0, max: SPAN }).map((d) => T + d * 1_000),
  equity: fc.option(fc.bigInt({ min: 0n, max: 10n ** 12n }), { nil: null }),
});
const time = fc.integer({ min: -5, max: SPAN + 5 }).map((d) => T + d * 1_000);

/** The first row stays when two share a mode and a millisecond (insertSnapshot's rule). */
function stored(rows: readonly Snap[]): Snap[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.mode}:${r.at}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

describe('the snapshot readers against a brute-force oracle (C42)', () => {
  it('snapshotNear and newestSnapshot agree with the oracle on 1,000 random row sets', () => {
    fc.assert(
      fc.property(fc.array(snap, { maxLength: 25 }), fc.constantFrom('paper' as const, 'live' as const), time, time, (rows, mode, target, now) => {
        const db = migratedDb();
        try {
          db.transaction((tx) => {
            for (const r of rows) {
              insertSnapshot(tx, r.mode, r.at, r.equity === null ? null : lamports(r.equity), null);
            }
          });
          const mine = stored(rows).filter((r) => r.mode === mode && r.at <= now);
          const known = mine.filter((r) => r.equity !== null).sort((a, b) => Math.abs(a.at - target) - Math.abs(b.at - target) || a.at - b.at);
          const near = known[0];
          assert.deepEqual(snapshotNear(db, mode, target, now), near === undefined ? null : { equity: near.equity, at: near.at });
          const newest = [...mine].sort((a, b) => b.at - a.at)[0];
          assert.deepEqual(newestSnapshot(db, mode, now), newest === undefined ? null : { at: newest.at, equity: newest.equity, stopEquity: null });
        } finally {
          db.close();
        }
      }),
      { numRuns: 1_000 },
    );
  });
});
