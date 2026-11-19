// Invariant 1 on SQLite (STORAGE_DESIGN.md s.15.14; RISK_POLICY invariant 1): over random sequences
// of T1 buys and exits, T2 redeems (through risk's own verifier, at slots in and out of range),
// abandons and settlements, every order has exactly one approved decision and a used token that
// matches it field by field, no token is used twice, no position holds two buys or two exits in
// flight, and the book always balances (portfolio/ledger.ts checkConservation). A step the database
// or storage refuses leaves nothing behind (the whole transaction rolls back).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { firstVersion } from '../../../src/config/changes.ts';
import { DEFAULT_TUNABLES } from '../../../src/config/tunables.ts';
import { lamports } from '../../../src/core/units.ts';
import { checkConservation } from '../../../src/portfolio/ledger.ts';
import type { RedeemSnapshot, TokenStore, ApprovalToken } from '../../../src/risk/approval.ts';
import { canonicalPlan, planMaxSpend, type OrderPlan } from '../../../src/risk/plan.ts';
import { abandonOpening, insertOpening, readBook, readPosition } from '../../../src/storage/repo-book.ts';
import { insertApproval, insertDecision, insertEntryIntent, insertExitIntent } from '../../../src/storage/repo-orders.ts';
import { redeemApproval } from '../../../src/storage/repo-redeem.ts';
import { setUpConfig, setUpLedger } from '../../../src/storage/repo-server.ts';
import { StorageError, type Db } from '../../../src/storage/sqlite.ts';
import { TEST_NOW, migratedDb } from '../../unit/storage/helpers.ts';
import { BUY, SELL, authority, issue } from '../../unit/storage/money-fixtures.ts';

const T = TEST_NOW;

class SqliteStore implements TokenStore {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  consume(tokenId: string, snapshot: RedeemSnapshot): boolean {
    return this.db.transaction((tx) => redeemApproval(tx, tokenId, snapshot, canonicalPlan(snapshot.plan), T + 10));
  }
}

type Step =
  | { readonly kind: 'buy'; readonly n: number; readonly amount: bigint }
  | { readonly kind: 'redeem'; readonly pick: number; readonly offset: bigint }
  | { readonly kind: 'abandon'; readonly n: number }
  | { readonly kind: 'settle'; readonly n: number }
  | { readonly kind: 'exit'; readonly n: number }
  | { readonly kind: 'fail'; readonly pick: number };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('buy' as const), n: fc.integer({ min: 1, max: 6 }), amount: fc.constantFrom(40_000_000n, 55_000_000n, 60_000_000n) }) }, // sizes the re-check passes (fees within the landing cap)
  // slots relative to the token's own quote: one before it, at it, inside, the last one, one past it
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('redeem' as const), pick: fc.nat(), offset: fc.constantFrom(-1n, 0n, 5n, 25n, 26n) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('abandon' as const), n: fc.integer({ min: 1, max: 6 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('settle' as const), n: fc.integer({ min: 1, max: 6 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('exit' as const), n: fc.integer({ min: 1, max: 6 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('fail' as const), pick: fc.nat() }) },
);

/** Every order against its decision and its used token (invariant 1), and the per-position order rules. */
function checkInvariants(db: Db): void {
  const orphans = db.all(
    `SELECT o.id FROM orders AS o
       LEFT JOIN approvals AS a ON a.token_id = o.token_id
       LEFT JOIN risk_decisions AS d ON d.intent_id = o.intent_id
       LEFT JOIN intents AS i ON i.id = o.intent_id
     WHERE a.token_id IS NULL OR a.consumed_at IS NULL OR a.intent_id <> o.intent_id OR a.position_id <> o.position_id
        OR a.mode <> o.mode OR a.kind <> o.kind OR a.plan_hash <> o.plan_hash OR a.max_spend <> o.max_spend OR a.min_out <> o.min_out
        OR a.quote_slot <> o.quote_slot OR d.approved IS NOT 1 OR i.position_id <> o.position_id OR i.mode <> o.mode`,
  );
  assert.deepEqual(orphans, [], 'every order has its approved decision and its used, matching token');
  assert.deepEqual(db.all('SELECT token_id FROM orders GROUP BY token_id HAVING count(*) > 1'), []);
  assert.deepEqual(db.all("SELECT position_id FROM orders WHERE kind = 'buy' GROUP BY position_id HAVING count(*) > 1"), []);
  assert.deepEqual(db.all("SELECT position_id FROM orders WHERE kind <> 'buy' AND status IN ('approved', 'submitted') GROUP BY position_id HAVING count(*) > 1"), []);
  const book = readBook(db, 'paper');
  checkConservation({
    mode: 'paper',
    sol: book.account.sol,
    totalDeposits: book.account.totalDeposits,
    totalWithdrawals: book.account.totalWithdrawals,
    positions: new Map(book.positions.map((p) => [p.id, p])),
    settledOrders: new Set(),
    updatedAt: book.account.updatedAt,
  });
}

/** A step the money path refuses (the database or a repository check): the transaction rolled back. */
function refusedOrDone(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof StorageError)) {
      throw e;
    }
  }
}

