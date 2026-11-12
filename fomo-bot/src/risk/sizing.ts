// Entry sizing (RISK_POLICY.md s.6 steps 2-4; limits 1, 2, 4, 5, 7, 8, 11 and 15). Pure: the risk
// engine gathers the inputs and, in the approval transaction, re-runs the same caps against the
// exact plan. The size is the lowest cap; every cap rounds down. The new position counts against
// the exposure caps at its worst-case spend (size + rent + every allowed attempt), like every
// opening position. There is no confidence input: confidence never raises a size.
import { isStrategyId, type StrategyId } from '../core/ids.ts';
import { bpsOfFloor, lamports, type Bps, type Lamports } from '../core/units.ts';
import { RiskError } from './reserve.ts';

/** RISK_POLICY.md limit 15, the H floor of the minimum trade (moves to config/caps.ts HARD_CAPS in step 5). */
const HARD_MIN_TRADE_FLOOR = 10_000_000n;

/**
 * Effective caps: the lower of each tunable and its HARD_CAPS (live: LIVE_CAPS) value. The size is
 * the swap input (limits 1 and 2); at the 0.06 SOL cap the worst-case spend is about 0.0617 SOL.
 */
export interface SizingCaps {
  readonly perTradeBps: Bps;
  readonly maxPositionLamports: Lamports;
  readonly exposureBps: Bps;
  readonly maxExposureLamports: Lamports;
  /** The launch strategy's share of the exposure cap. */
  readonly launchShareBps: Bps;
  /** Of pool liquidity, which is 2 x the real SOL reserve. */
  readonly poolShareBps: Bps;
  /** The configured account minimum trade (limit 15, default 0.02 SOL). */
  readonly minTradeLamports: Lamports;
  /** Its floor; refused below the 0.01 SOL hard floor. */
  readonly minTradeFloorLamports: Lamports;
}

export interface SizingInput {
  readonly strategy: StrategyId;
  readonly sizeHint: 'min' | 'normal';
  /** The lower of start-of-day and current equity (REVIEWS.md D): a pumped mark never raises sizes. */
  readonly sizingEquity: Lamports;
  /** Open positions at their mark plus opening positions at their maxSpend. */
  readonly exposure: Lamports;
  /** The same, for the launch strategy only. */
  readonly launchExposure: Lamports;
  readonly poolRealSolReserve: Lamports;
  /** Wallet SOL now minus the maxSpend still held for buys in flight (opening positions). */
  readonly sol: Lamports;
  /** The fee reserve with the new position included (reserve.ts). */
  readonly reserveAfterBuy: Lamports;
  /** Token-account rent this buy pays. */
  readonly rent: Lamports;
  /** Allowed attempts x the cost of one attempt (reserve.ts attemptCost). */
  readonly buyAttemptFees: Lamports;
  /** The smallest size that meets the cost rule for this pool; the entry needs at least this. */
  readonly minTrade: Lamports;
  /** A strategy's first 20 live trades are at half size. */
  readonly liveRampHalf: boolean;
}

export type SizingCap =
  | 'per-trade'
  | 'per-position'
  | 'exposure'
  | 'exposure-absolute'
  | 'launch'
  | 'pool-share'
  | 'free-sol';
export type SizeLimit = SizingCap | 'live-ramp' | 'min-hint';
export type CapValues = Readonly<Partial<Record<SizingCap, Lamports>>>;

/**
 * limitedBy names what set the size: a cap, the live ramp (half size) or the 'min' hint. binding is
 * always the lowest cap, also when the ramp or the hint decided. With the ramp on, a 'min' entry
 * needs a capped size of at least twice the minimum (stricter, on purpose).
 */
export type SizingResult =
  | {
      readonly ok: true;
      readonly size: Lamports;
      readonly limitedBy: SizeLimit;
      readonly binding: SizingCap;
      readonly caps: CapValues;
    }
  | {
      readonly ok: false;
      /**
       * equity-below-minimum: 10% of equity cannot reach the configured account minimum, so all
       * entries stop and the owner is told once. below-minimum: this entry only (a pool's cost
       * rule can ask for more, but never stops the bot).
       */
      readonly reason: 'below-minimum' | 'equity-below-minimum';
      readonly limitedBy: SizeLimit;
      readonly binding: SizingCap;
      readonly minimum: Lamports;
      readonly caps: CapValues;
    };

/** What is left under a cap, never below 0. */
function room(cap: bigint, used: bigint): Lamports {
  return lamports(cap > used ? cap - used : 0n);
}

