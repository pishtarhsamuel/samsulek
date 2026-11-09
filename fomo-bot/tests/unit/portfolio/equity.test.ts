// Equity valuation (RISK_POLICY.md s.4): SOL plus every open position at its exact full-size
// sell quote; unknown if any position lacks a fresh mark for the tokens it holds now (entries
// blocked); for the stops, a position whose last mark is older than the stop window is valued 0,
// while a missing or future mark leaves the stops unknown; locked rent and unknown mints never count.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AmountError, lamports, tokenUnits, type Lamports, type TokenUnits } from '../../../src/core/units.ts';
import { valueEquity, type Mark } from '../../../src/portfolio/equity.ts';
import { applyBuy, applySell, deposit, emptyLedger, openPosition, type Ledger } from '../../../src/portfolio/ledger.ts';

const T0 = 1_762_000_000_000;
const POLICY = { staleAfterMs: 30_000, stopZeroAfterMs: 300_000 };
const HELD = 1_000_000_000n;

function withPosition(): Ledger {
  let l = deposit(emptyLedger('paper'), lamports(550_000_000n), T0);
  l = openPosition(l, { id: 'p1', mint: 'MintA', strategy: 'crowdflow', openedAt: T0 });
  return applyBuy(l, {
    orderId: 'o1',
    positionId: 'p1',
    landed: true,
    quoteIn: lamports(30_000_000n),
    venueFee: lamports(375_000n),
    tokensOut: tokenUnits(HELD),
    networkFee: lamports(15_000n),
    tip: lamports(0n),
    rentPaid: lamports(1_513_840n),
    at: T0,
  });
}

const sell = (l: Ledger, tokens: bigint, at: number): Ledger =>
  applySell(l, {
    orderId: `s${at}`,
    positionId: 'p1',
    landed: true,
    tokensIn: tokenUnits(tokens),
    quoteOut: lamports(14_000_000n),
    venueFee: lamports(177_215n),
    networkFee: lamports(15_000n),
    tip: lamports(0n),
    closeAccount: false,
    rentRefunded: lamports(0n),
    at,
  });

const mark = (value: bigint, at: number, tokens: bigint = HELD): Mark => ({
  value: lamports(value),
  tokenUnits: tokenUnits(tokens),
  at,
});

describe('equity valuation', () => {
  it('SOL plus each fresh mark; locked rent is not counted', () => {
    const l = withPosition();
    const e = valueEquity(l, new Map([['p1', mark(28_000_000n, T0 + 10_000)]]), T0 + 20_000, POLICY);
    assert.equal(e.sol, 518_471_160n);
    assert.equal(e.positionsValue, 28_000_000n);
    assert.equal(e.equity, 546_471_160n);
    assert.equal(e.stopEquity, 546_471_160n);
    assert.deepEqual(e.staleMints, []);
  });

  it('a missing or stale mark makes equity unknown (entries blocked)', () => {
    const l = withPosition();
    const missing = valueEquity(l, new Map(), T0 + 20_000, POLICY);
    assert.equal(missing.equity, null);
    assert.equal(missing.stopEquity, null); // no price yet: never counted as 0
    assert.deepEqual(missing.staleMints, ['MintA']);
    const stale = valueEquity(l, new Map([['p1', mark(28_000_000n, T0)]]), T0 + 31_000, POLICY);
    assert.equal(stale.equity, null);
    assert.equal(stale.stopEquity, null);
  });

  it('for the stops, a position whose last mark is older than the stop window counts as 0', () => {
    const l = withPosition();
    const e = valueEquity(l, new Map([['p1', mark(28_000_000n, T0)]]), T0 + 300_001, POLICY);
    assert.equal(e.equity, null);
    assert.equal(e.stopEquity, 518_471_160n); // SOL only
  });

  it('a position with no tokens left (awaiting its close) is worth 0 and needs no mark', () => {
    const l = sell(withPosition(), HELD, T0 + 1_000);
    const e = valueEquity(l, new Map(), T0 + 2_000, POLICY);
    assert.equal(e.equity, l.sol);
    assert.equal(e.positionsValue, 0n);
  });

  it('marks for unknown positions (spam, dust) are ignored', () => {
    const l = withPosition();
    const marks = new Map([
      ['p1', mark(28_000_000n, T0)],
      ['spam', mark(10n ** 15n, T0)],
    ]);
    assert.equal(valueEquity(l, marks, T0 + 1_000, POLICY).positionsValue, 28_000_000n);
  });

  it('a mark from the future (clock problem) leaves equity and the stops unknown, never 0', () => {
    const l = withPosition();
    const soon = valueEquity(l, new Map([['p1', mark(28_000_000n, T0 + 60_000)]]), T0 + 1_000, POLICY);
    assert.equal(soon.equity, null);
    const old = valueEquity(l, new Map([['p1', mark(28_000_000n, T0 + 900_000)]]), T0 + 400_000, POLICY);
    assert.equal(old.equity, null);
    assert.equal(old.stopEquity, null); // the position is 400 s old, but the stops are not guessed
    assert.deepEqual(old.staleMints, ['MintA']);
  });
});

