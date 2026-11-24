// The day-sequence property of step 6e-1 (STORAGE_DESIGN.md s.17.8): random steps (the clock forward
// from 1 ms to 26 hours and back from 1 ms to 2 days, across both time-change nights; the one position's
// mark set to zero, small, large, above 2 SOL; the mark left to go stale past 30 s and 5 minutes; the
// paper SOL set to zero or low; an untrusted clock; the owner's resumes, through resumeTx since 6e-4,
// with its refusals modelled by the same rules) run through observeDayTx on
// SQLite and, beside it, through the pure functions on a model: the same valuation, the base from the
// model's own snapshots by the same rule, observeEquity, the halts of the halting trips, the low-equity
// stop. After every step the stored day state, halts, stop flag and snapshots equal the model's; the
// audit chain holds and each halt names its own row; no honest step ends in day-state-error.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { MARK_POLICY, lowEquityStopOf } from '../../../src/app/caps.ts';
import { DAY_HALT_TRIPS, JUMP_BASE_TOLERANCE_MS, observeDayTx } from '../../../src/app/day-tx.ts';
import { ledgerOf, readActiveConfig } from '../../../src/app/snapshot.ts';
import { lamports, tokenUnits } from '../../../src/core/units.ts';
import { valueEquity, type Mark } from '../../../src/portfolio/equity.ts';
import { RiskError } from '../../../src/risk/reserve.ts';
import { emptyEquityState, observeEquity, resumePeak, resumeStreak, type EquityPolicy, type EquityState } from '../../../src/risk/daystate.ts';
import { readAuditRow, verifyAuditChain } from '../../../src/storage/repo-audit.ts';
import { readAccount, readActivePositions } from '../../../src/storage/repo-book.ts';
import { readDayState } from '../../../src/storage/repo-day.ts';
import { readFlags, readHalts } from '../../../src/storage/repo-flags.ts';
import { RESUME_FRESH_MS, resumeTx } from '../../../src/app/owner-tx.ts';
import { dayPolicyOf } from '../../../src/app/caps.ts';
import { DAY, HOUR, dayWorld, holding, mark, setPaperSol, type DayWorld } from '../../unit/app/day-world.ts';
import { T } from '../../unit/app/world.ts';

type Step =
  | { readonly kind: 'forward'; readonly ms: number }
  | { readonly kind: 'back'; readonly ms: number }
  | { readonly kind: 'mark'; readonly value: bigint }
  | { readonly kind: 'sol'; readonly sol: bigint }
  | { readonly kind: 'trust'; readonly trusted: boolean }
  | { readonly kind: 'resume'; readonly which: 'peak' | 'streak' }
  | { readonly kind: 'observe' };

const SOL = 1_000_000_000n;
const forward = fc.constantFrom(1, 5_000, 30_001, 300_001, HOUR, HOUR + 600_001, 6 * HOUR, DAY, 26 * HOUR).map((ms) => ({ kind: 'forward' as const, ms }));
const back = fc.constantFrom(1, 60_000, HOUR, DAY, 2 * DAY).map((ms) => ({ kind: 'back' as const, ms }));
const markStep = fc.constantFrom(0n, 50_000_000n, 150_000_000n, 300_000_000n, 550_000_000n, 650_000_000n, 900_000_000n, 1_600_000_000n, 3n * SOL).map((value) => ({ kind: 'mark' as const, value }));
const solStep = fc.constantFrom(0n, 150_000_000n, 550_000_000n).map((sol) => ({ kind: 'sol' as const, sol }));
const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 8, arbitrary: fc.constant({ kind: 'observe' as const }) },
  { weight: 5, arbitrary: forward },
  { weight: 1, arbitrary: back },
  { weight: 4, arbitrary: markStep },
  { weight: 1, arbitrary: solStep },
  { weight: 1, arbitrary: fc.boolean().map((trusted) => ({ kind: 'trust' as const, trusted })) },
  { weight: 1, arbitrary: fc.constantFrom('peak' as const, 'streak' as const).map((which) => ({ kind: 'resume' as const, which })) },
);
/** The start: the test day, and half an hour before Athens midnight on the 23- and 25-hour nights. */
const start = fc.constantFrom(T, Date.UTC(2026, 2, 28, 21, 30), Date.UTC(2026, 9, 25, 21, 30));

