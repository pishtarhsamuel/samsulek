// Two processes on one database file (STORAGE_DESIGN.md s.5 and s.6; VERIFIED_FACTS U10): another
// process holding the write lock makes our transaction fail with `busy` after the busy timeout,
// and a process that dies in the middle of a transaction leaves nothing behind. The child
// processes run with the same flags as the tests (and the no-secrets marker), and they work on
// Windows too.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { count, fileDb, removeDir, storageError, tempDir } from './helpers.ts';

const SQLITE_TS = pathToFileURL(path.resolve(import.meta.dirname, '../../../src/storage/sqlite.ts')).href;
const NO_SECRETS = pathToFileURL(path.resolve(import.meta.dirname, '../../setup/no-secrets.ts')).href;
const FLAGS = ['--frozen-intrinsics', '--disallow-code-generation-from-strings', '--no-warnings', '--import', NO_SECRETS];

interface Running {
  readonly done: Promise<{ code: number | null; output: string }>;
  readonly kill: () => void;
}

/** Starts a child that runs `body` with `openDb` imported and the file name as `file`. */
function runChild(dir: string, name: string, file: string, body: string): Running {
  const script = path.join(dir, `${name}.mjs`);
  writeFileSync(
    script,
    [
      `import { openDb } from ${JSON.stringify(SQLITE_TS)};`,
      "import { existsSync, writeFileSync } from 'node:fs';",
      `const file = ${JSON.stringify(file)};`,
      `const dir = ${JSON.stringify(dir)};`,
      'void existsSync; void writeFileSync; void dir;',
      body,
    ].join('\n'),
  );
  const child = spawn(process.execPath, [...FLAGS, script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const done = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
  return { done, kill: () => child.kill() };
}

async function waitFor(file: string, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (!existsSync(file)) {
    if (Date.now() > until) {
      throw new Error(`timed out waiting for ${path.basename(file)}`);
    }
    await delay(10);
  }
}

describe('two processes on one file', () => {
  it('another process holding the write lock: ours gets busy after the timeout, and succeeds after it commits', async () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, 'bot.sqlite');
      const db = fileDb(file);
      db.transaction((tx) => tx.script('CREATE TABLE t (id TEXT PRIMARY KEY) STRICT'));
      const ready = path.join(dir, 'ready');
      const release = path.join(dir, 'release');
      const child = runChild(
        dir,
        'holder',
        file,
        [
          'const db = openDb(file, { busyTimeoutMs: 5000, create: false });',
          'db.transaction((tx) => {',
          "  tx.run(\"INSERT INTO t (id) VALUES ('from-child')\");",
          `  writeFileSync(${JSON.stringify(ready)}, 'ready');`,
          '  const until = Date.now() + 20000;',
          `  while (!existsSync(${JSON.stringify(release)}) && Date.now() < until) { /* hold the lock */ }`,
          '  return 0;',
          '});',
          'db.close();',
        ].join('\n'),
      );
      try {
        await waitFor(ready, 20_000);
        const started = Date.now();
        storageError(() => db.transaction((tx) => tx.run("INSERT INTO t (id) VALUES ('from-parent')")), 'busy');
        assert.ok(Date.now() - started >= 80, 'it waited for the busy timeout first');
      } catch (e) {
        child.kill(); // never leave it holding the lock on a folder about to be removed (review O)
        throw e;
      } finally {
        writeFileSync(release, 'go');
      }
      const result = await child.done;
      assert.equal(result.code, 0, result.output);
      db.transaction((tx) => tx.run("INSERT INTO t (id) VALUES ('from-parent')"));
      assert.deepEqual(db.all('SELECT id FROM t ORDER BY id').map((r) => r['id']), ['from-child', 'from-parent']);
      db.close();
    } finally {
      removeDir(dir);
    }
  });

  it('a process that exits in the middle of a transaction leaves nothing behind, and the file is healthy', async () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, 'bot.sqlite');
      const db = fileDb(file);
      db.transaction((tx) => tx.script('CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT) STRICT'));
      db.transaction((tx) => tx.run("INSERT INTO t (id, v) VALUES ('kept', 'x')"));
      db.close();
      const { done } = runChild(
        dir,
        'crasher',
        file,
        [
          'const db = openDb(file, { busyTimeoutMs: 5000, create: false });',
          'db.transaction((tx) => {',
          '  for (let i = 0; i < 2000; i += 1) {',
          "    tx.run('INSERT INTO t (id, v) VALUES (?, ?)', `lost-${i}`, 'y'.repeat(300));",
          '  }',
          "  tx.run(\"UPDATE t SET v = 'changed' WHERE id = 'kept'\");",
          '  process.exit(3);',
          '});',
        ].join('\n'),
      );
      const result = await done;
      assert.equal(result.code, 3, result.output);
      const again = fileDb(file, false);
      try {
        assert.deepEqual(again.quickCheck(), []);
        assert.equal(count(again, 't'), 1n);
        assert.equal(again.get("SELECT v FROM t WHERE id = 'kept'")?.['v'], 'x');
      } finally {
        again.close();
      }
    } finally {
      removeDir(dir);
    }
  });
});
