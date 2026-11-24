// The equity observation of step 6e-1 (STORAGE_DESIGN.md s.17.5.1; conditions C20, C28, C33, C38,
// C39, C40, C42, C49): one locked step per tick reads the stored day state, values the book with the
// marks, takes the jump test's base from the stored snapshots at or before now, runs risk/daystate.ts,
// and writes the day state, one snapshot, the prune, each new halt (its own audit row first) and the
// low-equity stop, all at the one clock reading. Any failure but busy becomes the day-state-error halt
// and an alert, never a retry with an edited state. Written before src/app/day-tx.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DAY_ALERT_EVERY_MS, DAY_HALT_TRIPS, DAY_STATE_ERROR_HALT, JUMP_BASE_TOLERANCE_MS, createDayWatch, observeDayTx, type ObserveOutcome } from '../../../src/app/day-tx.ts';
import { athensDay } from '../../../src/core/day.ts';
import { lamports } from '../../../src/core/units.ts';
import { dailyStopActive, emptyEquityState } from '../../../src/risk/daystate.ts';
import { readAuditRow, verifyAuditChain } from '../../../src/storage/repo-audit.ts';
import { insertOpening } from '../../../src/storage/repo-book.ts';
import { newestSnapshot, readDayState } from '../../../src/storage/repo-day.ts';
import { insertSnapshot } from '../../../src/storage/repo-observe.ts';
import { readFlags, readHalts } from '../../../src/storage/repo-flags.ts';
import { StorageError, type Db } from '../../../src/storage/sqlite.ts';
import path from 'node:path';
import { count, dump, fileDb, rawDb, removeDir, tempDir } from '../storage/helpers.ts';
import { DAY, HOUR, PAPER, SOL, dayWorld, holding, mark, plantDayState, setPaperSol, type DayWorld } from './day-world.ts';
import { T, recordingAlerts, setUpDb } from './world.ts';
import { createEntryLatch } from '../../../src/app/faults.ts';

const observed = (o: ObserveOutcome) => {
  assert.equal(o.kind, 'observed', JSON.stringify(o));
  return o as Extract<ObserveOutcome, { kind: 'observed' }>;
};
const haltReasons = (db: Db): string[] => readHalts(db).map((h) => h.reason);
const alerted = (w: DayWorld, code: string): number => w.alerts.seen.filter((a) => a.code === code).length;

describe('observeDayTx: the first observation (C38, C39)', () => {
  it('sets the day, its baseline and the peak; one snapshot; everything at the one clock reading', () => {
    const w = dayWorld();
    let reads = 0;
    const clock = { now: (): number => (reads++ === 0 ? T : T + 999) }; // a second reading would differ
    const o = observeDayTx({ ...w.deps, clock });
    assert.equal(reads, 1, 'the clock is read once');
    assert.deepEqual(o, { kind: 'observed', at: T, trips: [], haltsSet: [], entriesStopped: false, stopChanged: false, base: { state: 'missing', at: null }, equityKnown: true });
    assert.ok(Object.isFrozen(o));
    assert.deepEqual(readDayState(w.db, 'paper'), { ...emptyEquityState(), day: athensDay(T), dayStart: PAPER, lastEquity: PAPER, peak: PAPER });
    assert.equal(w.db.get("SELECT updated_at FROM day_state WHERE mode = 'paper'")?.['updated_at'], BigInt(T));
    assert.deepEqual(newestSnapshot(w.db, 'paper', T + DAY), { at: T, equity: PAPER, stopEquity: PAPER });
    assert.equal(count(w.db, 'equity_snapshots'), 1n);
    assert.deepEqual(haltReasons(w.db), []);
    assert.deepEqual(readDayState(w.db, 'live'), emptyEquityState(), 'the live day state is never observed in paper');
  });

  it('the constants', () => {
    assert.deepEqual([...DAY_HALT_TRIPS], ['equity-zero', 'sanity-max', 'sanity-bankroll', 'clock-backwards', 'peak-halt', 'daily-stop-twice']);
    assert.equal(DAY_STATE_ERROR_HALT, 'day-state-error:paper');
    assert.equal(JUMP_BASE_TOLERANCE_MS, 600_000);
    assert.equal(DAY_ALERT_EVERY_MS, 600_000);
  });
});