const observe: Step = { kind: 'observe' };
/**
 * Two fixed sequences run first on every execution, so each case below is reached whatever the seed:
 * two stop days in a row (with the peak halt, a far base and both resumes), then a held jump, unknown
 * equity, the sanity and zero halts, a clock back across midnight and an untrusted clock.
 */
const EXAMPLES: [number, Step[]][] = [
  [
    T,
    [
      { kind: 'mark', value: 900_000_000n },
      observe, // 1.45 SOL: the baseline and the peak
      { kind: 'forward', ms: 5_000 },
      { kind: 'mark', value: 300_000_000n },
      observe, // 0.85 SOL: -41%, the first stop day
      { kind: 'forward', ms: DAY },
      { kind: 'mark', value: 0n },
      observe, // 0.55 SOL against the new baseline 0.85: the second stop day, and -62% from the peak
      { kind: 'resume', which: 'peak' },
      { kind: 'resume', which: 'streak' },
      observe,
    ],
  ],
  [
    T,
    [
      observe, // 0.55 SOL
      { kind: 'forward', ms: HOUR },
      { kind: 'mark', value: 900_000_000n },
      observe, // +163% in an hour: held
      { kind: 'forward', ms: 30_001 },
      observe, // the mark is stale: unknown
      { kind: 'mark', value: 3n * SOL },
      observe, // 3.55 SOL: the sanity halts
      { kind: 'sol', sol: 0n },
      { kind: 'mark', value: 0n },
      observe, // zero
      { kind: 'back', ms: DAY },
      observe, // back across midnight
      { kind: 'trust', trusted: false },
      observe, // not run
    ],
  ],
];

interface Snap {
  readonly at: number;
  readonly equity: bigint | null;
  readonly stopEquity: bigint | null;
}

interface Model {
  state: EquityState;
  snaps: Snap[];
  halts: Set<string>;
  stopped: boolean;
}

/** snapshotNear's rule on the model's rows: the known equity nearest the target at or before now, the older on a tie. */
function baseOf(snaps: readonly Snap[], target: number, now: number): Snap | null {
  const known = snaps.filter((s) => s.equity !== null && s.at <= now).sort((a, b) => Math.abs(a.at - target) - Math.abs(b.at - target) || a.at - b.at);
  return known[0] ?? null;
}

const ANOMALY = new Set(['equity-zero', 'sanity-max', 'sanity-bankroll', 'clock-backwards']);
const seenKinds = new Set<string>();

function modelObserve(w: DayWorld, m: Model, policy: EquityPolicy): void {
  const now = w.clock.now();
  const paper = readAccount(w.db, 'paper');
  const { equity, stopEquity } = valueEquity(ledgerOf({ account: paper, positions: readActivePositions(w.db) }), w.marks, now, MARK_POLICY);
  const target = now - HOUR;
  const base = baseOf(m.snaps, target, now);
  const r = observeEquity(m.state, { now, equity, stopEquity, equityAnHourAgo: base === null ? null : lamports(base.equity as bigint) }, policy);
  const backwards = r.trips.includes('clock-backwards');
  const anomaly = r.trips.some((t) => ANOMALY.has(t));
  const low = equity !== null && !anomaly && !r.state.jumpPending ? lowEquityStopOf(r.state.dayStart, equity, readActiveConfig(w.db).tunables) : null;
  m.state = r.state;
  if (!backwards) {
    if (!m.snaps.some((s) => s.at === now)) {
      m.snaps.push({ at: now, equity: anomaly ? null : equity, stopEquity: anomaly ? null : stopEquity });
    }
    m.snaps = m.snaps.filter((s) => s.at >= Math.max(0, now - DAY));
  }
  for (const t of r.trips) {
    if ((DAY_HALT_TRIPS as readonly string[]).includes(t)) {
      m.halts.add(`${t}:paper`);
    }
    seenKinds.add(`trip ${t}`);
  }
  if (low !== null) {
    m.stopped = low;
  }
  if (base !== null && Math.abs(base.at - target) > JUMP_BASE_TOLERANCE_MS) {
    seenKinds.add('base far');
  }
}

