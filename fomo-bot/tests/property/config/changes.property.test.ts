// Properties of the config changes (TEST_PLAN.md s.4 invariants 11, 15 and 24), over random sequences
// of /set (good and bad), AI reviews and approvals, /rollback, time passing (pending rows falling due),
// and the bot switching between paper and live, applied the way the engine will apply them (a new
// version when something applies now, pending rows replaced by tunable, demotions):
// - invariant 11: the active values are always inside every bound; every version changes exactly what
//   it says it changes; a rollback, once its pending rows apply, restores the target exactly;
// - invariant 15: every AI proposal that survives validation obeys the policy, checked here with the
//   policy's own table and raw arithmetic, and the AI never changes the paper model;
// - invariant 24: no plan can carry a mode (a mode is not a tunable, and every set of values has exactly
//   the tunables);
// - live loosening: a pending row is only ever a risk value moving away from the safer way, made while
//   live trading was possible, and nothing riskier in the risk group applies at once while live.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { TUNABLE_BOUNDS } from '../../../src/config/caps.ts';
import {
  LOOSENING_DELAY_MS,
  applyDuePending,
  checkAiProposals,
  firstVersion,
  nextVersion,
  planAiApproval,
  planRollback,
  planSet,
  type ChangeContext,
  type ConfigVersion,
  type PendingChange,
  type PlanResult,
  type RefusalReason,
} from '../../../src/config/changes.ts';
import { DEFAULT_TUNABLES, TUNABLE_PATHS, changedPaths, checkTunables, valueAt, withValue, type TunablePath, type TunableValue } from '../../../src/config/tunables.ts';
import { STRATEGY_IDS, type StrategyId } from '../../../src/core/ids.ts';

fc.configureGlobal({ numRuns: 1_000 }); // TEST_PLAN.md s.4 (this file's process only)

const START = Date.UTC(2026, 10, 1);
const HOUR = 3_600_000;

// The policy's table, written out here independently of src/config/tunables.ts: the safer way and the AI rule.
const SAFER: Readonly<Record<string, 'down' | 'up' | 'none'>> = {};
const AI: Readonly<Record<string, 'safer' | 'either' | 'never'>> = {};
for (const path of ['risk.tradePctBps', 'risk.openPositions', 'risk.exposurePctBps', 'risk.entriesPerDay', 'risk.costRuleBps', 'risk.poolShareBps', 'risk.priceCrossCheckBps', 'risk.dailyStopBps', 'risk.peakHaltBps', 'risk.buySlippageBps', 'risk.sellSlippageBps', 'crowdflow.maxTopBuyerShareBps', 'crowdflow.maxSameSlotShareBps', 'crowdflow.maxIdenticalSizeShareBps', 'launch.maxTop10ShareBps', 'launch.maxCreatorShareBps', 'exits.hardStopBps']) {
  (SAFER as Record<string, string>)[path] = 'down';
  (AI as Record<string, string>)[path] = 'safer';
}
for (const path of ['crowdflow.minDistinctBuyers5m', 'crowdflow.minCompletenessBps', 'momentum.minAgeMs', 'momentum.minLiquidityLamports', 'launch.minHolders']) {
  (SAFER as Record<string, string>)[path] = 'up';
  (AI as Record<string, string>)[path] = 'safer';
}
for (const path of ['crowdflow.minAccelerationBps', 'crowdflow.maxRun15mBps', 'momentum.pullbackBps', 'launch.curveProgressWindowBps', 'exits.takeProfitBps', 'exits.trailBps', 'exits.timeStopMin', 'exits.timeStopMinGainBps']) {
  (SAFER as Record<string, string>)[path] = 'none';
  (AI as Record<string, string>)[path] = 'either';
}
Object.assign(SAFER, { 'risk.landingSpendBps': 'down', 'risk.tokenAgeMs': 'up', 'risk.curveProgressBps': 'down', 'paper.pFailBps': 'up', 'paper.extraLatencyMs': 'up', 'paper.competitionBpsPerLeg': 'up' });
Object.assign(AI, { 'risk.landingSpendBps': 'either', 'risk.tokenAgeMs': 'never', 'risk.curveProgressBps': 'never', 'paper.pFailBps': 'never', 'paper.extraLatencyMs': 'never', 'paper.competitionBpsPerLeg': 'never' });

