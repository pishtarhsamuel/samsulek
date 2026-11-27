// The budget governor against random load (docs/CHAIN_DESIGN.md s.13, step 7b; review Y, risk 6):
// random acquires and settles of every method and priority, random statuses and header values, random
// stream charges (up to 60 MB at once), random clock steps. A settle may report up to one chunk (64 KiB)
// more than the method's cap: the transport stops at the first chunk past it. After every grant: no 10 s
// window holds more grants of a method than its cap then, nor more in all than the total cap; the data a
// grant saw, its own reservation included, is within its limit (for non-P0 the cap minus P0's reserve;
// for P0 the cap, with the shared part counted at most its share); never more than 6 requests in flight.
// P0 is never shed; when P0 is refused for a full window the window holds at least the P0 reserve of P0
// grants; and when P0 is refused for data, P0's own bytes are what fill its reserve: no other priority
// and no stream flood ate it (review Y, risk 1).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { createBudgetGovernor, type Ticket } from '../../../src/chain/budget.ts';
import { METHOD_TABLE, type Priority, type ReadMethod } from '../../../src/chain/limits.ts';

const METHODS = [...(Object.keys(METHOD_TABLE) as ReadMethod[]), 'getTokenLargestAccounts' as ReadMethod];
const PRIORITIES: readonly Priority[] = ['P0', 'P1', 'P2', 'P3', 'P4'];

const CHUNK = 65_536;

type Op =
  | { readonly kind: 'acquire'; readonly method: ReadMethod; readonly p: Priority }
  | { readonly kind: 'stream'; readonly bytes: number }
  | { readonly kind: 'settle'; readonly pick: number; readonly share: number; readonly status: number | null; readonly limit: number | null; readonly remaining: number | null; readonly after: number | null }
  | { readonly kind: 'advance'; readonly ms: number };

const opArb = (learning: boolean): fc.Arbitrary<Op> =>
  fc.oneof(
    { weight: 6, arbitrary: fc.record({ kind: fc.constant('acquire' as const), method: fc.constantFrom(...METHODS), p: fc.constantFrom(...PRIORITIES) }) },
    {
      weight: 4,
      arbitrary: fc.record({
        kind: fc.constant('settle' as const),
        pick: fc.nat({ max: 20 }),
        share: fc.double({ min: 0, max: 1.0625, noNaN: true }), // up to one chunk past a 1 MiB cap
        status: fc.constantFrom(200, 200, 200, 200, 429, 403, 503, null),
        limit: learning ? fc.option(fc.nat({ max: 120 }), { nil: null }) : fc.constant(null),
        remaining: fc.option(fc.integer({ min: -2, max: 30 }), { nil: null }),
        after: fc.option(fc.nat({ max: 900 }), { nil: null }),
      }),
    },
    { weight: 3, arbitrary: fc.record({ kind: fc.constant('advance' as const), ms: fc.oneof(fc.nat({ max: 600 }), fc.nat({ max: 12_000 }), fc.constantFrom(300_000, 900_000)) }) },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant('stream' as const), bytes: fc.oneof(fc.nat({ max: 20_000 }), fc.nat({ max: 5_000_000 }), fc.constantFrom(40_000_000, 60_000_000)) }) },
  );

const tightenArb = fc.oneof(
  fc.constant(undefined),
  fc.record({ totalCap: fc.constant(20), totalP0Reserve: fc.constant(8), dataCapBytes: fc.constant(4 * 1024 * 1024), dataP0ReserveBytes: fc.constant(1024 * 1024) }),
);

interface Run {
  readonly windowHolds: (method: ReadMethod | null, p: Priority | null, now: number) => number;
}

