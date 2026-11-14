// Migration 1, the step 6 schema (STORAGE_DESIGN.md s.2 and s.11; review O conditions for 6c):
// every table STRICT with TEXT amounts, the rows it starts with, the hard limits it copies, and
// each database tripwire tried at its boundary: the partial unique indexes, every trigger and
// every CHECK. The migration text itself is checked too: every RAISE carries one quoted message,
// every END closes a trigger body or a CASE, and no NOT IN can meet a NULL.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { HARD_CAPS } from '../../../src/config/caps.ts';
import { MAX_TIMESTAMP_MS } from '../../../src/core/time.ts';
import { LOOSENING_DELAY_MS } from '../../../src/config/changes.ts';
import { DEFAULT_TUNABLES, TUNABLE_PATHS, encodeTunables } from '../../../src/config/tunables.ts';
import { STRATEGY_IDS } from '../../../src/core/ids.ts';
import { emptyEquityState } from '../../../src/risk/daystate.ts';
import { PLAN_KINDS, PLAN_MODES, PLAN_URGENCIES } from '../../../src/risk/plan.ts';
import { boolCell, dayCell, intCell, lamportsCell, lamportsCellOrNull, msCellOrNull, signed, u64, u64AtMost, u64OrNull } from '../../../src/storage/codec.ts';
import { MIGRATIONS, migrate } from '../../../src/storage/migrations.ts';
import { SCHEMA_V1, SCHEMA_V1_COPIES, inList } from '../../../src/storage/schema-v1.ts';
import type { Db, SqlParam, Tx } from '../../../src/storage/sqlite.ts';
import { count, fileDb, memDb, rawDb, removeDir, storageError, tempDir } from './helpers.ts';

const NOW = Date.UTC(2026, 10, 14, 12);
const T = BigInt(NOW);
/** A clock that stepped a year forward or back (review P-R1). */
const YEAR = 365n * 86_400_000n;
const HEX = (n: number): string => n.toString(16).padStart(64, '0');
const VALUES = encodeTunables(DEFAULT_TUNABLES);

function fresh(): Db {
  const db = memDb();
  migrate(db, { now: () => NOW, backupDir: null, nodeVersion: 'v26.13.0', allowFresh: true });
  return db;
}

function withFresh(fn: (db: Db) => void): void {
  const db = fresh();
  try {
    fn(db);
  } finally {
    db.close();
  }
}

const write = (db: Db, sql: string, ...params: SqlParam[]): number => db.transaction((tx) => tx.run(sql, ...params));

/** The write is refused by a CHECK, an index or a trigger (whose message must match when given). */
function refused(db: Db, message: RegExp | null, sql: string, ...params: SqlParam[]): void {
  const e = storageError(() => write(db, sql, ...params), 'constraint');
  if (message !== null) {
    assert.match(e.detail, message);
  }
}

// ---------------------------------------------------------------- row builders (constant SQL)

const INSERT_VERSION = 'INSERT INTO config_versions (id, created_at, author, values_json, changed_json, undo_to) VALUES (?, ?, ?, ?, ?, ?)';
function version(db: Db, id: bigint, at = T, author = id === 1n ? 'default' : 'owner', changed = id === 1n ? '[]' : `["${TUNABLE_PATHS[0]}"]`, undoTo: bigint | null = id === 1n ? null : id - 1n): void {
  write(db, INSERT_VERSION, id, at, author, VALUES, changed, undoTo);
}

const INSERT_POSITION =
  'INSERT INTO positions (id, mint, strategy, mode, status, opened_at, max_spend, p95_exit_cost, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
function position(db: Db, id: string, opts: { mint?: string; mode?: string; status?: string; maxSpend?: string | null } = {}): void {
  write(db, INSERT_POSITION, id, opts.mint ?? `Mint${id}`, 'crowdflow', opts.mode ?? 'paper', opts.status ?? 'opening', T, opts.maxSpend === undefined ? '50000000' : opts.maxSpend, '400000', T);
}
const CLOSE_POSITION = "UPDATE positions SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?";
const closePosition = (db: Db, id: string): number => write(db, CLOSE_POSITION, T + 1n, T + 1n, id);

const INSERT_INTENT =
  'INSERT INTO intents (id, kind, mode, strategy, mint, position_id, size_hint, confidence_bps, exit_seq, fraction_bps, urgency, created_at, inputs_as_of, reasons_json, inputs_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const entryIntent = (db: Db, id: string, positionId: string): number =>
  write(db, INSERT_INTENT, id, 'entry', 'paper', 'crowdflow', `Mint${positionId}`, positionId, 'normal', 7_000n, null, null, null, T, T, '["signal:crowdflow"]', '{}');
const exitIntent = (db: Db, id: string, positionId: string, exitSeq: bigint): number =>
  write(db, INSERT_INTENT, id, 'exit', 'paper', null, `Mint${positionId}`, positionId, null, null, exitSeq, 10_000n, 'protective', T, T, '["exit:stop-loss"]', '{}');

const INSERT_DECISION =
  'INSERT INTO risk_decisions (intent_id, at, approved, stage, reasons_json, size, limited_by, binding, slot, config_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const decision = (db: Db, intentId: string, approved = true): number =>
  write(db, INSERT_DECISION, intentId, T, approved ? 1n : 0n, approved ? null : 'blocked', '[]', approved ? '50000000' : null, null, null, 1_000n, 1n);

const INSERT_TOKEN =
  'INSERT INTO approvals (token_id, intent_id, position_id, mode, kind, reduce_only, plan_hash, max_spend, min_out, quote_slot, expires_at_slot, issued_at, consumed_at, consumed_slot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
type TokenOpts = { maxSpend?: string; expires?: bigint; reduceOnly?: bigint; mode?: string };
const tokenArgs = (tokenId: string, intentId: string, positionId: string, kind = 'buy', opts: TokenOpts = {}): SqlParam[] => [
  tokenId, intentId, positionId, opts.mode ?? 'paper', kind, opts.reduceOnly ?? (kind === 'buy' ? 0n : 1n), HEX(1), opts.maxSpend ?? '50000000', '1000', 1_000n, opts.expires ?? 1_025n, T, null, null,
];
const token = (db: Db, tokenId: string, intentId: string, positionId: string, kind = 'buy', opts: TokenOpts = {}): number =>
  write(db, INSERT_TOKEN, ...tokenArgs(tokenId, intentId, positionId, kind, opts));
const CONSUME = 'UPDATE approvals SET consumed_at = ?, consumed_slot = ? WHERE token_id = ?';
const consume = (db: Db, tokenId: string, slot = 1_010n): number => write(db, CONSUME, T, slot, tokenId);

const INSERT_ORDER =
  'INSERT INTO orders (id, intent_id, token_id, position_id, mode, kind, status, plan_hash, plan_json, in_amount, min_out, max_spend, quote_slot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
type OrderOpts = { status?: string; planHash?: string; maxSpend?: string; minOut?: string; mode?: string; quoteSlot?: bigint; inAmount?: string };
function order(db: Db, id: string, intentId: string, tokenId: string, positionId: string, kind = 'buy', o: OrderOpts = {}): number {
  return write(db, INSERT_ORDER, id, intentId, tokenId, positionId, o.mode ?? 'paper', kind, o.status ?? 'approved', o.planHash ?? HEX(1), '{}', o.inAmount ?? '50000000', o.minOut ?? '1000', o.maxSpend ?? '50000000', o.quoteSlot ?? 1_000n, T, T);
}
const SET_ORDER_STATUS = 'UPDATE orders SET status = ?, updated_at = ? WHERE id = ?';
const orderStatus = (db: Db, id: string, status: string): number => write(db, SET_ORDER_STATUS, status, T + 1n, id);

/** A position with an approved entry, its consumed token and its buy order: n names them all. */
function buyChain(db: Db, n: number): void {
  position(db, `p${n}`);
  entryIntent(db, `i${n}`, `p${n}`);
  decision(db, `i${n}`);
  token(db, `t${n}`, `i${n}`, `p${n}`);
  consume(db, `t${n}`);
  order(db, `o${n}`, `i${n}`, `t${n}`, `p${n}`);
}

/** An exit of position p<n>: its intent, decision and consumed token (the order is left to the test). */
function exitChain(db: Db, n: number, seq: number, kind = 'sell'): string {
  const name = `${n}x${seq}`;
  exitIntent(db, `i${name}`, `p${n}`, BigInt(seq));
  decision(db, `i${name}`);
  token(db, `t${name}`, `i${name}`, `p${n}`, kind, { maxSpend: '200000' });
  consume(db, `t${name}`);
  return name;
}

const GENESIS = '0'.repeat(64);
const INSERT_AUDIT = 'INSERT INTO audit_log (id, at, actor, action, detail_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)';
const NEXT_AUDIT = 'SELECT coalesce(max(id), 0) + 1 AS id, coalesce((SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1), ?) AS prev FROM audit_log';
const actorOf = (action: string): string =>
  action.startsWith('server:') ? 'owner-server' : action.startsWith('owner:') ? 'owner-telegram' : action.startsWith('ai:') ? 'ai' : 'engine';
let hashSeq = 0;
/** The next audit row in order: the next id, the previous row's hash, a fresh fake hash. */
function auditTx(tx: Tx, action: string, at: bigint, actor = actorOf(action)): number {
  const next = tx.get(NEXT_AUDIT, GENESIS);
  hashSeq += 1;
  return tx.run(INSERT_AUDIT, next?.['id'] as bigint, at, actor, action, '{}', String(next?.['prev']), HEX(0x10_0000 + hashSeq));
}
const audit = (db: Db, action: string, at = T, actor = actorOf(action)): number => db.transaction((tx) => auditTx(tx, action, at, actor));

// ---------------------------------------------------------------- the migration text

