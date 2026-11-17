// The owner's and the server's writers (STORAGE_DESIGN.md s.12.1; reviews P): each command first
// writes the owner's own audit row, as the newest row of all, then makes the change the database
// lets through only right after that row. They live in their own files, which only the owner's
// commands may import (the Telegram path after the owner check, the server's terminal): the engine
// can never write an owner or server row (architecture rule). Written before src/storage/repo-owner.ts
// and src/storage/repo-server.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFlags, readHalts, readModes, setHalt, setKill, setPaused } from '../../../src/storage/repo-flags.ts';
import { OWNER_AUDIT_ACTIONS, appendOwnerAudit, resumeHalt, setStrategyMode, unpause, type OwnerAuditAction } from '../../../src/storage/repo-owner.ts';
import { SERVER_AUDIT_ACTIONS, appendServerAudit, clearKill, resetHalts, type ServerAuditAction } from '../../../src/storage/repo-server.ts';
import { verifyAuditChain } from '../../../src/storage/repo-audit.ts';
import type { Db } from '../../../src/storage/sqlite.ts';
import { TEST_NOW, count, migratedDb, storageError } from './helpers.ts';

const T = TEST_NOW;

function withDb(fn: (db: Db) => void): void {
  const db = migratedDb();
  try {
    fn(db);
  } finally {
    db.close();
  }
}

const audits = (db: Db): string[] => db.all('SELECT actor, action FROM audit_log ORDER BY id').map((r) => `${String(r['actor'])} ${String(r['action'])}`);

