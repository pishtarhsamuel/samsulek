// Invariants 1, 2 and 17 on SQLite (STORAGE_DESIGN.md s.16.9, condition C3; RISK_POLICY.md s.15):
// random runs of T1 buys, T1 exits, T2 redeems (honest, replayed, with a changed plan, and through a
// second authority), abandons, settlements written by hand (what T3 will do) and slot moves.
// After every step the stored rows hold: every order has exactly one approved decision and a consumed
// token matching it in every field, used inside its slot range; no token works twice; at most four
// active positions, one per mint; every held-back spend, size and the exposure inside the hard caps;
// the day's entries inside the limit; the wallet minus the held SOL above the fee reserve. After every
// run no cell holds a MAC or an encoding of either key. Written with src/app/approve-tx.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { abandonOpeningTx, approveBuyTx, approveExitTx } from '../../../src/app/approve-tx.ts';
import { createEngineAuthority } from '../../../src/app/authority.ts';
import { buyCapsOf } from '../../../src/app/caps.ts';
import { HARD_CAPS } from '../../../src/config/caps.ts';
import { DEFAULT_TUNABLES } from '../../../src/config/tunables.ts';
import { base58Of, base64Of, base64UrlOf, hexOf } from '../../../src/core/encode.ts';
import { athensDay } from '../../../src/core/day.ts';
import { lamports, tokenUnits } from '../../../src/core/units.ts';
import type { ApprovalToken } from '../../../src/risk/approval.ts';
import type { CheckedPlan } from '../../../src/risk/recheck.ts';
import { feeReserve } from '../../../src/risk/reserve.ts';
import { readActivePositions, readPosition } from '../../../src/storage/repo-book.ts';
import { entriesOn } from '../../../src/storage/repo-flags.ts';
import { dump } from '../../unit/storage/helpers.ts';
import { T, testKeyBytes, testRng } from '../../unit/app/world.ts';
import { EXIT_MARKET, MARKET, RENT, entryRequest, exitRequest, txWorld, type TxWorld } from '../../unit/app/tx-world.ts';

type Action =
  | { readonly t: 'buy'; readonly mint: number; readonly window: number }
  | { readonly t: 'trade'; readonly mint: number }
  | { readonly t: 'redeem'; readonly token: number; readonly change: boolean }
  | { readonly t: 'foreign'; readonly token: number }
  | { readonly t: 'slot'; readonly by: number }
  | { readonly t: 'abandon'; readonly pos: number }
  | { readonly t: 'settle'; readonly pos: number }
  | { readonly t: 'exit'; readonly pos: number };

const action: fc.Arbitrary<Action> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ t: fc.constant('buy' as const), mint: fc.nat(7), window: fc.nat(2) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('trade' as const), mint: fc.nat(7) }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('redeem' as const), token: fc.nat(20), change: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('foreign' as const), token: fc.nat(20) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('slot' as const), by: fc.nat(30) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('abandon' as const), pos: fc.nat(10) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('settle' as const), pos: fc.nat(10) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('exit' as const), pos: fc.nat(10) }) },
);

interface Issued {
  readonly token: ApprovalToken;
  readonly plan: CheckedPlan;
}

const RESERVE_CAPS = buyCapsOf(DEFAULT_TUNABLES, RENT).reserve;
const DAY = athensDay(T);
const KEY_FORMS = [1, 2].flatMap((seed) => {
  const k = testKeyBytes(seed);
  return [hexOf(k), base64Of(k).replace(/=+$/, ''), base64UrlOf(k), base58Of(k)];
});

