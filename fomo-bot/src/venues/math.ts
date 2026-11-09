// Quote math for the supported venues: constant-product pools (PumpSwap, Raydium CPMM) and the
// pump.fun bonding curve on virtual reserves. Integer math only, every rounding in the venue's
// favour (never the bot's), so quotes and paper fills are never optimistic.
// Ported from the root project's src/samsulek/costs/memecoin.py (same hand vectors). Each venue's
// exact on-chain rounding is UNVERIFIED until Phase 3 replays recorded mainnet trades against
// these functions; until then they are deliberately pessimistic approximations.
import {
  AmountError,
  BPS_DENOMINATOR,
  bps,
  ceilDiv,
  floorDiv,
  lamports,
  mulDivFloor,
  tokenUnits,
  type Bps,
  type Lamports,
  type TokenUnits,
} from '../core/units.ts';

function feeRate(fee: Bps): bigint {
  const f = bps(fee);
  if (f >= 10_000) {
    throw new AmountError(`a venue fee must be below 100%, got ${f} bps`);
  }
  return BigInt(f);
}

function positive(what: string, value: bigint): bigint {
  if (typeof value !== 'bigint' || value <= 0n) {
    throw new AmountError(`${what} must be a positive bigint, got ${typeof value === 'bigint' ? value : typeof value}`);
  }
  return value;
}

function nonNegative(what: string, value: bigint): bigint {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new AmountError(`${what} must be a non-negative bigint, got ${typeof value === 'bigint' ? value : typeof value}`);
  }
  return value;
}

/** The fee on an amount, rounded up (in the venue's favour). */
function feeOn(amount: bigint, rate: bigint): bigint {
  return ceilDiv(amount * rate, BPS_DENOMINATOR);
}

function swapOut(netIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  return (netIn * reserveOut) / (reserveIn + netIn);
}

// ---------------------------------------------------------------- constant product

/** Output of a constant-product swap; the fee is taken from the input. */
export function cpAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, fee: Bps): bigint {
  const a = nonNegative('amountIn', amountIn);
  const rIn = positive('reserveIn', reserveIn);
  const rOut = positive('reserveOut', reserveOut);
  const rate = feeRate(fee);
  return swapOut(a - feeOn(a, rate), rIn, rOut);
}

/** The smallest input whose cpAmountOut reaches amountOut (exact inverse). */
export function cpAmountIn(amountOut: bigint, reserveIn: bigint, reserveOut: bigint, fee: Bps): bigint {
  const out = nonNegative('amountOut', amountOut);
  const rIn = positive('reserveIn', reserveIn);
  const rOut = positive('reserveOut', reserveOut);
  const rate = feeRate(fee);
  if (out >= rOut) {
    throw new AmountError(`cannot take ${out} out of a pool holding ${rOut}`);
  }
  if (out === 0n) {
    return 0n;
  }
  const net = ceilDiv(out * rIn, rOut - out);
  // The smallest gross input whose fee-adjusted amount (gross - ceil(gross x fee / 10_000)) reaches net.
  return ceilDiv(net * BPS_DENOMINATOR, BPS_DENOMINATOR - rate);
}

/** Shortfall of the output against the spot price, fee and rounding included, in bps rounded up. */
export function impactBpsCeil(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, fee: Bps): bigint {
  const a = positive('amountIn', amountIn);
  const out = cpAmountOut(a, reserveIn, reserveOut, fee);
  const spot = a * reserveOut; // output at the spot price, scaled by reserveIn
  return ceilDiv((spot - out * reserveIn) * BPS_DENOMINATOR, spot);
}

/** The least output a swap may accept: floor(expected x (1 - slippage / 10_000)). */
export function minOut(expectedOut: bigint, slippage: Bps): bigint {
  const expected = nonNegative('expectedOut', expectedOut);
  return mulDivFloor(expected, BPS_DENOMINATOR - BigInt(bps(slippage)), BPS_DENOMINATOR);
}

// ---------------------------------------------------------------- pump.fun bonding curve

export class CurveCompleteError extends Error {
  constructor() {
    super('the bonding curve is complete: the token now trades on another pool');
    this.name = 'CurveCompleteError';
  }
}

