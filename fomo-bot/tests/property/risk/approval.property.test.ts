// Property tests for approval tokens (TEST_PLAN.md s.4, invariants 1 and 19): the executor accepts
// exactly the matching, unexpired, unused token of the same mode and kind. For random plans, token
// tampering, plan changes, modes, slots and store states, redeem accepts IF AND ONLY IF an
// independent oracle says nothing is wrong; and a token never authorizes a different plan, a buy
// included when it was made for a sell (invariant 19). Every plan is issued through the re-check.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { bps, lamports, microLamportsPerCu } from '../../../src/core/units.ts';
import { createApprovalAuthority, type ApprovalToken, type TokenStore } from '../../../src/risk/approval.ts';
import { type OrderPlan, type PlanMode } from '../../../src/risk/plan.ts';
import { isCheckedPlan } from '../../../src/risk/recheck.ts';
import { RiskError } from '../../../src/risk/reserve.ts';
import { FREE_FEES, checked } from '../../unit/risk/fixtures.ts';

fc.configureGlobal({ numRuns: 1_000 }); // TEST_PLAN.md s.4 (this file's process only)

const KEY = Uint8Array.from({ length: 32 }, (_v, i) => (i * 7 + 3) % 256);
const QUOTE = 1_000n;
const pick = <T>(...values: T[]) => fc.constantFrom(...values);

function planOf(kind: 'buy' | 'sell' | 'close-account', mode: PlanMode, salt: number): OrderPlan {
  const close = kind === 'close-account';
  return {
    orderId: `order-${salt}`,
    intentId: `intent-${salt}`,
    positionId: 'p1',
    mode,
    kind,
    urgency: 'normal',
    venue: 'pumpswap',
    route: 'direct',
    mint: 'MintA',
    pool: 'PoolA',
    tokenAccount: 'AtaOfMintA',
    wallet: 'OurWallet',
    inAmount: close ? 0n : 55_000_000n + BigInt(salt),
    expectedOut: close ? 0n : 1_000_000_000n,
    minOut: close ? 0n : 980_000_000n,
    slippageBps: bps(close ? 0 : 200),
    feeBps: bps(125),
    feeConfigSlot: 995n,
    cuLimit: 200_000,
    cuPrice: microLamportsPerCu(150_000n),
    tip: { path: 'jito', lamports: lamports(1_000n) },
    rentLamports: lamports(kind === 'buy' ? 1_488_440n : 0n),
    attempts: 3,
    closeAccountAfter: false,
    quoteSlot: QUOTE,
    lastValidBlockHeight: null,
    ...(close ? FREE_FEES : {}), // a close on a rent-sized base passes the 0.6% landing cap only with no priority fee
  };
}

const TOKEN_TAMPERS: Readonly<Record<string, (t: ApprovalToken) => unknown>> = {
  id: (t) => ({ ...t, id: `${t.id}x` }),
  intentId: (t) => ({ ...t, intentId: `${t.intentId}x` }),
  mode: (t) => ({ ...t, mode: t.mode === 'paper' ? 'live' : 'paper' }),
  kind: (t) => ({ ...t, kind: t.kind === 'buy' ? 'sell' : 'buy' }),
  reduceOnly: (t) => ({ ...t, reduceOnly: !t.reduceOnly }),
  positionId: (t) => ({ ...t, positionId: 'p2' }),
  planHash: (t) => ({ ...t, planHash: `${t.planHash[0] === 'a' ? 'b' : 'a'}${t.planHash.slice(1)}` }),
  maxSpend: (t) => ({ ...t, maxSpendLamports: t.maxSpendLamports + 1n }),
  minOut: (t) => ({ ...t, minOut: t.minOut + 1n }),
  expiresAtSlot: (t) => ({ ...t, expiresAtSlot: t.expiresAtSlot + 1n }),
  mac: (t) => ({ ...t, mac: `${t.mac[0] === '0' ? '1' : '0'}${t.mac.slice(1)}` }),
};

