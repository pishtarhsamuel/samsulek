// Property tests for entry blocks (TEST_PLAN.md s.4, invariant 4): for random combinations of
// flags, breakers, cooldowns and counters, the reasons equal those of a small independent model,
// so no block can silently fail to fire; and no entry is ever allowed while kill, halt, pause,
// the daily stop, an applicable breaker or mode off is in force.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { STRATEGY_IDS, type StrategyId } from '../../../src/core/ids.ts';
import {
  BREAKER_NAMES,
  entryBlocks,
  type BlockReason,
  type BreakerScope,
  type BreakerState,
  type EntryCheck,
  type EntryState,
  type StrategyMode,
} from '../../../src/risk/blocks.ts';

fc.configureGlobal({ numRuns: 1_000 }); // TEST_PLAN.md s.4 (this file's process only)

const T0 = 1_762_000_000_000;
const MIN = 60_000;
const MINTS = ['MintA', 'MintB', 'MintC'] as const;
const VENUES = ['pump-curve', 'pumpswap', 'raydium-cpmm'] as const;
const CREATORS = ['CreatorA', 'CreatorB'] as const;

const strategy = fc.constantFrom(...STRATEGY_IDS);
const mode = fc.constantFrom<StrategyMode>('off', 'paper', 'live');
const near = (span: number) => fc.integer({ min: -span, max: span }).map((d) => T0 + d);
const rare = fc.integer({ min: 0, max: 4 }).map((n) => n === 0); // about 20% true

const scopeArb: fc.Arbitrary<BreakerScope> = fc.oneof(
  fc.constant({ kind: 'all' as const }),
  strategy.map((s) => ({ kind: 'strategy' as const, strategy: s })),
  fc.constantFrom(...MINTS).map((m) => ({ kind: 'mint' as const, mint: m })),
  fc.constantFrom(...VENUES).map((v) => ({ kind: 'venue' as const, venue: v })),
  fc.constant({ kind: 'live' as const }),
);
const breakerArb: fc.Arbitrary<BreakerState> = fc.record({
  name: fc.constantFrom(...BREAKER_NAMES),
  scope: scopeArb,
  until: fc.option(near(10 * MIN), { nil: null }),
});
const perStrategy = fc
  .array(fc.tuple(strategy, near(3 * 60 * MIN)), { maxLength: 3 })
  .map((pairs) => Object.fromEntries(pairs) as Partial<Record<StrategyId, number>>);
const subset = <T extends string>(values: readonly T[]) => fc.subarray([...values]).map((s) => new Set<string>(s));

const stateArb: fc.Arbitrary<EntryState> = fc.record({
  now: fc.constant(T0),
  kill: rare,
  haltReasons: fc.array(fc.constantFrom('RECONCILE_MISMATCH', 'PAPER_LEDGER'), { maxLength: 1 }),
  haltClearedAt: fc.option(near(30 * MIN), { nil: null }),
  paused: rare,
  dailyStop: rare,
  entriesStopped: rare,
  equityKnown: rare.map((r) => !r),
  equityJumpPending: rare,
  modes: fc.record({ crowdflow: mode, momentum: mode, launch: mode }),
  breakers: fc.array(breakerArb, { maxLength: 3 }),
  strategyPausedUntil: perStrategy,
  strategyOffUntil: perStrategy,
  tokenCooldownUntil: fc.array(fc.tuple(fc.constantFrom(...MINTS), near(7 * 60 * MIN)), { maxLength: 3 }).map((p) => new Map(p)),
  bannedMints: subset(MINTS),
  blockedCreators: subset(CREATORS),
  activeMints: subset(MINTS),
  entriesToday: fc.integer({ min: 0, max: 14 }),
  // up to far above the hard values (12 a day, 4 positions): the hard values must still hold
  entriesPerDay: fc.oneof(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 13, max: 100 })),
  activePositions: fc.integer({ min: 0, max: 6 }),
  maxPositions: fc.oneof(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 5, max: 40 })),
});
const entryArb: fc.Arbitrary<EntryCheck> = fc.record({
  strategy,
  mode: fc.constantFrom<'paper' | 'live'>('paper', 'live'),
  mint: fc.constantFrom(...MINTS),
  venue: fc.constantFrom(...VENUES),
  creator: fc.option(fc.constantFrom(...CREATORS), { nil: null }),
});

