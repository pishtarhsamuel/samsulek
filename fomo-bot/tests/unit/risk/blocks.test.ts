// Entry blocks (RISK_POLICY.md s.6 step 1, s.4, s.7 and s.8): every reason a new buy is refused
// before it is sized. Each block is tested alone, at and just past its boundary, and together
// with the others. Exits never pass through here. TEST_PLAN.md s.3 step 4. Written first.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RiskError } from '../../../src/risk/reserve.ts';
import { entryBlocks, type EntryCheck, type EntryState } from '../../../src/risk/blocks.ts';

const T0 = 1_762_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

const CLEAR: EntryState = {
  now: T0,
  kill: false,
  haltReasons: [],
  haltClearedAt: null,
  paused: false,
  dailyStop: false,
  entriesStopped: false,
  equityKnown: true,
  equityJumpPending: false,
  modes: { crowdflow: 'paper', momentum: 'paper', launch: 'off' },
  breakers: [],
  strategyPausedUntil: {},
  strategyOffUntil: {},
  tokenCooldownUntil: new Map(),
  bannedMints: new Set(),
  blockedCreators: new Set(),
  activeMints: new Set(),
  entriesToday: 0,
  entriesPerDay: 8,
  activePositions: 0,
  maxPositions: 4,
};

const ENTRY: EntryCheck = { strategy: 'crowdflow', mode: 'paper', mint: 'MintA', venue: 'pumpswap', creator: 'CreatorA' };

const blocks = (state: Partial<EntryState>, entry: Partial<EntryCheck> = {}) =>
  entryBlocks({ ...CLEAR, ...state }, { ...ENTRY, ...entry });

describe('a clear state allows the entry', () => {
  it('no reasons at all', () => {
    assert.deepEqual(blocks({}), []);
  });
});

describe('flags (s.8): each one alone blocks every entry', () => {
  const cases: ReadonlyArray<readonly [string, Partial<EntryState>]> = [
    ['kill', { kill: true }],
    ['halt', { haltReasons: ['RECONCILE_MISMATCH'] }],
    ['pause', { paused: true }],
    ['daily-stop', { dailyStop: true }],
    ['entries-stopped', { entriesStopped: true }], // 10% of equity below the minimum trade
    ['equity-unknown', { equityKnown: false }], // s.4: never size on a guess (stale marks included)
    ['equity-jump-check', { equityJumpPending: true }], // s.4: "+50% in 1 h" until verified
  ];
  for (const [reason, state] of cases) {
    it(reason, () => {
      assert.deepEqual(blocks(state), [reason]);
      assert.deepEqual(blocks(state, { strategy: 'momentum' }), [reason]);
    });
  }

  it('all of them together are all reported', () => {
    const all = blocks({
      kill: true,
      haltReasons: ['X'],
      paused: true,
      dailyStop: true,
      entriesStopped: true,
      equityKnown: false,
      equityJumpPending: true,
    });
    assert.deepEqual(all, ['kill', 'halt', 'pause', 'daily-stop', 'entries-stopped', 'equity-unknown', 'equity-jump-check']);
  });
});

describe('strategy modes: only the flags table decides', () => {
  it('a strategy that is off never enters', () => {
    assert.deepEqual(blocks({}, { strategy: 'launch' }), ['strategy-off']);
  });

  it('an entry must run in its strategy\'s own mode: a paper strategy never trades live, and back', () => {
    assert.deepEqual(blocks({}, { mode: 'live' }), ['mode-mismatch']);
    assert.deepEqual(blocks({ modes: { ...CLEAR.modes, crowdflow: 'live' } }, { mode: 'paper' }), ['mode-mismatch']);
    assert.deepEqual(blocks({ modes: { ...CLEAR.modes, crowdflow: 'live' } }, { mode: 'live' }), []);
  });
});

