// Portfolio ledger (TEST_PLAN.md s.3 step 3): cash, positions, cost basis with every fee and
// rent, realized PnL (negative too), rent paid and refunded, failed attempts, deposits and
// withdrawals, and the two conservation identities checked after every operation.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AmountError, lamports, signedLamports, tokenUnits } from '../../../src/core/units.ts';
import {
  LedgerError,
  abandonOpening,
  applyBuy,
  applyClose,
  applySell,
  cashFlow,
  checkConservation,
  deposit,
  emptyLedger,
  openPosition,
  withdraw,
  type BuyFill,
  type Ledger,
  type Position,
  type SellFill,
} from '../../../src/portfolio/ledger.ts';

const T0 = 1_762_000_000_000; // a fixed UTC ms timestamp: tests never read the clock

function funded(mode: 'paper' | 'live' = 'paper'): Ledger {
  return deposit(emptyLedger(mode), lamports(550_000_000n), T0);
}

function opened(): Ledger {
  return openPosition(funded(), { id: 'p1', mint: 'MintA', strategy: 'crowdflow', openedAt: T0 });
}

const buy: BuyFill = {
  orderId: 'o1',
  positionId: 'p1',
  landed: true,
  quoteIn: lamports(30_000_000n), // includes the venue fee below
  venueFee: lamports(375_000n),
  tokensOut: tokenUnits(1_000_000_000n),
  networkFee: lamports(15_000n),
  tip: lamports(5_000n),
  rentPaid: lamports(1_513_840n),
  at: T0 + 1_000,
};

const sellHalf: SellFill = {
  orderId: 'o2',
  positionId: 'p1',
  landed: true,
  tokensIn: tokenUnits(500_000_000n),
  quoteOut: lamports(16_000_000n), // after the venue fee below
  venueFee: lamports(202_532n),
  networkFee: lamports(15_000n),
  tip: lamports(5_000n),
  closeAccount: false,
  rentRefunded: lamports(0n),
  at: T0 + 2_000,
};

describe('ledger: a full trade worked to the lamport', () => {
  it('buy, partial sell, failed sell, final sell with close', () => {
    let l = applyBuy(opened(), buy);
    assert.equal(l.sol, 518_466_160n); // 550M - 30M - 15k - 5k - 1,513,840
    let p = l.positions.get('p1');
    assert.equal(p?.tokenUnits, 1_000_000_000n);
    assert.equal(p?.costBasis, 31_533_840n);
    assert.equal(p?.rentLocked, 1_513_840n);
    assert.equal(p?.status, 'open');
    checkConservation(l);

    // Half: releases ceil((31,533,840 - 1,513,840) x 1/2) = 15,010,000 of trade basis.
    l = applySell(l, sellHalf);
    p = l.positions.get('p1');
    assert.equal(p?.realized, 970_000n); // 16,000,000 - 20,000 - 15,010,000
    assert.equal(p?.costBasis, 16_523_840n);
    assert.equal(l.sol, 534_446_160n);
    checkConservation(l);

    // A failed exit attempt costs only its network fee, added to the basis.
    l = applySell(l, { ...sellHalf, orderId: 'o3', landed: false, at: T0 + 3_000 });
    p = l.positions.get('p1');
    assert.equal(l.sol, 534_431_160n);
    assert.equal(p?.costBasis, 16_538_840n);
    assert.equal(p?.failedFees, 15_000n);
    assert.equal(p?.tokenUnits, 500_000_000n);
    checkConservation(l);

    // Final sell closes the account and gets the rent back.
    l = applySell(l, {
      ...sellHalf,
      orderId: 'o4',
      quoteOut: lamports(14_000_000n),
      closeAccount: true,
      rentRefunded: lamports(1_513_840n),
      at: T0 + 4_000,
    });
    p = l.positions.get('p1');
    assert.equal(p?.realized, -75_000n); // 970,000 + (14,000,000 + 1,513,840 - 20,000 - 16,538,840)
    assert.equal(p?.status, 'closed');
    assert.equal(p?.tokenUnits, 0n);
    assert.equal(p?.costBasis, 0n);
    assert.equal(p?.rentLocked, 0n);
    assert.equal(l.sol, 549_925_000n); // deposits + realized
    checkConservation(l);
  });

  it('selling everything without closing keeps the rent locked until a close', () => {
    let l = applyBuy(opened(), buy);
    l = applySell(l, { ...sellHalf, tokensIn: tokenUnits(1_000_000_000n), quoteOut: lamports(29_000_000n) });
    let p = l.positions.get('p1');
    assert.equal(p?.status, 'exiting');
    assert.equal(p?.costBasis, p?.rentLocked);
    // realized excludes the still-locked rent: 29,000,000 - 20,000 - 30,020,000
    assert.equal(p?.realized, -1_040_000n);
    l = applyClose(l, {
      orderId: 'o5',
      positionId: 'p1',
      landed: true,
      networkFee: lamports(5_000n),
      rentRefunded: lamports(1_513_840n),
      at: T0 + 5_000,
    });
    p = l.positions.get('p1');
    assert.equal(p?.status, 'closed');
    assert.equal(p?.realized, -1_045_000n);
    checkConservation(l);
  });

  it('a buy that never lands costs only network fees and can be abandoned', () => {
    let l = applyBuy(opened(), { ...buy, landed: false });
    assert.equal(l.sol, 550_000_000n - 15_000n);
    assert.equal(l.positions.get('p1')?.status, 'opening');
    l = abandonOpening(l, 'p1', T0 + 9_000);
    const p = l.positions.get('p1');
    assert.equal(p?.status, 'closed');
    assert.equal(p?.realized, -15_000n);
    checkConservation(l);
  });
});

