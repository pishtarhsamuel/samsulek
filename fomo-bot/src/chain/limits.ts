// What chain/ may ask the RPC and how much (docs/CHAIN_DESIGN.md s.3 and s.5; ARCHITECTURE s.6 with R3):
// the read methods with their caps per 10 s, P0 reserves, timeouts and byte caps, the methods refused
// before any request, and the governor's fixed numbers. Pinned by a test; a change is a reviewed change.
// Every number is at or under the public endpoint's documented and header limits (VERIFIED_FACTS s.9).
// Pure.

/** A provider's code: the only provider name that reaches events and logs (never a URL). */
export type ProviderId = 'public-mainnet';

/** P0: exits, position prices, confirmations, reconciliation (never shed); P1: the safety checks of a buy under way (never shed, no reserve); P2 to P4: shed in that order. */
export type Priority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

export const PRIORITIES: readonly Priority[] = Object.freeze(['P0', 'P1', 'P2', 'P3', 'P4'] as const);

/** The read methods chain/ knows; none of them sends (the last four arrive in 7h). */
export type ReadMethod =
  | 'getGenesisHash'
  | 'getSlot'
  | 'getBlockHeight'
  | 'getBlockTime'
  | 'getMultipleAccounts'
  | 'getRecentPrioritizationFees'
  | 'getMinimumBalanceForRentExemption'
  | 'getSignaturesForAddress'
  | 'getTransaction'
  | 'simulateTransaction'
  | 'getProgramAccounts';

export interface MethodRule {
  /** Requests per 10 s, at most. */
  readonly capPer10s: number;
  /** Of those, kept for P0 only. */
  readonly p0Reserve: number;
  readonly timeoutMs: number;
  /** The most decoded bytes one answer may have (the transport stops reading there). */
  readonly maxResponseBytes: number;
  /** The most urgent priority that may use the method (getProgramAccounts: never P0). */
  readonly mostUrgent: Priority;
}

const KIB = 1024;
const MIB = 1024 * KIB;

const rule = (capPer10s: number, p0Reserve: number, timeoutMs: number, maxResponseBytes: number, mostUrgent: Priority = 'P0'): MethodRule =>
  Object.freeze({ capPer10s, p0Reserve, timeoutMs, maxResponseBytes, mostUrgent });

/** CHAIN_DESIGN s.5's table: the caps add up to 49 of our total 60, the P0 reserves to 27. */
export const METHOD_TABLE: Readonly<Record<ReadMethod, MethodRule>> = Object.freeze({
  getGenesisHash: rule(1, 1, 5_000, KIB),
  getSlot: rule(6, 6, 5_000, KIB),
  getBlockHeight: rule(2, 2, 5_000, KIB),
  getBlockTime: rule(1, 1, 5_000, KIB),
  getMultipleAccounts: rule(20, 8, 5_000, MIB),
  getRecentPrioritizationFees: rule(4, 2, 5_000, 64 * KIB),
  getMinimumBalanceForRentExemption: rule(1, 1, 5_000, KIB),
  getSignaturesForAddress: rule(3, 2, 5_000, 256 * KIB),
  getTransaction: rule(3, 2, 5_000, 256 * KIB),
  simulateTransaction: rule(4, 2, 5_000, 256 * KIB),
  getProgramAccounts: rule(4, 0, 15_000, 2 * MIB, 'P1'),
});

/** Refused before any request is made (the public endpoint's header limit for it is 0). */
export const REFUSED_METHODS: readonly string[] = Object.freeze(['getTokenLargestAccounts']);

/** The governor's fixed numbers (CHAIN_DESIGN s.6). */
export const BUDGET_RULES = Object.freeze({
  /** The request windows (the window behind the header limits is assumed to be 10 s, U4). */
  windowMs: 10_000,
  /** Our total per 10 s, of the documented 100, and its P0 reserve. */
  totalCap: 60,
  totalP0Reserve: 27,
  /** Decoded bytes per 30 s, of the documented 100 MB, and the P0 reserve. */
  dataWindowMs: 30_000,
  dataCapBytes: 50_000_000,
  dataP0ReserveBytes: 10_000_000,
  /** HTTP requests in flight, and how many of them only P0 may take (R13). */
  maxInFlight: 6,
  inFlightP0Reserve: 2,
  /** A bucket over this share of its cap for busyHoldMs raises the shed level. */
  busyRatio: 0.8,
  busyHoldMs: 60_000,
  /** The shed level falls by one after this long without a trigger; it never passes maxShed. */
  shedDecayMs: 300_000,
  maxShed: 3,
  /** A 429's wait when its Retry-After is missing or unreadable, the shortest (one window, even for
   *  Retry-After 0: a limiter that keeps saying 0 is never hammered into a 403; review Y, risk 4), and
   *  the longest wait honoured. */
  retryAfterDefaultMs: 60_000,
  retryAfterMinMs: 10_000,
  retryAfterMaxMs: 600_000,
  /** How long a 403 blocks the provider before one P0 probe. */
  blockMs: 900_000,
});
