// The error rules of the app/ transactions (STORAGE_DESIGN.md s.16.5.6): every throw out of a
// transaction becomes a fixed code (never its message), a scope (this intent only, a latch on new
// entries until the restart, or fatal) and its alerts. A busy database three times in ten minutes,
// a full disk or an I/O error also asks for the disk-db halt. The entry latch blocks entries before
// the database is touched; KILL seen anywhere is remembered there too. Written before
// src/app/faults.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AppError, classify, createEntryLatch, createFaultSink, isSecretRefusal, type Alert, type Fault } from '../../../src/app/faults.ts';
import { AmountError } from '../../../src/core/units.ts';
import { RngError } from '../../../src/core/rng.ts';
import { LedgerError } from '../../../src/portfolio/ledger.ts';
import { RiskError } from '../../../src/risk/reserve.ts';
import { StorageError, type StorageErrorCode } from '../../../src/storage/sqlite.ts';

const fault = (code: string, scope: Fault['scope'], flags: Partial<Omit<Fault, 'code' | 'scope'>> = {}): Fault => ({
  code,
  scope,
  bug: false,
  warn: false,
  busy: false,
  disk: false,
  ...flags,
});

describe('classify: each throw to its code, scope and alerts', () => {
  it('every storage code', () => {
    const expect: Readonly<Record<StorageErrorCode, Fault>> = {
      busy: fault('error:storage-busy', 'intent', { busy: true }),
      constraint: fault('error:storage-constraint', 'intent', { bug: true }),
      'bad-param': fault('error:storage-bad-param', 'intent', { bug: true }),
      'row-missing': fault('error:storage-row-missing', 'latch', { bug: true }),
      'row-count': fault('error:storage-row-count', 'latch', { bug: true }),
      'bad-cell': fault('error:storage-bad-cell', 'latch', { bug: true }),
      'tx-failed': fault('error:storage-tx-failed', 'latch', { bug: true }),
      denied: fault('error:storage-denied', 'latch', { bug: true }),
      'bad-sql': fault('error:storage-bad-sql', 'latch', { bug: true }),
      'audit-broken': fault('error:storage-audit-broken', 'latch', { bug: true }),
      'bad-option': fault('error:storage-bad-option', 'latch', { bug: true }),
      other: fault('error:storage-other', 'latch', { bug: true }),
      full: fault('error:storage-full', 'latch', { warn: true, disk: true }),
      io: fault('error:storage-io', 'latch', { warn: true, disk: true }),
      corrupt: fault('error:storage-corrupt', 'latch', { warn: true }),
      'not-a-database': fault('error:storage-not-a-database', 'latch', { warn: true }),
      readonly: fault('error:storage-readonly', 'latch', { warn: true }),
      pragma: fault('error:storage-pragma', 'latch', { warn: true }),
      closed: fault('error:storage-closed', 'latch', { warn: true }),
      missing: fault('error:storage-missing', 'latch', { warn: true }),
      'foreign-file': fault('error:storage-foreign-file', 'latch', { warn: true }),
      'schema-edited': fault('error:storage-schema-edited', 'latch', { warn: true }),
      'schema-newer': fault('error:storage-schema-newer', 'latch', { warn: true }),
      'schema-broken': fault('error:storage-schema-broken', 'latch', { warn: true }),
      poisoned: fault('error:storage-poisoned', 'fatal', { warn: true }),
      'async-in-transaction': fault('error:storage-async-in-transaction', 'fatal', { bug: true }),
      'nested-transaction': fault('error:storage-nested-transaction', 'fatal', { bug: true }),
      'tx-closed': fault('error:storage-tx-closed', 'fatal', { bug: true }),
    };
    for (const [code, want] of Object.entries(expect)) {
      assert.deepEqual(classify(new StorageError(code as StorageErrorCode, 'a detail with a secret-looking value 0123456789abcdef')), want, code);
    }
  });

  it("a secret-filter refusal of the caller's own text, and a token used too late or with a clock behind its issue, are warnings, not bugs", () => {
    const e = new StorageError('bad-param', 'expected the reasons that does not look like a secret (it looks like one: own-secret)');
    assert.deepEqual(classify(e), fault('error:storage-bad-param', 'intent', { warn: true }));
    for (const detail of [
      'expected a redeem at or after the token was issued (a clock behind it: a retry gets a new token)',
      'expected a redeem within 15 s of the token issue (a slot feed behind the chain, or a long wait for the database: a retry gets a new token)',
    ]) {
      assert.deepEqual(classify(new StorageError('bad-param', detail)), fault('error:storage-bad-param', 'intent', { warn: true }));
    }
  });

  it('every app code', () => {
    const expect = {
      'slot-unknown': fault('error:slot-unknown', 'intent'),
      'abandon-needs-settlement': fault('error:abandon-needs-settlement', 'intent'),
      'abandon-token-valid': fault('error:abandon-token-valid', 'intent'),
      'entries-latched': fault('error:entries-latched', 'intent'),
      'rent-unknown': fault('error:rent-unknown', 'intent', { warn: true }),
      'p95-below-base-fee': fault('error:p95-below-base-fee', 'intent', { warn: true }),
      'stale-opening-has-order': fault('error:stale-opening-has-order', 'intent', { warn: true }),
      'live-not-built': fault('error:live-not-built', 'intent', { bug: true }),
      'bad-request': fault('error:bad-request', 'intent', { bug: true }),
      'entry-count-mismatch': fault('error:entry-count-mismatch', 'latch', { bug: true }),
    } as const;
    for (const [code, want] of Object.entries(expect)) {
      const e = new AppError(code as keyof typeof expect, 'a fixed sentence');
      assert.equal(e.code, code);
      assert.equal(e.name, 'AppError');
      assert.deepEqual(classify(e), want, code);
    }
  });

  it("risk, amount, ledger and randomness errors stay with their intent; only risk's hard-limit backstop is a bug", () => {
    assert.deepEqual(classify(new RiskError('the approval would break a hard limit (exposure): refusing')), fault('error:risk', 'intent', { bug: true }));
    assert.deepEqual(classify(new RiskError('the plan is malformed')), fault('error:risk', 'intent'));
    // states the database and the snapshot make impossible are bugs too (review T, risk 4); the
    // approve-tx tests pin these words against risk's own throws
    for (const message of [
      'more than 1000 active positions: not a real portfolio',
      'a position has an unknown strategy',
      'a position here must be opening, open, exiting or stuck',
      'two positions share an id, or the new position already exists',
      'two active positions share a mint',
      'an opening position carries its maxSpend and the others their value, never the other number',
    ]) {
      assert.deepEqual(classify(new RiskError(message)), fault('error:risk', 'intent', { bug: true }), message);
    }
    assert.deepEqual(classify(new AmountError('not an amount')), fault('error:amount', 'intent'));
    assert.deepEqual(classify(new LedgerError('not balanced')), fault('error:ledger', 'intent'));
    assert.deepEqual(classify(new RngError('rng-filter', 'x')), fault('error:rng-filter', 'intent', { warn: true }));
    assert.deepEqual(classify(new RngError('rng-zero-key', 'x')), fault('error:rng-zero-key', 'intent', { warn: true }));
    assert.deepEqual(classify(new RngError('rng-bad-bytes', 'x')), fault('error:rng-bad-bytes', 'intent', { bug: true }));
  });

  it('anything else, and anything shaped to fool the check, is unexpected: a latch and a bug', () => {
    const unexpected = fault('error:unexpected', 'latch', { bug: true });
    const forged = Object.create(StorageError.prototype) as StorageError;
    Object.defineProperty(forged, 'code', { get: () => 'busy' });
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('trap');
        },
      },
    );
    const unknownCode = new StorageError('busy', 'x');
    Object.defineProperty(unknownCode, 'code', { value: 'made-up' });
    const unknownApp = new AppError('slot-unknown', 'x');
    Object.defineProperty(unknownApp, 'code', { value: 'made-up' });
    const unknownRng = new RngError('rng-filter', 'x');
    Object.defineProperty(unknownRng, 'code', { value: 'made-up' });
    for (const e of [new Error('x'), new TypeError('y'), 'a string', 42, null, undefined, { code: 'busy' }, forged, hostile, unknownCode, unknownApp, unknownRng]) {
      assert.deepEqual(classify(e), unexpected);
    }
    assert.ok(Object.isFrozen(classify(new Error('z'))));
  });
});

