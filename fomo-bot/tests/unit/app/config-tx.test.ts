// The engine's config step and the shared config reads (STORAGE_DESIGN.md s.17.5.3 and s.17.8; C27,
// C60). readConfigState converts the stored rows for the planners and refuses a malformed one
// (ConfigError, never a guess); commandTime is never earlier than anything stored; applyDueTx applies
// each due loosening exactly as the owner queued it, one chained version per row, drops a stale or
// out-of-bounds row, demotes the live strategies the applied values touch and restarts their gates,
// all in one locked step on one clock reading; on an untrusted clock, or with a stored row dated after
// now, it writes nothing. Written before src/app/config-tx.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { LIVE_ARMED_IN_PAPER, applyDueTx, commandTime, readConfigState, type ConfigState } from '../../../src/app/config-tx.ts';
import { firstVersion, nextVersion, type ConfigVersion, type PendingChange } from '../../../src/config/changes.ts';
import { ConfigError, DEFAULT_TUNABLES, boundsOf, decodeTunables, valueAt, withValue, type TunablePath, type TunableValue } from '../../../src/config/tunables.ts';
import { STRATEGY_IDS, type StrategyId } from '../../../src/core/ids.ts';
import { verifyAuditChain } from '../../../src/storage/repo-audit.ts';
import { readConfigHistory, readPendingChanges } from '../../../src/storage/repo-config.ts';
import { readModes } from '../../../src/storage/repo-flags.ts';
import { setStrategyMode, writeOwnerConfig } from '../../../src/storage/repo-owner.ts';
import type { Db } from '../../../src/storage/sqlite.ts';
import { dump, migratedDb, removeDir, tamper, tempDir } from '../storage/helpers.ts';
import { DAY, dayWorld } from './day-world.ts';
import { T, setUpDb } from './world.ts';

const V1 = firstVersion(DEFAULT_TUNABLES, T);
/** A risk value: it touches no strategy's gate. */
const RISK: TunablePath = 'risk.dailyStopBps';
/** A shared exit value: it touches every strategy. */
const EXIT: TunablePath = 'exits.trailBps';
const LAMPORTS: TunablePath = 'momentum.minLiquidityLamports';
const LATER: TunablePath = 'exits.timeStopMin';

/** A value of the tunable other than its default, inside its bounds. */
function other(p: TunablePath): TunableValue {
  const [lo, hi] = boundsOf(p);
  return valueAt(DEFAULT_TUNABLES, p) === lo ? hi : lo;
}

/** A waiting change of `p` from its default to another value, asked for at `at` and due a day later. */
const row = (p: TunablePath, at: number, over: Partial<PendingChange> = {}): PendingChange =>
  Object.freeze({ path: p, from: valueAt(DEFAULT_TUNABLES, p), to: other(p), source: 'owner' as const, requestedAt: at, applyAt: at + DAY, ...over });

/** The owner's command while live trading is possible, through the owner's writer: the rows wait. */
function queue(db: Db, at: number, ...rows: PendingChange[]): void {
  db.transaction((tx) => writeOwnerConfig(tx, at, 'owner-telegram', 'owner:set', { version: null, pending: rows, cancelled: [] }));
}

/** A row stored past the owner's writer: a stand-in for one a later release's bounds made stale. */
function plant(db: Db, r: PendingChange): void {
  db.transaction((tx) =>
    tx.run(
      'INSERT INTO pending_changes (path, from_value, to_value, source, requested_at, apply_at) VALUES (?, ?, ?, ?, ?, ?)',
      r.path,
      String(r.from),
      String(r.to),
      r.source,
      BigInt(r.requestedAt),
      BigInt(r.applyAt),
    ),
  );
}

/** A strategy set live by the test, through paper (tests only: no step builds /golive yet). */
function goLive(db: Db, s: StrategyId, at = T): void {
  db.transaction((tx) => {
    setStrategyMode(tx, at, 'owner-telegram', s, 'paper');
    setStrategyMode(tx, at, 'owner-telegram', s, 'live');
  });
}

/** Every stored version, decoded as the config module reads it (the decode test of s.17.8). */
const decoded = (db: Db): ConfigVersion[] =>
  readConfigHistory(db).map((s) => ({ id: s.id, createdAt: s.createdAt, author: s.author, values: decodeTunables(s.valuesJson), changed: s.changed as readonly TunablePath[], undoTo: s.undoTo }));

