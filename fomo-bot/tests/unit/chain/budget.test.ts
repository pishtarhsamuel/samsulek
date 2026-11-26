// The budget governor (docs/CHAIN_DESIGN.md s.6, step 7b): sliding 10 s windows per method and in all,
// a 30 s window of decoded bytes, at most 6 requests in flight; each with a P0 reserve that no other
// priority may touch; shed levels; Retry-After; a 403 block with one P0 probe; limits learned only
// downward. Deterministic: a hand-driven monotonic clock, no timers. Written before src/chain/budget.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBudgetGovernor, type DenyReason, type Grant, type Settlement, type Ticket } from '../../../src/chain/budget.ts';
import type { ChainEvent } from '../../../src/chain/events.ts';
import type { Priority, ReadMethod } from '../../../src/chain/limits.ts';

const MIB = 1024 * 1024;
const START = 1_000_000;
const OK: Settlement = Object.freeze({ decodedBytes: 100, status: 200, rate: null });

function world(tighten?: Parameters<typeof createBudgetGovernor>[0]['tighten'], throwingSink = false) {
  let now = START;
  const seen: ChainEvent[] = [];
  const gov = createBudgetGovernor({
    provider: 'public-mainnet',
    mono: { nowMs: () => now },
    events: {
      event: (e) => {
        seen.push(e);
        if (throwingSink) {
          throw new Error('the sink failed');
        }
      },
    },
    ...(tighten === undefined ? {} : { tighten }),
  });
  return {
    gov,
    seen,
    now: (): number => now,
    advance: (ms: number): void => {
      now += ms;
    },
    set: (ms: number): void => {
      now = ms;
    },
    codes: (): string[] => seen.map((e) => e.code),
  };
}

function granted(g: Grant): Ticket {
  assert.ok(g.ok, `expected a grant, got ${JSON.stringify(g)}`);
  return g.ticket;
}

function denied(g: Grant, reason: DenyReason): number {
  assert.ok(!g.ok, 'expected a denial, got a grant');
  assert.equal(g.reason, reason);
  return g.retryAtMs;
}

/** Acquires and settles at once (a request that answered), n times. */
function use(w: ReturnType<typeof world>, m: ReadMethod, p: Priority, n = 1): void {
  for (let i = 0; i < n; i += 1) {
    w.gov.settle(granted(w.gov.acquire(m, p)), OK);
  }
}

const rate = (r: Partial<{ methodLimit: number | null; methodRemaining: number | null; retryAfterSec: number | null }>) =>
  Object.freeze({ methodLimit: null, methodRemaining: null, retryAfterSec: null, ...r });