/** The stored rows hold every invariant (1, 2 and 17). */
function invariantsHold(w: TxWorld): void {
  // invariant 1: an order has exactly one approved decision and its consumed, matching token
  for (const o of w.db.all('SELECT id, intent_id, token_id, position_id, mode, kind, plan_hash, max_spend, min_out, quote_slot FROM orders')) {
    assert.equal(w.db.get('SELECT count(*) AS n FROM risk_decisions WHERE intent_id = ? AND approved = 1', o['intent_id'] as string)?.['n'], 1n);
    const a = w.db.get('SELECT * FROM approvals WHERE token_id = ?', o['token_id'] as string);
    assert.ok(a !== undefined && a['consumed_at'] !== null, 'the order has its consumed token');
    for (const field of ['intent_id', 'position_id', 'mode', 'kind', 'plan_hash', 'max_spend', 'min_out', 'quote_slot']) {
      assert.equal(a[field], o[field], field);
    }
    const used = a['consumed_slot'] as bigint;
    assert.ok(used >= (a['quote_slot'] as bigint) && used <= (a['expires_at_slot'] as bigint), 'used inside its slot range');
  }
  // invariant 2: the caps on the stored book
  const active = readActivePositions(w.db);
  assert.ok(active.length <= HARD_CAPS.openPositions);
  assert.equal(new Set(active.map((p) => p.mint)).size, active.length, 'one active position per mint');
  let exposure = 0n;
  for (const p of active) {
    if (p.status === 'opening') {
      assert.ok(p.maxSpend !== null && p.maxSpend <= HARD_CAPS.buyMaxSpendLamports);
      exposure += p.maxSpend ?? 0n;
    } else {
      exposure += w.marks.get(p.id)?.value ?? 0n;
    }
  }
  assert.ok(exposure <= HARD_CAPS.exposureLamports, `exposure ${exposure}`);
  for (const d of w.db.all('SELECT size FROM risk_decisions WHERE size IS NOT NULL')) {
    assert.ok(BigInt(d['size'] as string) <= HARD_CAPS.positionLamports);
  }
  assert.ok(entriesOn(w.db, DAY) <= DEFAULT_TUNABLES.risk.entriesPerDay);
  // invariant 17: the wallet minus the SOL held for buys in flight covers the fee reserve
  const wallet = BigInt(w.db.get("SELECT sol FROM ledger_accounts WHERE mode = 'paper'")?.['sol'] as string);
  const held = active.reduce((sum, p) => sum + (p.status === 'opening' ? (p.maxSpend ?? 0n) : 0n), 0n);
  if (active.length > 0) {
    assert.ok(wallet - held >= feeReserve({ p95ExitCosts: active.map((p) => p.p95ExitCost), wsolHelper: false }, RESERVE_CAPS), 'the fee reserve stays covered');
  }
}

interface Seen {
  buys: number;
  redeems: number;
  exits: number;
}