/** The audit rows as actor, action and detail. */
const audits = (db: Db): string[] => db.all('SELECT actor, action, detail_json FROM audit_log ORDER BY id').map((r) => `${String(r['actor'])} ${String(r['action'])} ${String(r['detail_json'])}`);

const configError = (fn: () => unknown, message: RegExp): void => {
  assert.throws(fn, (e: unknown) => e instanceof ConfigError && message.test(e.message));
};

/** A database file with the owner's setup and `prepare`, changed behind the bot's back by `script`, then reopened for `check`. */
function tampered(prepare: (db: Db) => void, script: string, check: (db: Db) => void): void {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'bot.sqlite');
    const setup = setUpDb(file);
    prepare(setup);
    setup.close();
    tamper(file, script);
    const db = migratedDb(file);
    try {
      check(db);
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
}

const NO_PENDING_UPDATE = 'DROP TRIGGER pending_changes_no_update;\n';
const NO_VERSION_UPDATE = 'DROP TRIGGER config_versions_no_update;\n';

describe('readConfigState: the stored config, converted for the planners', () => {
  it('reads the owner\'s setup: version 1 decoded and active, nothing waiting, nothing live; all frozen', () => {
    const db = setUpDb();
    try {
      const s = readConfigState(db);
      assert.deepEqual(s, { history: [V1], active: V1, pending: [], liveStrategies: [] });
      assert.equal(s.active, s.history[0]);
      assert.ok([s, s.history, s.history[0], s.pending, s.liveStrategies].every(Object.isFrozen));
    } finally {
      db.close();
    }
  });

  it('the active version is the newest one', () => {
    const db = setUpDb();
    try {
      const v2 = nextVersion(V1, withValue(V1.values, RISK, other(RISK)), 'owner', T + 1);
      db.transaction((tx) => writeOwnerConfig(tx, T + 1, 'owner-telegram', 'owner:set', { version: v2, pending: [], cancelled: [] }));
      const s = readConfigState(db);
      assert.deepEqual(s.history, [V1, v2]);
      assert.equal(s.active, s.history[1]);
    } finally {
      db.close();
    }
  });

  it('converts each waiting amount to its tunable\'s kind: a lamport amount stays a bigint, any other becomes a number', () => {
    const db = setUpDb();
    try {
      const rows = [row(RISK, T), row(LAMPORTS, T)];
      queue(db, T, ...rows);
      const s = readConfigState(db);
      assert.deepEqual(s.pending, [rows[1], rows[0]]); // stored by name
      assert.deepEqual(s.pending.map((p) => [typeof p.from, typeof p.to]), [['bigint', 'bigint'], ['number', 'number']]);
      assert.ok(s.pending.every(Object.isFrozen));
    } finally {
      db.close();
    }
  });

  it('the live strategies come from the modes table, in the strategies\' order; a paper or off strategy is not live', () => {
    const db = setUpDb();
    try {
      db.transaction((tx) => setStrategyMode(tx, T, 'owner-telegram', 'launch', 'paper'));
      assert.deepEqual(readConfigState(db).liveStrategies, []);
      goLive(db, 'momentum');
      goLive(db, 'crowdflow');
      assert.deepEqual(readConfigState(db).liveStrategies, ['crowdflow', 'momentum']);
    } finally {
      db.close();
    }
  });

  it('a whole-number amount up to 2^53 - 1 becomes that number; one past it is refused, from or to, never rounded', () => {
    const prepare = (db: Db): void => queue(db, T, row(RISK, T));
    tampered(prepare, `${NO_PENDING_UPDATE}UPDATE pending_changes SET to_value = '9007199254740991';`, (db) => {
      assert.equal(readConfigState(db).pending[0]?.to, Number.MAX_SAFE_INTEGER);
    });
    for (const column of ['to_value', 'from_value']) {
      tampered(prepare, `${NO_PENDING_UPDATE}UPDATE pending_changes SET ${column} = '9007199254740992';`, (db) => {
        configError(() => readConfigState(db), /largest safe/);
      });
    }
  });

  it('a lamport amount is kept whole at any size a u64 holds', () => {
    tampered(
      (db) => queue(db, T, row(LAMPORTS, T)),
      `${NO_PENDING_UPDATE}UPDATE pending_changes SET to_value = '18446744073709551615';`,
      (db) => assert.equal(readConfigState(db).pending[0]?.to, 18_446_744_073_709_551_615n),
    );
  });

  it('a waiting row that names no tunable is refused (storage only checks the shape of the name)', () => {
    tampered(
      (db) => queue(db, T, row(RISK, T)),
      `${NO_PENDING_UPDATE}UPDATE pending_changes SET path = 'risk.unknownThing';`,
      (db) => configError(() => readConfigState(db), /names no tunable/),
    );
  });

  it('a version whose values do not decode is refused', () => {
    tampered(
      () => undefined,
      `${NO_VERSION_UPDATE}UPDATE config_versions SET values_json = '{}' WHERE id = 1;`,
      (db) => assert.throws(() => readConfigState(db), ConfigError),
    );
  });

  it('a version that lists a changed name that is no tunable is refused', () => {
    const v2 = nextVersion(V1, withValue(V1.values, RISK, other(RISK)), 'owner', T + 1);
    tampered(
      (db) => db.transaction((tx) => writeOwnerConfig(tx, T + 1, 'owner-telegram', 'owner:set', { version: v2, pending: [], cancelled: [] })),
      `${NO_VERSION_UPDATE}UPDATE config_versions SET changed_json = '["risk.unknownThing"]' WHERE id = 2;`,
      (db) => configError(() => readConfigState(db), /no tunable/),
    );
  });
});