const REASONS: readonly RefusalReason[] = [
  'unknown-parameter', 'not-a-number', 'out-of-bounds', 'paper-only-more-pessimistic', 'no-change', 'not-ai-tunable', 'stale-current',
  'wrong-direction', 'change-too-large', 'changed-recently', 'duplicate-parameter', 'too-many', 'malformed', 'nothing-to-roll-back',
];

function bounds(path: TunablePath): readonly [bigint, bigint] {
  const [group, name] = path.split('.') as [keyof typeof TUNABLE_BOUNDS, string];
  const [min, max] = (TUNABLE_BOUNDS[group] as Readonly<Record<string, readonly [number | bigint, number | bigint]>>)[name]!;
  return [BigInt(min), BigInt(max)];
}
const big = (value: TunableValue): bigint => BigInt(value);
/** Which way a move goes for this tunable: safer, riskier, or neither. */
function direction(path: TunablePath, from: TunableValue, to: TunableValue): 'safer' | 'riskier' | 'neutral' {
  const way = SAFER[path]!;
  if (way === 'none' || big(from) === big(to)) {
    return 'neutral';
  }
  return (way === 'down') === big(to) < big(from) ? 'safer' : 'riskier';
}

// ---------------------------------------------------------------- the engine, as it will apply plans

interface World {
  history: ConfigVersion[];
  activeId: number;
  pending: PendingChange[];
  now: number;
  armed: boolean;
  live: Set<StrategyId>;
}

const active = (w: World): ConfigVersion => w.history.find((v) => v.id === w.activeId)!;
const context = (w: World): ChangeContext => ({ now: w.now, liveArmed: w.armed, liveStrategies: [...w.live] });

interface Stats {
  versions: number;
  pendingMade: number;
  pendingApplied: number;
  aiValid: number;
  aiApplied: number;
  rollbacks: number;
  demotions: number;
  /** Paper-model values a rollback left as they were (it would have made them less pessimistic). */
  kept: number;
}

/** Writes a plan the way T-config will: pending rows by tunable, demotions, and a version when something applies now. */
function commit(w: World, result: PlanResult, author: 'owner' | 'ai-approved' | 'rollback', stats: Stats, undoTo?: number | null): void {
  if (!result.ok) {
    assert.ok(REASONS.includes(result.reason), result.reason);
    return;
  }
  const wasLive = w.armed || w.live.size > 0;
  const before = active(w);
  // every new pending row: a risk or exit value moving any way but the safer one, made while live
  for (const row of result.pending) {
    assert.ok(wasLive, 'a pending row only while live trading is possible');
    assert.ok(row.path.startsWith('risk.') || row.path.startsWith('exits.'), row.path);
    assert.notEqual(direction(row.path, row.from, row.to), 'safer', row.path);
    assert.equal(row.applyAt, w.now + LOOSENING_DELAY_MS);
    assert.equal(big(row.from), big(valueAt(before.values, row.path)));
  }
  // what a command leaves alone: only paper-model values it would have made less pessimistic
  for (const path of result.kept) {
    assert.ok(path.startsWith('paper.'), path);
    stats.kept += 1;
  }
  for (const change of result.applied) {
    // nothing but the safer way in the risk and exit groups applies at once while live (open live positions follow them)
    if (wasLive && (change.path.startsWith('risk.') || change.path.startsWith('exits.'))) {
      assert.equal(direction(change.path, change.from, change.to), 'safer', `${change.path} applied at once while live`);
    }
    // the paper model never becomes less pessimistic, by any command
    if (change.path.startsWith('paper.')) {
      assert.equal(direction(change.path, change.from, change.to), 'safer', `${change.path} made less pessimistic`);
    }
    // a live strategy whose signal or exit values change is demoted
    const group = change.path.split('.')[0]!;
    for (const s of w.live) {
      if (group === s || group === 'exits') {
        assert.ok(result.demote.includes(s), `${s} must be demoted after ${change.path}`);
      }
    }
  }
  w.pending = [...w.pending.filter((row) => !result.cancelled.some((c) => c.path === row.path)), ...result.pending];
  stats.pendingMade += result.pending.length;
  for (const s of result.demote) {
    assert.ok(w.live.has(s), 'only a live strategy is demoted');
    w.live.delete(s);
    stats.demotions += 1;
  }
  if (result.applied.length > 0) {
    const version = nextVersion(before, result.values, author, w.now, undoTo === undefined ? before.id : undoTo);
    w.history.push(version);
    w.activeId = version.id;
    stats.versions += 1;
  }
}

