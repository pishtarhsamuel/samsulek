// Changing the tunables (RISK_POLICY.md s.12; ARCHITECTURE.md s.8; TEST_PLAN.md s.3 item 5 and s.6
// "Live loosening by /rollback"): /set, AI proposals and their approval, /rollback, versions and the
// 24-hour wait of a live loosening, each rule at its boundary; and the fixes of review M (exit values
// wait while live, no command makes the paper model less pessimistic, stored rows and versions are
// checked strictly). Written before the engine that stores the versions and the pending rows.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_COOLDOWN_MS,
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
  type RollbackResult,
} from '../../../src/config/changes.ts';
import { ConfigError, DEFAULT_TUNABLES, withValue, type TunablePath, type TunableValue, type Tunables } from '../../../src/config/tunables.ts';

const NOW = Date.UTC(2026, 10, 12, 12);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const D = DEFAULT_TUNABLES;
const PAPER: ChangeContext = { now: NOW, liveArmed: false, liveStrategies: [] };
const LIVE: ChangeContext = { now: NOW, liveArmed: true, liveStrategies: ['crowdflow'] };
const at = (ctx: ChangeContext, now: number): ChangeContext => ({ ...ctx, now });

function ok<T extends PlanResult | RollbackResult>(result: T): Extract<T, { ok: true }> {
  assert.equal(result.ok, true, result.ok ? '' : `refused: ${result.reason}`);
  return result as Extract<T, { ok: true }>;
}

const set = (values: Tunables, path: string, value: unknown, ctx = PAPER, pending: readonly PendingChange[] = []) => planSet(values, path, value, ctx, pending);
const tweak = (changes: ReadonlyArray<readonly [TunablePath, TunableValue]>, base: Tunables = D): Tunables =>
  changes.reduce((values, [path, value]) => withValue(values, path, value), base);
/** A pending row due at `applyAt`, asked for exactly 24 hours before. */
const row = (path: TunablePath, from: TunableValue, to: TunableValue, applyAt: number, source: PendingChange['source'] = 'owner'): PendingChange => ({
  path,
  from,
  to,
  source,
  requestedAt: applyAt - LOOSENING_DELAY_MS,
  applyAt,
});

const V1 = firstVersion(D, NOW - 30 * DAY);

describe('/set', () => {
  it('in paper any value inside the bounds applies at once, either way; risk values restart no gate', () => {
    const down = ok(set(D, 'risk.tradePctBps', '500'));
    assert.deepEqual(down.applied, [{ path: 'risk.tradePctBps', from: 1_000, to: 500, safety: 'safer' }]);
    assert.equal(down.values.risk.tradePctBps, 500);
    assert.deepEqual([down.pending, down.cancelled, down.kept, down.demote, down.restartGate], [[], [], [], [], []]);
    const up = ok(set(down.values, 'risk.tradePctBps', '1000'));
    assert.deepEqual(up.applied, [{ path: 'risk.tradePctBps', from: 500, to: 1_000, safety: 'riskier' }]);
    assert.ok(Object.isFrozen(up) && Object.isFrozen(up.values) && Object.isFrozen(up.applied));
  });

  it('refuses names that are not tunables: modes, hard caps, addresses, the AI model, wrong case', () => {
    for (const name of ['crowdflow.mode', 'mode', 'risk.positionLamports', 'withdrawAddress', 'ai.model', 'risk.tradepctbps', '', 42, null]) {
      assert.deepEqual(set(D, name as string, '1'), { ok: false, reason: 'unknown-parameter' }, String(name));
    }
  });

  it('refuses a value that is not digits, or outside the bounds, or the value it already has', () => {
    assert.deepEqual(set(D, 'risk.tradePctBps', 'ten'), { ok: false, reason: 'not-a-number' });
    assert.deepEqual(set(D, 'risk.tradePctBps', '5.5'), { ok: false, reason: 'not-a-number' });
    assert.deepEqual(set(D, 'risk.tradePctBps', '1001'), { ok: false, reason: 'out-of-bounds' });
    assert.deepEqual(set(D, 'risk.tradePctBps', '99'), { ok: false, reason: 'out-of-bounds' });
    assert.deepEqual(set(D, 'risk.tradePctBps', '1000'), { ok: false, reason: 'no-change' });
    assert.equal(ok(set(D, 'momentum.minLiquidityLamports', '20000000000')).values.momentum.minLiquidityLamports, 20_000_000_000n);
  });

  it('the paper model only becomes more pessimistic', () => {
    const raised = ok(set(D, 'paper.pFailBps', '3000')).values;
    assert.deepEqual(set(raised, 'paper.pFailBps', '2500'), { ok: false, reason: 'paper-only-more-pessimistic' });
    assert.equal(ok(set(raised, 'paper.pFailBps', '3500')).values.paper.pFailBps, 3_500);
    assert.deepEqual(set(D, 'paper.competitionBpsPerLeg', '40'), { ok: false, reason: 'out-of-bounds' }); // below its floor
  });
});