describe('ledger: fail closed on impossible operations (state unchanged)', () => {
  it('refuses to spend more SOL than the wallet holds', () => {
    const l = opened();
    assert.throws(() => applyBuy(l, { ...buy, quoteIn: lamports(600_000_000n) }), LedgerError);
    assert.equal(l.sol, 550_000_000n);
  });

  it('refuses to sell more tokens than held, or to sell an unknown position', () => {
    const l = applyBuy(opened(), buy);
    assert.throws(() => applySell(l, { ...sellHalf, tokensIn: tokenUnits(1_000_000_001n) }), LedgerError);
    assert.throws(() => applySell(l, { ...sellHalf, positionId: 'nope' }), LedgerError);
    assert.equal(l.positions.get('p1')?.tokenUnits, 1_000_000_000n);
  });

  it('refuses a close that would leave tokens or a refund that differs from the locked rent', () => {
    const l = applyBuy(opened(), buy);
    assert.throws(() => applySell(l, { ...sellHalf, closeAccount: true, rentRefunded: lamports(1_513_840n) }), /tokens left/);
    const sold = applySell(l, { ...sellHalf, tokensIn: tokenUnits(1_000_000_000n) });
    assert.throws(
      () => applyClose(sold, { orderId: 'c', positionId: 'p1', landed: true, networkFee: lamports(5_000n), rentRefunded: lamports(1n), at: T0 }),
      /rent/,
    );
  });

  it('refuses a venue fee larger than the swap amount, duplicate positions and buys into a closed position', () => {
    assert.throws(() => applyBuy(opened(), { ...buy, venueFee: lamports(30_000_001n) }), LedgerError);
    assert.throws(() => openPosition(opened(), { id: 'p1', mint: 'MintB', strategy: 'momentum', openedAt: T0 }), /exists/);
    assert.throws(() => openPosition(opened(), { id: 'p2', mint: 'MintA', strategy: 'momentum', openedAt: T0 }), /one position per token/);
    const closed = abandonOpening(opened(), 'p1', T0);
    assert.throws(() => applyBuy(closed, buy), /closed/);
  });

  it('refuses to abandon a position that holds tokens or rent', () => {
    assert.throws(() => abandonOpening(applyBuy(opened(), buy), 'p1', T0), /tokens or rent/);
  });
});

describe('deposits and withdrawals', () => {
  it('a deposit raises SOL and the deposit total', () => {
    const l = deposit(funded(), lamports(1_000n), T0);
    assert.equal(l.sol, 550_001_000n);
    assert.equal(l.totalDeposits, 550_001_000n);
  });

  it('withdrawals are impossible in paper mode', () => {
    assert.throws(() => withdraw(funded('paper'), lamports(1n), T0), /paper/);
  });

  it('a live withdrawal lowers SOL and cannot exceed it', () => {
    const l = withdraw(funded('live'), lamports(50_000_000n), T0);
    assert.equal(l.sol, 500_000_000n);
    assert.equal(l.totalWithdrawals, 50_000_000n);
    checkConservation(l);
    assert.throws(() => withdraw(l, lamports(500_000_001n), T0), LedgerError);
  });
});

