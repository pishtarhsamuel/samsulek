// The flags, halts, strategy modes, entry bans and the day's entry count (STORAGE_DESIGN.md s.1.4,
// s.3 and s.12): the engine's reads come back typed and checked, a required row that is gone throws
// (never a default, contract 1), every write checks the rows it changed, and setting KILL or a halt
// writes its own audit row and names it (reviews P, P-R1). Lifting a halt and clearing KILL are not
// here: they belong to the owner's and the server's writers. Written before src/storage/repo-flags.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { STRATEGY_IDS } from '../../../src/core/ids.ts';
import * as flagsFile from '../../../src/storage/repo-flags.ts';
import {
  activeBans,
  addBan,
  countEntry,
  demote,
  entriesOn,
  PRUNE_MARGIN_MS,
  pruneBans,
  readFlags,
  readHalts,
  readModes,
  restartGate,
  setEntriesStopped,
  setHalt,
  setKill,
  setPaused,
} from '../../../src/storage/repo-flags.ts';
import { setStrategyMode } from '../../../src/storage/repo-owner.ts';
import type { Db } from '../../../src/storage/sqlite.ts';
import { TEST_NOW, count, migratedDb, removeDir, storageError, tamper, tempDir } from './helpers.ts';

const T = TEST_NOW;

function withDb(fn: (db: Db) => void): void {
  const db = migratedDb();
  try {
    fn(db);
  } finally {
    db.close();
  }
}

/** A migrated file database changed behind the bot's back, then opened again. */
function withTampered(script: string, fn: (db: Db) => void): void {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'bot.sqlite');
    migratedDb(file).close();
    tamper(file, script);
    const db = migratedDb(file);
    try {
      fn(db);
    } finally {
      db.close();
    }
  } finally {
    removeDir(dir);
  }
}

const audits = (db: Db): Record<string, unknown>[] =>
  db.all('SELECT id, actor, action, detail_json FROM audit_log ORDER BY id').map((r) => ({ ...r }));

describe('the engine\'s file: only what it may do', () => {
  it('exports no write that lifts anything or moves a safety time back: a new export here is a reviewed change (review Q, risk 1)', () => {
    assert.deepEqual(Object.keys(flagsFile).sort(), [
      'BAN_KINDS', 'KILL_SOURCES', 'MODE_CHANGERS', 'PRUNE_MARGIN_MS', 'STRATEGY_MODES',
      'activeBans', 'addBan', 'countEntry', 'demote', 'entriesOn', 'pruneBans', 'readFlags', 'readHalts', 'readModes',
      'restartGate', 'setEntriesStopped', 'setHalt', 'setKill', 'setPaused',
    ]);
  });
});