describe('the owner\'s writer: owner actions only, by the owner from Telegram or at the server', () => {
  it('appends owner rows with the actor of the channel the command came from', () => {
    withDb((db) => {
      assert.equal(db.transaction((tx) => appendOwnerAudit(tx, T, 'owner-telegram', 'owner:set', { path: 'risk.perTradeBps' })), 1);
      assert.equal(db.transaction((tx) => appendOwnerAudit(tx, T, 'owner-server', 'owner:rollback')), 2);
      assert.deepEqual(audits(db), ['owner-telegram owner:set', 'owner-server owner:rollback']);
      assert.equal(verifyAuditChain(db).rows, 2);
    });
  });

  it('refuses another prefix, an unknown action or an actor that is not the owner; nothing is written', () => {
    withDb((db) => {
      for (const action of ['server:clear-kill', 'engine:kill-set', 'owner:anything', 'owner:SET'] as unknown as OwnerAuditAction[]) {
        storageError(() => db.transaction((tx) => appendOwnerAudit(tx, T, 'owner-telegram', action)), 'bad-param');
      }
      for (const actor of ['engine', 'ai', 'owner'] as unknown as ('owner-telegram' | 'owner-server')[]) {
        storageError(() => db.transaction((tx) => appendOwnerAudit(tx, T, actor, 'owner:set')), 'bad-param');
      }
      assert.equal(count(db, 'audit_log'), 0n);
      assert.ok([...OWNER_AUDIT_ACTIONS].every((a) => a.startsWith('owner:')));
      assert.ok(Object.isFrozen(OWNER_AUDIT_ACTIONS));
    });
  });

  it('resumeHalt lifts the paper peak halt or the paper streak halt right after the owner\'s row, and records when halts were cleared', () => {
    withDb((db) => {
      for (const reason of ['peak-halt:paper', 'peak-halt:live', 'daily-stop-twice:paper', 'daily-stop-twice:live']) {
        db.transaction((tx) => setHalt(tx, reason, T));
      }
      assert.equal(db.transaction((tx) => resumeHalt(tx, T + 1, 'owner-telegram', 'peak')), true);
      assert.deepEqual(readHalts(db).map((h) => h.reason), ['daily-stop-twice:live', 'daily-stop-twice:paper', 'peak-halt:live']);
      assert.equal(readFlags(db).haltClearedAt, T + 1);
      assert.equal(db.transaction((tx) => resumeHalt(tx, T + 2, 'owner-server', 'streak')), true);
      assert.deepEqual(readHalts(db).map((h) => h.reason), ['daily-stop-twice:live', 'peak-halt:live']); // live only at the server's reset (D4)
      assert.deepEqual(audits(db).slice(-2), ['owner-telegram owner:resume-peak', 'owner-server owner:resume-streak']);
      // nothing to resume: nothing is written
      assert.equal(db.transaction((tx) => resumeHalt(tx, T + 3, 'owner-telegram', 'peak')), false);
      assert.equal(count(db, 'audit_log'), 6n);
      storageError(() => db.transaction((tx) => resumeHalt(tx, T, 'owner-telegram', 'all' as unknown as 'peak')), 'bad-param');
    });
  });

  it('unpause clears the owner\'s pause with the owner\'s row; with no pause it writes nothing', () => {
    withDb((db) => {
      assert.equal(db.transaction((tx) => unpause(tx, T, 'owner-telegram')), false);
      db.transaction((tx) => setPaused(tx, T));
      assert.equal(db.transaction((tx) => unpause(tx, T + 1, 'owner-telegram')), true);
      assert.equal(readFlags(db).pausedAt, null);
      assert.deepEqual(audits(db), ['owner-telegram owner:unpause']);
    });
  });

  it('setStrategyMode records the owner\'s choice: off, paper, and live only through /golive, only from paper; leaving live starts the gate again', () => {
    withDb((db) => {
      // off straight to live is refused, with nothing written (review Q, risk 6)
      storageError(() => db.transaction((tx) => setStrategyMode(tx, T, 'owner-telegram', 'crowdflow', 'live')), 'bad-param');
      assert.equal(count(db, 'audit_log'), 0n);
      db.transaction((tx) => setStrategyMode(tx, T, 'owner-telegram', 'crowdflow', 'paper'));
      assert.deepEqual(readModes(db).crowdflow, { mode: 'paper', changedAt: T, changedBy: 'owner-paper', gateSince: 0 });
      db.transaction((tx) => setStrategyMode(tx, T + 1, 'owner-telegram', 'crowdflow', 'live'));
      assert.deepEqual(readModes(db).crowdflow, { mode: 'live', changedAt: T + 1, changedBy: 'owner-golive', gateSince: 0 });
      storageError(() => db.transaction((tx) => setStrategyMode(tx, T + 1, 'owner-telegram', 'crowdflow', 'live')), 'bad-param'); // live again: not from paper
      db.transaction((tx) => setStrategyMode(tx, T + 2, 'owner-server', 'crowdflow', 'off'));
      assert.deepEqual(readModes(db).crowdflow, { mode: 'off', changedAt: T + 2, changedBy: 'owner-off', gateSince: T + 2 });
      db.transaction((tx) => setStrategyMode(tx, T + 3, 'owner-server', 'crowdflow', 'paper'));
      assert.equal(readModes(db).crowdflow.gateSince, T + 2); // leaving off does not move it
      db.transaction((tx) => setStrategyMode(tx, T + 4, 'owner-server', 'crowdflow', 'live'));
      db.transaction((tx) => setStrategyMode(tx, T - 50, 'owner-server', 'crowdflow', 'paper')); // a clock that stepped back
      assert.deepEqual(readModes(db).crowdflow, { mode: 'paper', changedAt: T - 50, changedBy: 'owner-paper', gateSince: T + 2 });
      assert.deepEqual(audits(db), [
        'owner-telegram owner:paper', 'owner-telegram owner:golive', 'owner-server owner:off', 'owner-server owner:paper', 'owner-server owner:golive', 'owner-server owner:paper',
      ]);
      storageError(() => db.transaction((tx) => setStrategyMode(tx, T, 'owner-telegram', 'crowdflow', 'turbo' as unknown as 'off')), 'bad-param');
      storageError(() => db.transaction((tx) => setStrategyMode(tx, T, 'owner-telegram', 'copy' as unknown as 'launch', 'off')), 'bad-param');
      assert.equal(count(db, 'audit_log'), 6n);
    });
  });
});

