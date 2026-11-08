// The gates must be able to fail: canary tests for the coverage gate and the lockfile gate
// (security-auditor conditions C2 and the CI supply-chain check).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkCoverage, parseLcov, type FileCoverage } from '../../tools/check-coverage.ts';
import { checkLockfile, parseApproved } from '../../tools/check-lockfile.ts';

const full = (file: string): FileCoverage => ({ file, linesFound: 10, linesHit: 10, branchesFound: 4, branchesHit: 4 });

describe('coverage gate', () => {
  it('passes when every file meets its threshold', () => {
    const sources = [{ file: 'src/core/units.ts', text: 'export {}' }];
    assert.deepEqual(checkCoverage([full('src/core/units.ts')], sources), []);
  });

  it('CANARY: fails a gated file under 90%', () => {
    const low = { ...full('src/risk/engine.ts'), linesHit: 8 }; // 80%
    const problems = checkCoverage([low], [{ file: 'src/risk/engine.ts', text: '' }]);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /needs 90%/);
  });

  it('CANARY: fails low branch coverage even when lines are complete', () => {
    const low = { ...full('src/core/units.ts'), branchesHit: 2 }; // 50% branches
    assert.equal(checkCoverage([low], [{ file: 'src/core/units.ts', text: '' }]).length, 1);
  });

  it('uses 80% outside the gated folders', () => {
    const ok = { ...full('src/telegram/client.ts'), linesHit: 8 }; // 80% is enough here
    assert.deepEqual(checkCoverage([ok], [{ file: 'src/telegram/client.ts', text: '' }]), []);
    const low = { ...full('src/telegram/client.ts'), linesHit: 7 };
    assert.equal(checkCoverage([low], [{ file: 'src/telegram/client.ts', text: '' }]).length, 1);
  });

  it('CANARY: fails a source file that is missing from the report', () => {
    const problems = checkCoverage([], [{ file: 'src/core/units.ts', text: '' }]);
    assert.match(problems[0] ?? '', /missing from the coverage report/);
  });

  it('CANARY: refuses coverage-ignore comments in gated folders', () => {
    const text = '/* node:coverage ignore next */\nexport const x = 1;';
    const problems = checkCoverage([full('src/portfolio/ledger.ts')], [{ file: 'src/portfolio/ledger.ts', text }]);
    assert.match(problems[0] ?? '', /coverage-ignore/);
  });

  it('parses lcov records into project-relative paths', () => {
    const lcov = ['SF:/p/src/core/units.ts', 'LF:20', 'LH:19', 'BRF:6', 'BRH:5', 'end_of_record'].join('\n');
    assert.deepEqual(parseLcov(lcov, '/p'), [
      { file: 'src/core/units.ts', linesFound: 20, linesHit: 19, branchesFound: 6, branchesHit: 5 },
    ]);
  });
});

const approvedText = 'a@1.0.0 sha512-AAAA\n# comment\nb@2.0.0 sha512-BBBB\n';
const lockWith = (packages: Record<string, unknown>): string => JSON.stringify({ lockfileVersion: 3, packages });
const entry = (version: string, integrity: string, resolved = 'https://registry.npmjs.org/x.tgz') => ({
  version,
  integrity,
  resolved,
});

describe('lockfile gate', () => {
  it('accepts a lockfile that matches the approved list', () => {
    const lock = lockWith({ '': {}, 'node_modules/a': entry('1.0.0', 'sha512-AAAA') });
    assert.deepEqual(checkLockfile(lock, approvedText), []);
  });

  it('CANARY: rejects an unapproved (for example new transitive) package', () => {
    const lock = lockWith({ 'node_modules/a/node_modules/c': entry('3.0.0', 'sha512-CCCC') });
    assert.deepEqual(checkLockfile(lock, approvedText), [{ pkg: 'c@3.0.0', problem: 'not in the approved list' }]);
  });

  it('CANARY: rejects a changed integrity, a non-registry source and sha1', () => {
    assert.equal(checkLockfile(lockWith({ 'node_modules/a': entry('1.0.0', 'sha512-ZZZZ') }), approvedText).length, 1);
    const git = entry('1.0.0', 'sha512-AAAA', 'git+https://github.com/x/a.git');
    assert.equal(checkLockfile(lockWith({ 'node_modules/a': git }), approvedText).length, 1);
    const sha1 = entry('1.0.0', 'sha1-AAAA');
    assert.ok(checkLockfile(lockWith({ 'node_modules/a': sha1 }), approvedText).length >= 1);
  });

  it('rejects malformed approved-list lines', () => {
    assert.throws(() => parseApproved('a@1.0.0 md5-xyz'));
  });

  it('the real lockfile contains only approved packages', () => {
    const lock = readFileSync(new URL('../../../package-lock.json', import.meta.url), 'utf8');
    const approved = readFileSync(new URL('../../../ops/approved-packages.txt', import.meta.url), 'utf8');
    assert.deepEqual(checkLockfile(lock, approved), []);
  });
});

describe('test setup', () => {
  it('marks the process so the secrets loader refuses to run', () => {
    assert.equal((globalThis as Record<symbol, unknown>)[Symbol.for('fomo-bot.secrets-forbidden')], true);
  });
});