describe('isSecretRefusal: the secret filter refused the text the bot was given (the exit retry, review T)', () => {
  it("is true only for storage's bad-param with the filter's own words", () => {
    assert.equal(isSecretRefusal(new StorageError('bad-param', 'expected the reasons that does not look like a secret (it looks like one: own-secret)')), true);
    const forged = new StorageError('bad-param', 'x');
    Object.defineProperty(forged, 'detail', { get: () => 'it looks like one: own-secret' });
    const otherCode = new StorageError('constraint', 'it looks like one: own-secret');
    // a look-alike that passes instanceof and throws when its fields are read: still false, never a throw
    const hostile = new Proxy(new StorageError('bad-param', 'x'), {
      getOwnPropertyDescriptor: () => {
        throw new Error('trap');
      },
    });
    for (const e of [
      hostile,
      new StorageError('bad-param', 'expected a redeem within 15 s of the token issue (a retry gets a new token)'),
      new StorageError('bad-param', 'expected a code'),
      otherCode,
      forged,
      new Error('it looks like one: own-secret'),
      { code: 'bad-param', detail: 'it looks like one: own-secret' },
      null,
      'it looks like one:',
    ]) {
      assert.equal(isSecretRefusal(e), false);
    }
  });
});

describe('the entry latch', () => {
  it('starts open; each reason is kept once, sorted, until the restart; KILL seen is kept too', () => {
    const latch = createEntryLatch();
    assert.deepEqual(latch.blocked(), []);
    assert.equal(latch.killSeen(), false);
    latch.set('storage');
    latch.set('bug');
    latch.set('storage');
    assert.deepEqual(latch.blocked(), ['bug', 'storage']);
    assert.ok(Object.isFrozen(latch.blocked()));
    latch.markKill();
    assert.equal(latch.killSeen(), true);
    assert.throws(() => latch.set('whatever' as 'bug'), TypeError);
    assert.deepEqual(latch.blocked(), ['bug', 'storage']);
    assert.ok(Object.isFrozen(latch));
  });
});