describe('the server\'s writer: what only the owner at the server may do', () => {
  it('appends server rows only, always as the owner at the server', () => {
    withDb((db) => {
      assert.equal(db.transaction((tx) => appendServerAudit(tx, T, 'server:reset-halt')), 1);
      for (const action of ['owner:set', 'engine:kill-set', 'server:anything'] as unknown as ServerAuditAction[]) {
        storageError(() => db.transaction((tx) => appendServerAudit(tx, T, action)), 'bad-param');
      }
      assert.deepEqual(audits(db), ['owner-server server:reset-halt']);
      assert.ok([...SERVER_AUDIT_ACTIONS].every((a) => a.startsWith('server:')));
      assert.ok(Object.isFrozen(SERVER_AUDIT_ACTIONS));
    });
  });

  it('clearKill writes the owner\'s row and then clears KILL; with no KILL set it refuses and writes nothing', () => {
    withDb((db) => {
      storageError(() => db.transaction((tx) => clearKill(tx, T)), 'row-count');
      assert.equal(count(db, 'audit_log'), 0n);
      db.transaction((tx) => setKill(tx, T, 'telegram'));
      db.transaction((tx) => clearKill(tx, T + 1));
      assert.equal(readFlags(db).kill, null);
      assert.deepEqual(audits(db), ['engine engine:kill-set', 'owner-server server:clear-kill']);
      // a new KILL needs a new clear
      db.transaction((tx) => setKill(tx, T + 2, 'sentinel'));
      assert.deepEqual(readFlags(db).kill, { at: T + 2, source: 'sentinel', auditId: 3 });
    });
  });

  it('a refused command writes nothing even when its caller catches the refusal inside the transaction (preconditions before the first write)', () => {
    withDb((db) => {
      const caught = (fn: () => unknown): void => {
        try {
          fn();
        } catch {
          // a careless caller carries on and commits
        }
      };
      db.transaction((tx) => {
        caught(() => clearKill(tx, T)); // no KILL to clear
        caught(() => appendServerAudit(tx, T, 'owner:set' as unknown as ServerAuditAction));
        caught(() => appendOwnerAudit(tx, T, 'engine' as unknown as 'owner-server', 'owner:set'));
        return resetHalts(tx, T) + Number(resumeHalt(tx, T, 'owner-telegram', 'peak')) + Number(unpause(tx, T, 'owner-telegram'));
      });
      assert.equal(count(db, 'audit_log'), 0n);
    });
  });

  it('a clear in the same millisecond as the KILL still works: the audit id, not the clock, gives the order (review P-R1)', () => {
    withDb((db) => {
      db.transaction((tx) => setKill(tx, T, 'cli'));
      db.transaction((tx) => clearKill(tx, T - 1000)); // even a clock that stepped back
      assert.equal(readFlags(db).kill, null);
    });
  });

  it('resetHalts lifts every halt, paper and live, records when, and returns how many; with none it writes nothing', () => {
    withDb((db) => {
      assert.equal(db.transaction((tx) => resetHalts(tx, T)), 0);
      assert.equal(count(db, 'audit_log'), 0n);
      for (const reason of ['peak-halt:live', 'disk-db', 'daily-stop-twice:live']) {
        db.transaction((tx) => setHalt(tx, reason, T));
      }
      assert.equal(db.transaction((tx) => resetHalts(tx, T + 1)), 3);
      assert.deepEqual(readHalts(db), []);
      assert.equal(readFlags(db).haltClearedAt, T + 1);
      assert.deepEqual(audits(db).at(-1), 'owner-server server:reset-halt');
      assert.equal(verifyAuditChain(db).rows, 4);
    });
  });

  it('KILL is not a halt: resetHalts leaves it, clearKill leaves the halts', () => {
    withDb((db) => {
      db.transaction((tx) => {
        setKill(tx, T, 'cli');
        return setHalt(tx, 'disk-db', T);
      });
      db.transaction((tx) => resetHalts(tx, T + 1));
      assert.notEqual(readFlags(db).kill, null);
      db.transaction((tx) => setHalt(tx, 'disk-db', T + 2));
      db.transaction((tx) => clearKill(tx, T + 3));
      assert.equal(readFlags(db).kill, null);
      assert.deepEqual(readHalts(db).map((h) => h.reason), ['disk-db']);
    });
  });
});
