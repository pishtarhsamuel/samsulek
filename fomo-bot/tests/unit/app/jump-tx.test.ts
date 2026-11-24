// The jump confirmation of step 6e-2 (STORAGE_DESIGN.md s.17.5.2; C41): the verification routine's
// fresh, fully valued read clears a held +50% jump in one locked step: the lower of the verified and
// the held level becomes the reference, at most 5 minutes after the hold and never before it. It reads
// no flag, halt or KILL, so it works while halted. A refusal writes nothing and sets no halt (the hold
// keeps blocking entries); any other failure but busy is the day-state-error halt. Only cli/ may import
// the file (contract 3). Written before src/app/jump-tx.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DAY_STATE_ERROR_HALT, observeDayTx } from '../../../src/app/day-tx.ts';
import { confirmJumpTx } from '../../../src/app/jump-tx.ts';
import { lamports, type Lamports } from '../../../src/core/units.ts';
import { readDayState } from '../../../src/storage/repo-day.ts';
import { readHalts, setHalt, setKill, setPaused } from '../../../src/storage/repo-flags.ts';
import { StorageError, type Db } from '../../../src/storage/sqlite.ts';
import { dump } from '../storage/helpers.ts';
import { HOUR, PAPER, dayWorld, holding, type DayWorld } from './day-world.ts';
import { T } from './world.ts';

const HELD_AT = T + HOUR;
const HELD = 900_000_000n;

/** 0.55 SOL at T, then 0.9 SOL an hour later: +63%, held at T + 1 h. */
function heldWorld(): DayWorld {
  const w = dayWorld();
  observeDayTx(w.deps);
  w.clock.set(HELD_AT);
  holding(w, 'p1', 350_000_000n);
  const o = observeDayTx(w.deps);
  assert.ok(o.kind === 'observed' && o.trips.includes('equity-jump'));
  return w;
}
const haltReasons = (db: Db): string[] => readHalts(db).map((h) => h.reason);

