// Money units. Every on-chain amount is a bigint in base units (lamports, token base units);
// there is no floating point for amounts, fees or balances anywhere in the bot. Constructors
// validate and throw AmountError, so a bad value stops the operation (fail closed).
// Rounding rule for the whole code base: caps round DOWN (bpsOfFloor, mulDivFloor), costs and
// reserves round UP (bpsOfCeil, mulDivCeil, ceilDiv). See RISK_POLICY.md s.15.

export type Lamports = bigint & { readonly __unit: 'lamports' };
export type TokenUnits = bigint & { readonly __unit: 'token-units' };
/** Profit and loss only: may be negative. Stored as TEXT matching ^-?[0-9]+$. */
export type SignedLamports = bigint & { readonly __unit: 'lamports-signed' };
export type MicroLamportsPerCu = bigint & { readonly __unit: 'micro-lamports-per-cu' };
/** Basis points: an integer from 0 to 10,000 (100%). */
export type Bps = number & { readonly __unit: 'bps' };

export const U64_MAX: bigint = (1n << 64n) - 1n;
export const LAMPORTS_PER_SOL: bigint = 1_000_000_000n;
export const BPS_DENOMINATOR: bigint = 10_000n;
const SOL_DECIMALS = 9;

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmountError';
  }
}

function asBigint(what: string, value: unknown): bigint {
  if (typeof value !== 'bigint') {
    throw new AmountError(`${what} must be a bigint, got ${typeof value}`);
  }
  return value;
}

function asU64(what: string, value: unknown): bigint {
  const v = asBigint(what, value);
  if (v < 0n || v > U64_MAX) {
    throw new AmountError(`${what} is outside the u64 range: ${v}`);
  }
  return v;
}

function asNonNegative(what: string, value: unknown): bigint {
  const v = asBigint(what, value);
  if (v < 0n) {
    throw new AmountError(`${what} must not be negative: ${v}`);
  }
  return v;
}

function asPositiveDivisor(value: unknown): bigint {
  const d = asBigint('divisor', value);
  if (d <= 0n) {
    throw new AmountError(`divisor must be positive: ${d}`);
  }
  return d;
}

export function lamports(value: bigint): Lamports {
  return asU64('lamports', value) as Lamports;
}

export function tokenUnits(value: bigint): TokenUnits {
  return asU64('token units', value) as TokenUnits;
}

export function microLamportsPerCu(value: bigint): MicroLamportsPerCu {
  return asU64('micro-lamports per CU', value) as MicroLamportsPerCu;
}

export function signedLamports(value: bigint): SignedLamports {
  const v = asBigint('signed lamports', value);
  if (v < -U64_MAX || v > U64_MAX) {
    throw new AmountError(`signed lamports outside +-u64: ${v}`);
  }
  return v as SignedLamports;
}

export function bps(value: number): Bps {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new AmountError(`bps must be an integer from 0 to 10000, got ${String(value)}`);
  }
  return value as Bps;
}

export function addLamports(a: Lamports, b: Lamports): Lamports {
  return lamports(asU64('a', a) + asU64('b', b));
}

export function subLamports(a: Lamports, b: Lamports): Lamports {
  const result = asU64('a', a) - asU64('b', b);
  if (result < 0n) {
    throw new AmountError(`subtraction below zero: ${a} - ${b}`);
  }
  return result as Lamports;
}

export function sumLamports(values: readonly Lamports[]): Lamports {
  let total = lamports(0n);
  for (const v of values) {
    total = addLamports(total, v);
  }
  return total;
}

/** floor(a / d) for a >= 0 and d > 0. */
export function floorDiv(a: bigint, d: bigint): bigint {
  return asNonNegative('dividend', a) / asPositiveDivisor(d);
}

/** ceil(a / d) for a >= 0 and d > 0. */
export function ceilDiv(a: bigint, d: bigint): bigint {
  const n = asNonNegative('dividend', a);
  const div = asPositiveDivisor(d);
  return (n + div - 1n) / div;
}

/** floor(a * b / d) with the exact product (no intermediate overflow). For caps. */
export function mulDivFloor(a: bigint, b: bigint, d: bigint): bigint {
  return floorDiv(asNonNegative('a', a) * asNonNegative('b', b), d);
}

/** ceil(a * b / d) with the exact product. For costs, fees and reserves. */
export function mulDivCeil(a: bigint, b: bigint, d: bigint): bigint {
  return ceilDiv(asNonNegative('a', a) * asNonNegative('b', b), d);
}

/** amount x rate / 10,000, rounded down: use for caps and limits. */
export function bpsOfFloor(amount: bigint, rate: Bps): bigint {
  return mulDivFloor(amount, BigInt(bps(rate)), BPS_DENOMINATOR);
}

/** amount x rate / 10,000, rounded up: use for costs, fees and reserves. */
export function bpsOfCeil(amount: bigint, rate: Bps): bigint {
  return mulDivCeil(amount, BigInt(bps(rate)), BPS_DENOMINATOR);
}

// ---------------------------------------------------------------- TEXT (SQLite storage)
// SQLite INTEGER is signed 64-bit, so u64 amounts are stored as canonical decimal TEXT.

const UNSIGNED_TEXT = /^(?:0|[1-9][0-9]*)$/;
const SIGNED_TEXT = /^(?:0|-?[1-9][0-9]*)$/;
const MAX_TEXT_LENGTH = 21; // "-" plus the 20 digits of U64_MAX

export function toText(value: bigint): string {
  return asBigint('value', value).toString(10);
}

function parseText(what: string, text: unknown, pattern: RegExp): bigint {
  if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH || !pattern.test(text)) {
    throw new AmountError(`${what}: not a canonical integer string: ${JSON.stringify(text)}`);
  }
  return BigInt(text);
}

export function lamportsFromText(text: string): Lamports {
  return lamports(parseText('lamports', text, UNSIGNED_TEXT));
}

export function tokenUnitsFromText(text: string): TokenUnits {
  return tokenUnits(parseText('token units', text, UNSIGNED_TEXT));
}

export function signedLamportsFromText(text: string): SignedLamports {
  return signedLamports(parseText('signed lamports', text, SIGNED_TEXT));
}

// ---------------------------------------------------------------- SOL text (display, owner input)

/** Lamports as a SOL decimal string without trailing zeros, e.g. 30000000 -> "0.03". Display only. */
export function formatSol(value: Lamports): string {
  const v = asU64('lamports', value);
  const whole = v / LAMPORTS_PER_SOL;
  const fraction = v % LAMPORTS_PER_SOL;
  if (fraction === 0n) {
    return whole.toString(10);
  }
  const digits = fraction.toString(10).padStart(SOL_DECIMALS, '0').replace(/0+$/, '');
  return `${whole.toString(10)}.${digits}`;
}

const SOL_DECIMAL = /^(0|[1-9][0-9]{0,10})(?:\.([0-9]{1,9}))?$/;

/** Parse an owner-typed SOL amount ("0.03") into lamports exactly: at most 9 decimals, no float. */
export function parseSolAmount(text: string): Lamports {
  const match = typeof text === 'string' ? SOL_DECIMAL.exec(text) : null;
  const whole = match?.[1];
  if (match === null || whole === undefined) {
    throw new AmountError(`not a SOL amount: ${JSON.stringify(text)}`);
  }
  const fraction = (match[2] ?? '').padEnd(SOL_DECIMALS, '0');
  return lamports(BigInt(whole) * LAMPORTS_PER_SOL + BigInt(fraction));
}