describe('equity valuation: the mark must quote the tokens held now', () => {
  it('a full-size mark taken before a partial sell is not used, so the sold half never counts twice', () => {
    const l = sell(withPosition(), HELD / 2n, T0 + 10_000);
    const before = mark(28_000_000n, T0 + 9_000); // still young, but quotes the old holding
    const e = valueEquity(l, new Map([['p1', before]]), T0 + 11_000, POLICY);
    assert.equal(e.equity, null);
    assert.deepEqual(e.staleMints, ['MintA']);
    assert.equal(e.stopEquity, null); // recently priced: unknown, not 0
    const after = mark(13_900_000n, T0 + 10_500, HELD / 2n);
    assert.equal(valueEquity(l, new Map([['p1', after]]), T0 + 11_000, POLICY).equity, l.sol + 13_900_000n);
  });

  it('a mark for another amount that is also older than the stop window counts 0 for the stops', () => {
    const l = sell(withPosition(), HELD / 2n, T0 + 10_000);
    const e = valueEquity(l, new Map([['p1', mark(28_000_000n, T0 + 9_000)]]), T0 + 309_001, POLICY);
    assert.equal(e.equity, null);
    assert.equal(e.stopEquity, l.sol);
  });
});

describe('equity valuation: boundaries, several positions, live mode, bad input', () => {
  it('a mark exactly staleAfterMs old is fresh; stale for exactly stopZeroAfterMs still blocks the stops', () => {
    const l = withPosition();
    const marks = new Map([['p1', mark(28_000_000n, T0)]]);
    assert.equal(valueEquity(l, marks, T0 + 30_000, POLICY).equity, 546_471_160n);
    const e = valueEquity(l, marks, T0 + 300_000, POLICY);
    assert.equal(e.equity, null);
    assert.equal(e.stopEquity, null);
  });

  it('with two positions only the stale one is listed, and past the stop window the fresh one still counts', () => {
    let l = openPosition(withPosition(), { id: 'p2', mint: 'MintB', strategy: 'momentum', openedAt: T0 });
    l = applyBuy(l, {
      orderId: 'o2',
      positionId: 'p2',
      landed: true,
      quoteIn: lamports(10_000_000n),
      venueFee: lamports(125_000n),
      tokensOut: tokenUnits(500_000_000n),
      networkFee: lamports(15_000n),
      tip: lamports(0n),
      rentPaid: lamports(1_513_840n),
      at: T0,
    });
    const marks = new Map([
      ['p1', mark(28_000_000n, T0 + 400_000)],
      ['p2', mark(9_000_000n, T0, 500_000_000n)],
    ]);
    const e = valueEquity(l, marks, T0 + 400_000, POLICY);
    assert.deepEqual(e.staleMints, ['MintB']);
    assert.equal(e.equity, null);
    assert.equal(e.positionsValue, 28_000_000n);
    assert.equal(e.sol, 506_942_320n);
    assert.equal(e.stopEquity, 534_942_320n); // SOL + the fresh p1 mark; p2 counts 0
  });

  it('a missing mark keeps the stops unknown however old the position is (no spurious stop after a restart)', () => {
    for (const now of [T0 + 300_001, T0 + 86_400_000, T0 - 1_000]) {
      const e = valueEquity(withPosition(), new Map(), now, POLICY);
      assert.equal(e.equity, null);
      assert.equal(e.stopEquity, null);
    }
  });

  it('live: SOL is the lower of the ledger and the chain, so an unexplained inflow never counts', () => {
    const live = deposit(emptyLedger('live'), lamports(550_000_000n), T0);
    assert.equal(valueEquity(live, new Map(), T0, POLICY, lamports(560_000_000n)).equity, 550_000_000n);
    assert.equal(valueEquity(live, new Map(), T0, POLICY, lamports(540_000_000n)).equity, 540_000_000n);
    assert.throws(() => valueEquity(live, new Map(), T0, POLICY), /balance read from the chain/);
    assert.throws(() => valueEquity(withPosition(), new Map(), T0, POLICY, lamports(1n)), /paper equity/);
  });

  it('refuses a bad clock, a bad policy and malformed marks', () => {
    const l = withPosition();
    const bad = (m: object): Map<string, Mark> => new Map([['p1', m as Mark]]);
    assert.throws(() => valueEquity(l, new Map(), Number.NaN, POLICY), /now must be/);
    assert.throws(() => valueEquity(l, new Map(), T0, { staleAfterMs: 60_000, stopZeroAfterMs: 30_000 }), /policy/);
    assert.throws(() => valueEquity(l, new Map(), T0, { staleAfterMs: -1, stopZeroAfterMs: 30_000 }), /policy/);
    assert.throws(() => valueEquity(l, new Map(), T0, { staleAfterMs: 30_000, stopZeroAfterMs: 0.5 }), /policy/);
    assert.throws(() => valueEquity(l, bad({ value: lamports(1n), tokenUnits: tokenUnits(HELD), at: 1.5 }), T0, POLICY), /valid time/);
    assert.throws(() => valueEquity(l, bad({ value: -1n as Lamports, tokenUnits: tokenUnits(HELD), at: T0 }), T0, POLICY), AmountError);
    assert.throws(() => valueEquity(l, bad({ value: lamports(1n), tokenUnits: -1n as TokenUnits, at: T0 }), T0, POLICY), AmountError);
    assert.throws(() => valueEquity(l, bad({ value: lamports(1n), at: T0 }), T0, POLICY), AmountError); // no amount
  });
});
