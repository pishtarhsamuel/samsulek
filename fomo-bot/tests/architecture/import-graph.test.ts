// Architecture rules for every source file (ARCHITECTURE.md s.2), checked with the TypeScript
// compiler's parser rather than regexes (security-auditor condition C3):
// - each top-level folder may import only the folders listed in ALLOWED (same folder: always);
// - `import type` is erased at runtime and always allowed; `import { type X }` is NOT type-only
//   (the import statement itself survives type stripping), so it counts as a runtime import;
// - third-party packages only where PACKAGES allows them (each one reviewed first);
// - no `require`, `createRequire`, `import x = require()` or dynamic import of a non-literal;
// - no wall clock or randomness outside core/clock.ts and core/rng.ts, so tests stay
//   deterministic: Date only as new Date(x), Date.UTC or Date.parse; Math never random;
//   Temporal never Now; no performance; no zero-argument format() (it formats "now");
// - node:crypto only as named imports from an allowlist, never re-exported (its random
//   functions live in core/rng.ts only);
// - pure folders (PURE) import no Node built-in beyond their list, no dynamic import, and
//   core/clock.ts or core/rng.ts only as types; every global they name must be a plain
//   ECMAScript global (ES_GLOBALS: no console, process, fetch, timers, Buffer, ...), and
//   "constructor" never appears, so "pure" is enforced, not only reviewed (security-auditor,
//   REVIEWS.md entries D, E and F).
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
const RNG_FILE = 'core/rng.ts';

/** Pure folders and the only Node built-ins each may import (core/clock.ts and core/rng.ts excepted). */
const PURE: Readonly<Record<string, readonly string[]>> = {
  core: [],
  venues: [],
  portfolio: [],
  strategies: [],
  exits: [],
  risk: ['node:crypto'], // HMAC approval tokens and plan hashes (CRYPTO_ALLOWED only)
};
/** Globals that reach the outside world, the clock or code generation: never named in pure code. */
const AMBIENT = new Set([
  'process', 'globalThis', 'global', 'fetch', 'crypto', 'performance', 'WebSocket', 'XMLHttpRequest',
  'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'eval', 'Function', 'Temporal',
  'navigator', 'console', 'Reflect',
]);
/** The only globals pure code may name (Math and Date still pass the clock rule). */
const ES_GLOBALS = new Set([
  'Object', 'Array', 'Number', 'BigInt', 'String', 'Boolean', 'Symbol', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Promise', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'AggregateError', 'JSON', 'Math', 'Date',
  'RegExp', 'Intl', 'ArrayBuffer', 'DataView', 'Uint8Array', 'Int8Array', 'Uint8ClampedArray', 'Uint16Array',
  'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'TextEncoder', 'TextDecoder', 'isFinite', 'isNaN', 'parseInt', 'parseFloat', 'encodeURIComponent',
  'decodeURIComponent', 'undefined', 'NaN', 'Infinity',
]);
/** The node:crypto functions any file but core/rng.ts may import: hashing, MACs, comparison. */
const CRYPTO_ALLOWED = new Set(['createHash', 'createHmac', 'timingSafeEqual']);
/** Clock globals that must not be reached as properties of the global object either. */
const CLOCK_GLOBALS = new Set(['Date', 'Math', 'performance', 'Temporal', 'crypto']);

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

/** `Date` in `at: Date` or `typeof Date` is only a type. */
function isTypePosition(node: ts.Identifier): boolean {
  return ts.isTypeReferenceNode(node.parent) || ts.isTypeQueryNode(node.parent);
}

/** Inside a type (annotation, alias, interface, `implements`): erased, never run. */
function inTypeContext(node: ts.Node): boolean {
  for (let p = node.parent; p !== undefined; p = p.parent) {
    if (ts.isTypeNode(p)) {
      return true;
    }
    if (ts.isHeritageClause(p)) {
      return p.token === ts.SyntaxKind.ImplementsKeyword || ts.isInterfaceDeclaration(p.parent);
    }
    if (ts.isStatement(p) || ts.isSourceFile(p)) {
      return ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p);
    }
  }
  return false;
}

/** The identifier names something this file declares (a variable, parameter, import, label...). */
function isDeclarationName(node: ts.Identifier): boolean {
  const p = node.parent;
  const named =
    ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) ||
    ts.isClassDeclaration(p) || ts.isClassExpression(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) ||
    ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p) || ts.isInterfaceDeclaration(p) ||
    ts.isTypeAliasDeclaration(p) || ts.isTypeParameterDeclaration(p) || ts.isEnumDeclaration(p) || ts.isEnumMember(p) ||
    ts.isModuleDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p) || ts.isPropertyAssignment(p);
  return (
    (named && p.name === node) ||
    (ts.isBindingElement(p) && (p.name === node || p.propertyName === node)) ||
    ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p) ||
    ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)
  );
}

