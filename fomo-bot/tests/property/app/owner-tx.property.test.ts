// The command-sequence property of step 6e-4 (STORAGE_DESIGN.md s.17.8): random /set (valid and
// invalid names and values of both kinds, the paper model), /rollback, /cancel, the engine's due step,
// the clock forward (past a day too) and back, and a strategy set live by the test (tests only) so that
// loosenings wait. The same commands run on a model: the pure planners on an in-memory history and
// pending list at the same commandTime. After every step the outcome equals the model's, the decoded
// history, the waiting rows, the modes and the gate starts equal the model's, every stored version
// decodes, storage never refuses a planner's plan (no step ends in an error), the owner's row comes
// first in each command's writes, and the audit chain holds.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { applyDueTx, commandTime, readConfigState, type ConfigState, type DueOutcome } from '../../../src/app/config-tx.ts';
import { cancelPendingTx, rollbackTx, setTx, type OwnerConfigOutcome } from '../../../src/app/owner-tx.ts';
import {
  applyDuePending,
  firstVersion,
  nextVersion,
  planCancel,
  planRollback,
  planSet,
  type ChangeContext,
  type ConfigVersion,
  type PendingChange,
} from '../../../src/config/changes.ts';
import { DEFAULT_TUNABLES, boundsOf, decodeTunables, isTunablePath, valueAt, type TunablePath } from '../../../src/config/tunables.ts';
import { STRATEGY_IDS, type StrategyId } from '../../../src/core/ids.ts';
import { verifyAuditChain } from '../../../src/storage/repo-audit.ts';
import { readConfigHistory } from '../../../src/storage/repo-config.ts';
import { readModes } from '../../../src/storage/repo-flags.ts';
import { setStrategyMode } from '../../../src/storage/repo-owner.ts';
import type { Db } from '../../../src/storage/sqlite.ts';
import { DAY, HOUR, dayWorld } from '../../unit/app/day-world.ts';
import { T } from '../../unit/app/world.ts';

type Step =
  | { readonly kind: 'set'; readonly path: string; readonly value: number }
  | { readonly kind: 'rollback' }
  | { readonly kind: 'cancel'; readonly path: string }
  | { readonly kind: 'due' }
  | { readonly kind: 'forward'; readonly ms: number }
  | { readonly kind: 'back'; readonly ms: number }
  | { readonly kind: 'live'; readonly strategy: StrategyId };

/** Risk and exit values (they wait while live), a strategy's own values, the paper model, a lamport value, and names that are no tunable. */
const PATHS = [
  'risk.entriesPerDay',
  'risk.priceCrossCheckBps',
  'exits.hardStopBps',
  'exits.trailBps',
  'momentum.pullbackBps',
  'crowdflow.minDistinctBuyers5m',
  'momentum.minLiquidityLamports',
  'paper.pFailBps',
  'risk.unknownThing',
  'mode',
] as const;

/** The value the owner types: an index into this tunable's candidates (its bounds and between, one past each, the default, and text that is no number). */
function typed(path: string, i: number): string {
  if (!isTunablePath(path)) {
    return '5';
  }
  const [lo, hi] = boundsOf(path);
  const d = valueAt(DEFAULT_TUNABLES, path);
  const big = typeof lo === 'bigint';
  const mid = big ? ((lo as bigint) + (hi as bigint)) / 2n : Math.floor(((lo as number) + (hi as number)) / 2);
  const below = big ? (lo as bigint) - 1n : (lo as number) - 1;
  const above = big ? (hi as bigint) + 1n : (hi as number) + 1;
  const candidates = [String(lo), String(hi), String(mid), String(d), String(below), String(above), 'abc', '1.5', '-1'];
  return candidates[i % candidates.length] as string;
}

