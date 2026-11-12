// Approval tokens (ARCHITECTURE.md s.3; RISK_POLICY.md invariants 1 and 19): an order runs only with
// a token that risk issued for exactly that plan, and only a plan that passed the re-check can be
// given one. The token carries the plan hash, mode, kind, worst-case spend, minOut and an expiry
// slot, all under an HMAC with a per-boot key that only the authority holds; it works once, in one
// mode, for one intent. The executor gets a verifier that cannot issue. verify and redeem never
// throw, whatever they are given; redeem returns the frozen validated plan. A paper authority
// never mints a live token. The single-use store and the slot source are bound when the authority is
// created, never passed by a caller (REVIEWS.md K, security findings 2 and 3), the slot only moves
// forward, and the store receives the validated snapshot. TEST_PLAN.md s.3 step 4 and s.4 invariant 1.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bps, lamports, microLamportsPerCu } from '../../../src/core/units.ts';
import {
  createApprovalAuthority,
  type ApprovalAuthority,
  type ApprovalOptions,
  type ApprovalToken,
  type RedeemSnapshot,
  type SlotSource,
  type TokenProblem,
  type TokenStore,
} from '../../../src/risk/approval.ts';
import { planHash, planMaxSpend, type OrderPlan, type PlanMode } from '../../../src/risk/plan.ts';
import { isCheckedPlan, type CheckedPlan } from '../../../src/risk/recheck.ts';
import { RiskError } from '../../../src/risk/reserve.ts';
import { FREE_FEES, checked } from './fixtures.ts';

const PLAN: OrderPlan = {
  orderId: 'order-1',
  intentId: 'intent-1',
  positionId: 'p1',
  mode: 'paper',
  kind: 'buy',
  urgency: 'normal',
  venue: 'pumpswap',
  route: 'direct',
  mint: 'MintA',
  pool: 'PoolA',
  tokenAccount: 'AtaOfMintA',
  wallet: 'OurWallet',
  inAmount: 55_000_000n,
  expectedOut: 1_000_000_000n,
  minOut: 980_000_000n,
  slippageBps: bps(200),
  feeBps: bps(125),
  feeConfigSlot: 995n,
  cuLimit: 300_000,
  cuPrice: microLamportsPerCu(200_000n),
  tip: { path: 'jito', lamports: lamports(1_000n) },
  rentLamports: lamports(1_488_440n),
  attempts: 3,
  closeAccountAfter: false,
  quoteSlot: 1_000n,
  lastValidBlockHeight: null,
};
const SELL: OrderPlan = { ...PLAN, kind: 'sell', inAmount: 400_000n, rentLamports: lamports(0n) };
const CLOSE: OrderPlan = { ...SELL, kind: 'close-account', inAmount: 0n, expectedOut: 0n, minOut: 0n, slippageBps: bps(0), attempts: 1, ...FREE_FEES };
const LIVE: OrderPlan = { ...PLAN, mode: 'live' };

const KEY = Uint8Array.from({ length: 32 }, (_v, i) => i + 1);

/** A slot source the test moves by hand (the chain stream in the bot). */
class Slots implements SlotSource {
  value: unknown = 1_005n;
  reads = 0;
  currentSlot(): bigint | null {
    this.reads += 1;
    return this.value as bigint | null;
  }
}

/** The single-use store, as T2 will be: it keeps the snapshot it was given. */
class MemoryStore implements TokenStore {
  readonly seen = new Map<string, RedeemSnapshot>();
  consume(tokenId: string, snapshot: RedeemSnapshot): boolean {
    if (this.seen.has(tokenId)) {
      return false;
    }
    this.seen.set(tokenId, snapshot);
    return true;
  }
}

interface Harness {
  readonly a: ApprovalAuthority;
  readonly slots: Slots;
  readonly store: MemoryStore;
}

function authority(options: { mode?: PlanMode; key?: Uint8Array; planFreshSlots?: number; newTokenId?: () => string; store?: TokenStore } = {}): Harness {
  let n = 0;
  const slots = new Slots();
  const store = new MemoryStore();
  const a = createApprovalAuthority({
    mode: options.mode ?? 'paper',
    key: options.key ?? KEY,
    newTokenId: options.newTokenId ?? (() => `tok-${(n += 1)}`),
    planFreshSlots: options.planFreshSlots ?? 25,
    slots,
    store: options.store ?? store,
  });
  return { a, slots, store };
}

