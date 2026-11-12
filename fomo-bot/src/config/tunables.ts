// The tunables (RISK_POLICY.md s.12; ARCHITECTURE.md s.3 `Tunables`): every value /set and approved AI
// proposals may change. Each has its bounds (config/caps.ts TUNABLE_BOUNDS, which a test holds at or
// inside the hard limits), the direction that is safer, what the AI may do with it, and whether /set
// may move it both ways. There are no modes here: a strategy's mode lives only in the flags table, so
// no config operation can make anything live (invariant 24). Values are base units: basis points,
// milliseconds, minutes, counts, and lamports as bigint. Pure: no I/O and no clock; the engine stores
// the versions (config/changes.ts plans every change). Validation is written out here rather than with
// a schema package, so this needs no dependency.
import { type StrategyId } from '../core/ids.ts';
import { TUNABLE_BOUNDS } from './caps.ts';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Bounds = typeof TUNABLE_BOUNDS;
export type TunableGroup = keyof Bounds;
type ValueOf<B> = B extends readonly [bigint, bigint] ? bigint : number;

/** One set of values: the groups and names of TUNABLE_BOUNDS, lamports as bigint, everything else a whole number. */
export type Tunables = { readonly [G in TunableGroup]: { readonly [K in keyof Bounds[G]]: ValueOf<Bounds[G][K]> } };
export type TunableValue = number | bigint;
/** A tunable's name as the owner types it: 'risk.tradePctBps', 'crowdflow.minDistinctBuyers5m', ... */
export type TunablePath = { [G in TunableGroup]: `${G}.${keyof Bounds[G] & string}` }[TunableGroup];

export interface TunableRule {
  /** The safer direction: 'down' (a lower value is stricter), 'up', or 'none' (neither is clearly safer). */
  readonly safer: 'down' | 'up' | 'none';
  /** What an approved AI proposal may do (s.12): move it only the safer way, either way, or not at all. */
  readonly ai: 'safer' | 'either' | 'never';
  /** What /set may do: either way within the bounds, or (the paper model) only the more pessimistic way. */
  readonly set: 'either' | 'safer';
}

const LOWER_ONLY: TunableRule = Object.freeze({ safer: 'down', ai: 'safer', set: 'either' });
const RAISE_ONLY: TunableRule = Object.freeze({ safer: 'up', ai: 'safer', set: 'either' });
const AI_EITHER: TunableRule = Object.freeze({ safer: 'none', ai: 'either', set: 'either' });
const PESSIMISTIC: TunableRule = Object.freeze({ safer: 'up', ai: 'never', set: 'safer' });

/**
 * The rules of RISK_POLICY.md s.12, one per tunable. The AI moves only the parameters marked for it:
 * risk, safety, anti-sybil and the hard stop only the safer way; the token age and curve limits are
 * not marked, so only /set changes them; the paper model only becomes more pessimistic, and never by
 * the AI. landingSpend is "yes" for the AI, and spending less on landing counts as the safer way.
 */
