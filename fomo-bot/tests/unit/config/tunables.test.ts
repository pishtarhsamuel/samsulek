// The tunables (RISK_POLICY.md s.12; TEST_PLAN.md s.3 item 5): every value /set and the AI may change.
// The rules (safer direction, AI rule, /set rule) and the defaults are pinned to the policy here, and
// the checks are strict: a whole set has exactly the known fields (no mode, hard cap or address can
// ride along), each the right kind of number and inside its bounds; a typed value is digits only; the
// stored form round-trips exactly.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TUNABLE_BOUNDS } from '../../../src/config/caps.ts';
import {
  ConfigError,
  DEFAULT_TUNABLES,
  RULES,
  TUNABLE_PATHS,
  boundsOf,
  changeSafety,
  changedPaths,
  checkTunables,
  decodeTunables,
  encodeTunables,
  groupOf,
  inBounds,
  isTunablePath,
  parseTunableValue,
  strategyOf,
  valueAt,
  withValue,
  type TunablePath,
  type TunableValue,
} from '../../../src/config/tunables.ts';

/** A plain, mutable copy (as JSON.parse would make it, bigints kept). */
function raw(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [group, params] of Object.entries(DEFAULT_TUNABLES)) {
    out[group] = { ...(params as Record<string, unknown>) };
  }
  return out;
}

function rawWith(path: TunablePath, value: unknown): Record<string, Record<string, unknown>> {
  const copy = raw();
  const [group, name] = path.split('.') as [string, string];
  copy[group]![name] = value;
  return copy;
}

// RISK_POLICY.md s.12, written out once more here: [the safer direction, the AI rule, the /set rule].
const POLICY_RULES: Readonly<Record<TunablePath, readonly ['down' | 'up' | 'none', 'safer' | 'either' | 'never', 'either' | 'safer']>> = {
  'risk.tradePctBps': ['down', 'safer', 'either'],
  'risk.openPositions': ['down', 'safer', 'either'],
  'risk.exposurePctBps': ['down', 'safer', 'either'],
  'risk.entriesPerDay': ['down', 'safer', 'either'],
  'risk.costRuleBps': ['down', 'safer', 'either'],
  'risk.poolShareBps': ['down', 'safer', 'either'],
  'risk.priceCrossCheckBps': ['down', 'safer', 'either'],
  'risk.dailyStopBps': ['down', 'safer', 'either'],
  'risk.peakHaltBps': ['down', 'safer', 'either'],
  'risk.buySlippageBps': ['down', 'safer', 'either'],
  'risk.sellSlippageBps': ['down', 'safer', 'either'],
  'risk.landingSpendBps': ['down', 'either', 'either'],
  'risk.tokenAgeMs': ['up', 'never', 'either'],
  'risk.curveProgressBps': ['down', 'never', 'either'],
  'crowdflow.minDistinctBuyers5m': ['up', 'safer', 'either'],
  'crowdflow.minCompletenessBps': ['up', 'safer', 'either'],
  'crowdflow.maxTopBuyerShareBps': ['down', 'safer', 'either'],
  'crowdflow.maxSameSlotShareBps': ['down', 'safer', 'either'],
  'crowdflow.maxIdenticalSizeShareBps': ['down', 'safer', 'either'],
  'crowdflow.minAccelerationBps': ['none', 'either', 'either'],
  'crowdflow.maxRun15mBps': ['none', 'either', 'either'],
  'momentum.minAgeMs': ['up', 'safer', 'either'],
  'momentum.minLiquidityLamports': ['up', 'safer', 'either'],
  'momentum.pullbackBps': ['none', 'either', 'either'],
  'launch.minHolders': ['up', 'safer', 'either'],
  'launch.maxTop10ShareBps': ['down', 'safer', 'either'],
  'launch.maxCreatorShareBps': ['down', 'safer', 'either'],
  'launch.curveProgressWindowBps': ['none', 'either', 'either'],
  'exits.hardStopBps': ['down', 'safer', 'either'],
  'exits.takeProfitBps': ['none', 'either', 'either'],
  'exits.trailBps': ['none', 'either', 'either'],
  'exits.timeStopMin': ['none', 'either', 'either'],
  'exits.timeStopMinGainBps': ['none', 'either', 'either'],
  'paper.pFailBps': ['up', 'never', 'safer'],
  'paper.extraLatencyMs': ['up', 'never', 'safer'],
  'paper.competitionBpsPerLeg': ['up', 'never', 'safer'],
};

