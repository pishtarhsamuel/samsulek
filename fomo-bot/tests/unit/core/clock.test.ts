// The real clocks and timers of core/clock.ts (docs/CHAIN_DESIGN.md s.2 and s.3, step 7a): the only file
// that reads the wall clock, the monotonic clock and timers; only cli/ may import it at runtime (the
// architecture test), and everything else is handed these interfaces, so every other test stays
// deterministic. Written before the file.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { systemMono, systemTimers, systemWall } from '../../../src/core/clock.ts';

describe('the system clocks', () => {
  it('the wall clock gives whole UTC milliseconds, the monotonic clock never goes back', () => {
    const before = Date.now();
    const wall = systemWall.now();
    assert.ok(Number.isInteger(wall) && wall >= before && wall <= Date.now());
    assert.ok(systemMono.nowMs() < systemWall.now() / 10, 'the monotonic clock counts from the process start, not from the epoch');
    let last = systemMono.nowMs();
    for (let i = 0; i < 1_000; i += 1) {
      const next = systemMono.nowMs();
      assert.ok(Number.isFinite(next) && next >= last);
      last = next;
    }
  });

  it('each is frozen, so no one swaps a method under the bot', () => {
    for (const o of [systemWall, systemMono, systemTimers]) {
      assert.ok(Object.isFrozen(o));
    }
  });
});

describe('the system timers', () => {
  it('timeoutSignal aborts after the time, not before, with a TimeoutError', async () => {
    const started = performance.now();
    const signal = systemTimers.timeoutSignal(20);
    assert.equal(signal.aborted, false);
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    assert.ok(performance.now() - started >= 15, 'not before its time');
    assert.equal(signal.aborted, true);
    assert.equal((signal.reason as Error).name, 'TimeoutError');
  });

  it('after runs the function once, not before its time, and its cancel stops it', async () => {
    let ran = 0;
    systemTimers.after(25, () => {
      ran += 1;
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
    assert.equal(ran, 0, 'not yet');
    let cancelledRan = 0;
    const cancel = systemTimers.after(10, () => {
      cancelledRan += 1;
    });
    cancel();
    cancel(); // twice is harmless
    await new Promise<void>((resolve) => systemTimers.after(40, resolve));
    assert.equal(ran, 1);
    assert.equal(cancelledRan, 0);
  });

  it('refuses a time that is not a whole number of milliseconds from 0', () => {
    for (const ms of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
      assert.throws(() => systemTimers.timeoutSignal(ms), TypeError);
      assert.throws(() => systemTimers.after(ms, () => undefined), TypeError);
    }
  });
});
