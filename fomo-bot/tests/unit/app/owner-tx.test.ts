// The owner's commands as transactions (STORAGE_DESIGN.md s.17.5.4, s.17.5.5 and s.17.8). /set,
// /rollback and /cancel plan with config/changes.ts at the command time (never before anything stored)
// and write through the owner's writer, the owner's row first, then demote and restart gates, all in
// one locked step; a refusal writes nothing. /resume lifts the paper peak or streak halt, the peak only
// right after a money check that valued everything (contract 4); every expected refusal is a refusal,
// never a bug. Written before src/app/owner-tx.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { applyDueTx } from '../../../src/app/config-tx.ts';
import { RESUME_FRESH_MS, cancelPendingTx, resumeTx, rollbackTx, setTx, type OwnerConfigOutcome } from '../../../src/app/owner-tx.ts';
import { firstVersion, nextVersion, type ConfigVersion } from '../../../src/config/changes.ts';
import { DEFAULT_TUNABLES, decodeTunables, withValue, type TunablePath } from '../../../src/config/tunables.ts';
import { STRATEGY_IDS, type StrategyId } from '../../../src/core/ids.ts';
import { athensDay } from '../../../src/core/day.ts';
import { lamports } from '../../../src/core/units.ts';
import { emptyEquityState, resumePeak, resumeStreak, type EquityState } from '../../../src/risk/daystate.ts';
import { verifyAuditChain } from '../../../src/storage/repo-audit.ts';
import { readConfigHistory, readPendingChanges } from '../../../src/storage/repo-config.ts';
import { readDayState } from '../../../src/storage/repo-day.ts';
import { insertSnapshot } from '../../../src/storage/repo-observe.ts';
import { readFlags, readHalts, readModes, setHalt } from '../../../src/storage/repo-flags.ts';
import { setStrategyMode } from '../../../src/storage/repo-owner.ts';
import type { Db, Tx } from '../../../src/storage/sqlite.ts';
import { dump, fileDb, migratedDb, removeDir, tamper, tempDir } from '../storage/helpers.ts';
import { DAY, SOL, dayWorld, plantDayState, type DayWorld } from './day-world.ts';
import { T, setUpDb } from './world.ts';

const V1 = firstVersion(DEFAULT_TUNABLES, T);
/** Lower is safer: 4 applies at once even while live; 12 waits while live. Its default is 8. */
const ENTRIES: TunablePath = 'risk.entriesPerDay';
const SIGNAL: TunablePath = 'momentum.pullbackBps';
const EXIT: TunablePath = 'exits.trailBps';
const PAPER_MODEL: TunablePath = 'paper.pFailBps';
const LAMPORTS: TunablePath = 'momentum.minLiquidityLamports';

const decoded = (db: Db): ConfigVersion[] =>
  readConfigHistory(db).map((s) => ({ id: s.id, createdAt: s.createdAt, author: s.author, values: decodeTunables(s.valuesJson), changed: s.changed as readonly TunablePath[], undoTo: s.undoTo }));

/** Actor and action of each audit row. */
const actions = (db: Db): string[] => db.all('SELECT actor, action FROM audit_log ORDER BY id').map((r) => `${String(r['actor'])} ${String(r['action'])}`);

function goLive(db: Db, s: StrategyId, at = T): void {
  db.transaction((tx) => {
    setStrategyMode(tx, at, 'owner-telegram', s, 'paper');
    setStrategyMode(tx, at, 'owner-telegram', s, 'live');
  });
}

const done = (over: Partial<Extract<OwnerConfigOutcome, { kind: 'done' }>>): OwnerConfigOutcome => ({
  kind: 'done',
  at: T,
  clockBehind: false,
  versionId: null,
  applied: [],
  pending: [],
  cancelled: [],
  kept: [],
  demoted: [],
  restarted: [],
  ...over,
});

/** Nothing written, nothing alerted, nothing latched. */
function untouched(w: DayWorld, before: string): void {
  assert.equal(dump(w.db), before);
  assert.deepEqual([w.alerts.seen, w.anchors.written, [...w.latch.blocked()]], [[], [], []]);
}

