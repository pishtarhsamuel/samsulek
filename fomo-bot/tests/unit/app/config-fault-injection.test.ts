// Exhaustive fault injection into the engine's config step (STORAGE_DESIGN.md s.17.8): for every
// statement k of the richest successful applyDueTx (two chained versions, one dropped row, one
// demotion, every gate restarted, a waiting row kept) and each of full, io, constraint, bad-param and
// busy, nothing of the step stays: the database equals the database before (plus only the disk-db
// halt and its audit row for a full disk or an I/O error, which the fault sink writes), no anchor
// moves, and the latch and the alerts are as s.17.5.6 says. Nothing is recorded for the step itself:
// it has no intent.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { persistHaltTx } from '../../../src/app/approve-tx.ts';
import { applyDueTx } from '../../../src/app/config-tx.ts';
import { DEFAULT_TUNABLES, boundsOf, valueAt, type TunablePath, type TunableValue } from '../../../src/config/tunables.ts';
import { STRATEGY_IDS } from '../../../src/core/ids.ts';
import type { PendingChange } from '../../../src/config/changes.ts';
import { setStrategyMode, writeOwnerConfig } from '../../../src/storage/repo-owner.ts';
import type { Db } from '../../../src/storage/sqlite.ts';
import { dump } from '../storage/helpers.ts';
import { DAY, dayWorld, type DayWorld } from './day-world.ts';
import { FAULT_CODES, faulty } from './faulty-db.ts';
import { T } from './world.ts';

function other(p: TunablePath): TunableValue {
  const [lo, hi] = boundsOf(p);
  return valueAt(DEFAULT_TUNABLES, p) === lo ? hi : lo;
}

const row = (p: TunablePath, at: number, over: Partial<PendingChange> = {}): PendingChange =>
  Object.freeze({ path: p, from: valueAt(DEFAULT_TUNABLES, p), to: other(p), source: 'owner' as const, requestedAt: at, applyAt: at + DAY, ...over });

function queue(db: Db, at: number, ...rows: PendingChange[]): void {
  db.transaction((tx) => writeOwnerConfig(tx, at, 'owner-telegram', 'owner:set', { version: null, pending: rows, cancelled: [] }));
}

/** Momentum live; two rows due (a risk and an exit value), one stale due row, one row not yet due; the clock at their time. */
function richWorld(): DayWorld {
  const w = dayWorld();
  w.db.transaction((tx) => {
    setStrategyMode(tx, T, 'owner-telegram', 'momentum', 'paper');
    setStrategyMode(tx, T, 'owner-telegram', 'momentum', 'live');
  });
  queue(w.db, T, row('risk.dailyStopBps', T), row('exits.trailBps', T));
  queue(w.db, T + 1, row('risk.peakHaltBps', T + 1));
  const stale = row('exits.timeStopMin', T, { from: 9 });
  w.db.transaction((tx) =>
    tx.run(
      'INSERT INTO pending_changes (path, from_value, to_value, source, requested_at, apply_at) VALUES (?, ?, ?, ?, ?, ?)',
      stale.path,
      String(stale.from),
      String(stale.to),
      stale.source,
      BigInt(stale.requestedAt),
      BigInt(stale.applyAt),
    ),
  );
  w.clock.set(T + DAY);
  return w;
}

/** The database a full disk or an I/O error leaves: as before, plus the disk-db halt the fault sink writes. */
function afterDiskFault(): string {
  const twin = richWorld();
  try {
    persistHaltTx(twin.deps, 'disk-db');
    return dump(twin.db);
  } finally {
    twin.db.close();
  }
}

describe('exhaustive fault injection into applyDueTx (s.17.8)', () => {
  it('the richest step, then every statement failed in every class: the database as before, the latch and the alerts as s.17.5.6 says', () => {
    const probe = richWorld();
    const counting = faulty(probe.db, 0, 'busy');
    const ok = applyDueTx({ ...probe.deps, db: counting.db });
    assert.deepEqual(ok, {
      kind: 'applied',
      versionIds: [2, 3],
      applied: ['risk.dailyStopBps', 'exits.trailBps'],
      dropped: ['exits.timeStopMin'],
      demoted: ['momentum'],
      restarted: [...STRATEGY_IDS],
    });
    const total = counting.statements();
    assert.ok(total >= 20, `the step ran ${total} statements`);
    probe.db.close();
    const disk = afterDiskFault();
    for (let k = 1; k <= total; k += 1) {
      for (const code of FAULT_CODES) {
        const w = richWorld();
        try {
          const before = dump(w.db);
          const o = applyDueTx({ ...w.deps, db: faulty(w.db, k, code).db });
          const isDisk = code === 'full' || code === 'io';
          assert.deepEqual(o, { kind: 'error', code: `error:storage-${code}`, scope: isDisk ? 'latch' : 'intent' });
          assert.equal(dump(w.db), isDisk ? disk : before, 'nothing of the step stays');
          assert.deepEqual([...w.latch.blocked()], isDisk ? ['storage'] : []);
          const alerts = code === 'busy' ? [] : [{ code: `error:storage-${code}`, severity: isDisk ? 'warn' : 'bug', codes: ['config-due'] }];
          assert.deepEqual(w.alerts.seen, alerts);
          assert.equal(w.anchors.written.length, isDisk ? 1 : 0, 'only the disk-db halt moves the anchor');
        } catch (e) {
          throw new Error(`k = ${k}, code ${code}: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          w.db.close();
        }
      }
    }
  });
});
