// Exhaustive fault injection into the owner's commands (STORAGE_DESIGN.md s.17.8): for every statement k
// of the richest successful setTx, rollbackTx, cancelPendingTx and resumeTx, and each of full, io,
// constraint, bad-param and busy, nothing of the command stays: the database equals the database before
// (plus only the disk-db halt and its audit row for a full disk or an I/O error, which the fault sink
// writes), no anchor moves, and the latch and the alerts are as s.17.5.6 says. The config, the waiting
// rows, the modes and the halts stay exactly as they were.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { persistHaltTx } from '../../../src/app/approve-tx.ts';
import { cancelPendingTx, resumeTx, rollbackTx, setTx, type OwnerDeps } from '../../../src/app/owner-tx.ts';
import { athensDay } from '../../../src/core/day.ts';
import { lamports } from '../../../src/core/units.ts';
import { emptyEquityState } from '../../../src/risk/daystate.ts';
import { insertSnapshot } from '../../../src/storage/repo-day.ts';
import { setHalt } from '../../../src/storage/repo-flags.ts';
import { setStrategyMode } from '../../../src/storage/repo-owner.ts';
import type { Db } from '../../../src/storage/sqlite.ts';
import { dump } from '../storage/helpers.ts';
import { SOL, dayWorld, plantDayState, type DayWorld } from './day-world.ts';
import { FAULT_CODES, faulty } from './faulty-db.ts';
import { T } from './world.ts';

function goLive(db: Db, at = T): void {
  db.transaction((tx) => {
    setStrategyMode(tx, at, 'owner-telegram', 'momentum', 'paper');
    setStrategyMode(tx, at, 'owner-telegram', 'momentum', 'live');
  });
}

interface Case {
  /** A world just before the command, the same every time it is built. */
  readonly world: () => DayWorld;
  readonly run: (deps: OwnerDeps) => { readonly kind: string };
  /** What the successful command did, to show the world is the rich one. */
  readonly expect: Readonly<Record<string, unknown>>;
}

const CASES: Readonly<Record<string, Case>> = {
  // cancels a waiting row, writes a version, demotes the live strategy, restarts every gate
  setTx: {
    world: () => {
      const w = dayWorld();
      goLive(w.db);
      setTx(w.deps, 'owner-telegram', 'exits.hardStopBps', '4000'); // riskier while live: waits
      w.clock.set(T + 1);
      return w;
    },
    run: (deps) => setTx(deps, 'owner-telegram', 'exits.hardStopBps', '3000'),
    expect: { kind: 'done', versionId: 2, cancelled: ['exits.hardStopBps'], demoted: ['momentum'], restarted: ['crowdflow', 'momentum', 'launch'] },
  },
  // replaces a waiting row, writes the version back, demotes the live strategy, restarts its gate
  rollbackTx: {
    world: () => {
      const w = dayWorld();
      setTx(w.deps, 'owner-telegram', 'momentum.pullbackBps', '2000');
      goLive(w.db);
      setTx(w.deps, 'owner-telegram', 'risk.priceCrossCheckBps', '500'); // riskier while live: waits
      w.clock.set(T + 2);
      return w;
    },
    run: (deps) => rollbackTx(deps, 'owner-telegram'),
    expect: { kind: 'done', versionId: 3, cancelled: ['risk.priceCrossCheckBps'], demoted: ['momentum'], restarted: ['momentum'] },
  },
  cancelPendingTx: {
    world: () => {
      const w = dayWorld();
      goLive(w.db);
      setTx(w.deps, 'owner-telegram', 'risk.entriesPerDay', '12');
      w.clock.set(T + 3);
      return w;
    },
    run: (deps) => cancelPendingTx(deps, 'owner-telegram', 'risk.entriesPerDay'),
    expect: { kind: 'done', versionId: null, cancelled: ['risk.entriesPerDay'] },
  },
  // lifts the halt, restarts the peak, records the clear time
  resumeTx: {
    world: () => {
      const w = dayWorld(undefined, T + 10);
      plantDayState(w.db, { ...emptyEquityState(), day: athensDay(T), dayStart: lamports(SOL), lastEquity: lamports(550_000_000n), peak: lamports(1_200_000_000n) });
      w.db.transaction((tx) => {
        setHalt(tx, 'peak-halt:paper', T);
        insertSnapshot(tx, 'paper', T + 5, lamports(550_000_000n), lamports(550_000_000n));
      });
      return w;
    },
    run: (deps) => resumeTx(deps, 'owner-telegram', 'peak'),
    expect: { kind: 'resumed', which: 'peak' },
  },
};

const pick = (o: object, keys: readonly string[]): Record<string, unknown> => Object.fromEntries(keys.map((k) => [k, (o as Record<string, unknown>)[k]]));

describe('exhaustive fault injection into the owner\'s commands (s.17.8)', () => {
  for (const [name, c] of Object.entries(CASES)) {
    it(`${name}: the richest command, then every statement failed in every class: the database as before, the latch and the alerts as s.17.5.6 says`, () => {
      const probe = c.world();
      const counting = faulty(probe.db, 0, 'busy');
      const ok = c.run({ ...probe.deps, db: counting.db });
      assert.deepEqual(pick(ok, Object.keys(c.expect)), c.expect);
      const total = counting.statements();
      assert.ok(total >= 4, `the command ran ${total} statements`);
      probe.db.close();
      const twin = c.world();
      persistHaltTx(twin.deps, 'disk-db');
      const disk = dump(twin.db);
      twin.db.close();
      for (let k = 1; k <= total; k += 1) {
        for (const code of FAULT_CODES) {
          const w = c.world();
          try {
            w.alerts.seen.length = 0;
            w.anchors.written.length = 0;
            const before = dump(w.db);
            const o = c.run({ ...w.deps, db: faulty(w.db, k, code).db });
            const isDisk = code === 'full' || code === 'io';
            assert.deepEqual(o, { kind: 'error', code: `error:storage-${code}`, scope: isDisk ? 'latch' : 'intent' });
            assert.equal(dump(w.db), isDisk ? disk : before, 'nothing of the command stays');
            assert.deepEqual([...w.latch.blocked()], isDisk ? ['storage'] : []);
            assert.deepEqual(w.alerts.seen, code === 'busy' ? [] : [{ code: `error:storage-${code}`, severity: isDisk ? 'warn' : 'bug', codes: ['owner'] }]);
            assert.equal(w.anchors.written.length, isDisk ? 1 : 0, 'only the disk-db halt moves the anchor');
          } catch (e) {
            throw new Error(`k = ${k}, code ${code}: ${e instanceof Error ? e.message : String(e)}`);
          } finally {
            w.db.close();
          }
        }
      }
    });
  }
});
