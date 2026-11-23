// The exit path's own alerts (review T, risk 4, 5 and 8; STORAGE_DESIGN.md s.16.14): an exit that is
// refused warns, at most once a minute per position and refusal codes; a refusal for the fee budget
// says so; five exits in a row that did not approve for one position raise exit-blocked, at most
// once in ten minutes per position; an approved exit ends the run. Written before src/app/exit-watch.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT_WATCH_RULES, createExitWatch } from '../../../src/app/exit-watch.ts';
import { createEntryLatch } from '../../../src/app/faults.ts';
import { recordingAlerts, testClock } from './world.ts';

function world() {
  const alerts = recordingAlerts();
  const clock = testClock();
  const latch = createEntryLatch();
  return { alerts, clock, latch, watch: createExitWatch({ alerts, clock, latch }) };
}

describe('app/exit-watch.ts', () => {
  it('the fixed rules', () => {
    assert.deepEqual({ ...EXIT_WATCH_RULES }, { blockedAfter: 5, refusedEveryMs: 60_000, blockedEveryMs: 600_000 });
    assert.ok(Object.isFrozen(EXIT_WATCH_RULES));
  });

  it('a refusal warns with the position and its codes, at most once a minute per position and codes', () => {
    const w = world();
    w.watch.refused('ps_a', ['stale-quote']);
    w.watch.refused('ps_a', ['stale-quote']);
    w.watch.refused('ps_a', ['slippage-above-cap']);
    w.watch.refused('ps_b', ['stale-quote']);
    assert.deepEqual(w.alerts.seen, [
      { code: 'exit-refused', severity: 'warn', codes: ['ps_a', 'plan:stale-quote'] },
      { code: 'exit-refused', severity: 'warn', codes: ['ps_a', 'plan:slippage-above-cap'] },
      { code: 'exit-refused', severity: 'warn', codes: ['ps_b', 'plan:stale-quote'] },
    ]);
    const refusedAlerts = (): number => w.alerts.codes().filter((c) => c === 'exit-refused').length;
    w.clock.advance(59_999);
    w.watch.refused('ps_a', ['stale-quote']);
    assert.equal(refusedAlerts(), 3);
    w.clock.advance(1);
    w.watch.refused('ps_a', ['stale-quote']);
    assert.equal(refusedAlerts(), 4);
    w.clock.advance(-3_600_000); // a clock that stepped back alerts again rather than staying quiet
    w.watch.refused('ps_a', ['stale-quote']);
    assert.equal(refusedAlerts(), 5);
  });

  it('a refusal for the fee budget, or because automatic exits stopped, says so (risk 8)', () => {
    const w = world();
    w.watch.refused('ps_a', ['exit-fee-budget']);
    w.watch.refused('ps_b', ['auto-exits-stopped']); // alone, so the other problem cannot raise it
    assert.deepEqual(
      w.alerts.seen.filter((a) => a.code === 'exit-fee-budget'),
      [
        { code: 'exit-fee-budget', severity: 'warn', codes: ['ps_a'] },
        { code: 'exit-fee-budget', severity: 'warn', codes: ['ps_b'] },
      ],
    );
  });

  it('five exits in a row that did not approve raise exit-blocked, at most once in ten minutes; an approval ends the run', () => {
    const w = world();
    for (let i = 0; i < 4; i += 1) {
      w.watch.failed('ps_a');
    }
    assert.deepEqual(w.alerts.codes(), []);
    w.watch.refused('ps_a', ['stale-quote']);
    assert.deepEqual(w.alerts.seen.at(-1), { code: 'exit-blocked', severity: 'warn', codes: ['ps_a'] });
    w.watch.failed('ps_a');
    w.clock.advance(599_999);
    w.watch.failed('ps_a');
    assert.equal(w.alerts.codes().filter((c) => c === 'exit-blocked').length, 1);
    w.clock.advance(1);
    w.watch.failed('ps_a');
    assert.equal(w.alerts.codes().filter((c) => c === 'exit-blocked').length, 2);
    w.watch.approved('ps_a');
    for (let i = 0; i < 4; i += 1) {
      w.watch.failed('ps_a');
    }
    assert.equal(w.alerts.codes().filter((c) => c === 'exit-blocked').length, 2, 'the run starts again after an approval');
    w.watch.failed('ps_b');
    w.watch.approved('ps_unknown');
    assert.equal(w.alerts.codes().filter((c) => c === 'exit-blocked').length, 2, 'each position has its own run');
  });

  it('an alert sink that throws latches entries as a bug and never escapes', () => {
    const latch = createEntryLatch();
    const watch = createExitWatch({
      alerts: {
        alert: () => {
          throw new Error('telegram down');
        },
      },
      clock: testClock(),
      latch,
    });
    watch.refused('ps_a', ['stale-quote']);
    assert.deepEqual(latch.blocked(), ['bug']);
  });

  it('refuses options it cannot use', () => {
    const ok = { alerts: recordingAlerts(), clock: testClock(), latch: createEntryLatch() };
    for (const key of Object.keys(ok)) {
      assert.throws(() => createExitWatch({ ...ok, [key]: null } as unknown as typeof ok), TypeError, key);
    }
  });
});
