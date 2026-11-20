// The slot feed (STORAGE_DESIGN.md s.16.7.3 and s.16.14; reviews K, N and T): the bot's view of the
// chain's current slot, bound into the approval authority. Once anchored, a higher reading is adopted
// when it fits the advance budget (at most 150 slots at once, refilled at 10 a second, never above
// 150: the tolerance does not compound) and leads no fresh channel by more than 150, or when another
// channel above the accepted slot agrees. A cold start needs two agreeing channels, or one channel
// twice 500 ms to 5 s apart with no fresh channel disagreeing. The slot is unknown before the first
// adoption, after maxAgeMs, and when it rose by less than 1 slot a second over 5 s; a clock that
// steps back, and 15 s of unknown, restart the cold start. Equal or lower readings change nothing.
// report and currentSlot never throw. Written before the review T version of src/app/slots.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import type { Alert } from '../../../src/app/faults.ts';
import * as slotsFile from '../../../src/app/slots.ts';
import { MAX_SLOT_AGE_MS, SLOT_FEED_DEFAULTS, SLOT_FEED_RULES, createSlotFeed, type SlotChannel, type SlotFeedOptions } from '../../../src/app/slots.ts';
import { HARD_CAPS } from '../../../src/config/caps.ts';

const T0 = Date.UTC(2026, 10, 19, 12);
const S = 400_000_000n; // about where mainnet is (VERIFIED_FACTS)

function world(options: Partial<SlotFeedOptions> = {}) {
  let now = T0;
  const alerts: Alert[] = [];
  const feed = createSlotFeed({ ...SLOT_FEED_DEFAULTS, clock: { now: () => now }, alerts: { alert: (a) => alerts.push(a) }, ...options });
  return {
    feed,
    alerts,
    at: (ms: number): void => {
      now = T0 + ms;
    },
    codes: (): string[] => alerts.map((a) => a.code),
  };
}

/** A feed anchored at S at time 0 by two channels agreeing (stream and http both fresh at S). */
function anchored(options: Partial<SlotFeedOptions> = {}) {
  const w = world(options);
  w.feed.report('stream', S);
  w.feed.report('http', S);
  assert.equal(w.feed.currentSlot(), S);
  return w;
}

/** A feed anchored at S at 500 ms by one channel (stream) twice, so no other channel is fresh. */
function anchoredAlone() {
  const w = world();
  w.feed.report('stream', S);
  w.at(500);
  w.feed.report('stream', S);
  assert.equal(w.feed.currentSlot(), S);
  return w;
}

describe('the slot feed file: only what it may do', () => {
  it('exports the feed, its defaults, its fixed rules and its age limit, and nothing else', () => {
    assert.deepEqual(Object.keys(slotsFile).sort(), ['MAX_SLOT_AGE_MS', 'SLOT_FEED_DEFAULTS', 'SLOT_FEED_RULES', 'createSlotFeed']);
    assert.deepEqual({ ...SLOT_FEED_DEFAULTS }, { maxAgeMs: 2_000, maxSlotsPerSecond: 10, toleranceSlots: 150, agreeSlots: 150 });
    assert.deepEqual(
      { ...SLOT_FEED_RULES },
      { coldGapMs: 500, coldBaseMaxMs: 5_000, coldResetMs: 15_000, minSlotsPerSecond: 1, rateWindowMs: 5_000, behindSlots: 25, behindMs: 10_000, alertEveryMs: 60_000 },
    );
    assert.equal(SLOT_FEED_RULES.behindSlots, HARD_CAPS.planFreshSlots); // a token's life
    assert.ok(Object.isFrozen(SLOT_FEED_DEFAULTS) && Object.isFrozen(SLOT_FEED_RULES));
    assert.equal(MAX_SLOT_AGE_MS, 2_500); // 25 slots at 100 ms (review N risk 3)
  });
});

