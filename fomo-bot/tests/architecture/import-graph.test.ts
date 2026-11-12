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
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  // risk/ and portfolio/ are pure: at runtime they may import only pure folders (a meta-test below
  // enforces it), so purity holds across imports and not only file by file. They reach storage and
  // config through types and values the composition root (app/) hands in.
  risk: ['core', 'portfolio'],
  execution: ['core', 'venues', 'chain', 'storage', 'risk'],
  signer: [],
  portfolio: ['core'],
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

/**
 * Folders whose files only some folders may import at runtime (types are always fine). risk/ holds
 * the means to mint approval tokens: only risk/ itself and the composition root may use it at
 * runtime, so the executor is handed a verifier and can never make a token ("the constructor is
 * not exported from risk/", ARCHITECTURE.md s.3). The whole folder is restricted, not one file, so
 * a re-export cannot launder the issuer through another risk/ file. Folder names are compared in
 * lower case: Windows and macOS file systems ignore case.
 */
const RUNTIME_ONLY_FROM: Readonly<Record<string, readonly string[]>> = {
  risk: ['risk', 'app'],
  // the composition root is reached only from the process entry (cli/) and from itself, so nothing else can pick up what it holds
  app: ['app', 'cli'],
};
/** Lower case: the check compares import targets in lower case, because Windows and macOS ignore case in file names. */
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
    if (ts.isExpressionWithTypeArguments(p)) {
      continue; // `extends X` runs, `implements X` does not: the heritage clause above decides
    }
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

/** Inside a `declare ...` statement or block: a promise about the outside, not a binding. */
function isAmbient(node: ts.Node): boolean {
  for (let a: ts.Node | undefined = node; a !== undefined; a = a.parent) {
    if (ts.canHaveModifiers(a) && (ts.getModifiers(a) ?? []).some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) {
      return true;
    }
  }
  return false;
}

/**
 * The identifier is a value this file really binds at runtime: a variable, parameter, function,
 * class, enum or value import. Object keys, members, labels, the source side of an import alias,
 * type-only imports and `declare` lines bind nothing, so they cannot excuse a global of that name.
 */
function isRuntimeBinding(node: ts.Identifier): boolean {
  const p = node.parent;
  if (isAmbient(p) || inTypeContext(node)) {
    return false;
  }
  if (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p)) {
    return p.name === node;
  }
  if (
    ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p) ||
    ts.isClassExpression(p) || ts.isEnumDeclaration(p)
  ) {
    return p.name === node;
  }
  if (ts.isImportClause(p)) {
    return p.name === node && !p.isTypeOnly;
  }
  if (ts.isNamespaceImport(p)) {
    return !p.parent.isTypeOnly;
  }
  if (ts.isImportSpecifier(p)) {
    return p.name === node && !p.isTypeOnly && !p.parent.parent.isTypeOnly;
  }
  return false;
}

/** Every runtime binding of the file (scope-insensitive: a real local can only shadow, never add I/O). */
function declaredNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isRuntimeBinding(node)) {
      names.add(node.text);
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return names;
}

/** No arguments, only `undefined` or `void x`, or a spread: formats "now". */
function formatsNow(args: ts.NodeArray<ts.Expression>): boolean {
  const empty = (a: ts.Expression): boolean => (ts.isIdentifier(a) && a.text === 'undefined') || ts.isVoidExpression(a);
  return args.every(empty) || args.some((a) => ts.isSpreadElement(a));
}

