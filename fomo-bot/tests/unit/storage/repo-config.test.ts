// The config versions and the waiting loosenings (STORAGE_DESIGN.md s.3.4 and s.14; ARCHITECTURE.md
// s.7): version 1 comes only from the owner's setup at the server; the history and the pending rows
// come back as stored, for config/changes.ts to check and decode (a missing version 1 throws, never a
// default); the owner's commands write versions and pending rows with the owner's audit row first
// (repo-owner.ts, which the engine cannot import); and the engine itself may only apply a due
// loosening the owner queued, exactly as queued, or drop a due one, each with its own audit row.
// Storage re-checks what it can without the config module, so a bug in the engine can never write a
// version the owner did not ask for. Written before src/storage/repo-config.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { firstVersion, nextVersion, type ConfigVersion, type PendingChange } from '../../../src/config/changes.ts';
import { DEFAULT_TUNABLES, boundsOf, decodeTunables, encodeTunables, valueAt, withValue, type TunablePath, type TunableValue } from '../../../src/config/tunables.ts';
import * as configFile from '../../../src/storage/repo-config.ts';
import { applyDueStep, dropDuePending, readConfigHistory, readPendingChanges, type StoredVersion } from '../../../src/storage/repo-config.ts';
import { verifyAuditChain } from '../../../src/storage/repo-audit.ts';
import { writeOwnerConfig } from '../../../src/storage/repo-owner.ts';
import { setUpConfig } from '../../../src/storage/repo-server.ts';
import type { Db } from '../../../src/storage/sqlite.ts';
import { TEST_NOW, count, migratedDb, removeDir, storageError, tamper, tempDir } from './helpers.ts';

const T = TEST_NOW;
const DAY = 86_400_000;
const V1 = firstVersion(DEFAULT_TUNABLES, T);
const RISK: TunablePath = 'risk.dailyStopBps';
const LAMPORTS: TunablePath = 'momentum.minLiquidityLamports';
const EXIT: TunablePath = 'exits.hardStopBps';

/** A value of the tunable other than this one, inside its bounds. */
function other(path: TunablePath, current: TunableValue): TunableValue {
  const [lo, hi] = boundsOf(path);
  return current === lo ? hi : lo;
}

/** A waiting loosening of `path` from its value in `values`, requested at `at` and due a day later. */
function pendingOf(path: TunablePath, at: number, values = V1.values, source: PendingChange['source'] = 'owner'): PendingChange {
  const from = valueAt(values, path);
  return Object.freeze({ path, from, to: other(path, from), source, requestedAt: at, applyAt: at + DAY });
}

/** The version a due row makes: the active values with only its tunable moved to the queued value. */
const dueVersion = (active: ConfigVersion, row: PendingChange, at: number): ConfigVersion => nextVersion(active, withValue(active.values, row.path, row.to), row.source, at);

function withConfig(fn: (db: Db) => void): void {
  const db = migratedDb();
  try {
    db.transaction((tx) => setUpConfig(tx, T, V1));
    fn(db);
  } finally {
    db.close();
  }
}

/** The owner's /set while live: the loosening waits (no version now). */
function queue(db: Db, row: PendingChange): void {
  db.transaction((tx) => writeOwnerConfig(tx, row.requestedAt, 'owner-telegram', 'owner:set', { version: null, pending: [row], cancelled: [] }));
}

const audits = (db: Db): string[] => db.all('SELECT actor, action, detail_json FROM audit_log ORDER BY id').map((r) => `${String(r['actor'])} ${String(r['action'])} ${String(r['detail_json'])}`);

/** A stored version as the config module sees it, once decoded. */
function asVersion(s: StoredVersion): ConfigVersion {
  return { id: s.id, createdAt: s.createdAt, author: s.author, values: decodeTunables(s.valuesJson), changed: s.changed as readonly TunablePath[], undoTo: s.undoTo };
}

const active = (db: Db): ConfigVersion => asVersion(readConfigHistory(db).at(-1)!);

describe('the engine\'s config file: only what it may do', () => {
  it('exports reads, the due step and the due drop, and no other write: a new export here is a reviewed change', () => {
    assert.deepEqual(Object.keys(configFile).sort(), ['CHANGE_SOURCES', 'CONFIG_AUTHORS', 'applyDueStep', 'dropDuePending', 'readConfigHistory', 'readPendingChanges']);
  });
});