function tick(w: World, hours: number, stats: Stats): void {
  w.now += hours * HOUR;
  const due = applyDuePending(active(w).values, w.pending, context(w));
  for (const step of due.steps) {
    // a row applies only after its full 24 hours
    assert.ok(step.change.applyAt <= w.now && step.change.applyAt - step.change.requestedAt >= LOOSENING_DELAY_MS);
    const version = nextVersion(active(w), step.values, step.change.source, w.now);
    w.history.push(version);
    w.activeId = version.id;
    stats.pendingApplied += 1;
  }
  // a due exit value demotes every live strategy when it applies
  if (due.steps.some((step) => step.change.path.startsWith('exits.'))) {
    assert.deepEqual([...due.demote].sort(), [...w.live].sort());
  }
  for (const s of due.demote) {
    assert.ok(w.live.has(s));
    w.live.delete(s);
    stats.demotions += 1;
  }
  w.pending = [...due.waiting];
}

/** The invariants that hold after every operation. */
function check(w: World): void {
  const current = active(w);
  // invariant 11: inside every bound, exactly the tunables (invariant 24: no mode can ride along)
  assert.deepEqual(checkTunables(current.values), current.values);
  for (const path of TUNABLE_PATHS) {
    const [min, max] = bounds(path);
    const value = big(valueAt(current.values, path));
    assert.ok(value >= min && value <= max, path);
  }
  assert.deepEqual(Object.keys(current.values).sort(), ['crowdflow', 'exits', 'launch', 'momentum', 'paper', 'risk']);
  // every version changes exactly what it says, never nothing
  for (let i = 1; i < w.history.length; i += 1) {
    const prev = w.history[i - 1]!;
    const next = w.history[i]!;
    assert.deepEqual(next.changed, changedPaths(prev.values, next.values));
    assert.ok(next.changed.length > 0);
    assert.ok(next.undoTo === null || next.undoTo < next.id);
  }
  // at most one pending row per tunable
  assert.equal(new Set(w.pending.map((row) => row.path)).size, w.pending.length);
}

// ---------------------------------------------------------------- the operations

const RISK_PATHS = TUNABLE_PATHS.filter((path) => path.startsWith('risk.'));
const PAPER_PATHS = TUNABLE_PATHS.filter((path) => path.startsWith('paper.'));
const pathArb = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(...RISK_PATHS) },
  { weight: 4, arbitrary: fc.constantFrom(...TUNABLE_PATHS) },
  { weight: 2, arbitrary: fc.constantFrom(...PAPER_PATHS) }, // so that rollbacks meet a more pessimistic paper model often
  { weight: 1, arbitrary: fc.constantFrom('crowdflow.mode', 'risk.positionLamports', 'ai.model') },
);