describe('the windows: per method, in all, data and connections', () => {
  it('a method\'s cap per sliding 10 s: the 7th getSlot is refused with the time a slot frees, and granted exactly then', () => {
    const w = world();
    for (let i = 0; i < 6; i += 1) {
      use(w, 'getSlot', 'P0');
      w.advance(1);
    }
    assert.equal(denied(w.gov.acquire('getSlot', 'P0'), 'method-cap'), START + 10_000);
    w.set(START + 9_999);
    denied(w.gov.acquire('getSlot', 'P0'), 'method-cap');
    w.set(START + 10_000); // the first grant is 10 s old: out of the window
    granted(w.gov.acquire('getSlot', 'P0'));
    assert.equal(denied(w.gov.acquire('getSlot', 'P0'), 'method-cap'), START + 1 + 10_000);
    // getSlot's whole cap is P0's: no other priority ever gets one
    assert.equal(denied(w.gov.acquire('getSlot', 'P1'), 'method-cap'), Number.POSITIVE_INFINITY);
  });

  it('non-P0 leaves each method\'s P0 reserve free, and P0 may use the whole cap', () => {
    const w = world();
    use(w, 'getMultipleAccounts', 'P2', 12);
    denied(w.gov.acquire('getMultipleAccounts', 'P2'), 'method-cap');
    denied(w.gov.acquire('getMultipleAccounts', 'P1'), 'method-cap');
    use(w, 'getMultipleAccounts', 'P0', 8);
    denied(w.gov.acquire('getMultipleAccounts', 'P0'), 'method-cap');
  });

  it('the total per 10 s keeps its P0 reserve (tightened here: the method caps add up to only 49 of 60)', () => {
    const w = world({ totalCap: 10, totalP0Reserve: 4 });
    use(w, 'getMultipleAccounts', 'P2', 6);
    assert.equal(denied(w.gov.acquire('getRecentPrioritizationFees', 'P2'), 'total-cap'), START + 10_000);
    use(w, 'getSlot', 'P0', 4);
    denied(w.gov.acquire('getSlot', 'P0'), 'total-cap');
    w.advance(10_000);
    use(w, 'getRecentPrioritizationFees', 'P2');
  });

  it('data: a grant reserves the method\'s byte cap, a settle puts the decoded bytes in its place for 30 s, and P0 keeps its reserve', () => {
    const w = world({ dataCapBytes: 4 * MIB, dataP0ReserveBytes: MIB });
    w.gov.settle(granted(w.gov.acquire('getProgramAccounts', 'P1')), { decodedBytes: 2 * MIB, status: 200, rate: null });
    const t0 = w.now();
    w.advance(1_000);
    const held = granted(w.gov.acquire('getMultipleAccounts', 'P2')); // 2 MiB settled + 1 MiB reserved: the non-P0 3 MiB
    assert.equal(denied(w.gov.acquire('getMultipleAccounts', 'P2'), 'data-cap'), t0 + 30_000); // the 2 MiB answer frees enough then
    const p0 = granted(w.gov.acquire('getMultipleAccounts', 'P0')); // P0 may use the last MiB
    denied(w.gov.acquire('getMultipleAccounts', 'P0'), 'data-cap');
    w.gov.settle(held, { decodedBytes: 10, status: 200, rate: null }); // each reservation becomes 10 bytes
    w.gov.settle(p0, { decodedBytes: 10, status: 200, rate: null });
    denied(w.gov.acquire('getMultipleAccounts', 'P2'), 'data-cap'); // the 2 MiB answer still counts
    w.set(t0 + 30_000);
    granted(w.gov.acquire('getMultipleAccounts', 'P2'));
    granted(w.gov.acquire('getMultipleAccounts', 'P2'));
  });

  it('the stream\'s bytes count after receipt, for 30 s', () => {
    const w = world({ dataCapBytes: 4 * MIB, dataP0ReserveBytes: MIB });
    w.gov.chargeStream(3 * MIB);
    denied(w.gov.acquire('getMultipleAccounts', 'P2'), 'data-cap');
    granted(w.gov.acquire('getMultipleAccounts', 'P0'));
    w.advance(30_000);
    granted(w.gov.acquire('getMultipleAccounts', 'P2'));
    assert.throws(() => w.gov.chargeStream(-1), TypeError);
    assert.throws(() => w.gov.chargeStream(1.5), TypeError);
  });

  it('connections: at most 6 requests in flight, the last 2 only for P0; a settle frees one', () => {
    const w = world();
    const p2 = [0, 1, 2, 3].map(() => granted(w.gov.acquire('getMultipleAccounts', 'P2')));
    denied(w.gov.acquire('getRecentPrioritizationFees', 'P2'), 'connections');
    const p0 = [0, 1].map(() => granted(w.gov.acquire('getMultipleAccounts', 'P0')));
    denied(w.gov.acquire('getSlot', 'P0'), 'connections');
    w.gov.settle(p0[0] as Ticket, OK);
    granted(w.gov.acquire('getSlot', 'P0'));
    for (const t of p2) {
      w.gov.settle(t, OK);
    }
    granted(w.gov.acquire('getRecentPrioritizationFees', 'P2')); // 2 P0 and this one in flight
  });
});

