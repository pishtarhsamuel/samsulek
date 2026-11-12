// Entry sizing (RISK_POLICY.md s.6 steps 2-4; limits 1, 2, 4, 5, 7, 8, 11 and 15): the size is the
// lowest cap, caps round down, the new position counts at its worst-case spend (maxSpend) against
// the exposure caps like every opening position, and anything below the minimum trade is refused.
// TEST_PLAN.md s.3 step 4. Written before the implementation.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AmountError, bps, lamports } from '../../../src/core/units.ts';
import { RiskError } from '../../../src/risk/reserve.ts';
import { capsInEffect, sizeEntry, type LiveSolCaps, type SizingCaps, type SizingInput } from '../../../src/risk/sizing.ts';

const SOL = 1_000_000_000n;

// The HARD_CAPS of RISK_POLICY.md s.3 (paper); a live entry adds LIVE_CAPS and today's EUR caps.
const CAPS: SizingCaps = {
  perTradeBps: bps(1_000), // limit 1: 10% of equity
  maxPositionLamports: lamports(60_000_000n), // limit 2: 0.06 SOL
  exposureBps: bps(5_000), // limit 4: 50% of equity
  maxExposureLamports: lamports(300_000_000n), // limit 5: 0.30 SOL
  launchShareBps: bps(2_500), // limit 8: 25% of the exposure cap
  poolShareBps: bps(50), // limit 7: 0.5% of pool liquidity (2 x real SOL reserve)
  minTradeLamports: lamports(20_000_000n), // limit 15: the configured minimum, 0.02 SOL
  minTradeFloorLamports: lamports(10_000_000n), // limit 15: never below 0.01 SOL
};

// The paper bankroll of 0.55 SOL, nothing held, a 20 SOL pool.
const BASE: SizingInput = {
  strategy: 'crowdflow',
  mode: 'paper',
  liveSol: null,
  sizeHint: 'normal',
  sizingEquity: lamports(550_000_000n),
  exposure: lamports(0n),
  launchExposure: lamports(0n),
  poolRealSolReserve: lamports(20n * SOL),
  sol: lamports(550_000_000n),
  reserveAfterBuy: lamports(10_000_000n),
  rent: lamports(1_488_440n),
  buyAttemptFees: lamports(198_000n), // 3 attempts x (5,000 + 60,000 priority + 1,000 tip)
  minTrade: lamports(20_000_000n),
  liveRampHalf: false,
};
const OVERHEAD = 1_488_440n + 198_000n; // rent + every allowed attempt: counted with the new position

const size = (input: Partial<SizingInput>) => sizeEntry({ ...BASE, ...input }, CAPS);

