// Architecture rules for every source file (ARCHITECTURE.md s.2), checked with the TypeScript
// compiler's parser rather than regexes (security-auditor condition C3):
// - each top-level folder may import only the folders listed in ALLOWED (same folder: always);
// - `import type` is erased at runtime and always allowed; `import { type X }` is NOT type-only
//   (the import statement itself survives type stripping), so it counts as a runtime import;
// - third-party packages only where PACKAGES allows them (each one reviewed first);
// - no `require`, `createRequire`, `import x = require()` or dynamic import of a non-literal;
// - no wall clock or randomness (Date.now, new Date(), Date(), performance.now, Math.random, the
//   random functions of node:crypto) outside core/clock.ts and core/rng.ts, so tests stay
//   deterministic;
// - pure folders (PURE) import no Node built-in beyond their list and use no ambient I/O global
//   (process, globalThis, fetch, timers, ...), so "pure" is enforced, not only reviewed
//   (security-auditor, REVIEWS.md entry D).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SRC = path.resolve(import.meta.dirname, '../../src');

const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  core: [],
  config: ['core', 'storage'],
  storage: ['core'],
  chain: ['core', 'config'],
  venues: ['core'],
  ingest: ['core', 'chain', 'venues', 'fomo'],
  fomo: ['core', 'venues'],
  safety: ['core', 'chain', 'venues'],
  strategies: ['core'],
  exits: ['core'],
  risk: ['core', 'config', 'storage', 'portfolio'],
  execution: ['core', 'venues', 'chain', 'storage', 'risk'],
  signer: [],
  portfolio: ['core', 'storage'],
  research: ['core', 'storage', 'portfolio', 'exits'],
  telegram: ['core'],
  'ai-review': ['core', 'research', 'config'],
  reports: ['core', 'portfolio'],
  ops: ['core', 'storage'],
  app: ['*'],
  cli: ['*'],
};

/** Runtime third-party imports per folder. Empty until a package is approved in REVIEWS.md. */
const PACKAGES: Readonly<Record<string, readonly string[]>> = {};
const CLOCK_FILES = new Set(['core/clock.ts', 'core/rng.ts']);

/** Pure folders and the only Node built-ins each may import (core/clock.ts and core/rng.ts excepted). */
const PURE: Readonly<Record<string, readonly string[]>> = {
  core: [],
  venues: [],
  portfolio: [],
  strategies: [],
  exits: [],
  risk: ['node:crypto'], // HMAC approval tokens and plan hashes; its random functions stay in core/rng.ts
};
/** Globals that reach the outside world, the clock or randomness: never named in pure code. */
const AMBIENT = new Set([
  'process', 'globalThis', 'global', 'fetch', 'crypto', 'performance', 'WebSocket', 'XMLHttpRequest',
  'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'eval',
]);
const RANDOM_CRYPTO = new Set([
  'randomBytes', 'randomUUID', 'randomInt', 'randomFill', 'randomFillSync', 'getRandomValues',
  'generateKey', 'generateKeySync', 'generateKeyPair', 'generateKeyPairSync', 'webcrypto',
]);

/** True when the identifier is only a property name (`a.process`, `{ fetch: 1 }`), not the global. */
function isPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    ((ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent)) &&
      parent.name === node)
  );
}

export function checkSource(rel: string, text: string): string[] {
  const problems: string[] = [];
  const folder = rel.split('/')[0] ?? '';
  const allowed = ALLOWED[folder];
  if (allowed === undefined) {
    return [`${rel}: unknown top-level folder "${folder}"`];
  }
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const pure = CLOCK_FILES.has(rel) ? undefined : PURE[folder];

  const checkSpecifier = (spec: string, typeOnly: boolean): void => {
    if (spec.startsWith('node:')) {
      if (pure !== undefined && !typeOnly && !pure.includes(spec)) {
        problems.push(`${rel}: ${spec} is not allowed in ${folder}/ (pure code)`);
      }
      return;
    }
    if (spec.startsWith('.')) {
      if (!spec.endsWith('.ts')) {
        problems.push(`${rel}: relative import "${spec}" must name the .ts file`);
      }
      const target = path.relative(SRC, path.resolve(SRC, path.dirname(rel), spec)).split(path.sep).join('/');
      if (target.startsWith('..')) {
        problems.push(`${rel}: import "${spec}" leaves src/`);
        return;
      }
      const targetFolder = target.split('/')[0] ?? '';
      if (typeOnly || targetFolder === folder || allowed.includes('*') || allowed.includes(targetFolder)) {
        return;
      }
      problems.push(`${rel}: ${folder}/ may not import ${targetFolder}/ ("${spec}")`);
      return;
    }
    const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : (spec.split('/')[0] ?? spec);
    if (typeOnly || (PACKAGES[folder] ?? []).includes(pkg)) {
      return;
    }
    problems.push(`${rel}: package "${pkg}" is not approved for ${folder}/ (or a Node built-in without "node:")`);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      checkSpecifier(node.moduleSpecifier.text, node.importClause?.isTypeOnly === true);
      const bindings = node.importClause?.namedBindings;
      const fromCrypto = node.moduleSpecifier.text === 'node:crypto' || node.moduleSpecifier.text === 'crypto';
      if (fromCrypto && !CLOCK_FILES.has(rel)) {
        if (node.importClause?.name !== undefined || (bindings !== undefined && ts.isNamespaceImport(bindings))) {
          problems.push(`${rel}: import named functions from node:crypto (no default or namespace import)`);
        } else if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const imported = (element.propertyName ?? element.name).text;
            if (RANDOM_CRYPTO.has(imported)) {
              problems.push(`${rel}: ${imported} from node:crypto outside core/rng.ts`);
            }
          }
        }
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      checkSpecifier(node.moduleSpecifier.text, node.isTypeOnly);
    } else if (ts.isImportEqualsDeclaration(node)) {
      problems.push(`${rel}: "import x = require()" is not allowed`);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg !== undefined && ts.isStringLiteral(arg)) {
          checkSpecifier(arg.text, false);
        } else {
          problems.push(`${rel}: dynamic import with a non-literal specifier`);
        }
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        problems.push(`${rel}: require() is not allowed`);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'Date' && !CLOCK_FILES.has(rel)) {
        problems.push(`${rel}: Date() outside core/clock.ts`);
      }
    } else if (ts.isIdentifier(node) && node.text === 'createRequire') {
      problems.push(`${rel}: createRequire is not allowed`);
    }
    if (pure !== undefined && ts.isIdentifier(node) && AMBIENT.has(node.text) && !isPropertyName(node)) {
      problems.push(`${rel}: ${node.text} is not allowed in ${folder}/ (pure code)`);
    }
    if (!CLOCK_FILES.has(rel)) {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        const name = `${node.expression.text}.${node.name.text}`;
        if (name === 'Date.now' || name === 'Math.random' || name === 'performance.now') {
          problems.push(`${rel}: ${name} outside core/clock.ts or core/rng.ts`);
        }
      }
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'Date' &&
        (node.arguments === undefined || node.arguments.length === 0)
      ) {
        problems.push(`${rel}: new Date() outside core/clock.ts`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}

function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.split(path.sep).join('/'))
    .sort();
}