/** Words outside quoted text, upper case. */
function bareWords(sql: string): string[] {
  const words: string[] = [];
  let quote = '';
  let word = '';
  for (const ch of `${sql} `) {
    if (quote !== '') {
      quote = ch === quote ? '' : quote;
      continue;
    }
    if (/[A-Za-z0-9_]/.test(ch)) {
      word += ch;
      continue;
    }
    if (word !== '') {
      words.push(word.toUpperCase());
      word = '';
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    }
  }
  return words;
}

/** Every BEGIN opens a trigger body and every END closes one or a CASE (review O, condition for 6c). */
function blockProblems(sql: string): string[] {
  const problems: string[] = [];
  const words = bareWords(sql);
  let trigger = false;
  let body = false;
  let cases = 0;
  words.forEach((w, i) => {
    if (w === 'CREATE' && words[i + 1] === 'TRIGGER') {
      trigger = true;
    } else if (w === 'BEGIN') {
      if (!trigger || body) {
        problems.push(`BEGIN outside a trigger at word ${i}`);
      }
      body = true;
    } else if (w === 'CASE') {
      cases += 1;
    } else if (w === 'END') {
      if (cases > 0) {
        cases -= 1;
      } else if (body) {
        body = false;
        trigger = false;
      } else {
        problems.push(`END outside a trigger body or a CASE at word ${i}`);
      }
    }
  });
  if (body || cases > 0) {
    problems.push('a block is not closed');
  }
  return problems;
}

/** Every RAISE is RAISE(ABORT, '<one quoted message>'): SQLite puts what it evaluates into the error text (review O). */
function raiseProblems(sql: string): string[] {
  const all = sql.match(/\bRAISE\s*\(/gi) ?? [];
  const literal = sql.match(/\bRAISE\s*\(\s*ABORT\s*,\s*'[^']*'\s*\)/gi) ?? [];
  return all.length === literal.length ? [] : [`${all.length - literal.length} RAISE without one quoted message`];
}

/** NULL NOT IN (...) is NULL, which a trigger's WHEN reads as false: never NOT IN after a sub-expression. */
function notInProblems(sql: string): string[] {
  return /\)\s*NOT\s+IN\b/i.test(sql) ? ['NOT IN after a parenthesized expression (a NULL would slip through)'] : [];
}

describe('migration 1: what it creates', () => {
  it('is the bot\'s only migration, applies to a fresh database after the version table, and is recorded', () => {
    assert.deepEqual(MIGRATIONS, [SCHEMA_V1]);
    assert.equal(SCHEMA_V1.version, 1);
    assert.equal(SCHEMA_V1.name, 'schema-v1');
    withFresh((db) => {
      const rows = db.all('SELECT version, name, sha256 FROM schema_migrations');
      assert.deepEqual(rows.map((r) => ({ ...r })), [{ version: 1n, name: 'schema-v1', sha256: createHash('sha256').update(SCHEMA_V1.sql, 'utf8').digest('hex') }]);
      const tables = db.all("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite%' ORDER BY name").map((r) => r['name']);
      assert.deepEqual(tables, [
        'approvals', 'audit_log', 'config_versions', 'day_state', 'entry_bans', 'entry_counts', 'equity_snapshots', 'flags',
        'halt_reasons', 'intents', 'ledger_accounts', 'orders', 'pending_changes', 'positions', 'risk_decisions', 'schema_migrations', 'strategy_modes',
      ]);
      assert.deepEqual(db.foreignKeyCheck(), []);
      assert.deepEqual(db.quickCheck(), []);
    });
  });

  it('never changes once released: its SQL is pinned by sha256', () => {
    assert.equal(createHash('sha256').update(SCHEMA_V1.sql, 'utf8').digest('hex'), '5f3c8cd49cbfcc718d4dc4d53cc3f52a08ed751556af5a838a5121ec117ed864');
    assert.ok(Object.isFrozen(SCHEMA_V1));
  });

  it('every table is STRICT, every column is TEXT or INTEGER, and every amount column is TEXT with its canonical check (review O, risk note 8)', () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, 'bot.sqlite');
      const db = fileDb(file);
      migrate(db, { now: () => NOW, backupDir: dir, nodeVersion: 'v26.13.0', allowFresh: true });
      db.close();
      const raw = rawDb(file, { readOnly: true });
      try {
        const tables = raw.prepare("SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite%'").all();
        assert.equal(tables.length, 17);
        const amounts: Record<string, string[]> = {
          pending_changes: ['from_value', 'to_value'],
          day_state: ['day_start', 'last_equity', 'peak', 'jump_held_equity', 'jump_ack_equity'],
          equity_snapshots: ['equity', 'stop_equity'],
          ledger_accounts: ['sol', 'total_deposits', 'total_withdrawals'],
          positions: ['max_spend', 'p95_exit_cost', 'token_units', 'cost_basis', 'rent_locked', 'realized', 'bought', 'sold', 'venue_fees', 'network_fees', 'failed_fees', 'tips', 'rent_paid', 'rent_refunded', 'tokens_bought', 'tokens_sold', 'exit_fees', 'basis_released'],
          risk_decisions: ['size'],
          approvals: ['max_spend', 'min_out'],
          orders: ['in_amount', 'min_out', 'max_spend'],
        };
        for (const t of tables) {
          const name = String(t['name']);
          assert.equal(t['strict'], 1n, `${name} is STRICT`);
          const columns = raw.prepare('SELECT name, type FROM pragma_table_xinfo(?)').all(name);
          for (const c of columns) {
            assert.ok(['TEXT', 'INTEGER'].includes(String(c['type'])), `${name}.${String(c['name'])} is ${String(c['type'])}`);
          }
          const sql = String(raw.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name)?.['sql']);
          for (const column of amounts[name] ?? []) {
            const type = columns.find((c) => c['name'] === column)?.['type'];
            assert.equal(type, 'TEXT', `${name}.${column}`);
            const checked = [u64(column), u64OrNull(column), signed(column), u64AtMost(column, SCHEMA_V1_COPIES.buyMaxSpendLamports)].some((f) => sql.includes(f));
            assert.ok(checked, `${name}.${column} carries a canonical amount check`);
          }
        }
      } finally {
        raw.close();
      }
    } finally {
      removeDir(dir);
    }
  });

  it('the text: every RAISE has one quoted message, every BEGIN and END pairs up in triggers or CASE, no NOT IN meets a NULL (review O)', () => {
    for (const m of MIGRATIONS) {
      assert.deepEqual([...raiseProblems(m.sql), ...blockProblems(m.sql), ...notInProblems(m.sql)], [], m.name);
    }
    // the checks catch what they are for
    assert.notDeepEqual(blockProblems('CREATE TABLE x1 (a TEXT) STRICT; END; BEGIN; CREATE TABLE x2 (a TEXT) STRICT;'), []);
    assert.notDeepEqual(blockProblems("CREATE TRIGGER t BEFORE DELETE ON x BEGIN SELECT RAISE(ABORT, 'no'); END; END;"), []);
    assert.deepEqual(blockProblems("CREATE TABLE x (a TEXT CHECK (CASE WHEN a = 'end' THEN 1 ELSE 1 END)) STRICT;"), []);
    assert.notDeepEqual(raiseProblems("CREATE TRIGGER t BEFORE INSERT ON x BEGIN SELECT RAISE(ABORT, 'leak:' || NEW.v); END;"), []);
    assert.notDeepEqual(raiseProblems("CREATE TRIGGER t BEFORE INSERT ON x BEGIN SELECT RAISE(ROLLBACK, 'no'); END;"), []);
    assert.notDeepEqual(notInProblems("WHEN (SELECT action FROM audit_log LIMIT 1) NOT IN ('a', 'b')"), []);
  });

  it('starts with the flags row, every strategy switched off (D5), and the empty day state for both modes; no ledger and no config version', () => {
    withFresh((db) => {
      assert.deepEqual({ ...db.get('SELECT * FROM flags') }, {
        id: 1n, kill: 0n, kill_at: null, kill_source: null, kill_audit_id: null, paused: 0n, paused_at: null, entries_stopped: 0n, halt_cleared_at: null, updated_at: 0n,
      });
      assert.deepEqual(
        db.all('SELECT strategy, mode, changed_by FROM strategy_modes ORDER BY strategy').map((r) => ({ ...r })),
        [...STRATEGY_IDS].sort().map((strategy) => ({ strategy, mode: 'off', changed_by: 'migration' })),
      );
      const empty = emptyEquityState();
      for (const mode of PLAN_MODES) {
        const r = db.get('SELECT * FROM day_state WHERE mode = ?', mode);
        assert.ok(r !== undefined, mode);
        assert.equal(r['day'], empty.day);
        assert.equal(lamportsCell(r, 'day_start'), empty.dayStart);
        assert.equal(lamportsCell(r, 'last_equity'), empty.lastEquity);
        assert.equal(lamportsCellOrNull(r, 'peak'), empty.peak);
        assert.equal(boolCell(r, 'jump_pending'), empty.jumpPending);
        assert.equal(empty.jumpHeld, null);
        assert.equal(lamportsCellOrNull(r, 'jump_held_equity'), null);
        assert.equal(msCellOrNull(r, 'jump_held_at'), null);
        assert.equal(empty.jumpAck, null);
        assert.equal(lamportsCellOrNull(r, 'jump_ack_equity'), null);
        assert.equal(msCellOrNull(r, 'jump_ack_at'), null);
        assert.equal(r['daily_stop_day'], empty.dailyStopDay);
        assert.equal(intCell(r, 'daily_stop_streak', 0, 1_000_000), empty.dailyStopStreak);
        assert.equal(boolCell(r, 'streak_halt'), empty.streakHalt);
        assert.equal(r['shape'], 1n);
      }
      for (const table of ['ledger_accounts', 'config_versions', 'positions', 'halt_reasons', 'audit_log']) {
        assert.equal(count(db, table), 0n, table);
      }
    });
  });

  it('copies the hard limits and the lists of the code exactly (a change there needs a new migration)', () => {
    assert.equal(SCHEMA_V1_COPIES.openPositions, HARD_CAPS.openPositions);
    assert.equal(SCHEMA_V1_COPIES.entriesPerDay, HARD_CAPS.entriesPerDay);
    assert.equal(SCHEMA_V1_COPIES.buyMaxSpendLamports, HARD_CAPS.buyMaxSpendLamports);
    assert.equal(SCHEMA_V1_COPIES.planFreshSlots, HARD_CAPS.planFreshSlots);
    assert.equal(SCHEMA_V1_COPIES.looseningDelayMs, LOOSENING_DELAY_MS);
    assert.deepEqual([...SCHEMA_V1_COPIES.strategies], [...STRATEGY_IDS]);
    assert.deepEqual([...SCHEMA_V1_COPIES.modes], [...PLAN_MODES]);
    assert.deepEqual([...SCHEMA_V1_COPIES.orderKinds], PLAN_KINDS.filter((k) => k !== 'withdraw'));
    assert.deepEqual([...SCHEMA_V1_COPIES.urgencies], [...PLAN_URGENCIES]);
    assert.ok(Object.isFrozen(SCHEMA_V1_COPIES));
  });

  it('builds IN lists only from plain words, never an empty one (review P, security 9)', () => {
    assert.equal(inList(['paper', 'peak-halt:paper', 'a.b_c']), "('paper', 'peak-halt:paper', 'a.b_c')");
    const bad: unknown[][] = [["it's"], ['a b'], ['Paper'], [''], ["x') OR 1 OR ('"], ['a\u0000b'], [5], [null], []];
    for (const values of bad) {
      assert.throws(() => inList(values as string[]), /an IN list/, JSON.stringify(values));
    }
  });
});