/** Every name the file declares anywhere (scope-insensitive: a local can only shadow, never add I/O). */
function declaredNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isDeclarationName(node)) {
      names.add(node.text);
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return names;
}

/** No arguments, only `undefined`, or a spread: formats "now". */
function formatsNow(args: ts.NodeArray<ts.Expression>): boolean {
  return args.every((a) => ts.isIdentifier(a) && a.text === 'undefined') || args.some((a) => ts.isSpreadElement(a));
}

/** Why this use of Date, Math, Temporal or performance can read the clock or randomness, or null. */
function clockProblem(node: ts.Identifier): string | null {
  const parent = node.parent;
  const member = ts.isPropertyAccessExpression(parent) && parent.expression === node ? parent.name.text : null;
  switch (node.text) {
    case 'Date': {
      const args = ts.isNewExpression(parent) && parent.expression === node ? parent.arguments : undefined;
      if (args !== undefined && args.length > 0 && !args.some((a) => ts.isSpreadElement(a))) {
        return null; // new Date(x): a fixed instant
      }
      return member === 'UTC' || member === 'parse' ? null : 'Date may only be new Date(x), Date.UTC or Date.parse';
    }
    case 'Math':
      return member !== null && member !== 'random' ? null : 'Math may only be Math.<member>, never random';
    case 'Temporal':
      return member !== null && member !== 'Now' ? null : 'Temporal may only be Temporal.<type>, never Now';
    case 'performance':
      return 'performance reads the clock';
    default:
      return null;
  }
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
  const declared = pure === undefined ? new Set<string>() : declaredNames(source);

  const checkSpecifier = (spec: string, typeOnly: boolean): void => {
    if (spec.startsWith('node:')) {
      if (pure !== undefined && !typeOnly && !pure.includes(spec)) {
        problems.push(`${rel}: ${spec} is not allowed in ${folder}/ (pure code)`);
      }
      if (spec === 'node:perf_hooks' && !typeOnly && !CLOCK_FILES.has(rel)) {
        problems.push(`${rel}: node:perf_hooks reads the clock outside core/clock.ts`);
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
      if (pure !== undefined && !typeOnly && CLOCK_FILES.has(target)) {
        problems.push(`${rel}: pure code may import ${target} only as types (time and randomness are passed in)`);
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

  const isCrypto = (spec: ts.Expression | undefined): boolean =>
    spec !== undefined && ts.isStringLiteral(spec) && (spec.text === 'node:crypto' || spec.text === 'crypto');

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      checkSpecifier(node.moduleSpecifier.text, clause?.isTypeOnly === true);
      if (isCrypto(node.moduleSpecifier) && rel !== RNG_FILE && clause !== undefined && !clause.isTypeOnly) {
        const bindings = clause.namedBindings;
        if (clause.name !== undefined || (bindings !== undefined && ts.isNamespaceImport(bindings))) {
          problems.push(`${rel}: import named functions from node:crypto (no default or namespace import)`);
        } else if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const imported = (element.propertyName ?? element.name).text;
            if (!element.isTypeOnly && !CRYPTO_ALLOWED.has(imported)) {
              problems.push(`${rel}: ${imported} from node:crypto is not allowed outside core/rng.ts`);
            }
          }
        }
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      checkSpecifier(node.moduleSpecifier.text, node.isTypeOnly);
      if (isCrypto(node.moduleSpecifier) && rel !== RNG_FILE && !node.isTypeOnly) {
        problems.push(`${rel}: node:crypto may not be re-exported`);
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      problems.push(`${rel}: "import x = require()" is not allowed`);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (pure !== undefined) {
          problems.push(`${rel}: no dynamic import in ${folder}/ (pure code)`);
        }
        if (arg !== undefined && ts.isStringLiteral(arg)) {
          checkSpecifier(arg.text, false);
          if (isCrypto(arg) && rel !== RNG_FILE) {
            problems.push(`${rel}: node:crypto may not be imported dynamically`);
          }
        } else {
          problems.push(`${rel}: dynamic import with a non-literal specifier`);
        }
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        problems.push(`${rel}: require() is not allowed`);
      } else if (
        !CLOCK_FILES.has(rel) &&
        ts.isPropertyAccessExpression(node.expression) &&
        (node.expression.name.text === 'format' || node.expression.name.text === 'formatToParts') &&
        formatsNow(node.arguments)
      ) {
        problems.push(`${rel}: a format() without a value formats the current time`);
      }
    } else if (ts.isIdentifier(node) && node.text === 'createRequire') {
      problems.push(`${rel}: createRequire is not allowed`);
    }
    if (ts.isIdentifier(node) && !isPropertyName(node)) {
      if (!CLOCK_FILES.has(rel) && !isTypePosition(node)) {
        const problem = clockProblem(node);
        if (problem !== null) {
          problems.push(`${rel}: ${problem} outside core/clock.ts and core/rng.ts`);
        }
      }
      if (node.text === 'crypto' && rel !== RNG_FILE && !inTypeContext(node)) {
        problems.push(`${rel}: the global crypto (randomness) outside core/rng.ts`);
      }
      if (pure !== undefined && AMBIENT.has(node.text)) {
        problems.push(`${rel}: ${node.text} is not allowed in ${folder}/ (pure code)`);
      }
      const free = !isDeclarationName(node) && !declared.has(node.text) && !inTypeContext(node);
      if (pure !== undefined && free && !ES_GLOBALS.has(node.text)) {
        problems.push(`${rel}: the global ${node.text} is not allowed in ${folder}/ (pure code: plain ECMAScript only)`);
      }
    }
    if (!CLOCK_FILES.has(rel) && ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const owner = node.expression.text;
      if (owner === 'process' && node.name.text === 'hrtime') {
        problems.push(`${rel}: process.hrtime reads the clock outside core/clock.ts`);
      }
      if ((owner === 'globalThis' || owner === 'global') && CLOCK_GLOBALS.has(node.name.text)) {
        problems.push(`${rel}: ${owner}.${node.name.text} outside core/clock.ts and core/rng.ts`);
      }
    }
    if (pure !== undefined) {
      const named =
        (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        node.text === 'constructor';
      if (named) {
        problems.push(`${rel}: "constructor" is not allowed in ${folder}/ (pure code: it reaches Function)`);
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

const flagged = (cases: readonly (readonly [string, string])[]): void => {
  for (const [rel, text] of cases) {
    assert.ok(checkSource(rel, text).length > 0, `should flag ${rel}: ${text}`);
  }
};

describe('architecture: imports and determinism', () => {
  it('every source file follows the import and clock rules', () => {
    const files = sourceFiles();
    assert.ok(files.length > 0, 'found the source files');
    const problems = files.flatMap((rel) => checkSource(rel, readFileSync(path.join(SRC, rel), 'utf8')));
    assert.deepEqual(problems, []);
  });

  it('CANARY: catches forbidden edges, packages, require and dynamic imports', () => {
    flagged([
      ['strategies/x.ts', "import { plan } from '../execution/planner.ts';"],
      ['core/x.ts', "import { z } from 'zod';"],
      ['core/x.ts', "import fs from 'fs';"],
      ['risk/x.ts', "import { a } from './a';"],
      ['risk/x.ts', 'const m = await import(name);'],
      ['risk/x.ts', "const f = require('node:fs');"],
      ['risk/x.ts', "import { createRequire } from 'node:module'; createRequire(import.meta.url);"],
      ['strategies/x.ts', "import { type Plan } from '../execution/planner.ts';"],
      ['nowhere/x.ts', 'export {};'],
    ]);
  });

  it('CANARY: catches every way to read the clock or randomness outside core/clock.ts and core/rng.ts', () => {
    flagged([
      ['risk/x.ts', 'const t = Date.now();'],
      ['risk/x.ts', 'const d = new Date();'],
      ['risk/x.ts', 'const r = Math.random();'],
      ['telegram/x.ts', 'const s = Date();'],
      ['execution/x.ts', 'const d = new Date(...[]);'],
      ['execution/x.ts', 'const d = new (Date)();'],
      ['execution/x.ts', 'const D = Date; const t = D.now();'],
      ['execution/x.ts', "const t = Date['now']();"],
      ['execution/x.ts', 'const { random } = Math;'],
      ['execution/x.ts', 'const t = Temporal.Now.instant();'],
      ['execution/x.ts', 'const t = performance.timeOrigin;'],
      ['execution/x.ts', "const s = new Intl.DateTimeFormat('en').format();"],
      ['execution/x.ts', "const p = new Intl.DateTimeFormat('en').formatToParts();"],
      ['execution/x.ts', "const s = new Intl.DateTimeFormat('en').format(undefined);"],
      ['execution/x.ts', "const a: [] = []; const s = new Intl.DateTimeFormat('en').format(...a);"],
      ['execution/x.ts', 'const id = crypto.randomUUID();'],
      ['execution/x.ts', 'const t = process.hrtime.bigint();'],
      ['execution/x.ts', 'const t = globalThis.Date.now();'],
      ['execution/x.ts', "import { performance as p } from 'node:perf_hooks';"],
      ['execution/x.ts', "import * as ns from 'node:perf_hooks';"],
    ]);
  });

  it('CANARY: node:crypto only from the allowlist, named, and never re-exported', () => {
    flagged([
      ['risk/x.ts', "import { randomBytes } from 'node:crypto';"],
      ['execution/x.ts', "import { randomUUID as id } from 'node:crypto';"],
      ['execution/x.ts', "import { generatePrime } from 'node:crypto';"],
      ['execution/x.ts', "import { createECDH } from 'node:crypto';"],
      ['execution/x.ts', "import * as c from 'node:crypto';"],
      ['execution/x.ts', "import nodeCrypto from 'node:crypto';"],
      ['risk/x.ts', "export { randomBytes } from 'node:crypto';"],
      ['execution/x.ts', "export * from 'node:crypto';"],
      ['execution/x.ts', "const c = await import('node:crypto');"],
    ]);
  });

  it('CANARY: pure folders get no Node built-ins beyond their list and no ambient global', () => {
    flagged([
      ['core/x.ts', "import { readFileSync } from 'node:fs';"],
      ['risk/x.ts', "import { readFileSync } from 'node:fs';"],
      ['portfolio/x.ts', 'const env = process.env;'],
      ['venues/x.ts', 'const g = globalThis;'],
      ['risk/x.ts', "const r = await fetch('https://example.invalid');"],
      ['strategies/x.ts', 'setTimeout(() => 1, 5);'],
      ['exits/x.ts', 'const v = crypto.getRandomValues(new Uint8Array(4));'],
      ['portfolio/x.ts', 'const o = { process };'],
      ['core/x.ts', 'const t = performance.timeOrigin;'],
      ['portfolio/x.ts', "const g = Function('return this')();"],
      ['portfolio/x.ts', "const p = (() => 0).constructor('return process')();"],
      ['portfolio/x.ts', "const p = (() => 0)['constructor'];"],
      ['venues/x.ts', 'const n = navigator.userAgent;'],
      ['core/x.ts', "const d = Temporal.PlainDate.from('2026-11-09');"],
      ['risk/x.ts', 'console.log(1);'],
      ['risk/x.ts', "const b = Buffer.from('x');"],
      ['portfolio/x.ts', 'const c = structuredClone({ a: 1 });'],
      ['strategies/x.ts', 'const w = new WebAssembly.Memory({ initial: 1 });'],
      ['risk/x.ts', "const m = await import('./a.ts');"],
      ['risk/x.ts', "import { now } from '../core/clock.ts';"],
      ['portfolio/x.ts', "export { draw } from '../core/rng.ts';"],
      ['portfolio/x.ts', 'const f = (() => 0)[`constructor`];'],
      ['portfolio/x.ts', 'const { constructor: F } = (() => 0);'],
      ['portfolio/x.ts', "const F = Reflect.get(() => 0, 'constructor');"],
    ]);
  });

  it('allows type-only imports, same-folder imports, listed edges and fixed instants', () => {
    const cases: [string, string][] = [
      ['strategies/x.ts', "import type { Plan } from '../execution/planner.ts';"],
      ['risk/x.ts', "import { lamports } from '../core/units.ts';"],
      ['risk/x.ts', "import { a } from './a.ts';"],
      ['core/clock.ts', 'export const now = (): number => Date.now();'],
      ['storage/x.ts', "import { readFileSync } from 'node:fs'; const d = new Date(0);"],
      ['risk/x.ts', "import { createHash, createHmac } from 'node:crypto';"],
      ['risk/x.ts', "import { type KeyObject, timingSafeEqual } from 'node:crypto';"],
      ['core/rng.ts', "import { randomBytes } from 'node:crypto';"],
      ['core/x.ts', "import type { Stats } from 'node:fs';"],
      [
        'portfolio/x.ts',
        'export function f(order: { process: number }): number { const o = { fetch: 1 }; return order.process + o.fetch; } interface I { setTimeout: number }',
      ],
      ['risk/x.ts', "import type { Clock } from '../core/clock.ts'; export const x = (c: Clock): Clock => c;"],
      ['portfolio/x.ts', 'export class E extends Error { constructor(m: string) { super(m); } } const n = BigInt(Number.MAX_SAFE_INTEGER);'],
      ['execution/x.ts', "const s = new Intl.DateTimeFormat('en').format(0);"],
      ['execution/x.ts', 'const t = setTimeout(() => 1, 5);'],
      ['execution/x.ts', 'const d = new Date(0); const u = Date.UTC(2026, 0, 1); const m = Math.max(1, Math.floor(2.5));'],
      ['core/x.ts', 'export function day(at: Date): number { return at.getUTCDate(); }'],
      ['execution/x.ts', "const s = new Intl.NumberFormat('en').format(5);"],
      ['execution/x.ts', "const d = Temporal.PlainDate.from('2026-11-09');"],
    ];
    for (const [rel, text] of cases) {
      assert.deepEqual(checkSource(rel, text), [], `should allow ${rel}: ${text}`);
    }
  });
});
