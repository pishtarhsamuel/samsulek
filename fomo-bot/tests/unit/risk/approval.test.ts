// Approval tokens (ARCHITECTURE.md s.3; RISK_POLICY.md invariants 1 and 19): an order runs only with
// a token that risk issued for exactly that plan, and only a plan that passed the re-check can be
// given one. The token carries the plan hash, mode, kind, worst-case spend, minOut and an expiry
// slot, all under an HMAC with a per-boot key that only the authority holds; it works once, in one
// mode, for one intent. The executor gets a verifier that cannot issue. verify and redeem never
// throw, whatever they are given; redeem returns the frozen validated plan. A paper authority
// never mints a live token. TEST_PLAN.md s.3 step 4 and s.4 invariant 1.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bps, lamports, microLamportsPerCu } from '../../../src/core/units.ts';
import {
  createApprovalAuthority,
  type ApprovalAuthority,
  type ApprovalToken,
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
const NOW = { currentSlot: 1_005n, mode: 'paper' as const };

function authority(options: { mode?: PlanMode; key?: Uint8Array; planFreshSlots?: number } = {}): ApprovalAuthority {
  let n = 0;
  return createApprovalAuthority({
    mode: options.mode ?? 'paper',
    key: options.key ?? KEY,
    newTokenId: () => `tok-${(n += 1)}`,
    planFreshSlots: options.planFreshSlots ?? 25,
  });
}

class MemoryStore implements TokenStore {
  readonly seen = new Set<string>();
  consume(tokenId: string): boolean {
    if (this.seen.has(tokenId)) {
      return false;
    }
    this.seen.add(tokenId);
    return true;
  }
}

const storeReturning = (value: unknown): TokenStore => ({ consume: () => value as boolean });
const verify = (a: ApprovalAuthority, token: unknown, plan: unknown = PLAN, context: unknown = NOW): readonly TokenProblem[] =>
  a.verifier.verify(token as ApprovalToken, plan as OrderPlan, context as typeof NOW);
const issue = (a: ApprovalAuthority, plan: OrderPlan = PLAN, slot = 1_005n): ApprovalToken => a.issuer.issue(checked(plan), slot);

describe('issuing a token', () => {
  it('binds the plan hash, mode, kind, worst-case spend, minOut and an expiry 25 slots after the quote', () => {
    const t = issue(authority());
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
    const a = authority();
    assert.equal(issue(a, SELL).reduceOnly, true);
    assert.equal(issue(a, CLOSE).reduceOnly, true);
    assert.equal(issue(a, PLAN).reduceOnly, false);
  });

  it('every token is different: a fresh id and so a fresh MAC, even for the same plan checked twice', () => {
    const a = authority();
    const [one, two] = [a.issuer.issue(checked(PLAN), 1_005n), a.issuer.issue(checked(PLAN), 1_005n)];
    assert.notEqual(one.id, two.id);
    assert.notEqual(one.mac, two.mac);
  });

  it('one re-check, at most one token: issuing spends it, a refused issue does not', () => {
    const ids = ['bad id', 'tok-a', 'tok-b'];
    const a = createApprovalAuthority({ mode: 'paper', key: KEY, newTokenId: () => ids.shift() ?? 'x', planFreshSlots: 25 }).issuer;
    const plan = checked(PLAN);
    assert.throws(() => a.issue(plan, 999n), /future/); // refused before anything was spent
    assert.throws(() => a.issue(plan, 1_005n), /plain id/); // 'bad id' is refused too
    assert.equal(isCheckedPlan(plan), true);
    assert.equal(a.issue(plan, 1_005n).id, 'tok-a');
    assert.equal(isCheckedPlan(plan), false);
    assert.throws(() => a.issue(plan, 1_005n), /re-check/); // the same snapshot cannot get a second token
    assert.equal(a.issue(checked(PLAN), 1_005n).id, 'tok-b'); // a new re-check against fresh inputs can
  });

  it('even if newTokenId comes back into issue with the same plan, only one token comes out', () => {
    let calls = 0;
    let inner = undefined as ApprovalToken | undefined;
    const plan = checked(PLAN);
    const a: ApprovalAuthority = createApprovalAuthority({
      mode: 'paper',
      key: KEY,
      planFreshSlots: 25,
      newTokenId: () => {
        calls += 1;
        if (calls === 1) {
          inner = a.issuer.issue(plan, 1_005n); // the callback tries to issue the same plan
          return 'outer';
        }
        return 'inner';
      },
    });
    assert.throws(() => a.issuer.issue(plan, 1_005n), /already has a token/); // the outer call loses
    assert.equal(calls, 2);
    assert.equal(inner?.id, 'inner'); // the one token there is
    assert.deepEqual(verify(a, inner), []);
  });

  it('only a plan that passed the re-check can be issued a token (REVIEWS.md G)', () => {
    const a = authority().issuer;
    assert.throws(() => a.issue(PLAN as CheckedPlan, 1_005n), /re-check/); // never checked
    assert.throws(() => a.issue({ ...checked(PLAN) } as CheckedPlan, 1_005n), /re-check/); // a copy is not the snapshot
    assert.throws(() => a.issue({ ...PLAN, kind: 'withdraw' } as CheckedPlan, 1_005n), /re-check/); // a withdraw never passes
    assert.throws(() => a.issue(null as unknown as CheckedPlan, 1_005n), /re-check/);
  });

  it('a paper authority never mints a live token, and the reverse', () => {
    assert.throws(() => authority({ mode: 'paper' }).issuer.issue(checked(LIVE), 1_005n), /own mode/);
    assert.throws(() => authority({ mode: 'live' }).issuer.issue(checked(PLAN), 1_005n), /own mode/);
    assert.equal(authority({ mode: 'live' }).issuer.issue(checked(LIVE), 1_005n).mode, 'live');
  });

  it('refuses a plan from the future, an expired plan and a bad slot', () => {
    const a = authority().issuer;
    const plan = checked(PLAN);
    assert.throws(() => a.issue(plan, 999n), /future/);
    assert.throws(() => a.issue(plan, 1_026n), /expired/);
    assert.throws(() => a.issue(plan, -1n), /slot/);
    assert.throws(() => a.issue(plan, 5 as unknown as bigint), /slot/);
    assert.equal(a.issue(plan, 1_025n).expiresAtSlot, 1_025n); // the last slot it is still valid
  });

  it('refuses a token id that is not a plain id or was already used', () => {
    const ids = ['ok-1', 'ok-1', 'has space', ''];
    const a = createApprovalAuthority({ mode: 'paper', key: KEY, newTokenId: () => ids.shift() ?? 'x', planFreshSlots: 25 });
    assert.equal(a.issuer.issue(checked(PLAN), 1_005n).id, 'ok-1');
    assert.throws(() => a.issuer.issue(checked(PLAN), 1_005n), /already/);
    assert.throws(() => a.issuer.issue(checked(PLAN), 1_005n), /plain id/);
    assert.throws(() => a.issuer.issue(checked(PLAN), 1_005n), /plain id/);
  });

  it('remembers only the newest ids, so memory stays bounded', () => {
    const ids = ['dup'];
    let n = 0;
    const a = createApprovalAuthority({ mode: 'paper', key: KEY, newTokenId: () => ids.shift() ?? `t-${(n += 1)}`, planFreshSlots: 25 });
    a.issuer.issue(checked(PLAN), 1_005n); // 'dup'
    assert.throws(() => (ids.push('dup'), a.issuer.issue(checked(PLAN), 1_005n)), /already/);
    for (let i = 0; i < 10_000; i += 1) {
      a.issuer.issue(checked(PLAN), 1_005n);
    }
    ids.push('dup');
    assert.equal(a.issuer.issue(checked(PLAN), 1_005n).id, 'dup'); // forgotten after 10,000 newer ids
  });
});

describe('verifying: a valid token', () => {
  it('passes for the plan it was issued for, in its mode, before it expires', () => {
    const a = authority();
    const t = issue(a);
    assert.deepEqual(verify(a, t), []);
    assert.deepEqual(verify(a, t, PLAN, { currentSlot: 1_025n, mode: 'paper' }), []);
    assert.deepEqual(verify(a, issue(a, SELL), SELL), []);
    assert.deepEqual(verify(a, issue(a, CLOSE), CLOSE), []);
  });

  it('the executor\'s verifier cannot issue (the key and the constructor stay with risk)', () => {
    const a = authority();
    assert.equal('issue' in a.verifier, false);
    assert.equal(Object.keys(a.verifier).includes('key'), false);
  });
});

describe('verifying: a forged or tampered token', () => {
  const a = authority();
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
    const other = authority({ key: Uint8Array.from({ length: 32 }, (_v, i) => 200 - i) });
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

  it('a token never works in the other mode', () => {
    assert.deepEqual(verify(a, token, PLAN, { currentSlot: 1_005n, mode: 'live' }), ['wrong-mode']);
    // a live token (same key) at a paper authority, with a paper executor context or a live one
    const live = issue(authority({ mode: 'live' }), LIVE);
    assert.deepEqual(verify(a, live, LIVE, NOW), ['wrong-mode']);
    assert.deepEqual(verify(a, live, LIVE, { currentSlot: 1_005n, mode: 'live' }), ['wrong-mode']);
    assert.deepEqual(verify(authority({ mode: 'live' }), live, LIVE, { currentSlot: 1_005n, mode: 'live' }), []);
  });
});

describe('verifying: expiry', () => {
  it('valid through its expiry slot, refused after', () => {
    const a = authority();
    const t = issue(a);
    assert.deepEqual(verify(a, t, PLAN, { currentSlot: 1_025n, mode: 'paper' }), []);
    assert.deepEqual(verify(a, t, PLAN, { currentSlot: 1_026n, mode: 'paper' }), ['expired']);
  });

  it('an expiry later than the quote allows is refused (a verifier with a tighter window)', () => {
    const issued = issue(authority()); // expires 1,025
    assert.deepEqual(verify(authority({ planFreshSlots: 10 }), issued), ['expiry-too-late']);
  });
});

describe('single use', () => {
  it('redeem verifies, consumes, and hands back the frozen validated plan; a second use is refused', () => {
    const a = authority();
    const store = new MemoryStore();
    const t = issue(a);
    const first = a.verifier.redeem(t, PLAN, NOW, store);
    assert.ok(first.ok);
    assert.deepEqual({ ...first.plan }, { ...PLAN });
    assert.ok(Object.isFrozen(first.plan));
    const second = a.verifier.redeem(t, PLAN, NOW, store);
    assert.deepEqual(second, { ok: false, problems: ['already-consumed'] });
    assert.deepEqual([...store.seen], ['tok-1']);
  });

  it('the plan the executor builds from cannot change after redeem (REVIEWS.md H, M2)', () => {
    const a = authority();
    const mine = { ...PLAN };
    const result = a.verifier.redeem(issue(a), mine, NOW, new MemoryStore());
    (mine as { wallet: string }).wallet = 'Attacker';
    assert.ok(result.ok && result.plan.wallet === 'OurWallet');
  });

  it('a token that fails verification is not consumed', () => {
    const a = authority();
    const store = new MemoryStore();
    const t = issue(a);
    assert.deepEqual(a.verifier.redeem(t, { ...PLAN, wallet: 'Attacker' }, NOW, store), { ok: false, problems: ['plan-hash-mismatch'] });
    assert.equal(store.seen.size, 0);
    assert.ok(a.verifier.redeem(t, PLAN, NOW, store).ok); // still good for the right plan
  });

  it('only an explicit true from the store approves: an async or truthy result is refused (REVIEWS.md H, H1)', () => {
    const a = authority();
    const t = issue(a);
    for (const answer of [Promise.resolve(false), Promise.resolve(true), 1, 'yes', {}, undefined, null, 0]) {
      assert.deepEqual(a.verifier.redeem(t, PLAN, NOW, storeReturning(answer)), { ok: false, problems: ['store-error'] }, String(answer));
    }
    assert.deepEqual(a.verifier.redeem(t, PLAN, NOW, storeReturning(false)), { ok: false, problems: ['already-consumed'] });
    assert.ok(a.verifier.redeem(t, PLAN, NOW, storeReturning(true)).ok);
  });

  it('a store that fails, or is not a store, means no guarantee of single use: refused, never approved', () => {
    const a = authority();
    const t = issue(a);
    const broken: TokenStore = {
      consume(): boolean {
        throw new Error('disk full');
      },
    };
    assert.deepEqual(a.verifier.redeem(t, PLAN, NOW, broken), { ok: false, problems: ['store-error'] });
    assert.deepEqual(a.verifier.redeem(t, PLAN, NOW, null as unknown as TokenStore), { ok: false, problems: ['store-error'] });
  });
});

describe('verify never throws', () => {
  const a = authority();
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
    assert.deepEqual(a.verifier.redeem(getter as unknown as ApprovalToken, PLAN, NOW, new MemoryStore()), { ok: false, problems: ['malformed-token'] });
  });

  it('a malformed or hostile plan or context is refused as such', () => {
    assert.deepEqual(verify(a, token, null), ['malformed-plan']);
    assert.deepEqual(verify(a, token, { ...PLAN, attempts: 0 }), ['malformed-plan']);
    assert.deepEqual(verify(a, token, Object.defineProperty({ ...PLAN }, 'wallet', { get: boom, enumerable: true })), ['malformed-plan']);
    assert.deepEqual(verify(a, token, PLAN, null), ['malformed-context']);
    assert.deepEqual(verify(a, token, PLAN, { currentSlot: 1_005n, mode: 'off' }), ['malformed-context']);
    assert.deepEqual(verify(a, token, PLAN, { currentSlot: 5, mode: 'paper' }), ['malformed-context']);
    assert.deepEqual(verify(a, token, PLAN, { currentSlot: -1n, mode: 'paper' }), ['malformed-context']);
    assert.deepEqual(verify(a, token, PLAN, { get currentSlot() { return boom(); }, mode: 'paper' }), ['malformed-context']);
    assert.deepEqual(verify(a, token, PLAN, new Proxy({}, { get: boom })), ['malformed-context']);
  });

  it('a plan whose worst-case spend overflows is refused, not thrown', () => {
    const huge = { ...PLAN, inAmount: 2n ** 64n - 1n }; // plus the rent and fees it cannot be represented
    const problems = verify(a, token, huge);
    assert.ok(problems.includes('plan-hash-mismatch') && problems.includes('max-spend-mismatch'));
  });

  it('redeem never throws either', () => {
    const store = new MemoryStore();
    assert.deepEqual(a.verifier.redeem(null as unknown as ApprovalToken, PLAN, NOW, store), { ok: false, problems: ['malformed-token'] });
    assert.equal(store.seen.size, 0);
  });
});

describe('creating the authority', () => {
  const make = (patch: Record<string, unknown>) =>
    createApprovalAuthority({ mode: 'paper', key: KEY, newTokenId: () => 'x', planFreshSlots: 25, ...patch } as Parameters<typeof createApprovalAuthority>[0]);

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

  it('validates the COPY of the key: a subclass cannot show the check one thing and the MAC another (REVIEWS.md H)', () => {
    class ShortKey extends Uint8Array {
      override [Symbol.iterator](): ArrayIterator<number> {
        return [1, 2, 3][Symbol.iterator]();
      }
    }
    const evil = new ShortKey(64).fill(7); // 64 bytes to a length check, 3 bytes to anything that reads it
    assert.throws(() => make({ key: evil }), RiskError);
  });

  it('keeps its own copy of the key: wiping the caller\'s array does not break or weaken it', () => {
    const mine = Uint8Array.from(KEY);
    const a = createApprovalAuthority({ mode: 'paper', key: mine, newTokenId: (() => { let n = 0; return () => `t-${(n += 1)}`; })(), planFreshSlots: 25 });
    const before = issue(a);
    mine.fill(0);
    assert.deepEqual(verify(a, before), []);
    assert.deepEqual(verify(a, issue(a)), []);
  });
});