describe('config versions and pending changes', () => {
  it('versions are 1, 2, 3... in time order, the first is the default with nothing to undo, and none is ever changed or deleted', () => {
    withFresh((db) => {
      refused(db, null, INSERT_VERSION, 1n, T, 'owner', VALUES, '[]', null); // the first is the default
      version(db, 1n);
      refused(db, /in order/, INSERT_VERSION, 3n, T, 'owner', VALUES, '[]', 2n);
      refused(db, /in order/, INSERT_VERSION.replace('(id, ', '(').replace('(?, ', '('), T, 'owner', VALUES, '[]', 1n); // no id: the repository names it
      refused(db, null, INSERT_VERSION, 2n, T, 'default', VALUES, '[]', 1n); // only the first is the default
      refused(db, null, INSERT_VERSION, 2n, T, 'owner', VALUES, '[]', 2n); // undo to itself
      refused(db, null, INSERT_VERSION, 2n, T, 'owner', '{"not":json', '[]', 1n);
      refused(db, null, INSERT_VERSION, 2n, T, 'hacker', VALUES, '[]', 1n);
      version(db, 2n, T, 'rollback', `["${TUNABLE_PATHS[1]}"]`, null);
      version(db, 3n, T - 5n, 'ai-approved'); // dated before version 2: the clock may step back, ids give the order (review P-R1)
      refused(db, /never changed/, "UPDATE config_versions SET author = 'owner' WHERE id = 3");
      refused(db, /never deleted/, 'DELETE FROM config_versions WHERE id = 3');
      assert.equal(count(db, 'config_versions'), 3n);
    });
    withFresh((db) => refused(db, null, INSERT_VERSION, 1n, T, 'default', VALUES, `["${TUNABLE_PATHS[0]}"]`, null)); // the first changes nothing
  });

  it('a pending loosening waits at least 24 hours, there is one per tunable, and every tunable path fits', () => {
    withFresh((db) => {
      const insert = 'INSERT INTO pending_changes (path, from_value, to_value, source, requested_at, apply_at) VALUES (?, ?, ?, ?, ?, ?)';
      for (const p of TUNABLE_PATHS) {
        write(db, insert, p, '1', '2', 'owner', T, T + BigInt(LOOSENING_DELAY_MS));
      }
      assert.equal(count(db, 'pending_changes'), BigInt(TUNABLE_PATHS.length));
      refused(db, null, insert, TUNABLE_PATHS[0] as string, '1', '2', 'owner', T, T + BigInt(LOOSENING_DELAY_MS)); // one per tunable
      write(db, 'DELETE FROM pending_changes');
      refused(db, null, insert, TUNABLE_PATHS[0] as string, '1', '2', 'owner', T, T + BigInt(LOOSENING_DELAY_MS) - 1n);
      for (const p of ['risk', 'risk.', '.x', 'risk.a.b', 'Risk.x', 'risk.x-y', 'résk.x', 'risk.x\u0000y', `risk.${'a'.repeat(60)}`]) {
        refused(db, null, insert, p, '1', '2', 'owner', T, T + BigInt(LOOSENING_DELAY_MS));
      }
      refused(db, null, insert, 'risk.x', '01', '2', 'owner', T, T + BigInt(LOOSENING_DELAY_MS));
      refused(db, null, insert, 'risk.x', '1', '2', 'default', T, T + BigInt(LOOSENING_DELAY_MS));
      assert.equal(count(db, 'pending_changes'), 0n);
    });
  });

  it('a pending change is replaced, never changed: its wait cannot be shortened in place (review P)', () => {
    withFresh((db) => {
      const insert = 'INSERT INTO pending_changes (path, from_value, to_value, source, requested_at, apply_at) VALUES (?, ?, ?, ?, ?, ?)';
      write(db, insert, TUNABLE_PATHS[0] as string, '1', '2', 'owner', T, T + BigInt(LOOSENING_DELAY_MS));
      const neverChanged = /replaced, never changed/;
      refused(db, neverChanged, 'UPDATE pending_changes SET requested_at = requested_at + 1, apply_at = apply_at + 1');
      refused(db, neverChanged, "UPDATE pending_changes SET to_value = '3'");
      refused(db, neverChanged, `${insert} ON CONFLICT (path) DO UPDATE SET to_value = excluded.to_value`, TUNABLE_PATHS[0] as string, '1', '9', 'owner', T, T + BigInt(LOOSENING_DELAY_MS));
      assert.equal(db.get('SELECT to_value FROM pending_changes')?.['to_value'], '2');
    });
  });
});