const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 8, arbitrary: fc.record({ kind: fc.constant('set' as const), path: fc.constantFrom(...PATHS), value: fc.nat(17) }) },
  { weight: 2, arbitrary: fc.constant({ kind: 'rollback' as const }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('cancel' as const), path: fc.constantFrom(...PATHS) }) },
  { weight: 3, arbitrary: fc.constant({ kind: 'due' as const }) },
  { weight: 3, arbitrary: fc.constantFrom(1, 60_000, HOUR, DAY, DAY + 1, 2 * DAY).map((ms) => ({ kind: 'forward' as const, ms })) },
  { weight: 1, arbitrary: fc.constantFrom(1, 60_000, HOUR, DAY).map((ms) => ({ kind: 'back' as const, ms })) },
  { weight: 2, arbitrary: fc.constantFrom(...STRATEGY_IDS).map((strategy) => ({ kind: 'live' as const, strategy })) },
);

/** Two fixed sequences run first on every execution, so each case is reached whatever the seed. */
const EXAMPLES: [Step[]][] = [
  [
    [
      { kind: 'live', strategy: 'momentum' },
      { kind: 'set', path: 'exits.trailBps', value: 0 }, // a neutral exit value while live: waits
      { kind: 'set', path: 'risk.entriesPerDay', value: 1 }, // riskier while live: waits
      { kind: 'set', path: 'risk.entriesPerDay', value: 3 }, // the current value: cancels its row
      { kind: 'forward', ms: DAY },
      { kind: 'due' }, // the exit value applies: momentum is demoted, every gate restarts
      { kind: 'set', path: 'momentum.pullbackBps', value: 2 },
      { kind: 'rollback' },
      { kind: 'rollback' },
      { kind: 'rollback' }, // nothing left to roll back
    ],
  ],
  [
    [
      { kind: 'live', strategy: 'crowdflow' },
      { kind: 'forward', ms: HOUR },
      { kind: 'set', path: 'risk.entriesPerDay', value: 1 }, // waits
      { kind: 'back', ms: HOUR },
      { kind: 'due' }, // a row asked for after now: not run
      { kind: 'set', path: 'risk.priceCrossCheckBps', value: 0 }, // safer, at the row's time: the clock is behind
      { kind: 'cancel', path: 'risk.entriesPerDay' },
      { kind: 'cancel', path: 'risk.entriesPerDay' }, // nothing to cancel
      { kind: 'set', path: 'paper.pFailBps', value: 2 }, // more pessimistic: applies, restarts every gate
      { kind: 'set', path: 'paper.pFailBps', value: 0 }, // back down: refused, the paper model never loosens
      { kind: 'rollback' }, // only the paper model to undo: refused
      { kind: 'set', path: 'exits.hardStopBps', value: 1 }, // riskier while live: waits
      { kind: 'rollback' }, // replaces the waiting row; the paper model stays
    ],
  ],
];

interface Model {
  history: ConfigVersion[];
  pending: PendingChange[];
  modes: Record<StrategyId, { mode: 'off' | 'paper' | 'live'; gateSince: number }>;
}

const byPath = (a: PendingChange, b: PendingChange): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const liveOf = (m: Model): StrategyId[] => STRATEGY_IDS.filter((s) => m.modes[s].mode === 'live');
const stateOf = (m: Model): ConfigState => ({ history: m.history, active: m.history.at(-1)!, pending: [...m.pending].sort(byPath), liveStrategies: liveOf(m) });

function touch(m: Model, demote: readonly StrategyId[], restart: readonly StrategyId[], at: number): void {
  for (const s of demote) {
    m.modes[s] = { mode: 'paper', gateSince: Math.max(m.modes[s].gateSince, at) };
  }
  for (const s of restart) {
    m.modes[s] = { ...m.modes[s], gateSince: Math.max(m.modes[s].gateSince, at) };
  }
}