describe('observeDayTx: the trips', () => {
  it('a fall of 54%: the peak halt as a halt row (its audit row first), the daily stop in the day state; level-triggered', () => {
    const w = dayWorld();
    holding(w, 'p1', 650_000_000n); // 0.55 SOL and a position worth 0.65 SOL: 1.2 SOL
    observed(observeDayTx(w.deps));
    w.clock.advance(5_000);
    mark(w, 'p1', 0n);
    const o = observed(observeDayTx(w.deps));
    assert.deepEqual([...o.trips].sort(), ['daily-stop', 'peak-halt']);
    assert.deepEqual([...o.haltsSet], ['peak-halt:paper']);
    assert.deepEqual(haltReasons(w.db), ['peak-halt:paper']);
    const halt = readHalts(w.db)[0];
    const row = readAuditRow(w.db, halt?.setAuditId ?? 0);
    assert.deepEqual([row?.actor, row?.action, row?.detail, halt?.setAt], ['engine', 'engine:halt-set', { reason: 'peak-halt:paper' }, T + 5_000]);
    assert.equal(readDayState(w.db, 'paper').dailyStopDay, athensDay(T));
    assert.ok(dailyStopActive(readDayState(w.db, 'paper'), T + 5_000));
    assert.equal(w.anchors.written.at(-1)?.id, verifyAuditChain(w.db).newestId, 'the anchor moves to the halt row');
    const audits = count(w.db, 'audit_log');
    w.clock.advance(5_000);
    const again = observed(observeDayTx(w.deps));
    assert.deepEqual([...again.trips].sort(), ['daily-stop', 'peak-halt']);
    assert.deepEqual([...again.haltsSet], [], 'a halt already set writes nothing');
    assert.equal(count(w.db, 'audit_log'), audits);
    assert.equal(alerted(w, 'day-halt-set'), 1);
  });

  it('two halts in one tick: audit, halt, audit, halt; each halt names its own row (C28); an anomaly is stored as unknown', () => {
    const w = dayWorld();
    holding(w, 'p1', 1_600_000_000n); // 2.15 SOL: above 2 SOL and above three times the bankroll
    const o = observed(observeDayTx(w.deps));
    assert.deepEqual([...o.trips].sort(), ['sanity-bankroll', 'sanity-max']);
    assert.deepEqual([...o.haltsSet], ['sanity-bankroll:paper', 'sanity-max:paper']);
    const newest = verifyAuditChain(w.db).newestId;
    const byReason = new Map(readHalts(w.db).map((h) => [h.reason, h.setAuditId]));
    assert.equal(byReason.get('sanity-bankroll:paper'), newest - 1);
    assert.equal(byReason.get('sanity-max:paper'), newest);
    for (const [reason, id] of byReason) {
      const row = readAuditRow(w.db, id);
      assert.deepEqual([row?.actor, row?.action, row?.detail], ['engine', 'engine:halt-set', { reason }], reason);
    }
    assert.deepEqual(newestSnapshot(w.db, 'paper', T), { at: T, equity: null, stopEquity: null }, 'never the base of a jump test');
    assert.deepEqual(readDayState(w.db, 'paper'), emptyEquityState(), 'the baseline and the peak stay as they were');
    assert.equal(o.entriesStopped, null, 'the low-equity stop is left as stored on an anomaly');
  });

  it('zero equity: the equity-zero halt, an unknown snapshot', () => {
    const w = dayWorld();
    setPaperSol(w, 0n);
    const o = observed(observeDayTx(w.deps));
    assert.deepEqual([...o.trips], ['equity-zero']);
    assert.deepEqual(haltReasons(w.db), ['equity-zero:paper']);
    assert.deepEqual(newestSnapshot(w.db, 'paper', T), { at: T, equity: null, stopEquity: null });
  });

  it('a clock back across midnight: the clock-backwards halt; no snapshot and no prune; the state written unchanged', () => {
    const w = dayWorld();
    observed(observeDayTx(w.deps));
    w.db.transaction((tx) => insertSnapshot(tx, 'paper', T - 50 * HOUR, lamports(1n), null)); // a prune at T - 24 h would delete it
    const before = readDayState(w.db, 'paper');
    w.clock.set(T - DAY);
    const o = observed(observeDayTx(w.deps));
    assert.deepEqual([...o.trips], ['clock-backwards']);
    assert.deepEqual(haltReasons(w.db), ['clock-backwards:paper']);
    assert.equal(count(w.db, 'equity_snapshots'), 2n, 'no snapshot at the bad time, and nothing pruned');
    assert.deepEqual(readDayState(w.db, 'paper'), before);
    assert.equal(o.entriesStopped, null);
  });

  it('a second stop day in a row: the two-day halt as a halt row too', () => {
    const w = dayWorld();
    plantDayState(w.db, { ...emptyEquityState(), day: athensDay(T), dayStart: lamports(850_000_000n), lastEquity: lamports(850_000_000n), peak: lamports(850_000_000n), dailyStopDay: athensDay(T - DAY), dailyStopStreak: 1 });
    holding(w, 'p1', 0n); // 0.55 SOL against a baseline of 0.85: -35%
    const o = observed(observeDayTx(w.deps));
    assert.deepEqual([...o.trips].sort(), ['daily-stop', 'daily-stop-twice']);
    assert.deepEqual(haltReasons(w.db), ['daily-stop-twice:paper']);
    const s = readDayState(w.db, 'paper');
    assert.deepEqual([s.dailyStopDay, s.dailyStopStreak, s.streakHalt], [athensDay(T), 2, true]);
  });

  it('+63% within an hour: held in the day state, no halt row', () => {
    const w = dayWorld();
    observed(observeDayTx(w.deps)); // 0.55 SOL at T: the base an hour later
    w.clock.advance(HOUR);
    holding(w, 'p1', 350_000_000n); // 0.9 SOL
    const o = observed(observeDayTx(w.deps));
    assert.deepEqual([...o.trips], ['equity-jump']);
    assert.deepEqual(o.base, { state: 'ok', at: T });
    assert.deepEqual(haltReasons(w.db), []);
    const s = readDayState(w.db, 'paper');
    assert.deepEqual([s.jumpPending, s.jumpHeld?.equity, s.dayStart, s.peak], [true, 900_000_000n, PAPER, PAPER]);
    assert.equal(o.entriesStopped, null, 'a held jump leaves the low-equity stop as stored');
  });
});

