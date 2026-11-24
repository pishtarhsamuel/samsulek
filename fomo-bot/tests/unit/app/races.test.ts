// Races on one database file (STORAGE_DESIGN.md s.16.9, condition C3; VERIFIED_FACTS V3 and V8):
// - deterministic: inside connection A's T1, connection B's T1 runs on the same file and gets busy
//   after its timeout, unrecorded; once A commits, B is refused by the room A took (the position
//   cap, the day's entry count, the exposure cap);
// - parallel: two to six processes race for the last room in 50 seeded rounds: exactly one is
//   approved, the rest are refused by the cap (none busy: V3), and the database stays inside every cap;
// - a KILL another process commits stops the next entry, and a buy token issued before it;
// - a process that dies inside a transaction leaves nothing behind;
// - a plain read on a second connection does not wait for a writer (V8).
// Free SOL cannot be the last room under the paper caps: exposure (50% of equity) binds first, as the
// arithmetic in s.16.15 shows, so the rooms are the positions, the entries and the exposure.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { approveBuyTx, peekExitIntent, type EntryOutcome } from '../../../src/app/approve-tx.ts';
import { firstVersion, nextVersion } from '../../../src/config/changes.ts';
import { DEFAULT_TUNABLES, withValue } from '../../../src/config/tunables.ts';
import { athensDay } from '../../../src/core/day.ts';
import { lamports } from '../../../src/core/units.ts';
import { insertOpening, readActivePositions } from '../../../src/storage/repo-book.ts';
import { insertSnapshot } from '../../../src/storage/repo-observe.ts';
import { countEntry, entriesOn, readFlags } from '../../../src/storage/repo-flags.ts';
import { setStrategyMode, writeOwnerConfig } from '../../../src/storage/repo-owner.ts';
import type { Db } from '../../../src/storage/sqlite.ts';
import { fileDb, removeDir, tempDir } from '../storage/helpers.ts';
import { T, setUpDb } from './world.ts';
import { SLOT, SMALL_MARKET, SMALL_PLAN, entryRequest, openPosition, txWorld } from './tx-world.ts';

const url = (rel: string): string => pathToFileURL(path.resolve(import.meta.dirname, rel)).href;
const NO_SECRETS = url('../../setup/no-secrets.ts');
const FLAGS = ['--frozen-intrinsics', '--disallow-code-generation-from-strings', '--no-warnings', '--import', NO_SECRETS];
const IMPORTS = [
  `import { openDb } from ${JSON.stringify(url('../../../src/storage/sqlite.ts'))};`,
  `import { approveBuyTx } from ${JSON.stringify(url('../../../src/app/approve-tx.ts'))};`,
  `import { setKill } from ${JSON.stringify(url('../../../src/storage/repo-flags.ts'))};`,
  `import { SMALL_MARKET, SMALL_PLAN, entryRequest, txWorld } from ${JSON.stringify(url('./tx-world.ts'))};`,
].join('\n');
const DAY = athensDay(T);
const show = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));

type Room = 'positions' | 'entries' | 'exposure';
const ROOMS: readonly Room[] = ['positions', 'entries', 'exposure'];

/** One room left: three of four positions, seven of eight entries, or 20M of a 55M exposure cap. */
function leaveOneRoom(db: Db, room: Room): void {
  if (room === 'positions') {
    db.transaction((tx) => {
      for (const i of [1, 2, 3]) {
        insertOpening(tx, { id: `ps_held${i}`, mint: `MintHeld${i}`, strategy: 'momentum', mode: 'paper', openedAt: T - 5_000, maxSpend: lamports(30_000_000n) }, lamports(125_000n));
      }
    });
  } else if (room === 'entries') {
    db.transaction((tx) => {
      for (let i = 0; i < 7; i += 1) {
        countEntry(tx, DAY);
      }
    });
  } else {
    const v1 = firstVersion(DEFAULT_TUNABLES, T);
    db.transaction((tx) => writeOwnerConfig(tx, T, 'owner-telegram', 'owner:set', { version: nextVersion(v1, withValue(v1.values, 'risk.exposurePctBps', 1_000), 'owner', T), pending: [], cancelled: [] }));
    db.transaction((tx) => insertOpening(tx, { id: 'ps_held1', mint: 'MintHeld1', strategy: 'momentum', mode: 'paper', openedAt: T - 5_000, maxSpend: lamports(20_000_000n) }, lamports(125_000n)));
  }
}

