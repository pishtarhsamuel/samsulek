// Exhaustive fault injection into the equity observation (STORAGE_DESIGN.md s.17.8): for every statement
// k of the richest successful observation (two halts, the low-equity stop turned on, a snapshot and the
// prune) and each of full, io, constraint, bad-param and busy, nothing of the observation stays; the only
// new rows are the day-state-error halt and its audit row (nothing for busy), plus the disk-db halt and
// its row for a full disk or an I/O error; the latch is as s.17.5.6 says.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DAY_STATE_ERROR_HALT, observeDayTx } from '../../../src/app/day-tx.ts';
import { athensDay } from '../../../src/core/day.ts';
import { lamports } from '../../../src/core/units.ts';
import { emptyEquityState, type EquityState } from '../../../src/risk/daystate.ts';
import { readDayState } from '../../../src/storage/repo-day.ts';
import { readFlags, readHalts } from '../../../src/storage/repo-flags.ts';
import { count } from '../storage/helpers.ts';
import { DAY, dayWorld, holding, plantDayState, setPaperSol, type DayWorld } from './day-world.ts';
import { FAULT_CODES, faulty } from './faulty-db.ts';
import { T } from './world.ts';

/** Yesterday was a stop day; today's baseline and peak are 1.2 SOL; now 0.15 SOL: two halts and the stop. */
const PLANTED: EquityState = Object.freeze({
  ...emptyEquityState(),
  day: athensDay(T),
  dayStart: lamports(1_200_000_000n),
  lastEquity: lamports(1_200_000_000n),
  peak: lamports(1_200_000_000n),
  dailyStopDay: athensDay(T - DAY),
  dailyStopStreak: 1,
});

function richWorld(): DayWorld {
  const w = dayWorld();
  plantDayState(w.db, PLANTED);
  holding(w, 'p1', 0n);
  setPaperSol(w, 150_000_000n);
  return w;
}

describe('exhaustive fault injection into observeDayTx (s.17.8)', () => {
  it('the richest observation, then every statement failed in every class: only the halts of the failure stay', () => {
    const probe = richWorld();
    const counting = faulty(probe.db, 0, 'busy');
    const ok = observeDayTx({ ...probe.deps, db: counting.db });
    assert.equal(ok.kind, 'observed');
    assert.deepEqual(ok.kind === 'observed' ? [[...ok.haltsSet], ok.entriesStopped, ok.stopChanged] : null, [['daily-stop-twice:paper', 'peak-halt:paper'], true, true]);
    const total = counting.statements();
    assert.ok(total >= 15, `the observation ran ${total} statements`);
    probe.db.close();
    for (let k = 1; k <= total; k += 1) {
      for (const code of FAULT_CODES) {
        const w = richWorld();
        try {
          const audits = count(w.db, 'audit_log');
          const o = observeDayTx({ ...w.deps, db: faulty(w.db, k, code).db });
          const busy = code === 'busy';
          const disk = code === 'full' || code === 'io';
          assert.deepEqual(o, { kind: 'error', code: `error:storage-${code}`, scope: disk ? 'latch' : 'intent', halt: busy ? 'not-tried' : 'set' });
          assert.deepEqual(readDayState(w.db, 'paper'), PLANTED, 'the day state as it was');
          assert.equal(count(w.db, 'equity_snapshots'), 0n, 'no snapshot');
          assert.equal(readFlags(w.db).entriesStopped, false, 'the stop as it was');
          const halts = readHalts(w.db).map((h) => h.reason).sort();
          assert.deepEqual(halts, busy ? [] : disk ? [DAY_STATE_ERROR_HALT, 'disk-db'] : [DAY_STATE_ERROR_HALT]);
          assert.equal(count(w.db, 'audit_log'), audits + BigInt(halts.length), 'one audit row per halt, no other');
          assert.deepEqual([...w.latch.blocked()], disk ? ['storage'] : []);
        } catch (e) {
          throw new Error(`k = ${k}, code ${code}: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          w.db.close();
        }
      }
    }
  });
});