describe('observeDayTx: the baseline, the base and unknown equity', () => {
  it('a same-day baseline of 0 is set again from the higher of the last equity and the observation (C39)', () => {
    const w = dayWorld();
    plantDayState(w.db, { ...emptyEquityState(), day: athensDay(T), dayStart: lamports(0n), lastEquity: lamports(600_000_000n), peak: lamports(600_000_000n) });
    observed(observeDayTx(w.deps)); // 0.55 SOL now
    assert.equal(readDayState(w.db, 'paper').dayStart, 600_000_000n);
  });

  it("the jump test's base: the snapshot nearest an hour ago at or before now; missing, ok and far (C42)", () => {
    const w = dayWorld();
    assert.deepEqual(observed(observeDayTx(w.deps)).base, { state: 'missing', at: null });
    w.clock.advance(HOUR + JUMP_BASE_TOLERANCE_MS); // the row at T is exactly the tolerance from the target
    assert.deepEqual(observed(observeDayTx(w.deps)).base, { state: 'ok', at: T });
    const far = dayWorld();
    observed(observeDayTx(far.deps));
    far.clock.advance(HOUR + JUMP_BASE_TOLERANCE_MS + 1);
    assert.deepEqual(observed(observeDayTx(far.deps)).base, { state: 'far', at: T });
    // a row a clock that stepped back left after now is never the base, even when it is the nearer one
    const back = dayWorld();
    back.db.transaction((tx) => {
      insertSnapshot(tx, 'paper', T - 2 * HOUR - 600_000, lamports(PAPER), null); // 70 minutes from the target
      insertSnapshot(tx, 'paper', T + 30_000, lamports(5n * SOL), null); // 60.5 minutes from it, after now
    });
    assert.deepEqual(observed(observeDayTx(back.deps)).base, { state: 'far', at: T - 2 * HOUR - 600_000 });
  });

  it('a mark older than 30 s: equity unknown, the snapshot unknown, the stops idle, the low-equity stop left as stored', () => {
    const w = dayWorld();
    holding(w, 'p1', 650_000_000n);
    observed(observeDayTx(w.deps));
    const before = readDayState(w.db, 'paper');
    w.clock.advance(60_000); // the mark is a minute old: stale, but not yet 5 minutes
    const o = observed(observeDayTx(w.deps));
    assert.deepEqual([o.equityKnown, o.entriesStopped, [...o.trips]], [false, null, []]);
    assert.deepEqual(newestSnapshot(w.db, 'paper', w.clock.now()), { at: T + 60_000, equity: null, stopEquity: null });
    assert.deepEqual(readDayState(w.db, 'paper'), before);
  });

  it('a mark older than 5 minutes counts 0 for the stops: the daily stop and the peak halt run on the stops equity', () => {
    const w = dayWorld();
    holding(w, 'p1', 650_000_000n); // 1.2 SOL
    observed(observeDayTx(w.deps));
    w.clock.advance(6 * 60_000);
    const o = observed(observeDayTx(w.deps)); // stops equity 0.55 SOL: -54%
    assert.equal(o.equityKnown, false);
    assert.deepEqual([...o.trips].sort(), ['daily-stop', 'peak-halt']);
    assert.deepEqual(haltReasons(w.db), ['peak-halt:paper']);
    assert.deepEqual(newestSnapshot(w.db, 'paper', w.clock.now()), { at: T + 6 * 60_000, equity: null, stopEquity: PAPER });
  });
});