/** What refuses the loser of each room. */
function refusedFor(room: Room, o: EntryOutcome): boolean {
  if (o.kind !== 'refused') {
    return false;
  }
  return room === 'positions' ? o.reasons.includes('max-positions') : room === 'entries' ? o.reasons.includes('entries-per-day') : o.stage === 'sizing';
}

/** Every cap holds on the stored rows: at most four active positions, eight entries, 55M exposure when it was the room. */
function capsHold(db: Db, room: Room): void {
  const active = readActivePositions(db);
  assert.ok(active.length <= 4, `${active.length} active positions`);
  assert.equal(new Set(active.map((p) => p.mint)).size, active.length, 'one position per mint');
  assert.ok(entriesOn(db, DAY) <= 8);
  if (room === 'exposure') {
    const held = active.reduce((sum, p) => sum + (p.maxSpend ?? 0n), 0n);
    assert.ok(held <= 55_000_000n, `exposure ${held}`);
  }
}

describe('races on one database file (C3)', () => {
  for (const room of ROOMS) {
    it(`deterministic, the ${room} as the last room: B inside A's transaction is busy and unrecorded; after A commits, B is refused`, () => {
      const dir = tempDir();
      try {
        const file = path.join(dir, 'bot.sqlite');
        const a = txWorld(setUpDb(file));
        leaveOneRoom(a.db, room);
        const b = txWorld(fileDb(file, false), { setUp: false }); // 100 ms busy timeout
        const plan = room === 'exposure' ? SMALL_PLAN : {};
        const market = room === 'exposure' ? { market: SMALL_MARKET } : {};
        const reqB = entryRequest({ mint: 'MintB', positionId: 'ps_b', ...market }, plan);
        let inner: EntryOutcome | null = null;
        const slots = {
          currentSlot: (): bigint => {
            if (inner === null) {
              inner = approveBuyTx(b.deps, reqB); // A holds BEGIN IMMEDIATE now
            }
            return SLOT;
          },
        };
        const outcome = approveBuyTx({ ...a.deps, slots }, entryRequest({ mint: 'MintA', positionId: 'ps_a', ...market }, plan));
        assert.equal(outcome.kind, 'approved', show(outcome));
        assert.deepEqual(inner, { kind: 'error', code: 'error:storage-busy', scope: 'intent', recorded: false });
        const after = approveBuyTx(b.deps, reqB);
        assert.ok(refusedFor(room, after), show(after));
        capsHold(a.db, room);
        a.db.close();
        b.db.close();
      } finally {
        removeDir(dir);
      }
    });
  }

  it('parallel: two to six processes race for the last room, 50 seeded rounds: exactly one approved, the rest refused by the cap, none busy (V3)', { timeout: 300_000 }, async () => {
    const dir = tempDir();
    const children: { child: ChildProcessWithoutNullStreams; lines: string[]; waiting: ((line: string) => void) | null }[] = [];
    try {
      const script = path.join(dir, 'racer.mjs');
      writeFileSync(
        script,
        [
          IMPORTS,
          "import { createInterface } from 'node:readline';",
          'let w = null;',
          'let req = null;',
          'const rl = createInterface({ input: process.stdin });',
          "rl.on('line', (line) => {",
          '  const m = JSON.parse(line);',
          "  if (m.op === 'round') {",
          '    if (w !== null) { w.db.close(); }',
          '    w = txWorld(openDb(m.file, { busyTimeoutMs: 5000, create: false }), { setUp: false });',
          '    req = entryRequest({ mint: m.mint, positionId: m.positionId, ...(m.small ? { market: SMALL_MARKET } : {}) }, m.small ? SMALL_PLAN : {});',
          "    process.stdout.write(JSON.stringify({ op: 'ready' }) + '\\n');",
          "  } else if (m.op === 'go') {",
          '    const o = approveBuyTx(w.deps, req);',
          "    process.stdout.write(JSON.stringify({ op: 'done', kind: o.kind, stage: o.stage ?? null, reasons: o.reasons ?? null, code: o.code ?? null }) + '\\n');",
          '  } else {',
          '    if (w !== null) { w.db.close(); }',
          '    rl.close();',
          '  }',
          '});',
        ].join('\n'),
      );
      for (let i = 0; i < 6; i += 1) {
        const child = spawn(process.execPath, [...FLAGS, script], { stdio: ['pipe', 'pipe', 'pipe'] });
        const entry = { child, lines: [] as string[], waiting: null as ((line: string) => void) | null };
        let buffer = '';
        child.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
            const line = buffer.slice(0, at);
            buffer = buffer.slice(at + 1);
            const take = entry.waiting;
            if (take !== null) {
              entry.waiting = null;
              take(line);
            } else {
              entry.lines.push(line);
            }
          }
        });
        let errors = '';
        child.stderr.on('data', (chunk: Buffer) => {
          errors += chunk.toString('utf8');
        });
        child.on('close', (code) => {
          if (code !== 0 && code !== null) {
            entry.waiting?.(JSON.stringify({ op: 'died', errors }));
          }
        });
        children.push(entry);
      }
      const next = (i: number): Promise<Record<string, unknown>> =>
        new Promise((resolve) => {
          const entry = children[i] as (typeof children)[number];
          const early = entry.lines.shift();
          const done = (line: string): void => resolve(JSON.parse(line) as Record<string, unknown>);
          if (early !== undefined) {
            done(early);
          } else {
            entry.waiting = done;
          }
        });
      const send = (i: number, m: unknown): void => {
        (children[i] as (typeof children)[number]).child.stdin.write(`${JSON.stringify(m)}\n`);
      };
      // a seeded generator: the same 50 rounds on every run
      let seed = 0x6d2;
      const rand = (n: number): number => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return seed % n;
      };
      let busy = 0;
      for (let round = 0; round < 50; round += 1) {
        const n = 2 + rand(5);
        const room = ROOMS[rand(ROOMS.length)] as Room;
        const file = path.join(dir, `round-${round}.sqlite`);
        const db = setUpDb(file);
        db.transaction((tx) => {
          setStrategyMode(tx, T - 1, 'owner-telegram', 'momentum', 'paper');
          insertSnapshot(tx, 'paper', T, lamports(550_000_000n), lamports(550_000_000n)); // the money check T1 needs fresh (6e-2)
        });
        leaveOneRoom(db, room);
        for (let i = 0; i < n; i += 1) {
          send(i, { op: 'round', file, mint: `MintR${round}C${i}`, positionId: `ps_r${round}c${i}`, small: room === 'exposure' });
        }
        for (let i = 0; i < n; i += 1) {
          assert.deepEqual(await next(i), { op: 'ready' }, `round ${round}, child ${i}`);
        }
        for (let i = 0; i < n; i += 1) {
          send(i, { op: 'go' });
        }
        const outcomes: Record<string, unknown>[] = [];
        for (let i = 0; i < n; i += 1) {
          outcomes.push(await next(i));
        }
        const approved = outcomes.filter((o) => o['kind'] === 'approved').length;
        assert.equal(approved, 1, `round ${round} (${room}, ${n} racers): ${JSON.stringify(outcomes)}`);
        for (const o of outcomes.filter((x) => x['kind'] !== 'approved')) {
          if (o['kind'] === 'error') {
            assert.equal(o['code'], 'error:storage-busy', JSON.stringify(o));
            busy += 1;
          } else {
            assert.ok(refusedFor(room, o as unknown as EntryOutcome), `round ${round}: ${JSON.stringify(o)}`);
          }
        }
        capsHold(db, room);
        db.close();
      }
      assert.equal(busy, 0, 'V3: no racer got busy before its 5 s timeout');
    } finally {
      for (const entry of children) {
        entry.child.stdin.end(`${JSON.stringify({ op: 'quit' })}\n`);
      }
      await Promise.all(children.map((entry) => new Promise<void>((resolve) => (entry.child.exitCode !== null ? resolve() : entry.child.on('close', () => resolve())))));
      removeDir(dir);
    }
  });

  it('a KILL another process commits stops the next entry, and the buy token issued before it (T2 sees KILL through the latch)', async () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, 'bot.sqlite');
      const w = txWorld(setUpDb(file));
      const before = approveBuyTx(w.deps, entryRequest());
      assert.equal(before.kind, 'approved');
      const script = path.join(dir, 'kill.mjs');
      writeFileSync(script, [IMPORTS, `const db = openDb(${JSON.stringify(file)}, { busyTimeoutMs: 5000, create: false });`, `db.transaction((tx) => setKill(tx, ${T + 1}, 'cli'));`, 'db.close();'].join('\n'));
      const code = await new Promise<number | null>((resolve) => spawn(process.execPath, [...FLAGS, script], { stdio: 'ignore' }).on('close', resolve));
      assert.equal(code, 0);
      const next = approveBuyTx(w.deps, entryRequest({ mint: 'MintB', positionId: 'ps_b' }));
      assert.ok(next.kind === 'refused' && next.reasons.includes('kill'), show(next));
      assert.equal(w.latch.killSeen(), true);
      assert.ok(before.kind === 'approved' && !w.authority.redeemer.redeem(before.token, before.plan).ok);
      assert.equal(w.db.get('SELECT count(*) AS n FROM orders')?.['n'], 0n);
      assert.equal(readFlags(w.db).kill?.source, 'cli');
      w.db.close();
    } finally {
      removeDir(dir);
    }
  });

  it('a process that dies inside T1 leaves nothing behind, and the file is healthy', async () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, 'bot.sqlite');
      const seeded = txWorld(setUpDb(file));
      seeded.db.close();
      const script = path.join(dir, 'crash.mjs');
      writeFileSync(
        script,
        [
          IMPORTS,
          `const w = txWorld(openDb(${JSON.stringify(file)}, { busyTimeoutMs: 5000, create: false }), { setUp: false });`,
          'const slots = { currentSlot: () => process.exit(1) };',
          'approveBuyTx({ ...w.deps, slots }, entryRequest());',
        ].join('\n'),
      );
      const code = await new Promise<number | null>((resolve) => spawn(process.execPath, [...FLAGS, script], { stdio: 'ignore' }).on('close', resolve));
      assert.equal(code, 1);
      const db = fileDb(file, false);
      assert.deepEqual(db.quickCheck(), []);
      assert.deepEqual(['intents', 'positions', 'approvals', 'entry_counts'].map((t) => db.get(`SELECT count(*) AS n FROM ${t}`)?.['n']), [0n, 0n, 0n, 0n]);
      db.close();
    } finally {
      removeDir(dir);
    }
  });

  it('V8: a plain read on a second connection does not wait while the first holds BEGIN IMMEDIATE (peekExitIntent)', () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, 'bot.sqlite');
      const a = txWorld(setUpDb(file));
      openPosition(a.db, 'ps_1');
      const reader = fileDb(file, false); // 100 ms busy timeout: a wait would end in busy
      const seen = a.db.transaction((tx) => {
        tx.run("UPDATE positions SET exit_seq = 5 WHERE id = 'ps_1'"); // uncommitted
        return peekExitIntent({ db: reader }, 'ps_1');
      });
      assert.equal(seen.exitSeq, 0, 'the reader sees the last committed row, at once');
      assert.equal(peekExitIntent({ db: reader }, 'ps_1').exitSeq, 5);
      reader.close();
      a.db.close();
    } finally {
      removeDir(dir);
    }
  });
});