type Op =
  | { readonly kind: 'set'; readonly path: string; readonly at: number; readonly garbage: number }
  | { readonly kind: 'ai'; readonly paths: readonly string[]; readonly percents: readonly number[]; readonly stale: boolean }
  | { readonly kind: 'rollback' }
  | { readonly kind: 'tick'; readonly hours: number }
  | { readonly kind: 'live'; readonly armed: boolean; readonly strategies: readonly StrategyId[] };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ kind: fc.constant('set' as const), path: pathArb, at: fc.integer({ min: -20, max: 1_020 }), garbage: fc.integer({ min: 0, max: 19 }) }) },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('ai' as const),
      paths: fc.array(pathArb, { minLength: 1, maxLength: 5 }),
      percents: fc.array(fc.integer({ min: -40, max: 40 }), { minLength: 5, maxLength: 5 }),
      stale: fc.integer({ min: 0, max: 9 }).map((n) => n === 0),
    }),
  },
  { weight: 2, arbitrary: fc.constant({ kind: 'rollback' as const }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('tick' as const), hours: fc.integer({ min: 0, max: 48 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('live' as const), armed: fc.boolean(), strategies: fc.subarray([...STRATEGY_IDS]) }) },
);

/** A typed value: mostly inside the bounds, sometimes one past them, sometimes not a number at all. */
function typed(path: string, at: number, garbage: number): string {
  if (garbage === 0) {
    return ['abc', '-5', '5.5', '1e3', '', ' 7'][at % 6]!;
  }
  if (!(TUNABLE_PATHS as readonly string[]).includes(path)) {
    return '1';
  }
  const [min, max] = bounds(path as TunablePath);
  const value = min + ((max - min) * BigInt(Math.max(0, Math.min(1_000, at)))) / 1_000n + (at < 0 ? -1n : at > 1_000 ? 1n : 0n);
  return value.toString();
}

function run(w: World, op: Op, stats: Stats): void {
  const now = active(w);
  switch (op.kind) {
    case 'set':
      commit(w, planSet(now.values, op.path, typed(op.path, op.at, op.garbage), context(w), w.pending), 'owner', stats);
      break;
    case 'ai': {
      const proposals = op.paths.map((path, i) => {
        const known = (TUNABLE_PATHS as readonly string[]).includes(path);
        const current = known ? big(valueAt(now.values, path as TunablePath)) : 1n;
        const proposed = current + (current * BigInt(op.percents[i]!)) / 100n;
        return { param: path, current: (op.stale ? current + 1n : current).toString(), proposed: (proposed < 0n ? 0n : proposed).toString() };
      });
      const review = checkAiProposals(now.values, proposals, w.history, w.pending, w.now);
      assert.ok(review.valid.length <= 3);
      assert.equal(review.valid.length + review.dropped.length, proposals.length);
      for (const proposal of review.valid) {
        stats.aiValid += 1;
        // invariant 15, from the policy's own table and raw arithmetic
        const rule = AI[proposal.param]!;
        assert.notEqual(rule, 'never', proposal.param);
        assert.ok(!proposal.param.startsWith('paper.'), 'the AI never changes the paper model');
        if (rule === 'safer') {
          assert.equal(direction(proposal.param, proposal.current, proposal.proposed), 'safer', proposal.param);
        }
        const [min, max] = bounds(proposal.param);
        const from = big(proposal.current);
        const to = big(proposal.proposed);
        assert.ok(to >= min && to <= max && to !== from);
        assert.ok((to > from ? to - from : from - to) * 4n <= from, 'at most a quarter of the current value');
        assert.equal(from, big(valueAt(now.values, proposal.param)), 'the AI saw the running values');
      }
      // the owner approves each valid proposal, one after another (each re-checked at its own time)
      for (const proposal of review.valid) {
        const before = stats.versions + stats.pendingMade;
        commit(w, planAiApproval(active(w).values, proposal, w.history, context(w), w.pending), 'ai-approved', stats);
        stats.aiApplied += stats.versions + stats.pendingMade > before ? 1 : 0;
      }
      break;
    }
    case 'rollback': {
      const result = planRollback(w.history, w.activeId, context(w), w.pending);
      if (result.ok) {
        stats.rollbacks += 1;
        commit(w, result, 'rollback', stats, result.undoTo);
      } else {
        assert.ok(REASONS.includes(result.reason));
        if (result.reason === 'paper-only-more-pessimistic') {
          // refused because all it would do is make the paper model less pessimistic: check that, raw
          const target = w.history.find((v) => v.id === now.undoTo)!;
          const differing = changedPaths(now.values, target.values);
          assert.ok(differing.length > 0 && w.pending.length === 0);
          for (const path of differing) {
            assert.ok(path.startsWith('paper.') && direction(path, valueAt(now.values, path), valueAt(target.values, path)) === 'riskier', path);
          }
          stats.kept += 1;
        }
      }
      break;
    }
    case 'tick':
      tick(w, op.hours, stats);
      break;
    case 'live':
      w.armed = op.armed;
      w.live = new Set(op.strategies);
      break;
  }
  check(w);
}