export interface CurveState {
  readonly virtualQuote: Lamports;
  readonly virtualToken: TokenUnits;
  readonly realToken: TokenUnits;
  readonly complete: boolean;
}

/** Validates a decoded curve account (fail closed on anything inconsistent). */
export function curveState(state: CurveState): CurveState {
  const virtualQuote = lamports(positive('virtualQuote', state.virtualQuote));
  const virtualToken = tokenUnits(positive('virtualToken', state.virtualToken));
  const realToken = tokenUnits(nonNegative('realToken', state.realToken));
  if (realToken > virtualToken) {
    throw new AmountError(`realToken (${realToken}) cannot exceed virtualToken (${virtualToken})`);
  }
  if (typeof state.complete !== 'boolean') {
    throw new AmountError(`complete must be a boolean, got ${typeof state.complete}`);
  }
  return Object.freeze({ virtualQuote, virtualToken, realToken, complete: state.complete });
}

/** Tokens bought with quoteIn lamports (fee taken from the input), at most the real tokens left. */
export function curveBuy(state: CurveState, quoteIn: Lamports, fee: Bps): bigint {
  const s = curveState(state);
  if (s.complete) {
    throw new CurveCompleteError();
  }
  const tokens = cpAmountOut(nonNegative('quoteIn', quoteIn), s.virtualQuote, s.virtualToken, fee);
  return tokens < s.realToken ? tokens : s.realToken;
}

/** Lamports received for tokenIn (fee taken from the output, rounded up). */
export function curveSell(state: CurveState, tokenIn: TokenUnits, fee: Bps): bigint {
  const s = curveState(state);
  if (s.complete) {
    throw new CurveCompleteError();
  }
  const gross = swapOut(nonNegative('tokenIn', tokenIn), s.virtualToken, s.virtualQuote);
  return gross - feeOn(gross, feeRate(fee));
}

// ---------------------------------------------------------------- market-cap fee tiers

export interface FeeTier {
  readonly thresholdLamports: Lamports; // the tier applies from this market cap upwards
  readonly lpBps: Bps;
  readonly protocolBps: Bps;
  readonly creatorBps: Bps;
}

/** The tier's total fee. Each part is checked on its own, so a negative or fractional part cannot hide in a valid sum. */
export function totalFeeBps(tier: FeeTier): number {
  return bps(tier.lpBps) + bps(tier.protocolBps) + bps(tier.creatorBps);
}

/**
 * The tier for a market cap: the last one whose threshold is at or below it. The table must start
 * at 0, increase strictly, and every total must stay below 100%; anything else throws (fail closed).
 */
export function selectFeeTier(tiers: readonly FeeTier[], marketCap: bigint): FeeTier {
  const cap = nonNegative('marketCap', marketCap);
  const first = tiers[0];
  if (first === undefined) {
    throw new AmountError('fee tier table is empty');
  }
  if (first.thresholdLamports !== 0n) {
    throw new AmountError('fee tier table must start at 0');
  }
  let chosen = first;
  let previous = -1n;
  for (const tier of tiers) {
    const threshold = lamports(tier.thresholdLamports);
    if (threshold <= previous) {
      throw new AmountError('fee tier thresholds must be strictly increasing');
    }
    const total = totalFeeBps(tier);
    if (total >= 10_000) {
      throw new AmountError(`fee tier total must be below 100%, got ${total} bps`);
    }
    previous = threshold;
    if (threshold <= cap) {
      chosen = tier;
    }
  }
  return chosen;
}

/**
 * Market cap in lamports: quoteReserve x totalSupply / tokenReserve, rounded DOWN. Fees fall as
 * the market cap rises, so rounding down picks the higher (pessimistic) fee at a tier boundary.
 */
export function marketCapLamports(quoteReserve: bigint, tokenReserve: bigint, totalSupply: bigint): bigint {
  return floorDiv(nonNegative('quoteReserve', quoteReserve) * nonNegative('totalSupply', totalSupply), positive('tokenReserve', tokenReserve));
}
