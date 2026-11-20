// C18 (review P; STORAGE_DESIGN.md s.16.12 V2): openDb's chmod failure branch, for real. A child
// process running as uid and gid 65534 (nobody) opens a root-owned 0666 database: SQLite could read
// and write it, but the owner-only chmod that openDb makes before WAL starts fails with EPERM, so the
// open refuses with StorageError io and the connection is closed. setuid needs root, so the test runs
// only as root on POSIX; the node binary is hard-linked into a folder the child can enter (the one in
// use may sit in a private folder), and the child runs the source straight from the checkout.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, linkSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { migratedDb, removeDir } from './helpers.ts';

const NOBODY = 65_534;
const ROOT = process.platform !== 'win32' && process.getuid?.() === 0;
const SQLITE_TS = path.resolve(import.meta.dirname, '../../../src/storage/sqlite.ts');

/** Every folder from the root down to the source can be entered and read by others (the child is nobody). */
function sourceReadableByOthers(): boolean {
  let dir = path.dirname(SQLITE_TS);
  for (;;) {
    if ((statSync(dir).mode & 0o005) !== 0o005) {
      return false;
    }
    const up = path.dirname(dir);
    if (up === dir) {
      return true;
    }
    dir = up;
  }
}

describe('openDb: a chmod that fails refuses the open (C18, V2)', { skip: ROOT ? false : 'setuid needs root on POSIX' }, () => {
  it('a child as uid 65534 opening a root-owned 0666 database gets StorageError io (EPERM)', (t) => {
    if (!sourceReadableByOthers()) {
      t.skip('the checkout cannot be read by uid 65534 here');
      return;
    }
    const dir = mkdtempSync(path.join(tmpdir(), 'fomo-c18-'));
    try {
      chmodSync(dir, 0o777);
      const node = path.join(dir, 'node');
      try {
        linkSync(process.execPath, node);
      } catch {
        t.skip('the node binary cannot be hard-linked into the temp folder (another file system)');
        return;
      }
      const file = path.join(dir, 'root-owned.sqlite');
      migratedDb(file).close(); // a real database, owned by root
      chmodSync(file, 0o666);
      const script = path.join(dir, 'open.mjs');
      writeFileSync(
        script,
        [
          `import { openDb, StorageError } from ${JSON.stringify(pathToFileURL(SQLITE_TS).href)};`,
          'try {',
          `  openDb(${JSON.stringify(file)}, { busyTimeoutMs: 100, create: false }).close();`,
          "  console.log('opened');",
          '} catch (e) {',
          "  console.log(e instanceof StorageError ? `${e.code} ${e.detail}` : `other ${String(e)}`);",
          '}',
        ].join('\n'),
        { mode: 0o644 },
      );
      const r = spawnSync(node, ['--no-warnings', script], { cwd: dir, uid: NOBODY, gid: NOBODY, encoding: 'utf8', timeout: 60_000 });
      assert.equal(r.error, undefined, String(r.error));
      assert.equal(r.stdout.trim(), 'io cannot make the file readable by its owner only (EPERM)', r.stderr);
      assert.equal(statSync(file).mode & 0o777, 0o666, 'the file is as it was');
      assert.equal(statSync(file).uid, 0);
    } finally {
      removeDir(dir);
    }
  });
});