/**
 * The account minimum (the configured minimum trade, never below its floor, which itself cannot be
 * below the 0.01 SOL hard floor) and the entry minimum (the larger of that and the pool's cost-rule
 * minimum). One definition, used by sizing and by the plan re-check, so they cannot disagree.
 */
function minimums(poolMinTrade: Lamports, caps: SizingCaps): { readonly account: Lamports; readonly entry: Lamports } {
  const poolMinimum = lamports(poolMinTrade);
  const floor = lamports(caps.minTradeFloorLamports);
  if (floor < HARD_MIN_TRADE_FLOOR) {
    throw new RiskError('the minimum-trade floor cannot be below the 0.01 SOL hard floor');
  }
  const configured = lamports(caps.minTradeLamports);
  const account = configured > floor ? configured : floor;
  return { account, entry: lamports(poolMinimum > account ? poolMinimum : account) };
}

/** The smallest entry the caps and the pool's cost rule allow (RISK_POLICY.md limit 15 and s.5). */
export function tradeMinimum(poolMinTrade: Lamports, caps: SizingCaps): Lamports {
  return minimums(poolMinTrade, caps).entry;
}

export function sizeEntry(input: SizingInput, caps: SizingCaps): SizingResult {
  if (!isStrategyId(input.strategy)) {
    throw new RiskError('unknown strategy');
  }
  if (input.sizeHint !== 'min' && input.sizeHint !== 'normal') {
    throw new RiskError("sizeHint must be 'min' or 'normal'");
  }
  if (typeof input.liveRampHalf !== 'boolean') {
    throw new RiskError('liveRampHalf must be a boolean');
  }
  // Every input is checked up front, whatever the strategy.
  const equity = lamports(input.sizingEquity);
  const exposure = lamports(input.exposure);
  const launchExposure = lamports(input.launchExposure);
  const poolReserve = lamports(input.poolRealSolReserve);
  const sol = lamports(input.sol);
  const reserveAfterBuy = lamports(input.reserveAfterBuy);
  const overhead = lamports(input.rent) + lamports(input.buyAttemptFees); // the new position's spend beyond its size
  const { account: accountMinimum, entry: minimum } = minimums(input.minTrade, caps);

  const exposureUsed = exposure + overhead;
  const exposureCap = bpsOfFloor(equity, caps.exposureBps);
  const maxExposure = lamports(caps.maxExposureLamports);
  const perTrade = lamports(bpsOfFloor(equity, caps.perTradeBps));
  const values: Partial<Record<SizingCap, Lamports>> = {
    'per-trade': perTrade,
    'per-position': lamports(caps.maxPositionLamports),
    exposure: room(exposureCap, exposureUsed),
    'exposure-absolute': room(maxExposure, exposureUsed),
  };
  if (input.strategy === 'launch') {
    const effectiveExposureCap = exposureCap < maxExposure ? exposureCap : maxExposure;
    values.launch = room(bpsOfFloor(effectiveExposureCap, caps.launchShareBps), launchExposure + overhead);
  }
  values['pool-share'] = lamports(bpsOfFloor(2n * poolReserve, caps.poolShareBps));
  values['free-sol'] = room(sol, reserveAfterBuy + overhead);
  const capValues: CapValues = Object.freeze(values);

  // The lowest cap; on a tie the one listed first is named.
  let binding: SizingCap = 'per-trade';
  let size: bigint = perTrade;
  for (const [name, value] of Object.entries(values) as [SizingCap, Lamports][]) {
    if (value < size) {
      size = value;
      binding = name;
    }
  }

  if (perTrade < accountMinimum) {
    return Object.freeze({
      ok: false,
      reason: 'equity-below-minimum',
      limitedBy: 'per-trade',
      binding,
      minimum: accountMinimum,
      caps: capValues,
    });
  }
  let limitedBy: SizeLimit = binding;
  if (input.liveRampHalf) {
    size /= 2n;
    limitedBy = 'live-ramp';
  }
  if (size < minimum) {
    return Object.freeze({ ok: false, reason: 'below-minimum', limitedBy, binding, minimum, caps: capValues });
  }
  if (input.sizeHint === 'min') {
    return Object.freeze({ ok: true, size: minimum, limitedBy: 'min-hint', binding, caps: capValues });
  }
  return Object.freeze({ ok: true, size: lamports(size), limitedBy, binding, caps: capValues });
}