describe('commandTime: an owner command is never dated before anything stored (C27, R5)', () => {
  const state = (activeAt: number, requested: readonly (readonly [TunablePath, number])[]): ConfigState =>
    Object.freeze({ history: [], active: { ...V1, createdAt: activeAt }, pending: requested.map(([p, at]) => row(p, at)), liveStrategies: [] });

  it('is the latest of now, the active version\'s time and every waiting row\'s request time', () => {
    assert.equal(commandTime(T + 5, state(T, [])), T + 5);
    assert.equal(commandTime(T, state(T + 7, [])), T + 7);
    assert.equal(commandTime(T, state(T + 7, [[RISK, T + 9], [EXIT, T + 3]])), T + 9);
    assert.equal(commandTime(T, state(T + 7, [[RISK, T + 3], [EXIT, T + 9]])), T + 9);
    assert.equal(commandTime(T + 20, state(T + 7, [[RISK, T + 9]])), T + 20);
    assert.equal(commandTime(T + 9, state(T + 9, [[RISK, T + 9]])), T + 9);
  });
});

describe('applyDueTx: a due loosening applied exactly as queued, or dropped (s.17.5.3)', () => {
  it('nothing waiting: nothing-due, nothing written, nothing alerted', () => {
    const w = dayWorld();
    const before = dump(w.db);
    assert.deepEqual(applyDueTx(w.deps), { kind: 'nothing-due' });
    assert.equal(dump(w.db), before);
    assert.deepEqual([w.alerts.seen, w.anchors.written, [...w.latch.blocked()]], [[], [], []]);
  });

  it('a row 1 ms before its time waits: nothing-due, nothing written', () => {
    const w = dayWorld();
    queue(w.db, T, row(RISK, T));
    w.clock.set(T + DAY - 1);
    const before = dump(w.db);
    assert.deepEqual(applyDueTx(w.deps), { kind: 'nothing-due' });
    assert.equal(dump(w.db), before);
    assert.deepEqual(w.alerts.seen, []);
  });

  it('one row at its time: the next version with that value moved, by the row\'s source, undoing to the active one, dated now; the row gone; the engine\'s row; the anchor; an info alert', () => {
    const w = dayWorld();
    const r = row(RISK, T);
    queue(w.db, T, r);
    const before = audits(w.db);
    w.clock.set(T + DAY);
    const o = applyDueTx(w.deps);
    assert.deepEqual(o, { kind: 'applied', versionIds: [2], applied: [RISK], dropped: [], demoted: [], restarted: [] });
    assert.ok(Object.isFrozen(o));
    assert.deepEqual(decoded(w.db), [V1, nextVersion(V1, withValue(V1.values, RISK, r.to), 'owner', T + DAY)]);
    assert.deepEqual(readPendingChanges(w.db), []);
    const after = audits(w.db);
    assert.deepEqual(after.slice(0, before.length), before);
    assert.deepEqual(after.slice(before.length).map((a) => a.split(' ').slice(0, 2).join(' ')), ['engine engine:apply-due']);
    assert.deepEqual(JSON.parse(after.at(-1)!.split(' ').slice(2).join(' ')), { path: RISK, version: 2 });
    assert.equal(w.anchors.written.at(-1)?.id, verifyAuditChain(w.db).newestId, 'the anchor moves to the engine\'s row');
    assert.deepEqual(w.alerts.seen, [{ code: 'loosening-applied', severity: 'info', codes: [RISK] }]);
    assert.deepEqual([...w.latch.blocked()], []);
  });

  it('two rows due together chain in the tunables\' order: one version each, each undoing to the one before, dated now; every stored version decodes to the plan\'s values', () => {
    const w = dayWorld();
    const exit = row(EXIT, T);
    const risk = row(RISK, T);
    queue(w.db, T, exit, risk);
    w.clock.set(T + DAY + 5);
    const o = applyDueTx(w.deps);
    const v2 = nextVersion(V1, withValue(V1.values, RISK, risk.to), 'owner', T + DAY + 5);
    const v3 = nextVersion(v2, withValue(v2.values, EXIT, exit.to), 'owner', T + DAY + 5);
    assert.deepEqual(o, { kind: 'applied', versionIds: [2, 3], applied: [RISK, EXIT], dropped: [], demoted: [], restarted: [...STRATEGY_IDS] });
    assert.deepEqual(decoded(w.db), [V1, v2, v3]);
    assert.deepEqual([v2.undoTo, v3.undoTo], [1, 2]);
    assert.deepEqual(readPendingChanges(w.db), []);
    const modes = readModes(w.db);
    assert.ok(STRATEGY_IDS.every((s) => modes[s].gateSince === T + DAY + 5 && modes[s].mode === 'off'), 'every gate restarts on an exit value; no mode changes');
    assert.deepEqual(w.alerts.seen, [{ code: 'loosening-applied', severity: 'info', codes: [RISK, EXIT] }]);
  });

  it('rows due at different times apply in the order they fell due, whatever their names', () => {
    const w = dayWorld();
    const exit = row(EXIT, T);
    const risk = row(RISK, T + 10);
    queue(w.db, T, exit);
    queue(w.db, T + 10, risk);
    w.clock.set(T + DAY + 10);
    const o = applyDueTx(w.deps);
    assert.deepEqual(o.kind === 'applied' ? o.applied : null, [EXIT, RISK]);
    const v2 = nextVersion(V1, withValue(V1.values, EXIT, exit.to), 'owner', T + DAY + 10);
    assert.deepEqual(decoded(w.db), [V1, v2, nextVersion(v2, withValue(v2.values, RISK, risk.to), 'owner', T + DAY + 10)]);
  });

  it('a clock behind the active version dates the step as the active version, never before it', () => {
    const w = dayWorld();
    const r = row(RISK, T);
    queue(w.db, T, r);
    const v2 = nextVersion(V1, withValue(V1.values, LAMPORTS, other(LAMPORTS)), 'owner', T + DAY + 5_000);
    w.db.transaction((tx) => writeOwnerConfig(tx, T + DAY + 5_000, 'owner-telegram', 'owner:set', { version: v2, pending: [], cancelled: [] }));
    w.clock.set(T + DAY + 1_000); // stepped back behind version 2, still after the row was asked for
    const o = applyDueTx(w.deps);
    assert.equal(o.kind, 'applied');
    assert.deepEqual(decoded(w.db), [V1, v2, nextVersion(v2, withValue(v2.values, RISK, r.to), 'owner', T + DAY + 5_000)]);
  });

  it('a due row whose tunable no longer holds the value it was made from is dropped with the engine\'s row, never applied', () => {
    const w = dayWorld();
    plant(w.db, row(EXIT, T, { from: 9_999 })); // the tunable holds 3000
    w.clock.set(T + DAY);
    const o = applyDueTx(w.deps);
    assert.deepEqual(o, { kind: 'applied', versionIds: [], applied: [], dropped: [EXIT], demoted: [], restarted: [] });
    assert.deepEqual(decoded(w.db), [V1]);
    assert.deepEqual(readPendingChanges(w.db), []);
    const last = audits(w.db).at(-1)!;
    assert.equal(last, `engine engine:drop-pending ${JSON.stringify({ path: EXIT })}`);
    assert.equal(w.anchors.written.at(-1)?.id, verifyAuditChain(w.db).newestId);
    assert.deepEqual(w.alerts.seen, [{ code: 'loosening-dropped', severity: 'info', codes: [EXIT] }]);
  });

  it('a due row whose value is now out of bounds is dropped the same way', () => {
    const w = dayWorld();
    const [, hi] = boundsOf(EXIT);
    plant(w.db, row(EXIT, T, { to: (hi as number) + 1 }));
    w.clock.set(T + DAY);
    assert.deepEqual(applyDueTx(w.deps), { kind: 'applied', versionIds: [], applied: [], dropped: [EXIT], demoted: [], restarted: [] });
    assert.deepEqual(decoded(w.db), [V1]);
    assert.deepEqual(readPendingChanges(w.db), []);
  });

  it('an exit value demotes every live strategy (each with its own engine row, after the version) and restarts every gate; a paper strategy is not demoted; a waiting row stays', () => {
    const w = dayWorld();
    goLive(w.db, 'momentum');
    goLive(w.db, 'crowdflow');
    w.db.transaction((tx) => setStrategyMode(tx, T, 'owner-telegram', 'launch', 'paper'));
    queue(w.db, T, row(EXIT, T));
    queue(w.db, T + 1, row(LATER, T + 1));
    const before = audits(w.db).length;
    w.clock.set(T + DAY);
    const o = applyDueTx(w.deps);
    assert.deepEqual(o, { kind: 'applied', versionIds: [2], applied: [EXIT], dropped: [], demoted: ['crowdflow', 'momentum'], restarted: [...STRATEGY_IDS] });
    const modes = readModes(w.db);
    for (const s of ['crowdflow', 'momentum'] as const) {
      assert.deepEqual({ ...modes[s] }, { mode: 'paper', changedAt: T + DAY, changedBy: 'auto-demote', gateSince: T + DAY });
    }
    assert.deepEqual([modes.launch.mode, modes.launch.changedBy, modes.launch.gateSince], ['paper', 'owner-paper', T + DAY]);
    assert.deepEqual(
      audits(w.db).slice(before).map((a) => a.split(' ').slice(0, 2).join(' ')),
      ['engine engine:apply-due', 'engine engine:demote', 'engine engine:demote'],
    );
    assert.deepEqual(readPendingChanges(w.db).map((p) => p.path), [LATER]);
    assert.deepEqual(w.alerts.seen, [
      { code: 'loosening-applied', severity: 'info', codes: [EXIT] },
      { code: 'strategy-demoted', severity: 'warn', codes: ['crowdflow', 'momentum'] },
    ]);
  });

  it('a risk value demotes no one and restarts no gate, a strategy live or not', () => {
    const w = dayWorld();
    goLive(w.db, 'momentum');
    const gates = readModes(w.db);
    queue(w.db, T, row(RISK, T));
    w.clock.set(T + DAY);
    assert.deepEqual(applyDueTx(w.deps), { kind: 'applied', versionIds: [2], applied: [RISK], dropped: [], demoted: [], restarted: [] });
    assert.deepEqual(readModes(w.db), gates);
  });

  it('reads the clock once: every time it writes is that one reading', () => {
    const w = dayWorld();
    goLive(w.db, 'momentum');
    queue(w.db, T, row(RISK, T), row(EXIT, T));
    plant(w.db, row(LATER, T, { from: 9 }));
    let calls = 0;
    const clock = { now: (): number => T + DAY + 1_000 * calls++ };
    const o = applyDueTx({ ...w.deps, clock });
    assert.equal(o.kind, 'applied');
    assert.equal(calls, 1);
    const times = (sql: string): unknown[] => w.db.all(sql).map((r) => r['t']);
    assert.deepEqual(times('SELECT created_at AS t FROM config_versions WHERE id > 1'), [BigInt(T + DAY), BigInt(T + DAY)]);
    assert.deepEqual(times("SELECT at AS t FROM audit_log WHERE actor = 'engine'"), [BigInt(T + DAY), BigInt(T + DAY), BigInt(T + DAY), BigInt(T + DAY)]);
    assert.deepEqual(times("SELECT changed_at AS t FROM strategy_modes WHERE strategy = 'momentum'"), [BigInt(T + DAY)]);
  });

  it('an untrusted clock: not-run, nothing written, nothing alerted here (the day watch reports the same guard), a due row waits', () => {
    const w = dayWorld();
    queue(w.db, T, row(RISK, T));
    w.clock.set(T + DAY);
    w.guard.trusted = false;
    const before = dump(w.db);
    assert.deepEqual(applyDueTx(w.deps), { kind: 'not-run', code: 'clock-untrusted' });
    assert.equal(dump(w.db), before);
    assert.deepEqual([w.alerts.seen, w.anchors.written, [...w.latch.blocked()]], [[], [], []]);
    w.guard.trusted = true;
    assert.equal(applyDueTx(w.deps).kind, 'applied');
  });

  it('a waiting row asked for after now (the clock stepped back): not-run, nothing applied, not even a due row; a warn alert; no latch (a clock fault is no bug)', () => {
    const w = dayWorld();
    queue(w.db, T, row(RISK, T));
    queue(w.db, T + DAY + 10, row(EXIT, T + DAY + 10));
    w.clock.set(T + DAY + 9);
    const before = dump(w.db);
    assert.deepEqual(applyDueTx(w.deps), { kind: 'not-run', code: 'clock-behind-pending' });
    assert.equal(dump(w.db), before);
    assert.deepEqual(w.alerts.seen, [{ code: 'config-clock-behind', severity: 'warn' }]);
    assert.deepEqual([...w.latch.blocked()], []);
    w.clock.set(T + DAY + 10); // the clock catches up: the due row applies, the other waits
    const o = applyDueTx(w.deps);
    assert.deepEqual(o.kind === 'applied' ? [o.applied, readPendingChanges(w.db).map((p) => p.path)] : null, [[RISK], [EXIT]]);
  });

  it('a stored version that does not decode: error:config, entries latched as a bug, nothing written', () => {
    tampered(
      (db) => queue(db, T, row(RISK, T)),
      `${NO_VERSION_UPDATE}UPDATE config_versions SET values_json = '{}' WHERE id = 1;`,
      (db) => {
        const w = dayWorld(db, T + DAY);
        const before = dump(db);
        assert.deepEqual(applyDueTx(w.deps), { kind: 'error', code: 'error:config', scope: 'latch' });
        assert.equal(dump(db), before);
        assert.deepEqual([...w.latch.blocked()], ['bug']);
        assert.deepEqual(w.alerts.seen, [{ code: 'error:config', severity: 'bug', codes: ['config-due'] }]);
      },
    );
  });

  it('a malformed waiting row (a whole-number amount past 2^53 - 1) is error:config the same way', () => {
    tampered(
      (db) => queue(db, T, row(RISK, T)),
      `${NO_PENDING_UPDATE}UPDATE pending_changes SET to_value = '9007199254740992';`,
      (db) => {
        const w = dayWorld(db, T + DAY);
        assert.deepEqual(applyDueTx(w.deps), { kind: 'error', code: 'error:config', scope: 'latch' });
        assert.deepEqual([...w.latch.blocked()], ['bug']);
      },
    );
  });

  it('an anchor write that fails after the commit only warns: the step stays applied', () => {
    const w = dayWorld();
    queue(w.db, T, row(RISK, T));
    w.anchors.failing = true;
    w.clock.set(T + DAY);
    assert.equal(applyDueTx(w.deps).kind, 'applied');
    assert.equal(decoded(w.db).length, 2);
    assert.deepEqual(w.alerts.codes(), ['anchor-write-failed', 'loosening-applied']);
  });

  it('LIVE_ARMED_IN_PAPER is false (C60): in paper nothing is armed for live; Phase 8 replaces it with the server\'s flag', () => {
    assert.equal(LIVE_ARMED_IN_PAPER, false);
  });
});