describe('flags, halts, strategy modes, entry bans and the day count', () => {
  /** The newest audit id, read in the same statement: how the repository names it (step 6c-2). */
  const NEWEST = '(SELECT coalesce(max(id), 0) FROM audit_log)';
  const SET_KILL = `UPDATE flags SET kill = 1, kill_at = ?, kill_source = 'telegram', kill_audit_id = ${NEWEST}, updated_at = ? WHERE id = 1`;
  /** A KILL naming a chosen audit id, for the trigger's own boundaries. */
  const KILL_NAMING = "UPDATE flags SET kill = 1, kill_at = ?, kill_source = 'telegram', kill_audit_id = ?, updated_at = ? WHERE id = 1";
  const CLEAR_KILL = 'UPDATE flags SET kill = 0, kill_at = NULL, kill_source = NULL, kill_audit_id = NULL, updated_at = ? WHERE id = 1';
  const FLAGS_COLUMNS = '(id, kill, kill_at, kill_source, kill_audit_id, paused, paused_at, entries_stopped, halt_cleared_at, updated_at)';
  const INSERT_FLAGS = `INSERT INTO flags ${FLAGS_COLUMNS} VALUES (1, 0, NULL, NULL, NULL, 0, NULL, 0, NULL, ?)`;
  const REPLACE_FLAGS = `INSERT OR REPLACE INTO flags ${FLAGS_COLUMNS} VALUES (1, 0, NULL, NULL, NULL, 0, NULL, 0, NULL, 0)`;
  const SET_HALT = `INSERT INTO halt_reasons (reason, set_at, set_audit_id) VALUES (?, ?, ${NEWEST})`;
  /** A halt naming a chosen audit id, for the trigger's own boundaries. */
  const HALT_NAMING = 'INSERT INTO halt_reasons (reason, set_at, set_audit_id) VALUES (?, ?, ?)';
  /** How the repository sets a halt (step 6c-2): a repeat keeps the first one, and a failed CHECK still raises. */
  const HALT_ONCE = `${SET_HALT} ON CONFLICT (reason) DO NOTHING`;
  const LIFT = 'DELETE FROM halt_reasons WHERE reason = ?';

  it('there is one flags row, KILL and PAUSE carry their time (and KILL its source), and the row is never deleted or replaced', () => {
    withFresh((db) => {
      refused(db, null, 'INSERT INTO flags (id, kill, paused, entries_stopped, updated_at) VALUES (2, 0, 0, 0, 0)');
      refused(db, null, 'UPDATE flags SET kill = 1 WHERE id = 1');
      refused(db, null, "UPDATE flags SET kill = 1, kill_at = 5, kill_source = 'email' WHERE id = 1");
      refused(db, null, 'UPDATE flags SET kill_at = ? WHERE id = 1', T); // a time without a KILL
      refused(db, null, "UPDATE flags SET kill_source = 'cli' WHERE id = 1"); // a source without a KILL
      refused(db, null, 'UPDATE flags SET kill_audit_id = 0 WHERE id = 1'); // an audit link without a KILL
      refused(db, null, "UPDATE flags SET kill = 1, kill_at = ?, kill_source = 'cli' WHERE id = 1", T); // a KILL without its audit link
      write(db, SET_KILL, T, T);
      refused(db, null, 'UPDATE flags SET paused = 1 WHERE id = 1');
      write(db, 'UPDATE flags SET paused = 1, paused_at = ? WHERE id = 1', T);
      write(db, 'UPDATE flags SET paused = 0, paused_at = NULL WHERE id = 1'); // the owner's own pause comes and goes
      refused(db, /never deleted/, 'DELETE FROM flags');
      // REPLACE deletes the old row first; with recursive triggers on, that delete is refused too
      refused(db, /never deleted/, REPLACE_FLAGS);
      refused(db, null, 'UPDATE flags SET entries_stopped = 2 WHERE id = 1');
      assert.equal(db.get('SELECT kill FROM flags')?.['kill'], 1n);
    });
  });

  it('a KILL keeps its time, source and audit row until it is cleared; setting it again with coalesce changes nothing', () => {
    withFresh((db) => {
      write(db, SET_KILL, T, T);
      const kept = /keeps its time, source and audit row/;
      refused(db, kept, SET_KILL, T + 5n, T + 5n); // a later KILL would move its time
      refused(db, kept, "UPDATE flags SET kill_source = 'cli' WHERE id = 1");
      refused(db, kept, 'UPDATE flags SET kill_at = ? WHERE id = 1', T - 1n); // a backdated KILL
      audit(db, 'engine:observe');
      refused(db, kept, `UPDATE flags SET kill_audit_id = ${NEWEST} WHERE id = 1`); // a newer audit link would let a later row count as before it
      write(db, `UPDATE flags SET kill = 1, kill_at = coalesce(kill_at, ?), kill_source = coalesce(kill_source, 'cli'), kill_audit_id = coalesce(kill_audit_id, ${NEWEST}), updated_at = ? WHERE id = 1`, T + 5n, T + 5n);
      assert.deepEqual({ ...db.get('SELECT kill, kill_at, kill_source, kill_audit_id FROM flags') }, { kill: 1n, kill_at: T, kill_source: 'telegram', kill_audit_id: 0n });
      // an upsert is an update: the same triggers hold
      refused(db, kept, `${INSERT_FLAGS} ON CONFLICT (id) DO UPDATE SET kill_at = excluded.updated_at`, T + 9n);
      refused(db, /only by the owner/, `${INSERT_FLAGS} ON CONFLICT (id) DO UPDATE SET kill = 0, kill_at = NULL, kill_source = NULL, kill_audit_id = NULL`, T + 9n);
    });
  });

  it('KILL is cleared only while the newest audit row of all is the owner\'s clear-kill at the server, written after the KILL (by audit id, not by clock)', () => {
    withFresh((db) => {
      audit(db, 'server:clear-kill'); // id 1, before the KILL: stale
      write(db, SET_KILL, T, T); // names id 1
      refused(db, /only by the owner/, CLEAR_KILL, T);
      audit(db, 'owner:resume-peak'); // id 2: the wrong action
      refused(db, /only by the owner/, CLEAR_KILL, T);
      audit(db, 'server:clear-kill'); // id 3
      audit(db, 'engine:observe'); // id 4: the owner's command is no longer the newest
      refused(db, /only by the owner/, CLEAR_KILL, T);
      db.transaction((tx) => {
        auditTx(tx, 'server:clear-kill', T); // id 5, in the same millisecond: its id shows it came after
        return tx.run(CLEAR_KILL, T); // the repository writes the audit row last, then clears
      });
      assert.deepEqual({ ...db.get('SELECT kill, kill_at, kill_source, kill_audit_id FROM flags') }, { kill: 0n, kill_at: null, kill_source: null, kill_audit_id: null });
      // a second KILL needs a new audit row: row 5 came before it
      write(db, SET_KILL, T, T); // names id 5
      refused(db, /only by the owner/, CLEAR_KILL, T);
    });
    withFresh((db) => {
      write(db, SET_KILL, T, T); // names 0: there is no audit row yet
      refused(db, /only by the owner/, CLEAR_KILL, T); // no audit row at all: a NULL never lets it through
    });
  });

  it('a KILL or a halt names the newest audit row when it is set, so no clock reading can block it or let an old row stand in for the owner (review P-R1)', () => {
    withFresh((db) => {
      audit(db, 'server:clear-kill', T + YEAR); // id 1: a clock a year ahead
      // the clock is corrected: KILL, a halt and the owner's commands all still work at the real time
      refused(db, /names the newest audit row/, KILL_NAMING, T, 0n, T); // an older id
      refused(db, /names the newest audit row/, KILL_NAMING, T, 2n, T); // a future id
      write(db, KILL_NAMING, T, 1n, T);
      refused(db, /names the newest audit row/, HALT_NAMING, 'disk-db', T, 0n);
      refused(db, /names the newest audit row/, HALT_NAMING, 'disk-db', T, 5n);
      write(db, HALT_NAMING, 'disk-db', T, 1n);
      refused(db, /only by the owner/, CLEAR_KILL, T); // row 1, dated a year later, came before the KILL
      refused(db, /only by the owner/, LIFT, 'disk-db');
      audit(db, 'server:reset-halt', T); // id 2, dated before row 1
      write(db, LIFT, 'disk-db');
      audit(db, 'server:clear-kill', T - 1n); // id 3: the clock stepped back again
      write(db, CLEAR_KILL, T - 1n);
      // even a row at the largest timestamp the schema takes leaves room: ids, not times, decide
      audit(db, 'engine:observe', BigInt(MAX_TIMESTAMP_MS)); // id 4
      write(db, SET_KILL, T, T); // names id 4
      write(db, SET_HALT, 'sanity-max:paper', T);
      audit(db, 'server:clear-kill', T); // id 5
      write(db, CLEAR_KILL, T);
      audit(db, 'server:reset-halt', T); // id 6
      write(db, LIFT, 'sanity-max:paper');
      assert.equal(db.get('SELECT kill FROM flags')?.['kill'], 0n);
      assert.equal(count(db, 'halt_reasons'), 0n);
    });
  });

  it('a halt is lifted only by the owner: anything at the server, the paper peak and streak halts also by their resumes, the live ones never from Telegram', () => {
    withFresh((db) => {
      for (const reason of ['peak-halt:paper', 'peak-halt:live', 'daily-stop-twice:paper', 'daily-stop-twice:live', 'sanity-max:paper', 'disk-db']) {
        write(db, SET_HALT, reason, T); // each names 0: no audit row yet
      }
      refused(db, null, SET_HALT, 'Not A Code', T);
      refused(db, /only by the owner/, LIFT, 'disk-db'); // no audit row: the NULL trap of the design is closed
      audit(db, 'owner:resume-peak'); // id 1
      write(db, LIFT, 'peak-halt:paper');
      refused(db, /only by the owner/, LIFT, 'peak-halt:live'); // decision D4: live only at the server
      refused(db, /only by the owner/, LIFT, 'daily-stop-twice:paper'); // the other resume's halt
      refused(db, /only by the owner/, LIFT, 'sanity-max:paper');
      audit(db, 'owner:resume-streak'); // id 2
      write(db, LIFT, 'daily-stop-twice:paper');
      refused(db, /only by the owner/, LIFT, 'daily-stop-twice:live');
      refused(db, /only by the owner/, LIFT, 'peak-halt:live');
      audit(db, 'owner:resume-peak', T, 'owner-server'); // id 3: the owner's resume typed at the server counts too
      write(db, SET_HALT, 'peak-halt:paper', T); // set again, naming id 3
      refused(db, /only by the owner/, LIFT, 'peak-halt:paper'); // row 3 came before the new halt
      audit(db, 'engine:observe'); // id 4
      refused(db, /only by the owner/, LIFT, 'disk-db'); // the newest row is the engine's
      audit(db, 'server:reset-halt'); // id 5
      for (const reason of ['peak-halt:paper', 'peak-halt:live', 'daily-stop-twice:live', 'sanity-max:paper', 'disk-db']) {
        write(db, LIFT, reason);
      }
      assert.equal(count(db, 'halt_reasons'), 0n);
      write(db, SET_HALT, 'disk-db', T); // names id 5
      refused(db, /only by the owner/, LIFT, 'disk-db'); // the reset came before this halt
    });
  });

  it('a halt keeps its reason, time and audit row: never renamed, backdated, upserted or replaced; a repeat with ON CONFLICT DO NOTHING keeps the first', () => {
    withFresh((db) => {
      write(db, SET_HALT, 'disk-db', T);
      audit(db, 'engine:observe');
      refused(db, /never changed/, "UPDATE halt_reasons SET reason = 'disk-db2' WHERE reason = 'disk-db'");
      refused(db, /never changed/, 'UPDATE halt_reasons SET set_at = 0');
      refused(db, /never changed/, `UPDATE halt_reasons SET set_audit_id = ${NEWEST}`);
      refused(db, /never changed/, `${SET_HALT} ON CONFLICT (reason) DO UPDATE SET set_at = excluded.set_at`, 'disk-db', T + 1n);
      refused(db, /only by the owner/, SET_HALT.replace('INSERT', 'INSERT OR REPLACE'), 'disk-db', T + 1n);
      assert.equal(write(db, HALT_ONCE, 'disk-db', T + 1n), 0);
      refused(db, null, HALT_ONCE, 'Not A Code', T + 1n); // DO NOTHING never hides a failed CHECK
      assert.deepEqual(db.all('SELECT reason, set_at, set_audit_id FROM halt_reasons').map((r) => ({ ...r })), [{ reason: 'disk-db', set_at: T, set_audit_id: 0n }]);
      // why the repository never uses OR IGNORE for a halt: it drops a row that fails a CHECK without a word
      assert.equal(write(db, SET_HALT.replace('INSERT', 'INSERT OR IGNORE'), 'Not A Code', T + 1n), 0);
      assert.equal(count(db, 'halt_reasons'), 1n);
    });
  });

  it('a strategy is live only through /golive, only the three strategies exist, and modes are never deleted', () => {
    withFresh((db) => {
      const setMode = 'UPDATE strategy_modes SET mode = ?, changed_by = ?, changed_at = ? WHERE strategy = ?';
      refused(db, null, setMode, 'live', 'owner-paper', T, 'crowdflow');
      refused(db, null, setMode, 'live', 'auto-demote', T, 'crowdflow');
      write(db, setMode, 'live', 'owner-golive', T, 'crowdflow');
      write(db, setMode, 'paper', 'auto-demote', T, 'crowdflow');
      refused(db, null, setMode, 'turbo', 'owner-paper', T, 'momentum');
      refused(db, null, "INSERT INTO strategy_modes (strategy, mode, changed_at, changed_by, gate_since) VALUES ('copy', 'off', 0, 'migration', 0)");
      refused(db, null, "INSERT INTO strategy_modes (strategy, mode, changed_at, changed_by, gate_since) VALUES ('launch', 'off', 0, 'migration', 0)");
      refused(db, /never deleted/, "DELETE FROM strategy_modes WHERE strategy = 'launch'");
    });
  });

  it('entry bans: cooldowns and pauses end, bans do not; strategy pauses name a strategy; keys are ids', () => {
    withFresh((db) => {
      const ban = 'INSERT INTO entry_bans (kind, key, until, reason, set_at) VALUES (?, ?, ?, ?, ?)';
      write(db, ban, 'mint-cooldown', 'MintA', T + 1n, 'exit:cooldown', T);
      write(db, ban, 'mint-ban', 'MintB', null, 'exit:rug', T);
      write(db, ban, 'creator-ban', 'CreatorC', null, 'safety:creator', T);
      write(db, ban, 'strategy-pause', 'momentum', T + 1n, 'losses:three', T);
      refused(db, null, ban, 'mint-cooldown', 'MintD', null, 'exit:cooldown', T);
      refused(db, null, ban, 'mint-ban', 'MintE', T + 1n, 'exit:rug', T);
      refused(db, null, ban, 'strategy-off', 'copy', T + 1n, 'losses:six', T);
      refused(db, null, ban, 'mint-cooldown', 'Mint F', T + 1n, 'exit:cooldown', T);
      refused(db, null, ban, 'mint-cooldown', 'MintA', T + 2n, 'exit:cooldown', T); // one per kind and key
      refused(db, null, ban, 'whitelist', 'MintG', null, 'x', T);
    });
  });

  it('a ban stays and a cooldown or pause is never shortened; a cooldown may be lengthened, and removed once it is over (review P)', () => {
    withFresh((db) => {
      const ban = 'INSERT INTO entry_bans (kind, key, until, reason, set_at) VALUES (?, ?, ?, ?, ?)';
      write(db, ban, 'mint-cooldown', 'MintA', T + 10n, 'exit:cooldown', T);
      write(db, ban, 'mint-ban', 'MintB', null, 'exit:rug', T);
      write(db, ban, 'creator-ban', 'CreatorC', null, 'safety:creator', T);
      write(db, ban, 'strategy-pause', 'momentum', T + 10n, 'losses:three', T);
      const stays = /a ban stays/;
      refused(db, stays, "UPDATE entry_bans SET reason = 'exit:other' WHERE kind = 'mint-ban'");
      refused(db, stays, "UPDATE entry_bans SET set_at = 0 WHERE kind = 'creator-ban'");
      refused(db, stays, "DELETE FROM entry_bans WHERE kind = 'mint-ban'");
      refused(db, stays, "DELETE FROM entry_bans WHERE kind = 'creator-ban'");
      refused(db, stays, `${ban.replace('INSERT', 'INSERT OR REPLACE')}`, 'mint-ban', 'MintB', null, 'exit:other', T + 1n); // REPLACE deletes first
      refused(db, stays, "UPDATE entry_bans SET until = until - 1 WHERE kind = 'mint-cooldown'");
      refused(db, stays, "UPDATE entry_bans SET until = until - 1 WHERE kind = 'strategy-pause'");
      refused(db, stays, "UPDATE entry_bans SET key = 'MintZ' WHERE kind = 'mint-cooldown'");
      refused(db, stays, "UPDATE entry_bans SET kind = 'mint-ban', until = NULL WHERE kind = 'mint-cooldown'");
      refused(db, null, "UPDATE entry_bans SET until = NULL WHERE kind = 'mint-cooldown'"); // the CHECK: a cooldown has an end
      write(db, "UPDATE entry_bans SET until = until + 5, reason = 'exit:cooldown-again' WHERE kind = 'mint-cooldown'");
      write(db, "DELETE FROM entry_bans WHERE kind = 'mint-cooldown'");
      assert.deepEqual(db.all('SELECT kind FROM entry_bans ORDER BY kind').map((r) => r['kind']), ['creator-ban', 'mint-ban', 'strategy-pause']);
    });
  });

  it('the day\'s entry count starts at one, steps by one, stops at the hard limit and is kept', () => {
    withFresh((db) => {
      const start = 'INSERT INTO entry_counts (day, count) VALUES (?, ?)';
      const step = 'UPDATE entry_counts SET count = count + 1 WHERE day = ?';
      refused(db, /one entry/, start, '2026-11-14', 2n);
      refused(db, null, start, '2026-02-30', 1n);
      write(db, start, '2026-11-14', 1n);
      for (let n = 2; n <= SCHEMA_V1_COPIES.entriesPerDay; n += 1) {
        write(db, step, '2026-11-14');
      }
      assert.equal(db.get("SELECT count FROM entry_counts WHERE day = '2026-11-14'")?.['count'], BigInt(HARD_CAPS.entriesPerDay));
      refused(db, null, step, '2026-11-14'); // the 13th
      write(db, start, '2026-11-15', 1n);
      refused(db, /exactly one/, "UPDATE entry_counts SET count = count + 2 WHERE day = '2026-11-15'");
      refused(db, /exactly one/, "UPDATE entry_counts SET count = 1 WHERE day = '2026-11-15'");
      refused(db, /exactly one/, "UPDATE entry_counts SET day = '2026-11-16', count = count + 1 WHERE day = '2026-11-15'");
      refused(db, /kept/, "DELETE FROM entry_counts WHERE day = '2026-11-15'");
    });
  });
});