function run(actions: readonly Action[]): Seen {
  const seen: Seen = { buys: 0, redeems: 0, exits: 0 };
  const w = txWorld();
  const other = createEngineAuthority({ db: w.db, clock: w.clock, slots: w.deps.slots, rng: testRng(2), faults: w.deps.faults, latch: w.latch, sentinel: w.sentinel });
  const issued: Issued[] = [];
  const used = new Set<string>();
  const positions: string[] = [];
  let order = 100;
  const quoteNow = () => {
    const slot = w.slot.value ?? 1_005n;
    return { slot, quote: { slot, feeBps: MARKET.quote.feeBps, feeConfigSlot: slot - 5n } };
  };
  const buyOne = (mintIndex: number, window: number, id: string): Issued | null => {
    const { slot, quote } = quoteNow();
    const req = entryRequest({ mint: `Mint${mintIndex}`, positionId: id, windowStartMs: T - 60_000 * (window + 1), market: { ...MARKET, quote } }, { quoteSlot: slot, feeConfigSlot: slot - 5n, orderId: `or_${(order += 1)}` });
    const o = approveBuyTx(w.deps, req);
    if (o.kind !== 'approved') {
      return null;
    }
    const got = { token: o.token, plan: o.plan };
    issued.push(got);
    positions.push(id);
    seen.buys += 1;
    return got;
  };
  /** What T3 will do once a buy order landed, written by hand: the position holds its tokens. */
  const settleOne = (id: string): void => {
    const buy = w.db.get("SELECT id FROM orders WHERE position_id = ? AND kind = 'buy' AND status = 'approved'", id);
    if (buy !== undefined) {
      w.db.transaction((tx) => {
        tx.run("UPDATE orders SET status = 'submitted' WHERE id = ?", buy['id'] as string);
        tx.run("UPDATE orders SET status = 'landed' WHERE id = ?", buy['id'] as string);
        tx.run("UPDATE positions SET status = 'open', max_spend = NULL, token_units = '400000', tokens_bought = '400000' WHERE id = ? AND status = 'opening'", id);
      });
      w.marks.set(id, { value: lamports(50_000_000n), tokenUnits: tokenUnits(400_000n), at: T });
    }
  };
  const exitOne = (id: string): void => {
    if (readPosition(w.db, id).status !== 'open') {
      return;
    }
    const { slot, quote } = quoteNow();
    const mint = readPosition(w.db, id).mint;
    const o = approveExitTx(w.deps, exitRequest(w.deps, id, { market: { ...EXIT_MARKET, quote } }, { mint, tokenAccount: `AtaOf${mint}`, quoteSlot: slot, feeConfigSlot: slot - 5n, orderId: `or_${(order += 1)}` }));
    if (o.kind === 'approved') {
      issued.push({ token: o.token, plan: o.plan });
      seen.exits += 1;
    }
  };
  try {
    actions.forEach((a, step) => {
      const slot = w.slot.value ?? 1_005n;
      if (a.t === 'buy') {
        buyOne(a.mint, a.window, `ps_${step}`);
      } else if (a.t === 'trade') {
        // a whole round trip in a row: the buy, its redeem, the settlement and the sale
        const got = buyOne(a.mint, 2, `ps_${step}`);
        if (got !== null && w.authority.redeemer.redeem(got.token, got.plan).ok) {
          used.add(got.token.id);
          seen.redeems += 1;
          settleOne(`ps_${step}`);
          exitOne(`ps_${step}`);
        }
      } else if (a.t === 'redeem' || a.t === 'foreign') {
        const pick = issued[a.token % Math.max(1, issued.length)];
        if (pick === undefined) {
          return;
        }
        if (a.t === 'foreign') {
          // a second authority bound to the same database refuses the token: its MAC is not that key's
          assert.equal(other.redeemer.redeem(pick.token, pick.plan).ok, false);
          return;
        }
        const plan = a.change ? { ...pick.plan, minOut: pick.plan.minOut - 1n } : pick.plan;
        const r = w.authority.redeemer.redeem(pick.token, plan);
        if (a.change || used.has(pick.token.id)) {
          assert.equal(r.ok, false, 'a replay or a changed plan never redeems');
        } else if (r.ok) {
          used.add(pick.token.id);
          seen.redeems += 1;
        }
      } else if (a.t === 'slot') {
        w.slot.value = slot + BigInt(a.by);
      } else if (a.t === 'abandon') {
        const id = positions[a.pos % Math.max(1, positions.length)];
        if (id !== undefined) {
          abandonOpeningTx(w.store, id);
        }
      } else {
        const id = positions[a.pos % Math.max(1, positions.length)];
        if (id !== undefined && a.t === 'settle') {
          settleOne(id);
        } else if (id !== undefined) {
          exitOne(id);
        }
      }
      invariantsHold(w);
    });
    const cells = dump(w.db);
    for (const { token } of issued) {
      assert.ok(!cells.includes(token.mac), 'no MAC in any cell');
    }
    for (const form of KEY_FORMS) {
      assert.ok(!cells.toLowerCase().includes(form.toLowerCase()), 'no encoding of a key in any cell');
    }
    return seen;
  } finally {
    w.db.close();
  }
}

describe('invariants 1, 2 and 17 on SQLite, over random runs of the approval transactions (C3)', () => {
  it('hold after every step of 200 random runs', () => {
    const total: Seen = { buys: 0, redeems: 0, exits: 0 };
    fc.assert(
      fc.property(fc.array(action, { minLength: 1, maxLength: 40 }), (actions) => {
        const s = run(actions);
        total.buys += s.buys;
        total.redeems += s.redeems;
        total.exits += s.exits;
      }),
      { numRuns: 200 },
    );
    // non-vacuity: the runs approved buys, redeemed tokens and approved exits
    assert.ok(total.buys >= 100 && total.redeems >= 50 && total.exits >= 20, JSON.stringify(total));
  });

  it('the boundary run: four buys fill the position cap, every token redeems once, exits of settled positions go through', () => {
    const actions: Action[] = [];
    for (let i = 0; i < 6; i += 1) {
      actions.push({ t: 'buy', mint: i, window: 0 });
    }
    for (let i = 0; i < 6; i += 1) {
      actions.push({ t: 'redeem', token: i, change: false }, { t: 'redeem', token: i, change: false }, { t: 'foreign', token: i });
    }
    for (let i = 0; i < 4; i += 1) {
      actions.push({ t: 'settle', pos: i }, { t: 'exit', pos: i });
    }
    actions.push({ t: 'slot', by: 30 }, { t: 'abandon', pos: 0 });
    assert.deepEqual(run(actions), { buys: 4, redeems: 4, exits: 4 }, 'four buys fill the cap; each token redeems once; each settled position sells');
  });
});