describe('the size is the lowest cap', () => {
  it('0.55 SOL bankroll: 10% of equity binds at 0.055 SOL; every cap is reported', () => {
    const r = size({});
    assert.deepEqual(r, {
      ok: true,
      size: 55_000_000n,
      limitedBy: 'per-trade',
      binding: 'per-trade',
      caps: {
        'per-trade': 55_000_000n,
        'per-position': 60_000_000n,
        exposure: 275_000_000n - OVERHEAD,
        'exposure-absolute': 300_000_000n - OVERHEAD,
        'pool-share': 200_000_000n,
        'free-sol': 550_000_000n - 10_000_000n - OVERHEAD,
      },
    });
  });

  it('caps round down', () => {
    const r = size({ sizingEquity: lamports(550_000_009n) });
    assert.equal(r.ok && r.size, 55_000_000n);
  });

  it('0.06 SOL per position binds above 0.6 SOL of equity', () => {
    const r = size({ sizingEquity: lamports(SOL), sol: lamports(SOL) });
    assert.equal(r.ok && r.limitedBy, 'per-position');
    assert.equal(r.ok && r.size, 60_000_000n);
  });

  it('exposure: the room left under 50% of equity, the new position at its worst-case spend', () => {
    const r = size({ exposure: lamports(230_000_000n) });
    assert.equal(r.ok && r.limitedBy, 'exposure');
    assert.equal(r.ok && r.size, 275_000_000n - 230_000_000n - OVERHEAD);
  });

  it('absolute exposure: 0.30 SOL whatever the equity', () => {
    const r = size({ sizingEquity: lamports(1_900_000_000n), sol: lamports(1_900_000_000n), exposure: lamports(250_000_000n) });
    assert.equal(r.ok && r.limitedBy, 'exposure-absolute');
    assert.equal(r.ok && r.size, 300_000_000n - 250_000_000n - OVERHEAD);
  });

  it('launch: 25% of the exposure cap (12.5% of equity), for the launch strategy only', () => {
    const launch = size({ strategy: 'launch', exposure: lamports(20_000_000n), launchExposure: lamports(20_000_000n) });
    assert.equal(launch.ok && launch.limitedBy, 'launch');
    assert.equal(launch.ok && launch.size, 68_750_000n - 20_000_000n - OVERHEAD);
    const crowd = size({ exposure: lamports(20_000_000n), launchExposure: lamports(20_000_000n) });
    assert.equal(crowd.ok && crowd.limitedBy, 'per-trade');
    assert.equal(crowd.ok && 'launch' in crowd.caps, false);
  });

  it('pool share: 0.5% of liquidity (2 x real SOL reserve), so 0.055 SOL needs a 5.5 SOL reserve', () => {
    const r = size({ poolRealSolReserve: lamports(5n * SOL) });
    assert.equal(r.ok && r.limitedBy, 'pool-share');
    assert.equal(r.ok && r.size, 50_000_000n);
    const exact = size({ poolRealSolReserve: lamports(5_500_000_000n) });
    assert.equal(exact.ok && exact.size, 55_000_000n);
  });

  it('free SOL: the buy can never spend the reserve, the rent or the fees of its attempts', () => {
    const r = size({ sol: lamports(60_000_000n) });
    assert.equal(r.ok && r.limitedBy, 'free-sol');
    assert.equal(r.ok && r.size, 60_000_000n - 10_000_000n - OVERHEAD);
  });

  it('a cap already used up is 0, not negative, and refuses the entry', () => {
    const r = size({ exposure: lamports(280_000_000n) });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.limitedBy, 'exposure');
    assert.equal(r.caps.exposure, 0n);
  });
});

describe('the minimum trade', () => {
  it('at the minimum: accepted; one lamport of equity cap below it: refused, entries stop', () => {
    const at = size({ sizingEquity: lamports(200_000_000n) });
    assert.equal(at.ok && at.size, 20_000_000n);
    const above = size({ sizingEquity: lamports(200_000_010n) });
    assert.equal(above.ok && above.size, 20_000_001n);
    const below = size({ sizingEquity: lamports(199_999_999n) });
    assert.equal(below.ok, false);
    assert.equal(!below.ok && below.reason, 'equity-below-minimum'); // the account is too small: tell the owner
    assert.equal(!below.ok && below.minimum, 20_000_000n);
  });

  it('another cap below the minimum refuses this entry only', () => {
    const r = size({ poolRealSolReserve: lamports(SOL) });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, 'below-minimum');
    assert.equal(!r.ok && r.limitedBy, 'pool-share');
  });

  it('a pool whose cost rule needs a bigger trade refuses that entry only, never all entries', () => {
    // A token with expensive fees must not be able to stop the bot (risk-guardian M1).
    const r = size({ minTrade: lamports(60_000_000n) });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, 'below-minimum');
    assert.equal(!r.ok && r.minimum, 60_000_000n);
  });

  it('never below the 0.01 SOL floor, whatever the cost rule or the configuration says', () => {
    const low = { ...CAPS, minTradeLamports: lamports(5_000_000n) };
    const r = sizeEntry({ ...BASE, minTrade: lamports(5_000_000n), poolRealSolReserve: lamports(900_000_000n) }, low);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.minimum, 10_000_000n);
    const hint = sizeEntry({ ...BASE, sizeHint: 'min', minTrade: lamports(0n) }, low);
    assert.equal(hint.ok && hint.size, 10_000_000n);
  });

  it('refuses a floor below the 0.01 SOL hard floor, so a size of 0 can never be approved', () => {
    for (const floor of [0n, 9_999_999n]) {
      assert.throws(
        () => sizeEntry({ ...BASE, minTrade: lamports(0n) }, { ...CAPS, minTradeLamports: lamports(0n), minTradeFloorLamports: lamports(floor) }),
        RiskError,
      );
    }
  });

  it("sizeHint 'min' trades exactly the minimum when every cap allows it", () => {
    const r = size({ sizeHint: 'min' });
    assert.equal(r.ok && r.size, 20_000_000n);
    assert.equal(r.ok && r.limitedBy, 'min-hint');
    assert.equal(size({ sizeHint: 'min', poolRealSolReserve: lamports(SOL) }).ok, false);
  });
});