export const RULES: Readonly<Record<TunablePath, TunableRule>> = Object.freeze({
  'risk.tradePctBps': LOWER_ONLY,
  'risk.openPositions': LOWER_ONLY,
  'risk.exposurePctBps': LOWER_ONLY,
  'risk.entriesPerDay': LOWER_ONLY,
  'risk.costRuleBps': LOWER_ONLY,
  'risk.poolShareBps': LOWER_ONLY,
  'risk.priceCrossCheckBps': LOWER_ONLY,
  'risk.dailyStopBps': LOWER_ONLY,
  'risk.peakHaltBps': LOWER_ONLY,
  'risk.buySlippageBps': LOWER_ONLY,
  'risk.sellSlippageBps': LOWER_ONLY,
  'risk.landingSpendBps': Object.freeze({ safer: 'down', ai: 'either', set: 'either' }),
  'risk.tokenAgeMs': Object.freeze({ safer: 'up', ai: 'never', set: 'either' }),
  'risk.curveProgressBps': Object.freeze({ safer: 'down', ai: 'never', set: 'either' }),
  'crowdflow.minDistinctBuyers5m': RAISE_ONLY,
  'crowdflow.minCompletenessBps': RAISE_ONLY,
  'crowdflow.maxTopBuyerShareBps': LOWER_ONLY,
  'crowdflow.maxSameSlotShareBps': LOWER_ONLY,
  'crowdflow.maxIdenticalSizeShareBps': LOWER_ONLY,
  'crowdflow.minAccelerationBps': AI_EITHER,
  'crowdflow.maxRun15mBps': AI_EITHER,
  'momentum.minAgeMs': RAISE_ONLY,
  'momentum.minLiquidityLamports': RAISE_ONLY,
  'momentum.pullbackBps': AI_EITHER,
  'launch.minHolders': RAISE_ONLY,
  'launch.maxTop10ShareBps': LOWER_ONLY,
  'launch.maxCreatorShareBps': LOWER_ONLY,
  'launch.curveProgressWindowBps': AI_EITHER,
  'exits.hardStopBps': LOWER_ONLY,
  'exits.takeProfitBps': AI_EITHER,
  'exits.trailBps': AI_EITHER,
  'exits.timeStopMin': AI_EITHER,
  'exits.timeStopMinGainBps': AI_EITHER,
  'paper.pFailBps': PESSIMISTIC,
  'paper.extraLatencyMs': PESSIMISTIC,
  'paper.competitionBpsPerLeg': PESSIMISTIC,
});

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const SOL = 1_000_000_000n;

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) {
      deepFreeze(inner);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * The first version's values. risk, exits and paper are the policy's numbers (RISK_POLICY.md s.3:
 * the defaults marked P; the exits are policy P1: -35% hard stop, take profit at +100%, a 30% trail,
 * a 30-minute time stop under +10%; the paper model at its floors). The strategy values are
 * placeholders inside their bounds (decision D2: tuned values live only in the server file and the
 * database), to be set by quant-strategist in Phase 4.
 */
export const DEFAULT_TUNABLES: Tunables = deepFreeze({
  risk: {
    tradePctBps: 1_000,
    openPositions: 4,
    exposurePctBps: 5_000,
    entriesPerDay: 8,
    costRuleBps: 500,
    poolShareBps: 50,
    priceCrossCheckBps: 300,
    dailyStopBps: 3_000,
    peakHaltBps: 5_000,
    buySlippageBps: 200,
    sellSlippageBps: 300,
    landingSpendBps: 20,
    tokenAgeMs: 180_000,
    curveProgressBps: 9_000,
  },
  crowdflow: {
    minDistinctBuyers5m: 10,
    minCompletenessBps: 7_000,
    maxTopBuyerShareBps: 3_000,
    maxSameSlotShareBps: 3_000,
    maxIdenticalSizeShareBps: 3_000,
    minAccelerationBps: 10_000,
    maxRun15mBps: 10_000,
  },
  momentum: {
    minAgeMs: DAY_MS,
    minLiquidityLamports: 50n * SOL,
    pullbackBps: 1_500,
  },
  launch: {
    minHolders: 50,
    maxTop10ShareBps: 3_000,
    maxCreatorShareBps: 500,
    curveProgressWindowBps: 5_000,
  },
  exits: {
    hardStopBps: 3_500,
    takeProfitBps: 10_000,
    trailBps: 3_000,
    timeStopMin: 30,
    timeStopMinGainBps: 1_000,
  },
  paper: {
    pFailBps: 2_000,
    extraLatencyMs: 2_000,
    competitionBpsPerLeg: 50,
  },
});

/** Every group with its names, in the order of TUNABLE_BOUNDS (the order of the stored JSON). */
const LAYOUT: ReadonlyArray<readonly [TunableGroup, readonly string[]]> = Object.freeze(
  (Object.keys(TUNABLE_BOUNDS) as TunableGroup[]).map((group) => Object.freeze([group, Object.freeze(Object.keys(TUNABLE_BOUNDS[group]))] as const)),
);

/** Every tunable's name, in a fixed order. */
export const TUNABLE_PATHS: readonly TunablePath[] = Object.freeze(LAYOUT.flatMap(([group, names]) => names.map((name) => `${group}.${name}` as TunablePath)));

const BOUNDS: Readonly<Record<string, readonly [TunableValue, TunableValue]>> = Object.freeze(
  Object.fromEntries(
    LAYOUT.flatMap(([group, names]) =>
      names.map((name) => [`${group}.${name}`, (TUNABLE_BOUNDS[group] as Readonly<Record<string, readonly [TunableValue, TunableValue]>>)[name]!] as const),
    ),
  ),
);

export function isTunablePath(value: unknown): value is TunablePath {
  return typeof value === 'string' && Object.hasOwn(RULES, value);
}

function split(path: TunablePath): readonly [TunableGroup, string] {
  const dot = path.indexOf('.');
  return [path.slice(0, dot) as TunableGroup, path.slice(dot + 1)];
}

/** The [min, max] of a tunable. */
export function boundsOf(path: TunablePath): readonly [TunableValue, TunableValue] {
  if (!isTunablePath(path)) {
    throw new ConfigError('not a tunable');
  }
  return BOUNDS[path]!;
}

/** The group a tunable belongs to; for a strategy's own parameters, that strategy. */
export function groupOf(path: TunablePath): TunableGroup {
  return split(path)[0];
}

/** The strategy whose signal parameters these are, or null (risk, exits and the paper model are shared). */
export function strategyOf(path: TunablePath): StrategyId | null {
  const group = groupOf(path);
  return group === 'crowdflow' || group === 'momentum' || group === 'launch' ? group : null;
}

export function valueAt(values: Tunables, path: TunablePath): TunableValue {
  const [group, name] = split(path);
  return (values[group] as Readonly<Record<string, TunableValue>>)[name]!;
}

/** A new, frozen set of values with one value replaced (the value is checked against its bounds). */
export function withValue(values: Tunables, path: TunablePath, value: TunableValue): Tunables {
  const [group, name] = split(path);
  const checked = checkValue(path, value);
  const copy: Record<string, Record<string, TunableValue>> = {};
  for (const [g, names] of LAYOUT) {
    const inner: Record<string, TunableValue> = {};
    for (const n of names) {
      inner[n] = g === group && n === name ? checked : valueAt(values, `${g}.${n}` as TunablePath);
    }
    copy[g] = inner;
  }
  return deepFreeze(copy) as unknown as Tunables;
}

/** A tunable value, checked: the right kind of number for its bounds, inside them. */
function checkValue(path: TunablePath, raw: unknown): TunableValue {
  const [min, max] = boundsOf(path);
  if (typeof min === 'bigint' && typeof max === 'bigint') {
    if (typeof raw !== 'bigint') {
      throw new ConfigError(`${path} must be a whole number of lamports`);
    }
    if (raw < min || raw > max) {
      throw new ConfigError(`${path} must be from ${min} to ${max}`);
    }
    return raw;
  }
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
    throw new ConfigError(`${path} must be a whole number`);
  }
  if (raw < (min as number) || raw > (max as number)) {
    throw new ConfigError(`${path} must be from ${min} to ${max}`);
  }
  return raw;
}

