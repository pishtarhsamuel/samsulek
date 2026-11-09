// Identifiers shared by every layer (ARCHITECTURE.md s.3). These are predicates: each layer
// throws its own error, so a refusal names the operation it stopped.

/** The strategies the bot knows. Copy-trading is skipped (decision D1). */
export const STRATEGY_IDS: readonly ['crowdflow', 'momentum', 'launch'] = Object.freeze([
  'crowdflow',
  'momentum',
  'launch',
] as const);

export type StrategyId = (typeof STRATEGY_IDS)[number];

export function isStrategyId(value: unknown): value is StrategyId {
  return typeof value === 'string' && (STRATEGY_IDS as readonly string[]).includes(value);
}

// Base58 addresses (32-44 characters) and generated ids (UUIDs, ULIDs) both fit. Nothing that
// could break a log line, a path or a query: no spaces, dots, slashes, quotes or control characters.
const ID_TEXT = /^[A-Za-z0-9_-]{1,128}$/;

/** An internal id, or an address used as a key: 1-128 characters of A-Z, a-z, 0-9, _ and -. */
export function isIdText(value: unknown): value is string {
  return typeof value === 'string' && ID_TEXT.test(value);
}
