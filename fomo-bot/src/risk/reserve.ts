// Fee reserve (RISK_POLICY.md s.3a, limit 11): what one transaction attempt can cost at the caps,
// the exit budget each position keeps, and the SOL no buy may ever spend, so selling is always
// affordable. Integer math only; every cost and the reserve round up. The configured values are
// never used below their hard values (reserveCapsInEffect), so a config can only raise the reserve.
import { HARD_CAPS } from '../config/caps.ts';
import { ceilDiv, lamports, microLamportsPerCu, type Lamports, type MicroLamportsPerCu } from '../core/units.ts';

export class RiskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RiskError';
  }
}

/** The Solana base fee per signature (a protocol constant). Plans carry one signature: ours. */
export const BASE_FEE_PER_SIGNATURE: Lamports = lamports(5_000n);

/** The largest tip one landed transaction may pay (limit 19). */
const HARD_TIP_MAX = HARD_CAPS.tipLamports.reduce<bigint>((most, tip) => (tip > most ? tip : most), 0n);

/** The reserve's inputs from the config; see reserveCapsInEffect for the values they never go below. */
export interface ReserveCaps {
  readonly baseFeePerSignature: Lamports;
  readonly exitSignatures: number;
  /** The highest CU price an exit may pay (exits 400,000 uL/CU). */
  readonly exitCuPriceMax: MicroLamportsPerCu;
  readonly cuLimitMax: number;
  /** Blockhash windows (~32 s each) and attempts per window in one exit's retry budget. */
  readonly retryWindows: number;
  readonly attemptsPerWindow: number;
  /** The largest tip one landed transaction pays. */
  readonly landedTipMax: Lamports;
  readonly reserveFloor: Lamports;
  /** The reserve is at least this many times the measured p95 exit costs. */
  readonly p95Multiplier: number;
  /** Rent of the wSOL helper account, held back while any exit needs it. */
  readonly wsolHelperRent: Lamports;
}

export interface AttemptParams {
  readonly signatures: number;
  readonly cuPrice: MicroLamportsPerCu;
  readonly cuLimit: number;
  readonly tip: Lamports;
}

export interface ReserveInput {
  /** The p95 exit cost of every position, the new one included: N = the length. */
  readonly p95ExitCosts: readonly Lamports[];
  /** True when any exit needs the wSOL helper account. */
  readonly wsolHelper: boolean;
}

const MICRO_PER_LAMPORT = 1_000_000n;

function count(what: string, value: unknown): bigint {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new RiskError(`${what} must be a positive whole number`);
  }
  return BigInt(value);
}

/** One attempt: base fee x signatures + ceil(CU price x CU limit / 10^6) + tip. */
export function attemptCost(params: AttemptParams, baseFeePerSignature: Lamports): Lamports {
  const signatures = count('signatures', params.signatures);
  const cuLimit = count('cuLimit', params.cuLimit);
  const priority = ceilDiv(microLamportsPerCu(params.cuPrice) * cuLimit, MICRO_PER_LAMPORT);
  return lamports(lamports(baseFeePerSignature) * signatures + priority + lamports(params.tip));
}

const atLeast = (value: bigint, floor: bigint): bigint => (value > floor ? value : floor);

/**
 * The reserve's inputs in effect, each read once and checked: every value at least its hard value
 * (RISK_POLICY.md limit 11 and s.3a: the 0.01 SOL floor, 2 x the p95 exit costs, 9 windows x 3
 * attempts, each attempt at the exit caps of 400,000 uL/CU x 300,000 CU plus the protocol base fee,
 * one landed tip of the largest allowed size), so a config can only make the reserve larger. Two
 * inputs are facts, not caps: the signature count of an exit (at least 1 by the count check: our
 * wallet signs) and the wSOL helper rent, which the engine reads from the chain
 * (getMinimumBalanceForRentExemption for a 165-byte account, VERIFIED_FACTS) and never takes from a
 * config file (REVIEWS.md L, security finding 2); they are checked, not raised.
 */