function check(w: DayWorld, m: Model): void {
  assert.deepEqual(readDayState(w.db, 'paper'), m.state);
  assert.deepEqual(readHalts(w.db).map((h) => h.reason).sort(), [...m.halts].sort());
  assert.equal(readFlags(w.db).entriesStopped, m.stopped);
  const rows = w.db.all("SELECT at, equity, stop_equity FROM equity_snapshots WHERE mode = 'paper' ORDER BY at");
  const stored = rows.map((r) => ({ at: Number(r['at']), equity: r['equity'] === null ? null : BigInt(String(r['equity'])), stopEquity: r['stop_equity'] === null ? null : BigInt(String(r['stop_equity'])) }));
  assert.deepEqual(stored, [...m.snaps].sort((a, b) => a.at - b.at));
  verifyAuditChain(w.db);
  for (const h of readHalts(w.db)) {
    const row = readAuditRow(w.db, h.setAuditId);
    assert.deepEqual([row?.action, row?.detail], ['engine:halt-set', { reason: h.reason }], h.reason);
  }
}

describe('observeDayTx against the pure functions on random day sequences (s.17.8)', () => {
  it('200 runs of up to 40 steps: the stored state, halts, stop and snapshots equal the model after every step', () => {
    fc.assert(
      fc.property(start, fc.array(step, { minLength: 5, maxLength: 40 }), (from, steps) => {
        const w = dayWorld(undefined, from);
        try {
          holding(w, 'p1', 0n);
          const policy = dayPolicyOf('paper', readActiveConfig(w.db).tunables, readAccount(w.db, 'paper'));
          const m: Model = { state: emptyEquityState(), snaps: [], halts: new Set(), stopped: false };
          let markValue = 0n;
          for (const s of steps) {
            if (s.kind === 'forward') {
              w.clock.advance(s.ms);
            } else if (s.kind === 'back') {
              w.clock.advance(-Math.min(s.ms, w.clock.now() - 1));
            } else if (s.kind === 'mark') {
              markValue = s.value;
              mark(w, 'p1', markValue);
            } else if (s.kind === 'sol') {
              setPaperSol(w, s.sol);
            } else if (s.kind === 'trust') {
              w.guard.trusted = s.trusted;
            } else if (s.kind === 'resume') {
              // through the owner's transaction (6e-4), its refusals by the same rules on the model's own rows
              const now = w.clock.now();
              const reason = s.which === 'peak' ? 'peak-halt:paper' : 'daily-stop-twice:paper';
              const newest = m.snaps.filter((x) => x.at <= now).sort((a, b) => b.at - a.at)[0];
              const refusal = !m.halts.has(reason)
                ? 'not-halted'
                : s.which === 'streak'
                  ? null
                  : m.state.jumpPending
                    ? 'jump-held'
                    : m.state.lastEquity < 1n
                      ? 'equity-unknown'
                      : newest === undefined || newest.equity === null || now - newest.at > RESUME_FRESH_MS
                        ? 'observe-first'
                        : null;
              const o = resumeTx(w.deps, 'owner-telegram', s.which);
              if (refusal === null) {
                assert.deepEqual(o, { kind: 'resumed', which: s.which, at: now });
                m.halts.delete(reason);
                m.state = s.which === 'peak' ? resumePeak(m.state) : resumeStreak(m.state);
                seenKinds.add(`resume ${s.which}`);
              } else {
                assert.deepEqual(o, { kind: 'refused', reason: refusal });
                if (refusal === 'jump-held' || refusal === 'equity-unknown') {
                  assert.throws(() => resumePeak(m.state), RiskError); // the pure function refuses the same states
                }
                seenKinds.add(`resume refused ${refusal}`);
              }
            } else {
              const o = observeDayTx(w.deps);
              assert.notEqual(o.kind, 'error', `no honest step ends in day-state-error: ${JSON.stringify(o, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}`);
              if (o.kind === 'observed') {
                modelObserve(w, m, policy);
                seenKinds.add(o.equityKnown ? 'equity known' : 'equity unknown');
              } else {
                seenKinds.add('not-run');
              }
            }
            check(w, m);
          }
        } finally {
          w.db.close();
        }
      }),
      { numRuns: 200, examples: EXAMPLES },
    );
    // the runs reached the cases they are for
    for (const kind of ['trip daily-stop', 'trip peak-halt', 'trip equity-jump', 'trip clock-backwards', 'trip sanity-max', 'trip equity-zero', 'trip daily-stop-twice', 'equity unknown', 'not-run', 'resume peak', 'base far']) {
      assert.ok(seenKinds.has(kind), `no run reached ${kind}`);
    }
  });
});