describe('the live ramp halves the size', () => {
  it('half size for a strategy\'s first 20 live trades, rounded down, still above the minimum', () => {
    const r = size({ liveRampHalf: true, sizingEquity: lamports(550_000_001n) });
    assert.equal(r.ok && r.size, 27_500_000n);
    assert.equal(r.ok && r.limitedBy, 'live-ramp');
    assert.equal(r.ok && r.binding, 'per-trade'); // the cap underneath is still reported
  });

  it('a halved size below the minimum is refused', () => {
    const r = size({ liveRampHalf: true, sizingEquity: lamports(300_000_000n) });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, 'below-minimum');
    assert.equal(!r.ok && r.limitedBy, 'live-ramp');
  });
});

// Every ceiling far above its hard value (REVIEWS.md K, risk-guardian N1: "a config with a 3 SOL
// exposure cap ... passes everything"). Bps cannot exceed 100%, so 100% is as loose as a rate gets.
const LOOSE: SizingCaps = {
  ...CAPS,
  perTradeBps: bps(10_000),
  maxPositionLamports: lamports(10n * SOL),
  exposureBps: bps(10_000),
  maxExposureLamports: lamports(100n * SOL),
  launchShareBps: bps(10_000),
  poolShareBps: bps(10_000),
};
const EUR_CAPS: LiveSolCaps = { positionLamports: lamports(40_000_000n), exposureLamports: lamports(120_000_000n) };

describe('the caps in effect: a config can only make sizing stricter (REVIEWS.md K, N1)', () => {
  it('every ceiling is clamped to its hard value: 10%, 0.06 SOL, 50%, 0.30 SOL, 25% of the exposure cap, 0.5% of the pool', () => {
    assert.deepEqual(capsInEffect(LOOSE, 'paper', null), CAPS);
    assert.ok(Object.isFrozen(capsInEffect(LOOSE, 'paper', null)));
  });

  it('caps far above the hard values size exactly as the hard caps do, whatever binds', () => {
    const inputs: Partial<SizingInput>[] = [
      {},
      { sizingEquity: lamports(1_900_000_000n), sol: lamports(1_900_000_000n) }, // per-position
      { exposure: lamports(230_000_000n) }, // exposure
      { sizingEquity: lamports(1_900_000_000n), sol: lamports(1_900_000_000n), exposure: lamports(250_000_000n) }, // absolute exposure
      { strategy: 'launch', exposure: lamports(20_000_000n), launchExposure: lamports(20_000_000n) }, // launch
      { poolRealSolReserve: lamports(5n * SOL) }, // pool share
      { sizingEquity: lamports(199_999_999n) }, // equity below the minimum
      { sizeHint: 'min', liveRampHalf: true },
    ];
    for (const input of inputs) {
      assert.deepEqual(sizeEntry({ ...BASE, ...input }, LOOSE), sizeEntry({ ...BASE, ...input }, CAPS), JSON.stringify(input, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v)));
    }
    // the size itself never passes a hard cap: 10% of a 1.9 SOL equity would be 0.19 SOL
    const big = sizeEntry({ ...BASE, sizingEquity: lamports(1_900_000_000n), sol: lamports(1_900_000_000n) }, LOOSE);
    assert.equal(big.ok && big.size, 60_000_000n);
  });

  it('a value tighter than the hard one stays as configured', () => {
    const tight: SizingCaps = { ...CAPS, perTradeBps: bps(500), maxPositionLamports: lamports(30_000_000n), exposureBps: bps(2_000), maxExposureLamports: lamports(100_000_000n), launchShareBps: bps(1_000), poolShareBps: bps(10) };
    assert.deepEqual(capsInEffect(tight, 'paper', null), tight);
    assert.deepEqual(capsInEffect({ ...CAPS, minTradeLamports: lamports(40_000_000n), minTradeFloorLamports: lamports(30_000_000n) }, 'paper', null).minTradeFloorLamports, 30_000_000n);
  });
});