describe('observeDayTx: the low-equity stop (C33)', () => {
  it('turns on below 0.2 SOL of sizing equity, stays on for the day (the baseline), turns off on a new day; one alert per turn-on', () => {
    const w = dayWorld();
    setPaperSol(w, 150_000_000n);
    const on = observed(observeDayTx(w.deps));
    assert.deepEqual([on.entriesStopped, on.stopChanged], [true, true]);
    assert.equal(readFlags(w.db).entriesStopped, true);
    w.clock.advance(5_000);
    const still = observed(observeDayTx(w.deps));
    assert.deepEqual([still.entriesStopped, still.stopChanged], [true, false]);
    setPaperSol(w, 200_000_000n); // +33%: no jump hold (a jump would leave the stop as stored)
    w.clock.advance(5_000);
    assert.equal(observed(observeDayTx(w.deps)).entriesStopped, true, "the day's baseline of 0.15 SOL sizes the trades all day");
    w.clock.advance(DAY); // a new day's baseline: 0.2 SOL, whose 10% is the 0.02 SOL minimum exactly
    const off = observed(observeDayTx(w.deps));
    assert.deepEqual([off.entriesStopped, off.stopChanged], [false, true]);
    assert.equal(readFlags(w.db).entriesStopped, false);
    assert.equal(alerted(w, 'equity-below-minimum'), 1);
  });
});

