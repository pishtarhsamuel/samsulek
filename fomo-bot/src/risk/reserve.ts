// Fee reserve (RISK_POLICY.md s.3a, limit 11): what one transaction attempt can cost at the caps,
// the exit budget each position keeps, and the SOL no buy may ever spend, so selling is always
// affordable. Integer math only; every cost and the reserve round up.
import { ceilDiv, lamports, microLamportsPerCu, type Lamports, type MicroLamportsPerCu } from '../core/units.ts';

export class RiskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RiskError';
  }
}

/** The HARD_CAPS this file needs (config/caps.ts provides them from step 5). */
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

/** One position's exit budget: windows x attempts x one exit attempt at the caps, plus one landed tip. */
export function positionExitBudget(caps: ReserveCaps): Lamports {
  const attempt = attemptCost(
    { signatures: caps.exitSignatures, cuPrice: caps.exitCuPriceMax, cuLimit: caps.cuLimitMax, tip: lamports(0n) },
    caps.baseFeePerSignature,
  );
  const attempts = count('retryWindows', caps.retryWindows) * count('attemptsPerWindow', caps.attemptsPerWindow);
  return lamports(attempts * attempt + lamports(caps.landedTipMax));
}

/** A buy's worst-case spend: its input, the rent and every allowed attempt (ARCHITECTURE.md s.3). */
export function maxSpend(inAmount: Lamports, rent: Lamports, attempts: number, perAttempt: Lamports): Lamports {
  return lamports(lamports(inAmount) + lamports(rent) + count('attempts', attempts) * lamports(perAttempt));
}

/** max(floor; multiplier x the sum of p95 exit costs; N x the exit budget + the helper rent). */
export function feeReserve(input: ReserveInput, caps: ReserveCaps): Lamports {
  if (!Array.isArray(input.p95ExitCosts)) {
    throw new RiskError('p95ExitCosts must be a list');
  }
  if (typeof input.wsolHelper !== 'boolean') {
    throw new RiskError('wsolHelper must be a boolean');
  }
  let p95Sum = 0n;
  for (const cost of input.p95ExitCosts) {
    p95Sum += lamports(cost);
  }
  const fromP95 = count('p95Multiplier', caps.p95Multiplier) * p95Sum;
  const helper = input.wsolHelper ? lamports(caps.wsolHelperRent) : 0n;
  const fromBudget = BigInt(input.p95ExitCosts.length) * positionExitBudget(caps) + helper;
  let reserve: bigint = lamports(caps.reserveFloor);
  for (const candidate of [fromP95, fromBudget]) {
    if (candidate > reserve) {
      reserve = candidate;
    }
  }
  return lamports(reserve);
}
