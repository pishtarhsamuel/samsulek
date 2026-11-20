// T1, the approval transactions (STORAGE_DESIGN.md s.16.5 and s.16.9; review T's conditions for 6d-2
// in s.16.14). A buy writes exactly its intent, its opening position, the day's count, its decision
// and its approval, in one transaction, and returns the token only after COMMIT; a refusal records
// its stage and reasons; a duplicate or a latched entry writes nothing. An exit reads no flag, re-reads
// every exit fact inside the transaction, and writes nothing before its position is read. Every throw
// is recorded as an error with `inputs: {}` and its code. Written before src/app/approve-tx.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXIT_SEQ_ALERT,
  abandonOpeningTx,
  approveBuyTx,
  approveExitTx,
  entryIntentId,
  exitIntentId,
  peekExitIntent,
  persistHaltTx,
  persistKillTx,
  recordRefusalTx,
  type EngineDeps,
  type EntryOutcome,
  type EntryRequest,
  type ExitOutcome,
} from '../../../src/app/approve-tx.ts';
import { classify } from '../../../src/app/faults.ts';
import { readBuySnapshot } from '../../../src/app/snapshot.ts';
import { hexOf } from '../../../src/core/encode.ts';
import { lamports } from '../../../src/core/units.ts';
import { approveBuy, type ActivePosition } from '../../../src/risk/approve.ts';
import { readFlags, readHalts, setHalt, setKill, setPaused } from '../../../src/storage/repo-flags.ts';
import { readPosition } from '../../../src/storage/repo-book.ts';
import { StorageError, type Db, type Tx } from '../../../src/storage/sqlite.ts';
import { count, dump } from '../storage/helpers.ts';
import { T, testKeyBytes } from './world.ts';
import { EXIT_MARKET, MARKET, RENT, SLOT, WINDOW, entryRequest, exitRequest, openPosition, txWorld, type TxWorld } from './tx-world.ts';

function withWorld(fn: (w: TxWorld) => void): void {
  const w = txWorld();
  try {
    fn(w);
  } finally {
    w.db.close();
  }
}

