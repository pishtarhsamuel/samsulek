// The run folder's two small files and the real file-system probe (STORAGE_DESIGN.md s.16.3, s.16.6;
// review T's conditions for 6d-3): the KILL file reads as present on any doubt, an error that is not
// "no such file" included; the audit anchor is written 0600 by a write and a rename (V5), read back
// strictly (anything malformed throws), and null when there is none; the probe reports what the boot
// checks, the hard-link count included. Written before src/app/run-files.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ANCHOR_FILE, KILL_FILE, createAnchorFile, createKillSentinel, nodeFsProbe } from '../../../src/app/run-files.ts';
import { removeDir, tempDir } from '../storage/helpers.ts';

const HASH = 'ab'.repeat(32);

function withDir(fn: (dir: string) => void): void {
  const dir = tempDir('fomo-run-');
  try {
    fn(dir);
  } finally {
    chmodSync(dir, 0o700);
    removeDir(dir);
  }
}

describe('app/run-files.ts: the KILL file', () => {
  it('present exactly while the file exists; any doubt reads as present (fail closed)', () => {
    withDir((dir) => {
      const sentinel = createKillSentinel(dir);
      assert.equal(KILL_FILE, 'KILL');
      assert.equal(sentinel.present(), false);
      writeFileSync(path.join(dir, KILL_FILE), '');
      assert.equal(sentinel.present(), true);
      assert.ok(Object.isFrozen(sentinel));
    });
    withDir((dir) => {
      // a dangling link is still a KILL file
      symlinkSync(path.join(dir, 'nowhere'), path.join(dir, KILL_FILE));
      assert.equal(createKillSentinel(dir).present(), true);
    });
    withDir((dir) => {
      // a run folder that is a file: lstat fails with ENOTDIR, which is not "no such file"
      writeFileSync(path.join(dir, 'run'), '');
      assert.equal(createKillSentinel(path.join(dir, 'run')).present(), true);
    });
  });
});

describe('app/run-files.ts: the audit anchor', () => {
  it('null before the first write; written 0600 by a rename over the old one, read back as written', () => {
    withDir((dir) => {
      const anchors = createAnchorFile(dir);
      assert.equal(ANCHOR_FILE, 'audit-anchor.json');
      assert.equal(anchors.read(), null);
      anchors.write({ id: 3, hash: HASH, at: 1_800_000_000_000 });
      assert.deepEqual(anchors.read(), { id: 3, hash: HASH, at: 1_800_000_000_000 });
      anchors.write({ id: 4, hash: 'cd'.repeat(32), at: 1_800_000_000_001 });
      assert.deepEqual(anchors.read(), { id: 4, hash: 'cd'.repeat(32), at: 1_800_000_000_001 });
      const file = path.join(dir, ANCHOR_FILE);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(readFileSync(file, 'utf8'), `{"id":4,"hash":"${'cd'.repeat(32)}","at":1800000000001}`);
      assert.ok(Object.isFrozen(anchors.read()));
      // a temp file left behind by a crash is overwritten, and made 0600 again
      writeFileSync(`${file}.tmp`, 'junk', { mode: 0o666 });
      chmodSync(`${file}.tmp`, 0o666);
      anchors.write({ id: 5, hash: HASH, at: 1_800_000_000_002 });
      assert.equal(anchors.read()?.id, 5);
      assert.equal(statSync(file).mode & 0o777, 0o600);
    });
  });

  it('a malformed file throws, never a guess; a bad anchor is never written', () => {
    withDir((dir) => {
      const anchors = createAnchorFile(dir);
      const file = path.join(dir, ANCHOR_FILE);
      for (const text of [
        '',
        'not json',
        '[]',
        'null',
        '{"id":3,"hash":"ab","at":1}',
        `{"id":0,"hash":"${HASH}","at":1}`,
        `{"id":1.5,"hash":"${HASH}","at":1}`,
        `{"id":3,"hash":"${HASH.toUpperCase()}","at":1}`,
        `{"id":3,"hash":"${HASH}","at":-1}`,
        `{"id":3,"hash":"${HASH}","at":1,"extra":true}`,
        `{"id":3,"hash":"${HASH}"}`,
        `{"id":"3","hash":"${HASH}","at":1}`,
      ]) {
        writeFileSync(file, text);
        assert.throws(() => anchors.read(), /audit anchor/, text);
      }
      for (const bad of [{ id: 0, hash: HASH, at: 1 }, { id: 1, hash: 'x', at: 1 }, { id: 1, hash: HASH, at: Number.NaN }, null]) {
        assert.throws(() => anchors.write(bad as never), /audit anchor/);
      }
    });
    withDir((dir) => {
      // a folder where the file should be is not "no anchor": it throws
      mkdirSync(path.join(dir, ANCHOR_FILE));
      assert.throws(() => createAnchorFile(dir).read());
    });
  });
});

describe('app/run-files.ts: the real file-system probe (Linux)', { skip: process.platform === 'win32' }, () => {
  it('reports links, folders, the permission bits, the owner, the link count and the file-system type', () => {
    withDir((dir) => {
      const file = path.join(dir, 'f');
      writeFileSync(file, 'x', { mode: 0o640 });
      chmodSync(file, 0o640);
      symlinkSync(file, path.join(dir, 'link'));
      const f = nodeFsProbe.lstat(file);
      assert.deepEqual(f, { isSymbolicLink: false, isDirectory: false, mode: 0o640, uid: process.getuid?.() ?? -1, nlink: 1 });
      assert.equal(nodeFsProbe.lstat(path.join(dir, 'link'))?.isSymbolicLink, true);
      assert.equal(nodeFsProbe.lstat(dir)?.isDirectory, true);
      assert.equal(nodeFsProbe.lstat(path.join(dir, 'none')), null);
      linkSync(file, path.join(dir, 'hard'));
      assert.equal(nodeFsProbe.lstat(file)?.nlink, 2);
      assert.equal(nodeFsProbe.realpath(path.join(dir, 'link')), nodeFsProbe.realpath(file));
      nodeFsProbe.chmod(file, 0o600);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      const type = nodeFsProbe.fsType(dir);
      assert.ok(typeof type === 'number' && type > 0, `the type of the temp folder: ${String(type)}`);
      assert.throws(() => nodeFsProbe.lstat(path.join(file, 'below')), /ENOTDIR/);
    });
  });
});