/** A breaker that blocks this entry: in scope, and open or still in its quiet time. */
function breakerBlocks(s: EntryState, e: EntryCheck, b: BreakerState): boolean {
  const scoped =
    b.scope.kind === 'all' ||
    (b.scope.kind === 'strategy' && b.scope.strategy === e.strategy) ||
    (b.scope.kind === 'mint' && b.scope.mint === e.mint) ||
    (b.scope.kind === 'venue' && b.scope.venue === e.venue) ||
    (b.scope.kind === 'live' && e.mode === 'live');
  return scoped && (b.until === null || s.now < b.until);
}

/** The model: the same rules, written as plainly as possible. */
function expected(s: EntryState, e: EntryCheck): BlockReason[] {
  const out: BlockReason[] = [];
  const active = (until: number | null | undefined): boolean => until !== null && until !== undefined && s.now < until;
  if (s.kill) out.push('kill');
  if (s.haltReasons.length > 0) out.push('halt');
  if (s.paused) out.push('pause');
  if (s.dailyStop) out.push('daily-stop');
  if (s.entriesStopped) out.push('entries-stopped');
  if (!s.equityKnown) out.push('equity-unknown');
  if (s.equityJumpPending) out.push('equity-jump-check');
  if (s.haltClearedAt !== null && s.now < s.haltClearedAt + 15 * MIN) out.push('halt-recovery');
  const m = s.modes[e.strategy];
  if (m === 'off') out.push('strategy-off');
  if (m !== 'off' && m !== e.mode) out.push('mode-mismatch');
  for (const b of s.breakers) {
    const reason: BlockReason = `breaker:${b.name}`;
    if (breakerBlocks(s, e, b) && !out.includes(reason)) out.push(reason);
  }
  if (active(s.strategyPausedUntil[e.strategy])) out.push('strategy-cooldown');
  if (active(s.strategyOffUntil[e.strategy])) out.push('strategy-off-today');
  if (active(s.tokenCooldownUntil.get(e.mint))) out.push('token-cooldown');
  if (s.bannedMints.has(e.mint)) out.push('token-banned');
  if (e.creator !== null && s.blockedCreators.has(e.creator)) out.push('creator-blocked');
  if (s.activeMints.has(e.mint)) out.push('token-active');
  // the policy's numbers: 12 entries a day (a live entry 5) and 4 positions, whatever the config says
  if (s.entriesToday >= Math.min(s.entriesPerDay, e.mode === 'live' ? 5 : 12)) out.push('entries-per-day');
  if (s.activePositions >= Math.min(s.maxPositions, 4)) out.push('max-positions');
  return out;
}

describe('entry block properties', () => {
  it('the reasons are exactly those of the independent model', () => {
    fc.assert(fc.property(stateArb, entryArb, (s, e) => assert.deepEqual([...entryBlocks(s, e)], expected(s, e))));
  });

  it('invariant 4: no entry while kill, halt, pause, the daily stop, a blocking breaker, unknown equity or mode off applies', () => {
    fc.assert(
      fc.property(stateArb, entryArb, (s, e) => {
        const hard =
          s.kill ||
          s.haltReasons.length > 0 ||
          s.paused ||
          s.dailyStop ||
          !s.equityKnown ||
          s.modes[e.strategy] === 'off' ||
          s.breakers.some((b) => breakerBlocks(s, e, b));
        if (hard) {
          assert.ok(entryBlocks(s, e).length > 0, 'refused');
        }
      }),
    );
  });

  it('a state with nothing set allows every valid entry whose strategy runs in its mode', () => {
    fc.assert(
      fc.property(entryArb, (e) => {
        const modes = { crowdflow: e.mode, momentum: e.mode, launch: e.mode };
        const clear: EntryState = {
          now: T0, kill: false, haltReasons: [], haltClearedAt: null, paused: false, dailyStop: false,
          entriesStopped: false, equityKnown: true, equityJumpPending: false, modes, breakers: [], strategyPausedUntil: {},
          strategyOffUntil: {}, tokenCooldownUntil: new Map(), bannedMints: new Set(), blockedCreators: new Set(),
          activeMints: new Set(), entriesToday: 0, entriesPerDay: 8, activePositions: 0, maxPositions: 4,
        };
        assert.deepEqual([...entryBlocks(clear, e)], []);
      }),
    );
  });
});