describe('a cold start: nothing is known until two channels agree, or one channel twice', () => {
  it('unknown at first, since the feed was made', () => {
    const w = world();
    assert.equal(w.feed.currentSlot(), null);
    w.at(5_000);
    assert.equal(w.feed.unknownSinceMs(), T0);
  });

  it('two channels within 150 slots of each other, both fresh: the higher is adopted, whichever reports first', () => {
    const w = world();
    w.feed.report('stream', S);
    assert.equal(w.feed.currentSlot(), null);
    w.at(100);
    w.feed.report('http', S + 150n);
    assert.equal(w.feed.currentSlot(), S + 150n);
    assert.equal(w.feed.unknownSinceMs(), null);
    const v = world();
    v.feed.report('http', S + 150n);
    v.feed.report('stream', S);
    assert.equal(v.feed.currentSlot(), S + 150n);
  });

  it('two channels 151 slots apart disagree (slot-disagree), and one older than maxAgeMs does not count: nothing adopted', () => {
    const w = world();
    w.feed.report('stream', S);
    w.feed.report('http', S + 151n);
    assert.equal(w.feed.currentSlot(), null);
    assert.deepEqual(w.codes(), ['slot-disagree']);
    const v = world();
    v.feed.report('stream', S);
    v.at(2_001);
    v.feed.report('http', S + 5n);
    assert.equal(v.feed.currentSlot(), null);
  });

  it('one channel: the second of two consistent readings at least 500 ms apart is adopted; 499 ms is too soon', () => {
    const w = world();
    w.feed.report('stream', S);
    w.at(499);
    w.feed.report('stream', S + 2n);
    assert.equal(w.feed.currentSlot(), null);
    w.at(500);
    w.feed.report('stream', S + 3n);
    assert.equal(w.feed.currentSlot(), S + 3n);
  });

  it('one channel: a base older than 5 s no longer counts (review T risk 1d)', () => {
    const w = world();
    w.feed.report('stream', S);
    w.at(5_001);
    w.feed.report('stream', S + 20n); // a new base, not a pair
    assert.equal(w.feed.currentSlot(), null);
    w.at(5_501);
    w.feed.report('stream', S + 22n);
    assert.equal(w.feed.currentSlot(), S + 22n);
  });

  it('one channel: no pair is adopted while another fresh channel disagrees with it', () => {
    const w = world();
    w.feed.report('http', S + 300n);
    w.feed.report('stream', S);
    w.at(600);
    w.feed.report('stream', S + 2n);
    assert.equal(w.feed.currentSlot(), null);
    w.at(2_700); // http's reading is stale now: the pair counts again
    w.feed.report('stream', S + 10n);
    w.at(3_300);
    w.feed.report('stream', S + 12n);
    assert.equal(w.feed.currentSlot(), S + 12n);
  });

  it('one channel: a lone wild first reading is never adopted; the next sane ones are', () => {
    const w = world();
    w.feed.report('stream', 10n ** 15n);
    w.at(600);
    w.feed.report('stream', S);
    assert.equal(w.feed.currentSlot(), null); // lower than the wild one: it replaces it
    w.at(1_200);
    w.feed.report('stream', S + 3n);
    assert.equal(w.feed.currentSlot(), S + 3n);
  });

  it('one channel: a wild second reading replaces the base and is never adopted', () => {
    const w = world();
    w.feed.report('stream', S);
    w.at(600);
    w.feed.report('stream', 10n ** 15n);
    assert.equal(w.feed.currentSlot(), null);
    w.at(700);
    w.feed.report('stream', S + 4n); // below the wild one: a new base
    w.at(1_300);
    w.feed.report('stream', S + 7n);
    assert.equal(w.feed.currentSlot(), S + 7n);
  });
});