describe('the table of tunables (RISK_POLICY.md s.12)', () => {
  it('one rule and one bound per tunable, in a fixed order', () => {
    assert.equal(TUNABLE_PATHS.length, 36);
    assert.deepEqual([...TUNABLE_PATHS].sort(), Object.keys(RULES).sort());
    assert.deepEqual([...TUNABLE_PATHS].sort(), Object.keys(POLICY_RULES).sort());
    for (const [group, params] of Object.entries(TUNABLE_BOUNDS)) {
      for (const name of Object.keys(params)) {
        assert.ok(isTunablePath(`${group}.${name}`), `${group}.${name}`);
      }
    }
    assert.equal(TUNABLE_PATHS[0], 'risk.tradePctBps');
    assert.ok(Object.isFrozen(TUNABLE_PATHS) && Object.isFrozen(RULES));
  });

  it('each rule is the policy\'s: the safer way, what the AI may do, what /set may do', () => {
    for (const path of TUNABLE_PATHS) {
      const [safer, ai, set] = POLICY_RULES[path];
      assert.deepEqual({ ...RULES[path] }, { safer, ai, set }, path);
      assert.ok(Object.isFrozen(RULES[path]), path);
    }
  });

  it('the AI never touches the paper model; the paper model only becomes more pessimistic', () => {
    for (const path of TUNABLE_PATHS.filter((p) => p.startsWith('paper.'))) {
      assert.equal(RULES[path].ai, 'never');
      assert.equal(RULES[path].set, 'safer');
      assert.equal(RULES[path].safer, 'up');
    }
  });

  it('names that are not tunables: modes, hard caps, addresses, inherited names', () => {
    for (const name of ['mode', 'crowdflow.mode', 'modes.crowdflow', 'risk.positionLamports', 'withdrawAddress', 'ai.model', 'risk', 'risk.', '.tradePctBps', 'risk.tradepctbps', 'toString', '__proto__', '', 42, null]) {
      assert.equal(isTunablePath(name), false, String(name));
    }
    assert.throws(() => boundsOf('risk.mode' as TunablePath), ConfigError);
  });
});

describe('the defaults (the first version)', () => {
  it('are inside every bound, frozen, and the policy\'s numbers for risk, exits and the paper model', () => {
    assert.deepEqual(checkTunables(DEFAULT_TUNABLES), DEFAULT_TUNABLES);
    assert.ok(Object.isFrozen(DEFAULT_TUNABLES) && Object.isFrozen(DEFAULT_TUNABLES.risk) && Object.isFrozen(DEFAULT_TUNABLES.paper));
    assert.deepEqual({ ...DEFAULT_TUNABLES.risk }, {
      tradePctBps: 1_000, // limit 1: 10%
      openPositions: 4,
      exposurePctBps: 5_000,
      entriesPerDay: 8, // limit 13 (P)
      costRuleBps: 500,
      poolShareBps: 50,
      priceCrossCheckBps: 300, // limit 21: D 3%
      dailyStopBps: 3_000,
      peakHaltBps: 5_000,
      buySlippageBps: 200, // limit 16: 2% (P)
      sellSlippageBps: 300, // limit 17: 3% (P)
      landingSpendBps: 20, // limit 18: 0.2% (P)
      tokenAgeMs: 180_000, // limit 22: the 3-minute floor
      curveProgressBps: 9_000, // limit 23: 90% (P)
    });
    assert.deepEqual({ ...DEFAULT_TUNABLES.exits }, { hardStopBps: 3_500, takeProfitBps: 10_000, trailBps: 3_000, timeStopMin: 30, timeStopMinGainBps: 1_000 }); // P1
    assert.deepEqual({ ...DEFAULT_TUNABLES.paper }, { pFailBps: 2_000, extraLatencyMs: 2_000, competitionBpsPerLeg: 50 }); // limit 29's floors
    assert.equal(DEFAULT_TUNABLES.momentum.minAgeMs, 86_400_000); // limit 22: momentum 24 h
  });
});