/** A sink with recording callbacks and a clock the test moves. */
function sinkWorld() {
  const alerts: Alert[] = [];
  const fatal: string[] = [];
  const disk: string[] = [];
  let now = 1_000_000;
  const latch = createEntryLatch();
  const sink = createFaultSink({
    latch,
    alerts: { alert: (a) => alerts.push(a) },
    clock: { now: () => now },
    onFatal: (code) => fatal.push(code),
    onDiskTrouble: (code) => disk.push(code),
  });
  return { alerts, fatal, disk, latch, sink, advance: (ms: number) => (now += ms) };
}

describe('the fault sink: what each scope does', () => {
  it('an intent fault alerts only as a bug or a warning, and latches nothing', () => {
    const w = sinkWorld();
    w.sink.report('t1-buy', fault('error:slot-unknown', 'intent'));
    assert.deepEqual(w.alerts, []);
    w.sink.report('t1-buy', fault('error:storage-constraint', 'intent', { bug: true }));
    w.sink.report('t1-exit', fault('error:rent-unknown', 'intent', { warn: true }));
    assert.deepEqual(w.alerts, [
      { code: 'error:storage-constraint', severity: 'bug', codes: ['t1-buy'] },
      { code: 'error:rent-unknown', severity: 'warn', codes: ['t1-exit'] },
    ]);
    assert.deepEqual(w.latch.blocked(), []);
  });

  it('a latch fault latches storage, or bug for a bug, and alerts', () => {
    const w = sinkWorld();
    w.sink.report('t2', fault('error:storage-corrupt', 'latch', { warn: true }));
    w.sink.report('t1-buy', fault('error:unexpected', 'latch', { bug: true }));
    assert.deepEqual(w.latch.blocked(), ['bug', 'storage']);
    assert.deepEqual(
      w.alerts.map((a) => [a.code, a.severity]),
      [
        ['error:storage-corrupt', 'warn'],
        ['error:unexpected', 'bug'],
      ],
    );
    assert.deepEqual(w.disk, []);
  });

  it('a full disk or an I/O error latches, alerts and asks for the disk-db halt each time', () => {
    const w = sinkWorld();
    w.sink.report('t1-buy', fault('error:storage-full', 'latch', { warn: true, disk: true }));
    w.sink.report('refusal', fault('error:storage-io', 'latch', { warn: true, disk: true }));
    assert.deepEqual(w.disk, ['error:storage-full', 'error:storage-io']);
    assert.deepEqual(w.latch.blocked(), ['storage']);
  });

  it('a fatal fault latches, alerts as fatal, and calls onFatal once only', () => {
    const w = sinkWorld();
    w.sink.report('t1-buy', fault('error:storage-poisoned', 'fatal', { warn: true }));
    w.sink.report('t2', fault('error:storage-tx-closed', 'fatal', { bug: true }));
    assert.deepEqual(w.fatal, ['error:storage-poisoned']);
    assert.deepEqual(w.latch.blocked(), ['bug', 'storage']);
    assert.deepEqual(
      w.alerts.map((a) => a.severity),
      ['fatal', 'fatal'],
    );
  });

  it('busy: two in ten minutes change nothing; the third latches storage-busy, alerts once and asks for the halt once', () => {
    const w = sinkWorld();
    const busy = fault('error:storage-busy', 'intent', { busy: true });
    w.sink.report('t1-buy', busy);
    w.advance(5 * 60_000);
    w.sink.report('t1-buy', busy);
    assert.deepEqual(w.latch.blocked(), []);
    assert.deepEqual(w.alerts, []);
    w.advance(5 * 60_000 - 1); // the first is now 9:59.999 ago
    w.sink.report('abandon', busy);
    assert.deepEqual(w.latch.blocked(), ['storage-busy']);
    assert.deepEqual(w.alerts, [{ code: 'storage-busy-storm', severity: 'warn', codes: ['abandon'] }]);
    assert.deepEqual(w.disk, ['storage-busy-storm']);
    w.sink.report('t1-buy', busy);
    assert.equal(w.alerts.length, 1);
    assert.equal(w.disk.length, 1);
  });

  it('busy: three spread over more than ten minutes change nothing', () => {
    const w = sinkWorld();
    const busy = fault('error:storage-busy', 'intent', { busy: true });
    w.sink.report('t1-buy', busy);
    w.advance(5 * 60_000);
    w.sink.report('t1-buy', busy);
    w.advance(5 * 60_000 + 1);
    w.sink.report('t1-buy', busy);
    assert.deepEqual(w.latch.blocked(), []);
    assert.deepEqual(w.alerts, []);
  });

  it('an exit that failed always alerts (review T, risk 4): a quiet fault or a busy refusal on t1-exit or t2-exit warns once a minute per site and code; bugs and warnings alert as always', () => {
    const w = sinkWorld();
    const quiet = fault('error:slot-unknown', 'intent');
    const busy = fault('error:storage-busy', 'intent', { busy: true });
    w.sink.report('t1-exit', quiet);
    w.sink.report('t1-exit', quiet); // within the minute: not again
    w.sink.report('t2-exit', quiet); // another site: its own minute
    w.sink.report('t1-exit', busy);
    w.sink.report('t1-buy', quiet); // a buy's quiet fault stays quiet
    assert.deepEqual(w.alerts, [
      { code: 'error:slot-unknown', severity: 'warn', codes: ['t1-exit'] },
      { code: 'error:slot-unknown', severity: 'warn', codes: ['t2-exit'] },
      { code: 'error:storage-busy', severity: 'warn', codes: ['t1-exit'] },
    ]);
    w.advance(60_000);
    w.sink.report('t1-exit', quiet);
    assert.equal(w.alerts.length, 4);
    w.sink.report('t1-exit', fault('error:storage-constraint', 'intent', { bug: true }));
    w.sink.report('t1-exit', fault('error:storage-constraint', 'intent', { bug: true }));
    assert.deepEqual(
      w.alerts.slice(4).map((a) => a.severity),
      ['bug', 'bug'],
    );
    assert.deepEqual(w.latch.blocked(), []);
  });

  it('never throws: an alert sink or a callback that throws is contained, and latches bug', () => {
    const latch = createEntryLatch();
    const sink = createFaultSink({
      latch,
      alerts: {
        alert: () => {
          throw new Error('telegram down');
        },
      },
      clock: { now: () => 0 },
      onFatal: () => {
        throw new Error('exit failed');
      },
      onDiskTrouble: () => {
        throw new Error('halt failed');
      },
    });
    sink.report('t1-buy', fault('error:storage-full', 'latch', { warn: true, disk: true }));
    sink.report('t1-buy', fault('error:storage-poisoned', 'fatal', { warn: true }));
    sink.report('t1-buy', fault('error:storage-constraint', 'intent', { bug: true }));
    assert.deepEqual(latch.blocked(), ['bug', 'storage']);
  });

  it('refuses options it cannot use', () => {
    const ok = { latch: createEntryLatch(), alerts: { alert: () => undefined }, clock: { now: () => 0 }, onFatal: () => undefined, onDiskTrouble: () => undefined };
    for (const key of Object.keys(ok)) {
      assert.throws(() => createFaultSink({ ...ok, [key]: null } as unknown as typeof ok), TypeError, key);
    }
  });
});

