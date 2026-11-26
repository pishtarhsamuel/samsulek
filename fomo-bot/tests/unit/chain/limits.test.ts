// chain/limits.ts pinned to docs/CHAIN_DESIGN.md s.5 and s.6 (step 7b): a change to any number is a
// reviewed change. Every cap stays under the public endpoint's documented 40 per method and 100 in all
// per 10 s, and under its header limits (VERIFIED_FACTS s.9: getMultipleAccounts 50, fees 20,
// getBlockTime, getTransaction, getSignaturesForAddress and getProgramAccounts 10).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BUDGET_RULES, METHOD_TABLE, PRIORITIES, REFUSED_METHODS, type ReadMethod } from '../../../src/chain/limits.ts';

const KIB = 1024;
const MIB = 1024 * KIB;

describe('the method table (CHAIN_DESIGN s.5)', () => {
  it('holds each method with its cap, P0 reserve, timeout, byte cap and most urgent priority', () => {
    const expected: Record<ReadMethod, readonly [number, number, number, number, string]> = {
      getGenesisHash: [1, 1, 5_000, KIB, 'P0'],
      getSlot: [6, 6, 5_000, KIB, 'P0'],
      getBlockHeight: [2, 2, 5_000, KIB, 'P0'],
      getBlockTime: [1, 1, 5_000, KIB, 'P0'],
      getMultipleAccounts: [20, 8, 5_000, MIB, 'P0'],
      getRecentPrioritizationFees: [4, 2, 5_000, 64 * KIB, 'P0'],
      getMinimumBalanceForRentExemption: [1, 1, 5_000, KIB, 'P0'],
      getSignaturesForAddress: [3, 2, 5_000, 256 * KIB, 'P0'],
      getTransaction: [3, 2, 5_000, 256 * KIB, 'P0'],
      simulateTransaction: [4, 2, 5_000, 256 * KIB, 'P0'],
      getProgramAccounts: [4, 0, 15_000, 2 * MIB, 'P1'], // never P0, and no reserve
    };
    assert.deepEqual(Object.keys(METHOD_TABLE).sort(), Object.keys(expected).sort());
    for (const [m, [cap, reserve, timeout, bytes, urgent]] of Object.entries(expected) as [ReadMethod, (typeof expected)[ReadMethod]][]) {
      assert.deepEqual(METHOD_TABLE[m], { capPer10s: cap, p0Reserve: reserve, timeoutMs: timeout, maxResponseBytes: bytes, mostUrgent: urgent }, m);
      assert.ok(Object.isFrozen(METHOD_TABLE[m]), m);
    }
    assert.ok(Object.isFrozen(METHOD_TABLE));
  });

  it('the caps add up to 49 of our 60 per 10 s and the P0 reserves to 27, each under the endpoint\'s limits', () => {
    const rules = Object.values(METHOD_TABLE);
    assert.equal(rules.reduce((n, r) => n + r.capPer10s, 0), 49);
    assert.equal(rules.reduce((n, r) => n + r.p0Reserve, 0), 27);
    const headerLimits: Partial<Record<ReadMethod, number>> = {
      getMultipleAccounts: 50, getRecentPrioritizationFees: 20, getBlockTime: 10, getTransaction: 10, getSignaturesForAddress: 10, getProgramAccounts: 10, getSlot: 150, getGenesisHash: 150,
    };
    for (const [m, r] of Object.entries(METHOD_TABLE) as [ReadMethod, (typeof METHOD_TABLE)[ReadMethod]][]) {
      assert.ok(r.capPer10s <= 40 && r.p0Reserve <= r.capPer10s, m);
      const header = headerLimits[m];
      assert.ok(header === undefined || r.capPer10s <= header / 2, `${m}: at most half its header limit`);
    }
  });

  it('refuses getTokenLargestAccounts (header limit 0), and lists the priorities most urgent first', () => {
    assert.deepEqual(REFUSED_METHODS, ['getTokenLargestAccounts']);
    assert.ok(!Object.hasOwn(METHOD_TABLE, 'getTokenLargestAccounts'));
    assert.deepEqual(PRIORITIES, ['P0', 'P1', 'P2', 'P3', 'P4']);
    assert.ok(Object.isFrozen(REFUSED_METHODS) && Object.isFrozen(PRIORITIES));
  });
});

describe('the governor\'s fixed numbers (CHAIN_DESIGN s.6)', () => {
  it('are as designed, frozen', () => {
    assert.deepEqual(BUDGET_RULES, {
      windowMs: 10_000,
      totalCap: 60,
      totalP0Reserve: 27,
      dataWindowMs: 30_000,
      dataCapBytes: 50_000_000,
      dataP0ReserveBytes: 10_000_000,
      maxInFlight: 6,
      inFlightP0Reserve: 2,
      busyRatio: 0.8,
      busyHoldMs: 60_000,
      shedDecayMs: 300_000,
      maxShed: 3,
      retryAfterDefaultMs: 60_000,
      retryAfterMinMs: 10_000,
      retryAfterMaxMs: 600_000,
      blockMs: 900_000,
    });
    assert.ok(Object.isFrozen(BUDGET_RULES));
  });
});