describe('a live loosening waits 24 hours (RISK_POLICY.md s.12)', () => {
  const half = withValue(D, 'risk.tradePctBps', 500);

  it('a riskier risk value waits; nothing changes now; the owner is told by the engine', () => {
    const plan = ok(set(half, 'risk.tradePctBps', '1000', LIVE));
    assert.deepEqual(plan.applied, []);
    assert.equal(plan.values.risk.tradePctBps, 500);
    assert.deepEqual(plan.pending, [{ path: 'risk.tradePctBps', from: 500, to: 1_000, source: 'owner', requestedAt: NOW, applyAt: NOW + LOOSENING_DELAY_MS }]);
  });

  it('a safer risk value applies at once', () => {
    assert.equal(ok(set(D, 'risk.tradePctBps', '500', LIVE)).values.risk.tradePctBps, 500);
  });

  it('armed with no strategy live yet, or a strategy live without the flag: live either way', () => {
    assert.equal(ok(set(half, 'risk.tradePctBps', '1000', { ...LIVE, liveStrategies: [] })).pending.length, 1);
    assert.equal(ok(set(half, 'risk.tradePctBps', '1000', { ...LIVE, liveArmed: false })).pending.length, 1);
    assert.equal(ok(set(half, 'risk.tradePctBps', '1000', PAPER)).pending.length, 0);
  });

  it('every riskier risk value waits: stops, slippage, entries, positions, the landing spend, the token age', () => {
    const tight = tweak([
      ['risk.dailyStopBps', 1_000],
      ['risk.buySlippageBps', 100],
      ['risk.entriesPerDay', 4],
      ['risk.openPositions', 2],
      ['risk.landingSpendBps', 10],
      ['risk.tokenAgeMs', 600_000],
    ]);
    for (const [path, value] of [
      ['risk.dailyStopBps', '3000'],
      ['risk.buySlippageBps', '300'],
      ['risk.entriesPerDay', '12'],
      ['risk.openPositions', '4'],
      ['risk.landingSpendBps', '30'],
      ['risk.tokenAgeMs', '180000'],
    ] as const) {
      const plan = ok(set(tight, path, value, LIVE));
      assert.deepEqual([plan.applied.length, plan.pending.length], [0, 1], path);
    }
  });

  it('a looser shared exit value waits too, and so does any move of an exit value with no safer way: open live positions follow them (review M, risk finding 1)', () => {
    const stop = ok(set(D, 'exits.hardStopBps', '4000', LIVE)); // a wider stop: riskier
    assert.deepEqual([stop.applied, stop.pending.map((p) => [p.path, p.to]), stop.demote], [[], [['exits.hardStopBps', 4_000]], []]);
    for (const [path, value] of [['exits.timeStopMin', '240'], ['exits.takeProfitBps', '20000'], ['exits.trailBps', '1000']] as const) {
      const plan = ok(set(D, path, value, LIVE));
      assert.deepEqual([plan.applied.length, plan.pending.length], [0, 1], path);
    }
    // a tighter stop applies at once, and still demotes every live strategy (their gate used the old exits)
    const tighter = ok(set(D, 'exits.hardStopBps', '3000', { ...LIVE, liveStrategies: ['crowdflow', 'launch'] }));
    assert.deepEqual([tighter.applied.length, tighter.demote, tighter.restartGate], [1, ['crowdflow', 'launch'], ['crowdflow', 'momentum', 'launch']]);
    // in paper every exit value applies at once
    assert.equal(ok(set(D, 'exits.hardStopBps', '4000', PAPER)).applied.length, 1);
  });

  it("a live strategy's own signal value applies at once and demotes it; a paper strategy's restarts only its count", () => {
    const own = ok(set(D, 'crowdflow.minDistinctBuyers5m', '5', LIVE)); // looser, but crowdflow goes back to paper
    assert.equal(own.values.crowdflow.minDistinctBuyers5m, 5);
    assert.deepEqual([own.pending, own.demote, own.restartGate], [[], ['crowdflow'], ['crowdflow']]);
    const other = ok(set(D, 'launch.minHolders', '100', LIVE));
    assert.deepEqual([other.demote, other.restartGate], [[], ['launch']]);
  });

  it('the paper model applies at once, restarts every count and demotes none', () => {
    const paper = ok(set(D, 'paper.pFailBps', '2500', LIVE));
    assert.deepEqual([paper.applied.length, paper.pending, paper.demote, paper.restartGate], [1, [], [], ['crowdflow', 'momentum', 'launch']]);
  });

  it("the owner's latest word wins: a new /set of a value replaces its pending change, even back to the current value", () => {
    const first = ok(set(half, 'risk.tradePctBps', '1000', LIVE));
    const back = ok(set(half, 'risk.tradePctBps', '500', LIVE, first.pending));
    assert.deepEqual([back.applied, back.pending, back.cancelled], [[], [], first.pending]);
    const again = ok(set(half, 'risk.tradePctBps', '800', LIVE, first.pending));
    assert.deepEqual([again.pending.map((p) => p.to), again.cancelled], [[800], first.pending]);
    // a pending change of another value is left alone
    const pool = ok(set(withValue(half, 'risk.poolShareBps', 30), 'risk.poolShareBps', '50', LIVE)).pending;
    assert.deepEqual(ok(set(half, 'risk.tradePctBps', '600', LIVE, pool)).cancelled, []);
  });
});

