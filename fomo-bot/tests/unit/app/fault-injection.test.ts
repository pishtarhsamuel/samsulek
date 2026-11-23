// Exhaustive fault injection (STORAGE_DESIGN.md s.16.9, condition C3): a test handle whose first
// transaction hands the callback a Tx that throws a chosen StorageError at its k-th get, all or run.
// For every k over all statements of a successful call, and for full, io, constraint, bad-param and
// busy, each app/ transaction leaves exactly what s.16.5.6 says: the refusal's intent and error
// decision with the class's code (nothing for busy), the disk-db halt for a full disk or an I/O error,
// and never a position, a count, an approval or an order of the call that failed. Written with
// src/app/approve-tx.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { abandonOpeningTx, approveBuyTx, approveExitTx, persistKillTx, recordRefusalTx, type EngineDeps } from '../../../src/app/approve-tx.ts';
import { createEngineAuthority } from '../../../src/app/authority.ts';
import { readHalts } from '../../../src/storage/repo-flags.ts';
import { readPosition } from '../../../src/storage/repo-book.ts';
import { StorageError, type Db, type StorageErrorCode, type Tx } from '../../../src/storage/sqlite.ts';
import { count } from '../storage/helpers.ts';
import { testRng } from './world.ts';
import { entryRequest, exitRequest, openPosition, txWorld, type TxWorld } from './tx-world.ts';

const CODES: readonly StorageErrorCode[] = ['full', 'io', 'constraint', 'bad-param', 'busy'];

/**
 * A handle whose FIRST transaction throws `code` at its k-th get, all or run (k from 1), before the
 * statement runs; later transactions and the plain reads pass through. k = 0 throws nothing: it counts.
 */
function faulty(real: Db, k: number, code: StorageErrorCode): { readonly db: Db; readonly statements: () => number } {
  let n = 0;
  let first = true;
  const db = {
    file: real.file,
    readOnly: false,
    get: (sql: string, ...p: never[]) => real.get(sql, ...p),
    all: (sql: string, ...p: never[]) => real.all(sql, ...p),
    close: () => real.close(),
    transaction: (fn: (tx: Tx) => unknown) => {
      const armed = first;
      first = false;
      return real.transaction((tx) => {
        const hit = (): void => {
          if (armed) {
            n += 1;
            if (n === k) {
              throw new StorageError(code, 'injected by the test');
            }
          }
        };
        const wrapped: Tx = {
          get: (sql, ...p) => {
            hit();
            return tx.get(sql, ...p);
          },
          all: (sql, ...p) => {
            hit();
            return tx.all(sql, ...p);
          },
          run: (sql, ...p) => {
            hit();
            return tx.run(sql, ...p);
          },
          script: (sql) => tx.script(sql),
        };
        return fn(wrapped) as never;
      });
    },
  } as unknown as Db;
  return { db, statements: () => n };
}

/** How many statements a successful call runs in its first transaction. */
function statementsOf(make: () => TxWorld, run: (w: TxWorld, db: Db) => unknown): number {
  const w = make();
  try {
    const probe = faulty(w.db, 0, 'busy');
    run(w, probe.db);
    return probe.statements();
  } finally {
    w.db.close();
  }
}

/** Runs `check` for every k of a successful call and every code, each on a fresh world. */
function sweep(make: () => TxWorld, run: (w: TxWorld, db: Db) => unknown, check: (w: TxWorld, code: StorageErrorCode, k: number, result: unknown) => void): number {
  const total = statementsOf(make, run);
  assert.ok(total >= 1, 'the call runs at least one statement');
  for (let k = 1; k <= total; k += 1) {
    for (const code of CODES) {
      const w = make();
      try {
        const result = run(w, faulty(w.db, k, code).db);
        check(w, code, k, result);
      } catch (e) {
        throw new Error(`k = ${k}, code ${code}: ${e instanceof Error ? e.message : String(e)}`);
      }
      w.db.close();
    }
  }
  return total;
}

const disk = (code: StorageErrorCode): boolean => code === 'full' || code === 'io';
const haltsOf = (w: TxWorld): string[] => readHalts(w.db).map((h) => h.reason);
const withDb = (w: TxWorld, db: Db): EngineDeps => ({ ...w.deps, db });