describe('setTx: /set as the owner typed it (s.17.5.4)', () => {
  it('in paper a value applies at once: the next version by the owner, dated now, undoing to the active one; the owner\'s row; the anchor; no alert', () => {
    const w = dayWorld();
    const o = setTx(w.deps, 'owner-telegram', ENTRIES, '4');
    assert.deepEqual(o, done({ versionId: 2, applied: [{ path: ENTRIES, from: 8, to: 4, safety: 'safer' }] }));
    assert.ok(Object.isFrozen(o));
    assert.deepEqual(decoded(w.db), [V1, nextVersion(V1, withValue(V1.values, ENTRIES, 4), 'owner', T)]);
    assert.equal(actions(w.db).at(-1), 'owner-telegram owner:set');
    assert.equal(w.anchors.written.at(-1)?.id, verifyAuditChain(w.db).newestId);
    assert.deepEqual([w.alerts.seen, [...w.latch.blocked()]], [[], []]);
  });

  it('in paper a riskier value applies at once too (nothing is live and nothing is armed); a lamport value stays whole; the server is an owner too', () => {
    const w = dayWorld();
    assert.deepEqual(setTx(w.deps, 'owner-telegram', ENTRIES, '12'), done({ versionId: 2, applied: [{ path: ENTRIES, from: 8, to: 12, safety: 'riskier' }] }));
    const o = setTx(w.deps, 'owner-server', LAMPORTS, '30000000000');
    assert.deepEqual(o, done({ versionId: 3, applied: [{ path: LAMPORTS, from: 50_000_000_000n, to: 30_000_000_000n, safety: 'riskier' }], restarted: ['momentum'] }));
    assert.equal(actions(w.db).at(-1), 'owner-server owner:set');
    assert.deepEqual(readPendingChanges(w.db), []);
  });

  it('a strategy\'s own value restarts its go-live count; an exit value and the paper model restart every count', () => {
    const w = dayWorld();
    assert.deepEqual(setTx(w.deps, 'owner-telegram', SIGNAL, '2000'), done({ versionId: 2, applied: [{ path: SIGNAL, from: 1500, to: 2000, safety: 'neutral' }], restarted: ['momentum'] }));
    assert.deepEqual(STRATEGY_IDS.map((s) => readModes(w.db)[s].gateSince), [0, T, 0]);
    w.clock.set(T + 5);
    assert.equal(setTx(w.deps, 'owner-telegram', EXIT, '2000').kind, 'done');
    assert.deepEqual(STRATEGY_IDS.map((s) => readModes(w.db)[s].gateSince), [T + 5, T + 5, T + 5]);
    w.clock.set(T + 9);
    const o = setTx(w.deps, 'owner-telegram', PAPER_MODEL, '3000');
    assert.deepEqual(o, done({ at: T + 9, versionId: 4, applied: [{ path: PAPER_MODEL, from: 2000, to: 3000, safety: 'safer' }], restarted: [...STRATEGY_IDS] }));
    assert.deepEqual(STRATEGY_IDS.map((s) => readModes(w.db)[s].mode), ['off', 'off', 'off']);
  });

  it('refusals write nothing and alert nothing: an unknown name, a mode, not a number, out of bounds, no change, a paper model less pessimistic', () => {
    const w = dayWorld();
    assert.equal(setTx(w.deps, 'owner-telegram', PAPER_MODEL, '3000').kind, 'done');
    w.alerts.seen.length = 0;
    w.anchors.written.length = 0;
    const before = dump(w.db);
    for (const [p, value, reason] of [
      ['risk.unknownThing', '5', 'unknown-parameter'],
      ['mode', 'live', 'unknown-parameter'],
      [ENTRIES, '4.5', 'not-a-number'],
      [ENTRIES, '-1', 'not-a-number'],
      [ENTRIES, '0x10', 'not-a-number'],
      [ENTRIES, '13', 'out-of-bounds'],
      [ENTRIES, '0', 'out-of-bounds'],
      [ENTRIES, '8', 'no-change'],
      [PAPER_MODEL, '2500', 'paper-only-more-pessimistic'],
    ] as const) {
      assert.deepEqual(setTx(w.deps, 'owner-telegram', p, value), { kind: 'refused', reason }, `${p} ${value}`);
    }
    untouched(w, before);
  });

  it('while a strategy is live, a riskier risk value waits a day (a row asked for now, no version); a safer one then applies at once and replaces it', () => {
    const w = dayWorld();
    goLive(w.db, 'momentum');
    const row = { path: ENTRIES, from: 8, to: 12, source: 'owner' as const, requestedAt: T, applyAt: T + DAY };
    assert.deepEqual(setTx(w.deps, 'owner-telegram', ENTRIES, '12'), done({ pending: [row] }));
    assert.deepEqual(decoded(w.db), [V1]);
    assert.deepEqual(readPendingChanges(w.db).map((p) => ({ ...p, from: Number(p.from), to: Number(p.to) })), [row]);
    w.clock.set(T + 7);
    assert.deepEqual(setTx(w.deps, 'owner-telegram', ENTRIES, '4'), done({ at: T + 7, versionId: 2, applied: [{ path: ENTRIES, from: 8, to: 4, safety: 'safer' }], cancelled: [ENTRIES] }));
    assert.deepEqual(readPendingChanges(w.db), []);
  });

  it('a /set to the current value cancels its waiting row (no version)', () => {
    const w = dayWorld();
    goLive(w.db, 'momentum');
    assert.equal(setTx(w.deps, 'owner-telegram', ENTRIES, '12').kind, 'done');
    assert.deepEqual(setTx(w.deps, 'owner-telegram', ENTRIES, '8'), done({ cancelled: [ENTRIES] }));
    assert.deepEqual([decoded(w.db).length, readPendingChanges(w.db)], [1, []]);
  });

  it('a live strategy\'s own value applies at once and demotes it to paper (its gate restarts); the engine\'s demote row follows the owner\'s row', () => {
    const w = dayWorld();
    goLive(w.db, 'momentum');
    w.clock.set(T + 3);
    const o = setTx(w.deps, 'owner-telegram', SIGNAL, '2000');
    assert.deepEqual(o, done({ at: T + 3, versionId: 2, applied: [{ path: SIGNAL, from: 1500, to: 2000, safety: 'neutral' }], demoted: ['momentum'], restarted: ['momentum'] }));
    assert.deepEqual({ ...readModes(w.db).momentum }, { mode: 'paper', changedAt: T + 3, changedBy: 'auto-demote', gateSince: T + 3 });
    assert.deepEqual(actions(w.db).slice(-2), ['owner-telegram owner:set', 'engine engine:demote']);
    assert.equal(w.anchors.written.at(-1)?.id, verifyAuditChain(w.db).newestId);
  });

  it('a clock behind the active version: the command runs at the version\'s time and warns', () => {
    const w = dayWorld();
    w.clock.set(T + 10);
    assert.equal(setTx(w.deps, 'owner-telegram', ENTRIES, '4').kind, 'done');
    w.clock.set(T + 5);
    const o = setTx(w.deps, 'owner-telegram', SIGNAL, '2000');
    assert.deepEqual(o, done({ at: T + 10, clockBehind: true, versionId: 3, applied: [{ path: SIGNAL, from: 1500, to: 2000, safety: 'neutral' }], restarted: ['momentum'] }));
    assert.equal(decoded(w.db)[2]?.createdAt, T + 10);
    assert.deepEqual(w.alerts.seen, [{ code: 'config-clock-behind', severity: 'warn' }]);
  });

  it('a clock behind the active version dates the demotion and the gate restart as the command, not the clock', () => {
    const w = dayWorld();
    w.clock.set(T + 10);
    assert.equal(setTx(w.deps, 'owner-telegram', ENTRIES, '4').kind, 'done');
    goLive(w.db, 'momentum', T + 10);
    w.clock.set(T + 5);
    const o = setTx(w.deps, 'owner-telegram', SIGNAL, '2000');
    assert.deepEqual(o.kind === 'done' ? [o.at, o.clockBehind, o.demoted, o.restarted] : o, [T + 10, true, ['momentum'], ['momentum']]);
    assert.deepEqual({ ...readModes(w.db).momentum }, { mode: 'paper', changedAt: T + 10, changedBy: 'auto-demote', gateSince: T + 10 });
  });

  it('a clock behind a waiting row: the command runs at the row\'s request time', () => {
    const w = dayWorld();
    goLive(w.db, 'momentum');
    w.clock.set(T + 20);
    assert.equal(setTx(w.deps, 'owner-telegram', ENTRIES, '12').kind, 'done');
    w.clock.set(T + 15);
    const o = setTx(w.deps, 'owner-telegram', 'risk.tradePctBps', '500');
    assert.deepEqual(o, done({ at: T + 20, clockBehind: true, versionId: 2, applied: [{ path: 'risk.tradePctBps', from: 1000, to: 500, safety: 'safer' }] }));
  });

  it('a stored version that does not decode: error:config at the owner site, entries latched as a bug, nothing written', () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, 'bot.sqlite');
      setUpDb(file).close();
      tamper(file, "DROP TRIGGER config_versions_no_update;\nUPDATE config_versions SET values_json = '{}' WHERE id = 1;");
      const w = dayWorld(migratedDb(file));
      const before = dump(w.db);
      assert.deepEqual(setTx(w.deps, 'owner-telegram', ENTRIES, '4'), { kind: 'error', code: 'error:config', scope: 'latch' });
      assert.equal(dump(w.db), before);
      assert.deepEqual([...w.latch.blocked()], ['bug']);
      assert.deepEqual(w.alerts.seen, [{ code: 'error:config', severity: 'bug', codes: ['owner'] }]);
      w.db.close();
    } finally {
      removeDir(dir);
    }
  });

  it('an actor that is not the owner is a TypeError before anything is read', () => {
    const w = dayWorld();
    const before = dump(w.db);
    for (const actor of ['engine', 'ai', 'owner', '']) {
      assert.throws(() => setTx(w.deps, actor as never, ENTRIES, '4'), TypeError);
      assert.throws(() => rollbackTx(w.deps, actor as never), TypeError);
      assert.throws(() => cancelPendingTx(w.deps, actor as never, ENTRIES), TypeError);
      assert.throws(() => resumeTx(w.deps, actor as never, 'peak'), TypeError);
    }
    untouched(w, before);
  });
});