describe('AI proposals (RISK_POLICY.md s.12; BUILD_PROMPT s.13)', () => {
  const review = (proposals: unknown, history: readonly ConfigVersion[] = [V1], pending: readonly PendingChange[] = [], values = D) => checkAiProposals(values, proposals, history, pending, NOW);
  const p = (param: string, current: unknown, proposed: unknown) => ({ param, current, proposed });

  it('a valid proposal: a marked tunable, the safer way, at most a quarter of the current value', () => {
    assert.deepEqual(review([p('risk.tradePctBps', 1_000, 800)]), { valid: [{ param: 'risk.tradePctBps', current: 1_000, proposed: 800 }], dropped: [] });
    assert.equal(review([p('momentum.minLiquidityLamports', '50000000000', '60000000000')]).valid.length, 1); // raise only, +20%
    assert.equal(review([p('crowdflow.maxRun15mBps', 10_000, 12_000)]).valid.length, 1); // either way
    assert.equal(review([p('crowdflow.maxRun15mBps', 10_000, 7_500)]).valid.length, 1);
  });

  it('never a tunable the policy does not mark for the AI, and never the paper model', () => {
    for (const [param, from, to] of [['paper.pFailBps', 2_000, 2_400], ['risk.tokenAgeMs', 180_000, 200_000], ['risk.curveProgressBps', 9_000, 8_000]] as const) {
      assert.deepEqual(review([p(param, from, to)]).dropped, [{ index: 0, reason: 'not-ai-tunable' }], param);
    }
    assert.deepEqual(review([p('crowdflow.mode', 'paper', 'live')]).dropped, [{ index: 0, reason: 'unknown-parameter' }]);
  });

  it('risk, safety and anti-sybil values and the hard stop only the safer way', () => {
    for (const [param, from, to] of [
      ['risk.entriesPerDay', 8, 9],
      ['risk.landingSpendBps', 20, 20],
      ['crowdflow.minDistinctBuyers5m', 10, 9],
      ['crowdflow.maxTopBuyerShareBps', 3_000, 3_300],
      ['momentum.minAgeMs', 86_400_000, 86_400_000],
      ['launch.minHolders', 50, 45],
      ['exits.hardStopBps', 3_500, 3_800],
    ] as const) {
      const expected = from === to ? 'no-change' : 'wrong-direction';
      assert.deepEqual(review([p(param, from, to)]).dropped, [{ index: 0, reason: expected }], param);
    }
    assert.equal(review([p('risk.landingSpendBps', 20, 25)]).valid.length, 1); // "yes": either way
  });

  it('at most a quarter of the current value, exactly; nothing from zero', () => {
    assert.equal(review([p('risk.tradePctBps', 1_000, 750)]).valid.length, 1); // 250 x 4 = 1,000
    assert.deepEqual(review([p('risk.tradePctBps', 1_000, 749)]).dropped, [{ index: 0, reason: 'change-too-large' }]);
    assert.deepEqual(review([p('momentum.minLiquidityLamports', '50000000000', '62500000001')]).dropped, [{ index: 0, reason: 'change-too-large' }]);
    assert.equal(review([p('momentum.minLiquidityLamports', '50000000000', '62500000000')]).valid.length, 1);
    const zero = withValue(D, 'crowdflow.minAccelerationBps', 0);
    assert.deepEqual(review([p('crowdflow.minAccelerationBps', 0, 1)], [V1], [], zero).dropped, [{ index: 0, reason: 'change-too-large' }]);
  });

  it('the AI must have seen the numbers the bot runs with', () => {
    assert.deepEqual(review([p('risk.tradePctBps', 900, 800)]).dropped, [{ index: 0, reason: 'stale-current' }]);
    assert.deepEqual(review([p('risk.tradePctBps', 'x', 800)]).dropped, [{ index: 0, reason: 'stale-current' }]);
  });

  it("once in 7 days per tunable, counting approved AI versions and AI changes still pending, not the owner's", () => {
    const changed = withValue(D, 'risk.tradePctBps', 900);
    const aiVersion = (when: number): ConfigVersion => ({ ...nextVersion(V1, changed, 'ai-approved', when) });
    const recent = review([p('risk.tradePctBps', 900, 800)], [V1, aiVersion(NOW - AI_COOLDOWN_MS + 1)], [], changed);
    assert.deepEqual(recent.dropped, [{ index: 0, reason: 'changed-recently' }]);
    assert.equal(review([p('risk.tradePctBps', 900, 800)], [V1, aiVersion(NOW - AI_COOLDOWN_MS)], [], changed).valid.length, 1);
    const owner = { ...nextVersion(V1, changed, 'owner', NOW - HOUR) };
    assert.equal(review([p('risk.tradePctBps', 900, 800)], [V1, owner], [], changed).valid.length, 1);
    const pendingAi = row('risk.tradePctBps', 900, 1_000, NOW + HOUR, 'ai-approved'); // asked for 23 hours ago
    assert.deepEqual(review([p('risk.tradePctBps', 900, 800)], [V1], [pendingAi], changed).dropped, [{ index: 0, reason: 'changed-recently' }]);
  });

  it('at most 3 per review and one per tunable; anything malformed is dropped, never thrown', () => {
    const many = review([p('risk.tradePctBps', 1_000, 900), p('risk.tradePctBps', 1_000, 800), null, p('risk.poolShareBps', 50, 40), p('risk.costRuleBps', 500, 400)]);
    assert.deepEqual(many.valid.map((x) => x.param), ['risk.tradePctBps']);
    assert.deepEqual(many.dropped, [
      { index: 1, reason: 'duplicate-parameter' },
      { index: 2, reason: 'malformed' },
      { index: 3, reason: 'too-many' },
      { index: 4, reason: 'too-many' },
    ]);
    assert.deepEqual(review('drop everything'), { valid: [], dropped: [{ index: 0, reason: 'malformed' }] });
    for (const bad of [800.5, -800, '8e2', '0800', null, 10n]) {
      assert.deepEqual(review([p('risk.tradePctBps', 1_000, bad)]).dropped, [{ index: 0, reason: 'not-a-number' }], String(bad));
    }
    assert.deepEqual(review([p('risk.tradePctBps', 1_000, 50)]).dropped, [{ index: 0, reason: 'out-of-bounds' }]);
  });

  it('approval re-checks every rule against the values and history at approval time', () => {
    const proposal = review([p('risk.tradePctBps', 1_000, 800)]).valid[0]!;
    const approved = ok(planAiApproval(D, proposal, [V1], PAPER, []));
    assert.deepEqual(approved.applied, [{ path: 'risk.tradePctBps', from: 1_000, to: 800, safety: 'safer' }]);
    // the owner changed it in between: the AI's numbers are stale
    assert.deepEqual(planAiApproval(withValue(D, 'risk.tradePctBps', 900), proposal, [V1], PAPER, []), { ok: false, reason: 'stale-current' });
    // a riskier "either" risk value from the AI waits 24 hours like the owner's
    const landing = review([p('risk.landingSpendBps', 20, 25)]).valid[0]!;
    const waiting = ok(planAiApproval(D, landing, [V1], LIVE, []));
    assert.deepEqual([waiting.applied, waiting.pending.map((x) => [x.path, x.to, x.source])], [[], [['risk.landingSpendBps', 25, 'ai-approved']]]);
  });
});