const PLAN_CHANGES: Readonly<Record<string, (p: OrderPlan) => OrderPlan>> = {
  wallet: (p) => ({ ...p, wallet: 'Attacker' }),
  tokenAccount: (p) => ({ ...p, tokenAccount: 'AtaOther' }),
  inAmount: (p) => ({ ...p, inAmount: p.inAmount + 1n }),
  minOut: (p) => ({ ...p, minOut: p.minOut === 0n ? 1n : p.minOut - 1n }),
  quoteSlot: (p) => ({ ...p, quoteSlot: p.quoteSlot + 1n }),
  attempts: (p) => ({ ...p, attempts: p.attempts + 1 }),
  mint: (p) => ({ ...p, mint: 'MintB' }),
  intent: (p) => ({ ...p, intentId: `${p.intentId}x` }),
  tip: (p) => ({ ...p, tip: { path: 'none', lamports: lamports(0n) } }),
  closeAfter: (p) => ({ ...p, closeAccountAfter: !p.closeAccountAfter }),
};

// Each kind of fault is the exception (about 20-40%), so valid cases are common and every fault
// still occurs often: the properties are never vacuous (counts are asserted below).
const mostly = <T>(common: T, rare: fc.Arbitrary<T>) =>
  fc.oneof({ weight: 7, arbitrary: fc.constant(common) }, { weight: 3, arbitrary: rare });

const caseArb = fc
  .record({
    kind: pick('buy' as const, 'sell' as const, 'close-account' as const),
    planMode: pick('paper' as const, 'live' as const),
    otherMode: mostly(false, fc.constant(true)), // the executor runs the other mode
    issueAt: fc.integer({ min: 0, max: 25 }), // slots after the quote
    verifyAt: fc.oneof({ weight: 7, arbitrary: fc.integer({ min: 0, max: 25 }) }, { weight: 3, arbitrary: fc.integer({ min: 26, max: 60 }) }),
    tamper: mostly<string | null>(null, pick(...Object.keys(TOKEN_TAMPERS))),
    change: mostly<string | null>(null, pick(...Object.keys(PLAN_CHANGES))),
    consumedBefore: mostly(false, fc.constant(true)),
    salt: fc.integer({ min: 0, max: 1_000 }),
  })
  .map((c) => ({ ...c, execMode: (c.otherMode ? (c.planMode === 'paper' ? 'live' : 'paper') : c.planMode) as PlanMode }));

const text = (p: OrderPlan): string => JSON.stringify(p, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v));

class Store implements TokenStore {
  readonly seen = new Set<string>();
  consume(tokenId: string): boolean {
    if (this.seen.has(tokenId)) {
      return false;
    }
    this.seen.add(tokenId);
    return true;
  }
}

function newAuthority(mode: PlanMode) {
  let n = 0;
  return createApprovalAuthority({ mode, key: KEY, newTokenId: () => `tok-${(n += 1)}`, planFreshSlots: 25 });
}