describe('rollbackTx: /rollback (s.17.5.4)', () => {
  it('nothing to roll back at the setup: refused, nothing written', () => {
    const w = dayWorld();
    const before = dump(w.db);
    assert.deepEqual(rollbackTx(w.deps, 'owner-telegram'), { kind: 'refused', reason: 'nothing-to-roll-back' });
    untouched(w, before);
  });

  it('one step back: a version by rollback with the earlier values, undoing to what the earlier one undid to; the owner\'s row', () => {
    const w = dayWorld();
    assert.equal(setTx(w.deps, 'owner-telegram', ENTRIES, '4').kind, 'done');
    w.clock.set(T + 1);
    const o = rollbackTx(w.deps, 'owner-telegram');
    assert.deepEqual(o, done({ at: T + 1, versionId: 3, applied: [{ path: ENTRIES, from: 4, to: 8, safety: 'riskier' }] }));
    const [, v2] = decoded(w.db);
    assert.deepEqual(decoded(w.db), [V1, v2, nextVersion(v2!, V1.values, 'rollback', T + 1, null)]);
    assert.equal(actions(w.db).at(-1), 'owner-telegram owner:rollback');
  });

  it('two steps back follow the undo chain; then there is nothing left to roll back', () => {
    const w = dayWorld();
    assert.equal(setTx(w.deps, 'owner-telegram', ENTRIES, '4').kind, 'done');
    assert.equal(setTx(w.deps, 'owner-telegram', SIGNAL, '2000').kind, 'done');
    const v2 = decoded(w.db)[1]!;
    const back1 = rollbackTx(w.deps, 'owner-telegram');
    assert.deepEqual(back1, done({ versionId: 4, applied: [{ path: SIGNAL, from: 2000, to: 1500, safety: 'neutral' }], restarted: ['momentum'] }));
    const back2 = rollbackTx(w.deps, 'owner-telegram');
    assert.deepEqual(back2, done({ versionId: 5, applied: [{ path: ENTRIES, from: 4, to: 8, safety: 'riskier' }] }));
    const history = decoded(w.db);
    assert.deepEqual([history[3]!.values, history[3]!.undoTo, history[4]!.values, history[4]!.undoTo], [v2.values, 1, V1.values, null]);
    const before = dump(w.db);
    assert.deepEqual(rollbackTx(w.deps, 'owner-telegram'), { kind: 'refused', reason: 'nothing-to-roll-back' });
    assert.equal(dump(w.db), before);
  });

  it('a rollback that would only make the paper model less pessimistic is refused, nothing written', () => {
    const w = dayWorld();
    assert.equal(setTx(w.deps, 'owner-telegram', PAPER_MODEL, '3000').kind, 'done');
    w.alerts.seen.length = 0;
    w.anchors.written.length = 0;
    const before = dump(w.db);
    assert.deepEqual(rollbackTx(w.deps, 'owner-telegram'), { kind: 'refused', reason: 'paper-only-more-pessimistic' });
    untouched(w, before);
  });

  it('while a strategy is live, a rollback whose fields all wait makes no version, only waiting rows', () => {
    const w = dayWorld();
    assert.equal(setTx(w.deps, 'owner-telegram', ENTRIES, '4').kind, 'done');
    goLive(w.db, 'momentum');
    w.clock.set(T + 2);
    const o = rollbackTx(w.deps, 'owner-telegram');
    assert.deepEqual(o, done({ at: T + 2, pending: [{ path: ENTRIES, from: 4, to: 8, source: 'rollback', requestedAt: T + 2, applyAt: T + 2 + DAY }] }));
    assert.equal(decoded(w.db).length, 2);
    assert.deepEqual(readPendingChanges(w.db).map((p) => [p.path, p.source]), [[ENTRIES, 'rollback']]);
  });
});

