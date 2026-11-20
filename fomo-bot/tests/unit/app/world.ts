// Shared fakes for the app/ tests (STORAGE_DESIGN.md s.16.9): a clock the test moves, a recording
// alert sink, a test Rng (a fixed key per seed, counter ids), a KILL sentinel the test switches, and
// a migrated database with the owner's setup (config version 1 and both ledger accounts). Nothing
// here touches fomo-bot/data/: databases are in memory or in temp folders.
import type { Alert, AlertSink, KillSentinel } from '../../../src/app/faults.ts';
import type { Clock } from '../../../src/app/slots.ts';
import { firstVersion } from '../../../src/config/changes.ts';
import { DEFAULT_TUNABLES } from '../../../src/config/tunables.ts';
import { lamports } from '../../../src/core/units.ts';
import type { Rng } from '../../../src/core/rng.ts';
import { setUpConfig, setUpLedger } from '../../../src/storage/repo-server.ts';
import type { Db } from '../../../src/storage/sqlite.ts';
import { TEST_NOW, migratedDb } from '../storage/helpers.ts';

export const T = TEST_NOW;

export interface TestClock extends Clock {
  set(ms: number): void;
  advance(ms: number): void;
}

export function testClock(start = T): TestClock {
  let now = start;
  return {
    now: () => now,
    set: (ms) => {
      now = ms;
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

export interface RecordingAlerts extends AlertSink {
  readonly seen: Alert[];
  codes(): string[];
}

export function recordingAlerts(): RecordingAlerts {
  const seen: Alert[] = [];
  return { seen, alert: (a) => void seen.push(a), codes: () => seen.map((a) => a.code) };
}

/** The bytes of the test key of this seed (fake). */
export const testKeyBytes = (seed: number): Uint8Array => Uint8Array.from({ length: 32 }, (_v, i) => (i * 13 + seed * 71 + 1) % 256);

export interface TestRng extends Rng {
  /** Every key array handed out, to check the caller wiped it. */
  readonly keys: Uint8Array[];
}

/** A fixed key for the seed (registering it again adds no form) and counter ids such as tk_00...01. */
export function testRng(seed = 1): TestRng {
  let n = 0;
  const keys: Uint8Array[] = [];
  const id = (prefix: string): string => `${prefix}_${(n += 1).toString(16).padStart(32, '0')}`;
  return {
    keys,
    approvalKey: () => {
      const k = testKeyBytes(seed);
      keys.push(k);
      return k;
    },
    tokenId: () => id('tk'),
    positionId: () => id('ps'),
    orderId: () => id('or'),
  };
}

export interface TestSentinel extends KillSentinel {
  on: boolean;
}

export const testSentinel = (): TestSentinel => {
  const s = {
    on: false,
    present: (): boolean => s.on,
  };
  return s;
};

/** A database with migration 1 and the owner's setup: config version 1, paper at 0.55 SOL, live at zero. */
export function setUpDb(file = ':memory:'): Db {
  const db = migratedDb(file);
  db.transaction((tx) => {
    setUpConfig(tx, T, firstVersion(DEFAULT_TUNABLES, T));
    setUpLedger(tx, T, lamports(550_000_000n));
  });
  return db;
}