describe('the config history: version 1 from the owner\'s setup, then read back as stored', () => {
  it('needs version 1: an empty history is a missing row, never the defaults (contract 1)', () => {
    const db = migratedDb();
    try {
      storageError(() => readConfigHistory(db), 'row-missing');
      assert.deepEqual(readPendingChanges(db), []);
    } finally {
      db.close();
    }
  });

  it('version 1 comes from the owner\'s setup at the server, once, after the server\'s audit row', () => {
    withConfig((db) => {
      const history = readConfigHistory(db);
      assert.equal(history.length, 1);
      assert.deepEqual({ ...history[0] }, { id: 1, createdAt: T, author: 'default', valuesJson: encodeTunables(DEFAULT_TUNABLES), changed: [], undoTo: null });
      assert.deepEqual(asVersion(history[0]!), V1); // the stored text is the config module's own encoding
      assert.ok(Object.isFrozen(history) && Object.isFrozen(history[0]) && Object.isFrozen(history[0]!.changed));
      assert.deepEqual(audits(db), ['owner-server server:setup {}']);
      storageError(() => db.transaction((tx) => setUpConfig(tx, T + 1, V1)), 'row-count'); // only once
      assert.equal(count(db, 'audit_log'), 1n);
      assert.equal(count(db, 'config_versions'), 1n);
    });
  });

  it('setUpConfig takes only a first version (id 1, the default author, nothing changed or undone), and writes nothing otherwise', () => {
    const db = migratedDb();
    try {
      for (const bad of [{ ...V1, id: 2 }, { ...V1, author: 'owner' as const }, { ...V1, changed: [RISK] }, { ...V1, undoTo: 1 }]) {
        storageError(() => db.transaction((tx) => setUpConfig(tx, T, bad)), 'bad-param');
      }
      storageError(() => db.transaction((tx) => setUpConfig(tx, Number.NaN, V1)), 'bad-param');
      assert.equal(count(db, 'audit_log'), 0n);
      assert.equal(count(db, 'config_versions'), 0n);
    } finally {
      db.close();
    }
  });

  it('reads every version back in order, as stored, and each decodes to what was written', () => {
    withConfig((db) => {
      const v2 = nextVersion(V1, withValue(V1.values, RISK, other(RISK, valueAt(V1.values, RISK))), 'owner', T + 1);
      db.transaction((tx) => writeOwnerConfig(tx, T + 1, 'owner-telegram', 'owner:set', { version: v2, pending: [], cancelled: [] }));
      const v3 = nextVersion(v2, withValue(v2.values, LAMPORTS, other(LAMPORTS, valueAt(v2.values, LAMPORTS))), 'owner', T + 2);
      db.transaction((tx) => writeOwnerConfig(tx, T + 2, 'owner-server', 'owner:set', { version: v3, pending: [], cancelled: [] }));
      assert.deepEqual(readConfigHistory(db).map(asVersion), [V1, v2, v3]);
      assert.equal(typeof valueAt(active(db).values, LAMPORTS), 'bigint'); // lamports come back as bigints
    });
  });

  it('a history changed behind the bot\'s back is refused, never patched (a gap, an unknown author, text jsonParam never writes, a changed list that is no list of names)', () => {
    const cases: readonly (readonly [string, RegExp])[] = [
      ["DROP TRIGGER config_versions_in_order;\nINSERT INTO config_versions (id, created_at, author, values_json, changed_json, undo_to) SELECT 3, created_at, 'owner', values_json, '[\"risk.dailyStopBps\"]', 1 FROM config_versions WHERE id = 1;", /version 3/],
      ["DROP TRIGGER config_versions_no_update;\nPRAGMA ignore_check_constraints = 1;\nUPDATE config_versions SET author = 'stranger' WHERE id = 1;", /column author/],
      ["DROP TRIGGER config_versions_no_update;\nUPDATE config_versions SET values_json = ' ' || values_json WHERE id = 1;", /column values_json/],
      ["DROP TRIGGER config_versions_no_update;\nPRAGMA ignore_check_constraints = 1;\nUPDATE config_versions SET changed_json = '[1]' WHERE id = 1;", /column changed_json/],
      ["DROP TRIGGER config_versions_no_update;\nUPDATE config_versions SET values_json = '[1]' WHERE id = 1;", /column values_json/], // JSON, but no tunables
    ];
    for (const [script, message] of cases) {
      const dir = tempDir();
      try {
        const file = path.join(dir, 'bot.sqlite');
        const setup = migratedDb(file);
        setup.transaction((tx) => setUpConfig(tx, T, V1));
        setup.close();
        tamper(file, script);
        const db = migratedDb(file);
        try {
          assert.match(storageError(() => readConfigHistory(db), 'bad-cell').detail, message, script);
        } finally {
          db.close();
        }
      } finally {
        removeDir(dir);
      }
    }
  });
});

