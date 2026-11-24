// The test world of the approval transactions (STORAGE_DESIGN.md s.16.9): a migrated database with
// the owner's setup (0.55 SOL paper) and momentum switched to paper, a clock and a slot the test moves,
// the real authority bound to the SQLite token store, the real fault sink wired to the disk-db halt,
// the exit watch, and fakes for the marks, the rent, the breakers, the paper identity and the KILL
// file. Requests are built like the risk tests' passing scenario: a 0.055 SOL pumpswap buy quoted at
// slot 1,000, and a 400,000-token sell of an open position.
import { entryIntentId, peekExitIntent, persistHaltTx, type EngineDeps, type EntryRequest, type ExitRequest, type StoreDeps } from '../../../src/app/approve-tx.ts';
import { createEngineAuthority, type EngineAuthority } from '../../../src/app/authority.ts';
import { createExitWatch } from '../../../src/app/exit-watch.ts';
import { createEntryLatch, createFaultSink, type EntryLatch } from '../../../src/app/faults.ts';
import type { AnchorStore, AuditAnchor } from '../../../src/app/run-files.ts';
import { bps, lamports, microLamportsPerCu, type Lamports } from '../../../src/core/units.ts';
import type { Mark } from '../../../src/portfolio/equity.ts';
import type { OrderPlan } from '../../../src/risk/plan.ts';
import { insertOpening } from '../../../src/storage/repo-book.ts';
import { insertSnapshot } from '../../../src/storage/repo-observe.ts';
import { setStrategyMode } from '../../../src/storage/repo-owner.ts';
import type { Db } from '../../../src/storage/sqlite.ts';
import { WSOL } from '../risk/fixtures.ts';
import { BUY, SELL } from '../storage/money-fixtures.ts';
import { T, recordingAlerts, setUpDb, testClock, testRng, testSentinel, type RecordingAlerts, type TestClock, type TestSentinel } from './world.ts';

export const WINDOW = T - 60_000;
export const SLOT = 1_005n;
export const RENT = lamports(2_039_280n);

export const MARKET: EntryRequest['market'] = Object.freeze({
  pool: Object.freeze({ id: 'PoolA', venue: 'pumpswap', quoteMint: WSOL }),
  quote: Object.freeze({ slot: 1_000n, feeBps: bps(125), feeConfigSlot: 995n }),
  poolRealSolReserve: lamports(20_000_000_000n),
  poolMinTrade: lamports(20_000_000n),
  quotedOut: 1_000_000_000n,
  simulatedCu: null,
  attemptsAllowed: 3,
  rentRequired: lamports(1_488_440n),
  newPositionP95ExitCost: lamports(125_000n),
  wsolHelper: false,
  liveRampHalf: false,
}) as EntryRequest['market'];

/** A 0.025 SOL buy (for the exposure races): 2% slippage, and landing fees inside 0.2% of its input. */
export const SMALL_PLAN: Partial<OrderPlan> = Object.freeze({
  inAmount: 25_000_000n,
  expectedOut: 450_000_000n,
  minOut: 441_000_000n,
  cuPrice: microLamportsPerCu(100_000n),
});

/** Risk's own quote for the small plan's input. */
export const SMALL_MARKET: EntryRequest['market'] = Object.freeze({ ...MARKET, quotedOut: 450_000_000n });

export const EXIT_MARKET: ExitRequest['market'] = Object.freeze({
  quote: Object.freeze({ slot: 1_000n, feeBps: bps(125), feeConfigSlot: 995n }),
  quotedOut: 1_000_000_000n,
  pool: Object.freeze({ id: 'PoolA', venue: 'pumpswap', quoteMint: WSOL }),
  attemptsAllowed: 3,
  simulatedCu: null,
}) as ExitRequest['market'];

export interface TxWorld {
  readonly db: Db;
  readonly clock: TestClock;
  readonly slot: { value: bigint | null };
  readonly rent: { value: Lamports | null };
  readonly marks: Map<string, Mark>;
  readonly latch: EntryLatch;
  readonly alerts: RecordingAlerts;
  readonly sentinel: TestSentinel;
  readonly fatal: string[];
  readonly authority: EngineAuthority;
  readonly deps: EngineDeps;
  readonly store: StoreDeps;
  readonly anchors: MemoryAnchors;
}

/** The audit anchor in memory: what was written, and a switch that makes the next write fail. */
export interface MemoryAnchors extends AnchorStore {
  readonly written: AuditAnchor[];
  failing: boolean;
}

export function memoryAnchors(): MemoryAnchors {
  const m: MemoryAnchors = {
    written: [],
    failing: false,
    read: () => m.written.at(-1) ?? null,
    write: (a) => {
      if (m.failing) {
        throw new Error('disk full');
      }
      m.written.push(a);
    },
  };
  return m;
}

