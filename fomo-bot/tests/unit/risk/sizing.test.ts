// Entry sizing (RISK_POLICY.md s.6 steps 2-4; limits 1, 2, 4, 5, 7, 8, 11 and 15): the size is the
// lowest cap, caps round down, the new position counts at its worst-case spend (maxSpend) against
// the exposure caps like every opening position, and anything below the minimum trade is refused.
// TEST_PLAN.md s.3 step 4. Written before the implementation.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AmountError, bps, lamports } from '../../../src/core/units.ts';
import { RiskError } from '../../../src/risk/reserve.ts';
import { sizeEntry, type SizingCaps, type SizingInput } from '../../../src/risk/sizing.ts';

const SOL = 1_000_000_000n;

// The HARD_CAPS of RISK_POLICY.md s.3 (paper); live uses LIVE_CAPS through the same fields.
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