const FORMATTERS = new Set(['format', 'formatToParts']);
/** Host objects whose members can reach the clock, randomness or code generation. */
const HOST_OBJECTS = new Set(['process', 'globalThis', 'global']);
/** Members of those objects that read a clock (process.hrtime and process.uptime) or are clock globals. */
const HOST_CLOCK_MEMBERS = new Set(['hrtime', 'uptime', ...CLOCK_GLOBALS]);

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

  const checkSpecifier = (spec: string, typeOnly: boolean, reexport = false): void => {
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
      if (pure !== undefined && !typeOnly && CLOCK_FILES.has(target.toLowerCase())) {
        problems.push(`${rel}: pure code may import ${target} only as types (time and randomness are passed in)`);
      }
      const targetFolder = target.split('/')[0] ?? '';
      const onlyFrom = RUNTIME_ONLY_FROM[targetFolder.toLowerCase()];
      if (onlyFrom !== undefined && !typeOnly && !onlyFrom.includes(folder.toLowerCase())) {
        problems.push(`${rel}: ${target} may be imported at runtime only from ${onlyFrom.join(' and ')} (types are fine)`);
      }
      // A re-export hands the values on to whoever imports this file: only the folder itself may do that.
      if (onlyFrom !== undefined && !typeOnly && reexport && folder.toLowerCase() !== targetFolder.toLowerCase()) {
        problems.push(`${rel}: ${target} may not be re-exported outside ${targetFolder}/ (types are fine)`);
      }
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
      checkSpecifier(node.moduleSpecifier.text, node.isTypeOnly, true);
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
      }
    } else if (ts.isIdentifier(node) && node.text === 'createRequire') {
      problems.push(`${rel}: createRequire is not allowed`);
    }
    if (!CLOCK_FILES.has(rel)) {
      // Every reference to a date formatter's format must be a direct call with a real value:
      // a bare reference, an alias, destructuring, .call/.apply/.bind or format() formats "now".
      const formatter =
        (ts.isPropertyAccessExpression(node) && FORMATTERS.has(node.name.text)) ||
        (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && FORMATTERS.has(node.argumentExpression.text));
      if (formatter) {
        const call = node.parent;
        if (!(ts.isCallExpression(call) && call.expression === node && !formatsNow(call.arguments))) {
          problems.push(`${rel}: format must be called directly with a value (anything else can format the current time)`);
        }
      }
      if (ts.isBindingElement(node)) {
        const key = node.propertyName ?? node.name;
        if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && FORMATTERS.has(key.text)) {
          problems.push(`${rel}: do not destructure format (it could format the current time)`);
        }
      }
      // Destructuring the host objects: named members only, none that reads the clock or randomness.
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer !== undefined &&
        ts.isIdentifier(node.initializer) &&
        HOST_OBJECTS.has(node.initializer.text)
      ) {
        for (const element of node.name.elements) {
          const key = element.propertyName ?? element.name;
          const plainName = ts.isIdentifier(key) || ts.isStringLiteralLike(key);
          if (element.dotDotDotToken !== undefined || !plainName || HOST_CLOCK_MEMBERS.has(key.text)) {
            problems.push(`${rel}: do not destructure ${node.initializer.text} with a rest, a computed key or a clock member`);
          }
        }
      }
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      (node.moduleSpecifier.text === 'node:process' || node.moduleSpecifier.text === 'process') &&
      !CLOCK_FILES.has(rel)
    ) {
      const bindings = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
      const names = bindings !== undefined && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) ? bindings.elements : [];
      for (const element of names) {
        if (HOST_CLOCK_MEMBERS.has((element.propertyName ?? element.name).text)) {
          problems.push(`${rel}: ${(element.propertyName ?? element.name).text} from node:process reads the clock outside core/clock.ts`);
        }
      }
    }
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === 'getBuiltinModule') {
      problems.push(`${rel}: process.getBuiltinModule is a hidden require and is not allowed`);
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
    const dotted = ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression);
    const indexed = ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression);
    if (!CLOCK_FILES.has(rel) && (dotted || indexed)) {
      const owner = (node.expression as ts.Identifier).text;
      const hostObject = owner === 'globalThis' || owner === 'global' || owner === 'process';
      // a.b and a['b'] name the member; a[expr] could name any member.
      let member: string | null = null;
      if (ts.isPropertyAccessExpression(node)) {
        member = node.name.text;
      } else if (ts.isStringLiteralLike(node.argumentExpression)) {
        member = node.argumentExpression.text;
      }
      if (hostObject && member === null) {
        problems.push(`${rel}: computed access on ${owner} can reach the clock or randomness`);
      }
      if (owner === 'process' && member !== null && HOST_CLOCK_MEMBERS.has(member)) {
        problems.push(`${rel}: process.${member} reads the clock outside core/clock.ts`);
      }
      if ((owner === 'globalThis' || owner === 'global') && member !== null && CLOCK_GLOBALS.has(member)) {
        problems.push(`${rel}: ${owner}.${member} outside core/clock.ts and core/rng.ts`);
      }
    }
    // In every folder, not only the pure ones: `x.constructor` reaches Function and the members of
    // Date (`new Date(0).constructor.now()` reads the clock). A class's own `constructor(...)` is a
    // keyword in the syntax tree, not a name, so classes are untouched.
    const named =
      (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text === 'constructor';
    if (named) {
      problems.push(`${rel}: "constructor" is not allowed (it reaches Function and the clock)`);
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

  it('CANARY: only risk/ and app/ may import anything in risk/ at runtime (so the token issuer cannot be laundered); everyone else gets types', () => {
    flagged([
      ['execution/x.ts', "import { createApprovalAuthority } from '../risk/approval.ts';"],
      ['execution/x.ts', "export { createApprovalAuthority } from '../risk/approval.ts';"],
      ['execution/x.ts', "const m = await import('../risk/approval.ts');"],
      ['execution/x.ts', "import { exitProblems } from '../risk/exits.ts';"], // any risk/ file, not only the issuer
      ['execution/x.ts', "import { x } from '../Risk/approval.ts';"], // Windows and macOS ignore case
      ['cli/x.ts', "import { createApprovalAuthority } from '../risk/approval.ts';"],
      ['signer/x.ts', "import { createApprovalAuthority } from '../risk/approval.ts';"],
    ]);
    for (const [rel, text] of [
      ['execution/x.ts', "import type { ApprovalToken, ApprovalVerifier } from '../risk/approval.ts';"],
      ['execution/x.ts', "import { type TokenStore } from '../risk/approval.ts';"],
      ['execution/x.ts', "import type { ExitPlan } from '../risk/exits.ts';"],
      ['app/x.ts', "import { createApprovalAuthority } from '../risk/approval.ts';"],
      ['app/x.ts', "import { exitProblems } from '../risk/exits.ts';"],
      ['risk/x.ts', "import { createApprovalAuthority } from './approval.ts';"],
      ['risk/x.ts', "import { exitProblems } from './exits.ts';"],
    ] as const) {
      const problems = checkSource(rel, text).filter((p) => p.includes('imported at runtime only'));
      // `import { type X }` is not type-only (the import statement survives), so it is flagged on
      // purpose; plain `import type` and the allowed folders pass.
      assert.equal(problems.length, rel === 'execution/x.ts' && text.includes('{ type') ? 1 : 0, `${rel}: ${text}`);
    }
  });

  it('CANARY: no way to format "now", and no clock member smuggled out of process or globalThis', () => {
    const formatter = "const d = new Intl.DateTimeFormat('en'); ";
    flagged([
      ['execution/x.ts', `${formatter}const f = d.format; f();`],
      ['execution/x.ts', `${formatter}d['format']();`],
      ['execution/x.ts', `${formatter}const { format } = d;`],
      ['execution/x.ts', `${formatter}[undefined].map(d.format);`],
      ['execution/x.ts', `${formatter}d.format.call(d);`],
      ['execution/x.ts', `${formatter}d.formatToParts();`],
      ['execution/x.ts', 'const { hrtime } = process;'],
      ['execution/x.ts', 'const { uptime: up } = process;'],
      ['execution/x.ts', 'const { ...rest } = process;'],
      ['execution/x.ts', "const k = 'hr'; const { [`${k}time`]: h } = process;"],
      ['execution/x.ts', 'const { Date: D } = globalThis;'],
      ['execution/x.ts', 'const t = process.uptime();'],
      ['execution/x.ts', "import { hrtime } from 'node:process';"],
      ['execution/x.ts', "import { uptime as up } from 'node:process';"],
    ]);
    for (const [rel, text] of [
      ['execution/x.ts', "const s = new Intl.NumberFormat('en').format(5);"],
      ['execution/x.ts', "const d = new Intl.DateTimeFormat('en'); const s = d.format(new Date(0));"],
      ['execution/x.ts', 'const { env, argv } = process; const home = env;'],
      ['execution/x.ts', "import { env } from 'node:process';"],
    ] as const) {
      assert.deepEqual(checkSource(rel, text), [], `should allow ${rel}: ${text}`);
    }
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

  it('CANARY: a class heritage expression runs, and only real bindings can shadow a global', () => {
    flagged([
      ['risk/x.ts', 'export class X extends (structuredClone(1), Object) {}'],
      ['execution/x.ts', 'export class X extends (crypto.randomUUID(), Object) {}'],
      ['risk/x.ts', "const o = { Buffer: 1 }; const b = Buffer.from('x');"],
      ['risk/x.ts', 'interface I { WebAssembly: number } const w = WebAssembly;'],
      ['risk/x.ts', 'declare const structuredClone: (x: number) => number; const c = structuredClone(1);'],
      ['risk/x.ts', "import { Buffer as B } from './a.ts'; const b = Buffer.from('x'); const c = B;"],
      ['risk/x.ts', "import type { Buffer } from './a.ts'; const b = Buffer.from('x');"],
      ['risk/x.ts', "Buffer: for (;;) { break Buffer; } const b = Buffer.from('x');"],
    ]);
  });

  it('CANARY: host objects reached by string or computed keys, and hidden requires', () => {
    flagged([
      ['execution/x.ts', "const t = globalThis['Date'].now();"],
      ['execution/x.ts', "const t = process['hrtime']();"],
      ['execution/x.ts', "const k = 'Date'; const t = globalThis[k];"],
      ['execution/x.ts', "const c = process.getBuiltinModule('node:crypto');"],
      ['execution/x.ts', "const c = process['getBuiltinModule']('node:fs');"],
      ['execution/x.ts', "const d = new Intl.DateTimeFormat('en'); const s = d.format(void 0);"],
      ['execution/x.ts', "const d = new Intl.DateTimeFormat('en'); const s = d.format.call(d);"],
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
      ['portfolio/x.ts', 'export function f(Buffer: number): number { return Buffer + 1; }'], // a real local shadow
      ['portfolio/x.ts', 'interface Shape { area: number } export class Sq implements Shape { area = 1; }'],
      ['execution/x.ts', "const v = process.env['HOME']; const a = process.argv[2];"],
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

describe('architecture: purity across imports, re-exports and links (REVIEWS.md K, security findings 1, 4, 5 and the clock-file case)', () => {
  it('purity holds across imports: a pure folder may import only pure folders at runtime', () => {
    for (const folder of Object.keys(PURE)) {
      const bad = (ALLOWED[folder] ?? []).filter((target) => target !== folder && !(target in PURE));
      assert.deepEqual(bad, [], `${folder}/ may import only pure folders (${Object.keys(PURE).join(', ')})`);
    }
  });

  it('CANARY: a pure folder importing storage/ or config/ at runtime is flagged, types are fine', () => {
    flagged([
      ['risk/x.ts', "import { open } from '../storage/db.ts';"],
      ['risk/x.ts', "import { load } from '../config/load.ts';"],
      ['portfolio/x.ts', "import { open } from '../storage/db.ts';"],
      ['risk/x.ts', "export { readFileSync } from '../storage/fsx.ts';"],
    ]);
    assert.deepEqual(checkSource('risk/x.ts', "import type { Db } from '../storage/db.ts'; export const x = (d: Db): Db => d;"), []);
  });

  it('CANARY: app/ cannot hand risk/ values on, and only cli/ reaches app/ at runtime', () => {
    flagged([
      ['app/x.ts', "export { createApprovalAuthority } from '../risk/approval.ts';"],
      ['app/x.ts', "export * from '../risk/approval.ts';"],
      ['execution/y.ts', "import { build } from '../app/x.ts';"],
      ['signer/y.ts', "import { build } from '../app/x.ts';"],
    ]);
    assert.deepEqual(checkSource('app/x.ts', "export type { ApprovalToken } from '../risk/approval.ts';"), []); // types are fine
    assert.deepEqual(checkSource('app/x.ts', "import { createApprovalAuthority } from '../risk/approval.ts'; export const build = () => createApprovalAuthority;"), []); // using it is the point of app/
    assert.deepEqual(checkSource('cli/y.ts', "import { build } from '../app/x.ts';"), []);
    assert.deepEqual(checkSource('risk/z.ts', "export { createApprovalAuthority } from './approval.ts';"), []); // risk/ itself may
  });

  it('CANARY: "constructor" is flagged in every folder (it reaches the clock through Date), a class\'s own constructor is not', () => {
    flagged([
      ['execution/x.ts', 'const t = new Date(0).constructor.now();'],
      ['execution/x.ts', "const F = (() => 0)['constructor'];"],
      ['cli/x.ts', 'const { constructor: C } = new Date(0);'],
    ]);
    assert.deepEqual(checkSource('execution/x.ts', 'export class E extends Error { constructor(m: string) { super(m); } }'), []);
  });

  it('LIMIT, written down: re-exporting through a local binding is not seen (import then export), and the determinism rules are a tripwire for mistakes, not a sandbox', () => {
    // Only cli/ can reach app/, and app/ is the composition root we write; the guarantee against a hostile
    // file is review plus the verifier/issuer split, not this lint. If this ever starts to be flagged, update ARCHITECTURE s.11.
    assert.deepEqual(
      checkSource('app/x.ts', "import { createApprovalAuthority as c } from '../risk/approval.ts'; export { c };"),
      [],
    );
  });

  it('CANARY: the clock files are recognised whatever the case of the import (Windows and macOS ignore case)', () => {
    flagged([
      ['risk/x.ts', "import { systemClock } from '../core/Clock.ts';"],
      ['portfolio/x.ts', "import { systemRng } from '../core/RNG.ts';"],
    ]);
  });

  const symlinksUnder = (root: string): string[] =>
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isSymbolicLink())
      .map((entry) => path.join(entry.parentPath, entry.name));

  it('there are no symbolic links under src/: a link could point a file in one folder at code in another', () => {
    assert.deepEqual(symlinksUnder(SRC), []);
  });

  it('CANARY: the link scan finds a link (skipped where the system does not let the test make one)', (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fomo-links-'));
    try {
      writeFileSync(path.join(dir, 'real.ts'), 'export const x = 1;\n');
      try {
        symlinkSync(path.join(dir, 'real.ts'), path.join(dir, 'link.ts'));
      } catch {
        t.skip('symbolic links are not permitted here');
        return;
      }
      assert.deepEqual(symlinksUnder(dir), [path.join(dir, 'link.ts')]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