describe('a live entry: LIVE_CAPS and today\'s EUR caps on top of the hard caps (RISK_POLICY.md s.2)', () => {
  it('5% per trade, 20% exposure, 0.5% of the pool, and the lower of the SOL and the EUR caps', () => {
    assert.deepEqual(capsInEffect(CAPS, 'live', EUR_CAPS), {
      ...CAPS,
      perTradeBps: 500,
      maxPositionLamports: 40_000_000n,
      exposureBps: 2_000,
      maxExposureLamports: 120_000_000n,
    });
    // EUR caps worth more than the hard SOL caps: the hard caps apply
    const rich = capsInEffect(LOOSE, 'live', { positionLamports: lamports(SOL), exposureLamports: lamports(5n * SOL) });
    assert.deepEqual([rich.perTradeBps, rich.maxPositionLamports, rich.exposureBps, rich.maxExposureLamports, rich.poolShareBps], [500, 60_000_000n, 2_000, 300_000_000n, 50]);
  });

  it('sizes a live entry under the live caps, to the lamport', () => {
    const live = (input: Partial<SizingInput>) => sizeEntry({ ...BASE, mode: 'live', liveSol: EUR_CAPS, ...input }, LOOSE);
    const perTrade = live({}); // 5% of 0.55 SOL
    assert.equal(perTrade.ok && perTrade.size, 27_500_000n);
    assert.equal(perTrade.ok && perTrade.limitedBy, 'per-trade');
    const position = live({ sizingEquity: lamports(SOL), sol: lamports(SOL) }); // EUR 5 in lamports
    assert.equal(position.ok && position.size, 40_000_000n);
    assert.equal(position.ok && position.limitedBy, 'per-position');
    const exposure = live({ sizingEquity: lamports(SOL), sol: lamports(SOL), exposure: lamports(90_000_000n) }); // EUR 10 in lamports
    assert.equal(exposure.ok && exposure.limitedBy, 'exposure-absolute');
    assert.equal(exposure.ok && exposure.size, 120_000_000n - 90_000_000n - OVERHEAD);
    const percent = live({ sizingEquity: lamports(SOL), sol: lamports(SOL), liveSol: { positionLamports: lamports(SOL), exposureLamports: lamports(SOL) }, exposure: lamports(160_000_000n) });
    assert.equal(percent.ok && percent.limitedBy, 'exposure'); // 20% of 1 SOL
    assert.equal(percent.ok && percent.size, 200_000_000n - 160_000_000n - OVERHEAD);
  });

  it('at 5% per trade all entries stop below 0.4 SOL of equity (the 0.02 SOL minimum trade)', () => {
    const at = sizeEntry({ ...BASE, mode: 'live', liveSol: EUR_CAPS, sizingEquity: lamports(400_000_000n) }, CAPS);
    assert.equal(at.ok && at.size, 20_000_000n);
    const below = sizeEntry({ ...BASE, mode: 'live', liveSol: EUR_CAPS, sizingEquity: lamports(399_999_999n) }, CAPS);
    assert.equal(!below.ok && below.reason, 'equity-below-minimum');
  });

  it('no EUR caps today means no live entry; a bad mode or bad EUR caps fail closed; paper never needs them', () => {
    assert.throws(() => sizeEntry({ ...BASE, mode: 'live', liveSol: null }, CAPS), RiskError);
    assert.throws(() => sizeEntry({ ...BASE, mode: 'live', liveSol: { positionLamports: -1n as LiveSolCaps['positionLamports'], exposureLamports: lamports(1n) } }, CAPS), AmountError);
    assert.throws(() => sizeEntry({ ...BASE, mode: 'live', liveSol: { positionLamports: lamports(1n) } as LiveSolCaps }, CAPS), AmountError);
    assert.throws(() => sizeEntry({ ...BASE, mode: 'demo' as 'paper' }, CAPS), RiskError);
    assert.throws(() => capsInEffect(null as unknown as SizingCaps, 'paper', null), RiskError);
    assert.equal(sizeEntry({ ...BASE, liveSol: null }, CAPS).ok, true);
  });
});

describe('fail closed on bad inputs', () => {
  it('refuses malformed amounts, strategies, hints and flags', () => {
    assert.throws(() => size({ sol: -1n as typeof BASE.sol }), AmountError);
    assert.throws(() => size({ strategy: 'copy' as 'launch' }), RiskError);
    assert.throws(() => size({ sizeHint: 'max' as 'min' }), RiskError);
    assert.throws(() => size({ liveRampHalf: 1 as unknown as boolean }), RiskError);
    assert.throws(() => size({ launchExposure: -1n as typeof BASE.sol }), AmountError); // checked for every strategy
    assert.throws(() => sizeEntry(BASE, { ...CAPS, poolShareBps: 20_000 as typeof CAPS.poolShareBps }), AmountError);
  });
});