describe('day state and equity snapshots', () => {
  const SAVE =
    'UPDATE day_state SET day = ?, day_start = ?, last_equity = ?, peak = ?, jump_pending = ?, jump_held_equity = ?, jump_held_at = ?, jump_ack_equity = ?, jump_ack_at = ?, daily_stop_day = ?, daily_stop_streak = ?, streak_halt = ?, updated_at = ? WHERE mode = ?';

  it('a day state is consistent: a held jump has its equity and time, an acknowledged one too; amounts are canonical; rows are never deleted', () => {
    withFresh((db) => {
      write(db, SAVE, '2026-11-14', '1000', '1500', '2000', 1n, '1500', T, null, null, null, 0n, 0n, T, 'paper');
      assert.equal(dayCell(db.get("SELECT day FROM day_state WHERE mode = 'paper'") ?? {}, 'day'), '2026-11-14');
      refused(db, null, SAVE, '2026-11-14', '1000', '1500', '2000', 1n, null, null, null, null, null, 0n, 0n, T, 'paper'); // pending without the held jump
      refused(db, null, SAVE, '2026-11-14', '1000', '1500', '2000', 0n, '1500', T, null, null, null, 0n, 0n, T, 'paper'); // a held jump without pending
      refused(db, null, SAVE, '2026-11-14', '1000', '1500', '2000', 0n, null, null, '1500', null, null, 0n, 0n, T, 'paper'); // ack without its time
      refused(db, null, SAVE, '2026-11-14', '01000', '1500', '2000', 0n, null, null, null, null, null, 0n, 0n, T, 'paper');
      refused(db, null, SAVE, '2026-13-14', '1000', '1500', '2000', 0n, null, null, null, null, null, 0n, 0n, T, 'paper');
      refused(db, null, SAVE, '2026-11-14', '1000', '1500', '2000', 0n, null, null, null, null, null, -1n, 0n, T, 'paper');
      refused(db, null, 'UPDATE day_state SET shape = 2');
      refused(db, /never deleted/, "DELETE FROM day_state WHERE mode = 'live'");
      refused(db, null, "INSERT INTO day_state (mode, shape, day_start, last_equity, jump_pending, daily_stop_streak, streak_halt, updated_at) VALUES ('demo', 1, '0', '0', 0, 0, 0, 0)");
    });
  });

  it('equity snapshots: one per mode and instant, amounts canonical or null', () => {
    withFresh((db) => {
      const snap = 'INSERT INTO equity_snapshots (mode, at, equity, stop_equity) VALUES (?, ?, ?, ?)';
      write(db, snap, 'paper', T, '1000', null);
      write(db, snap, 'live', T, null, null);
      refused(db, null, snap, 'paper', T, '1000', '900');
      refused(db, null, snap, 'paper', T + 1n, '-1', null);
      refused(db, /never changed/, "UPDATE equity_snapshots SET equity = '5000' WHERE mode = 'paper'"); // the hour-ago base of the jump test
      refused(db, /never changed/, 'UPDATE equity_snapshots SET at = at - 1');
      write(db, 'DELETE FROM equity_snapshots WHERE at < ?', T + 1n); // old snapshots may be pruned
    });
  });
});