const one = (db: Db, sql: string, ...params: (string | bigint)[]) => db.get(sql, ...params);
const approved = (o: EntryOutcome) => {
  assert.equal(o.kind, 'approved', JSON.stringify(o, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
  return o as Extract<EntryOutcome, { kind: 'approved' }>;
};
const exitApproved = (o: ExitOutcome) => {
  assert.equal(o.kind, 'approved', JSON.stringify(o, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
  return o as Extract<ExitOutcome, { kind: 'approved' }>;
};
const decisionOf = (db: Db, intentId: string) => one(db, 'SELECT approved, stage, reasons_json, slot, config_version FROM risk_decisions WHERE intent_id = ?', intentId);

describe('the intent ids', () => {
  it("an entry is named by strategy, mint and window; an exit by position and number: 'en_' or 'ex_' and 40 hex", () => {
    const id = entryIntentId('momentum', 'MintA', WINDOW);
    assert.match(id, /^en_[0-9a-f]{40}$/);
    assert.equal(entryIntentId('momentum', 'MintA', WINDOW), id);
    assert.notEqual(entryIntentId('crowdflow', 'MintA', WINDOW), id);
    assert.notEqual(entryIntentId('momentum', 'MintB', WINDOW), id);
    assert.notEqual(entryIntentId('momentum', 'MintA', WINDOW + 1), id);
    const ex = exitIntentId('ps_1', 0);
    assert.match(ex, /^ex_[0-9a-f]{40}$/);
    assert.notEqual(exitIntentId('ps_1', 1), ex);
    assert.notEqual(exitIntentId('ps_2', 0), ex);
    assert.equal(exitIntentId('ps_1', 999_999).length, 43);
    for (const bad of [
      () => entryIntentId('copy' as 'momentum', 'MintA', WINDOW),
      () => entryIntentId('momentum', 'bad mint', WINDOW),
      () => entryIntentId('momentum', 'MintA', 1.5),
      () => exitIntentId('bad id', 0),
      () => exitIntentId('ps_1', -1),
      () => exitIntentId('ps_1', 1_000_000),
    ]) {
      assert.throws(bad, (e: unknown) => classify(e).code === 'error:bad-request');
    }
  });
});

describe('T1 buy: an approved entry', () => {
  it('writes exactly the intent, the opening position, the count, the decision and the approval; the token comes after COMMIT', () => {
    withWorld((w) => {
      const req = entryRequest();
      const o = approved(approveBuyTx(w.deps, req));
      assert.equal(o.intentId, req.plan.intentId);
      assert.equal(o.positionId, 'ps_new1');
      assert.equal(o.token.intentId, o.intentId);
      assert.equal(o.token.expiresAtSlot, 1_025n);
      assert.deepEqual(
        ['intents', 'positions', 'entry_counts', 'risk_decisions', 'approvals', 'orders'].map((t) => count(w.db, t)),
        [1n, 1n, 1n, 1n, 1n, 0n],
      );
      const p = readPosition(w.db, 'ps_new1');
      assert.equal(p.status, 'opening');
      assert.equal(p.p95ExitCost, 125_000n, "the stored p95 is the market's (C50)");
      assert.equal(p.mode, 'paper');
      const d = decisionOf(w.db, o.intentId);
      assert.deepEqual([d?.['approved'], d?.['stage'], d?.['slot'], d?.['config_version']], [1n, null, SLOT, 1n]);
      assert.equal(one(w.db, 'SELECT count FROM entry_counts')?.['count'], 1n);
      assert.ok(!dump(w.db).includes(o.token.mac), 'the MAC is in no cell');
      // T2 through the real redeemer: the order is written from the validated snapshot
      const r = w.authority.redeemer.redeem(o.token, o.plan);
      assert.equal(r.ok, true);
      assert.equal(count(w.db, 'orders'), 1n);
    });
  });

  it("the identity's wallet, token account and wSOL mint override the market's (s.16.1)", () => {
    withWorld((w) => {
      const sneaky = { ...MARKET, wallet: 'EvilWallet', ownTokenAccount: 'EvilAta', wsolMint: 'EvilMint' } as EntryRequest['market'];
      approved(approveBuyTx(w.deps, entryRequest({ market: sneaky })));
    });
    withWorld((w) => {
      const o = approveBuyTx(w.deps, entryRequest({}, { wallet: 'EvilWallet' }));
      assert.equal(o.kind, 'refused');
      assert.deepEqual(o.kind === 'refused' ? [o.stage, [...o.reasons]] : null, ['plan', ['plan:foreign-wallet']]);
    });
  });

  it('a repeat of the same entry is a duplicate: nothing written', () => {
    withWorld((w) => {
      approved(approveBuyTx(w.deps, entryRequest()));
      const before = dump(w.db);
      const again = approveBuyTx(w.deps, entryRequest({ positionId: 'ps_new2' }));
      assert.deepEqual({ ...again }, { kind: 'duplicate', intentId: entryIntentId('momentum', 'MintA', WINDOW) });
      assert.equal(dump(w.db), before);
    });
  });
});

describe('T1 buy: refusals and errors are recorded', () => {
  it('each refusal stage with its reasons, and nothing else', () => {
    withWorld((w) => {
      const blocked = approveBuyTx(w.deps, entryRequest({ strategy: 'launch' })); // launch is off
      assert.equal(blocked.kind, 'refused');
      const sizing = approveBuyTx(w.deps, entryRequest({ mint: 'MintB', market: { ...MARKET, poolMinTrade: lamports(60_000_001n) } }));
      const plan = approveBuyTx(w.deps, entryRequest({ mint: 'MintC' }, { slippageBps: 301 as never }));
      const got = [blocked, sizing, plan].map((o) => (o.kind === 'refused' ? [o.stage, o.reasons[0]] : o.kind));
      assert.deepEqual(got, [
        ['blocked', 'strategy-off'],
        ['sizing', 'sizing:below-minimum'],
        ['plan', 'plan:slippage-above-cap'],
      ]);
      assert.deepEqual(['intents', 'risk_decisions', 'positions', 'entry_counts', 'approvals'].map((t) => count(w.db, t)), [3n, 3n, 0n, 0n, 0n]);
      for (const o of [blocked, sizing, plan]) {
        const d = decisionOf(w.db, (o as { intentId: string }).intentId);
        assert.equal(d?.['approved'], 0n);
        assert.equal(d?.['slot'], SLOT);
      }
    });
  });

  it('while entries are latched nothing is written and the database is not touched', () => {
    withWorld((w) => {
      w.latch.set('storage');
      const untouchable = new Proxy({}, { get: () => assert.fail('the database was touched') }) as unknown as Db;
      const o = approveBuyTx({ ...w.deps, db: untouchable }, entryRequest());
      assert.equal(o.kind, 'not-run');
      assert.deepEqual(o.kind === 'not-run' ? [...o.latched] : null, ['storage']);
    });
  });

  it('the KILL file: KILL stored (sentinel) and seen first, then this entry recorded as blocked: kill (C25)', () => {
    withWorld((w) => {
      w.sentinel.on = true;
      const o = approveBuyTx(w.deps, entryRequest());
      assert.equal(o.kind, 'refused');
      assert.ok(o.kind === 'refused' && o.reasons.includes('kill'));
      assert.equal(readFlags(w.db).kill?.source, 'sentinel');
      assert.equal(w.latch.killSeen(), true);
      assert.equal(count(w.db, 'positions'), 0n);
    });
  });

  it('a KILL another process stored refuses the entry, and the latch marks it after COMMIT', () => {
    withWorld((w) => {
      w.db.transaction((tx) => setKill(tx, T - 5, 'cli'));
      const o = approveBuyTx(w.deps, entryRequest());
      assert.ok(o.kind === 'refused' && o.reasons.includes('kill'));
      assert.equal(w.latch.killSeen(), true);
    });
  });

  it('a live request, an unknown rent and a p95 exit cost below the base fee are recorded errors (C46, C50)', () => {
    withWorld((w) => {
      const live = approveBuyTx(w.deps, entryRequest({ mode: 'live' as 'paper' }));
      assert.deepEqual({ ...live }, { kind: 'error', code: 'error:live-not-built', scope: 'intent', recorded: true });
      w.rent.value = null;
      const rent = approveBuyTx(w.deps, entryRequest({ mint: 'MintB' }));
      assert.deepEqual({ ...rent }, { kind: 'error', code: 'error:rent-unknown', scope: 'intent', recorded: true });
      w.rent.value = RENT;
      const p95 = approveBuyTx(w.deps, entryRequest({ mint: 'MintC', market: { ...MARKET, newPositionP95ExitCost: lamports(4_999n) } }));
      assert.deepEqual({ ...p95 }, { kind: 'error', code: 'error:p95-below-base-fee', scope: 'intent', recorded: true });
      approved(approveBuyTx(w.deps, entryRequest({ mint: 'MintD', market: { ...MARKET, newPositionP95ExitCost: lamports(5_000n) } })));
      const rows = w.db.all("SELECT i.mode, i.reasons_json, i.inputs_json, d.stage, d.reasons_json AS d_reasons, d.slot FROM intents AS i JOIN risk_decisions AS d ON d.intent_id = i.id WHERE d.stage = 'error' ORDER BY i.created_at, i.id");
      assert.deepEqual(
        rows.map((r) => [r['mode'], r['reasons_json'], r['inputs_json'], r['d_reasons'], r['slot']]).sort(),
        [
          ['live', '{"reasons":["error:live-not-built"]}', '{}', '{"reasons":["error:live-not-built"]}', 0n],
          ['paper', '{"reasons":["error:p95-below-base-fee"]}', '{}', '{"reasons":["error:p95-below-base-fee"]}', 0n],
          ['paper', '{"reasons":["error:rent-unknown"]}', '{}', '{"reasons":["error:rent-unknown"]}', 0n],
        ],
      );
    });
  });

  it('an unknown slot is recorded with slot 0; a slot that was read is recorded as read (C47)', () => {
    withWorld((w) => {
      w.slot.value = null;
      const o = approveBuyTx(w.deps, entryRequest());
      assert.deepEqual({ ...o }, { kind: 'error', code: 'error:slot-unknown', scope: 'intent', recorded: true });
      assert.equal(decisionOf(w.db, entryIntentId('momentum', 'MintA', WINDOW))?.['slot'], 0n);
      w.slot.value = SLOT;
      // an error after the slot was read keeps it: a plan that is not an object makes risk throw
      const bad = approveBuyTx(w.deps, entryRequest({ mint: 'MintB', plan: null as never }));
      assert.equal(bad.kind, 'error');
      assert.equal(decisionOf(w.db, entryIntentId('momentum', 'MintB', WINDOW))?.['slot'], SLOT);
    });
  });

  it('a malformed request is an error that cannot be recorded: nothing written', () => {
    withWorld((w) => {
      const before = dump(w.db);
      for (const req of [null, { ...entryRequest(), strategy: 'copy' }, { ...entryRequest(), mode: 'demo' }, { ...entryRequest(), market: null }]) {
        const o = approveBuyTx(w.deps, req as never);
        assert.deepEqual({ ...o }, { kind: 'error', code: 'error:bad-request', scope: 'intent', recorded: false });
      }
      assert.equal(dump(w.db), before);
    });
  });

  it('a secret-looking input is refused by the filter and the entry recorded without its inputs', () => {
    withWorld((w) => {
      const secret = hexOf(testKeyBytes(1)); // the approval key, registered as an own secret
      const o = approveBuyTx(w.deps, entryRequest({ inputs: { venue: secret } }));
      assert.deepEqual({ ...o }, { kind: 'error', code: 'error:storage-bad-param', scope: 'intent', recorded: true });
      assert.ok(!dump(w.db).includes(secret));
      assert.ok(w.alerts.seen.some((a) => a.code === 'error:storage-bad-param' && a.severity === 'warn'));
    });
  });

  it("the day's count that moved inside the transaction latches entries as a bug, and nothing of the entry stays", () => {
    withWorld((w) => {
      // a Tx that counts the day's entry twice: the count moved under the transaction's feet
      const doubled = {
        transaction: (fn: (tx: Tx) => unknown) =>
          w.db.transaction((tx) => {
            const twice: Tx = {
              get: (sql, ...p) => tx.get(sql, ...p),
              all: (sql, ...p) => tx.all(sql, ...p),
              run: (sql, ...p) => {
                const n = tx.run(sql, ...p);
                if (sql.startsWith('INSERT INTO entry_counts')) {
                  tx.run(sql, ...p);
                }
                return n;
              },
              script: (sql) => tx.script(sql),
            };
            return fn(twice) as never;
          }),
      } as unknown as Db;
      const o = approveBuyTx({ ...w.deps, db: doubled }, entryRequest());
      assert.deepEqual({ ...o }, { kind: 'error', code: 'error:entry-count-mismatch', scope: 'latch', recorded: true });
      assert.deepEqual(w.latch.blocked(), ['bug']);
      assert.deepEqual(['positions', 'entry_counts', 'approvals'].map((t) => count(w.db, t)), [0n, 0n, 0n]);
    });
  });

  it('a COMMIT whose outcome is unknown never returns a token: fatal, onFatal once (review T, security on s.16.5)', () => {
    withWorld((w) => {
      const unknownCommit = {
        transaction: (fn: (tx: Tx) => unknown) => {
          w.db.transaction((tx) => fn(tx) as never);
          throw new StorageError('poisoned', 'the COMMIT outcome is unknown');
        },
      } as unknown as Db;
      const deps: EngineDeps = { ...w.deps, db: unknownCommit };
      const o = approveBuyTx(deps, entryRequest());
      assert.deepEqual({ ...o }, { kind: 'error', code: 'error:storage-poisoned', scope: 'fatal', recorded: false });
      assert.ok(!('token' in o));
      assert.deepEqual(w.fatal, ['error:storage-poisoned']);
      assert.ok(w.latch.blocked().includes('storage'));
      assert.ok(w.latch.blocked().includes('refusal-write-failed'), 'the refusal could not be recorded either');
    });
  });

  it("risk's words for impossible position lists are bugs (review T, risk 4): pinned against risk's own throws", () => {
    withWorld((w) => {
      const req = entryRequest();
      const snap = w.db.transaction((tx) => readBuySnapshot(tx, { now: T, slot: SLOT, mode: 'paper', marks: new Map(), breakers: [], wsolHelperRent: RENT, killSeen: false }));
      const pos = (id: string, mint: string): ActivePosition => ({ id, mint, strategy: 'momentum', p95ExitCost: lamports(125_000n), status: 'open', value: lamports(1n) });
      const many = Array.from({ length: 1_001 }, (_v, i) => pos(`ps_${i}`, `Mint${i}`));
      const odd = (patch: Record<string, unknown>): ActivePosition => ({ ...pos('ps_a', 'MintX'), ...patch }) as unknown as ActivePosition;
      const lists: readonly (readonly ActivePosition[])[] = [
        many,
        [odd({ strategy: 'copy' })],
        [odd({ status: 'closed' })],
        [pos('ps_a', 'MintX'), pos('ps_a', 'MintY')],
        [pos('ps_a', 'MintX'), pos('ps_b', 'MintX')],
        [odd({ status: 'opening' })], // an opening position with a value instead of its maxSpend
      ];
      for (const positions of lists) {
        const input = { intent: { strategy: req.strategy, mode: 'paper' as const, mint: req.mint, creator: req.creator, sizeHint: req.sizeHint, positionId: req.positionId, intentId: req.plan.intentId }, plan: req.plan, world: { ...snap.world, positions }, market: { ...MARKET, wallet: 'OurWallet', ownTokenAccount: 'AtaOfMintA', wsolMint: 'So11111111111111111111111111111111111111112' }, caps: snap.caps };
        assert.throws(
          () => approveBuy(input, w.authority.issuer),
          (e: unknown) => classify(e).bug && classify(e).code === 'error:risk',
          `positions ${positions.length}`,
        );
      }
    });
  });
});

describe('T1 exit', () => {
  it('approved: the exit intent uses up the number, the decision and the token; mint and mode come from the position', () => {
    withWorld((w) => {
      openPosition(w.db, 'ps_1');
      const o = exitApproved(approveExitTx(w.deps, exitRequest(w.deps, 'ps_1')));
      assert.equal(o.exitSeq, 0);
      assert.equal(o.intentId, exitIntentId('ps_1', 0));
      assert.equal(o.token.kind, 'sell');
      assert.equal(readPosition(w.db, 'ps_1').exitSeq, 1);
      const i = one(w.db, 'SELECT kind, mode, mint, exit_seq FROM intents WHERE id = ?', o.intentId);
      assert.deepEqual([i?.['kind'], i?.['mode'], i?.['mint'], i?.['exit_seq']], ['exit', 'paper', 'MintA', 0n]);
      assert.equal(decisionOf(w.db, o.intentId)?.['approved'], 1n);
      assert.equal(w.authority.redeemer.redeem(o.token, o.plan).ok, true);
      assert.deepEqual(peekExitIntent(w.deps, 'ps_1'), { intentId: exitIntentId('ps_1', 1), exitSeq: 1 });
    });
  });

  it('refused: the number is used up too, and the owner is told (review T, risk 4)', () => {
    withWorld((w) => {
      openPosition(w.db, 'ps_1');
      const o = approveExitTx(w.deps, exitRequest(w.deps, 'ps_1', {}, { slippageBps: 600 as never }));
      assert.deepEqual(o.kind === 'refused' ? [o.exitSeq, [...o.problems]] : o, [0, ['slippage-above-cap']]);
      assert.equal(readPosition(w.db, 'ps_1').exitSeq, 1);
      assert.equal(decisionOf(w.db, exitIntentId('ps_1', 0))?.['reasons_json'], '{"reasons":["plan:slippage-above-cap"]}');
      assert.deepEqual(w.alerts.seen.at(-1), { code: 'exit-refused', severity: 'warn', codes: ['ps_1', 'plan:slippage-above-cap'] });
    });
  });

  it("a plan built for a stale number is refused plan:wrong-intent and uses that number up", () => {
    withWorld((w) => {
      openPosition(w.db, 'ps_1');
      const stale = exitRequest(w.deps, 'ps_1');
      approveExitTx(w.deps, exitRequest(w.deps, 'ps_1', {}, { slippageBps: 600 as never })); // uses number 0
      const o = approveExitTx(w.deps, stale);
      assert.ok(o.kind === 'refused' && o.problems.includes('wrong-intent'));
      assert.equal(readPosition(w.db, 'ps_1').exitSeq, 2);
    });
  });

  it('an unused exit token that is still valid blocks a second exit; an expired one does not; a used one counts as its order (C51)', () => {
    withWorld((w) => {
      openPosition(w.db, 'ps_1');
      const first = exitApproved(approveExitTx(w.deps, exitRequest(w.deps, 'ps_1')));
      const second = approveExitTx(w.deps, exitRequest(w.deps, 'ps_1', {}, { orderId: 'order-9' }));
      assert.ok(second.kind === 'refused' && second.problems.includes('exit-in-flight'));
      // the first token expires at 1,025: past it, a fresh quote passes
      w.slot.value = 1_026n;
      const market = { ...EXIT_MARKET, quote: { ...EXIT_MARKET.quote, slot: 1_026n, feeConfigSlot: 1_020n } };
      const third = exitApproved(approveExitTx(w.deps, exitRequest(w.deps, 'ps_1', { market }, { orderId: 'order-10', quoteSlot: 1_026n, feeConfigSlot: 1_020n })));
      assert.equal(third.exitSeq, 2);
      assert.equal(w.authority.redeemer.redeem(third.token, third.plan).ok, true); // now an order in flight
      const fourth = approveExitTx(w.deps, exitRequest(w.deps, 'ps_1', { market }, { orderId: 'order-11', quoteSlot: 1_026n, feeConfigSlot: 1_020n }));
      assert.ok(fourth.kind === 'refused' && fourth.problems.includes('exit-in-flight'));
      assert.equal(first.exitSeq, 0);
    });
  });

  it('no flag stops an exit: KILL, a halt, the pause, the latch and the KILL file (s.9)', () => {
    withWorld((w) => {
      openPosition(w.db, 'ps_1');
      w.db.transaction((tx) => {
        setKill(tx, T - 3, 'cli');
        setHalt(tx, 'disk-db', T - 2);
        setPaused(tx, T - 1);
      });
      w.latch.set('storage');
      w.latch.markKill();
      w.sentinel.on = true;
      exitApproved(approveExitTx(w.deps, exitRequest(w.deps, 'ps_1')));
    });
  });

  it("an owner's exit, and an unknown slot, run nothing: no exit number used, even after an hour of retries (review T, risk 5)", () => {
    withWorld((w) => {
      openPosition(w.db, 'ps_1');
      const before = dump(w.db);
      const owner = approveExitTx(w.deps, { ...exitRequest(w.deps, 'ps_1'), origin: { kind: 'owner' } as never });
      assert.deepEqual({ ...owner }, { kind: 'not-run', code: 'error:bad-request' });
      w.slot.value = null;
      for (let s = 0; s < 3_600; s += 2) {
        const o = approveExitTx(w.deps, exitRequest(w.deps, 'ps_1'));
        assert.deepEqual({ ...o }, { kind: 'not-run', code: 'error:slot-unknown' });
        w.clock.advance(2_000);
      }
      assert.equal(dump(w.db), before);
      assert.equal(readPosition(w.db, 'ps_1').exitSeq, 0);
      const slotAlerts = w.alerts.seen.filter((a) => a.code === 'error:slot-unknown').length;
      assert.ok(slotAlerts >= 60 && slotAlerts <= 61, `once a minute: ${slotAlerts}`);
      const blocked = w.alerts.seen.filter((a) => a.code === 'exit-blocked').length;
      assert.ok(blocked >= 6 && blocked <= 7, `once in ten minutes: ${blocked}`);
    });
  });

  it('the fee budget of automatic exits: 3,375,000 lamports over the position life, never 3,380,000 (C55, review L)', () => {
    withWorld((w) => {
      openPosition(w.db, 'ps_1');
      openPosition(w.db, 'ps_2', 'MintB');
      openPosition(w.db, 'ps_3', 'MintC');
      // the plan's worst fees: 3 attempts x 66,000
      const fees = (id: string, failed: bigint): void => {
        w.db.transaction((tx) => tx.run('UPDATE positions SET failed_fees = ?, cost_basis = ? WHERE id = ?', failed.toString(), failed.toString(), id));
      };
      fees('ps_1', 3_375_000n - 198_000n); // exactly the plan's fees left
      fees('ps_2', 3_375_000n - 198_000n + 1n);
      fees('ps_3', 3_375_000n);
      exitApproved(approveExitTx(w.deps, exitRequest(w.deps, 'ps_1')));
      const short = approveExitTx(w.deps, exitRequest(w.deps, 'ps_2', {}, { mint: 'MintB', tokenAccount: 'AtaOfMintB' }));
      assert.ok(short.kind === 'refused' && short.problems.includes('exit-fee-budget'));
      const none = approveExitTx(w.deps, exitRequest(w.deps, 'ps_3', {}, { mint: 'MintC', tokenAccount: 'AtaOfMintC' }));
      assert.ok(none.kind === 'refused' && none.problems.includes('auto-exits-stopped'));
      assert.deepEqual(
        w.alerts.seen.filter((a) => a.code === 'exit-fee-budget').map((a) => a.codes),
        [['ps_2'], ['ps_3']],
        'risk 8: a refusal for the fee budget says so',
      );
    });
  });

  it('a secret-looking input of the exit planner alerts as a bug and the sale goes ahead without it (review T, security on D1; C31)', () => {
    withWorld((w) => {
      openPosition(w.db, 'ps_1');
      const secret = hexOf(testKeyBytes(1));
      const o = exitApproved(approveExitTx(w.deps, exitRequest(w.deps, 'ps_1', { inputs: { why: secret } })));
      assert.equal(o.exitSeq, 0);
      assert.ok(w.alerts.seen.some((a) => a.code === 'exit-inputs-refused' && a.severity === 'bug'));
      const i = one(w.db, 'SELECT reasons_json, inputs_json FROM intents WHERE id = ?', o.intentId);
      assert.deepEqual([i?.['reasons_json'], i?.['inputs_json']], ['{"reasons":["inputs-refused"]}', '{}']);
      assert.ok(!dump(w.db).includes(secret));
    });
  });

  it('an error after the position was read is recorded and uses up the number; a missing position runs nothing', () => {
    withWorld((w) => {
      openPosition(w.db, 'ps_1');
      const o = approveExitTx(w.deps, exitRequest(w.deps, 'ps_1', { plan: null as never }));
      assert.deepEqual({ ...o }, { kind: 'error', code: 'error:risk', scope: 'intent', recorded: true });
      assert.equal(readPosition(w.db, 'ps_1').exitSeq, 1);
      const r = one(w.db, 'SELECT reasons_json, inputs_json FROM intents WHERE id = ?', exitIntentId('ps_1', 0));
      assert.deepEqual([r?.['reasons_json'], r?.['inputs_json']], ['{"reasons":["error:risk"]}', '{}']);
      assert.equal(decisionOf(w.db, exitIntentId('ps_1', 0))?.['slot'], SLOT);
      const before = dump(w.db);
      const missing = approveExitTx(w.deps, { ...exitRequest(w.deps, 'ps_1'), positionId: 'ps_none' });
      assert.deepEqual({ ...missing }, { kind: 'not-run', code: 'error:storage-row-missing' });
      assert.equal(dump(w.db), before);
    });
  });

  it('exit number 10,000 warns (C53)', () => {
    withWorld((w) => {
      openPosition(w.db, 'ps_1');
      w.db.transaction((tx) => tx.run("UPDATE positions SET exit_seq = 9999 WHERE id = 'ps_1'"));
      exitApproved(approveExitTx(w.deps, exitRequest(w.deps, 'ps_1')));
      assert.equal(EXIT_SEQ_ALERT, 10_000);
      assert.deepEqual(w.alerts.seen.at(-1), { code: 'exit-seq-high', severity: 'warn', codes: ['ps_1'] });
    });
  });
});

describe('abandoning an opening position', () => {
  it('only once its buy token expired and only without a buy order, at max(now, opened_at) (C48; review T, security 3)', () => {
    withWorld((w) => {
      const o = approved(approveBuyTx(w.deps, entryRequest()));
      const valid = abandonOpeningTx(w.store, 'ps_new1');
      assert.deepEqual({ ...valid }, { kind: 'error', code: 'error:abandon-token-valid' });
      w.slot.value = 1_025n;
      assert.equal(abandonOpeningTx(w.store, 'ps_new1').kind, 'error', 'still valid at its expiry slot');
      w.slot.value = 1_026n;
      w.clock.set(T - 60_000); // a clock behind the opening: booked at opened_at
      const done = abandonOpeningTx(w.store, 'ps_new1');
      assert.deepEqual({ ...done }, { kind: 'abandoned', at: T });
      assert.equal(readPosition(w.db, 'ps_new1').status, 'closed');
      assert.equal(w.authority.redeemer.redeem(o.token, o.plan).ok, false, 'the token is past its expiry, and its position closed');
      w.slot.value = null;
      assert.deepEqual({ ...abandonOpeningTx(w.store, 'ps_new1') }, { kind: 'error', code: 'error:slot-unknown' });
    });
  });

  it('a position with a buy order, whatever its status, is never abandoned before T3', () => {
    for (const status of ['approved', 'submitted', 'landed', 'failed', 'expired']) {
      withWorld((w) => {
        const o = approved(approveBuyTx(w.deps, entryRequest()));
        assert.equal(w.authority.redeemer.redeem(o.token, o.plan).ok, true);
        // statuses only move forward: approved, then submitted, then landed, failed or expired
        for (const step of status === 'approved' ? [] : status === 'submitted' ? ['submitted'] : ['submitted', status]) {
          w.db.transaction((tx) => tx.run('UPDATE orders SET status = ? WHERE position_id = ?', step, 'ps_new1'));
        }
        w.slot.value = 2_000n;
        assert.deepEqual({ ...abandonOpeningTx(w.store, 'ps_new1') }, { kind: 'error', code: 'error:abandon-needs-settlement' }, status);
        assert.equal(readPosition(w.db, 'ps_new1').status, 'opening');
      });
    }
  });
});

describe('the small writes: the refusal record, KILL and halts', () => {
  it('recordRefusalTx: one code, no inputs, slot 0 only for an unknown slot; a duplicate; its own failure latches', () => {
    withWorld((w) => {
      const req = entryRequest();
      assert.equal(recordRefusalTx(w.deps, { kind: 'entry', req }, 'error:storage-busy', null), 'recorded');
      assert.equal(recordRefusalTx(w.deps, { kind: 'entry', req }, 'error:storage-busy', SLOT), 'duplicate');
      assert.equal(decisionOf(w.db, req.plan.intentId)?.['slot'], 0n);
      openPosition(w.db, 'ps_1');
      assert.equal(recordRefusalTx(w.deps, { kind: 'exit', req: exitRequest(w.deps, 'ps_1') }, 'error:risk', SLOT), 'recorded');
      assert.equal(decisionOf(w.db, exitIntentId('ps_1', 0))?.['slot'], SLOT);
      assert.equal(readPosition(w.db, 'ps_1').exitSeq, 1);
      assert.deepEqual(w.latch.blocked(), []);
      w.db.close();
      assert.equal(recordRefusalTx(w.deps, { kind: 'entry', req: entryRequest({ mint: 'MintB' }) }, 'error:risk', null), 'failed');
      assert.deepEqual(w.latch.blocked(), ['refusal-write-failed', 'storage']);
      assert.ok(w.alerts.seen.some((a) => a.code === 'refusal-write-failed'));
    });
  });

  it('persistKillTx: set, then already; KILL is seen either way; a failure latches and alerts', () => {
    withWorld((w) => {
      assert.equal(persistKillTx(w.store, 'sentinel'), 'set');
      assert.equal(persistKillTx(w.store, 'cli'), 'already');
      assert.equal(readFlags(w.db).kill?.source, 'sentinel');
      assert.equal(w.latch.killSeen(), true);
      w.db.close();
      const other = txWorld();
      other.db.close();
      assert.equal(persistKillTx(other.store, 'cli'), 'failed');
      assert.ok(other.latch.blocked().includes('kill-write-failed'));
      assert.equal(other.latch.killSeen(), true);
      assert.ok(other.alerts.seen.some((a) => a.code === 'kill-write-failed' && a.severity === 'fatal'));
    });
  });

  it('persistHaltTx: set, then already; a failure latches and alerts without asking for the halt again', () => {
    withWorld((w) => {
      assert.equal(persistHaltTx(w.store, 'disk-db'), 'set');
      assert.equal(persistHaltTx(w.store, 'disk-db'), 'already');
      assert.deepEqual(readHalts(w.db).map((h) => h.reason), ['disk-db']);
      w.db.close();
      assert.equal(persistHaltTx(w.store, 'disk-db'), 'failed');
      assert.ok(w.latch.blocked().includes('halt-write-failed'));
      assert.deepEqual(
        w.alerts.seen.filter((a) => a.code === 'halt-write-failed').map((a) => a.codes),
        [['error:storage-closed']],
      );
    });
  });

  it('a full disk at T1 asks for the disk-db halt through the fault sink (C66)', () => {
    withWorld((w) => {
      const full = {
        transaction: (fn: (tx: Tx) => unknown) =>
          w.db.transaction((tx) => {
            fn(tx);
            throw new StorageError('full', 'database or disk is full');
          }),
      } as unknown as Db;
      const o = approveBuyTx({ ...w.deps, db: full }, entryRequest());
      assert.equal(o.kind, 'error');
      assert.deepEqual(readHalts(w.db).map((h) => h.reason), ['disk-db']);
      assert.ok(w.latch.blocked().includes('storage'));
    });
  });
});