describe('breakers (s.8): blocked while open and during the quiet time after they close', () => {
  it('scope all blocks every entry; an open breaker has until = null', () => {
    assert.deepEqual(blocks({ breakers: [{ name: 'DATA_STALE', scope: { kind: 'all' }, until: null }] }), ['breaker:DATA_STALE']);
  });

  it('scope strategy blocks that strategy only (FOMO_SIGNAL stops crowdflow)', () => {
    const state = { breakers: [{ name: 'FOMO_SIGNAL' as const, scope: { kind: 'strategy' as const, strategy: 'crowdflow' as const }, until: null }] };
    assert.deepEqual(blocks(state), ['breaker:FOMO_SIGNAL']);
    assert.deepEqual(blocks(state, { strategy: 'momentum' }), []);
  });

  it('scope mint and scope venue block that token or venue only', () => {
    const mint = { breakers: [{ name: 'PRICE_DIVERGENCE' as const, scope: { kind: 'mint' as const, mint: 'MintA' }, until: null }] };
    assert.deepEqual(blocks(mint), ['breaker:PRICE_DIVERGENCE']);
    assert.deepEqual(blocks(mint, { mint: 'MintB' }), []);
    const venue = { breakers: [{ name: 'VENUE_CHANGED' as const, scope: { kind: 'venue' as const, venue: 'pumpswap' }, until: null }] };
    assert.deepEqual(blocks(venue), ['breaker:VENUE_CHANGED']);
    assert.deepEqual(blocks(venue, { venue: 'pump-curve' }), []);
  });

  it('scope live blocks live entries only (SEND_FAILURES)', () => {
    const state = {
      modes: { ...CLEAR.modes, crowdflow: 'live' as const },
      breakers: [{ name: 'SEND_FAILURES' as const, scope: { kind: 'live' as const }, until: null }],
    };
    assert.deepEqual(blocks(state, { mode: 'live' }), ['breaker:SEND_FAILURES']);
    assert.deepEqual(blocks({ breakers: state.breakers }), []);
  });

  it('the same breaker in two scopes is reported once', () => {
    const twice = {
      breakers: [
        { name: 'DECODE' as const, scope: { kind: 'all' as const }, until: null },
        { name: 'DECODE' as const, scope: { kind: 'mint' as const, mint: 'MintA' }, until: null },
      ],
    };
    assert.deepEqual(blocks(twice), ['breaker:DECODE']);
  });

  it('a closed breaker keeps blocking until its quiet time ends (5 min), then not', () => {
    const quiet = (until: number) => ({ breakers: [{ name: 'RPC_ERRORS' as const, scope: { kind: 'all' as const }, until }] });
    assert.deepEqual(blocks(quiet(T0 + 1)), ['breaker:RPC_ERRORS']);
    assert.deepEqual(blocks(quiet(T0)), []);
  });

  it('after a halt clears: 15 min of clean data before entries', () => {
    assert.deepEqual(blocks({ haltClearedAt: T0 - 15 * MIN + 1 }), ['halt-recovery']);
    assert.deepEqual(blocks({ haltClearedAt: T0 - 15 * MIN }), []);
  });
});

describe('cooldowns (s.7)', () => {
  it('a strategy paused after 3 losses in a row (2 h), or off for the day after 6 losses', () => {
    assert.deepEqual(blocks({ strategyPausedUntil: { crowdflow: T0 + 1 } }), ['strategy-cooldown']);
    assert.deepEqual(blocks({ strategyPausedUntil: { crowdflow: T0 } }), []);
    assert.deepEqual(blocks({ strategyPausedUntil: { crowdflow: T0 + 2 * HOUR } }, { strategy: 'momentum' }), []);
    assert.deepEqual(blocks({ strategyOffUntil: { crowdflow: T0 + HOUR } }), ['strategy-off-today']);
    assert.deepEqual(blocks({ strategyOffUntil: { crowdflow: T0 } }), []);
  });

  it('no re-entry into a token for 6 h after any exit', () => {
    assert.deepEqual(blocks({ tokenCooldownUntil: new Map([['MintA', T0 + 1]]) }), ['token-cooldown']);
    assert.deepEqual(blocks({ tokenCooldownUntil: new Map([['MintA', T0]]) }), []);
    assert.deepEqual(blocks({ tokenCooldownUntil: new Map([['MintA', T0 + 6 * HOUR]]) }, { mint: 'MintB' }), []);
  });

  it('never after an emergency or rug exit, and never from a blocklisted creator', () => {
    assert.deepEqual(blocks({ bannedMints: new Set(['MintA']) }), ['token-banned']);
    assert.deepEqual(blocks({ blockedCreators: new Set(['CreatorA']) }), ['creator-blocked']);
    assert.deepEqual(blocks({ blockedCreators: new Set(['CreatorA']) }, { creator: null }), []);
  });
});

describe('holdings and counters', () => {
  it('one position per token: a token already opening, open, exiting or stuck is refused', () => {
    assert.deepEqual(blocks({ activeMints: new Set(['MintA']) }), ['token-active']);
    assert.deepEqual(blocks({ activeMints: new Set(['MintB']) }), []);
  });

  it('entries per day (limit 13): 7 of 8 allowed, 8 of 8 refused', () => {
    assert.deepEqual(blocks({ entriesToday: 7 }), []);
    assert.deepEqual(blocks({ entriesToday: 8 }), ['entries-per-day']);
    assert.deepEqual(blocks({ entriesToday: 9 }), ['entries-per-day']);
  });

  it('open positions (limit 3): 3 of 4 allowed, 4 of 4 refused (opening ones count)', () => {
    assert.deepEqual(blocks({ activePositions: 3 }), []);
    assert.deepEqual(blocks({ activePositions: 4 }), ['max-positions']);
  });
});