describe('approval token properties', () => {
  it('redeem accepts if and only if the token is untampered, for the same plan and mode, unexpired and unused', () => {
    let accepted = 0;
    let refused = 0;
    fc.assert(
      fc.property(caseArb, (c) => {
        const authority = newAuthority(c.planMode);
        const plan = planOf(c.kind, c.planMode, c.salt);
        const token = authority.issuer.issue(checked(plan), QUOTE + BigInt(c.issueAt));
        const store = new Store();
        if (c.consumedBefore) {
          store.consume(token.id);
        }
        const presentedToken = c.tamper === null ? token : (TOKEN_TAMPERS[c.tamper]!(token) as ApprovalToken);
        const presentedPlan = c.change === null ? plan : PLAN_CHANGES[c.change]!(plan);
        const result = authority.verifier.redeem(presentedToken, presentedPlan, { currentSlot: QUOTE + BigInt(c.verifyAt), mode: c.execMode }, store);

        // A "change" that leaves the plan as it was (a tip change on a plan that has no tip) is no change.
        const planChanged = text(presentedPlan) !== text(plan);
        const expected = c.tamper === null && !planChanged && c.execMode === c.planMode && c.verifyAt <= 25 && !c.consumedBefore;
        assert.equal(result.ok, expected, JSON.stringify([c, result.ok ? [] : result.problems]));
        if (expected) {
          accepted += 1;
          assert.equal(store.seen.has(token.id), true, 'an accepted token is consumed');
          assert.ok(result.ok && Object.isFrozen(result.plan), 'the executor gets the frozen snapshot');
          // ...and a second use of the same token is always refused
          assert.deepEqual(authority.verifier.redeem(token, plan, { currentSlot: QUOTE, mode: c.execMode }, store), { ok: false, problems: ['already-consumed'] });
        } else {
          refused += 1;
          if (!c.consumedBefore) {
            assert.equal(store.seen.has(token.id), false, 'a refused token is never consumed');
          }
        }
      }),
    );
    assert.ok(accepted >= 100 && refused >= 100, `accepted ${accepted}, refused ${refused}`);
  });

  it('a token never authorizes a different plan, a buy included when it was made for a sell (invariant 19)', () => {
    fc.assert(
      fc.property(caseArb, caseArb, (a, b) => {
        const authority = newAuthority(a.planMode);
        const plan = planOf(a.kind, a.planMode, a.salt);
        const other = planOf(b.kind, b.planMode, b.salt);
        const token = authority.issuer.issue(checked(plan), QUOTE);
        const problems = authority.verifier.verify(token, other, { currentSlot: QUOTE, mode: other.mode });
        assert.equal(problems.length === 0, text(plan) === text(other));
        if (token.reduceOnly && other.kind === 'buy') {
          assert.ok(problems.length > 0, 'a reduce-only token never runs a buy');
        }
      }),
    );
  });

  it('a token from another boot (another key) is never accepted', () => {
    fc.assert(
      fc.property(caseArb, fc.integer({ min: 1, max: 255 }), (c, shift) => {
        const mine = newAuthority(c.planMode);
        const theirs = createApprovalAuthority({ mode: c.planMode, key: Uint8Array.from(KEY, (b) => (b + shift) % 256 || 1), newTokenId: () => 'tok-1', planFreshSlots: 25 });
        const plan = planOf(c.kind, c.planMode, c.salt);
        assert.deepEqual(mine.verifier.verify(theirs.issuer.issue(checked(plan), QUOTE), plan, { currentSlot: QUOTE, mode: c.planMode }), ['bad-mac']);
      }),
    );
  });

  it('only a plan that passed the re-check can be issued a token, whatever else it looks like', () => {
    fc.assert(
      fc.property(caseArb, fc.boolean(), (c, copy) => {
        const authority = newAuthority(c.planMode);
        const plan = planOf(c.kind, c.planMode, c.salt);
        const snapshot = checked(plan);
        const attempt = copy ? { ...snapshot } : plan;
        assert.throws(() => authority.issuer.issue(attempt as typeof snapshot, QUOTE), /re-check/);
      }),
      { numRuns: 200 },
    );
  });

  it('one re-check gives at most one token: a refused issue keeps it, the first success spends it, nothing more is ever issued', () => {
    let spentThenRefused = 0;
    fc.assert(
      fc.property(caseArb, fc.array(fc.integer({ min: -5, max: 40 }), { minLength: 1, maxLength: 8 }), (c, offsets) => {
        const authority = newAuthority(c.planMode);
        const snapshot = checked(planOf(c.kind, c.planMode, c.salt));
        let tokens = 0;
        for (const offset of offsets) {
          const slot = QUOTE + BigInt(offset); // before the quote, 0..25 slots after it (valid), or expired
          if (offset >= 0 && offset <= 25 && tokens === 0) {
            assert.equal(authority.issuer.issue(snapshot, slot).intentId, snapshot.intentId);
            tokens += 1;
          } else {
            assert.throws(() => authority.issuer.issue(snapshot, slot), RiskError);
            spentThenRefused += tokens;
          }
          assert.equal(isCheckedPlan(snapshot), tokens === 0, 'checked until the first token, never again');
        }
        assert.ok(tokens <= 1);
      }),
    );
    assert.ok(spentThenRefused >= 100, `only ${spentThenRefused} issues were refused after the token was made`);
  });
});
