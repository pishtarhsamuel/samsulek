// Coverage gate (TEST_PLAN.md s.10; security-auditor condition C2), dependency-free.
// Node's own threshold flags apply to one total per run, so this script checks every source file
// in an lcov report: at least 90% of lines and branches in the money folders, 80% elsewhere. It
// fails if a source file is missing from the report or a gated file uses a coverage-ignore comment.
// Usage: node tests/tools/check-coverage.ts coverage/lcov.info
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export interface FileCoverage {
  file: string; // relative to the project root, forward slashes
  linesFound: number;
  linesHit: number;
  branchesFound: number;
  branchesHit: number;
}

export const GATED: readonly RegExp[] = [
  /^src\/core\//,
  /^src\/venues\//,
  /^src\/portfolio\//,
  /^src\/risk\//,
  // the hard limits and the rules for changing the tunables: money code like risk/
  /^src\/config\//,
];
export const GATED_PERCENT = 90;
export const OTHER_PERCENT = 80;
const IGNORE_COMMENT = /\/[/*]\s*node:coverage/;

function toRelative(root: string, file: string): string {
  return path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
}

export function parseLcov(text: string, root: string): FileCoverage[] {
  const files: FileCoverage[] = [];
  let current: FileCoverage | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const [key, value = ''] = line.split(/:(.*)/s);
    if (key === 'SF') {
      current = { file: toRelative(root, value), linesFound: 0, linesHit: 0, branchesFound: 0, branchesHit: 0 };
    } else if (current !== null && key === 'LF') {
      current.linesFound = Number(value);
    } else if (current !== null && key === 'LH') {
      current.linesHit = Number(value);
    } else if (current !== null && key === 'BRF') {
      current.branchesFound = Number(value);
    } else if (current !== null && key === 'BRH') {
      current.branchesHit = Number(value);
    } else if (current !== null && line === 'end_of_record') {
      files.push(current);
      current = null;
    }
  }
  return files;
}

function percent(hit: number, found: number): number {
  return found === 0 ? 100 : (hit / found) * 100;
}

export function checkCoverage(
  report: readonly FileCoverage[],
  sources: readonly { file: string; text: string }[],
): string[] {
  const byFile = new Map(report.map((c) => [c.file, c]));
  const problems: string[] = [];
  for (const source of sources) {
    const gated = GATED.some((re) => re.test(source.file));
    const required = gated ? GATED_PERCENT : OTHER_PERCENT;
    if (gated && IGNORE_COMMENT.test(source.text)) {
      problems.push(`${source.file}: coverage-ignore comments are not allowed in gated folders`);
    }
    const cov = byFile.get(source.file);
    if (cov === undefined) {
      problems.push(`${source.file}: missing from the coverage report`);
      continue;
    }
    const lines = percent(cov.linesHit, cov.linesFound);
    const branches = percent(cov.branchesHit, cov.branchesFound);
    if (lines < required || branches < required) {
      problems.push(
        `${source.file}: lines ${lines.toFixed(1)}%, branches ${branches.toFixed(1)}% (needs ${required}%)`,
      );
    }
  }
  return problems;
}

export function listSources(root: string): { file: string; text: string }[] {
  const srcDir = path.join(root, 'src');
  return readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => {
      const full = path.join(srcDir, f);
      return { file: toRelative(root, full), text: readFileSync(full, 'utf8') };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.filename === path.resolve(invokedPath)) {
  const lcovPath = process.argv[2];
  if (lcovPath === undefined) {
    process.stderr.write('usage: node tests/tools/check-coverage.ts <lcov.info>\n');
    process.exit(2);
  }
  const root = process.cwd();
  const problems = checkCoverage(parseLcov(readFileSync(lcovPath, 'utf8'), root), listSources(root));
  for (const p of problems) {
    process.stdout.write(`FAIL ${p}\n`);
  }
  process.stdout.write(problems.length === 0 ? 'coverage: every file meets its threshold\n' : `coverage: ${problems.length} problem(s)\n`);
  process.exit(problems.length === 0 ? 0 : 1);
}