describe('the waiting loosenings, as stored', () => {
  it('a waiting row changed behind the bot\'s back is refused, never patched (a name that is no tunable name, an unknown source)', () => {
    for (const [script, message] of [
      ["DROP TRIGGER pending_changes_no_update;\nPRAGMA ignore_check_constraints = 1;\nUPDATE pending_changes SET path = 'BAD';", /column path/],
      ["DROP TRIGGER pending_changes_no_update;\nPRAGMA ignore_check_constraints = 1;\nUPDATE pending_changes SET source = 'ai';", /column source/],
    ] as const) {
      const dir = tempDir();
      try {
        const file = path.join(dir, 'bot.sqlite');
        const setup = migratedDb(file);
        setup.transaction((tx) => setUpConfig(tx, T, V1));
        queue(setup, pendingOf(EXIT, T));
        setup.close();
        tamper(file, script);
        const db = migratedDb(file);
        try {
          assert.match(storageError(() => readPendingChanges(db), 'bad-cell').detail, message, script);
        } finally {
          db.close();
        }
      } finally {
        removeDir(dir);
      }
    }
  });
});

describe('the owner\'s config commands: the owner\'s audit row first, then exactly what the planner decided', () => {
  it('/set writes the owner\'s row, cancels the rows it replaces, makes the version that applies now and queues the rest', () => {
    withConfig((db) => {
      queue(db, pendingOf(EXIT, T));
      const v2 = nextVersion(V1, withValue(V1.values, RISK, other(RISK, valueAt(V1.values, RISK))), 'owner', T + 5);
      const waiting = pendingOf(LAMPORTS, T + 5);
      const id = db.transaction((tx) => writeOwnerConfig(tx, T + 5, 'owner-server', 'owner:set', { version: v2, pending: [waiting], cancelled: [EXIT] }));
      assert.equal(id, 2);
      assert.deepEqual(readConfigHistory(db).map(asVersion), [V1, v2]);
      assert.deepEqual(readPendingChanges(db), [{ path: LAMPORTS, from: waiting.from, to: waiting.to, source: 'owner', requestedAt: T + 5, applyAt: T + 5 + DAY }]);
      assert.deepEqual(audits(db).slice(1), [
        `owner-telegram owner:set {"version":null,"applied":[],"pending":["${EXIT}"],"cancelled":[]}`,
        `owner-server owner:set {"version":2,"applied":["${RISK}"],"pending":["${LAMPORTS}"],"cancelled":["${EXIT}"]}`,
      ]);
      assert.equal(verifyAuditChain(db).rows, 3);
    });
  });

  it('a rollback and an approved AI proposal write their own authors; /cancel only deletes; each command its own action', () => {
    withConfig((db) => {
      const v2 = nextVersion(V1, withValue(V1.values, RISK, other(RISK, valueAt(V1.values, RISK))), 'ai-approved', T + 1);
      db.transaction((tx) => writeOwnerConfig(tx, T + 1, 'owner-telegram', 'owner:ai-approve', { version: v2, pending: [], cancelled: [] }));
      const v3 = nextVersion(v2, V1.values, 'rollback', T + 2, null);
      db.transaction((tx) => writeOwnerConfig(tx, T + 2, 'owner-telegram', 'owner:rollback', { version: v3, pending: [], cancelled: [] }));
      queue(db, pendingOf(EXIT, T + 3, v3.values));
      assert.equal(db.transaction((tx) => writeOwnerConfig(tx, T + 4, 'owner-telegram', 'owner:cancel-pending', { version: null, pending: [], cancelled: [EXIT] })), null);
      assert.deepEqual(readPendingChanges(db), []);
      assert.deepEqual(readConfigHistory(db).map((v) => [v.author, v.undoTo]), [['default', null], ['ai-approved', 1], ['rollback', null]]);
      assert.deepEqual(audits(db).map((a) => a.split(' ').slice(0, 2).join(' ')), [
        'owner-server server:setup', 'owner-telegram owner:ai-approve', 'owner-telegram owner:rollback', 'owner-telegram owner:set', 'owner-telegram owner:cancel-pending',
      ]);
    });
  });

  it('refuses, before any write, what no planner would hand it: storage re-checks what it can see', () => {
    withConfig((db) => {
      queue(db, pendingOf(EXIT, T));
      const base = active(db);
      const v2 = nextVersion(base, withValue(base.values, RISK, other(RISK, valueAt(base.values, RISK))), 'owner', T + 1);
      const setsExit = nextVersion(base, withValue(base.values, EXIT, other(EXIT, valueAt(base.values, EXIT))), 'owner', T + 1);
      const rollback = nextVersion(base, v2.values, 'rollback', T + 1, null);
      const refused: readonly (readonly [string, Parameters<typeof writeOwnerConfig>[3], Parameters<typeof writeOwnerConfig>[4], 'bad-param' | 'row-count']) [] = [
        // the times (review R, risk 2 and 3): a row is asked for by this command, now, and a version dated between the active one and now
        ['a waiting row asked for before the command (due at once)', 'owner:set', { version: null, pending: [pendingOf(RISK, T + 1 - 2 * DAY)], cancelled: [] }, 'bad-param'],
        ['a waiting row asked for after the command', 'owner:set', { version: null, pending: [pendingOf(RISK, T + 2)], cancelled: [] }, 'bad-param'],
        ['a version dated before the active one', 'owner:set', { version: { ...v2, createdAt: T - 1 }, pending: [], cancelled: [] }, 'bad-param'],
        ['a version dated after the command', 'owner:set', { version: { ...v2, createdAt: T + 2 }, pending: [], cancelled: [] }, 'bad-param'],
        // RISK_POLICY s.12 (review R, risk 4): a command replaces the waiting change of every tunable it sets; /rollback replaces them all
        ['a version that sets a tunable and leaves its waiting row', 'owner:set', { version: setsExit, pending: [], cancelled: [] }, 'bad-param'],
        ['a tunable applied now and queued too', 'owner:set', { version: v2, pending: [pendingOf(RISK, T + 1)], cancelled: [] }, 'bad-param'],
        ['a rollback that leaves a waiting row', 'owner:rollback', { version: rollback, pending: [], cancelled: [] }, 'bad-param'],
        ['another action', 'owner:unpause' as unknown as 'owner:set', { version: v2, pending: [], cancelled: [] }, 'bad-param'],
        ['nothing to write', 'owner:set', { version: null, pending: [], cancelled: [] }, 'bad-param'],
        ['a cancel that also writes', 'owner:cancel-pending', { version: v2, pending: [], cancelled: [EXIT] }, 'bad-param'],
        // a malformed row the source check alone would let by: a /cancel refuses any write on its own
        ['a cancel that also queues', 'owner:cancel-pending', { version: null, pending: [{ ...pendingOf(RISK, T + 1), source: null as unknown as 'owner' }], cancelled: [EXIT] }, 'bad-param'],
        ['a cancel of nothing', 'owner:cancel-pending', { version: null, pending: [], cancelled: [] }, 'bad-param'],
        ['the author of another command', 'owner:rollback', { version: v2, pending: [], cancelled: [] }, 'bad-param'],
        ['a version that is not the next one', 'owner:set', { version: { ...v2, id: 5 }, pending: [], cancelled: [] }, 'bad-param'],
        ['a version that lists less than it changed', 'owner:set', { version: { ...v2, changed: [] }, pending: [], cancelled: [] }, 'bad-param'],
        ['a version that lists what it did not change', 'owner:set', { version: { ...v2, changed: [RISK, EXIT] }, pending: [], cancelled: [] }, 'bad-param'],
        ['a version that drops a tunable', 'owner:set', { version: { ...v2, values: { ...v2.values, paper: undefined } as unknown as ConfigVersion['values'] }, pending: [], cancelled: [] }, 'bad-param'],
        ['a version that undoes to itself', 'owner:set', { version: { ...v2, undoTo: 2 }, pending: [], cancelled: [] }, 'bad-param'],
        ['a version that changes nothing', 'owner:set', { version: { ...v2, values: base.values, changed: [] }, pending: [], cancelled: [] }, 'bad-param'],
        ['a pending row for no tunable', 'owner:set', { version: null, pending: [{ ...pendingOf(RISK, T + 1), path: 'risk.noSuchThing' as TunablePath }], cancelled: [] }, 'bad-param'],
        ['a pending row not made from the current value', 'owner:set', { version: null, pending: [{ ...pendingOf(RISK, T + 1), from: other(RISK, valueAt(base.values, RISK)) }], cancelled: [] }, 'bad-param'],
        ['a pending row of another source', 'owner:set', { version: null, pending: [pendingOf(RISK, T + 1, base.values, 'rollback')], cancelled: [] }, 'bad-param'],
        ['a pending row that waits less than a day', 'owner:set', { version: null, pending: [{ ...pendingOf(RISK, T + 1), applyAt: T + DAY }], cancelled: [] }, 'bad-param'],
        ['a second row for a tunable that has one', 'owner:set', { version: null, pending: [pendingOf(EXIT, T + 1)], cancelled: [] }, 'bad-param'],
        ['two rows for one tunable', 'owner:set', { version: null, pending: [pendingOf(RISK, T + 1), pendingOf(RISK, T + 1)], cancelled: [] }, 'bad-param'],
        ['a cancel of a row that is not there', 'owner:set', { version: v2, pending: [], cancelled: [LAMPORTS] }, 'row-count'],
        ['cancelled names that are no list', 'owner:set', { version: v2, pending: [], cancelled: EXIT as unknown as string[] }, 'bad-param'],
        ['a tunable cancelled twice', 'owner:set', { version: v2, pending: [], cancelled: [EXIT, EXIT] }, 'bad-param'],
        ['a changed list with a name that is no name', 'owner:set', { version: { ...v2, changed: ['risk'] as unknown as TunablePath[] }, pending: [], cancelled: [] }, 'bad-param'],
        ['waiting changes that are no list', 'owner:set', { version: v2, pending: RISK as unknown as PendingChange[], cancelled: [] }, 'bad-param'],
        ['a waiting value that is no whole number', 'owner:set', { version: null, pending: [{ ...pendingOf(RISK, T + 1), from: 1.5 }], cancelled: [] }, 'bad-param'],
        ['a waiting value below zero', 'owner:set', { version: null, pending: [{ ...pendingOf(RISK, T + 1), to: -1n }], cancelled: [] }, 'bad-param'],
      ];
      for (const [what, action, write, code] of refused) {
        // a careless caller that catches the refusal and commits still writes nothing
        db.transaction((tx) => {
          storageError(() => writeOwnerConfig(tx, T + 1, 'owner-telegram', action, write), code);
        });
        assert.equal(count(db, 'audit_log'), 2n, what);
      }
      storageError(() => db.transaction((tx) => writeOwnerConfig(tx, T + 1, 'engine' as unknown as 'owner-server', 'owner:set', { version: v2, pending: [], cancelled: [] })), 'bad-param');
      assert.deepEqual(readConfigHistory(db).map((v) => v.id), [1]);
      assert.deepEqual(readPendingChanges(db).map((p) => p.path), [EXIT]);
    });
  });

  it('what the commands do need goes through: a version dated as the active one while the clock is behind it, a set and a rollback that replace the waiting rows (review R)', () => {
    withConfig((db) => {
      queue(db, pendingOf(EXIT, T));
      // the clock stepped back behind version 1: the new version is dated as the active one, never earlier
      const behind = T - 5;
      const v2 = nextVersion(V1, withValue(V1.values, RISK, other(RISK, valueAt(V1.values, RISK))), 'owner', T);
      storageError(() => db.transaction((tx) => writeOwnerConfig(tx, behind, 'owner-telegram', 'owner:set', { version: { ...v2, createdAt: behind }, pending: [], cancelled: [] })), 'bad-param');
      db.transaction((tx) => writeOwnerConfig(tx, behind, 'owner-telegram', 'owner:set', { version: v2, pending: [], cancelled: [] }));
      // setting a tunable that has a waiting row replaces that row
      const v3 = nextVersion(v2, withValue(v2.values, EXIT, other(EXIT, valueAt(v2.values, EXIT))), 'owner', T + 1);
      db.transaction((tx) => writeOwnerConfig(tx, T + 1, 'owner-telegram', 'owner:set', { version: v3, pending: [], cancelled: [EXIT] }));
      assert.deepEqual(readPendingChanges(db), []);
      // a rollback replaces every waiting row, also of tunables it does not move
      queue(db, pendingOf(LAMPORTS, T + 2, v3.values));
      const back = nextVersion(v3, V1.values, 'rollback', T + 3, null);
      db.transaction((tx) => writeOwnerConfig(tx, T + 3, 'owner-telegram', 'owner:rollback', { version: back, pending: [], cancelled: [LAMPORTS] }));
      assert.deepEqual(readPendingChanges(db), []);
      assert.deepEqual(readConfigHistory(db).map((v) => [v.id, v.createdAt]), [[1, T], [2, T], [3, T + 1], [4, T + 3]]);
    });
  });
});