describe('confirmJumpTx (s.17.5.2)', () => {
  it('confirms at the hold and 5 minutes after it: the lower of the verified and the held level is the reference', () => {
    for (const [after, verified, ack] of [
      [0, 850_000_000n, 850_000_000n],
      [300_000, 850_000_000n, 850_000_000n],
      [1, 1_000_000_000n, HELD], // never more than the hold saw
    ] as const) {
      const w = heldWorld();
      w.clock.set(HELD_AT + after);
      assert.deepEqual(confirmJumpTx(w.deps, lamports(verified)), { kind: 'confirmed', at: HELD_AT + after, ackEquity: ack });
      const s = readDayState(w.db, 'paper');
      assert.deepEqual([s.jumpPending, s.jumpHeld, s.jumpAck], [false, null, { equity: ack, at: HELD_AT + after }]);
      assert.ok(w.alerts.seen.some((a) => a.code === 'equity-jump-confirmed' && a.severity === 'info'));
    }
  });

  it('refuses 5 minutes and 1 ms after the hold, before it, and with no held jump: nothing written, no halt, the hold stays', () => {
    for (const [at, held] of [
      [HELD_AT + 300_001, true],
      [HELD_AT - 1, true],
      [T, false],
    ] as const) {
      const w = held ? heldWorld() : dayWorld();
      if (!held) {
        observeDayTx(w.deps);
      }
      w.clock.set(at);
      const before = dump(w.db);
      assert.deepEqual(confirmJumpTx(w.deps, lamports(850_000_000n)), { kind: 'refused', code: 'error:risk' });
      assert.equal(dump(w.db), before);
      assert.deepEqual(haltReasons(w.db), []);
      assert.ok(w.alerts.seen.some((a) => a.code === 'jump-confirm-refused' && a.severity === 'warn'));
      assert.deepEqual([...w.latch.blocked()], []);
    }
  });

  it('refuses a verified level above the sanity limits (three times the bankroll)', () => {
    const w = heldWorld();
    assert.deepEqual(confirmJumpTx(w.deps, lamports(3n * PAPER + 1n)), { kind: 'refused', code: 'error:risk' });
    assert.equal(readDayState(w.db, 'paper').jumpPending, true);
  });

  it('works while KILL, a halt and the pause are set: it reads none of them (C41)', () => {
    const w = heldWorld();
    w.db.transaction((tx) => {
      setKill(tx, HELD_AT, 'cli');
      setHalt(tx, 'peak-halt:paper', HELD_AT);
      setPaused(tx, HELD_AT);
    });
    assert.equal(confirmJumpTx(w.deps, lamports(850_000_000n)).kind, 'confirmed');
  });

  it('after a confirmation the next observation moves the baseline and the peak again', () => {
    const w = heldWorld();
    confirmJumpTx(w.deps, lamports(HELD));
    w.clock.advance(5_000);
    const o = observeDayTx(w.deps);
    assert.ok(o.kind === 'observed' && !o.trips.includes('equity-jump'), JSON.stringify(o));
    assert.equal(readDayState(w.db, 'paper').peak, HELD);
  });

  it('reads the clock once: the confirmation, its write and its reference all at that reading', () => {
    const w = heldWorld();
    let reads = 0;
    const clock = { now: (): number => (reads++ === 0 ? HELD_AT + 1_000 : HELD_AT + 1_999) };
    assert.deepEqual(confirmJumpTx({ ...w.deps, clock }, lamports(HELD)), { kind: 'confirmed', at: HELD_AT + 1_000, ackEquity: HELD });
    assert.equal(reads, 1);
    assert.equal(w.db.get("SELECT updated_at FROM day_state WHERE mode = 'paper'")?.['updated_at'], BigInt(HELD_AT + 1_000));
    assert.deepEqual(readDayState(w.db, 'paper').jumpAck, { equity: HELD, at: HELD_AT + 1_000 });
  });

  it('its failures reach the fault sink: three busy confirmations in ten minutes are a busy storm (the latch and the disk-db halt)', () => {
    const w = heldWorld();
    const busyDb = { transaction: (): never => { throw new StorageError('busy', 'database is locked'); } } as unknown as Db;
    for (let i = 0; i < 3; i += 1) {
      confirmJumpTx({ ...w.deps, db: busyDb }, lamports(HELD));
    }
    assert.ok(w.latch.blocked().includes('storage-busy'));
    assert.deepEqual(haltReasons(w.db), ['disk-db']);
  });

  it('an untrusted clock: not-run, nothing written', () => {
    const w = heldWorld();
    w.guard.trusted = false;
    const before = dump(w.db);
    assert.deepEqual(confirmJumpTx(w.deps, lamports(HELD)), { kind: 'not-run', code: 'clock-untrusted' });
    assert.equal(dump(w.db), before);
  });

  it('a value that is not lamports, before BEGIN: error:amount and the day-state-error halt; busy: no halt', () => {
    const w = heldWorld();
    assert.deepEqual(confirmJumpTx(w.deps, -1n as Lamports), { kind: 'error', code: 'error:amount', scope: 'intent', halt: 'set' });
    assert.deepEqual(haltReasons(w.db), [DAY_STATE_ERROR_HALT]);
    assert.ok(w.alerts.seen.some((a) => a.code === 'day-state-error' && a.severity === 'bug' && a.codes?.[0] === 'error:amount'));
    const b = heldWorld();
    const busyDb = { transaction: (): never => { throw new StorageError('busy', 'database is locked'); } } as unknown as Db;
    assert.deepEqual(confirmJumpTx({ ...b.deps, db: busyDb }, lamports(HELD)), { kind: 'error', code: 'error:storage-busy', scope: 'intent', halt: 'not-tried' });
    assert.deepEqual(haltReasons(b.db), []);
  });
});