describe('ledger: cost lines and idempotency', () => {
  it('keeps every cost line of the full trade, and the cash flow equals the realized PnL once closed', () => {
    let l = applyBuy(opened(), buy);
    l = applySell(l, sellHalf);
    l = applySell(l, { ...sellHalf, orderId: 'o3', landed: false });
    l = applySell(l, {
      ...sellHalf,
      orderId: 'o4',
      quoteOut: lamports(14_000_000n),
      closeAccount: true,
      rentRefunded: lamports(1_513_840n),
      at: T0 + 4_000,
    });
    const p = l.positions.get('p1');
    assert.ok(p !== undefined);
    assert.equal(p.bought, 30_000_000n);
    assert.equal(p.sold, 30_000_000n);
    assert.equal(p.venueFees, 375_000n + 202_532n * 2n); // the failed sell paid no venue fee
    assert.equal(p.networkFees, 45_000n); // the buy and the two landed sells
    assert.equal(p.failedFees, 15_000n);
    assert.equal(p.tips, 15_000n); // the failed sell's tip was never paid
    assert.equal(p.rentPaid, 1_513_840n);
    assert.equal(p.rentRefunded, 1_513_840n);
    assert.equal(p.tokensBought, 1_000_000_000n);
    assert.equal(p.tokensSold, 1_000_000_000n);
    assert.equal(p.exitFees, 40_000n); // fees and tips of the two landed sells
    assert.equal(p.basisReleased, 15_010_000n + 16_538_840n);
    assert.equal(p.closedAt, T0 + 4_000);
    assert.equal(cashFlow(p), -75_000n);
    assert.equal(cashFlow(p), p.realized);
  });

  it('settles each order id once: the same fill never counts twice', () => {
    const l = applyBuy(opened(), { ...buy, landed: false });
    assert.throws(() => applyBuy(l, buy), /already settled/);
    const bought = applyBuy(l, { ...buy, orderId: 'o1b' });
    assert.throws(() => applySell(bought, { ...sellHalf, orderId: 'o1b' }), /already settled/);
    assert.equal(bought.settledOrders.size, 2);
  });

  it('never changes the ledger it was given', () => {
    const before = opened();
    const after = applyBuy(before, buy);
    assert.equal(before.sol, 550_000_000n);
    assert.equal(before.positions.get('p1')?.status, 'opening');
    assert.equal(before.settledOrders.size, 0);
    assert.notEqual(after.positions, before.positions);
    assert.ok(Object.isFrozen(after));
    assert.ok(Object.isFrozen(after.positions.get('p1')));
  });

  it('allows a new position on a token once the previous one is closed', () => {
    const closed = abandonOpening(opened(), 'p1', T0);
    const again = openPosition(closed, { id: 'p2', mint: 'MintA', strategy: 'momentum', openedAt: T0 + 1 });
    assert.equal(again.positions.get('p2')?.status, 'opening');
  });
});

