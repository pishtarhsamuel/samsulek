// The money check and a buy on one database file (step 6e-2, STORAGE_DESIGN.md s.17.8): inside
// connection A's observation that trips a stop, connection B's T1 runs on the same file and gets busy
// after its timeout, unrecorded (A holds BEGIN IMMEDIATE); once A commits, B is refused by the stop A
// wrote: the daily stop in the day state, or the peak halt as a halt row. So no buy is ever approved on
// a day state an observation in progress is about to stop.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { approveBuyTx, type EntryOutcome } from '../../../src/app/approve-tx.ts';
import { observeDayTx } from '../../../src/app/day-tx.ts';
import { athensDay } from '../../../src/core/day.ts';
import { lamports } from '../../../src/core/units.ts';
import { emptyEquityState, type EquityState } from '../../../src/risk/daystate.ts';
import { fileDb, removeDir, tempDir } from '../storage/helpers.ts';
import { dayWorld, plantDayState } from './day-world.ts';
import { T, setUpDb } from './world.ts';
import { entryRequest, txWorld } from './tx-world.ts';

const show = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));
const state = (dayStart: bigint, peak: bigint): EquityState =>
  Object.freeze({ ...emptyEquityState(), day: athensDay(T), dayStart: lamports(dayStart), lastEquity: lamports(dayStart), peak: lamports(peak) });

describe('races: the money check and a buy on one file (6e-2)', () => {
  for (const [name, planted, reason] of [
    ['the daily stop (a fall of 35% today)', state(850_000_000n, 850_000_000n), 'daily-stop'],
    ['the peak halt (54% below the peak)', state(600_000_000n, 1_200_000_000n), 'halt'],
  ] as const) {
    it(`${name}: B inside A's observation is busy and unrecorded; after A commits, B is refused by it`, () => {
      const dir = tempDir();
      try {
        const file = path.join(dir, 'bot.sqlite');
        const b = txWorld(setUpDb(file)); // momentum on paper and a fresh money check at T
        plantDayState(b.db, planted);
        const a = dayWorld(fileDb(file, false)); // a second connection, 100 ms busy timeout
        let inner: EntryOutcome | null = null;
        const clock = {
          now: (): number => {
            if (inner === null) {
              inner = approveBuyTx(b.deps, entryRequest()); // A holds BEGIN IMMEDIATE now
            }
            return T;
          },
        };
        const o = observeDayTx({ ...a.deps, clock });
        assert.equal(o.kind, 'observed', show(o));
        assert.deepEqual(inner, { kind: 'error', code: 'error:storage-busy', scope: 'intent', recorded: false });
        const after = approveBuyTx(b.deps, entryRequest());
        assert.ok(after.kind === 'refused' && after.reasons.includes(reason), show(after));
        a.db.close();
        b.db.close();
      } finally {
        removeDir(dir);
      }
    });
  }
});