describe('observeDayTx: what it refuses, and its failures (C40)', () => {
  it('an untrusted clock: not-run, nothing written, a warning at most every 10 minutes', () => {
    const w = dayWorld();
    w.guard.trusted = false;
    const before = dump(w.db);
    assert.deepEqual(observeDayTx(w.deps), { kind: 'not-run', code: 'clock-untrusted' });
    assert.equal(dump(w.db), before);
    w.clock.advance(DAY_ALERT_EVERY_MS - 1);
    observeDayTx(w.deps);
    assert.equal(alerted(w, 'day-clock-untrusted'), 1);
    w.clock.advance(1);
    observeDayTx(w.deps);
    assert.equal(alerted(w, 'day-clock-untrusted'), 2);
  });

  it('a live position: live-not-built, the day-state-error halt with its row; the live day state never moves', () => {
    const w = dayWorld();
    w.db.transaction((tx) => insertOpening(tx, { id: 'ps_live', mint: 'MintL', strategy: 'momentum', mode: 'live', openedAt: T, maxSpend: lamports(30_000_000n) }, lamports(125_000n)));
    const o = observeDayTx(w.deps);
    assert.deepEqual(o, { kind: 'error', code: 'error:live-not-built', scope: 'intent', halt: 'set' });
    assert.deepEqual(haltReasons(w.db), [DAY_STATE_ERROR_HALT]);
    assert.deepEqual(readDayState(w.db, 'live'), emptyEquityState());
    assert.deepEqual(readDayState(w.db, 'paper'), emptyEquityState());
    assert.ok(w.alerts.seen.some((a) => a.code === 'day-state-error' && a.severity === 'bug' && a.codes?.[0] === 'error:live-not-built'));
  });

  it('a day-state write storage refuses (a planted state): nothing of the observation stays; the halt, its row and the anchor; no retry with an edited state', () => {
    const w = dayWorld();
    // two stop days in a row without the two-day halt: the observation keeps it, and the guard refuses the write
    const planted = { ...emptyEquityState(), day: athensDay(T), dayStart: lamports(PAPER), lastEquity: lamports(PAPER), peak: lamports(PAPER), dailyStopDay: athensDay(T - DAY), dailyStopStreak: 2 };
    plantDayState(w.db, planted);
    const o = observeDayTx(w.deps);
    assert.deepEqual(o, { kind: 'error', code: 'error:storage-bad-param', scope: 'intent', halt: 'set' });
    assert.deepEqual(readDayState(w.db, 'paper'), planted);
    assert.equal(count(w.db, 'equity_snapshots'), 0n);
    assert.deepEqual(haltReasons(w.db), [DAY_STATE_ERROR_HALT]);
    const halt = readHalts(w.db)[0];
    assert.deepEqual(readAuditRow(w.db, halt?.setAuditId ?? 0)?.detail, { reason: DAY_STATE_ERROR_HALT });
    assert.equal(w.anchors.written.at(-1)?.id, verifyAuditChain(w.db).newestId);
    assert.ok(w.alerts.seen.some((a) => a.code === 'day-state-error' && a.codes?.[0] === 'error:storage-bad-param'));
    w.clock.advance(5_000);
    assert.deepEqual(observeDayTx(w.deps), { kind: 'error', code: 'error:storage-bad-param', scope: 'intent', halt: 'already' });
    assert.deepEqual(readDayState(w.db, 'paper'), planted, 'the next tick observes the stored state again');
    assert.equal(alerted(w, 'day-state-error'), 1, 'at most every 10 minutes');
  });

  it('busy: nothing written, no halt tried, only the busy storm counts it', () => {
    const w = dayWorld();
    const busyDb = { transaction: (): never => { throw new StorageError('busy', 'database is locked'); } } as unknown as Db;
    for (let i = 0; i < 2; i += 1) {
      assert.deepEqual(observeDayTx({ ...w.deps, db: busyDb }), { kind: 'error', code: 'error:storage-busy', scope: 'intent', halt: 'not-tried' });
    }
    assert.deepEqual(haltReasons(w.db), []);
    assert.equal(alerted(w, 'day-state-error'), 0);
    assert.deepEqual([...w.latch.blocked()], []);
  });

  it('a missing live account (a damaged file): the day-state-error halt; the paper day state never moves', () => {
    const dir = tempDir('fomo-day-');
    try {
      const file = path.join(dir, 'bot.sqlite');
      setUpDb(file).close();
      // the never-delete trigger lifted for the change, as the boot tests do: a stand-in for a damaged file
      const raw = rawDb(file);
      const triggers = raw.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'ledger_accounts'").all() as { name: string; sql: string }[];
      raw.exec('PRAGMA foreign_keys = OFF');
      raw.exec('BEGIN');
      for (const t of triggers) {
        raw.exec(`DROP TRIGGER "${t.name}"`);
      }
      raw.exec("DELETE FROM ledger_accounts WHERE mode = 'live'");
      for (const t of triggers) {
        raw.exec(t.sql);
      }
      raw.exec('COMMIT');
      raw.close();
      const w = dayWorld(fileDb(file, false));
      try {
        assert.deepEqual(observeDayTx(w.deps), { kind: 'error', code: 'error:storage-row-missing', scope: 'latch', halt: 'set' });
        assert.deepEqual(haltReasons(w.db), [DAY_STATE_ERROR_HALT]);
        assert.deepEqual(readDayState(w.db, 'paper'), emptyEquityState());
      } finally {
        w.db.close();
      }
    } finally {
      removeDir(dir);
    }
  });

  it('a marks reader that throws: classified, the day-state-error halt', () => {
    const w = dayWorld();
    const o = observeDayTx({ ...w.deps, marks: { marks: () => assert.fail('the chain client broke') } });
    assert.deepEqual(o, { kind: 'error', code: 'error:unexpected', scope: 'latch', halt: 'set' });
    assert.deepEqual([...w.latch.blocked()], ['bug']);
  });

  it('a failed anchor write after a halt only warns', () => {
    const w = dayWorld();
    w.anchors.failing = true;
    setPaperSol(w, 0n);
    observed(observeDayTx(w.deps));
    assert.ok(w.alerts.seen.some((a) => a.code === 'anchor-write-failed' && a.severity === 'warn'));
  });
});