describe('ledger accounts and positions', () => {
  it('ledger accounts: one per mode, canonical amounts, a fixed mode, never deleted or replaced', () => {
    withFresh((db) => {
      const open = 'INSERT INTO ledger_accounts (mode, sol, total_deposits, total_withdrawals, updated_at) VALUES (?, ?, ?, ?, ?)';
      write(db, open, 'paper', '1000000000', '1000000000', '0', T);
      refused(db, null, open, 'paper', '1', '1', '0', T);
      refused(db, null, open, 'live', '1.5', '1', '0', T);
      refused(db, null, open, 'demo', '1', '1', '0', T);
      refused(db, /keeps its mode/, "UPDATE ledger_accounts SET mode = 'live' WHERE mode = 'paper'"); // paper money never turns live
      refused(db, /never deleted/, 'DELETE FROM ledger_accounts');
      refused(db, /never deleted/, open.replace('INSERT', 'INSERT OR REPLACE'), 'paper', '5', '5', '0', T);
      write(db, "UPDATE ledger_accounts SET sol = '999', updated_at = ? WHERE mode = 'paper'", T + 1n);
      assert.equal(db.get('SELECT sol FROM ledger_accounts')?.['sol'], '999');
    });
  });

  it('a position starts as opening with a max spend of at most 0.07 SOL, and its amounts start at zero', () => {
    withFresh((db) => {
      refused(db, /starts as opening/, INSERT_POSITION, 'p1', 'MintA', 'crowdflow', 'paper', 'open', T, '50000000', '400000', T);
      refused(db, null, INSERT_POSITION, 'p1', 'MintA', 'crowdflow', 'paper', 'opening', T, null, '400000', T);
      refused(db, null, INSERT_POSITION, 'p1', 'MintA', 'crowdflow', 'paper', 'opening', T, '70000001', '400000', T);
      position(db, 'p1', { maxSpend: SCHEMA_V1_COPIES.buyMaxSpendLamports.toString() });
      const r = db.get('SELECT token_units, cost_basis, realized, exit_seq FROM positions WHERE id = ?', 'p1');
      assert.deepEqual({ ...r }, { token_units: '0', cost_basis: '0', realized: '0', exit_seq: 0n });
      write(db, "UPDATE positions SET status = 'open', realized = ?, updated_at = ? WHERE id = 'p1'", '-5', T);
      refused(db, null, "UPDATE positions SET realized = '-0' WHERE id = 'p1'");
      refused(db, null, "UPDATE positions SET token_units = '-1' WHERE id = 'p1'");
      refused(db, null, "UPDATE positions SET status = 'liquidated' WHERE id = 'p1'");
      refused(db, null, "UPDATE positions SET status = 'closed' WHERE id = 'p1'"); // closed needs its time
      refused(db, null, "UPDATE positions SET closed_at = ? WHERE id = 'p1'", T + 1n); // a time needs closed
      // a close dated before the open is still booked: a clock that stepped back never blocks an exit (review P-R1)
      write(db, CLOSE_POSITION, T - 1n, T - 1n, 'p1');
      assert.equal(db.get("SELECT status FROM positions WHERE id = 'p1'")?.['status'], 'closed');
    });
  });

  it('one active position per token; a closed one may share it', () => {
    withFresh((db) => {
      position(db, 'p1', { mint: 'MintA' });
      refused(db, null, INSERT_POSITION, 'p2', 'MintA', 'momentum', 'live', 'opening', T, '1', '1', T);
      write(db, "UPDATE positions SET status = 'stuck', updated_at = ? WHERE id = 'p1'", T);
      refused(db, null, INSERT_POSITION, 'p2', 'MintA', 'momentum', 'paper', 'opening', T, '1', '1', T); // stuck is still active
      closePosition(db, 'p1');
      position(db, 'p2', { mint: 'MintA' });
      assert.equal(count(db, 'positions'), 2n);
    });
  });

  it('at most 4 active positions, paper and live together; a closed one frees its place', () => {
    withFresh((db) => {
      for (let n = 1; n <= SCHEMA_V1_COPIES.openPositions; n += 1) {
        position(db, `p${n}`, { mode: n % 2 === 0 ? 'live' : 'paper' });
      }
      refused(db, /more than 4 active/, INSERT_POSITION, 'p5', 'Mint5', 'crowdflow', 'live', 'opening', T, '1', '1', T);
      closePosition(db, 'p2');
      position(db, 'p5');
      refused(db, /more than 4 active/, INSERT_POSITION, 'p6', 'Mint6', 'crowdflow', 'paper', 'opening', T, '1', '1', T);
      assert.equal(SCHEMA_V1_COPIES.openPositions, HARD_CAPS.openPositions);
    });
  });

  it('a position keeps its identity, a closed one is final, and none is ever deleted', () => {
    withFresh((db) => {
      position(db, 'p1');
      for (const set of ["mint = 'MintZ'", "strategy = 'launch'", "mode = 'live'", 'opened_at = 1', "id = 'p9'", "mint = 'Mintp1'"]) {
        refused(db, /identity/, `UPDATE positions SET ${set} WHERE id = 'p1'`);
      }
      closePosition(db, 'p1');
      refused(db, /final/, "UPDATE positions SET status = 'open', closed_at = NULL WHERE id = 'p1'");
      refused(db, /final/, "UPDATE positions SET tips = '5' WHERE id = 'p1'");
      refused(db, /kept/, "DELETE FROM positions WHERE id = 'p1'");
      refused(db, /kept/, "INSERT OR REPLACE INTO positions (id, mint, strategy, mode, status, opened_at, max_spend, p95_exit_cost, updated_at) VALUES ('p1', 'MintQ', 'crowdflow', 'paper', 'opening', 1, '1', '1', 1)");
    });
  });

  it('a position never goes back to opening, so a used buy cannot be spent twice (review P)', () => {
    withFresh((db) => {
      for (const [n, status] of [[1, 'open'], [2, 'exiting'], [3, 'stuck']] as const) {
        position(db, `p${n}`);
        write(db, `UPDATE positions SET status = ?, updated_at = ? WHERE id = 'p${n}'`, status, T);
        refused(db, /never goes back to opening/, `UPDATE positions SET status = 'opening' WHERE id = 'p${n}'`);
      }
      write(db, "UPDATE positions SET status = 'exiting', updated_at = ? WHERE id = 'p1'", T);
      write(db, "UPDATE positions SET status = 'stuck', updated_at = ? WHERE id = 'p1'", T);
      write(db, "UPDATE positions SET status = 'open', updated_at = ? WHERE id = 'p1'", T); // the other moves are the repository's to check
    });
  });
});