const verify = (a: ApprovalAuthority, token: unknown, plan: unknown = PLAN): readonly TokenProblem[] => a.verifier.verify(token as ApprovalToken, plan as OrderPlan);
const issue = (a: ApprovalAuthority, plan: OrderPlan = PLAN): ApprovalToken => a.issuer.issue(checked(plan));

describe('issuing a token', () => {
  it('binds the plan hash, mode, kind, worst-case spend, minOut and an expiry 25 slots after the quote', () => {
    const t = issue(authority().a);
    assert.equal(t.id, 'tok-1');
    assert.equal(t.intentId, 'intent-1');
    assert.equal(t.mode, 'paper');
    assert.equal(t.kind, 'buy');
    assert.equal(t.reduceOnly, false);
    assert.equal(t.positionId, 'p1');
    assert.equal(t.planHash, planHash(PLAN));
    assert.equal(t.maxSpendLamports, planMaxSpend(PLAN));
    assert.equal(t.maxSpendLamports, 56_686_440n);
    assert.equal(t.minOut, 980_000_000n);
    assert.equal(t.expiresAtSlot, 1_025n);
    assert.match(t.mac, /^[0-9a-f]{64}$/);
    assert.ok(Object.isFrozen(t));
  });

  it('a sell or a close is reduce-only; a buy never is', () => {
    const { a } = authority();
    assert.equal(issue(a, SELL).reduceOnly, true);
    assert.equal(issue(a, CLOSE).reduceOnly, true);
    assert.equal(issue(a, PLAN).reduceOnly, false);
  });

  it('every token is different: a fresh id and so a fresh MAC, even for the same plan checked twice', () => {
    const { a } = authority();
    const [one, two] = [a.issuer.issue(checked(PLAN)), a.issuer.issue(checked(PLAN))];
    assert.notEqual(one.id, two.id);
    assert.notEqual(one.mac, two.mac);
  });

  it('one re-check, at most one token: issuing spends it, a refused issue does not', () => {
    const ids = ['bad id', 'tok-a', 'tok-b'];
    const { a, slots } = authority({ newTokenId: () => ids.shift() ?? 'x' });
    const plan = checked(PLAN);
    slots.value = 999n;
    assert.throws(() => a.issuer.issue(plan), /future/); // refused before anything was spent
    slots.value = 1_005n;
    assert.throws(() => a.issuer.issue(plan), /plain id/); // 'bad id' is refused too
    assert.equal(isCheckedPlan(plan), true);
    assert.equal(a.issuer.issue(plan).id, 'tok-a');
    assert.equal(isCheckedPlan(plan), false);
    assert.throws(() => a.issuer.issue(plan), /re-check/); // the same snapshot cannot get a second token
    assert.equal(a.issuer.issue(checked(PLAN)).id, 'tok-b'); // a new re-check against fresh inputs can
  });

  it('even if newTokenId comes back into issue with the same plan, only one token comes out', () => {
    let calls = 0;
    let inner = undefined as ApprovalToken | undefined;
    const plan = checked(PLAN);
    const slots = new Slots();
    const a: ApprovalAuthority = createApprovalAuthority({
      mode: 'paper',
      key: KEY,
      planFreshSlots: 25,
      slots,
      store: new MemoryStore(),
      newTokenId: () => {
        calls += 1;
        if (calls === 1) {
          inner = a.issuer.issue(plan); // the callback tries to issue the same plan
          return 'outer';
        }
        return 'inner';
      },
    });
    assert.throws(() => a.issuer.issue(plan), /already has a token/); // the outer call loses
    assert.equal(calls, 2);
    assert.equal(inner?.id, 'inner'); // the one token there is
    assert.deepEqual(verify(a, inner), []);
  });

  it('only a plan that passed the re-check can be issued a token (REVIEWS.md G)', () => {
    const { a } = authority();
    assert.throws(() => a.issuer.issue(PLAN as CheckedPlan), /re-check/); // never checked
    assert.throws(() => a.issuer.issue({ ...checked(PLAN) } as CheckedPlan), /re-check/); // a copy is not the snapshot
    assert.throws(() => a.issuer.issue({ ...PLAN, kind: 'withdraw' } as CheckedPlan), /re-check/); // a withdraw never passes
    assert.throws(() => a.issuer.issue(null as unknown as CheckedPlan), /re-check/);
  });

  it('a paper authority never mints a live token, and the reverse', () => {
    assert.throws(() => authority({ mode: 'paper' }).a.issuer.issue(checked(LIVE)), /own mode/);
    assert.throws(() => authority({ mode: 'live' }).a.issuer.issue(checked(PLAN)), /own mode/);
    assert.equal(authority({ mode: 'live' }).a.issuer.issue(checked(LIVE)).mode, 'live');
  });

  it('refuses a plan from the future and an expired plan, by the bound slot', () => {
    const { a, slots } = authority();
    const plan = checked(PLAN);
    slots.value = 999n;
    assert.throws(() => a.issuer.issue(plan), /future/);
    slots.value = 1_025n;
    assert.equal(a.issuer.issue(plan).expiresAtSlot, 1_025n); // the last slot it is still valid
    slots.value = 1_026n;
    assert.throws(() => a.issuer.issue(checked(PLAN)), /expired/);
  });

  it('refuses a token id that is not a plain id or was already used', () => {
    const ids = ['ok-1', 'ok-1', 'has space', ''];
    const { a } = authority({ newTokenId: () => ids.shift() ?? 'x' });
    assert.equal(a.issuer.issue(checked(PLAN)).id, 'ok-1');
    assert.throws(() => a.issuer.issue(checked(PLAN)), /already/);
    assert.throws(() => a.issuer.issue(checked(PLAN)), /plain id/);
    assert.throws(() => a.issuer.issue(checked(PLAN)), /plain id/);
  });

  it('remembers only the newest ids, so memory stays bounded', () => {
    const ids = ['dup'];
    let n = 0;
    const { a } = authority({ newTokenId: () => ids.shift() ?? `t-${(n += 1)}` });
    a.issuer.issue(checked(PLAN)); // 'dup'
    assert.throws(() => (ids.push('dup'), a.issuer.issue(checked(PLAN))), /already/);
    for (let i = 0; i < 10_000; i += 1) {
      a.issuer.issue(checked(PLAN));
    }
    ids.push('dup');
    assert.equal(a.issuer.issue(checked(PLAN)).id, 'dup'); // forgotten after 10,000 newer ids
  });
});