describe('once anchored: the advance budget, the lead cap and agreement', () => {
  it('a higher reading within the budget is accepted and refreshes the age', () => {
    const w = anchored();
    w.at(1_000);
    w.feed.report('stream', S + 5n);
    w.at(2_900);
    assert.equal(w.feed.currentSlot(), S + 5n);
  });

  it('equal or lower readings change nothing: they neither raise the slot nor refresh its age', () => {
    const w = anchored();
    w.at(1_500);
    w.feed.report('http', S);
    w.feed.report('stream', S - 10n);
    w.at(2_000);
    assert.equal(w.feed.currentSlot(), S);
    w.at(2_001);
    assert.equal(w.feed.currentSlot(), null);
    assert.equal(w.feed.unknownSinceMs(), T0 + 2_001);
  });

  it('the budget: 150 slots at once; then it refills at 10 a second, and never holds more than 150', () => {
    const w = anchoredAlone(); // at S, 500 ms
    w.at(600);
    w.feed.report('stream', S + 150n);
    assert.equal(w.feed.currentSlot(), S + 150n);
    w.feed.report('stream', S + 151n); // the budget is spent
    assert.equal(w.feed.currentSlot(), S + 150n);
    assert.deepEqual(w.codes(), ['slot-implausible']);
    w.at(700); // 100 ms: one slot more
    w.feed.report('stream', S + 152n);
    assert.equal(w.feed.currentSlot(), S + 150n);
    w.feed.report('stream', S + 151n);
    assert.equal(w.feed.currentSlot(), S + 151n);
    // a steady +1 every second for 20 s: the budget refills to 150 and no further
    let slot = S + 151n;
    for (let t = 1_700; t <= 21_700; t += 1_000) {
      w.at(t);
      slot += 1n;
      w.feed.report('stream', slot);
    }
    assert.equal(w.feed.currentSlot(), slot);
    w.at(21_800); // 100 ms more: without the cap the budget would now hold about 190 slots
    w.feed.report('stream', slot + 151n);
    assert.equal(w.feed.currentSlot(), slot);
    w.feed.report('stream', slot + 150n);
    assert.equal(w.feed.currentSlot(), slot + 150n);
  });

  it('W1 (review T risk 1): one channel walking ahead in steps past the budget, or just inside it, never takes the feed more than the budget plus the rate', () => {
    const w = anchored();
    for (let k = 1; k <= 1_000; k += 1) {
      w.at(k);
      w.feed.report('http', S + 151n * BigInt(k));
    }
    assert.equal(w.feed.currentSlot(), S); // the stream at S is fresh: no reading may lead it by more than 150
    assert.ok(w.codes().includes('slot-implausible'));
    w.at(1_213);
    w.feed.report('stream', S + 5n);
    assert.equal(w.feed.currentSlot(), S + 5n); // honest readings are adopted at once
    const v = anchoredAlone();
    for (let k = 1; k <= 1_000; k += 1) {
      v.at(500 + k);
      v.feed.report('stream', S + 150n * BigInt(k));
    }
    const s = v.feed.currentSlot();
    assert.ok(s !== null && s - S <= 150n + 10n, `the feed moved ${String(s === null ? 'null' : s - S)} slots in 1 s`);
  });

  it('W2 (review T risk 1): a channel that runs at 10 slots a second against a chain at 4.7 never leads it by more than about 150, and slot-behind is raised', () => {
    const w = anchored();
    let honest = S;
    let liar = S;
    let worstLead = 0n;
    for (let t = 1; t <= 3_600_000; t += 1) {
      const honestDue = t % 213 === 0;
      const liarDue = t % 100 === 0;
      if (!honestDue && !liarDue) {
        continue;
      }
      w.at(t);
      if (honestDue) {
        honest = S + BigInt(Math.floor((t * 47) / 10_000));
        w.feed.report('stream', honest);
      }
      if (liarDue) {
        liar += 1n;
        w.feed.report('http', liar);
      }
      const s = w.feed.currentSlot();
      if (s !== null && s - honest > worstLead) {
        worstLead = s - honest;
      }
    }
    assert.ok(worstLead <= 155n, `the feed led the chain by ${worstLead} slots`);
    assert.ok(w.codes().includes('slot-behind'));
    assert.equal(w.feed.currentSlot(), null); // the two channels disagree: no slot is trusted, and the alerts say why
  });

  it('a held reading is adopted when another channel, above the accepted slot, agrees within 150 slots', () => {
    const w = anchored();
    w.feed.report('stream', S + 1_000n);
    assert.equal(w.feed.currentSlot(), S);
    w.at(1_000);
    w.feed.report('http-2', S + 1_120n);
    assert.equal(w.feed.currentSlot(), S + 1_120n);
  });

  it('an agreed jump spends the whole budget: the next small step waits for the refill', () => {
    const w = anchoredAlone(); // at S, 500 ms: no other channel can cap what follows
    w.feed.report('stream', S + 1_000n); // past the budget: held
    w.feed.report('http-2', S + 1_100n); // agrees with the stream's: adopted
    assert.equal(w.feed.currentSlot(), S + 1_100n);
    w.feed.report('stream', S + 1_110n); // 10 slots, but the budget is spent
    assert.equal(w.feed.currentSlot(), S + 1_100n);
    w.at(1_500); // 1 s later: 10 slots of budget
    w.feed.report('stream', S + 1_110n);
    assert.equal(w.feed.currentSlot(), S + 1_110n);
  });

  it('a held reading is not adopted by a channel that disagrees, nor by itself, nor by a channel below the accepted slot, nor after maxAgeMs', () => {
    const w = anchored();
    w.feed.report('stream', S + 1_000n);
    w.feed.report('http', S + 1_200n); // 200 slots from the held one: they disagree
    w.feed.report('stream', S + 1_001n); // 199 from http's, and its own earlier one does not count
    assert.equal(w.feed.currentSlot(), S);
    const u = anchored();
    u.feed.report('stream', S + 100n); // within the budget: 50 slots left
    u.feed.report('http', S + 60n); // fresh, but below the accepted slot
    u.feed.report('stream', S + 170n); // past the budget; 110 above http, which is not above the accepted slot
    assert.equal(u.feed.currentSlot(), S + 100n); // a lower channel agrees with no jump
    const v = anchored();
    v.feed.report('stream', S + 1_000n);
    v.at(2_001);
    v.feed.report('http', S + 1_010n);
    assert.equal(v.feed.currentSlot(), null); // stale; and the late reading is held, not adopted
  });

  it('one wild reading (10^15) after anchoring is ignored with an alert, the slot stays, and the next sane one is accepted', () => {
    const w = anchored();
    w.at(400);
    w.feed.report('stream', 10n ** 15n);
    assert.equal(w.feed.currentSlot(), S);
    w.at(800);
    w.feed.report('http', S + 2n);
    assert.equal(w.feed.currentSlot(), S + 2n);
    assert.deepEqual(w.codes(), ['slot-implausible']);
  });

  it('slot-behind (review T risk 1c, security 4): a channel more than 150 below at once, or more than 25 below for 10 s', () => {
    const w = anchoredAlone();
    w.at(600);
    w.feed.report('stream', S + 150n);
    w.feed.report('http', S - 1n); // 151 below: at once
    assert.deepEqual(w.codes(), ['slot-behind']);
    const v = anchoredAlone();
    v.at(600);
    v.feed.report('stream', S + 30n);
    let slot = S + 30n;
    for (let t = 600; t <= 10_600; t += 1_000) {
      v.at(t);
      slot += 3n;
      v.feed.report('stream', slot);
      v.feed.report('http', slot - 26n); // 26 below, every second
      if (t === 9_600) {
        assert.deepEqual(v.codes(), [], 'not before the 10 s');
      }
    }
    assert.deepEqual(v.codes(), ['slot-behind']); // raised once the 10 s have passed
    const u = anchoredAlone();
    let s = S;
    for (let t = 600; t <= 20_600; t += 1_000) {
      u.at(t);
      s += 3n;
      u.feed.report('stream', s);
      u.feed.report('http', s - 25n); // 25 below: within a token's life
    }
    assert.deepEqual(u.codes(), []);
  });
});