/** The model of one owner config command: the planner at commandTime, then what writeOwnerConfig, demote and restartGate store. */
function modelCommand(
  m: Model,
  now: number,
  plan: (s: ConfigState, ctx: ChangeContext) => { readonly ok: false; readonly reason: string } | { readonly ok: true; readonly version: ConfigVersion | null; readonly p: Omit<Extract<OwnerConfigOutcome, { kind: 'done' }>, 'kind' | 'at' | 'clockBehind' | 'versionId' | 'cancelled'> & { readonly cancelledRows: readonly PendingChange[] } },
): OwnerConfigOutcome {
  const s = stateOf(m);
  const t = commandTime(now, s);
  const r = plan(s, { now: t, liveArmed: false, liveStrategies: s.liveStrategies });
  if (!r.ok) {
    return { kind: 'refused', reason: r.reason as never };
  }
  if (r.version !== null) {
    m.history.push(r.version);
  }
  const gone = new Set(r.p.cancelledRows.map((row) => row.path));
  m.pending = [...m.pending.filter((row) => !gone.has(row.path)), ...r.p.pending];
  touch(m, r.p.demoted, r.p.restarted, t);
  return { kind: 'done', at: t, clockBehind: t > now, versionId: r.version?.id ?? null, applied: r.p.applied, pending: r.p.pending, cancelled: r.p.cancelledRows.map((row) => row.path), kept: r.p.kept, demoted: r.p.demoted, restarted: r.p.restarted };
}

function modelDue(m: Model, now: number): DueOutcome {
  if (m.pending.length === 0) {
    return { kind: 'nothing-due' };
  }
  if (m.pending.some((row) => row.requestedAt > now)) {
    return { kind: 'not-run', code: 'clock-behind-pending' };
  }
  const s = stateOf(m);
  const r = applyDuePending(s.active.values, s.pending, { now, liveArmed: false, liveStrategies: s.liveStrategies });
  if (r.steps.length === 0 && r.stale.length === 0) {
    return { kind: 'nothing-due' };
  }
  const ids: number[] = [];
  for (const st of r.steps) {
    const active = m.history.at(-1)!;
    const v = nextVersion(active, st.values, st.change.source, Math.max(now, active.createdAt));
    m.history.push(v);
    ids.push(v.id);
  }
  const gone = new Set([...r.steps.map((st) => st.change.path), ...r.stale.map((row) => row.path)]);
  m.pending = m.pending.filter((row) => !gone.has(row.path));
  touch(m, r.demote, r.restartGate, now);
  return { kind: 'applied', versionIds: ids, applied: r.steps.map((st) => st.change.path), dropped: r.stale.map((row) => row.path), demoted: r.demote, restarted: r.restartGate };
}

const decoded = (db: Db): ConfigVersion[] =>
  readConfigHistory(db).map((s) => ({ id: s.id, createdAt: s.createdAt, author: s.author, values: decodeTunables(s.valuesJson), changed: s.changed as readonly TunablePath[], undoTo: s.undoTo }));

const auditRows = (db: Db): string[] => db.all('SELECT actor, action FROM audit_log ORDER BY id').map((r) => `${String(r['actor'])} ${String(r['action'])}`);

const seen = new Set<string>();