describe('fail closed on a malformed state', () => {
  it('refuses bad times, counts, modes, scopes and ids instead of guessing', () => {
    assert.throws(() => blocks({ now: Number.NaN }), RiskError);
    assert.throws(() => blocks({ entriesToday: -1 }), RiskError);
    assert.throws(() => blocks({ entriesPerDay: 0.5 }), RiskError);
    assert.throws(() => blocks({ modes: { ...CLEAR.modes, crowdflow: 'on' as 'paper' } }), RiskError);
    assert.throws(() => blocks({ modes: { crowdflow: 'paper', momentum: 'paper' } as EntryState['modes'] }), RiskError);
    assert.throws(() => blocks({ kill: 'no' as unknown as boolean }), RiskError);
    assert.throws(() => blocks({ breakers: [{ name: 'DATA_STALE', scope: { kind: 'planet' } as never, until: null }] }), RiskError);
    assert.throws(() => blocks({ breakers: [{ name: 'DATA_STALE', scope: { kind: 'all' }, until: -5 }] }), RiskError);
    assert.throws(() => blocks({}, { strategy: 'copy' as 'launch' }), RiskError);
    assert.throws(() => blocks({}, { mode: 'off' as 'paper' }), RiskError);
    assert.throws(() => blocks({}, { mint: 'a b' }), RiskError);
    assert.throws(() => blocks({ haltReasons: 'X' as unknown as string[] }), RiskError);
  });

  it('refuses containers of the wrong kind, unknown breakers and unknown scope strategies', () => {
    assert.throws(() => blocks({ tokenCooldownUntil: {} as unknown as Map<string, number> }), RiskError);
    assert.throws(() => blocks({ bannedMints: [] as unknown as Set<string> }), RiskError);
    assert.throws(() => blocks({ strategyPausedUntil: null as unknown as EntryState['strategyPausedUntil'] }), RiskError);
    assert.throws(() => blocks({ strategyOffUntil: { crowdflow: 'soon' as unknown as number } }), RiskError);
    assert.throws(() => blocks({ modes: null as unknown as EntryState['modes'] }), RiskError);
    assert.throws(() => blocks({ breakers: {} as unknown as EntryState['breakers'] }), RiskError);
    assert.throws(() => blocks({ breakers: [{ name: 'BOGUS' as 'CLOCK', scope: { kind: 'all' }, until: null }] }), RiskError);
    const strategy = { kind: 'strategy' as const, strategy: 'copy' as 'launch' };
    assert.throws(() => blocks({ breakers: [{ name: 'DECODE', scope: strategy, until: null }] }), RiskError);
    assert.throws(() => blocks({ breakers: [{ name: 'DECODE', scope: { kind: 'mint', mint: '' }, until: null }] }), RiskError);
    assert.throws(() => blocks({}, { creator: 'a/b' }), RiskError);
  });

  it('null or shapeless state, entry, breaker and scope throw RiskError, never a TypeError', () => {
    assert.throws(() => entryBlocks(null as unknown as EntryState, ENTRY), RiskError);
    assert.throws(() => entryBlocks(CLEAR, null as unknown as EntryCheck), RiskError);
    assert.throws(() => blocks({ breakers: [null as unknown as EntryState['breakers'][number]] }), RiskError);
    assert.throws(() => blocks({ breakers: [{ name: 'DECODE', until: null } as unknown as EntryState['breakers'][number]] }), RiskError);
    assert.throws(() => blocks({ equityJumpPending: undefined as unknown as boolean }), RiskError);
  });

  it('modes and cooldowns count only as own properties, never inherited ones', () => {
    const inherited = Object.create({ crowdflow: 'paper', momentum: 'paper', launch: 'off' }) as EntryState['modes'];
    assert.throws(() => blocks({ modes: inherited }), RiskError);
    const pausedByPrototype = Object.create({ crowdflow: T0 + HOUR }) as EntryState['strategyPausedUntil'];
    assert.deepEqual(blocks({ strategyPausedUntil: pausedByPrototype }), []);
  });

  it('the creator blocklist is validated even for an entry without a creator', () => {
    assert.throws(() => blocks({ blockedCreators: [] as unknown as Set<string> }, { creator: null }), RiskError);
  });
});