describe('the floor (review T security 1): a source that advances too slowly is not trusted', () => {
  it('F1: one slot every 1,900 ms is unknown once a 5 s window shows it, with slot-slow; it never passes as fresh for long', () => {
    const w = anchored();
    let slot = S;
    let knownAfterWindow = 0;
    for (let t = 1_900; t <= 36_100; t += 1_900) {
      w.at(t);
      slot += 1n;
      w.feed.report('http', slot);
      if (t >= 5_700 && w.feed.currentSlot() !== null) {
        knownAfterWindow += 1;
      }
    }
    assert.ok(w.codes().includes('slot-slow'));
    w.at(5_700);
    assert.ok(knownAfterWindow <= 4, `known on ${knownAfterWindow} checks after the first window`);
  });

  it('after a long healthy run, a source that turns slow is caught within a window or two: the window moves on, it does not average over the past', () => {
    const w = anchored();
    let slot = S;
    for (let t = 400; t <= 60_000; t += 400) {
      w.at(t);
      slot = S + BigInt(t / 400);
      w.feed.report('stream', slot);
    }
    assert.notEqual(w.feed.currentSlot(), null);
    let unknownAt: number | null = null;
    for (let t = 61_900; t <= 80_000; t += 1_900) {
      w.at(t);
      slot += 1n;
      w.feed.report('stream', slot);
      if (unknownAt === null && w.feed.currentSlot() === null) {
        unknownAt = t;
      }
    }
    assert.ok(unknownAt !== null && unknownAt - 60_000 <= 12_000, `unknown after ${String(unknownAt === null ? 'never' : unknownAt - 60_000)} ms of the slow source`);
  });

  it('a chain at 2.5 slots a second (400 ms slots) stays known through many windows', () => {
    const w = anchored();
    for (let t = 400; t <= 60_000; t += 400) {
      w.at(t);
      w.feed.report('stream', S + BigInt(t / 400));
      assert.notEqual(w.feed.currentSlot(), null, String(t));
    }
    assert.deepEqual(w.codes(), []);
  });
});

