// The audit log (STORAGE_DESIGN.md s.1 and s.12; reviews P): every row is appended in order by the
// repository, which names the next id, links the hash before it and computes its own sha256, so the
// chain can be checked from the first row to the last at start-up (step 6d). The engine writes only
// engine rows; the owner's and the server's writers live in their own files (repo-owner.ts,
// repo-server.ts), which only the owner's commands may import (architecture rule). Written before
// src/storage/repo-audit.ts and src/storage/audit-chain.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { AUDIT_GENESIS, auditHash } from '../../../src/storage/audit-chain.ts';
import * as auditFile from '../../../src/storage/repo-audit.ts';
import { ENGINE_AUDIT_ACTIONS, appendEngineAudit, newestAuditId, readAuditRow, verifyAuditChain, type EngineAuditAction } from '../../../src/storage/repo-audit.ts';
import type { Db } from '../../../src/storage/sqlite.ts';
import { TEST_NOW, count, migratedDb, removeDir, storageError, tamper, tempDir } from './helpers.ts';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const fakeKey = Array.from({ length: 88 }, (_v, i) => B58[(i * 7 + 3) % 58]).join('');

function withDb(fn: (db: Db) => void): void {
  const db = migratedDb();
  try {
    fn(db);
  } finally {
    db.close();
  }
}

const rows = (db: Db): Record<string, unknown>[] =>
  db.all('SELECT id, at, actor, action, detail_json, prev_hash, hash FROM audit_log ORDER BY id').map((r) => ({ ...r }));

describe('the audit readers of step 6d-3: one row by id, and the newest time (s.16.3)', () => {
  it('exports the engine writer, the readers and the action list, and nothing else', () => {
    assert.deepEqual(Object.keys(auditFile).sort(), ['ENGINE_AUDIT_ACTIONS', 'appendEngineAudit', 'newestAuditId', 'readAuditRow', 'verifyAuditChain']);
  });

  it('reads one row as stored: its id, time, actor, action, detail and hash; null for an id it does not hold', () => {
    withDb((db) => {
      assert.equal(readAuditRow(db, 1), null);
      db.transaction((tx) => appendEngineAudit(tx, TEST_NOW, 'engine:kill-set', { source: 'sentinel' }));
      db.transaction((tx) => appendEngineAudit(tx, TEST_NOW + 7, 'engine:halt-set', { reason: 'disk-db' }));
      const second = readAuditRow(db, 2);
      assert.deepEqual(second, { id: 2, at: TEST_NOW + 7, actor: 'engine', action: 'engine:halt-set', detail: { reason: 'disk-db' }, hash: rows(db)[1]?.['hash'] });
      assert.ok(second !== null && Object.isFrozen(second) && Object.isFrozen(second.detail));
      assert.equal(readAuditRow(db, 3), null);
      assert.equal(verifyAuditChain(db).newestAt, TEST_NOW + 7);
      for (const bad of [0, -1, 1.5, Number.NaN]) {
        storageError(() => readAuditRow(db, bad), 'bad-param');
      }
    });
  });
});