describe('flags: read typed, required, and changed one checked write at a time', () => {
  it('a new database has no KILL, no pause, entries not stopped and no halt ever cleared', () => {
    withDb((db) => {
      assert.deepEqual(readFlags(db), { kill: null, pausedAt: null, entriesStopped: false, haltClearedAt: null, updatedAt: 0 });
      assert.ok(Object.isFrozen(readFlags(db)));
    });
  });

  it('the flags row is required: gone, it throws row-missing instead of reading as "no KILL"', () => {
    withTampered('DROP TRIGGER flags_no_delete;\nDELETE FROM flags;', (db) => {
      storageError(() => readFlags(db), 'row-missing');
      storageError(() => db.transaction((tx) => setKill(tx, T, 'sentinel')), 'row-missing');
    });
  });

  it('a stored value the reader does not know is a bad cell, never a guess', () => {
    withTampered("DROP TRIGGER flags_kill_fixed;\nPRAGMA ignore_check_constraints = 1;\nUPDATE flags SET kill = 1, kill_at = 5, kill_source = 'email', kill_audit_id = 0;", (db) => {
      storageError(() => readFlags(db), 'bad-cell');
    });
    withTampered("PRAGMA ignore_check_constraints = 1;\nUPDATE flags SET entries_stopped = 2;", (db) => {
      storageError(() => readFlags(db), 'bad-cell');
    });
  });

  it('setKill writes its own audit row and names it; a second KILL changes nothing and writes nothing', () => {
    withDb((db) => {
      assert.equal(db.transaction((tx) => setKill(tx, T, 'sentinel')), true);
      assert.deepEqual(readFlags(db).kill, { at: T, source: 'sentinel', auditId: 1 });
      assert.deepEqual(audits(db), [{ id: 1n, actor: 'engine', action: 'engine:kill-set', detail_json: '{"source":"sentinel"}' }]);
      assert.equal(db.transaction((tx) => setKill(tx, T + 9, 'telegram')), false);
      assert.deepEqual(readFlags(db).kill, { at: T, source: 'sentinel', auditId: 1 }); // the first KILL keeps its time and source
      assert.equal(count(db, 'audit_log'), 1n);
      for (const source of ['email', 'Cli', ''] as unknown as ('cli' | 'telegram' | 'sentinel')[]) {
        storageError(() => db.transaction((tx) => setKill(tx, T, source)), 'bad-param');
      }
    });
  });

  it('a KILL written inside a transaction that fails is not saved, its audit row neither', () => {
    withDb((db) => {
      assert.throws(() =>
        db.transaction((tx) => {
          setKill(tx, T, 'cli');
          throw new Error('a later step failed');
        }),
      /a later step failed/);
      assert.equal(readFlags(db).kill, null);
      assert.equal(count(db, 'audit_log'), 0n);
    });
  });

  it('pause and the low-equity stop: set and cleared by the engine, each write reports whether it changed anything', () => {
    withDb((db) => {
      assert.equal(db.transaction((tx) => setPaused(tx, T)), true);
      assert.equal(db.transaction((tx) => setPaused(tx, T + 5)), false); // the first pause keeps its time
      assert.equal(readFlags(db).pausedAt, T);
      assert.equal(db.transaction((tx) => setEntriesStopped(tx, true, T)), true);
      assert.equal(db.transaction((tx) => setEntriesStopped(tx, true, T)), false);
      assert.equal(readFlags(db).entriesStopped, true);
      assert.equal(db.transaction((tx) => setEntriesStopped(tx, false, T + 1)), true);
      assert.equal(readFlags(db).entriesStopped, false);
      assert.equal(readFlags(db).updatedAt, T + 1);
      storageError(() => db.transaction((tx) => setEntriesStopped(tx, 1 as unknown as boolean, T)), 'bad-param');
      assert.equal(count(db, 'audit_log'), 0n);
    });
  });
});

describe('halts: set once with their own audit row; lifting is not the engine\'s', () => {
  it('setHalt writes an audit row and names it; a halt already set changes nothing and writes nothing', () => {
    withDb((db) => {
      assert.equal(db.transaction((tx) => setHalt(tx, 'disk-db', T)), true);
      assert.equal(db.transaction((tx) => setHalt(tx, 'peak-halt:paper', T + 1)), true);
      assert.equal(db.transaction((tx) => setHalt(tx, 'disk-db', T + 2)), false);
      assert.deepEqual(readHalts(db), [
        { reason: 'disk-db', setAt: T, setAuditId: 1 },
        { reason: 'peak-halt:paper', setAt: T + 1, setAuditId: 2 },
      ]);
      assert.deepEqual(audits(db).map((r) => r['detail_json']), ['{"reason":"disk-db"}', '{"reason":"peak-halt:paper"}']);
      assert.ok(Object.isFrozen(readHalts(db)) && Object.isFrozen(readHalts(db)[0]));
    });
  });

  it('a reason is a code, and one that looks like a secret is refused before anything is written', () => {
    withDb((db) => {
      for (const reason of ['Disk DB', '', 'x'.repeat(65), 'ab'.repeat(32), 'a b']) {
        storageError(() => db.transaction((tx) => setHalt(tx, reason, T)), 'bad-param');
      }
      assert.equal(count(db, 'halt_reasons'), 0n);
      assert.equal(count(db, 'audit_log'), 0n);
    });
  });

  it('readHalts is empty on a new database and lists every halt in a fixed order', () => {
    withDb((db) => {
      assert.deepEqual(readHalts(db), []);
      for (const reason of ['sanity-max:paper', 'clock-backwards:live', 'disk-db']) {
        db.transaction((tx) => setHalt(tx, reason, T));
      }
      assert.deepEqual(readHalts(db).map((h) => h.reason), ['clock-backwards:live', 'disk-db', 'sanity-max:paper']);
    });
  });
});