/** Half the sequences start with the bot armed for live and crowdflow live. */
const fresh = (live = false): World => ({
  history: [firstVersion(DEFAULT_TUNABLES, START)],
  activeId: 1,
  pending: [],
  now: START,
  armed: live,
  live: new Set<StrategyId>(live ? ['crowdflow'] : []),
});
const newStats = (): Stats => ({ versions: 0, pendingMade: 0, pendingApplied: 0, aiValid: 0, aiApplied: 0, rollbacks: 0, demotions: 0, kept: 0 });

describe('config change properties', () => {
  it('invariants 11, 15 and 24 and the live-loosening rule hold over random sequences of commands (and each kind happens often)', () => {
    const stats = newStats();
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 25 }), fc.boolean(), (ops, live) => {
        const w = fresh(live);
        for (const op of ops) {
          run(w, op, stats);
        }
      }),
    );
    assert.ok(stats.versions >= 2_000, `only ${stats.versions} versions`);
    assert.ok(stats.pendingMade >= 200, `only ${stats.pendingMade} pending rows`);
    assert.ok(stats.pendingApplied >= 40, `only ${stats.pendingApplied} pending rows applied`);
    assert.ok(stats.aiValid >= 300 && stats.aiApplied >= 200, `AI: ${stats.aiValid} valid, ${stats.aiApplied} applied`);
    assert.ok(stats.rollbacks >= 300, `only ${stats.rollbacks} rollbacks`);
    assert.ok(stats.demotions >= 50, `only ${stats.demotions} demotions`);
    assert.ok(stats.kept >= 10, `only ${stats.kept} paper-model values kept by a rollback`);
  });

  it('a rollback restores the target exactly: at once in paper, after 24 hours in live (invariant 11)', () => {
    let restored = 0;
    let waited = 0;
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 15 }), fc.boolean(), (ops, live) => {
        const stats = newStats();
        const w = fresh();
        for (const op of ops) {
          run(w, op, stats);
        }
        w.armed = live;
        w.live = new Set();
        const current = active(w);
        const result = planRollback(w.history, w.activeId, context(w), w.pending);
        if (!result.ok) {
          return;
        }
        const target = w.history.find((v) => v.id === result.target)!;
        // the target exactly, except the paper-model values it would have made less pessimistic, which stay
        const expected = result.kept.reduce((values, path) => withValue(values, path, valueAt(current.values, path)), target.values);
        commit(w, result, 'rollback', stats, result.undoTo);
        if (!live) {
          assert.deepEqual(active(w).values, expected);
        } else {
          waited += result.pending.length > 0 ? 1 : 0;
          tick(w, 24, stats);
          assert.deepEqual(active(w).values, expected);
        }
        assert.ok(current.id !== active(w).id || result.applied.length === 0);
        restored += 1;
        check(w);
      }),
    );
    assert.ok(restored >= 200 && waited >= 50, `restored ${restored}, waited ${waited}`);
  });
});