describe('the slot comes from the bound source, never from a caller (REVIEWS.md K, security finding 3)', () => {
  it('issue, verify and redeem take no slot at all; a slot passed anyway changes nothing', () => {
    const { a, slots } = authority();
    assert.equal(a.issuer.issue.length, 1);
    assert.equal(a.verifier.verify.length, 2);
    assert.equal(a.verifier.redeem.length, 2);
    const t = issue(a);
    slots.value = 1_026n; // expired by the source
    // the K reproduction: an executor passing `currentSlot: 0n` makes an expired token look fresh
    const verifyWithSlot = a.verifier.verify as unknown as (...args: unknown[]) => readonly TokenProblem[];
    assert.deepEqual(verifyWithSlot(t, PLAN, { currentSlot: 0n, mode: 'paper' }), ['expired']);
    assert.deepEqual(verify(a, t), ['expired']);
  });

  it('an unknown slot refuses everything: null, a throw, not a bigint, negative, past u64', () => {
    for (const value of [null, undefined, 5, -1n, 2n ** 64n, '1005', { slot: 1_005n }]) {
      const { a, slots } = authority();
      const t = issue(a);
      slots.value = value;
      assert.throws(() => a.issuer.issue(checked(PLAN)), /slot is unknown/, String(value));
      assert.deepEqual(verify(a, t), ['slot-unknown'], String(value));
      assert.deepEqual(a.verifier.redeem(t, PLAN), { ok: false, problems: ['slot-unknown'] });
    }
    const throwing = new Slots();
    throwing.currentSlot = (): bigint | null => {
      throw new Error('RPC down');
    };
    const a = createApprovalAuthority({ mode: 'paper', key: KEY, newTokenId: () => 'x', planFreshSlots: 25, slots: throwing, store: new MemoryStore() });
    assert.throws(() => a.issuer.issue(checked(PLAN)), /slot is unknown/);
  });

  it('a source that worked and then breaks is unknown, never its last good slot', () => {
    let broken = false;
    const flaky: SlotSource = {
      currentSlot: (): bigint | null => {
        if (broken) {
          throw new Error('stream lost');
        }
        return 1_005n;
      },
    };
    let n = 0;
    const a = createApprovalAuthority({ mode: 'paper', key: KEY, newTokenId: () => `t-${(n += 1)}`, planFreshSlots: 25, slots: flaky, store: new MemoryStore() });
    const t = issue(a);
    broken = true;
    assert.deepEqual(verify(a, t), ['slot-unknown']);
    assert.deepEqual(a.verifier.redeem(t, PLAN), { ok: false, problems: ['slot-unknown'] });
    assert.throws(() => a.issuer.issue(checked(PLAN)), /slot is unknown/);
    broken = false;
    assert.deepEqual(verify(a, t), []); // back once the source answers again
  });

  it('a source that goes backwards never revives an expired token: the slot only moves forward', () => {
    const { a, slots } = authority();
    const t = issue(a);
    slots.value = 1_026n;
    assert.deepEqual(verify(a, t), ['expired']);
    slots.value = 1_000n; // the stream lagged, or someone set it back
    assert.deepEqual(verify(a, t), ['expired']);
    assert.deepEqual(a.verifier.redeem(t, PLAN), { ok: false, problems: ['expired'] });
    assert.throws(() => a.issuer.issue(checked(PLAN)), /expired/); // nor can a new token be issued against the old slot
  });

  it('one reading above any storable slot (a parse bug, a lying RPC) is unknown and never sticks in the ratchet (REVIEWS.md N)', () => {
    const { a, slots } = authority();
    const t = issue(a);
    for (const wild of [2n ** 64n - 1n, 2n ** 63n]) {
      slots.value = wild;
      assert.deepEqual(verify(a, t), ['slot-unknown'], String(wild));
    }
    slots.value = 1_006n; // the next sane reading: tokens work again, exits included
    assert.deepEqual(verify(a, t), []);
    assert.ok(a.verifier.redeem(t, PLAN).ok);
    assert.equal(issue(a, SELL).expiresAtSlot, 1_025n);
    // the bound itself is adopted: anything up to it is app/slots.ts's to judge against time and a second provider
    slots.value = 2n ** 63n - 1n;
    assert.deepEqual(verify(a, t), ['expired']);
  });

  it('the source is read once at creation: replacing its method later changes nothing', () => {
    const { a, slots } = authority();
    const t = issue(a);
    slots.currentSlot = (): bigint => 0n; // the method swapped on the object the authority was given
    slots.value = 1_026n;
    const before = slots.reads;
    assert.deepEqual(verify(a, t), ['expired']); // still the original method, reading 1,026
    assert.equal(slots.reads, before + 1);
  });
});