/** `setUp: false` for a second handle on a database another world set up already (the race tests). */
export function txWorld(db: Db = setUpDb(), options: { readonly setUp?: boolean } = {}): TxWorld {
  if (options.setUp !== false) {
    db.transaction((tx) => {
      setStrategyMode(tx, T - 1, 'owner-telegram', 'momentum', 'paper');
      insertSnapshot(tx, 'paper', T, lamports(550_000_000n), lamports(550_000_000n)); // the money check T1 needs fresh (6e-2)
    });
  }
  const clock = testClock();
  const slot: { value: bigint | null } = { value: SLOT };
  const slots = { currentSlot: (): bigint | null => slot.value };
  const rent: { value: Lamports | null } = { value: RENT };
  const marks = new Map<string, Mark>();
  const latch = createEntryLatch();
  const alerts = recordingAlerts();
  const sentinel = testSentinel();
  const fatal: string[] = [];
  const late: { store: StoreDeps | null } = { store: null };
  const faults = createFaultSink({
    latch,
    alerts,
    clock,
    onFatal: (code) => void fatal.push(code),
    onDiskTrouble: () => {
      if (late.store !== null) {
        persistHaltTx(late.store, 'disk-db');
      }
    },
  });
  const anchors = memoryAnchors();
  const store: StoreDeps = Object.freeze({ db, clock, slots, latch, faults, alerts, anchors });
  late.store = store;
  const authority = createEngineAuthority({ db, clock, slots, rng: testRng(), faults, latch, sentinel });
  const deps: EngineDeps = Object.freeze({
    mode: 'paper',
    db,
    clock,
    slots,
    issuer: authority.issuer,
    marks: { marks: () => marks },
    rent: { wsolHelperRent: () => rent.value },
    breakers: { breakers: () => [] },
    identity: Object.freeze({ wallet: 'OurWallet', wsolMint: WSOL, tokenAccountOf: (mint: string) => `AtaOf${mint}` }),
    sentinel,
    latch,
    faults,
    alerts,
    exitWatch: createExitWatch({ alerts, clock, latch }),
    anchors,
  });
  return { db, clock, slot, rent, marks, latch, alerts, sentinel, fatal, authority, deps, store, anchors };
}

/** A paper buy that passes everything: momentum, MintA, a 0.055 SOL plan for the request's own ids. */
export function entryRequest(over: Partial<EntryRequest> = {}, plan: Partial<OrderPlan> = {}): EntryRequest {
  const strategy = over.strategy ?? 'momentum';
  const mint = over.mint ?? 'MintA';
  const windowStartMs = over.windowStartMs ?? WINDOW;
  const positionId = over.positionId ?? 'ps_new1';
  const intentId = entryIntentId(strategy, mint, windowStartMs);
  return {
    strategy,
    mode: 'paper',
    mint,
    creator: 'CreatorA',
    sizeHint: 'normal',
    windowStartMs,
    positionId,
    confidenceBps: 7_500,
    inputsAsOf: T - 1_000,
    reasons: ['flow-up'],
    inputs: { netFlowLamports: 123_456n, fresh: true },
    plan: { ...BUY, intentId, positionId, mint, tokenAccount: `AtaOf${mint}`, ...plan },
    market: MARKET,
    ...over,
  };
}

/** An open position holding tokens, as T3 will leave it (the buy settled), written by hand. */
export function openPosition(db: Db, id: string, mint = 'MintA', units = 400_000n): void {
  db.transaction((tx) => insertOpening(tx, { id, mint, strategy: 'momentum', mode: 'paper', openedAt: T - 10_000, maxSpend: lamports(30_000_000n) }, lamports(125_000n)));
  db.transaction((tx) =>
    tx.run("UPDATE positions SET status = 'open', max_spend = NULL, token_units = ?, tokens_bought = ?, updated_at = ? WHERE id = ?", units.toString(), units.toString(), BigInt(T - 9_000), id),
  );
}

/** An automatic sell of the position's 400,000 tokens, built for the exit number peekExitIntent gives. */
export function exitRequest(deps: EngineDeps, positionId: string, over: Partial<ExitRequest> = {}, plan: Partial<OrderPlan> = {}): ExitRequest {
  const { intentId } = peekExitIntent(deps, positionId);
  return {
    positionId,
    fractionBps: 10_000,
    urgency: 'normal',
    reasons: ['take-profit'],
    inputs: {},
    inputsAsOf: null,
    origin: { kind: 'automatic', sellSimPassed: true },
    plan: { ...SELL, intentId, positionId, ...plan },
    market: EXIT_MARKET,
    ...over,
  };
}