describe('versions', () => {
  it('the first is the default; each next one changes something, later, and undoes to the one before', () => {
    assert.deepEqual(V1, { id: 1, createdAt: NOW - 30 * DAY, author: 'default', values: D, changed: [], undoTo: null });
    const v2 = nextVersion(V1, withValue(D, 'risk.tradePctBps', 500), 'owner', NOW);
    assert.deepEqual([v2.id, v2.author, v2.changed, v2.undoTo], [2, 'owner', ['risk.tradePctBps'], 1]);
    assert.ok(Object.isFrozen(v2) && Object.isFrozen(v2.changed));
    assert.throws(() => nextVersion(V1, D, 'owner', NOW), ConfigError); // changes nothing
    assert.throws(() => nextVersion(V1, withValue(D, 'risk.tradePctBps', 500), 'owner', V1.createdAt - 1), ConfigError); // older
    assert.throws(() => nextVersion(V1, withValue(D, 'risk.tradePctBps', 500), 'default' as 'owner', NOW), ConfigError);
    assert.throws(() => nextVersion(V1, withValue(D, 'risk.tradePctBps', 500), 'owner', NOW, 2), ConfigError); // undo to itself or later
    assert.throws(() => firstVersion(D, Number.NaN), ConfigError);
  });

  it('a stored history must agree with itself (review M, risk finding 4): exact changes, no gaps, one default version, first', () => {
    const v2 = nextVersion(V1, withValue(D, 'risk.tradePctBps', 500), 'owner', NOW);
    const roll = (history: unknown[]) => planRollback(history as ConfigVersion[], 2, PAPER, []);
    assert.equal(roll([V1, v2]).ok, true);
    for (const bad of [
      [V1, { ...v2, changed: ['risk.poolShareBps'] }], // says it changed another tunable
      [V1, { ...v2, changed: [] }],
      [V1, { ...v2, changed: ['risk.tradePctBps', 'risk.poolShareBps'] }],
      [V1, { ...v2, values: D, changed: [] }], // changed nothing at all
      [V1, { ...v2, id: 3 }], // a gap
      [V1, { ...v2, author: 'default' }], // only the first version is the default one
      [{ ...V1, author: 'owner' }, v2],
      [{ ...V1, changed: ['risk.tradePctBps'] }, v2],
      [{ ...V1, undoTo: 1 }, v2],
      [V1, { ...v2, createdAt: V1.createdAt - 1 }], // made before the one before it
      [V1, { ...v2, extra: 1 }], // an extra field
      [V1, Object.assign(Object.create({ evil: 1 }), v2)], // another prototype
    ]) {
      assert.throws(() => roll(bad), ConfigError);
    }
    // a gap is refused even when everything else about the versions agrees
    assert.throws(() => planRollback([V1, { ...v2, id: 3 }], 3, PAPER, []), /without gaps/);
  });
});