describe('what the provider says: Retry-After, 403, the header limits', () => {
  it('a 429 closes its method for its Retry-After (60 s when missing or not whole, at most 600 s), raises the shed level and alerts; other methods stay open', () => {
    for (const [after, waitMs] of [[30, 30_000], [null, 60_000], [1.5, 60_000], [-5, 60_000], [5_000, 600_000], [0, 0]] as const) {
      const w = world();
      w.gov.settle(granted(w.gov.acquire('getMultipleAccounts', 'P0')), { decodedBytes: 80, status: 429, rate: rate({ retryAfterSec: after }) });
      if (waitMs > 0) {
        assert.equal(denied(w.gov.acquire('getMultipleAccounts', 'P0'), 'retry-after'), w.now() + waitMs, `Retry-After ${after}`);
      }
      granted(w.gov.acquire('getSlot', 'P0'));
      assert.equal(w.gov.shedLevel(), 1);
      assert.deepEqual(w.codes().filter((c) => c === 'chain-429' || c === 'chain-shed-up').sort(), ['chain-429', 'chain-shed-up']);
      assert.deepEqual(w.seen.find((e) => e.code === 'chain-429'), { code: 'chain-429', provider: 'public-mainnet', method: 'getMultipleAccounts' });
      w.advance(waitMs);
      granted(w.gov.acquire('getMultipleAccounts', 'P0'));
    }
    const w = world();
    w.gov.settle(granted(w.gov.acquire('getMultipleAccounts', 'P0')), { decodedBytes: 80, status: 429, rate: null }); // no headers at all
    assert.equal(denied(w.gov.acquire('getMultipleAccounts', 'P0'), 'retry-after'), w.now() + 60_000);
  });

  it('a 403 blocks the provider for 15 minutes, P0 included; then one P0 probe: a 200 unblocks, a 403 blocks again, anything else lets another probe through', () => {
    const w = world();
    w.gov.settle(granted(w.gov.acquire('getMultipleAccounts', 'P2')), { decodedBytes: 50, status: 403, rate: null });
    const until = w.now() + 900_000;
    assert.equal(denied(w.gov.acquire('getSlot', 'P0'), 'blocked'), until);
    assert.equal(denied(w.gov.acquire('getMultipleAccounts', 'P2'), 'blocked'), until);
    assert.ok(w.codes().includes('chain-blocked') && w.codes().includes('chain-p0-denied'));
    w.set(until);
    denied(w.gov.acquire('getMultipleAccounts', 'P2'), 'blocked'); // only a P0 probe after the block
    const probe = granted(w.gov.acquire('getSlot', 'P0'));
    denied(w.gov.acquire('getSlot', 'P0'), 'blocked'); // one probe at a time
    w.gov.settle(probe, { decodedBytes: 20, status: 503, rate: null }); // neither: another probe may go
    const probe2 = granted(w.gov.acquire('getSlot', 'P0'));
    w.gov.settle(probe2, { decodedBytes: 20, status: 403, rate: null }); // blocked again
    const until2 = w.now() + 900_000;
    assert.equal(denied(w.gov.acquire('getSlot', 'P0'), 'blocked'), until2);
    w.set(until2);
    w.gov.settle(granted(w.gov.acquire('getSlot', 'P0')), OK); // a 200: unblocked
    assert.ok(w.codes().includes('chain-unblocked'));
    granted(w.gov.acquire('getMultipleAccounts', 'P2'));
    assert.equal(w.codes().filter((c) => c === 'chain-blocked').length, 2);
  });

  it('a request already in flight when the block came does not unblock it with its 200', () => {
    const w = world();
    const early = granted(w.gov.acquire('getMultipleAccounts', 'P0'));
    w.gov.settle(granted(w.gov.acquire('getSlot', 'P0')), { decodedBytes: 50, status: 403, rate: null });
    w.gov.settle(early, OK);
    denied(w.gov.acquire('getSlot', 'P0'), 'blocked');
  });

  it('header limits only lower a cap, to half the limit, never raise it, and 0 refuses the method', () => {
    const w = world();
    const learn = (limit: number): void => w.gov.settle(granted(w.gov.acquire('getMultipleAccounts', 'P0')), { decodedBytes: 80, status: 200, rate: rate({ methodLimit: limit }) });
    const cap = (): number | undefined => w.gov.usage().find((u) => u.bucket === 'getMultipleAccounts')?.cap;
    learn(30);
    assert.equal(cap(), 15);
    assert.equal(w.codes().filter((c) => c === 'chain-limit-learned').length, 1);
    learn(50); // higher: never raised
    learn(31); // not lower than the 30 already seen
    learn(40);
    assert.equal(cap(), 15);
    assert.equal(w.codes().filter((c) => c === 'chain-limit-learned').length, 1);
    w.advance(10_000);
    learn(10); // 5, and the P0 reserve (8) falls to 5 with it: P2 gets none
    assert.equal(cap(), 5);
    denied(w.gov.acquire('getMultipleAccounts', 'P2'), 'method-cap');
    w.advance(10_000);
    learn(0);
    assert.equal(denied(w.gov.acquire('getMultipleAccounts', 'P0'), 'refused-method'), Number.POSITIVE_INFINITY);
    w.advance(3_600_000);
    denied(w.gov.acquire('getMultipleAccounts', 'P0'), 'refused-method'); // for the rest of the process
    granted(w.gov.acquire('getSlot', 'P0'));
  });

  it('a remaining count at or below zero closes the method until its window empties', () => {
    for (const remaining of [0, -3]) {
      const w = world();
      const t = granted(w.gov.acquire('getMultipleAccounts', 'P0'));
      const grantedAt = w.now();
      w.advance(100);
      w.gov.settle(t, { decodedBytes: 80, status: 200, rate: rate({ methodRemaining: remaining }) });
      assert.equal(denied(w.gov.acquire('getMultipleAccounts', 'P0'), 'retry-after'), grantedAt + 10_000);
      w.set(grantedAt + 10_000);
      granted(w.gov.acquire('getMultipleAccounts', 'P0'));
    }
    const w = world();
    w.gov.settle(granted(w.gov.acquire('getMultipleAccounts', 'P0')), { decodedBytes: 80, status: 200, rate: rate({ methodRemaining: 5 }) });
    granted(w.gov.acquire('getMultipleAccounts', 'P0'));
  });
});