describe('intents, decisions, tokens and orders', () => {
  it('an entry intent names its strategy and size, an exit its sequence, fraction and urgency; one exit intent per sequence; intents never change', () => {
    withFresh((db) => {
      version(db, 1n);
      position(db, 'p1');
      entryIntent(db, 'i1', 'p1');
      refused(db, null, INSERT_INTENT, 'i2', 'entry', 'paper', null, 'MintA', 'p1', 'normal', null, null, null, null, T, null, '[]', '{}');
      refused(db, null, INSERT_INTENT, 'i2', 'entry', 'paper', 'crowdflow', 'MintA', 'p1', 'normal', null, 1n, null, null, T, null, '[]', '{}');
      refused(db, null, INSERT_INTENT, 'i2', 'exit', 'paper', null, 'MintA', 'p1', null, null, 1n, null, 'normal', T, null, '[]', '{}');
      refused(db, null, INSERT_INTENT, 'i2', 'entry', 'paper', 'crowdflow', 'MintA', 'p1', 'normal', 10_001n, null, null, null, T, null, '[]', '{}');
      refused(db, null, INSERT_INTENT, 'i2', 'exit', 'paper', null, 'MintA', 'p1', null, null, 1n, 0n, 'normal', T, null, '[]', '{}');
      refused(db, null, INSERT_INTENT, 'i2', 'exit', 'paper', null, 'MintA', 'p1', null, null, 1n, 10_000n, 'panic', T, null, '[]', '{}');
      // each field belongs to one kind only (review P: a compound CHECK let the other kind's fields in)
      refused(db, null, INSERT_INTENT, 'i2', 'exit', 'paper', 'crowdflow', 'Mintp1', 'p1', null, null, 1n, 10_000n, 'normal', T, null, '[]', '{}');
      refused(db, null, INSERT_INTENT, 'i2', 'exit', 'paper', null, 'Mintp1', 'p1', 'min', null, 1n, 10_000n, 'normal', T, null, '[]', '{}');
      refused(db, null, INSERT_INTENT, 'i2', 'exit', 'paper', null, 'Mintp1', 'p1', null, 5_000n, 1n, 10_000n, 'normal', T, null, '[]', '{}');
      refused(db, null, INSERT_INTENT, 'i2', 'entry', 'paper', 'crowdflow', 'Mintp1', 'p1', 'normal', null, null, 10_000n, null, T, null, '[]', '{}');
      refused(db, null, INSERT_INTENT, 'i2', 'entry', 'paper', 'crowdflow', 'Mintp1', 'p1', 'normal', null, null, null, 'normal', T, null, '[]', '{}');
      refused(db, null, INSERT_INTENT, 'i2', 'entry', 'paper', 'crowdflow', 'MintA', 'p1', 'normal', null, null, null, null, T, null, '[1,]', '{}');
      exitIntent(db, 'x1', 'p1', 1n);
      refused(db, null, INSERT_INTENT, 'x2', 'exit', 'paper', null, 'Mintp1', 'p1', null, null, 1n, 10_000n, 'emergency', T, null, '[]', '{}');
      exitIntent(db, 'x2', 'p1', 2n);
      refused(db, /never changed/, "UPDATE intents SET urgency = 'emergency' WHERE id = 'x2'");
      refused(db, /never deleted/, "DELETE FROM intents WHERE id = 'x2'");
    });
  });

  it('one decision per intent, for an intent that exists, under a config version that exists; approved means no stage; decisions never change', () => {
    withFresh((db) => {
      version(db, 1n);
      position(db, 'p1');
      entryIntent(db, 'i1', 'p1');
      refused(db, null, INSERT_DECISION, 'nobody', T, 1n, null, '[]', '1', null, null, 1n, 1n); // no such intent
      refused(db, null, INSERT_DECISION, 'i1', T, 1n, null, '[]', '1', null, null, 1n, 9n); // no such version
      refused(db, null, INSERT_DECISION, 'i1', T, 1n, 'blocked', '[]', '1', null, null, 1n, 1n);
      refused(db, null, INSERT_DECISION, 'i1', T, 0n, null, '[]', null, null, null, 1n, 1n);
      refused(db, null, INSERT_DECISION, 'i1', T, 1n, null, '[]', '1', 'Not A Code', null, 1n, 1n);
      decision(db, 'i1');
      refused(db, null, INSERT_DECISION, 'i1', T, 0n, 'duplicate', '[]', null, null, null, 1n, 1n);
      refused(db, /never changed/, "UPDATE risk_decisions SET approved = 0, stage = 'error' WHERE intent_id = 'i1'");
      refused(db, /never deleted/, "DELETE FROM risk_decisions WHERE intent_id = 'i1'");
    });
  });

  it('a token: reduce-only exactly for sells and closes, a buy at most 0.07 SOL, at most 25 slots of life, consumed once within its life, otherwise never changed', () => {
    withFresh((db) => {
      version(db, 1n);
      position(db, 'p1');
      entryIntent(db, 'i1', 'p1');
      decision(db, 'i1');
      const args = (o: Partial<Record<'kind' | 'reduceOnly' | 'maxSpend' | 'quote' | 'expires', SqlParam>>): SqlParam[] => [
        't1', 'i1', 'p1', 'paper', o.kind ?? 'buy', o.reduceOnly ?? 0n, HEX(1), o.maxSpend ?? '50000000', '1000', o.quote ?? 1_000n, o.expires ?? 1_025n, T, null, null,
      ];
      refused(db, null, INSERT_TOKEN, ...args({ reduceOnly: 1n }));
      refused(db, null, INSERT_TOKEN, ...args({ kind: 'sell', reduceOnly: 0n }));
      refused(db, null, INSERT_TOKEN, ...args({ kind: 'withdraw' }));
      refused(db, null, INSERT_TOKEN, ...args({ maxSpend: '70000001' }));
      refused(db, null, INSERT_TOKEN, ...args({ expires: 1_000n + BigInt(SCHEMA_V1_COPIES.planFreshSlots) + 1n }));
      refused(db, null, INSERT_TOKEN, ...args({ expires: 999n }));
      refused(db, null, INSERT_TOKEN, 't1', 'nobody', 'p1', 'paper', 'buy', 0n, HEX(1), '1', '1', 1_000n, 1_025n, T, null, null); // no decision
      write(db, INSERT_TOKEN, ...args({ maxSpend: '70000000' }));
      refused(db, null, CONSUME, T, 1_026n, 't1'); // after its expiry
      refused(db, null, CONSUME, T, 999n, 't1'); // before its quote
      refused(db, null, 'UPDATE approvals SET consumed_at = ? WHERE token_id = ?', T, 't1'); // time without slot
      consume(db, 't1', 1_025n);
      refused(db, /consumed once/, CONSUME, T + 1n, 1_025n, 't1');
      refused(db, /consumed once/, 'UPDATE approvals SET plan_hash = ? WHERE token_id = ?', HEX(2), 't1');
      refused(db, /kept/, "DELETE FROM approvals WHERE token_id = 't1'");
    });
  });

  it('a token is not changed when it is consumed, nor consumed by a change of anything else', () => {
    withFresh((db) => {
      version(db, 1n);
      position(db, 'p1');
      entryIntent(db, 'i1', 'p1');
      decision(db, 'i1');
      token(db, 't1', 'i1', 'p1');
      for (const set of ["plan_hash = '" + HEX(2) + "'", "max_spend = '1'", "min_out = '1'", 'expires_at_slot = 1001', 'quote_slot = 1001', "mode = 'live'", 'issued_at = 1']) {
        refused(db, /consumed once/, `UPDATE approvals SET consumed_at = ${NOW}, consumed_slot = 1010, ${set} WHERE token_id = 't1'`);
      }
      refused(db, /consumed once/, "UPDATE approvals SET min_out = '1' WHERE token_id = 't1'"); // unconsumed, not consuming
      consume(db, 't1');
    });
  });

  it('an order needs its consumed token, matching it in every field', () => {
    withFresh((db) => {
      version(db, 1n);
      position(db, 'p1');
      entryIntent(db, 'i1', 'p1');
      decision(db, 'i1');
      token(db, 't1', 'i1', 'p1');
      refused(db, /consumed, matching token/, INSERT_ORDER, 'o1', 'i1', 't1', 'p1', 'paper', 'buy', 'approved', HEX(1), '{}', '50000000', '1000', '50000000', 1_000n, T, T);
      consume(db, 't1');
      const mismatches: Parameters<typeof order>[6][] = [{ planHash: HEX(2) }, { maxSpend: '50000001' }, { minOut: '999' }, { mode: 'live' }, { quoteSlot: 1_001n }, { status: 'submitted' }];
      for (const o of mismatches) {
        storageError(() => order(db, 'o1', 'i1', 't1', 'p1', 'buy', o), 'constraint');
      }
      storageError(() => order(db, 'o1', 'i1', 't1', 'p1', 'sell'), 'constraint');
      order(db, 'o1', 'i1', 't1', 'p1');
      assert.equal(count(db, 'orders'), 1n);
    });
  });

  it('a token needs an approved decision for its own intent, that intent\'s position, token and mode, and the right kind of order (review P)', () => {
    withFresh((db) => {
      version(db, 1n);
      position(db, 'p1');
      position(db, 'p2');
      position(db, 'p3', { mode: 'live' });
      entryIntent(db, 'i1', 'p1');
      entryIntent(db, 'i2', 'p2');
      entryIntent(db, 'i3', 'p3'); // a paper intent naming a live position
      write(db, INSERT_INTENT, 'i4', 'entry', 'paper', 'crowdflow', 'MintOther', 'p1', 'normal', 7_000n, null, null, null, T, T, '[]', '{}'); // another token
      decision(db, 'i1');
      decision(db, 'i2', false);
      decision(db, 'i3');
      decision(db, 'i4');
      const tied = /approved decision for its own intent/;
      refused(db, tied, INSERT_TOKEN, ...tokenArgs('t1', 'i2', 'p2')); // the engine refused it
      refused(db, tied, INSERT_TOKEN, ...tokenArgs('t1', 'i1', 'p2')); // another position
      refused(db, tied, INSERT_TOKEN, ...tokenArgs('t1', 'i1', 'p1', 'buy', { mode: 'live' })); // another mode
      refused(db, tied, INSERT_TOKEN, ...tokenArgs('t1', 'i3', 'p3')); // the position is live
      refused(db, tied, INSERT_TOKEN, ...tokenArgs('t1', 'i3', 'p3', 'buy', { mode: 'live' })); // a paper intent never pays for a live order
      refused(db, tied, INSERT_TOKEN, ...tokenArgs('t1', 'i4', 'p1')); // the intent's token is not the position's
      refused(db, tied, INSERT_TOKEN, ...tokenArgs('t1', 'i1', 'p1', 'sell')); // an entry pays for a buy only
      exitIntent(db, 'x0', 'p2', 1n);
      decision(db, 'x0');
      refused(db, tied, INSERT_TOKEN, ...tokenArgs('tx0', 'x0', 'p2', 'buy')); // an exit never buys, even into an opening position
      token(db, 't1', 'i1', 'p1');
      // an exit: a sell or a close, never a buy, and only while the position holds tokens
      exitIntent(db, 'x1', 'p1', 1n);
      decision(db, 'x1');
      refused(db, tied, INSERT_TOKEN, ...tokenArgs('tx1', 'x1', 'p1', 'sell', { maxSpend: '200000' })); // p1 is still opening
      write(db, "UPDATE positions SET status = 'open', updated_at = ? WHERE id = 'p1'", T);
      refused(db, tied, INSERT_TOKEN, ...tokenArgs('tx1', 'x1', 'p1', 'buy')); // an exit never buys
      token(db, 'tx1', 'x1', 'p1', 'sell', { maxSpend: '200000' });
      entryIntent(db, 'i5', 'p1');
      decision(db, 'i5');
      refused(db, tied, INSERT_TOKEN, ...tokenArgs('t5', 'i5', 'p1')); // a buy only while the position opens
      refused(db, tied, INSERT_TOKEN, ...tokenArgs('t5', 'i5', 'p1', 'sell', { maxSpend: '200000' })); // an entry never sells, even from an open position
      closePosition(db, 'p1');
      exitIntent(db, 'x2', 'p1', 2n);
      decision(db, 'x2');
      refused(db, tied, INSERT_TOKEN, ...tokenArgs('tx2', 'x2', 'p1', 'close-account', { maxSpend: '200000' })); // closed: nothing to take
      assert.equal(count(db, 'approvals'), 2n);
    });
    withFresh((db) => {
      // the same token in a new position: an intent for the old, closed one never pays for the new one
      version(db, 1n);
      position(db, 'p1', { mint: 'MintA' });
      closePosition(db, 'p1');
      position(db, 'p2', { mint: 'MintA' });
      write(db, INSERT_INTENT, 'i1', 'entry', 'paper', 'crowdflow', 'MintA', 'p1', 'normal', 7_000n, null, null, null, T, T, '[]', '{}');
      decision(db, 'i1');
      refused(db, /approved decision for its own intent/, INSERT_TOKEN, ...tokenArgs('t1', 'i1', 'p2'));
      assert.equal(count(db, 'approvals'), 0n);
    });
  });

  it('a token is consumed only while its position may still take the order, and never before it was issued (review P)', () => {
    withFresh((db) => {
      version(db, 1n);
      position(db, 'p1');
      entryIntent(db, 'i1', 'p1');
      decision(db, 'i1');
      token(db, 't1', 'i1', 'p1');
      refused(db, null, CONSUME, T - 1n, 1_010n, 't1'); // before it was issued
      write(db, "UPDATE positions SET status = 'open', updated_at = ? WHERE id = 'p1'", T);
      refused(db, /consumed only while/, CONSUME, T, 1_010n, 't1'); // the position already holds its tokens
      exitIntent(db, 'x1', 'p1', 1n);
      decision(db, 'x1');
      token(db, 'tx1', 'x1', 'p1', 'sell', { maxSpend: '200000' });
      closePosition(db, 'p1');
      refused(db, /consumed only while/, CONSUME, T, 1_010n, 'tx1'); // closed in the meantime
      assert.equal(db.get('SELECT count(*) AS n FROM approvals WHERE consumed_at IS NOT NULL')?.['n'], 0n);
    });
  });

  it('an order\'s position must still take it in the token\'s mode, and a buy spends at most its max spend (an exit\'s input is tokens) (review P)', () => {
    withFresh((db) => {
      version(db, 1n);
      position(db, 'p1');
      entryIntent(db, 'i1', 'p1');
      decision(db, 'i1');
      token(db, 't1', 'i1', 'p1');
      consume(db, 't1');
      refused(db, null, INSERT_ORDER, 'o1', 'i1', 't1', 'p1', 'paper', 'buy', 'approved', HEX(1), '{}', '50000001', '1000', '50000000', 1_000n, T, T);
      refused(db, null, INSERT_ORDER, 'o1', 'i1', 't1', 'p1', 'paper', 'buy', 'approved', HEX(1), '{}', '100000000', '1000', '50000000', 1_000n, T, T); // longer
      closePosition(db, 'p1');
      refused(db, /a position that may take it/, INSERT_ORDER, 'o1', 'i1', 't1', 'p1', 'paper', 'buy', 'approved', HEX(1), '{}', '50000000', '1000', '50000000', 1_000n, T, T);
    });
    withFresh((db) => {
      version(db, 1n);
      position(db, 'p1');
      entryIntent(db, 'i1', 'p1');
      decision(db, 'i1');
      token(db, 't1', 'i1', 'p1', 'buy', { maxSpend: '10' });
      consume(db, 't1');
      order(db, 'o1', 'i1', 't1', 'p1', 'buy', { maxSpend: '10', inAmount: '9' }); // shorter text, smaller number
      write(db, "UPDATE positions SET status = 'open', updated_at = ? WHERE id = 'p1'", T);
      const x = exitChain(db, 1, 1);
      order(db, `o${x}`, `i${x}`, `t${x}`, 'p1', 'sell', { maxSpend: '200000', inAmount: '18446744073709551615' }); // tokens, not lamports
      assert.equal(count(db, 'orders'), 2n);
    });
  });

  it('one buy order per position, ever; one exit in flight per position; a landed exit makes room for the next', () => {
    withFresh((db) => {
      version(db, 1n);
      buyChain(db, 1);
      orderStatus(db, 'o1', 'failed');
      // a second buy for the same position, even after the first failed
      entryIntent(db, 'i1b', 'p1');
      decision(db, 'i1b');
      token(db, 't1b', 'i1b', 'p1');
      consume(db, 't1b');
      storageError(() => order(db, 'o1b', 'i1b', 't1b', 'p1'), 'constraint');
      write(db, "UPDATE positions SET status = 'open', updated_at = ? WHERE id = 'p1'", T);
      const first = exitChain(db, 1, 1);
      order(db, `o${first}`, `i${first}`, `t${first}`, 'p1', 'sell', { maxSpend: '200000' });
      const second = exitChain(db, 1, 2, 'close-account');
      storageError(() => order(db, `o${second}`, `i${second}`, `t${second}`, 'p1', 'close-account', { maxSpend: '200000' }), 'constraint');
      orderStatus(db, `o${first}`, 'submitted');
      storageError(() => order(db, `o${second}`, `i${second}`, `t${second}`, 'p1', 'close-account', { maxSpend: '200000' }), 'constraint');
      orderStatus(db, `o${first}`, 'landed');
      order(db, `o${second}`, `i${second}`, `t${second}`, 'p1', 'close-account', { maxSpend: '200000' });
      assert.equal(count(db, 'orders'), 3n); // the failed buy, the landed sell, the close
    });
  });

  it('an order\'s status moves forward only, nothing else of it changes, and it is kept', () => {
    withFresh((db) => {
      version(db, 1n);
      buyChain(db, 1);
      refused(db, /forward only/, SET_ORDER_STATUS, 'landed', T, 'o1'); // approved -> landed skips submitted
      orderStatus(db, 'o1', 'submitted');
      refused(db, /forward only/, SET_ORDER_STATUS, 'approved', T, 'o1');
      orderStatus(db, 'o1', 'landed');
      refused(db, /forward only/, SET_ORDER_STATUS, 'failed', T, 'o1');
      for (const set of ["plan_json = '[]'", "in_amount = '1'", "max_spend = '1'", "kind = 'sell'", 'quote_slot = 1', 'created_at = 1']) {
        refused(db, /never changed/, `UPDATE orders SET ${set} WHERE id = 'o1'`);
      }
      write(db, "UPDATE orders SET updated_at = ? WHERE id = 'o1'", T + 9n);
      refused(db, /kept/, "DELETE FROM orders WHERE id = 'o1'");
    });
  });
});