describe('observeDayTx: Athens midnight on the 23- and 25-hour days (U2)', () => {
  for (const [name, stopAt, midnight] of [
    ['2026-03-29, 23 hours', Date.UTC(2026, 2, 29, 8), Date.UTC(2026, 2, 29, 21)],
    ['2026-10-25, 25 hours', Date.UTC(2026, 9, 25, 8), Date.UTC(2026, 9, 25, 22)],
  ] as const) {
    it(`${name}: the daily stop lasts until local midnight, never an hour early or late`, () => {
      const w = dayWorld(undefined, stopAt);
      holding(w, 'p1', 650_000_000n);
      observed(observeDayTx(w.deps));
      mark(w, 'p1', 0n);
      w.clock.advance(5_000);
      observed(observeDayTx(w.deps));
      w.clock.set(midnight - 1);
      mark(w, 'p1', 0n);
      observed(observeDayTx(w.deps));
      assert.ok(dailyStopActive(readDayState(w.db, 'paper'), midnight - 1), 'still the stop day');
      w.clock.set(midnight);
      mark(w, 'p1', 0n);
      observed(observeDayTx(w.deps));
      const s = readDayState(w.db, 'paper');
      assert.equal(s.day, athensDay(midnight));
      assert.notEqual(athensDay(midnight), athensDay(midnight - 1));
      assert.equal(dailyStopActive(s, midnight), false, 'a new day');
    });
  }
});