describe('strategy modes: three rows, all required; the engine may only demote and restart the gate', () => {
  it('a new database has every strategy off (decision D5), set by the migration', () => {
    withDb((db) => {
      const modes = readModes(db);
      assert.deepEqual(Object.keys(modes).sort(), [...STRATEGY_IDS].sort());
      for (const id of STRATEGY_IDS) {
        assert.deepEqual(modes[id], { mode: 'off', changedAt: 0, changedBy: 'migration', gateSince: 0 });
      }
      assert.ok(Object.isFrozen(modes) && Object.isFrozen(modes.crowdflow));
    });
  });

  it('a missing strategy row throws row-missing (a strategy is never assumed off)', () => {
    withTampered("DROP TRIGGER strategy_modes_no_delete;\nDELETE FROM strategy_modes WHERE strategy = 'launch';", (db) => {
      storageError(() => readModes(db), 'row-missing');
    });
  });

  it('demote moves a live strategy to paper with its own audit row and a fresh gate; one that is not live is left alone and nothing is written', () => {
    withDb((db) => {
      assert.equal(db.transaction((tx) => demote(tx, 'momentum', T)), false);
      assert.equal(count(db, 'audit_log'), 0n);
      db.transaction((tx) => setStrategyMode(tx, T, 'owner-server', 'momentum', 'paper'));
      db.transaction((tx) => setStrategyMode(tx, T, 'owner-server', 'momentum', 'live'));
      assert.equal(readModes(db).momentum.mode, 'live');
      assert.equal(db.transaction((tx) => demote(tx, 'momentum', T + 1)), true);
      // RISK_POLICY s.10: a demoted strategy returns to live only through a fresh gate
      assert.deepEqual(readModes(db).momentum, { mode: 'paper', changedAt: T + 1, changedBy: 'auto-demote', gateSince: T + 1 });
      assert.deepEqual(audits(db).at(-1), { id: 3n, actor: 'engine', action: 'engine:demote', detail_json: '{"strategy":"momentum"}' });
      assert.equal(db.transaction((tx) => demote(tx, 'momentum', T + 2)), false);
      assert.equal(count(db, 'audit_log'), 3n);
      storageError(() => db.transaction((tx) => demote(tx, 'copy' as unknown as 'momentum', T)), 'bad-param');
    });
  });

  it('restartGate moves a strategy\'s gate start later and nothing else; an earlier time keeps the later start (review Q, risk 2)', () => {
    withDb((db) => {
      db.transaction((tx) => restartGate(tx, 'launch', T));
      assert.deepEqual(readModes(db).launch, { mode: 'off', changedAt: 0, changedBy: 'migration', gateSince: T });
      db.transaction((tx) => restartGate(tx, 'launch', 0)); // a clock that stepped back, or a stale time
      assert.equal(readModes(db).launch.gateSince, T);
      db.transaction((tx) => restartGate(tx, 'launch', T + 5));
      assert.equal(readModes(db).launch.gateSince, T + 5);
      storageError(() => db.transaction((tx) => restartGate(tx, 'copy' as unknown as 'launch', T)), 'bad-param');
    });
  });
});

