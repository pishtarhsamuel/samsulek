// Shared fixtures for the money-path storage tests (STORAGE_DESIGN.md s.15): plans like the risk
// tests' own (tests/unit/risk/approval.test.ts), the largest plans the schema can hold, and a real
// approval authority, so every token the tests store comes from risk's own issuer and every redeem
// goes through risk's own verifier. Only plans that pass the re-check get a token (`checked`).
import { U64_MAX, bps, lamports, microLamportsPerCu } from '../../../src/core/units.ts';
import {
  createApprovalAuthority,
  type ApprovalAuthority,
  type ApprovalToken,
  type RedeemSnapshot,
  type SlotSource,
  type TokenStore,
} from '../../../src/risk/approval.ts';
import { type OrderPlan, type PlanMode } from '../../../src/risk/plan.ts';
import { FREE_FEES, checked } from '../risk/fixtures.ts';

/** A buy plan as the risk tests write one: a 0.055 SOL pumpswap buy, quoted at slot 1,000. */
export const BUY: OrderPlan = Object.freeze({
  orderId: 'order-1',
  intentId: 'intent-1',
  positionId: 'p1',
  mode: 'paper',
  kind: 'buy',
  urgency: 'normal',
  venue: 'pumpswap',
  route: 'direct',
  mint: 'MintA',
  pool: 'PoolA',
  tokenAccount: 'AtaOfMintA',
  wallet: 'OurWallet',
  inAmount: 55_000_000n,
  expectedOut: 1_000_000_000n,
  minOut: 980_000_000n,
  slippageBps: bps(200),
  feeBps: bps(125),
  feeConfigSlot: 995n,
  cuLimit: 300_000,
  cuPrice: microLamportsPerCu(200_000n),
  tip: Object.freeze({ path: 'jito', lamports: lamports(1_000n) }),
  rentLamports: lamports(1_488_440n),
  attempts: 3,
  closeAccountAfter: false,
  quoteSlot: 1_000n,
  lastValidBlockHeight: null,
}) as OrderPlan;

/** A sell of 400,000 token units of the same position. */
export const SELL: OrderPlan = Object.freeze({ ...BUY, orderId: 'order-2', intentId: 'exit-p1-0', kind: 'sell', inAmount: 400_000n, rentLamports: lamports(0n) }) as OrderPlan;

/** Closing the emptied token account. */
export const CLOSE: OrderPlan = Object.freeze({
  ...SELL,
  orderId: 'order-3',
  intentId: 'exit-p1-1',
  kind: 'close-account',
  inAmount: 0n,
  expectedOut: 0n,
  minOut: 0n,
  slippageBps: bps(0),
  attempts: 1,
  ...FREE_FEES,
}) as OrderPlan;

/** 63 characters: the longest id the secret filter lets through (64 key-like characters in a row look like a key). */
export const LONGEST_ID = 'P'.repeat(31) + '-' + 'Q'.repeat(31);
/** A base58 address of 44 characters (the longest a Solana address takes). */
export const ADDRESS_44 = 'H'.repeat(22) + 'k'.repeat(22);

/** The largest plan of a kind: every id at 63 characters, every address at 44, every number at its top, the longest list values. */
export function largestPlan(kind: 'buy' | 'sell' | 'close-account'): OrderPlan {
  return Object.freeze({
    orderId: LONGEST_ID,
    intentId: LONGEST_ID,
    positionId: LONGEST_ID,
    mode: 'paper',
    kind,
    urgency: 'protective',
    venue: 'raydium-cpmm',
    route: 'jupiter-build',
    mint: ADDRESS_44,
    pool: ADDRESS_44,
    tokenAccount: ADDRESS_44,
    wallet: ADDRESS_44,
    inAmount: U64_MAX,
    expectedOut: U64_MAX,
    minOut: U64_MAX,
    slippageBps: bps(10_000),
    feeBps: bps(10_000),
    feeConfigSlot: U64_MAX,
    cuLimit: 4_294_967_295,
    cuPrice: microLamportsPerCu(U64_MAX),
    tip: Object.freeze({ path: 'helius-swqos', lamports: lamports(U64_MAX) }),
    rentLamports: lamports(U64_MAX),
    attempts: Number.MAX_SAFE_INTEGER,
    closeAccountAfter: true,
    quoteSlot: 2n ** 63n - 1n, // a slot column takes at most the largest SQLite integer
    lastValidBlockHeight: U64_MAX,
  }) as OrderPlan;
}

export const KEY = Uint8Array.from({ length: 32 }, (_v, i) => (i * 11 + 5) % 256);

/** A slot source the test moves by hand (the chain stream in the bot). */
export class Slots implements SlotSource {
  value: bigint | null = 1_005n;
  currentSlot(): bigint | null {
    return this.value;
  }
}

/** A store that only remembers what it was given: for tests that need a token but not T2. */
export class MemoryStore implements TokenStore {
  readonly seen = new Map<string, RedeemSnapshot>();
  consume(tokenId: string, snapshot: RedeemSnapshot): boolean {
    if (this.seen.has(tokenId)) {
      return false;
    }
    this.seen.set(tokenId, snapshot);
    return true;
  }
}

export interface Harness {
  readonly a: ApprovalAuthority;
  readonly slots: Slots;
}

/** A real authority for one mode; `store` defaults to a MemoryStore (T2 tests pass their own SQLite store). */
export function authority(options: { mode?: PlanMode; store?: TokenStore; firstTokenId?: number } = {}): Harness {
  let n = options.firstTokenId ?? 0;
  const slots = new Slots();
  const a = createApprovalAuthority({
    mode: options.mode ?? 'paper',
    key: KEY,
    newTokenId: () => `tok-${(n += 1)}`,
    planFreshSlots: 25,
    slots,
    store: options.store ?? new MemoryStore(),
  });
  return { a, slots };
}

/** A token for the plan, from risk's own issuer (the plan must pass the re-check). */
export const issue = (h: Harness, plan: OrderPlan): ApprovalToken => h.a.issuer.issue(checked(plan));