describe('checkTunables: exactly the known fields, the right kind of number, inside the bounds', () => {
  it('returns a frozen copy, never the input itself', () => {
    const input = raw();
    const checked = checkTunables(input);
    assert.notEqual(checked, input);
    assert.ok(Object.isFrozen(checked) && Object.isFrozen(checked.risk));
    input['risk']!['tradePctBps'] = 999_999;
    assert.equal(checked.risk.tradePctBps, 1_000);
  });

  it('every tunable at its min and its max is accepted; one past either is refused', () => {
    for (const path of TUNABLE_PATHS) {
      const [min, max] = boundsOf(path);
      assert.equal(valueAt(checkTunables(rawWith(path, min)), path), min, path);
      assert.equal(valueAt(checkTunables(rawWith(path, max)), path), max, path);
      const one = typeof min === 'bigint' ? 1n : 1;
      assert.throws(() => checkTunables(rawWith(path, (max as number) + (one as number))), ConfigError, `${path} above max`);
      if ((min as number) > 0 || (min as bigint) > 0n) {
        assert.throws(() => checkTunables(rawWith(path, (min as number) - (one as number))), ConfigError, `${path} below min`);
      }
    }
  });

  it('refuses the wrong kind of number: a fraction, NaN, text, a bigint where a number belongs and the reverse', () => {
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, '500', 500n, null, undefined, true]) {
      assert.throws(() => checkTunables(rawWith('risk.tradePctBps', bad)), ConfigError, String(bad));
    }
    for (const bad of [50_000_000_000, '50000000000', -1n]) {
      assert.throws(() => checkTunables(rawWith('momentum.minLiquidityLamports', bad)), ConfigError, String(bad));
    }
  });

  it('refuses anything extra or missing: no mode, hard cap or address can ride along', () => {
    const withMode = raw();
    withMode['crowdflow']!['mode'] = 'live';
    const withModes = { ...raw(), modes: { crowdflow: 'live' } };
    const withCap = raw();
    withCap['risk']!['positionLamports'] = 1_000_000_000n;
    const missing = raw();
    delete missing['risk']!['tradePctBps'];
    const noGroup: Record<string, unknown> = raw();
    delete noGroup['paper'];
    for (const bad of [withMode, withModes, withCap, missing, noGroup, { ...raw(), withdrawAddress: 'Someone' }]) {
      assert.throws(() => checkTunables(bad), ConfigError);
    }
  });

  it('refuses what is not plain data: lists, null, class instances, other prototypes, symbol keys, getters', () => {
    class Box {
      readonly risk: unknown;
      constructor(risk: unknown) {
        this.risk = risk;
      }
    }
    const withSymbol = raw();
    (withSymbol['risk'] as Record<symbol, unknown>)[Symbol('x')] = 1;
    const withGetter = raw();
    Object.defineProperty(withGetter['risk'], 'tradePctBps', { get: () => 500, enumerable: true });
    const hidden = raw();
    Object.defineProperty(hidden['risk'], 'mode', { value: 'live', enumerable: false });
    const inherited = Object.create(raw()) as unknown;
    for (const bad of [[], null, 'text', new Box(raw()['risk']), inherited, Object.assign(Object.create({ evil: 1 }), raw()), withSymbol, withGetter, hidden]) {
      assert.throws(() => checkTunables(bad), ConfigError);
    }
    const nullProto = Object.assign(Object.create(null), raw()) as unknown;
    assert.deepEqual(checkTunables(nullProto), DEFAULT_TUNABLES); // a null prototype is plain enough
    // a getter is refused as such, and never run (it could answer differently each time it is read)
    let reads = 0;
    const counting = raw();
    Object.defineProperty(counting['risk'], 'tradePctBps', { get: () => ((reads += 1), 500), enumerable: true });
    assert.throws(() => checkTunables(counting), /risk\.tradePctBps must be a plain value/);
    assert.equal(reads, 0);
  });
});

describe('values as the owner types them (/set) or the AI writes them', () => {
  it('digits in the base unit, or a JSON whole number', () => {
    assert.deepEqual(parseTunableValue('risk.tradePctBps', '500'), { ok: true, value: 500 });
    assert.deepEqual(parseTunableValue('risk.tradePctBps', 500), { ok: true, value: 500 });
    assert.deepEqual(parseTunableValue('momentum.minLiquidityLamports', '20000000000'), { ok: true, value: 20_000_000_000n });
    assert.deepEqual(parseTunableValue('momentum.minLiquidityLamports', 20_000_000_000), { ok: true, value: 20_000_000_000n });
    assert.deepEqual(parseTunableValue('momentum.minLiquidityLamports', 20_000_000_000n), { ok: true, value: 20_000_000_000n });
  });

  it('nothing else: no sign, point, exponent, space, leading zero, bigint for a count, or fraction', () => {
    for (const bad of ['-5', '+5', '5.0', '5e2', ' 5', '5 ', '', '0500', '0x10', '5%', 1.5, -1, Number.NaN, 500n, null, true, ['500']]) {
      assert.deepEqual(parseTunableValue('risk.tradePctBps', bad), { ok: false, reason: 'not-a-number' }, String(bad));
    }
    assert.deepEqual(parseTunableValue('momentum.minLiquidityLamports', -1n), { ok: false, reason: 'not-a-number' });
  });

  it('then the bounds, exactly', () => {
    assert.deepEqual(parseTunableValue('risk.tradePctBps', '1000'), { ok: true, value: 1_000 });
    assert.deepEqual(parseTunableValue('risk.tradePctBps', '1001'), { ok: false, reason: 'out-of-bounds' });
    assert.deepEqual(parseTunableValue('risk.tradePctBps', '99'), { ok: false, reason: 'out-of-bounds' });
    assert.deepEqual(parseTunableValue('risk.tradePctBps', '99999999999999999999'), { ok: false, reason: 'out-of-bounds' }); // past 2^53
    assert.deepEqual(parseTunableValue('momentum.minLiquidityLamports', '19999999999'), { ok: false, reason: 'out-of-bounds' });
    assert.equal(inBounds('risk.tradePctBps', 1_000), true);
    assert.equal(inBounds('risk.tradePctBps', 1_000n), false);
    assert.equal(inBounds('momentum.minLiquidityLamports', 2_000_000_000_001n), false);
  });
});