describe('the audit chain: ids in order, each row linked to the one before, its own sha256', () => {
  it('appends rows 1, 2, 3, each naming the hash before it (zeros first) and a hash of exactly its own fields', () => {
    withDb((db) => {
      assert.equal(newestAuditId(db), 0);
      assert.equal(db.transaction((tx) => appendEngineAudit(tx, TEST_NOW, 'engine:kill-set', { source: 'sentinel' })), 1);
      assert.equal(db.transaction((tx) => appendEngineAudit(tx, TEST_NOW - 5, 'engine:halt-set', { reason: 'disk-db' })), 2); // the clock may step back
      assert.equal(db.transaction((tx) => appendEngineAudit(tx, TEST_NOW, 'engine:apply-due')), 3);
      assert.equal(newestAuditId(db), 3);
      const all = rows(db);
      assert.deepEqual(all.map((r) => r['detail_json']), ['{"source":"sentinel"}', '{"reason":"disk-db"}', '{}']);
      assert.deepEqual(all.map((r) => r['actor']), ['engine', 'engine', 'engine']);
      let prev = AUDIT_GENESIS;
      for (const r of all) {
        assert.equal(r['prev_hash'], prev);
        const text = `fomo-audit-v1\n${prev}\n${String(r['id'])}\n${String(r['at'])}\n${String(r['actor'])}\n${String(r['action'])}\n${String(r['detail_json'])}`;
        const expected = createHash('sha256').update(text, 'utf8').digest('hex');
        assert.equal(r['hash'], expected);
        assert.equal(auditHash(prev, Number(r['id']), Number(r['at']), String(r['actor']), String(r['action']), String(r['detail_json'])), expected);
        prev = expected;
      }
      assert.deepEqual(verifyAuditChain(db), { rows: 3, newestId: 3, newestHash: prev, newestAt: TEST_NOW });
    });
  });

  it('the hash covers every field: changing any one of them changes it', () => {
    const base = auditHash(AUDIT_GENESIS, 1, TEST_NOW, 'engine', 'engine:kill-set', '{}');
    const variants = [
      auditHash('1'.repeat(64), 1, TEST_NOW, 'engine', 'engine:kill-set', '{}'),
      auditHash(AUDIT_GENESIS, 2, TEST_NOW, 'engine', 'engine:kill-set', '{}'),
      auditHash(AUDIT_GENESIS, 1, TEST_NOW + 1, 'engine', 'engine:kill-set', '{}'),
      auditHash(AUDIT_GENESIS, 1, TEST_NOW, 'ai', 'engine:kill-set', '{}'),
      auditHash(AUDIT_GENESIS, 1, TEST_NOW, 'engine', 'engine:halt-set', '{}'),
      auditHash(AUDIT_GENESIS, 1, TEST_NOW, 'engine', 'engine:kill-set', '{"a":1}'),
    ];
    assert.equal(new Set([base, ...variants]).size, variants.length + 1);
    assert.match(base, /^[0-9a-f]{64}$/);
  });

  it('the engine writes engine actions only, and its detail is plain data with no secret in it; a refusal writes nothing', () => {
    withDb((db) => {
      for (const action of ['owner:resume-peak', 'server:clear-kill', 'ai:propose', 'engine:anything-else', 'Engine:kill-set'] as unknown as EngineAuditAction[]) {
        storageError(() => db.transaction((tx) => appendEngineAudit(tx, TEST_NOW, action)), 'bad-param');
      }
      storageError(() => db.transaction((tx) => appendEngineAudit(tx, TEST_NOW, 'engine:halt-set', { key: fakeKey })), 'bad-param');
      storageError(() => db.transaction((tx) => appendEngineAudit(tx, TEST_NOW, 'engine:halt-set', { rpc: 'https://rpc.example.invalid' })), 'bad-param');
      storageError(() => db.transaction((tx) => appendEngineAudit(tx, TEST_NOW, 'engine:halt-set', { when: new Date(0) })), 'bad-param');
      storageError(() => db.transaction((tx) => appendEngineAudit(tx, Number.NaN, 'engine:halt-set')), 'bad-param');
      storageError(() => db.transaction((tx) => appendEngineAudit(tx, TEST_NOW, 'engine:halt-set', null as unknown as Record<string, unknown>)), 'bad-param');
      storageError(() => db.transaction((tx) => appendEngineAudit(tx, TEST_NOW, 'engine:halt-set', ['disk-db'] as unknown as Record<string, unknown>)), 'bad-param');
      assert.equal(count(db, 'audit_log'), 0n);
      assert.deepEqual([...ENGINE_AUDIT_ACTIONS].every((a) => a.startsWith('engine:')), true);
      assert.ok(Object.isFrozen(ENGINE_AUDIT_ACTIONS));
    });
  });

  it('a row rolled back with its transaction leaves no gap: the next row takes its id', () => {
    withDb((db) => {
      storageError(
        () =>
          db.transaction((tx) => {
            appendEngineAudit(tx, TEST_NOW, 'engine:kill-set', { source: 'cli' });
            return tx.run('INSERT INTO entry_counts (day, count) VALUES (?, ?)', '2026-11-16', 2n); // refused: a day starts at one
          }),
        'constraint',
      );
      assert.equal(db.transaction((tx) => appendEngineAudit(tx, TEST_NOW, 'engine:kill-set', { source: 'cli' })), 1);
      assert.equal(verifyAuditChain(db).rows, 1);
    });
  });
});