describe('shedding and the P0 path', () => {
  it('shed levels: 1 sheds P4, 2 sheds P3 too, 3 sheds P2 too, never P1 or P0; at most 3; down one per 5 minutes without a trigger', () => {
    const w = world();
    const too429 = (m: ReadMethod): void => w.gov.settle(granted(w.gov.acquire(m, 'P0')), { decodedBytes: 80, status: 429, rate: rate({ retryAfterSec: 1 }) });
    too429('getMultipleAccounts');
    assert.equal(w.gov.shedLevel(), 1);
    denied(w.gov.acquire('getSignaturesForAddress', 'P4'), 'shed');
    too429('getRecentPrioritizationFees');
    too429('simulateTransaction');
    assert.equal(w.gov.shedLevel(), 3);
    const lastTrigger = w.now();
    assert.equal(denied(w.gov.acquire('getSignaturesForAddress', 'P2'), 'shed'), lastTrigger + 300_000);
    w.gov.settle(granted(w.gov.acquire('getProgramAccounts', 'P1')), OK); // P1: never shed
    use(w, 'getSlot', 'P0'); // P0: never shed
    too429('getTransaction'); // a fourth: still 3, and the decay starts again
    assert.equal(w.gov.shedLevel(), 3);
    assert.equal(w.codes().filter((c) => c === 'chain-shed-up').length, 3);
    w.advance(300_000);
    assert.equal(w.gov.shedLevel(), 2);
    use(w, 'getSignaturesForAddress', 'P2');
    denied(w.gov.acquire('getSignaturesForAddress', 'P3'), 'shed');
    w.advance(300_000);
    assert.equal(w.gov.shedLevel(), 1);
    use(w, 'getSignaturesForAddress', 'P3');
    w.advance(299_999);
    assert.equal(w.gov.shedLevel(), 1);
    w.advance(1);
    assert.equal(w.gov.shedLevel(), 0);
    use(w, 'getSignaturesForAddress', 'P4');
    assert.equal(w.codes().filter((c) => c === 'chain-shed-down').length, 3);
  });

  it('a long quiet stretch takes the level down by one for every 5 minutes in it', () => {
    const w = world();
    for (const m of ['getMultipleAccounts', 'getRecentPrioritizationFees', 'simulateTransaction'] as const) {
      w.gov.settle(granted(w.gov.acquire(m, 'P0')), { decodedBytes: 80, status: 429, rate: rate({ retryAfterSec: 1 }) });
    }
    w.advance(3 * 300_000);
    assert.equal(w.gov.shedLevel(), 0, 'three steps of 5 minutes have passed');
    assert.equal(w.codes().filter((c) => c === 'chain-shed-down').length, 3);
  });

  it('a bucket over 80% for a minute raises the shed level once a minute and alerts; methods whose whole cap is P0\'s do not count', () => {
    const w = world();
    const held = [0, 1, 2, 3, 4].map((i) => granted(w.gov.acquire('getMultipleAccounts', i < 4 ? 'P2' : 'P0'))); // 5 of 6 in flight
    assert.equal(w.gov.shedLevel(), 0);
    w.advance(30_000);
    assert.equal(w.gov.shedLevel(), 0);
    w.advance(30_000);
    assert.equal(w.gov.shedLevel(), 1);
    assert.ok(w.codes().includes('chain-budget-80'));
    w.advance(30_000);
    assert.equal(w.gov.shedLevel(), 1);
    w.advance(30_000);
    assert.equal(w.gov.shedLevel(), 2);
    for (const t of held) {
      w.gov.settle(t, OK);
    }
    w.advance(60_000);
    assert.equal(w.gov.shedLevel(), 2, 'no longer busy, and no new step');
    w.advance(240_000); // 5 minutes after the last trigger
    assert.equal(w.gov.shedLevel(), 1);
    // risk A's 2 s slot polling uses 5 of getSlot's 6 (all P0) for good: never a reason to shed
    const p = world();
    for (let s = 0; s < 180; s += 2) {
      use(p, 'getSlot', 'P0');
      p.advance(2_000);
    }
    assert.equal(p.gov.shedLevel(), 0);
    assert.ok(!p.codes().includes('chain-budget-80'));
  });

  it('every P0 denial alerts, with the method and the priority', () => {
    const w = world();
    use(w, 'getSlot', 'P0', 6);
    denied(w.gov.acquire('getSlot', 'P0'), 'method-cap');
    denied(w.gov.acquire('getSlot', 'P1'), 'method-cap'); // not P0: no alert
    assert.deepEqual(w.seen.filter((e) => e.code === 'chain-p0-denied'), [{ code: 'chain-p0-denied', provider: 'public-mainnet', method: 'getSlot', priority: 'P0' }]);
    assert.ok(w.seen.every((e) => Object.isFrozen(e)));
  });
});