describe('the safety of a change', () => {
  it('lower is safer for a cap, higher for a floor, neither for the tunables without a safer way', () => {
    assert.equal(changeSafety('risk.tradePctBps', 1_000, 500), 'safer');
    assert.equal(changeSafety('risk.tradePctBps', 500, 1_000), 'riskier');
    assert.equal(changeSafety('risk.tokenAgeMs', 180_000, 600_000), 'safer');
    assert.equal(changeSafety('momentum.minLiquidityLamports', 50_000_000_000n, 40_000_000_000n), 'riskier');
    assert.equal(changeSafety('paper.pFailBps', 2_000, 3_000), 'safer'); // more pessimistic
    assert.equal(changeSafety('exits.takeProfitBps', 10_000, 20_000), 'neutral');
    assert.equal(changeSafety('risk.tradePctBps', 500, 500), 'neutral');
  });
});

describe('the stored form', () => {
  it('round-trips exactly, lamports as decimal text, in a fixed order', () => {
    const text = encodeTunables(DEFAULT_TUNABLES);
    assert.ok(text.includes('"minLiquidityLamports":"50000000000"'));
    assert.ok(text.startsWith('{"risk":{"tradePctBps":1000,'));
    assert.deepEqual(decodeTunables(text), DEFAULT_TUNABLES);
    assert.equal(encodeTunables(decodeTunables(text)), text);
  });

  it('refuses a stored form that is not exactly right', () => {
    const good = JSON.parse(encodeTunables(DEFAULT_TUNABLES)) as Record<string, Record<string, unknown>>;
    const asNumber = structuredClone(good);
    asNumber['momentum']!['minLiquidityLamports'] = 50_000_000_000;
    const extra = { ...structuredClone(good), modes: {} };
    const outOfBounds = structuredClone(good);
    outOfBounds['risk']!['tradePctBps'] = 5_000;
    for (const bad of ['{', '', 'null', '[]', JSON.stringify(asNumber), JSON.stringify(extra), JSON.stringify(outOfBounds), '{"risk":1}']) {
      assert.throws(() => decodeTunables(bad), ConfigError, bad.slice(0, 40));
    }
    assert.throws(() => decodeTunables(5 as unknown as string), ConfigError);
    assert.throws(() => encodeTunables({ ...DEFAULT_TUNABLES, modes: {} } as unknown as typeof DEFAULT_TUNABLES), ConfigError);
  });
});

describe('helpers', () => {
  it('groups, strategies, reading and replacing one value', () => {
    assert.equal(groupOf('crowdflow.maxRun15mBps'), 'crowdflow');
    assert.equal(strategyOf('crowdflow.maxRun15mBps'), 'crowdflow');
    assert.equal(strategyOf('launch.minHolders'), 'launch');
    assert.equal(strategyOf('momentum.pullbackBps'), 'momentum');
    assert.equal(strategyOf('exits.trailBps'), null);
    assert.equal(strategyOf('risk.tradePctBps'), null);
    const changed = withValue(DEFAULT_TUNABLES, 'risk.tradePctBps', 500);
    assert.equal(changed.risk.tradePctBps, 500);
    assert.equal(DEFAULT_TUNABLES.risk.tradePctBps, 1_000); // the original is untouched
    assert.ok(Object.isFrozen(changed) && Object.isFrozen(changed.risk));
    assert.deepEqual(changedPaths(DEFAULT_TUNABLES, changed), ['risk.tradePctBps']);
    assert.deepEqual(changedPaths(DEFAULT_TUNABLES, DEFAULT_TUNABLES), []);
    assert.throws(() => withValue(DEFAULT_TUNABLES, 'risk.tradePctBps', 1_001), ConfigError);
    assert.throws(() => withValue(DEFAULT_TUNABLES, 'momentum.minLiquidityLamports', 50 as TunableValue), ConfigError);
  });
});