describe('verifying: a valid token', () => {
  it('passes for the plan it was issued for, in its mode, until its expiry slot', () => {
    const { a, slots } = authority();
    const t = issue(a);
    assert.deepEqual(verify(a, t), []);
    assert.deepEqual(verify(a, issue(a, SELL), SELL), []);
    assert.deepEqual(verify(a, issue(a, CLOSE), CLOSE), []);
    slots.value = 1_025n;
    assert.deepEqual(verify(a, t), []);
  });

  it('the verifier cannot issue, holds no key, and says which mode it serves', () => {
    const { a } = authority({ mode: 'live' });
    assert.equal('issue' in a.verifier, false);
    assert.equal(Object.keys(a.verifier).includes('key'), false);
    assert.equal(a.verifier.mode, 'live');
    assert.ok(Object.isFrozen(a.verifier) && Object.isFrozen(a.issuer));
  });

  it("the executor's redeemer can only redeem: no verify that skips single use, no issue (REVIEWS.md N, security finding 2)", () => {
    const { a } = authority();
    assert.deepEqual(Object.keys(a.redeemer).sort(), ['mode', 'redeem']);
    assert.equal(a.redeemer.mode, 'paper');
    assert.ok(Object.isFrozen(a.redeemer));
    const t = issue(a);
    assert.ok(a.redeemer.redeem(t, PLAN).ok);
    // the same bound store: a second use is refused whichever capability tries it
    assert.deepEqual(a.redeemer.redeem(t, PLAN), { ok: false, problems: ['already-consumed'] });
    assert.deepEqual(a.verifier.redeem(t, PLAN), { ok: false, problems: ['already-consumed'] });
  });
});

