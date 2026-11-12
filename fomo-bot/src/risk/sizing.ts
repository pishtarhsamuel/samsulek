// Entry sizing (RISK_POLICY.md s.6 steps 2-4; limits 1, 2, 4, 5, 7, 8, 11 and 15). Pure: the risk
// engine gathers the inputs and, in the approval transaction, re-runs the same caps against the
// exact plan. The size is the lowest cap; every cap rounds down. The new position counts against
// the exposure caps at its worst-case spend (size + rent + every allowed attempt), like every
// opening position. There is no confidence input: confidence never raises a size. The configured
// caps are never used as they are: capsInEffect clamps each to its hard value (live: also LIVE_CAPS
// and today's EUR caps), so a wrong config can only make sizing stricter (REVIEWS.md K, N1).
import { HARD_CAPS, LIVE_CAPS } from '../config/caps.ts';
import { isStrategyId, type StrategyId } from '../core/ids.ts';
import { bps, bpsOfFloor, lamports, type Bps, type Lamports } from '../core/units.ts';
import { RiskError } from './reserve.ts';

/** RISK_POLICY.md limit 15, the H floor of the minimum trade (config/caps.ts). */
const HARD_MIN_TRADE_FLOOR = HARD_CAPS.minTradeFloorLamports;

/**
 * The configured caps (tunables). Sizing and the independent limit check use them only through
 * capsInEffect. The size is the swap input (limits 1 and 2); at the 0.06 SOL cap the worst-case
 * spend is about 0.0617 SOL.
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

export type EntryMode = 'paper' | 'live';

/**
 * Today's live EUR caps in lamports (RISK_POLICY.md s.2: EUR 5 per position, EUR 10 exposure),
 * converted when live trading is switched on and at each 00:00 Athens, rounded down.
 */
export interface LiveSolCaps {
  readonly positionLamports: Lamports;
  readonly exposureLamports: Lamports;
}

export interface SizingInput {
  readonly strategy: StrategyId;
  /** The mode the entry runs in: a live entry is sized under LIVE_CAPS and today's EUR caps too. */
  readonly mode: EntryMode;
  /** Today's EUR caps in lamports: required for a live entry (no price, no live entries); unused in paper. */
  readonly liveSol: LiveSolCaps | null;
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

const lowerRate = (a: number, b: number): number => (a < b ? a : b);
const lowerAmount = (a: bigint, b: bigint): bigint => (a < b ? a : b);

function checkLiveSol(value: unknown): LiveSolCaps {
  if (typeof value !== 'object' || value === null) {
    throw new RiskError("a live entry needs today's EUR caps in lamports: no price means no live entries");
  }
  const { positionLamports, exposureLamports } = value as { readonly [K in keyof LiveSolCaps]?: unknown };
  return { positionLamports: lamports(positionLamports as bigint), exposureLamports: lamports(exposureLamports as bigint) };
}

/**
 * The caps sizing and the independent limit check apply (REVIEWS.md K, risk-guardian N1): each
 * configured ceiling, never above its HARD_CAPS value, and for a live entry never above LIVE_CAPS
 * and today's EUR caps either (the lower of the SOL and the EUR cap applies, RISK_POLICY.md s.2). A
 * config can only make them stricter. The minimum trade and its floor are floors: they pass through
 * (a higher one is only stricter), and a floor below the 0.01 SOL hard floor throws where it is used.
 * Every field is read once. A live entry without today's EUR caps throws; so does a malformed value.
 */
export function capsInEffect(configured: SizingCaps, mode: EntryMode, liveSol: LiveSolCaps | null): SizingCaps {
  if (typeof configured !== 'object' || (configured as unknown) === null) {
    throw new RiskError('caps must be an object');
  }
  if (mode !== 'paper' && mode !== 'live') {
    throw new RiskError('an entry runs in paper or live mode');
  }
  const { perTradeBps, maxPositionLamports, exposureBps, maxExposureLamports, launchShareBps, poolShareBps, minTradeLamports, minTradeFloorLamports } =
    configured;
  let perTrade = lowerRate(bps(perTradeBps), HARD_CAPS.tradePctBps);
  let position = lowerAmount(lamports(maxPositionLamports), HARD_CAPS.positionLamports);
  let exposure = lowerRate(bps(exposureBps), HARD_CAPS.exposurePctBps);
  let maxExposure = lowerAmount(lamports(maxExposureLamports), HARD_CAPS.exposureLamports);
  let poolShare = lowerRate(bps(poolShareBps), HARD_CAPS.poolShareBps);
  if (mode === 'live') {
    const live = checkLiveSol(liveSol);
    perTrade = lowerRate(perTrade, LIVE_CAPS.tradePctBps);
    position = lowerAmount(position, live.positionLamports);
    exposure = lowerRate(exposure, LIVE_CAPS.exposurePctBps);
    maxExposure = lowerAmount(maxExposure, live.exposureLamports);
    poolShare = lowerRate(poolShare, LIVE_CAPS.poolShareBps);
  }
  return Object.freeze({
    perTradeBps: bps(perTrade),
    maxPositionLamports: lamports(position),
    exposureBps: bps(exposure),
    maxExposureLamports: lamports(maxExposure),
    launchShareBps: bps(lowerRate(bps(launchShareBps), HARD_CAPS.launchShareOfExposureCapBps)),
    poolShareBps: bps(poolShare),
    minTradeLamports: lamports(minTradeLamports),
    minTradeFloorLamports: lamports(minTradeFloorLamports),
  });
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

export function sizeEntry(input: SizingInput, configured: SizingCaps): SizingResult {
  if (!isStrategyId(input.strategy)) {
    throw new RiskError('unknown strategy');
  }
  // The caps in effect, first: whatever the config says, no cap is looser than its hard (live: LIVE_CAPS) value.
  const caps = capsInEffect(configured, input.mode, input.liveSol);
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