describe('the clock (review T risk 2): a step back restarts the cold start; a long unknown too', () => {
  it('a clock one hour behind: the feed restarts with slot-clock-back, and honest readings make it known again within 1 s', () => {
    const w = anchored();
    const back = -3_600_000;
    w.at(back);
    assert.equal(w.feed.currentSlot(), null);
    assert.equal(w.feed.unknownSinceMs(), T0 + back);
    assert.deepEqual(w.codes(), ['slot-clock-back']);
    let knownAt: number | null = null;
    for (let t = back; t <= back + 3_000; t += 400) {
      w.at(t);
      const slot = S + 10n + BigInt((t - back) / 400);
      w.feed.report('stream', slot);
      w.feed.report('http', slot);
      if (knownAt === null && w.feed.currentSlot() !== null) {
        knownAt = t;
      }
    }
    assert.ok(knownAt !== null && knownAt - back <= 1_000, `known again after ${String(knownAt === null ? 'never' : knownAt - back)} ms`);
  });

  it('a clock one hour behind with one channel only: two of its readings 500 ms apart restore the slot', () => {
    const w = anchoredAlone();
    w.at(-3_600_000);
    w.feed.report('stream', S + 5n);
    assert.equal(w.feed.currentSlot(), null);
    w.at(-3_600_000 + 500);
    w.feed.report('stream', S + 7n);
    assert.equal(w.feed.currentSlot(), S + 7n);
  });

  it('a clock one day ahead: the old slot is stale, a reading 864,000 slots ahead is not adopted at once, and never while an honest channel disputes it', () => {
    const w = anchored();
    const day = 86_400_000;
    w.at(day);
    w.feed.report('http', S + 864_000n);
    assert.equal(w.feed.currentSlot(), null);
    w.feed.report('stream', S + 3n); // the chain did not jump: only the clock did
    w.at(day + 600);
    w.feed.report('http', S + 864_006n);
    w.feed.report('stream', S + 5n);
    assert.equal(w.feed.currentSlot(), null); // the two channels disagree
    assert.ok(w.codes().includes('slot-disagree'));
  });

  it('15 s of unknown: back to a cold start, where one reading alone is not enough', () => {
    const w = anchored();
    w.at(2_001);
    assert.equal(w.feed.currentSlot(), null);
    w.at(17_001);
    assert.equal(w.feed.unknownSinceMs(), T0 + 2_001);
    w.feed.report('http', S + 70n); // within the old budget, but the feed has restarted
    assert.equal(w.feed.currentSlot(), null);
    w.at(17_501);
    w.feed.report('http', S + 72n);
    assert.equal(w.feed.currentSlot(), S + 72n);
    assert.equal(w.feed.unknownSinceMs(), null);
  });
});

describe('malformed readings and a stale feed', () => {
  it('not a bigint, below 1, above 2^63-1 (u64 max included), or an unknown channel: ignored and alerted at most once a minute', () => {
    const w = anchored();
    for (const bad of [5, '400000001', 0n, -1n, 2n ** 63n, 2n ** 64n - 1n, null, undefined]) {
      w.feed.report('stream', bad);
    }
    w.feed.report('ws' as SlotChannel, S + 1n);
    assert.equal(w.feed.currentSlot(), S);
    assert.deepEqual(w.codes(), ['slot-malformed']);
    w.at(59_999);
    w.feed.report('stream', 0n);
    assert.deepEqual(w.codes(), ['slot-malformed']);
    w.at(60_000);
    w.feed.report('stream', 0n);
    assert.deepEqual(w.codes(), ['slot-malformed', 'slot-malformed']);
    assert.ok(w.alerts.every((a) => a.severity === 'warn'));
  });

  it('stale after maxAgeMs: known at exactly 2,000 ms, unknown at 2,001, since then; known again on a new reading within 15 s', () => {
    const w = anchored();
    w.at(2_000);
    assert.equal(w.feed.currentSlot(), S);
    assert.equal(w.feed.unknownSinceMs(), null);
    w.at(2_001);
    assert.equal(w.feed.currentSlot(), null);
    w.at(10_000);
    assert.equal(w.feed.unknownSinceMs(), T0 + 2_001);
    w.feed.report('http', S + 40n);
    assert.equal(w.feed.currentSlot(), S + 40n);
    assert.equal(w.feed.unknownSinceMs(), null);
  });

  it('a smaller maxAgeMs shortens the life of a reading', () => {
    const w = anchored({ maxAgeMs: 1 });
    w.at(1);
    assert.equal(w.feed.currentSlot(), S);
    w.at(2);
    assert.equal(w.feed.currentSlot(), null);
  });
});