/** Runs the ops and checks the invariants after every grant and every P0 refusal. */
function check(ops: readonly Op[], tighten: Parameters<typeof createBudgetGovernor>[0]['tighten'], learning: boolean): void {
  let now = 5_000_000;
  const gov = createBudgetGovernor({ provider: 'public-mainnet', mono: { nowMs: () => now }, events: { event: () => undefined }, ...(tighten === undefined ? {} : { tighten }) });
  const totalCap = tighten?.totalCap ?? 60;
  const totalReserve = tighten?.totalP0Reserve ?? 27;
  const dataCap = tighten?.dataCapBytes ?? 50_000_000;
  const dataReserve = tighten?.dataP0ReserveBytes ?? 10_000_000;
  const sharedLimit = dataCap - dataReserve;
  const grants: { readonly method: ReadMethod; readonly p: Priority; readonly at: number }[] = [];
  /** Settled and streamed bytes: P0's own or the shared part's. */
  const settled: { readonly at: number; readonly bytes: number; readonly p0: boolean }[] = [];
  const open: { readonly ticket: Ticket; readonly method: ReadMethod; readonly p0: boolean }[] = [];
  const parts = (t: number): { p0: number; shared: number } => {
    const inWindow = settled.filter((x) => x.at > t - 30_000);
    const sum = (p0: boolean): number =>
      inWindow.filter((x) => x.p0 === p0).reduce((n, x) => n + x.bytes, 0) + open.filter((x) => x.p0 === p0).reduce((n, x) => n + METHOD_TABLE[x.method].maxResponseBytes, 0);
    return { p0: sum(true), shared: sum(false) };
  };
  const run: Run = {
    windowHolds: (method, p, t) => grants.filter((g) => g.at > t - 10_000 && (method === null || g.method === method) && (p === null || g.p === p)).length,
  };
  for (const op of ops) {
    if (op.kind === 'advance') {
      now += op.ms;
      continue;
    }
    if (op.kind === 'stream') {
      const over = gov.chargeStream(op.bytes);
      settled.push({ at: now, bytes: op.bytes, p0: false });
      assert.equal(over, parts(now).shared > sharedLimit, 'over its share exactly when the shared part is');
      continue;
    }
    if (op.kind === 'settle') {
      const i = open.length === 0 ? -1 : op.pick % open.length;
      const o = open[i];
      if (o === undefined) {
        continue;
      }
      open.splice(i, 1);
      const cap = METHOD_TABLE[o.method].maxResponseBytes;
      const bytes = Math.min(Math.floor(op.share * cap), cap + CHUNK); // at most one chunk past the cap
      gov.settle(o.ticket, { decodedBytes: bytes, status: op.status, rate: { methodLimit: op.limit, methodRemaining: op.remaining, retryAfterSec: op.after } });
      settled.push({ at: now, bytes, p0: o.p0 });
      continue;
    }
    const before = parts(now);
    const g = gov.acquire(op.method, op.p);
    if (g.ok) {
      grants.push({ method: op.method, p: op.p, at: now });
      open.push({ ticket: g.ticket, method: op.method, p0: op.p === 'P0' });
      const usage = new Map(gov.usage().map((u) => [u.bucket, u]));
      assert.ok(run.windowHolds(op.method, null, now) <= (usage.get(op.method)?.cap ?? -1), `${op.method}: over its cap`);
      assert.ok(run.windowHolds(null, null, now) <= totalCap, 'over the total cap');
      assert.ok(open.length <= 6, 'more than 6 in flight');
      const need = Object.hasOwn(METHOD_TABLE, op.method) ? METHOD_TABLE[op.method].maxResponseBytes : 0;
      const seen = op.p === 'P0' ? before.p0 + Math.min(before.shared, sharedLimit) : before.p0 + before.shared;
      assert.ok(seen + need <= (op.p === 'P0' ? dataCap : sharedLimit), `data over its limit for ${op.p}: ${seen} + ${need}`);
      continue;
    }
    if (op.p === 'P0') {
      assert.notEqual(g.reason, 'shed', 'P0 is never shed');
      if (g.reason === 'data-cap') {
        // nothing but P0's own bytes can fill P0's reserve: the shared part counts at most its share
        assert.ok(before.p0 + METHOD_TABLE[op.method].maxResponseBytes > dataReserve, `P0 refused for data while its reserve was not its own: ${before.p0}`);
      }
      // without learning the reserves never move, so a full window must hold the P0 reserve in P0 grants
      if (!learning && g.reason === 'method-cap') {
        assert.ok(run.windowHolds(op.method, 'P0', now) >= METHOD_TABLE[op.method].p0Reserve, `${op.method}: others ate the P0 reserve`);
      }
      if (!learning && g.reason === 'total-cap') {
        assert.ok(run.windowHolds(null, 'P0', now) >= totalReserve, 'others ate the total P0 reserve');
      }
    }
  }
}

describe('the budget governor under random load', () => {
  it('with learning: no window over its cap, the data and connection caps held, P0 never shed', () => {
    fc.assert(fc.property(fc.array(opArb(true), { minLength: 20, maxLength: 250 }), tightenArb, (ops, tighten) => check(ops, tighten, true)), { numRuns: 1_000 });
  });

  it('without learning: the same, and a P0 refused for a full window had its whole reserve', () => {
    fc.assert(fc.property(fc.array(opArb(false), { minLength: 20, maxLength: 250 }), tightenArb, (ops, tighten) => check(ops, tighten, false)), { numRuns: 1_000 });
  });
});