export function reserveCapsInEffect(caps: ReserveCaps): ReserveCaps {
  if (typeof caps !== 'object' || (caps as unknown) === null) {
    throw new RiskError('the reserve caps must be an object');
  }
  const {
    baseFeePerSignature,
    exitSignatures,
    exitCuPriceMax,
    cuLimitMax,
    retryWindows,
    attemptsPerWindow,
    landedTipMax,
    reserveFloor,
    p95Multiplier,
    wsolHelperRent,
  } = caps;
  return Object.freeze({
    baseFeePerSignature: lamports(atLeast(lamports(baseFeePerSignature), BASE_FEE_PER_SIGNATURE)),
    exitSignatures: Number(count('exitSignatures', exitSignatures)),
    exitCuPriceMax: microLamportsPerCu(atLeast(microLamportsPerCu(exitCuPriceMax), HARD_CAPS.exitCuPriceMicroLamports)),
    cuLimitMax: Math.max(Number(count('cuLimitMax', cuLimitMax)), HARD_CAPS.cuLimit),
    retryWindows: Math.max(Number(count('retryWindows', retryWindows)), HARD_CAPS.exitBudgetWindows),
    attemptsPerWindow: Math.max(Number(count('attemptsPerWindow', attemptsPerWindow)), HARD_CAPS.exitAttemptsPerWindow),
    landedTipMax: lamports(atLeast(lamports(landedTipMax), HARD_TIP_MAX)),
    reserveFloor: lamports(atLeast(lamports(reserveFloor), HARD_CAPS.feeReserveFloorLamports)),
    p95Multiplier: Math.max(Number(count('p95Multiplier', p95Multiplier)), HARD_CAPS.feeReserveP95Multiple),
    wsolHelperRent: lamports(wsolHelperRent),
  });
}

/**
 * One position's exit budget: windows x attempts x one exit attempt at the caps, plus one landed tip.
 * This is what the reserve HOLDS for each position, so a config can only raise it. It is never an
 * allowance to SPEND: the failed-fee budget of automatic exits (s.3a, at most 3,375,000 lamports a
 * position a day) is its own number, at or below its hard value (REVIEWS.md L, security finding 3).
 */
export function positionExitBudget(configured: ReserveCaps): Lamports {
  const caps = reserveCapsInEffect(configured);
  const attempt = attemptCost(
    { signatures: caps.exitSignatures, cuPrice: caps.exitCuPriceMax, cuLimit: caps.cuLimitMax, tip: lamports(0n) },
    caps.baseFeePerSignature,
  );
  const attempts = BigInt(caps.retryWindows) * BigInt(caps.attemptsPerWindow);
  return lamports(attempts * attempt + caps.landedTipMax);
}

/** A buy's worst-case spend: its input, the rent and every allowed attempt (ARCHITECTURE.md s.3). */
export function maxSpend(inAmount: Lamports, rent: Lamports, attempts: number, perAttempt: Lamports): Lamports {
  return lamports(lamports(inAmount) + lamports(rent) + count('attempts', attempts) * lamports(perAttempt));
}

/** max(floor; multiplier x the sum of p95 exit costs; N x the exit budget + the helper rent). */
export function feeReserve(input: ReserveInput, configured: ReserveCaps): Lamports {
  const { p95ExitCosts, wsolHelper } = input;
  if (!Array.isArray(p95ExitCosts)) {
    throw new RiskError('p95ExitCosts must be a list');
  }
  if (typeof wsolHelper !== 'boolean') {
    throw new RiskError('wsolHelper must be a boolean');
  }
  const caps = reserveCapsInEffect(configured);
  let p95Sum = 0n;
  let positions = 0n;
  for (const cost of p95ExitCosts as readonly Lamports[]) {
    p95Sum += lamports(cost);
    positions += 1n;
  }
  const fromP95 = BigInt(caps.p95Multiplier) * p95Sum;
  const helper = wsolHelper ? caps.wsolHelperRent : 0n;
  const fromBudget = positions * positionExitBudget(caps) + helper;
  let reserve: bigint = caps.reserveFloor;
  for (const candidate of [fromP95, fromBudget]) {
    if (candidate > reserve) {
      reserve = candidate;
    }
  }
  return lamports(reserve);
}