describe('ledger: more refusals (state unchanged)', () => {
  const held = (): Ledger => applyBuy(opened(), buy);
  const exiting = (): Ledger =>
    applySell(held(), { ...sellHalf, tokensIn: tokenUnits(1_000_000_000n), quoteOut: lamports(29_000_000n) });
  const close = {
    orderId: 'c1',
    positionId: 'p1',
    landed: true,
    networkFee: lamports(5_000n),
    rentRefunded: lamports(1_513_840n),
    at: T0 + 5_000,
  };

  it('refuses a second buy into a position that already holds tokens', () => {
    assert.throws(() => applyBuy(held(), { ...buy, orderId: 'o9' }), /is open: a buy needs an opening position/);
  });

  it('refuses a landed buy with no input or no tokens', () => {
    assert.throws(() => applyBuy(opened(), { ...buy, tokensOut: tokenUnits(0n) }), /positive input and output/);
    assert.throws(() => applyBuy(opened(), { ...buy, quoteIn: lamports(0n), venueFee: lamports(0n) }), /positive input/);
  });

  it('refuses sells before the buy lands, after every token is sold, and of zero tokens', () => {
    assert.throws(() => applySell(opened(), sellHalf), /is opening: a sell needs an open position/);
    assert.throws(() => applySell(exiting(), { ...sellHalf, orderId: 'o9' }), /is exiting/);
    assert.throws(() => applySell(exiting(), { ...sellHalf, orderId: 'o9', landed: false }), /is exiting/);
    assert.throws(() => applySell(held(), { ...sellHalf, tokensIn: tokenUnits(0n) }), /cannot sell 0/);
  });

  it('refuses a rent refund without an account close', () => {
    assert.throws(
      () => applySell(held(), { ...sellHalf, rentRefunded: lamports(1_513_840n) }),
      /zero without an account close/,
    );
  });

  it('refuses fees the wallet cannot pay, for sells, failed orders and closes', () => {
    // A buy that spends all but 10,000 lamports.
    const all = applyBuy(opened(), { ...buy, quoteIn: lamports(550_000_000n - 10_000n - 15_000n - 5_000n - 1_513_840n) });
    assert.equal(all.sol, 10_000n);
    assert.throws(() => applySell(all, sellHalf), /insufficient SOL: the sell fees/);
    assert.throws(() => applySell(all, { ...sellHalf, landed: false }), /insufficient SOL: the failed order/);
    const sold = applySell(all, {
      ...sellHalf,
      tokensIn: tokenUnits(1_000_000_000n),
      quoteOut: lamports(0n),
      networkFee: lamports(5_000n),
      tip: lamports(0n),
    });
    assert.equal(sold.sol, 5_000n);
    assert.throws(() => applyClose(sold, { ...close, networkFee: lamports(6_000n) }), /insufficient SOL: the account close/);
  });

  it('a failed close costs its fee, which the final close realizes', () => {
    let l = applyClose(exiting(), { ...close, landed: false, rentRefunded: lamports(0n) });
    assert.equal(l.positions.get('p1')?.status, 'exiting');
    assert.equal(l.positions.get('p1')?.costBasis, 1_513_840n + 5_000n);
    l = applyClose(l, { ...close, orderId: 'c2' });
    const p = l.positions.get('p1');
    assert.equal(p?.status, 'closed');
    assert.equal(p?.realized, -1_040_000n - 10_000n);
    assert.equal(p?.failedFees, 5_000n);
  });

  it('refuses to close an account that still holds tokens or is already closed', () => {
    assert.throws(() => applyClose(held(), close), /is open: an account close needs an exiting position/);
    const closed = applyClose(exiting(), close);
    assert.throws(() => applyClose(closed, { ...close, orderId: 'c2' }), /is closed/);
  });

  it('abandoning books the failed fees as a loss, and a closed position cannot be abandoned', () => {
    let l = applyBuy(opened(), { ...buy, landed: false });
    l = applyBuy(l, { ...buy, orderId: 'o1b', landed: false });
    l = abandonOpening(l, 'p1', T0 + 9_000);
    assert.equal(l.positions.get('p1')?.realized, -30_000n);
    assert.equal(l.sol, 550_000_000n - 30_000n);
    assert.throws(() => abandonOpening(l, 'p1', T0 + 9_001), /is closed: abandoning needs an opening position/);
  });

  it('refuses empty deposits and withdrawals, and an unknown ledger mode', () => {
    assert.throws(() => deposit(funded(), lamports(0n), T0), /deposit must be positive/);
    assert.throws(() => withdraw(funded('live'), lamports(0n), T0), /withdrawal must be positive/);
    assert.throws(() => emptyLedger('demo' as 'paper'), /paper or live/);
  });
});

describe('ledger: malformed input is refused before anything changes', () => {
  it('ids, strategies, times and flags', () => {
    const l = opened();
    const spec = { id: 'p2', mint: 'MintB', strategy: 'momentum' as const, openedAt: T0 };
    assert.throws(() => openPosition(l, { ...spec, id: 'p 2' }), /position id must be/);
    assert.throws(() => openPosition(l, { ...spec, mint: '' }), /mint must be/);
    assert.throws(() => openPosition(l, { ...spec, strategy: 'copy' as 'momentum' }), /unknown strategy/);
    assert.throws(() => openPosition(l, { ...spec, openedAt: Number.NaN }), /openedAt must be/);
    assert.throws(() => applyBuy(l, { ...buy, orderId: '' }), /orderId must be/);
    assert.throws(() => applyBuy(l, { ...buy, positionId: '../p1' }), /positionId must be/);
    assert.throws(() => applyBuy(l, { ...buy, landed: 1 as unknown as boolean }), /landed must be a boolean, got number/);
    assert.throws(() => applyBuy(l, { ...buy, at: -1 }), /at must be a UTC millisecond timestamp/);
    assert.throws(() => deposit(l, lamports(1n), 0.5), /at must be/);
    assert.equal(l.positions.size, 1);
  });

  it('no event can be dated before its position opened', () => {
    const l = opened();
    assert.throws(() => applyBuy(l, { ...buy, at: T0 - 1 }), /earlier than position p1 opened/);
    assert.throws(() => abandonOpening(l, 'p1', T0 - 1), /earlier than position p1 opened/);
    const held = applyBuy(l, buy);
    assert.throws(() => applySell(held, { ...sellHalf, at: T0 - 1 }), /earlier than position p1 opened/);
    assert.equal(abandonOpening(l, 'p1', T0).positions.get('p1')?.closedAt, T0); // the same instant is fine
  });

  it('amounts that are not u64 bigints throw AmountError', () => {
    const l = opened();
    assert.throws(() => applyBuy(l, { ...buy, quoteIn: -1n as typeof buy.quoteIn }), AmountError);
    assert.throws(() => applyBuy(l, { ...buy, tip: 5_000 as unknown as typeof buy.tip }), AmountError);
    assert.throws(() => deposit(l, (2n ** 64n) as typeof buy.tip, T0), AmountError);
    assert.equal(l.sol, 550_000_000n);
  });
});