describe('architecture: imports and determinism', () => {
  it('every source file follows the import and clock rules', () => {
    const files = sourceFiles();
    assert.ok(files.length > 0, 'found the source files');
    const problems = files.flatMap((rel) => checkSource(rel, readFileSync(path.join(SRC, rel), 'utf8')));
    assert.deepEqual(problems, []);
  });

  it('CANARY: catches forbidden edges, packages, require, dynamic imports and the wall clock', () => {
    const cases: [string, string][] = [
      ['strategies/x.ts', "import { plan } from '../execution/planner.ts';"],
      ['core/x.ts', "import { z } from 'zod';"],
      ['core/x.ts', "import fs from 'fs';"],
      ['risk/x.ts', "import { a } from './a';"],
      ['risk/x.ts', "const m = await import(name);"],
      ['risk/x.ts', "const f = require('node:fs');"],
      ['risk/x.ts', "import { createRequire } from 'node:module'; createRequire(import.meta.url);"],
      ['risk/x.ts', 'const t = Date.now();'],
      ['risk/x.ts', 'const d = new Date();'],
      ['risk/x.ts', 'const r = Math.random();'],
      ['strategies/x.ts', "import { type Plan } from '../execution/planner.ts';"],
      ['nowhere/x.ts', 'export {};'],
      ['telegram/x.ts', 'const s = Date();'],
      ['execution/x.ts', "import { randomUUID as id } from 'node:crypto';"],
      ['execution/x.ts', "import * as c from 'node:crypto';"],
      ['execution/x.ts', "import nodeCrypto from 'node:crypto';"],
    ];
    for (const [rel, text] of cases) {
      assert.ok(checkSource(rel, text).length > 0, `should flag ${rel}: ${text}`);
    }
  });

  it('CANARY: pure folders get no Node built-ins beyond their list and no ambient I/O globals', () => {
    const cases: [string, string][] = [
      ['core/x.ts', "import { readFileSync } from 'node:fs';"],
      ['risk/x.ts', "import { readFileSync } from 'node:fs';"],
      ['risk/x.ts', "import { randomBytes } from 'node:crypto';"],
      ['portfolio/x.ts', 'const env = process.env;'],
      ['venues/x.ts', 'const g = globalThis;'],
      ['risk/x.ts', "const r = await fetch('https://example.invalid');"],
      ['strategies/x.ts', 'setTimeout(() => 1, 5);'],
      ['exits/x.ts', 'const v = crypto.getRandomValues(new Uint8Array(4));'],
      ['portfolio/x.ts', 'const o = { process };'],
      ['core/x.ts', 'const t = performance.timeOrigin;'],
    ];
    for (const [rel, text] of cases) {
      assert.ok(checkSource(rel, text).length > 0, `should flag ${rel}: ${text}`);
    }
  });

  it('allows type-only imports, same-folder imports and listed edges', () => {
    const cases: [string, string][] = [
      ['strategies/x.ts', "import type { Plan } from '../execution/planner.ts';"],
      ['risk/x.ts', "import { lamports } from '../core/units.ts';"],
      ['risk/x.ts', "import { a } from './a.ts';"],
      ['core/clock.ts', 'export const now = (): number => Date.now();'],
      ['storage/x.ts', "import { readFileSync } from 'node:fs'; const d = new Date(0);"],
      ['risk/x.ts', "import { createHash, createHmac } from 'node:crypto';"],
      ['core/rng.ts', "import { randomBytes } from 'node:crypto';"],
      ['core/x.ts', "import type { Stats } from 'node:fs';"],
      ['portfolio/x.ts', 'const p = order.process; const o = { fetch: 1 }; interface I { setTimeout: number }'],
      ['execution/x.ts', 'const t = setTimeout(() => 1, 5);'],
    ];
    for (const [rel, text] of cases) {
      assert.deepEqual(checkSource(rel, text), [], `should allow ${rel}: ${text}`);
    }
  });
});