describe('the money path on SQLite: invariant 1 over random sequences', () => {
  it('every order has exactly one approved decision and a used, matching token, and the book balances after every step', () => {
    let orders = 0;
    let refusedRedeems = 0;
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 5, maxLength: 30 }), (steps) => {
        const db = migratedDb();
        try {
          db.transaction((tx) => {
            setUpConfig(tx, T, firstVersion(DEFAULT_TUNABLES, T));
            setUpLedger(tx, T, lamports(550_000_000n));
          });
          const h = authority({ store: new SqliteStore(db) });
          const tokens: { readonly token: ApprovalToken; readonly plan: OrderPlan }[] = [];
          let exits = 0;
          // risk's authority keeps the highest slot it has seen (6a): time only moves on, so each new plan is quoted near it
          let highest = 1_005n;
          for (const s of steps) {
            h.slots.value = highest;
            if (s.kind === 'buy') {
              const plan: OrderPlan = { ...BUY, quoteSlot: highest - 5n, feeConfigSlot: highest - 10n, orderId: `order-${tokens.length + 1}`, intentId: `intent-${tokens.length + 1}`, positionId: `p${s.n}`, mint: `Mint${s.n}`, inAmount: s.amount };
              refusedOrDone(() => {
                const token = issue(h, plan);
                db.transaction((tx) => {
                  insertEntryIntent(tx, { id: plan.intentId, mode: 'paper', strategy: 'momentum', mint: plan.mint, positionId: plan.positionId, sizeHint: 'normal', confidenceBps: null, createdAt: T, inputsAsOf: null, reasons: ['flow-up'], inputs: {} });
                  insertOpening(tx, { id: plan.positionId, mint: plan.mint, strategy: 'momentum', mode: 'paper', openedAt: T, maxSpend: planMaxSpend(plan) }, lamports(0n));
                  insertDecision(tx, { outcome: 'entry-approved', intentId: plan.intentId, at: T, configVersion: 1, slot: 1_005n, size: lamports(s.amount), limitedBy: 'per-trade', binding: 'per-trade' });
                  insertApproval(tx, token, canonicalPlan(plan), T);
                });
                tokens.push({ token, plan });
              });
            } else if (s.kind === 'redeem' && tokens.length > 0) {
              const { token, plan } = tokens[s.pick % tokens.length] as (typeof tokens)[number];
              const slot = plan.quoteSlot + s.offset;
              h.slots.value = slot;
              highest = slot > highest ? slot : highest;
              const result = h.a.redeemer.redeem(token, plan);
              if (result.ok) {
                orders += 1;
              } else {
                refusedRedeems += 1;
              }
            } else if (s.kind === 'abandon') {
              refusedOrDone(() => db.transaction((tx) => abandonOpening(tx, `p${s.n}`, T + 5)));
            } else if (s.kind === 'settle') {
              // what T3 will do once a buy lands (written by hand: no writer in this step makes it)
              db.transaction((tx) => {
                const landed = tx.get("SELECT 1 AS x FROM orders WHERE position_id = ? AND kind = 'buy' AND status = 'approved'", `p${s.n}`);
                if (landed !== undefined) {
                  tx.run("UPDATE orders SET status = 'submitted', updated_at = ? WHERE position_id = ? AND kind = 'buy'", BigInt(T + 6), `p${s.n}`);
                  tx.run("UPDATE orders SET status = 'landed', updated_at = ? WHERE position_id = ? AND kind = 'buy'", BigInt(T + 6), `p${s.n}`);
                  tx.run("UPDATE positions SET status = 'open', max_spend = NULL, token_units = '400000', tokens_bought = '400000', updated_at = ? WHERE id = ? AND status = 'opening'", BigInt(T + 6), `p${s.n}`);
                }
              });
            } else if (s.kind === 'exit') {
              refusedOrDone(() => {
                const p = readPosition(db, `p${s.n}`);
                exits += 1;
                const plan: OrderPlan = { ...SELL, quoteSlot: highest - 5n, feeConfigSlot: highest - 10n, orderId: `exit-order-${exits}`, intentId: `exit-${s.n}-${p.exitSeq}`, positionId: p.id, mint: p.mint };
                const token = issue(h, plan);
                db.transaction((tx) => {
                  insertExitIntent(tx, { id: plan.intentId, positionId: p.id, exitSeq: p.exitSeq, fractionBps: 10_000, urgency: 'normal', createdAt: T + 7, inputsAsOf: null, reasons: ['take-profit'], inputs: {} });
                  insertDecision(tx, { outcome: 'exit-approved', intentId: plan.intentId, at: T + 7, configVersion: 1, slot: 1_005n });
                  insertApproval(tx, token, canonicalPlan(plan), T + 7);
                });
                tokens.push({ token, plan });
              });
            } else if (s.kind === 'fail' && tokens.length > 0) {
              const { plan } = tokens[s.pick % tokens.length] as (typeof tokens)[number];
              db.transaction((tx) => tx.run("UPDATE orders SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'approved'", BigInt(T + 8), plan.orderId));
            }
            checkInvariants(db);
          }
        } finally {
          db.close();
        }
      }),
      { numRuns: 200 },
    );
    // the runs reached both outcomes, many times over
    assert.ok(orders >= 100 && refusedRedeems >= 100, `orders ${orders}, refused redeems ${refusedRedeems}`);
  });
});