describe('verifying: a forged or tampered token', () => {
  const { a } = authority();
  const token = issue(a);

  it('any changed token field breaks the MAC', () => {
    const changed: Record<string, unknown> = {
      id: 'tok-2',
      intentId: 'intent-2',
      mode: 'live',
      kind: 'sell',
      reduceOnly: true,
      positionId: 'p2',
      planHash: 'f'.repeat(64),
      maxSpendLamports: token.maxSpendLamports + 1n,
      minOut: token.minOut + 1n,
      expiresAtSlot: token.expiresAtSlot + 1n,
      mac: `${token.mac[0] === '0' ? '1' : '0'}${token.mac.slice(1)}`,
    };
    for (const [field, value] of Object.entries(changed)) {
      assert.deepEqual(verify(a, { ...token, [field]: value }), ['bad-mac'], field);
    }
  });

  it('a token made with another key is refused, even a perfect copy of the fields', () => {
    const other = authority({ key: Uint8Array.from({ length: 32 }, (_v, i) => 200 - i) }).a;
    assert.deepEqual(verify(a, issue(other)), ['bad-mac']);
  });

  it('a token cannot be reused for another plan, intent or position', () => {
    assert.deepEqual(verify(a, token, { ...PLAN, wallet: 'Attacker' }), ['plan-hash-mismatch']);
    assert.deepEqual(verify(a, token, { ...PLAN, minOut: 0n }), ['plan-hash-mismatch', 'min-out-mismatch']);
    assert.deepEqual(verify(a, token, { ...PLAN, inAmount: 1n }), ['plan-hash-mismatch', 'max-spend-mismatch']);
    assert.ok(verify(a, token, { ...PLAN, intentId: 'intent-2' }).includes('wrong-intent'));
    assert.ok(verify(a, token, { ...PLAN, positionId: 'p2' }).includes('wrong-position'));
    const sell = verify(a, token, SELL);
    for (const problem of ['plan-hash-mismatch', 'wrong-kind', 'wrong-reduce-only'] as const) {
      assert.ok(sell.includes(problem), problem);
    }
  });

  it('a withdraw has its own path: this verifier refuses one whatever the token says', () => {
    assert.ok(verify(a, token, { ...PLAN, kind: 'withdraw' }).includes('kind-not-allowed'));
  });

  it('a token never works at an authority of the other mode, even with the same key', () => {
    const live = authority({ mode: 'live' }).a;
    const liveToken = issue(live, LIVE);
    assert.deepEqual(verify(a, liveToken, LIVE), ['wrong-mode']); // a live token at a paper authority
    assert.deepEqual(verify(live, token, PLAN), ['wrong-mode']); // a paper token at a live one
    assert.deepEqual(verify(live, liveToken, LIVE), []);
  });
});

describe('verifying: expiry', () => {
  it('valid through its expiry slot, refused after', () => {
    const { a, slots } = authority();
    const t = issue(a);
    slots.value = 1_025n;
    assert.deepEqual(verify(a, t), []);
    slots.value = 1_026n;
    assert.deepEqual(verify(a, t), ['expired']);
  });

  it('an expiry later than the quote allows is refused (a verifier with a tighter window)', () => {
    const issued = issue(authority().a); // expires 1,025
    assert.deepEqual(verify(authority({ planFreshSlots: 10 }).a, issued), ['expiry-too-late']);
  });
});