describe('the bug storm (review T, security on D1): bug-class intent faults latch entries when they repeat', () => {
  const bug = fault('error:storage-constraint', 'intent', { bug: true });

  it('five within ten minutes (inclusive) latch entries as a bug and alert once; four do not', () => {
    const w = sinkWorld();
    for (let i = 0; i < 4; i += 1) {
      w.sink.report('t1-buy', bug);
      w.advance(150_000); // the fifth comes exactly ten minutes after the first
    }
    assert.deepEqual(w.latch.blocked(), []);
    w.sink.report('t1-buy', bug);
    assert.deepEqual(w.latch.blocked(), ['bug']);
    assert.deepEqual(
      w.alerts.filter((a) => a.code === 'bug-storm'),
      [{ code: 'bug-storm', severity: 'bug', codes: ['t1-buy'] }],
    );
    w.sink.report('t1-exit', bug);
    assert.equal(w.alerts.filter((a) => a.code === 'bug-storm').length, 1, 'once per process');
  });

  it('five spread over more than ten minutes do not; warnings, quiet faults and latch faults do not count', () => {
    const w = sinkWorld();
    for (let i = 0; i < 5; i += 1) {
      w.sink.report('t1-buy', bug);
      w.advance(150_001);
    }
    for (let i = 0; i < 6; i += 1) {
      w.sink.report('t1-buy', fault('error:rent-unknown', 'intent', { warn: true }));
      w.sink.report('t1-buy', fault('error:slot-unknown', 'intent'));
    }
    assert.deepEqual(w.latch.blocked(), []);
    const latched = sinkWorld();
    for (let i = 0; i < 6; i += 1) {
      latched.sink.report('t1-buy', fault('error:storage-bad-cell', 'latch', { bug: true }));
    }
    assert.equal(latched.alerts.filter((a) => a.code === 'bug-storm').length, 0, 'a latch fault latches on its own');
  });

  it('a clock that steps back neither counts old faults twice nor throws', () => {
    const w = sinkWorld();
    w.sink.report('t1-buy', bug);
    w.advance(-3_600_000);
    for (let i = 0; i < 3; i += 1) {
      w.sink.report('t1-buy', bug);
    }
    assert.deepEqual(w.latch.blocked(), [], 'a fault from the future is not in the window');
  });
});