describe('ledger: a planted mismatch trips the conservation check (PAPER_LEDGER)', () => {
  const base = (): Ledger => applySell(applyBuy(opened(), buy), sellHalf);
  const p1 = (l: Ledger): Position => {
    const p = l.positions.get('p1');
    assert.ok(p !== undefined);
    return p;
  };
  const withP1 = (l: Ledger, p: Position, key = 'p1'): Ledger => ({ ...l, positions: new Map([[key, p]]) });
  // A second, empty opening position on the same token.
  const twin = (l: Ledger): Position => ({
    ...p1(l),
    id: 'p2',
    status: 'opening',
    tokenUnits: tokenUnits(0n),
    costBasis: lamports(0n),
    rentLocked: lamports(0n),
    realized: signedLamports(0n),
    bought: lamports(0n),
    sold: lamports(0n),
    venueFees: lamports(0n),
    networkFees: lamports(0n),
    tips: lamports(0n),
    rentPaid: lamports(0n),
    tokensBought: tokenUnits(0n),
    tokensSold: tokenUnits(0n),
    exitFees: lamports(0n),
    basisReleased: lamports(0n),
  });

  const cases: ReadonlyArray<readonly [string, (l: Ledger) => Ledger, RegExp]> = [
    ['SOL off by one lamport', (l) => ({ ...l, sol: lamports(l.sol + 1n) }), /SOL is/],
    ['an untracked withdrawal', (l) => ({ ...l, totalWithdrawals: lamports(1n) }), /SOL is/],
    ['realized PnL off by one', (l) => withP1(l, { ...p1(l), realized: signedLamports(p1(l).realized + 1n) }), /realized is/],
    [
      'an amount moved between the basis and realized PnL',
      (l) => withP1(l, { ...p1(l), realized: signedLamports(p1(l).realized + 1n), costBasis: lamports(p1(l).costBasis + 1n) }),
      /cost basis is .*realized is/,
    ],
    ['basis released not recorded', (l) => withP1(l, { ...p1(l), basisReleased: lamports(0n) }), /cost lines say/],
    ['a cost line dropped', (l) => withP1(l, { ...p1(l), tips: lamports(0n) }), /cost lines say/],
    ['rent locked without rent paid', (l) => withP1(l, { ...p1(l), rentPaid: lamports(0n) }), /rent locked/],
    ['rent locked above the basis', (l) => withP1(l, { ...p1(l), rentLocked: lamports(p1(l).costBasis + 1n) }), /rent locked/],
    ['tokens drifted from bought - sold', (l) => withP1(l, { ...p1(l), tokenUnits: tokenUnits(p1(l).tokenUnits + 1n) }), /tokens held/],
    ['open with no tokens', (l) => withP1(l, { ...p1(l), tokenUnits: tokenUnits(0n) }), /is open with 0 tokens/],
    ['closed while holding tokens', (l) => withP1(l, { ...p1(l), status: 'closed', closedAt: T0 }), /is closed/],
    ['opening after a landed buy', (l) => withP1(l, { ...p1(l), status: 'opening', tokenUnits: tokenUnits(0n) }), /is opening/],
    ['exiting with tokens', (l) => withP1(l, { ...p1(l), status: 'exiting' }), /is exiting/],
    ['an unknown status', (l) => withP1(l, { ...p1(l), status: 'stuck' as 'open' }), /is stuck/],
    ['stored under another key', (l) => withP1(l, p1(l), 'p9'), /stored under p9/],
    [
      'two active positions on one token',
      (l) => ({ ...l, positions: new Map<string, Position>([...l.positions, ['p2', twin(l)]]) }),
      /two active positions on MintA/,
    ],
  ];

  for (const [name, plant, message] of cases) {
    it(name, () => {
      const good = base();
      checkConservation(good);
      assert.throws(
        () => checkConservation(plant(good)),
        (e: unknown) => e instanceof LedgerError && message.test(e.message),
      );
    });
  }
});