describe('/rollback, field by field (TEST_PLAN.md s.6)', () => {
  // v2: the owner tightened sizes and slippage and the daily stop, and raised the entries per day
  const v2Values = tweak([
    ['risk.tradePctBps', 500],
    ['risk.poolShareBps', 30],
    ['risk.buySlippageBps', 100],
    ['risk.dailyStopBps', 2_000],
    ['risk.entriesPerDay', 12],
    ['crowdflow.minDistinctBuyers5m', 20],
  ]);
  const v2 = nextVersion(V1, v2Values, 'owner', NOW - DAY);

  it('in paper, everything goes back at once', () => {
    const plan = ok(planRollback([V1, v2], 2, PAPER, []));
    assert.deepEqual(plan.values, V1.values);
    assert.deepEqual([plan.target, plan.undoTo, plan.pending, plan.kept], [1, null, [], []]);
  });

  it("live: each looser risk value waits 24 hours, the safer ones apply at once, a live strategy's value demotes it", () => {
    const plan = ok(planRollback([V1, v2], 2, LIVE, []));
    assert.deepEqual(plan.pending.map((x) => [x.path, x.from, x.to, x.source]), [
      ['risk.tradePctBps', 500, 1_000, 'rollback'],
      ['risk.poolShareBps', 30, 50, 'rollback'],
      ['risk.dailyStopBps', 2_000, 3_000, 'rollback'],
      ['risk.buySlippageBps', 100, 200, 'rollback'],
    ]);
    // the strategy value is looser too, but it applies at once because crowdflow goes back to paper
    assert.deepEqual(plan.applied.map((x) => [x.path, x.safety]), [['risk.entriesPerDay', 'safer'], ['crowdflow.minDistinctBuyers5m', 'riskier']]);
    assert.deepEqual(plan.demote, ['crowdflow']);
    // 24 hours later the pending rows apply, and the values equal the target's exactly (invariant 11)
    const v3 = nextVersion(v2, plan.values, 'rollback', NOW, plan.undoTo);
    const due = applyDuePending(v3.values, plan.pending, at(LIVE, NOW + LOOSENING_DELAY_MS));
    assert.deepEqual([due.stale, due.waiting, due.demote], [[], [], []]);
    assert.deepEqual(due.steps.at(-1)!.values, V1.values);
    assert.equal(applyDuePending(v3.values, plan.pending, at(LIVE, NOW + LOOSENING_DELAY_MS - 1)).steps.length, 0);
  });

  it('a second /rollback goes one step further back, then there is nothing left to undo', () => {
    const v3 = nextVersion(v2, withValue(v2Values, 'risk.costRuleBps', 300), 'owner', NOW);
    const back1 = ok(planRollback([V1, v2, v3], 3, PAPER, []));
    assert.deepEqual([back1.target, back1.values], [2, v2Values]);
    const v4 = nextVersion(v3, back1.values, 'rollback', NOW, back1.undoTo);
    assert.equal(v4.undoTo, 1);
    const back2 = ok(planRollback([V1, v2, v3, v4], 4, PAPER, []));
    assert.deepEqual([back2.target, back2.values], [1, D]);
    const v5 = nextVersion(v4, back2.values, 'rollback', NOW, back2.undoTo);
    assert.deepEqual(planRollback([V1, v2, v3, v4, v5], 5, PAPER, []), { ok: false, reason: 'nothing-to-roll-back' });
  });

  it('it never makes the paper model less pessimistic: such a value stays, and is reported (review M)', () => {
    const pessimistic = nextVersion(V1, tweak([['paper.pFailBps', 5_000], ['risk.tradePctBps', 500]]), 'owner', NOW - HOUR);
    for (const ctx of [PAPER, LIVE]) {
      const plan = ok(planRollback([V1, pessimistic], 2, ctx, []));
      assert.deepEqual(plan.kept, ['paper.pFailBps']);
      assert.equal(plan.values.paper.pFailBps, 5_000);
      assert.equal(plan.applied.some((x) => x.path === 'paper.pFailBps') || plan.pending.some((x) => x.path === 'paper.pFailBps'), false);
    }
    // a rollback that would only lower the paper model is refused, as /set refuses it
    const onlyPaper = nextVersion(V1, withValue(D, 'paper.pFailBps', 5_000), 'owner', NOW - HOUR);
    assert.deepEqual(planRollback([V1, onlyPaper], 2, PAPER, []), { ok: false, reason: 'paper-only-more-pessimistic' });
    // making it MORE pessimistic by rollback is fine
    const loose = nextVersion(nextVersion(V1, withValue(D, 'paper.pFailBps', 5_000), 'owner', NOW - 2 * HOUR), D, 'owner', NOW - HOUR);
    void loose; // (unreachable through /set: lowering it was refused) the target values are what count:
    const raised = nextVersion(V1, withValue(D, 'risk.tradePctBps', 500), 'owner', NOW - HOUR);
    assert.deepEqual(ok(planRollback([V1, raised], 2, PAPER, [])).kept, []);
  });

  it('it addresses every tunable, so it replaces every pending change', () => {
    const pending = [row('risk.costRuleBps', 500, 500, NOW + HOUR)];
    const plan = ok(planRollback([V1, v2], 2, PAPER, pending));
    assert.deepEqual(plan.cancelled, pending);
  });

  it('a history that cannot be right fails closed', () => {
    assert.throws(() => planRollback([V1, v2], 3, PAPER, []), ConfigError); // the active version is missing
    assert.throws(() => planRollback([v2], 2, PAPER, []), ConfigError); // the target is missing
    assert.throws(() => planRollback([v2, V1], 2, PAPER, []), ConfigError); // out of order
    assert.throws(() => planRollback([], 1, PAPER, []), ConfigError);
    assert.throws(() => planRollback([{ ...V1, id: 0 }, v2], 2, PAPER, []), ConfigError);
    assert.throws(() => planRollback([V1, { ...v2, id: 2.5 }], 2.5, PAPER, []), ConfigError);
    assert.throws(() => planRollback([V1, { ...v2, author: 'someone' as 'owner' }], 2, PAPER, []), ConfigError);
    assert.throws(() => planRollback([V1, { ...v2, undoTo: 2 }], 2, PAPER, []), ConfigError);
    assert.throws(() => planRollback([V1, { ...v2, values: { ...v2.values, modes: {} } as unknown as Tunables }], 2, PAPER, []), ConfigError);
    assert.throws(() => planRollback([V1, { ...v2, changed: ['risk.mode' as TunablePath] }], 2, PAPER, []), ConfigError);
  });
});