describe('cancelPendingTx: /cancel (s.17.5.4)', () => {
  it('the waiting row deleted, with the owner\'s cancel row; no version', () => {
    const w = dayWorld();
    goLive(w.db, 'momentum');
    assert.equal(setTx(w.deps, 'owner-telegram', ENTRIES, '12').kind, 'done');
    w.clock.set(T + 4);
    assert.deepEqual(cancelPendingTx(w.deps, 'owner-telegram', ENTRIES), done({ at: T + 4, cancelled: [ENTRIES] }));
    assert.deepEqual([decoded(w.db).length, readPendingChanges(w.db)], [1, []]);
    assert.equal(actions(w.db).at(-1), 'owner-telegram owner:cancel-pending');
    assert.equal(w.anchors.written.at(-1)?.id, verifyAuditChain(w.db).newestId);
  });

  it('refused, with nothing written: an unknown name, nothing waiting', () => {
    const w = dayWorld();
    const before = dump(w.db);
    assert.deepEqual(cancelPendingTx(w.deps, 'owner-telegram', 'risk.unknownThing'), { kind: 'refused', reason: 'unknown-parameter' });
    assert.deepEqual(cancelPendingTx(w.deps, 'owner-telegram', ENTRIES), { kind: 'refused', reason: 'nothing-to-cancel' });
    untouched(w, before);
  });

  it('a row the engine applied first is gone: the cancel finds nothing to cancel', () => {
    const w = dayWorld();
    goLive(w.db, 'momentum');
    assert.equal(setTx(w.deps, 'owner-telegram', ENTRIES, '12').kind, 'done');
    w.clock.set(T + DAY);
    assert.equal(applyDueTx(w.deps).kind, 'applied');
    assert.deepEqual(cancelPendingTx(w.deps, 'owner-telegram', ENTRIES), { kind: 'refused', reason: 'nothing-to-cancel' });
  });
});