describe('exhaustive fault injection into the app/ transactions (C3)', () => {
  it('T1 buy: every statement, every class: the refusal or nothing, the disk-db halt on a full disk, never a position, count or approval', () => {
    const n = sweep(
      () => txWorld(),
      (w, db) => approveBuyTx(withDb(w, db), entryRequest()),
      (w, code, _k, result) => {
        const busy = code === 'busy';
        assert.deepEqual(result, { kind: 'error', code: `error:storage-${code}`, scope: disk(code) ? 'latch' : 'intent', recorded: !busy });
        assert.deepEqual(['positions', 'entry_counts', 'approvals', 'orders'].map((t) => count(w.db, t)), [0n, 0n, 0n, 0n]);
        assert.equal(count(w.db, 'intents'), busy ? 0n : 1n);
        if (!busy) {
          const d = w.db.get("SELECT stage, reasons_json FROM risk_decisions WHERE stage = 'error'");
          assert.deepEqual([d?.['stage'], d?.['reasons_json']], ['error', `{"reasons":["error:storage-${code}"]}`]);
        }
        assert.deepEqual(haltsOf(w), disk(code) ? ['disk-db'] : []);
        assert.deepEqual(w.latch.blocked(), disk(code) ? ['storage'] : []);
      },
    );
    assert.ok(n >= 20, `the buy ran ${n} statements`);
  });

  it('T1 exit: a fault before the position is read writes nothing; after it, the refusal uses up the number (busy excepted)', () => {
    const make = (): TxWorld => {
      const w = txWorld();
      openPosition(w.db, 'ps_1');
      return w;
    };
    const n = sweep(
      make,
      (w, db) => approveExitTx(withDb(w, db), exitRequest(w.deps, 'ps_1')),
      (w, code, k, result) => {
        const busy = code === 'busy';
        if (k === 1) {
          // the first statement reads the position
          assert.deepEqual(result, { kind: 'not-run', code: `error:storage-${code}` });
          assert.equal(readPosition(w.db, 'ps_1').exitSeq, 0);
          assert.equal(count(w.db, 'intents'), 0n);
        } else {
          assert.deepEqual(result, { kind: 'error', code: `error:storage-${code}`, scope: disk(code) ? 'latch' : 'intent', recorded: !busy });
          assert.equal(readPosition(w.db, 'ps_1').exitSeq, busy ? 0 : 1);
          assert.equal(count(w.db, 'intents'), busy ? 0n : 1n);
        }
        assert.deepEqual(['approvals', 'orders'].map((t) => count(w.db, t)), [0n, 0n]);
        assert.deepEqual(haltsOf(w), disk(code) ? ['disk-db'] : []);
      },
    );
    assert.ok(n >= 8, `the exit ran ${n} statements`);
  });

  it('T2: a fault in the token store refuses the redeem and writes no order; the token stays unused', () => {
    const make = (): TxWorld => txWorld();
    const run = (w: TxWorld, db: Db): unknown => {
      // a second authority whose token store is bound to the faulty handle; T1 runs on the real one
      const a = createEngineAuthority({ db, clock: w.clock, slots: w.deps.slots, rng: testRng(), faults: w.deps.faults, latch: w.latch, sentinel: w.sentinel });
      const o = approveBuyTx({ ...w.deps, issuer: a.issuer }, entryRequest());
      assert.equal(o.kind, 'approved');
      return o.kind === 'approved' ? a.redeemer.redeem(o.token, o.plan) : null;
    };
    const n = sweep(make, run, (w, code, _k, result) => {
      assert.equal((result as { ok: boolean }).ok, false, code);
      assert.equal(count(w.db, 'orders'), 0n);
      assert.equal(w.db.get('SELECT consumed_at FROM approvals')?.['consumed_at'], null);
      assert.deepEqual(haltsOf(w), disk(code) ? ['disk-db'] : []);
    });
    assert.ok(n >= 5, `the redeem ran ${n} statements`);
  });

  it('abandon: a fault leaves the opening as it was', () => {
    const make = (): TxWorld => {
      const w = txWorld();
      assert.equal(approveBuyTx(w.deps, entryRequest()).kind, 'approved');
      w.slot.value = 1_026n;
      return w;
    };
    const n = sweep(
      make,
      (w, db) => abandonOpeningTx({ ...w.store, db }, 'ps_new1'),
      (w, code, _k, result) => {
        assert.deepEqual(result, { kind: 'error', code: `error:storage-${code}` });
        assert.equal(readPosition(w.db, 'ps_new1').status, 'opening');
        assert.deepEqual(haltsOf(w), disk(code) ? ['disk-db'] : []);
      },
    );
    assert.ok(n >= 3, `the abandon ran ${n} statements`);
  });

  it('the refusal record and KILL: a fault writes nothing of theirs and latches entries', () => {
    const refusal = sweep(
      () => txWorld(),
      (w, db) => recordRefusalTx(withDb(w, db), { kind: 'entry', req: entryRequest() }, 'error:storage-busy', null),
      (w, code, _k, result) => {
        assert.equal(result, 'failed');
        assert.equal(count(w.db, 'intents'), 0n);
        assert.ok(w.latch.blocked().includes('refusal-write-failed'), code);
      },
    );
    const kill = sweep(
      () => txWorld(),
      (w, db) => persistKillTx({ ...w.store, db }, 'sentinel'),
      (w, code, _k, result) => {
        assert.equal(result, 'failed');
        assert.equal(w.db.get('SELECT kill FROM flags')?.['kill'], 0n);
        assert.ok(w.latch.blocked().includes('kill-write-failed'), code);
        assert.equal(w.latch.killSeen(), true);
      },
    );
    assert.ok(refusal >= 3 && kill >= 2, `${refusal} and ${kill} statements`);
  });
});