describe('pending rows', () => {
  it('apply when due, in the order they fall due; the rest keep waiting', () => {
    const base = tweak([['risk.tradePctBps', 500], ['risk.poolShareBps', 30]]);
    const a = row('risk.poolShareBps', 30, 50, NOW - 1);
    const b = row('risk.tradePctBps', 500, 1_000, NOW - 2);
    const c = row('risk.costRuleBps', 500, 400, NOW + 1);
    const due = applyDuePending(base, [a, b, c], PAPER);
    assert.deepEqual(due.steps.map((s) => s.change), [b, a]);
    assert.deepEqual([due.steps.at(-1)!.values.risk.tradePctBps, due.steps.at(-1)!.values.risk.poolShareBps], [1_000, 50]);
    assert.deepEqual(due.waiting, [c]);
  });

  it('a due exit value demotes every live strategy when it applies, and restarts every count', () => {
    const stop = row('exits.hardStopBps', 3_500, 4_000, NOW);
    const due = applyDuePending(D, [stop], { ...LIVE, liveStrategies: ['crowdflow', 'momentum'] });
    assert.deepEqual([due.steps.length, due.demote, due.restartGate], [1, ['crowdflow', 'momentum'], ['crowdflow', 'momentum', 'launch']]);
    assert.deepEqual(applyDuePending(D, [row('risk.costRuleBps', 500, 400, NOW)], LIVE).demote, []); // a risk value demotes none
  });

  it('a row whose value changed since, or that falls outside the bounds now, is stale and dropped', () => {
    const moved = applyDuePending(D, [row('risk.tradePctBps', 500, 1_000, NOW)], PAPER);
    assert.deepEqual([moved.steps.length, moved.stale.length], [0, 1]);
    const outside = applyDuePending(D, [row('risk.tradePctBps', 1_000, 2_000, NOW)], PAPER);
    assert.deepEqual([outside.steps.length, outside.stale.length], [0, 1]);
  });

  it('rows that cannot be right fail closed (review M, security findings 2 and 3)', () => {
    const good = row('risk.tradePctBps', 500, 1_000, NOW);
    for (const bad of [
      [good, good], // two for one tunable
      [{ ...good, path: 'risk.mode' }],
      [{ ...good, source: 'ai' }],
      [{ ...good, applyAt: good.requestedAt + LOOSENING_DELAY_MS - 1 }], // waits less than 24 hours
      [{ ...good, applyAt: good.requestedAt }],
      [{ ...good, requestedAt: NOW + 1, applyAt: NOW + 1 + LOOSENING_DELAY_MS }], // asked for after now
      [{ ...good, from: 500n }],
      [{ ...row('momentum.minLiquidityLamports', 50_000_000_000n, 40_000_000_000n, NOW), to: 40_000_000_000 }],
      [{ ...good, extra: 1 }],
      [Object.assign(Object.create({ evil: 1 }), good)],
      [null],
      'none',
    ]) {
      assert.throws(() => applyDuePending(D, bad as unknown as PendingChange[], PAPER), ConfigError, JSON.stringify(bad, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v)));
    }
    // a getter is refused and never run
    let reads = 0;
    const getter = { ...good } as Record<string, unknown>;
    Object.defineProperty(getter, 'applyAt', { get: () => ((reads += 1), NOW), enumerable: true });
    assert.throws(() => applyDuePending(D, [getter] as unknown as PendingChange[], PAPER), /plain value/);
    assert.equal(reads, 0);
    // inherited fields do not count
    const inherited = Object.create(good) as PendingChange;
    assert.throws(() => applyDuePending(D, [inherited], PAPER), ConfigError);
  });
});