// ---------------------------------------------------------------- /resume

const PEAK_HALT = 'peak-halt:paper';
const STREAK_HALT = 'daily-stop-twice:paper';
/** 54% below the peak: the peak halt is set. */
const HALTED: EquityState = Object.freeze({
  ...emptyEquityState(),
  day: athensDay(T),
  dayStart: lamports(SOL),
  lastEquity: lamports(550_000_000n),
  peak: lamports(1_200_000_000n),
});

/** The paper peak halt with its day state, and a valued money check `age` ms before now. */
function peakHalted(age: number | null = 0, state: EquityState = HALTED): DayWorld {
  const w = dayWorld(setUpDb(), T + 60_000);
  plantDayState(w.db, state);
  w.db.transaction((tx) => {
    setHalt(tx, PEAK_HALT, T);
    if (age !== null) {
      insertSnapshot(tx, 'paper', T + 60_000 - age, lamports(550_000_000n), lamports(550_000_000n));
    }
  });
  w.anchors.written.length = 0;
  return w;
}

describe('resumeTx: /resume after the paper peak or streak halt (s.17.5.5)', () => {
  it('the peak: each refusal writes nothing, alerts nothing, latches nothing, and is never a bug', () => {
    const cases: readonly (readonly [string, () => DayWorld, string])[] = [
      ['not halted', () => dayWorld(), 'not-halted'],
      ['a held jump', () => peakHalted(0, { ...HALTED, jumpPending: true, jumpHeld: { equity: lamports(900_000_000n), at: T } }), 'jump-held'],
      ['no known equity', () => peakHalted(0, { ...HALTED, lastEquity: lamports(0n), dayStart: lamports(0n) }), 'equity-unknown'],
      ['no money check', () => peakHalted(null), 'observe-first'],
      ['a check 60,001 ms old', () => peakHalted(RESUME_FRESH_MS + 1), 'observe-first'],
    ];
    for (const [name, world, reason] of cases) {
      const w = world();
      const before = dump(w.db);
      assert.deepEqual(resumeTx(w.deps, 'owner-telegram', 'peak'), { kind: 'refused', reason }, name);
      untouched(w, before);
    }
  });

  it('the peak: a newest check that could not value everything is refused too, even with a valued one before it', () => {
    const w = peakHalted(10);
    w.db.transaction((tx) => insertSnapshot(tx, 'paper', T + 60_000, null, lamports(550_000_000n)));
    const before = dump(w.db);
    assert.deepEqual(resumeTx(w.deps, 'owner-telegram', 'peak'), { kind: 'refused', reason: 'observe-first' });
    untouched(w, before);
  });

  it('the peak resumed right after a valued check (60,000 ms old at the edge): the halt lifted, the peak restarted as resumePeak computes, the clear time recorded, the owner\'s row, the anchor', () => {
    assert.equal(RESUME_FRESH_MS, 60_000, 'contract 4: one minute');
    const w = peakHalted(RESUME_FRESH_MS);
    const o = resumeTx(w.deps, 'owner-telegram', 'peak');
    assert.deepEqual(o, { kind: 'resumed', which: 'peak', at: T + 60_000 });
    assert.ok(Object.isFrozen(o));
    assert.deepEqual(readHalts(w.db), []);
    assert.deepEqual(readDayState(w.db, 'paper'), resumePeak(HALTED));
    assert.equal(readFlags(w.db).haltClearedAt, T + 60_000);
    assert.equal(actions(w.db).at(-1), 'owner-telegram owner:resume-peak');
    assert.equal(w.anchors.written.at(-1)?.id, verifyAuditChain(w.db).newestId);
    assert.deepEqual([w.alerts.seen, [...w.latch.blocked()]], [[], []]);
  });

  it('the streak: refused when not halted; resumed as resumeStreak computes, with no money check needed; only the paper halt lifts', () => {
    const w = dayWorld();
    const streak: EquityState = Object.freeze({ ...emptyEquityState(), day: athensDay(T), dayStart: lamports(SOL), lastEquity: lamports(SOL), peak: lamports(SOL), dailyStopDay: athensDay(T), dailyStopStreak: 2, streakHalt: true });
    plantDayState(w.db, streak);
    assert.deepEqual(resumeTx(w.deps, 'owner-server', 'streak'), { kind: 'refused', reason: 'not-halted' });
    w.db.transaction((tx) => {
      setHalt(tx, STREAK_HALT, T);
      setHalt(tx, 'daily-stop-twice:live', T);
    });
    w.clock.set(T + 9);
    assert.deepEqual(resumeTx(w.deps, 'owner-server', 'streak'), { kind: 'resumed', which: 'streak', at: T + 9 });
    assert.deepEqual(readHalts(w.db).map((h) => h.reason), ['daily-stop-twice:live']);
    assert.deepEqual(readDayState(w.db, 'paper'), resumeStreak(streak));
    assert.equal(actions(w.db).at(-1), 'owner-server owner:resume-streak');
  });

  it('a halt read in the step that storage then does not find to lift is a bug: error:bad-request, nothing written', () => {
    const w = peakHalted(0);
    let reads = 0;
    // a database that answers the halt read once, and then no more (storage disagreeing with itself)
    const lying = {
      file: w.db.file,
      readOnly: false,
      get: (sql: string, ...p: never[]) => w.db.get(sql, ...p),
      all: (sql: string, ...p: never[]) => w.db.all(sql, ...p),
      close: () => w.db.close(),
      transaction: (fn: (tx: Tx) => unknown) =>
        w.db.transaction((tx) => {
          const wrapped: Tx = {
            all: (sql, ...p) => {
              const rows = tx.all(sql, ...p);
              return sql.includes('halt_reasons') && (reads += 1) > 1 ? [] : rows;
            },
            get: (sql, ...p) => tx.get(sql, ...p),
            run: (sql, ...p) => tx.run(sql, ...p),
            script: (sql) => tx.script(sql),
          };
          return fn(wrapped) as never;
        }),
    } as unknown as Db;
    const before = dump(w.db);
    assert.deepEqual(resumeTx({ ...w.deps, db: lying }, 'owner-telegram', 'peak'), { kind: 'error', code: 'error:bad-request', scope: 'intent' });
    assert.equal(dump(w.db), before);
    assert.deepEqual(w.alerts.seen, [{ code: 'error:bad-request', severity: 'bug', codes: ['owner'] }]);
  });

  it('a kind that is neither peak nor streak is a TypeError before anything is read', () => {
    const w = peakHalted(0);
    const before = dump(w.db);
    for (const which of ['all', 'kill', '', 'Peak']) {
      assert.throws(() => resumeTx(w.deps, 'owner-telegram', which as never), TypeError);
    }
    untouched(w, before);
  });
});