describe('the audit log', () => {
  const row = (id: bigint, at: bigint, prev: string, hash: string, action = 'engine:observe'): SqlParam[] => [id, at, actorOf(action), action, '{}', prev, hash];

  it('rows are appended in order: the next id and the hash before it (the first names the genesis); the time is recorded, not ordered (review P-R1)', () => {
    withFresh((db) => {
      const inOrder = /appended in order/;
      refused(db, inOrder, INSERT_AUDIT, ...row(1n, T, HEX(5), HEX(6))); // the first names the genesis hash
      refused(db, inOrder, INSERT_AUDIT, ...row(2n, T, GENESIS, HEX(6))); // ids start at 1
      refused(db, inOrder, INSERT_AUDIT.replace('(id, ', '(').replace('(?, ', '('), T, 'engine', 'engine:observe', '{}', GENESIS, HEX(6)); // no id: the repository names it
      write(db, INSERT_AUDIT, ...row(1n, T, GENESIS, HEX(6)));
      refused(db, inOrder, INSERT_AUDIT, ...row(3n, T, HEX(6), HEX(7))); // a gap
      refused(db, inOrder, INSERT_AUDIT, ...row(2n ** 63n - 1n, T, HEX(6), HEX(7))); // the largest id would stay "newest" forever (review P, risk 3)
      refused(db, inOrder, INSERT_AUDIT, ...row(1n, T, HEX(6), HEX(7))); // a used id
      refused(db, inOrder, INSERT_AUDIT, ...row(2n, T, GENESIS, HEX(7))); // not the hash before it
      refused(db, inOrder, INSERT_AUDIT, ...row(2n, T, HEX(5), HEX(7)));
      refused(db, /UNIQUE/, INSERT_AUDIT, ...row(2n, T, HEX(6), HEX(6))); // a hash is never reused
      write(db, INSERT_AUDIT, ...row(2n, T - YEAR, HEX(6), HEX(7))); // a year earlier: the clock stepped back, the owner's commands must still go in
      write(db, INSERT_AUDIT, ...row(3n, T, HEX(7), HEX(8))); // the same millisecond as row 1
      assert.deepEqual(db.all('SELECT id, prev_hash, hash FROM audit_log ORDER BY id').map((r) => ({ ...r })), [
        { id: 1n, prev_hash: GENESIS, hash: HEX(6) },
        { id: 2n, prev_hash: HEX(6), hash: HEX(7) },
        { id: 3n, prev_hash: HEX(7), hash: HEX(8) },
      ]);
    });
  });

  it('an action names its actor: server commands only by the owner at the server, owner commands by the owner, engine and AI rows by themselves', () => {
    withFresh((db) => {
      const attempt = (action: string, actor: string): number => db.transaction((tx) => auditTx(tx, action, T, actor));
      const wrong: [string, string][] = [
        ['server:clear-kill', 'owner-telegram'],
        ['server:reset-halt', 'engine'],
        ['owner:resume-peak', 'engine'],
        ['owner:set', 'ai'],
        ['engine:observe', 'owner-server'],
        ['ai:propose', 'engine'],
        ['other:x', 'engine'],
        ['server:x', 'stranger'],
        ['serverx', 'owner-server'],
      ];
      for (const [action, actor] of wrong) {
        storageError(() => attempt(action, actor), 'constraint');
      }
      const right: [string, string][] = [
        ['server:reset-halt', 'owner-server'],
        ['owner:set', 'owner-telegram'],
        ['owner:set', 'owner-server'],
        ['engine:observe', 'engine'],
        ['ai:propose', 'ai'],
      ];
      for (const [action, actor] of right) {
        attempt(action, actor);
      }
      assert.equal(count(db, 'audit_log'), BigInt(right.length));
    });
  });

  it('is append-only, with a code for the action, JSON detail and lower-case sha256 hashes', () => {
    withFresh((db) => {
      audit(db, 'owner:set');
      const first = String(db.get('SELECT hash FROM audit_log WHERE id = 1')?.['hash']);
      const next = (action: string, detail: string, hash: string): SqlParam[] => [2n, T, actorOf(action), action, detail, first, hash];
      refused(db, null, INSERT_AUDIT, ...next('Free text', '{}', HEX(9)));
      refused(db, null, INSERT_AUDIT, ...next('engine:x', '{', HEX(9)));
      refused(db, null, INSERT_AUDIT, ...next('engine:x', '{}', HEX(0xabc).toUpperCase()));
      refused(db, /append-only/, "UPDATE audit_log SET action = 'owner:other'");
      refused(db, /append-only/, 'DELETE FROM audit_log');
      // REPLACE on the hash would delete the old row first: refused with recursive triggers on
      refused(db, /append-only/, INSERT_AUDIT.replace('INSERT', 'INSERT OR REPLACE'), ...next('engine:x', '{}', first));
      assert.equal(count(db, 'audit_log'), 1n);
    });
  });
});