describe('the context fails closed too', () => {
  it('a bad clock, flag or strategy list throws', () => {
    for (const ctx of [{ ...PAPER, now: Number.NaN }, { ...PAPER, liveArmed: 'no' }, { ...PAPER, liveStrategies: ['copy'] }, { ...PAPER, liveStrategies: 'crowdflow' }, { ...PAPER, extra: 1 }, null]) {
      assert.throws(() => planSet(D, 'risk.tradePctBps', '500', ctx as unknown as ChangeContext, []), ConfigError);
    }
    assert.throws(() => checkAiProposals(D, [], [V1], [], Number.NaN), ConfigError);
    assert.throws(() => planSet({ ...D, modes: {} } as unknown as Tunables, 'risk.tradePctBps', '500', PAPER, []), ConfigError);
  });

  it('lists are plain too: no getter, hole, extra field or other prototype in a list of strategies or rows', () => {
    let reads = 0;
    const getter: string[] = [];
    Object.defineProperty(getter, '0', { get: () => ((reads += 1), 'crowdflow'), enumerable: true, configurable: true });
    const hole = ['crowdflow', 'launch'];
    delete hole[0];
    const extra = Object.assign(['crowdflow'], { more: 1 });
    class Strategies extends Array<string> {}
    for (const list of [getter, hole, extra, Strategies.from(['crowdflow'])]) {
      assert.throws(() => planSet(D, 'risk.tradePctBps', '500', { ...PAPER, liveStrategies: list as ChangeContext['liveStrategies'] }, []), /plain list/);
    }
    assert.equal(reads, 0);
  });
});