describe('single use, in the bound store (REVIEWS.md K, security finding 2)', () => {
  it('redeem verifies, consumes, and hands back the frozen validated plan; a second use is refused', () => {
    const { a, store } = authority();
    const t = issue(a);
    const first = a.verifier.redeem(t, PLAN);
    assert.ok(first.ok);
    assert.deepEqual({ ...first.plan }, { ...PLAN });
    assert.ok(Object.isFrozen(first.plan));
    assert.deepEqual(a.verifier.redeem(t, PLAN), { ok: false, problems: ['already-consumed'] });
    assert.deepEqual([...store.seen.keys()], ['tok-1']);
  });

  it('the store gets the validated snapshot: the token as verified, the slot it was judged at, the frozen plan', () => {
    const { a, store, slots } = authority();
    const t = issue(a);
    slots.value = 1_010n;
    const mine = { ...PLAN };
    assert.ok(a.verifier.redeem(t, mine).ok);
    const snapshot = store.seen.get('tok-1')!;
    assert.deepEqual({ ...snapshot, plan: { ...snapshot.plan } }, {
      intentId: 'intent-1',
      positionId: 'p1',
      mode: 'paper',
      kind: 'buy',
      reduceOnly: false,
      planHash: planHash(PLAN),
      maxSpendLamports: 56_686_440n,
      minOut: 980_000_000n,
      expiresAtSlot: 1_025n,
      slot: 1_010n,
      plan: { ...PLAN },
    });
    assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.plan));
    assert.notEqual(snapshot.plan, mine); // never the executor's own object
    (mine as { wallet: string }).wallet = 'Attacker';
    assert.equal(snapshot.plan.wallet, 'OurWallet');
  });

  it('an executor cannot bring its own store: redeem has no place for one, and one passed anyway is ignored', () => {
    const { a } = authority();
    const t = issue(a);
    assert.ok(a.verifier.redeem(t, PLAN).ok);
    // the K reproduction: `{ consume: () => true }` would have given unlimited reuse
    const redeemWithStore = a.verifier.redeem as unknown as (...args: unknown[]) => unknown;
    assert.deepEqual(redeemWithStore(t, PLAN, { currentSlot: 1_005n, mode: 'paper' }, { consume: () => true }), { ok: false, problems: ['already-consumed'] });
  });

  it('the store is read once at creation: replacing its method later changes nothing', () => {
    const { a, store } = authority();
    const t = issue(a);
    assert.ok(a.verifier.redeem(t, PLAN).ok);
    store.consume = (): boolean => true;
    assert.deepEqual(a.verifier.redeem(t, PLAN), { ok: false, problems: ['already-consumed'] });
  });

  it('the plan the executor builds from cannot change after redeem (REVIEWS.md H, M2)', () => {
    const { a } = authority();
    const mine = { ...PLAN };
    const result = a.verifier.redeem(issue(a), mine);
    (mine as { wallet: string }).wallet = 'Attacker';
    assert.ok(result.ok && result.plan.wallet === 'OurWallet');
  });

  it('a token that fails verification is not consumed', () => {
    const { a, store } = authority();
    const t = issue(a);
    assert.deepEqual(a.verifier.redeem(t, { ...PLAN, wallet: 'Attacker' }), { ok: false, problems: ['plan-hash-mismatch'] });
    assert.equal(store.seen.size, 0);
    assert.ok(a.verifier.redeem(t, PLAN).ok); // still good for the right plan
  });

  it('only an explicit true from the store approves: an async or truthy result is refused (REVIEWS.md H, H1)', () => {
    for (const answer of [Promise.resolve(false), Promise.resolve(true), 1, 'yes', {}, undefined, null, 0]) {
      const { a } = authority({ store: { consume: () => answer as boolean } });
      assert.deepEqual(a.verifier.redeem(issue(a), PLAN), { ok: false, problems: ['store-error'] }, String(answer));
    }
    const no = authority({ store: { consume: () => false } }).a;
    assert.deepEqual(no.verifier.redeem(issue(no), PLAN), { ok: false, problems: ['already-consumed'] });
    const yes = authority({ store: { consume: () => true } }).a;
    assert.ok(yes.verifier.redeem(issue(yes), PLAN).ok);
  });

  it('a store that fails means no guarantee of single use: refused, never approved', () => {
    const broken: TokenStore = {
      consume(): boolean {
        throw new Error('disk full');
      },
    };
    const { a } = authority({ store: broken });
    assert.deepEqual(a.verifier.redeem(issue(a), PLAN), { ok: false, problems: ['store-error'] });
  });
});

