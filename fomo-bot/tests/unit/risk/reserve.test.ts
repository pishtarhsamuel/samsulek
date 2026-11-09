// Fee reserve (RISK_POLICY.md s.3a, limit 11), worked to the lamport: what one transaction attempt
// can cost at the caps, the exit budget each position keeps, and the reserve no buy may spend.
// TEST_PLAN.md s.3 step 4. Written before the implementation.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lamports, microLamportsPerCu } from '../../../src/core/units.ts';
import {
  RiskError,
  attemptCost,
  feeReserve,
  maxSpend,
  positionExitBudget,
  type ReserveCaps,
} from '../../../src/risk/reserve.ts';

// The HARD_CAPS values of RISK_POLICY.md s.3 and s.3a (config/caps.ts arrives in step 5).
const CAPS: ReserveCaps = {
  baseFeePerSignature: lamports(5_000n),
  exitSignatures: 1,
  exitCuPriceMax: microLamportsPerCu(400_000n),
  cuLimitMax: 300_000,
  retryWindows: 9,
  attemptsPerWindow: 3,
  landedTipMax: lamports(5_000n),
  reserveFloor: lamports(10_000_000n),
  p95Multiplier: 2,
  wsolHelperRent: lamports(1_488_440n),
};

const p95 = (n: number, each = 100_000n) => Array.from({ length: n }, () => lamports(each));

describe('one attempt and the exit budget per position', () => {
  it('one exit attempt at the caps costs 5,000 + 400,000 x 300,000 / 10^6 = 125,000 lamports', () => {
    const cost = attemptCost(
      { signatures: CAPS.exitSignatures, cuPrice: CAPS.exitCuPriceMax, cuLimit: CAPS.cuLimitMax, tip: lamports(0n) },
      CAPS.baseFeePerSignature,
    );
    assert.equal(cost, 125_000n);
  });

  it('rounds the priority fee up and adds the tip and every signature', () => {
    const cost = attemptCost(
      { signatures: 2, cuPrice: microLamportsPerCu(1n), cuLimit: 1, tip: lamports(1_000n) },
      CAPS.baseFeePerSignature,
    );
    assert.equal(cost, 10_000n + 1n + 1_000n); // 1 x 1 / 10^6 rounds up to 1 lamport
  });

  it('each position keeps 9 windows x 3 attempts x 125,000 + one landed tip = 3,380,000 lamports', () => {
    assert.equal(positionExitBudget(CAPS), 3_380_000n);
  });

  it('the worst-case spend of a buy is its input, the rent and every allowed attempt', () => {
    assert.equal(maxSpend(lamports(55_000_000n), lamports(1_488_440n), 3, lamports(66_000n)), 55_000_000n + 1_488_440n + 198_000n);
  });
});

describe('the reserve after a buy (N = positions including the new one)', () => {
  it('N = 4 with the wSOL helper: 4 x 3,380,000 + 1,488,440 = 15,008,440 lamports', () => {
    assert.equal(feeReserve({ p95ExitCosts: p95(4), wsolHelper: true }, CAPS), 15_008_440n);
  });

  it('N = 3 with the helper: 11,628,440; N = 4 without it: 13,520,000', () => {
    assert.equal(feeReserve({ p95ExitCosts: p95(3), wsolHelper: true }, CAPS), 11_628_440n);
    assert.equal(feeReserve({ p95ExitCosts: p95(4), wsolHelper: false }, CAPS), 13_520_000n);
  });

  it('N = 0, 1 or 2: the 0.01 SOL floor', () => {
    for (const n of [0, 1, 2]) {
      assert.equal(feeReserve({ p95ExitCosts: p95(n), wsolHelper: true }, CAPS), 10_000_000n, `N = ${n}`);
    }
  });

  it('twice the measured p95 exit costs when they are the largest', () => {
    // 2 x (6,000,000 + 6,000,000) = 24,000,000 > 2 x 3,380,000 + 1,488,440 and > the floor
    assert.equal(feeReserve({ p95ExitCosts: p95(2, 6_000_000n), wsolHelper: true }, CAPS), 24_000_000n);
  });
});

describe('fail closed on bad inputs', () => {
  it('refuses counts that are not positive safe integers', () => {
    assert.throws(() => positionExitBudget({ ...CAPS, retryWindows: 0 }), RiskError);
    assert.throws(() => positionExitBudget({ ...CAPS, attemptsPerWindow: 1.5 }), RiskError);
    assert.throws(() => feeReserve({ p95ExitCosts: p95(1), wsolHelper: true }, { ...CAPS, p95Multiplier: Number.NaN }), RiskError);
    const attempt = { signatures: 0, cuPrice: microLamportsPerCu(1n), cuLimit: 1, tip: lamports(0n) };
    assert.throws(() => attemptCost(attempt, CAPS.baseFeePerSignature), RiskError);
    assert.throws(() => attemptCost({ ...attempt, signatures: 1, cuLimit: -1 }, CAPS.baseFeePerSignature), RiskError);
    assert.throws(() => maxSpend(lamports(1n), lamports(0n), 0, lamports(1n)), RiskError);
  });

  it('refuses a helper flag that is not a boolean, and p95 costs that are not a list', () => {
    assert.throws(() => feeReserve({ p95ExitCosts: [], wsolHelper: 'yes' as unknown as boolean }, CAPS), RiskError);
    assert.throws(() => feeReserve({ p95ExitCosts: 4 as unknown as [], wsolHelper: true }, CAPS), RiskError);
  });
});