describe('entry bans: cooldowns and pauses end, bans stay; only expired ones are pruned', () => {
  it('a cooldown is added, lengthened by a later one, never shortened by an earlier one', () => {
    withDb((db) => {
      db.transaction((tx) => addBan(tx, { kind: 'mint-cooldown', key: 'MintA', until: T + 100, reason: 'exit:cooldown', at: T }));
      db.transaction((tx) => addBan(tx, { kind: 'mint-cooldown', key: 'MintA', until: T + 50, reason: 'exit:cooldown', at: T + 1 }));
      assert.equal(activeBans(db, T)[0]?.until, T + 100);
      db.transaction((tx) => addBan(tx, { kind: 'mint-cooldown', key: 'MintA', until: T + 200, reason: 'exit:cooldown', at: T + 2 }));
      assert.equal(activeBans(db, T)[0]?.until, T + 200);
      assert.equal(count(db, 'entry_bans'), 1n);
    });
  });

  it('a permanent ban stays as it is; adding it again changes nothing', () => {
    withDb((db) => {
      db.transaction((tx) => addBan(tx, { kind: 'mint-ban', key: 'MintB', until: null, reason: 'exit:rug', at: T }));
      db.transaction((tx) => addBan(tx, { kind: 'mint-ban', key: 'MintB', until: null, reason: 'exit:other', at: T + 1 }));
      assert.deepEqual(activeBans(db, T + 10 ** 9), [{ kind: 'mint-ban', key: 'MintB', until: null, reason: 'exit:rug', setAt: T }]);
    });
  });

  it('the kind decides whether a ban ends: a cooldown needs an end, a ban has none; strategy pauses name a strategy; keys are ids', () => {
    withDb((db) => {
      const bad = [
        { kind: 'mint-cooldown', key: 'MintA', until: null, reason: 'exit:cooldown', at: T },
        { kind: 'mint-ban', key: 'MintA', until: T + 1, reason: 'exit:rug', at: T },
        { kind: 'strategy-pause', key: 'copy', until: T + 1, reason: 'losses:three', at: T },
        { kind: 'mint-cooldown', key: 'Mint A', until: T + 1, reason: 'exit:cooldown', at: T },
        { kind: 'whitelist', key: 'MintA', until: null, reason: 'x', at: T },
        { kind: 'mint-cooldown', key: 'MintA', until: T + 1, reason: 'Not A Code', at: T },
      ] as unknown as Parameters<typeof addBan>[1][];
      for (const ban of bad) {
        storageError(() => db.transaction((tx) => addBan(tx, ban)), 'bad-param');
      }
      assert.equal(count(db, 'entry_bans'), 0n);
    });
  });

  it('activeBans lists what still blocks at `now`; pruneBans deletes only cooldowns and pauses that ended a day ago, never a ban', () => {
    withDb((db) => {
      const DAY = PRUNE_MARGIN_MS;
      assert.equal(DAY, 86_400_000);
      db.transaction((tx) => {
        addBan(tx, { kind: 'mint-cooldown', key: 'MintA', until: T + 10, reason: 'exit:cooldown', at: T });
        addBan(tx, { kind: 'mint-cooldown', key: 'MintC', until: T + 30, reason: 'exit:cooldown', at: T });
        addBan(tx, { kind: 'strategy-pause', key: 'momentum', until: T + 10, reason: 'losses:three', at: T });
        addBan(tx, { kind: 'creator-ban', key: 'CreatorX', until: null, reason: 'safety:creator', at: T });
      });
      assert.deepEqual(activeBans(db, T + 9).map((b) => `${b.kind}/${b.key}`), ['creator-ban/CreatorX', 'mint-cooldown/MintA', 'mint-cooldown/MintC', 'strategy-pause/momentum']);
      assert.deepEqual(activeBans(db, T + 10).map((b) => `${b.kind}/${b.key}`), ['creator-ban/CreatorX', 'mint-cooldown/MintC']); // ends at until
      assert.equal(db.transaction((tx) => pruneBans(tx, T + 10)), 0); // ended, but kept a day
      // a clock that jumped ahead by less than a day erases nothing that is still running (review Q, risk 3)
      assert.equal(db.transaction((tx) => pruneBans(tx, T + 23 * 3_600_000)), 0);
      assert.equal(db.transaction((tx) => pruneBans(tx, T + 10 + DAY - 1)), 0);
      assert.equal(db.transaction((tx) => pruneBans(tx, T + 10 + DAY)), 2);
      assert.equal(db.transaction((tx) => pruneBans(tx, T + 30 + DAY)), 1);
      assert.deepEqual(activeBans(db, T + 10 ** 9).map((b) => b.kind), ['creator-ban']);
      assert.equal(db.transaction((tx) => pruneBans(tx, 5)), 0); // near 1970: the margin stops at 0
      storageError(() => db.transaction((tx) => pruneBans(tx, Number.NaN)), 'bad-param');
    });
  });
});

describe('the day\'s entry count: counted in the same transaction, up to the hard limit', () => {
  it('entriesOn is 0 for a day without entries; countEntry returns the new count, day by day', () => {
    withDb((db) => {
      assert.equal(entriesOn(db, '2026-11-16'), 0);
      assert.equal(db.transaction((tx) => countEntry(tx, '2026-11-16')), 1);
      assert.equal(db.transaction((tx) => countEntry(tx, '2026-11-16')), 2);
      assert.equal(db.transaction((tx) => countEntry(tx, '2026-11-17')), 1);
      assert.equal(entriesOn(db, '2026-11-16'), 2);
      assert.equal(entriesOn(db, '2026-11-17'), 1);
      for (const day of ['2026-02-30', '16-11-2026', '']) {
        storageError(() => entriesOn(db, day), 'bad-param');
        storageError(() => db.transaction((tx) => countEntry(tx, day)), 'bad-param');
      }
    });
  });

  it('the 13th entry of a day is refused by the database and nothing of that transaction is kept', () => {
    withDb((db) => {
      for (let n = 1; n <= 12; n += 1) {
        assert.equal(db.transaction((tx) => countEntry(tx, '2026-11-16')), n);
      }
      storageError(() => db.transaction((tx) => countEntry(tx, '2026-11-16')), 'constraint');
      assert.equal(entriesOn(db, '2026-11-16'), 12);
    });
  });
});