describe('the day watch', () => {
  const observedOutcome = (over: Partial<Extract<ObserveOutcome, { kind: 'observed' }>> = {}): ObserveOutcome => ({
    kind: 'observed',
    at: T,
    trips: [],
    haltsSet: [],
    entriesStopped: false,
    stopChanged: false,
    base: { state: 'ok', at: T - HOUR },
    equityKnown: true,
    ...over,
  });
  const watchWorld = (startedAt = T) => {
    const alerts = recordingAlerts();
    const latch = createEntryLatch();
    return { alerts, latch, watch: createDayWatch({ alerts, latch, startedAt }) };
  };

  it('day-halt-set on every halt set, with the reasons; equity-below-minimum on every turn-on', () => {
    const { alerts, watch } = watchWorld();
    watch.note(observedOutcome({ haltsSet: ['peak-halt:paper'] }), T);
    watch.note(observedOutcome({ haltsSet: ['sanity-max:paper'] }), T + 1);
    watch.note(observedOutcome({ entriesStopped: true, stopChanged: true }), T + 2);
    watch.note(observedOutcome({ entriesStopped: true, stopChanged: false }), T + 3);
    watch.note(observedOutcome({ entriesStopped: false, stopChanged: true }), T + 4);
    watch.note(observedOutcome({ entriesStopped: true, stopChanged: true }), T + 5);
    assert.deepEqual(
      alerts.seen.map((a) => [a.code, a.severity, a.codes]),
      [
        ['day-halt-set', 'warn', ['peak-halt:paper']],
        ['day-halt-set', 'warn', ['sanity-max:paper']],
        ['equity-below-minimum', 'warn', undefined],
        ['equity-below-minimum', 'warn', undefined],
      ],
    );
  });

  it("equity-jump-held on the hold's first tick only, and again for a later hold", () => {
    const { alerts, watch } = watchWorld();
    watch.note(observedOutcome({ trips: ['equity-jump'] }), T);
    watch.note(observedOutcome({ trips: ['equity-jump'] }), T + 5_000);
    watch.note(observedOutcome(), T + 10_000);
    watch.note(observedOutcome({ trips: ['equity-jump'] }), T + 15_000);
    assert.equal(alerts.codes().filter((c) => c === 'equity-jump-held').length, 2);
  });

  it('equity-unknown after 5 minutes of unknown equity, at most every 10 minutes; known equity ends the run', () => {
    const { alerts, watch } = watchWorld();
    const unknown = observedOutcome({ equityKnown: false, entriesStopped: null });
    watch.note(unknown, T);
    watch.note(unknown, T + 300_000);
    assert.deepEqual(alerts.codes(), [], '5 minutes exactly is not over 5 minutes');
    watch.note(unknown, T + 300_001);
    watch.note(unknown, T + 300_001 + DAY_ALERT_EVERY_MS - 1);
    assert.equal(alerts.codes().filter((c) => c === 'equity-unknown').length, 1);
    watch.note(observedOutcome(), T + 2 * DAY_ALERT_EVERY_MS);
    watch.note(unknown, T + 2 * DAY_ALERT_EVERY_MS + 1);
    watch.note(unknown, T + 2 * DAY_ALERT_EVERY_MS + 300_000);
    assert.equal(alerts.codes().filter((c) => c === 'equity-unknown').length, 1, 'a new run waits 5 minutes again');
  });

  it('jump-base-missing and jump-base-far only after the first hour from the start (contract 6), at most every 10 minutes', () => {
    const { alerts, watch } = watchWorld(T);
    watch.note(observedOutcome({ base: { state: 'missing', at: null } }), T + HOUR - 1);
    watch.note(observedOutcome({ base: { state: 'far', at: T } }), T + HOUR - 1);
    assert.deepEqual(alerts.codes(), []);
    watch.note(observedOutcome({ base: { state: 'missing', at: null } }), T + HOUR);
    assert.deepEqual(alerts.codes(), ['jump-base-missing'], 'at the hour exactly');
    watch.note(observedOutcome({ base: { state: 'missing', at: null } }), T + HOUR + 1);
    watch.note(observedOutcome({ base: { state: 'far', at: T } }), T + HOUR + 2);
    assert.deepEqual(alerts.codes(), ['jump-base-missing', 'jump-base-far']);
  });

  it('day-state-error (bug, with the code) for any failure but busy; day-clock-untrusted; each at most every 10 minutes, again after the clock steps back', () => {
    const { alerts, watch } = watchWorld();
    watch.note({ kind: 'error', code: 'error:storage-busy', scope: 'intent', halt: 'not-tried' }, T);
    watch.note({ kind: 'error', code: 'error:risk', scope: 'intent', halt: 'set' }, T);
    watch.note({ kind: 'error', code: 'error:risk', scope: 'intent', halt: 'already' }, T + 1);
    watch.note({ kind: 'not-run', code: 'clock-untrusted' }, T);
    watch.note({ kind: 'not-run', code: 'clock-untrusted' }, T - 1); // the clock stepped back: alert again
    assert.deepEqual(
      alerts.seen.map((a) => [a.code, a.severity, a.codes]),
      [
        ['day-state-error', 'bug', ['error:risk']],
        ['day-clock-untrusted', 'warn', undefined],
        ['day-clock-untrusted', 'warn', undefined],
      ],
    );
  });

  it('a sink that throws latches entries as a bug and never escapes', () => {
    const latch = createEntryLatch();
    const watch = createDayWatch({ alerts: { alert: () => assert.fail('down') }, latch, startedAt: T });
    watch.note(observedOutcome({ haltsSet: ['peak-halt:paper'] }), T);
    assert.deepEqual([...latch.blocked()], ['bug']);
  });
});