describe('the feed never throws once made, and refuses options it cannot use', () => {
  it('report takes any value on any channel without a throw, and currentSlot stays a bigint or null', () => {
    const w = anchored();
    fc.assert(
      fc.property(fc.oneof(fc.constantFrom('stream', 'http', 'http-2'), fc.string()), fc.oneof(fc.anything(), fc.bigInt()), fc.integer({ min: -5_000, max: 5_000 }), (channel, slot, step) => {
        w.at(step);
        w.feed.report(channel as SlotChannel, slot);
        const s = w.feed.currentSlot();
        assert.ok(s === null || (typeof s === 'bigint' && s >= 1n && s < 2n ** 63n));
        const since = w.feed.unknownSinceMs();
        assert.ok((s === null) === (since !== null));
      }),
      { numRuns: 1_000 },
    );
  });

  it('a clock or an alert sink that throws is contained: report and currentSlot give no throw (unknown instead)', () => {
    let fail = false;
    const feed = createSlotFeed({
      ...SLOT_FEED_DEFAULTS,
      clock: {
        now: () => {
          if (fail) {
            throw new Error('clock broke');
          }
          return T0;
        },
      },
      alerts: {
        alert: () => {
          throw new Error('alerts broke');
        },
      },
    });
    feed.report('stream', S);
    feed.report('http', S);
    feed.report('stream', 0n); // its alert throws: contained
    assert.equal(feed.currentSlot(), S);
    fail = true;
    feed.report('stream', S + 1n);
    assert.equal(feed.currentSlot(), null);
    assert.equal(feed.unknownSinceMs(), T0); // the clock is not readable: as unknown as it gets
  });

  it('a clock that gives a fraction of a millisecond or NaN: each reading is malformed, and the alert is not repeated while the clock is unreadable', () => {
    let now = T0;
    const alerts: Alert[] = [];
    const feed = createSlotFeed({ ...SLOT_FEED_DEFAULTS, clock: { now: () => now }, alerts: { alert: (a) => alerts.push(a) } });
    now = T0 + 0.5;
    feed.report('stream', S);
    assert.deepEqual(
      alerts.map((a) => a.code),
      ['slot-malformed'],
      'a fraction of a millisecond is no reading time',
    );
    now = Number.NaN;
    feed.report('http', S);
    feed.report('stream', S);
    assert.deepEqual(
      alerts.map((a) => a.code),
      ['slot-malformed'],
    );
    assert.equal(feed.currentSlot(), null);
  });

  it('a feed is not made on a clock that does not give whole milliseconds', () => {
    for (const bad of [T0 + 0.5, Number.NaN, Number.POSITIVE_INFINITY, '0']) {
      assert.throws(() => createSlotFeed({ ...SLOT_FEED_DEFAULTS, clock: { now: () => bad as number }, alerts: { alert: () => undefined } }), TypeError);
    }
  });

  it('options outside their ranges are refused', () => {
    const ok: SlotFeedOptions = { ...SLOT_FEED_DEFAULTS, clock: { now: () => T0 }, alerts: { alert: () => undefined } };
    const bad: readonly Partial<Record<keyof SlotFeedOptions, unknown>>[] = [
      { maxAgeMs: 0 },
      { maxAgeMs: 2_501 },
      { maxAgeMs: 1.5 },
      { maxSlotsPerSecond: 0 },
      { maxSlotsPerSecond: 51 },
      { toleranceSlots: -1 },
      { toleranceSlots: 1_001 },
      { agreeSlots: -1 },
      { agreeSlots: 1_001 },
      { clock: {} },
      { clock: null },
      { alerts: { notify: () => undefined } },
    ];
    for (const patch of bad) {
      assert.throws(() => createSlotFeed({ ...ok, ...patch } as SlotFeedOptions), TypeError, JSON.stringify(Object.keys(patch)));
    }
    assert.ok(Object.isFrozen(createSlotFeed(ok)));
  });
});
