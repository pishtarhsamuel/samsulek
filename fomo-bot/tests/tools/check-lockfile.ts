// Supply-chain gate (TEST_PLAN.md s.11), dependency-free. Every package in package-lock.json
// must appear in ops/approved-packages.txt with the same version and sha512 integrity, and must
// come from registry.npmjs.org. New transitive packages therefore fail until they are reviewed.
// Usage: node tests/tools/check-lockfile.ts package-lock.json ops/approved-packages.txt
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export interface LockProblem {
  pkg: string;
  problem: string;
}

interface LockEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
}

const APPROVED_LINE = /^(\S+@\S+) (sha512-[A-Za-z0-9+/]+={0,2})$/;

export function parseApproved(text: string): Map<string, string> {
  const approved = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const match = APPROVED_LINE.exec(line);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      throw new Error(`malformed approved-packages line: ${line}`);
    }
    approved.set(match[1], match[2]);
  }
  return approved;
}

export function checkLockfile(lockText: string, approvedText: string): LockProblem[] {
  const approved = parseApproved(approvedText);
  const lock: unknown = JSON.parse(lockText);
  if (typeof lock !== 'object' || lock === null || !('packages' in lock)) {
    return [{ pkg: '(lockfile)', problem: 'no "packages" map (lockfileVersion 3 expected)' }];
  }
  const packages = (lock as { packages: Record<string, LockEntry> }).packages;
  const problems: LockProblem[] = [];
  for (const [location, entry] of Object.entries(packages)) {
    if (location === '') {
      continue; // the project itself
    }
    const name = location.replace(/^(?:.*\/)?node_modules\//, '');
    const id = `${name}@${entry.version ?? '?'}`;
    if (entry.link === true) {
      problems.push({ pkg: id, problem: 'linked (local) package' });
      continue;
    }
    if (entry.resolved === undefined || !entry.resolved.startsWith('https://registry.npmjs.org/')) {
      problems.push({ pkg: id, problem: `not resolved from https://registry.npmjs.org/: ${String(entry.resolved)}` });
    }
    if (entry.integrity === undefined || !entry.integrity.startsWith('sha512-')) {
      problems.push({ pkg: id, problem: 'integrity is missing or not sha512' });
    }
    const wanted = approved.get(id);
    if (wanted === undefined) {
      problems.push({ pkg: id, problem: 'not in the approved list' });
    } else if (wanted !== entry.integrity) {
      problems.push({ pkg: id, problem: 'integrity differs from the approved list' });
    }
  }
  return problems;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.filename === path.resolve(invokedPath)) {
  const [lockPath, approvedPath] = process.argv.slice(2);
  if (lockPath === undefined || approvedPath === undefined) {
    process.stderr.write('usage: node tests/tools/check-lockfile.ts <package-lock.json> <approved-packages.txt>\n');
    process.exit(2);
  }
  const problems = checkLockfile(readFileSync(lockPath, 'utf8'), readFileSync(approvedPath, 'utf8'));
  for (const p of problems) {
    process.stdout.write(`FAIL ${p.pkg}: ${p.problem}\n`);
  }
  process.stdout.write(problems.length === 0 ? 'lockfile: every package is approved\n' : `lockfile: ${problems.length} problem(s)\n`);
  process.exit(problems.length === 0 ? 0 : 1);
}