/** A list made by JSON.parse or a literal: the plain array prototype, no holes, no extra fields, elements read once. */
export function plainList(what: string, value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) {
    throw new ConfigError(`${what} must be a plain list`);
  }
  const length = (value as readonly unknown[]).length;
  if (Object.getOwnPropertyNames(value).length !== length + 1) {
    throw new ConfigError(`${what} must be a plain list`); // a hole or an extra field
  }
  const out: unknown[] = [];
  for (let i = 0; i < length; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new ConfigError(`${what} must be a plain list`);
    }
    out.push(descriptor.value);
  }
  return out;
}

/**
 * An object made by JSON.parse or a literal, with exactly these fields: own data properties only (a
 * getter is refused, never run), the plain or no prototype, no symbols. Each field is read once.
 */
export function plainFields(what: string, value: unknown, expected: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`${what} must be an object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length > 0) {
    throw new ConfigError(`${what} must be a plain object`);
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== expected.length || !expected.every((name) => names.includes(name))) {
    throw new ConfigError(`${what} must have exactly the fields ${expected.join(', ')}`);
  }
  const out: Record<string, unknown> = {};
  for (const name of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new ConfigError(`${what}.${name} must be a plain value`);
    }
    out[name] = descriptor.value; // read once
  }
  return out;
}

/**
 * A whole set of values, checked: exactly the groups and names of TUNABLE_BOUNDS (nothing missing,
 * nothing extra: no mode, no hard cap, no address can ride along), each the right kind of number and
 * inside its bounds. Returns a frozen copy; the input is read once. Anything else throws ConfigError.
 */
export function checkTunables(input: unknown): Tunables {
  return readTunables(input, (_path, raw) => raw);
}

function readTunables(input: unknown, convert: (path: TunablePath, raw: unknown) => unknown): Tunables {
  const groups = plainFields('the tunables', input, LAYOUT.map(([group]) => group));
  const out: Record<string, Record<string, TunableValue>> = {};
  for (const [group, names] of LAYOUT) {
    const fields = plainFields(group, groups[group], names);
    const inner: Record<string, TunableValue> = {};
    for (const name of names) {
      const path = `${group}.${name}` as TunablePath;
      inner[name] = checkValue(path, convert(path, fields[name]));
    }
    out[group] = inner;
  }
  return deepFreeze(out) as unknown as Tunables;
}

const DIGITS = /^(0|[1-9][0-9]{0,19})$/;

export type ParsedValue =
  | { readonly ok: true; readonly value: TunableValue }
  | { readonly ok: false; readonly reason: 'not-a-number' | 'out-of-bounds' };

/** The value is of the tunable's kind (bigint for lamports, a safe integer otherwise) and inside its bounds. */
export function inBounds(path: TunablePath, value: unknown): value is TunableValue {
  const [min, max] = boundsOf(path);
  if (typeof min === 'bigint') {
    return typeof value === 'bigint' && value >= min && value <= (max as bigint);
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= (max as number);
}

/**
 * A value as the owner types it after /set, or as the AI writes it: decimal digits in the tunable's
 * base unit (no sign, point, exponent or space), or a JSON whole number from 0 up to 2^53 - 1; for
 * lamports also a bigint. Lamports become bigint. Then the bounds. Never throws for a bad value: it
 * says which kind of bad.
 */
export function parseTunableValue(path: TunablePath, raw: unknown): ParsedValue {
  const [min] = boundsOf(path);
  let value: TunableValue;
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) {
    value = typeof min === 'bigint' ? BigInt(raw) : raw;
  } else if (typeof raw === 'string' && DIGITS.test(raw)) {
    value = typeof min === 'bigint' ? BigInt(raw) : Number(raw);
  } else if (typeof raw === 'bigint' && raw >= 0n && typeof min === 'bigint') {
    value = raw;
  } else {
    return { ok: false, reason: 'not-a-number' };
  }
  return inBounds(path, value) ? { ok: true, value } : { ok: false, reason: 'out-of-bounds' };
}

/** The stored form: JSON in the fixed order, lamports as decimal strings. */
export function encodeTunables(values: Tunables): string {
  const checked = checkTunables(values);
  return JSON.stringify(checked, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
}

/** Back from the stored form, checked exactly as checkTunables; lamports must be decimal strings. */
export function decodeTunables(text: string): Tunables {
  if (typeof text !== 'string') {
    throw new ConfigError('stored tunables must be text');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError('stored tunables are not valid JSON');
  }
  return readTunables(parsed, (path, raw) => {
    const [min] = boundsOf(path);
    if (typeof min !== 'bigint') {
      return raw;
    }
    if (typeof raw !== 'string' || !DIGITS.test(raw)) {
      throw new ConfigError(`${path} must be stored as decimal digits`);
    }
    return BigInt(raw);
  });
}

/** Whether moving from one value to another is safer, riskier, or neither (no safer direction, or no move). */
export function changeSafety(path: TunablePath, from: TunableValue, to: TunableValue): 'safer' | 'riskier' | 'neutral' {
  const { safer } = RULES[path];
  if (safer === 'none' || from === to) {
    return 'neutral';
  }
  const lower = typeof from === 'bigint' && typeof to === 'bigint' ? to < from : (to as number) < (from as number);
  return (safer === 'down') === lower ? 'safer' : 'riskier';
}

/** Every tunable whose value differs, in the fixed order. */
export function changedPaths(from: Tunables, to: Tunables): readonly TunablePath[] {
  return Object.freeze(TUNABLE_PATHS.filter((path) => valueAt(from, path) !== valueAt(to, path)));
}