describe('verifyAuditChain: a broken log is found, naming the row and never a value', () => {
  // the three rows broken() writes, for the cases where the tampering also recomputes a hash (the
  // hash has no secret in it, so a forger can: then only the id order, the link or the actor list shows it)
  const h1 = auditHash(AUDIT_GENESIS, 1, TEST_NOW, 'engine', 'engine:kill-set', '{"source":"sentinel"}');
  const h2 = auditHash(h1, 2, TEST_NOW, 'engine', 'engine:halt-set', '{"reason":"disk-db"}');

  /** A file database with three good rows, then the tampering script run behind the bot's back. */
  function broken(script: string, code: 'audit-broken' | 'bad-cell' = 'audit-broken'): string {
    const dir = tempDir();
    try {
      const file = path.join(dir, 'bot.sqlite');
      const db = migratedDb(file);
      db.transaction((tx) => appendEngineAudit(tx, TEST_NOW, 'engine:kill-set', { source: 'sentinel' }));
      db.transaction((tx) => appendEngineAudit(tx, TEST_NOW, 'engine:halt-set', { reason: 'disk-db' }));
      db.transaction((tx) => appendEngineAudit(tx, TEST_NOW, 'engine:apply-due'));
      db.close();
      tamper(file, `DROP TRIGGER audit_log_no_update;\nDROP TRIGGER audit_log_no_delete;\nDROP TRIGGER audit_log_in_order;\n${script}`);
      const again = migratedDb(file);
      try {
        const e = storageError(() => verifyAuditChain(again), code);
        for (const value of ['disk-db', 'sentinel', 'deadbeef']) {
          assert.ok(!e.message.includes(value), value);
        }
        return e.detail;
      } finally {
        again.close();
      }
    } finally {
      removeDir(dir);
    }
  }

  it('an edited detail, action, actor or time no longer matches its hash', () => {
    assert.match(broken('UPDATE audit_log SET detail_json = \'{"reason":"x"}\' WHERE id = 2;'), /row 2/);
    assert.match(broken("UPDATE audit_log SET action = 'engine:apply-due' WHERE id = 1;"), /row 1/);
    assert.match(broken("UPDATE audit_log SET actor = 'ai', action = 'ai:propose' WHERE id = 3;"), /row 3/);
    assert.match(broken('UPDATE audit_log SET at = at + 1 WHERE id = 2;'), /row 2/);
  });

  it('a rewritten hash breaks the next link, a deleted row leaves a gap, a re-pointed link is found', () => {
    assert.match(broken(`UPDATE audit_log SET hash = '${'d'.repeat(64)}' WHERE id = 1;`), /row 1/);
    assert.match(broken('DELETE FROM audit_log WHERE id = 2;'), /row 3|after 1/);
    assert.match(broken(`UPDATE audit_log SET prev_hash = '${AUDIT_GENESIS}' WHERE id = 2;`), /row 2/);
    assert.match(broken('DELETE FROM audit_log WHERE id = 1;'), /row 2|first/);
  });

  it('a forger who also recomputes the hash is still found: by the id order, by the link, by the actor list', () => {
    // row 2 removed, row 3 re-linked to row 1 with a hash that fits: only the gap in the ids shows it
    const h3 = auditHash(h1, 3, TEST_NOW, 'engine', 'engine:apply-due', '{}');
    assert.match(broken(`DELETE FROM audit_log WHERE id = 2;\nUPDATE audit_log SET prev_hash = '${h1}', hash = '${h3}' WHERE id = 3;`), /row 3 follows row 1/);
    // row 2 pointed at the genesis with a hash that fits: only the link to row 1 shows it
    const h2g = auditHash(AUDIT_GENESIS, 2, TEST_NOW, 'engine', 'engine:halt-set', '{"reason":"disk-db"}');
    assert.match(broken(`UPDATE audit_log SET prev_hash = '${AUDIT_GENESIS}', hash = '${h2g}' WHERE id = 2;`), /row 2 does not name the hash/);
    // the last row's actor made up, with a hash that fits: only the list of actors shows it
    const h3x = auditHash(h2, 3, TEST_NOW, 'stranger', 'engine:apply-due', '{}');
    assert.match(broken(`PRAGMA ignore_check_constraints = 1;\nUPDATE audit_log SET actor = 'stranger', hash = '${h3x}' WHERE id = 3;`, 'bad-cell'), /column actor/);
  });

  it('an empty log is a whole chain of no rows', () => {
    withDb((db) => {
      assert.deepEqual(verifyAuditChain(db), { rows: 0, newestId: 0, newestHash: AUDIT_GENESIS, newestAt: null });
    });
  });
});