describe('the engine\'s due step: only a loosening the owner queued, exactly as queued, once it is due', () => {
  it('applies a due row as the next version, deletes the row, and writes the engine\'s audit row first', () => {
    withConfig((db) => {
      const row = pendingOf(LAMPORTS, T); // a bigint tunable: stored as decimal text, compared as stored
      queue(db, row);
      const v2 = dueVersion(V1, row, T + DAY);
      assert.equal(db.transaction((tx) => applyDueStep(tx, T + DAY, v2)), 2);
      assert.deepEqual(readConfigHistory(db).map(asVersion), [V1, v2]);
      assert.deepEqual(readPendingChanges(db), []);
      assert.deepEqual(audits(db).at(-1), `engine engine:apply-due {"path":"${LAMPORTS}","version":2}`);
      // the next due row builds on the version just made
      const exit = pendingOf(EXIT, T + DAY, v2.values);
      queue(db, exit);
      assert.equal(db.transaction((tx) => applyDueStep(tx, T + 2 * DAY + 7, dueVersion(v2, exit, T + 2 * DAY + 7))), 3);
      assert.equal(verifyAuditChain(db).rows, 5);
    });
  });

  it('refuses, before any write, a version that is anything but the queued change (each one alone)', () => {
    withConfig((db) => {
      const row = pendingOf(RISK, T);
      queue(db, row);
      const good = dueVersion(V1, row, T + DAY);
      const twoChanges = nextVersion(V1, withValue(good.values, EXIT, other(EXIT, valueAt(good.values, EXIT))), 'owner', T + DAY);
      const elsewhere = nextVersion(V1, withValue(V1.values, EXIT, other(EXIT, valueAt(V1.values, EXIT))), 'owner', T + DAY);
      const [lo, hi] = boundsOf(RISK);
      const otherValue = [lo, hi, (Number(lo) + Number(hi)) / 2].find((v) => v !== row.from && v !== row.to)!;
      const refused: readonly (readonly [string, number, ConfigVersion, 'bad-param' | 'row-missing']) [] = [
        ['not due yet', T + DAY - 1, good, 'bad-param'],
        ['a second tunable changed too, listed as one', T + DAY, { ...twoChanges, changed: [RISK] }, 'bad-param'],
        ['a second tunable changed too, listed as two', T + DAY, twoChanges, 'bad-param'],
        ['another tunable than the row\'s', T + DAY, elsewhere, 'row-missing'],
        ['another value than the queued one', T + DAY, nextVersion(V1, withValue(V1.values, RISK, Math.floor(Number(otherValue))), 'owner', T + DAY), 'bad-param'],
        ['a changed list that says more', T + DAY, { ...good, changed: [RISK, EXIT] }, 'bad-param'],
        ['a changed list that says less', T + DAY, { ...good, changed: [] }, 'bad-param'],
        ['another author than the row\'s source', T + DAY, { ...good, author: 'rollback' }, 'bad-param'],
        ['not the next version', T + DAY, { ...good, id: 3 }, 'bad-param'],
        ['an undo to anything but the active version', T + DAY, { ...good, undoTo: null }, 'bad-param'],
        ['a timestamp that is not one', Number.NaN, good, 'bad-param'],
        // review R, risk 3 and security 2: dated between the active version and now
        ['dated before the active version', T + DAY, { ...good, createdAt: T - 1 }, 'bad-param'],
        ['dated after now', T + DAY, { ...good, createdAt: T + DAY + 1 }, 'bad-param'],
      ];
      for (const [what, now, version, code] of refused) {
        db.transaction((tx) => {
          storageError(() => applyDueStep(tx, now, version), code);
        });
        assert.equal(count(db, 'audit_log'), 2n, what);
        assert.equal(count(db, 'config_versions'), 1n, what);
        assert.equal(count(db, 'pending_changes'), 1n, what);
      }
    });
  });

  it('a clock behind the active version dates the due step as the active one: never earlier, and never later than both (review R)', () => {
    withConfig((db) => {
      const row = pendingOf(EXIT, T);
      queue(db, row);
      // the owner set another tunable two days on; then the clock stepped back to just after the row came due
      const v2 = nextVersion(V1, withValue(V1.values, RISK, other(RISK, valueAt(V1.values, RISK))), 'owner', T + 2 * DAY);
      db.transaction((tx) => writeOwnerConfig(tx, T + 2 * DAY, 'owner-telegram', 'owner:set', { version: v2, pending: [], cancelled: [] }));
      const now = T + DAY + 1;
      const step = dueVersion(v2, row, T + 2 * DAY);
      storageError(() => db.transaction((tx) => applyDueStep(tx, now, { ...step, createdAt: now })), 'bad-param');
      storageError(() => db.transaction((tx) => applyDueStep(tx, now, { ...step, createdAt: T + 2 * DAY + 1 })), 'bad-param');
      assert.equal(db.transaction((tx) => applyDueStep(tx, now, step)), 3);
      assert.deepEqual(readConfigHistory(db).map((v) => v.createdAt), [T, T + 2 * DAY, T + 2 * DAY]);
    });
  });

  it('refuses a row whose tunable no longer holds the value it was made from (stale: the engine drops it instead)', () => {
    withConfig((db) => {
      // made from a value the tunable does not hold: the owner's commands cancel a row when they set its tunable (RISK_POLICY
      // s.12), so such a row is written here behind the writers' back (one from an older bot, or changed by hand)
      const held = valueAt(V1.values, RISK);
      const [lo, hi] = boundsOf(RISK);
      const from = other(RISK, held);
      const to = [lo, hi, Math.floor((Number(lo) + Number(hi)) / 2)].find((v) => v !== held && v !== from)!;
      const row: PendingChange = Object.freeze({ path: RISK, from, to, source: 'owner', requestedAt: T, applyAt: T + DAY });
      db.transaction((tx) =>
        tx.run(
          'INSERT INTO pending_changes (path, from_value, to_value, source, requested_at, apply_at) VALUES (?, ?, ?, ?, ?, ?)',
          row.path,
          String(row.from),
          String(row.to),
          row.source,
          BigInt(row.requestedAt),
          BigInt(row.applyAt),
        ),
      );
      const staleStep = dueVersion(V1, row, T + DAY);
      assert.match(storageError(() => db.transaction((tx) => applyDueStep(tx, T + DAY, staleStep)), 'bad-param').detail, /no longer holds/);
      assert.equal(count(db, 'config_versions'), 1n);
      db.transaction((tx) => dropDuePending(tx, T + DAY, RISK));
      assert.deepEqual(readPendingChanges(db), []);
      assert.deepEqual(audits(db).at(-1), `engine engine:drop-pending {"path":"${RISK}"}`);
    });
  });

  it('drops a due row with its own audit row; a row not due yet, or not there, is refused with nothing written', () => {
    withConfig((db) => {
      queue(db, pendingOf(EXIT, T));
      storageError(() => db.transaction((tx) => dropDuePending(tx, T + DAY - 1, EXIT)), 'bad-param');
      storageError(() => db.transaction((tx) => dropDuePending(tx, T + DAY, RISK)), 'row-missing');
      storageError(() => db.transaction((tx) => dropDuePending(tx, T + DAY, 'risk.x y' as TunablePath)), 'bad-param');
      assert.equal(count(db, 'audit_log'), 2n);
      db.transaction((tx) => dropDuePending(tx, T + DAY, EXIT));
      assert.equal(count(db, 'pending_changes'), 0n);
      assert.equal(count(db, 'config_versions'), 1n); // dropping a waiting loosening never makes a version
    });
  });

  it('nothing here needs a version 1 that is not there: the due step and the drop refuse without one', () => {
    const db = migratedDb();
    try {
      storageError(() => db.transaction((tx) => applyDueStep(tx, T + DAY, nextVersion(V1, withValue(V1.values, RISK, other(RISK, valueAt(V1.values, RISK))), 'owner', T + DAY))), 'row-missing');
      assert.equal(count(db, 'audit_log'), 0n);
    } finally {
      db.close();
    }
  });
});