describe('the owner\'s commands and the due step against the pure planners on random sequences (s.17.8)', () => {
  it('200 runs of up to 30 steps: outcomes, history, waiting rows, modes and gates equal the model after every step', () => {
    fc.assert(
      fc.property(fc.array(step, { minLength: 5, maxLength: 30 }), (steps) => {
        const w = dayWorld();
        try {
          const modes = readModes(w.db);
          const m: Model = {
            history: [firstVersion(DEFAULT_TUNABLES, T)],
            pending: [],
            modes: Object.fromEntries(STRATEGY_IDS.map((s) => [s, { mode: modes[s].mode, gateSince: modes[s].gateSince }])) as Model['modes'],
          };
          for (const s of steps) {
            const now = w.clock.now();
            const audits = auditRows(w.db).length;
            if (s.kind === 'forward') {
              w.clock.advance(s.ms);
            } else if (s.kind === 'back') {
              w.clock.advance(-s.ms);
            } else if (s.kind === 'live') {
              if (m.modes[s.strategy].mode !== 'live') {
                w.db.transaction((tx) => {
                  setStrategyMode(tx, now, 'owner-telegram', s.strategy, 'paper');
                  setStrategyMode(tx, now, 'owner-telegram', s.strategy, 'live');
                });
                m.modes[s.strategy] = { ...m.modes[s.strategy], mode: 'live' };
              }
            } else if (s.kind === 'due') {
              const expected = modelDue(m, now);
              assert.deepEqual(applyDueTx(w.deps), expected);
              seen.add(`due ${expected.kind}${expected.kind === 'applied' && expected.demoted.length > 0 ? ' demoting' : ''}`);
            } else {
              let o: OwnerConfigOutcome;
              let expected: OwnerConfigOutcome;
              if (s.kind === 'set') {
                const value = typed(s.path, s.value);
                o = setTx(w.deps, 'owner-telegram', s.path, value);
                expected = modelCommand(m, now, (st, ctx) => {
                  const p = planSet(st.active.values, s.path, value, ctx, st.pending);
                  return p.ok ? { ok: true, version: p.applied.length > 0 ? nextVersion(st.active, p.values, 'owner', ctx.now) : null, p: { ...p, cancelledRows: p.cancelled, demoted: p.demote, restarted: p.restartGate } } : p;
                });
              } else if (s.kind === 'rollback') {
                o = rollbackTx(w.deps, 'owner-telegram');
                expected = modelCommand(m, now, (st, ctx) => {
                  const p = planRollback(st.history, st.active.id, ctx, st.pending);
                  return p.ok ? { ok: true, version: p.applied.length > 0 ? nextVersion(st.active, p.values, 'rollback', ctx.now, p.undoTo) : null, p: { ...p, cancelledRows: p.cancelled, demoted: p.demote, restarted: p.restartGate } } : p;
                });
              } else {
                o = cancelPendingTx(w.deps, 'owner-telegram', s.path);
                expected = modelCommand(m, now, (st, ctx) => {
                  const p = planCancel(st.pending, s.path, ctx);
                  return p.ok ? { ok: true, version: null, p: { applied: [], pending: [], cancelledRows: [p.cancelled], kept: [], demoted: [], restarted: [] } } : p;
                });
              }
              assert.deepEqual(o, expected, `${s.kind}: storage never refuses a planner's plan`);
              seen.add(`${s.kind} ${o.kind === 'done' ? (o.versionId !== null ? 'version' : o.pending.length > 0 ? 'waiting' : 'cancel only') : o.kind === 'refused' ? o.reason : 'error'}`);
              if (o.kind === 'done') {
                // the owner's row first, then only the engine's demotions
                const fresh = auditRows(w.db).slice(audits);
                assert.deepEqual(fresh, [`owner-telegram owner:${s.kind === 'cancel' ? 'cancel-pending' : s.kind}`, ...o.demoted.map(() => 'engine engine:demote')]);
                if (o.clockBehind) {
                  seen.add('clock behind');
                }
              }
            }
            assert.deepEqual(decoded(w.db), m.history, 'every stored version decodes to the model\'s');
            assert.deepEqual(readConfigState(w.db).pending, [...m.pending].sort(byPath));
            const stored = readModes(w.db);
            assert.deepEqual(Object.fromEntries(STRATEGY_IDS.map((x) => [x, { mode: stored[x].mode, gateSince: stored[x].gateSince }])), m.modes);
            verifyAuditChain(w.db);
          }
        } finally {
          w.db.close();
        }
      }),
      { numRuns: 200, examples: EXAMPLES },
    );
    for (const kind of [
      'set version',
      'set waiting',
      'set cancel only',
      'set unknown-parameter',
      'set not-a-number',
      'set out-of-bounds',
      'set no-change',
      'set paper-only-more-pessimistic',
      'rollback version',
      'rollback waiting',
      'rollback nothing-to-roll-back',
      'rollback paper-only-more-pessimistic',
      'cancel cancel only',
      'cancel nothing-to-cancel',
      'due applied demoting',
      'due not-run',
      'clock behind',
    ]) {
      assert.ok(seen.has(kind), `no run reached ${kind}`);
    }
  });
});