describe('verify never throws', () => {
  const { a } = authority();
  const token = issue(a);
  const boom = (): never => {
    throw new Error('boom');
  };

  it('a malformed token is refused as malformed', () => {
    const bad: unknown[] = [null, undefined, 7, 'token', [], {}, { ...token, extra: 1 }, { ...token, mac: 'short' }, { ...token, mac: token.mac.toUpperCase() },
      { ...token, id: 'a b' }, { ...token, mode: 'off' }, { ...token, kind: 'swap' }, { ...token, reduceOnly: 'yes' }, { ...token, planHash: 'zz' },
      { ...token, maxSpendLamports: 5 }, { ...token, minOut: -1n }, { ...token, expiresAtSlot: 2n ** 64n }, { ...token, id: undefined }];
    for (const t of bad) {
      assert.deepEqual(verify(a, t), ['malformed-token'], JSON.stringify(t, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v)));
    }
    assert.deepEqual(verify(a, { ...token, [Symbol('x')]: 1 }), ['malformed-token']);
  });

  it('a hostile token (a throwing getter or a Proxy with throwing traps) is refused, not thrown (REVIEWS.md H, M1)', () => {
    const getter = Object.defineProperty({ ...token }, 'id', { get: boom, enumerable: true });
    const proxy = new Proxy({}, { ownKeys: boom, getOwnPropertyDescriptor: boom, get: boom, has: boom });
    assert.deepEqual(verify(a, getter), ['malformed-token']);
    assert.deepEqual(verify(a, proxy), ['malformed-token']);
    assert.deepEqual(a.verifier.redeem(getter as unknown as ApprovalToken, PLAN), { ok: false, problems: ['malformed-token'] });
  });

  it('a malformed or hostile plan is refused as such', () => {
    assert.deepEqual(verify(a, token, null), ['malformed-plan']);
    assert.deepEqual(verify(a, token, { ...PLAN, attempts: 0 }), ['malformed-plan']);
    assert.deepEqual(verify(a, token, Object.defineProperty({ ...PLAN }, 'wallet', { get: boom, enumerable: true })), ['malformed-plan']);
  });

  it('a plan whose worst-case spend overflows is refused, not thrown', () => {
    const huge = { ...PLAN, inAmount: 2n ** 64n - 1n }; // plus the rent and fees it cannot be represented
    const problems = verify(a, token, huge);
    assert.ok(problems.includes('plan-hash-mismatch') && problems.includes('max-spend-mismatch'));
  });

  it('redeem never throws either', () => {
    const { a: fresh, store } = authority();
    assert.deepEqual(fresh.verifier.redeem(null as unknown as ApprovalToken, PLAN), { ok: false, problems: ['malformed-token'] });
    assert.equal(store.seen.size, 0);
  });
});

describe('creating the authority', () => {
  const make = (patch: Record<string, unknown>) =>
    createApprovalAuthority({ mode: 'paper', key: KEY, newTokenId: () => 'x', planFreshSlots: 25, slots: new Slots(), store: new MemoryStore(), ...patch } as ApprovalOptions);

  it('needs a mode and a real key: at least 32 bytes, not all zero, a Uint8Array', () => {
    assert.throws(() => make({ mode: 'demo' }), RiskError);
    assert.throws(() => make({ mode: undefined }), RiskError);
    assert.throws(() => make({ key: new Uint8Array(31).fill(7) }), RiskError);
    assert.throws(() => make({ key: new Uint8Array(32) }), RiskError);
    assert.throws(() => make({ key: 'a'.repeat(32) }), RiskError);
    assert.throws(() => make({ key: null }), RiskError);
    assert.throws(() => make({ planFreshSlots: 0 }), RiskError);
    assert.throws(() => make({ planFreshSlots: 26 }), RiskError);
    assert.throws(() => make({ newTokenId: 'not a function' }), RiskError);
    assert.doesNotThrow(() => make({ key: new Uint8Array(32).fill(1) }));
    assert.doesNotThrow(() => make({ key: new Uint8Array(64).fill(9), mode: 'live' }));
  });

  it('needs a slot source and a store, each with its method (a getter that throws counts as none)', () => {
    const throwingGetter = Object.defineProperty({}, 'consume', {
      get: () => {
        throw new Error('boom');
      },
    });
    for (const patch of [{ slots: undefined }, { slots: null }, { slots: {} }, { slots: { currentSlot: 1_005n } }, { store: undefined }, { store: {} }, { store: { consume: true } }, { store: throwingGetter }]) {
      assert.throws(() => make(patch), RiskError, JSON.stringify(patch, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v)));
    }
  });

  it('validates the COPY of the key: a subclass cannot show the check one thing and the MAC another (REVIEWS.md H)', () => {
    class ShortKey extends Uint8Array {
      override [Symbol.iterator](): ArrayIterator<number> {
        return [1, 2, 3][Symbol.iterator]();
      }
    }
    const evil = new ShortKey(64).fill(7); // 64 bytes to a length check, 3 bytes to anything that reads it
    assert.throws(() => make({ key: evil }), RiskError);
  });

  it("keeps its own copy of the key: wiping the caller's array does not break or weaken it", () => {
    const mine = Uint8Array.from(KEY);
    let n = 0;
    const a = make({ key: mine, newTokenId: () => `t-${(n += 1)}` });
    const before = issue(a);
    mine.fill(0);
    assert.deepEqual(verify(a, before), []);
    assert.deepEqual(verify(a, issue(a)), []);
  });
});