describe('refusals, tickets, the clock and the sink', () => {
  it('refuses getTokenLargestAccounts, any unknown method and P0 on getProgramAccounts before counting anything', () => {
    const w = world();
    assert.equal(denied(w.gov.acquire('getTokenLargestAccounts' as ReadMethod, 'P2'), 'refused-method'), Number.POSITIVE_INFINITY);
    denied(w.gov.acquire('sendTransaction' as ReadMethod, 'P0'), 'refused-method');
    denied(w.gov.acquire('getProgramAccounts', 'P0'), 'refused-method');
    assert.equal(w.gov.usage().find((u) => u.bucket === 'total')?.used, 0);
    granted(w.gov.acquire('getProgramAccounts', 'P1'));
    assert.throws(() => w.gov.acquire('getSlot', 'P5' as Priority), TypeError);
  });

  it('a second settle of a ticket, or one it never gave, alerts chain-ticket-bug and changes nothing', () => {
    const w = world();
    const t = granted(w.gov.acquire('getMultipleAccounts', 'P0'));
    w.gov.settle(t, OK);
    w.gov.settle(t, OK);
    w.gov.settle(Object.freeze({ __ticket: 'budget-ticket' }) as unknown as Ticket, OK);
    assert.equal(w.codes().filter((c) => c === 'chain-ticket-bug').length, 2);
    assert.equal(w.gov.usage().find((u) => u.bucket === 'connections')?.used, 0);
  });

  it('a settle with a byte count or a status that cannot be real is a TypeError', () => {
    const w = world();
    for (const bad of [{ decodedBytes: -1, status: 200 }, { decodedBytes: 1.5, status: 200 }, { decodedBytes: 1, status: 99 }, { decodedBytes: 1, status: 600 }, { decodedBytes: 1, status: 200.5 }]) {
      const t = granted(w.gov.acquire('getMultipleAccounts', 'P0'));
      assert.throws(() => w.gov.settle(t, { ...bad, rate: null }), TypeError, JSON.stringify(bad));
    }
  });

  it('a monotonic clock that steps back is held at its last reading, so no grant ages out early', () => {
    const w = world();
    use(w, 'getSlot', 'P0', 6);
    w.set(START + 9_000);
    w.set(START - 50_000);
    assert.equal(denied(w.gov.acquire('getSlot', 'P0'), 'method-cap'), START + 10_000);
    w.set(START + 10_000);
    granted(w.gov.acquire('getSlot', 'P0'));
  });

  it('a sink that throws never stops the governor', () => {
    const w = world(undefined, true);
    use(w, 'getSlot', 'P0', 6);
    denied(w.gov.acquire('getSlot', 'P0'), 'method-cap');
    w.gov.settle(granted(w.gov.acquire('getMultipleAccounts', 'P0')), { decodedBytes: 80, status: 429, rate: null });
    assert.equal(w.gov.shedLevel(), 1);
    assert.ok(w.seen.length >= 3);
  });

  it('usage() names every bucket with what it holds now and its cap', () => {
    const w = world();
    use(w, 'getSlot', 'P0', 2);
    const held = granted(w.gov.acquire('getMultipleAccounts', 'P2'));
    const u = new Map(w.gov.usage().map((b) => [b.bucket, b]));
    assert.deepEqual(u.get('total'), { bucket: 'total', used: 3, cap: 60 });
    assert.deepEqual(u.get('getSlot'), { bucket: 'getSlot', used: 2, cap: 6 });
    assert.deepEqual(u.get('connections'), { bucket: 'connections', used: 1, cap: 6 });
    assert.deepEqual(u.get('data'), { bucket: 'data', used: 200 + MIB, cap: 50_000_000 });
    assert.equal(u.size, 3 + 11);
    w.gov.settle(held, OK);
  });

  it('the limits can only be tightened, never loosened', () => {
    for (const bad of [{ totalCap: 61 }, { totalP0Reserve: 28 }, { dataCapBytes: 50_000_001 }, { dataP0ReserveBytes: 10_000_001 }, { totalCap: 10, totalP0Reserve: 11 }, { totalCap: -1 }, { totalCap: 1.5 }, { dataCapBytes: 1_000 }]) {
      assert.throws(() => world(bad), TypeError, JSON.stringify(bad));
    }
    world({ totalCap: 0, totalP0Reserve: 0 });
  });
});