describe('races: the engine\'s due step and /cancel on one due row (s.17.8)', () => {
  for (const first of ['applyDueTx', 'cancelPendingTx'] as const) {
    it(`${first} first: the other, inside it, is busy and writes nothing; after the commit it finds no row`, () => {
      const dir = tempDir();
      try {
        const file = path.join(dir, 'bot.sqlite');
        const b = dayWorld(setUpDb(file), T + DAY);
        goLive(b.db, 'momentum');
        b.clock.set(T);
        assert.equal(setTx(b.deps, 'owner-telegram', ENTRIES, '12').kind, 'done');
        b.clock.set(T + DAY);
        const a = dayWorld(fileDb(file, false), T + DAY); // a second connection, 100 ms busy timeout
        const second = (): unknown => (first === 'applyDueTx' ? cancelPendingTx(b.deps, 'owner-telegram', ENTRIES) : applyDueTx(b.deps));
        let inner: unknown = null;
        const clock = {
          now: (): number => {
            if (inner === null) {
              inner = second(); // A holds BEGIN IMMEDIATE now
            }
            return T + DAY;
          },
        };
        const o = first === 'applyDueTx' ? applyDueTx({ ...a.deps, clock }) : cancelPendingTx({ ...a.deps, clock }, 'owner-telegram', ENTRIES);
        assert.equal(o.kind, first === 'applyDueTx' ? 'applied' : 'done');
        assert.deepEqual(inner, { kind: 'error', code: 'error:storage-busy', scope: 'intent' });
        assert.deepEqual(second(), first === 'applyDueTx' ? { kind: 'refused', reason: 'nothing-to-cancel' } : { kind: 'nothing-due' });
        assert.deepEqual([readPendingChanges(b.db), decoded(b.db).length], [[], first === 'applyDueTx' ? 2 : 1]);
        a.db.close();
        b.db.close();
      } finally {
        removeDir(dir);
      }
    });
  }
});
