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
//   functions live in core/rng.ts only, which imports randomBytes and nothing else from it and is
//   held to the pure rules like the rest of core/);
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
  // the process entry and the owner's terminal commands: nothing outside cli/ reaches them, so the
  // engine cannot pick up a command that wraps the server's writers (review Q, security finding 1a)
  cli: ['cli'],
};
/**
 * The approval authority holds the token key and binds the single-use store and the slot source
 * (REVIEWS.md K, security findings 2 and 3): it is created in exactly one place, the composition
 * root's authority file, which hands the executor only the verifier. Its own module defines it.
 */
const AUTHORITY_FILES = new Set(['risk/approval.ts', 'app/authority.ts']);
/** A relative import: a plain path of letters, digits, dots, slashes, underscores and dashes, ending in .ts. */
const RELATIVE_SPEC = /^\.{1,2}\/[./A-Za-z0-9_-]*\.ts$/;
/**
 * The database module is opened in one file, which checks every statement, parameter and cell
 * (STORAGE_DESIGN.md s.1.1); everything else, types included, goes through that wrapper. Only the
 * schema runner may run multi-statement SQL (tx.script), which skips the one-statement checks.
 */
const SQLITE_FILE = 'storage/sqlite.ts';
const SCRIPT_FILES = new Set([SQLITE_FILE, 'storage/migrations.ts']);
/**
 * Files only some files may import at runtime (types are always fine), with a static import, and that
 * no file may re-export (reviews P, the audit writers): the chain's row writer, used by the three files
 * that decide who may write which action; the owner's writers, for the Telegram commands after the
 * owner check (app/owner.ts) and the server's terminal (cli/); the server's writers, for cli/ only;
 * and app/owner.ts itself, which only its Telegram wiring file may import (none yet: Phase 3 names it;
 * review Q, security finding 1b). Their functions are only called where they are imported, never handed
 * on (the typed rule below), and nothing outside cli/ imports cli/. So the engine can never write an
 * owner's or a server's audit row, and with it lift a halt or clear KILL. Keys and the allowed
 * importers are compared exactly (a look-alike name is another file on Linux).
 */
const RESTRICTED_FILES: Readonly<Record<string, { readonly allows: (rel: string) => boolean; readonly who: string }>> = {
  'storage/audit-chain.ts': {
    allows: (rel) => ['storage/repo-audit.ts', 'storage/repo-owner.ts', 'storage/repo-server.ts'].includes(rel),
    who: 'storage/repo-audit.ts, repo-owner.ts and repo-server.ts',
  },
  'storage/repo-owner.ts': { allows: (rel) => rel === 'app/owner.ts' || rel.startsWith('cli/'), who: 'app/owner.ts (Telegram, after the owner check) and cli/' },
  'storage/repo-server.ts': { allows: (rel) => rel.startsWith('cli/'), who: 'cli/ (the owner at the server)' },
  'app/owner.ts': { allows: () => false, who: 'its one Telegram wiring file (Phase 3 names it; none until then)' },
  // the money path (6c-2b-2, STORAGE_DESIGN s.15.11): T1 lives in app/; only the token store bound into
  // the verifier uses a token, so nothing else can consume one with a slot of its own choosing (K finding 3)
  'storage/repo-redeem.ts': { allows: (rel) => rel === 'app/token-store.ts', who: 'app/token-store.ts (the token store bound into the verifier)' },
  // and the token store itself only where it is bound into the authority: anything else could call
  // its consume directly, past the verifier's MAC and its slot (review S, security 4)
  'app/token-store.ts': { allows: (rel) => rel === 'app/authority.ts', who: 'app/authority.ts (where the store is bound into the verifier)' },
  'storage/repo-orders.ts': { allows: (rel) => rel.startsWith('app/'), who: 'app/ (T1)' },
  // randomness has one door, and only the composition root and the process entry use it: other code
  // takes an Rng or random data as an argument, so tests stay deterministic (6d-1, STORAGE_DESIGN s.16.7.4)
  'core/rng.ts': { allows: (rel) => rel.startsWith('app/') || rel.startsWith('cli/'), who: 'app/ and cli/ (other code takes an Rng)' },
  // one authority, one boot and one engine per process: no other app/ file can make a second authority
  // or start a second engine, and only the process entry starts one (6d, STORAGE_DESIGN s.16.3, D14)
  'app/authority.ts': { allows: (rel) => rel === 'app/engine.ts', who: 'app/engine.ts (one authority per process)' },
  'app/storage-boot.ts': { allows: (rel) => rel === 'app/engine.ts', who: 'app/engine.ts (the boot runs once, before the authority)' },
  'app/engine.ts': { allows: (rel) => rel.startsWith('cli/'), who: 'cli/ (the process entry)' },
  'storage/repo-book.ts': {
    allows: (rel) => rel.startsWith('app/') || rel === 'storage/repo-orders.ts' || rel === 'storage/repo-redeem.ts',
    who: 'app/, storage/repo-orders.ts and storage/repo-redeem.ts',
  },
};
/**
 * Who each writer of the audit chain may write as (review Q re-check, security R1): its every call
 * of appendAuditRow passes an actor whose type is one of these literals, or a union of them, never a
 * string. The database ties an action's prefix to its actor, so this decides which rows a file can
 * write at all: a wrapper in repo-audit.ts that took the actor as a value would hand the engine the
 * owner's rows. A file not listed writes as nobody.
 */
const AUDIT_ACTORS: Readonly<Record<string, readonly string[]>> = {
  'storage/repo-audit.ts': ['engine'],
  'storage/repo-owner.ts': ['owner-telegram', 'owner-server'],
  'storage/repo-server.ts': ['owner-server'],
};
/**
 * A conflict clause in SQL text (reviews P; VERIFIED_FACTS, conflict clauses): OR REPLACE deletes the
 * row in the way, OR IGNORE drops a row that fails a CHECK without a word, and a column's ON CONFLICT
 * clause would do either for every later insert. ON CONFLICT (...) DO NOTHING or DO UPDATE is the way.
 */
const CONFLICT_CLAUSE = /\b(?:INSERT|UPDATE)\s+OR\s+(?:REPLACE|IGNORE|ROLLBACK|ABORT|FAIL)\b|\bREPLACE\s+INTO\b|\bON\s+CONFLICT\s+(?:REPLACE|IGNORE|ROLLBACK|ABORT|FAIL)\b/i;
/** Lower case: the check compares import targets in lower case, because Windows and macOS ignore case in file names. */
const CLOCK_FILES = new Set(['core/clock.ts', 'core/rng.ts']);
/**
 * The one file the clock rules leave out. core/rng.ts is held to the pure rules like the rest of
 * core/, with node:crypto allowed and randomBytes its only import from it: randomness has one audited
 * door, and the global crypto, Math.random and Date are refused there too (6d-1, STORAGE_DESIGN s.16.7.4).
 */
const CLOCK_EXEMPT = new Set(['core/clock.ts']);
const RNG_FILE = 'core/rng.ts';
const RNG_BUILTINS: readonly string[] = ['node:crypto'];
const RNG_CRYPTO = new Set(['randomBytes']);

/**
 * Single files outside the pure folders that any folder may import at runtime: config/caps.ts holds
 * only the hard limits, and the risk code clamps every configured cap against them. Such a file is
 * held to the pure rules, and it imports and re-exports nothing at runtime (its list is the only
 * Node built-ins it may use), so it cannot hand its importers anything from its own folder's edges
 * (REVIEWS.md L, security finding 1). Keys are lower case; the exception is granted only to an
 * import that names the file in its exact case, and no two source files may differ only in case.
 */
const PURE_FILES: Readonly<Record<string, readonly string[]>> = {
  'config/caps.ts': [],
};

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
  // a directive that switches the type check off for a line or a file hides it from the typed rules too
  if (/@ts-(?:ignore|expect-error|nocheck)\b/.test(text)) {
    problems.push(`${rel}: no @ts-ignore, @ts-expect-error or @ts-nocheck`);
  }
  // A pure file is found whatever the case of its name (a look-alike `Caps.ts` is held to the same rules).
  const pureFile = Object.hasOwn(PURE_FILES, rel.toLowerCase()) ? PURE_FILES[rel.toLowerCase()] : undefined;
  const pure = CLOCK_EXEMPT.has(rel) ? undefined : rel === RNG_FILE ? RNG_BUILTINS : (pureFile ?? PURE[folder]);
  const declared = pure === undefined ? new Set<string>() : declaredNames(source);

  const checkSpecifier = (spec: string, typeOnly: boolean, reexport = false, dynamic = false): void => {
    if ((spec === 'node:sqlite' || spec === 'sqlite') && (rel !== SQLITE_FILE || reexport)) {
      problems.push(`${rel}: only storage/sqlite.ts may import node:sqlite, types included, and it hands none of it on (everything else uses its checked wrapper)`);
    }
    if (pureFile !== undefined && !typeOnly && !spec.startsWith('node:')) {
      problems.push(`${rel}: a pure file outside the pure folders imports and re-exports nothing at runtime ("${spec}")`);
      return;
    }
    if (spec.startsWith('node:')) {
      if (pure !== undefined && !typeOnly && !pure.includes(spec)) {
        problems.push(`${rel}: ${spec} is not allowed in ${folder}/ (pure code)`);
      }
      if (spec === 'node:perf_hooks' && !typeOnly && !CLOCK_EXEMPT.has(rel)) {
        problems.push(`${rel}: node:perf_hooks reads the clock outside core/clock.ts`);
      }
      return;
    }
    if (spec.startsWith('.')) {
      // A plain path to a .ts file and nothing else: a query or a fragment ('./approval.ts?x=.ts') loads
      // the same file as a second module and would slip past every rule that compares the target
      // (REVIEWS.md N, security), and so would a space, an escape or a backslash.
      if (!RELATIVE_SPEC.test(spec)) {
        problems.push(`${rel}: relative import "${spec}" must name the .ts file as a plain path (no query, fragment or escape)`);
        return;
      }
      const target = path.relative(SRC, path.resolve(SRC, path.dirname(rel), spec)).split(path.sep).join('/');
      if (target.startsWith('..')) {
        problems.push(`${rel}: import "${spec}" leaves src/`);
        return;
      }
      if (pure !== undefined && !typeOnly && CLOCK_FILES.has(target.toLowerCase())) {
        problems.push(`${rel}: pure code may import ${target} only as types (time and randomness are passed in)`);
      }
      // The token module's only runtime value is the factory: it reaches the authority files and nothing
      // else, whatever the form (named, namespace, re-export, dynamic). Types are fine everywhere.
      if (!typeOnly && target.toLowerCase() === 'risk/approval.ts' && !AUTHORITY_FILES.has(rel)) {
        problems.push(`${rel}: only app/authority.ts may import risk/approval.ts at runtime (types are fine)`);
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
      // a dynamic import hands the whole module on as a value, past the rule that its functions are only called
      const restricted = RESTRICTED_FILES[target.toLowerCase()];
      if (restricted !== undefined && !typeOnly && (reexport || dynamic || !restricted.allows(rel))) {
        problems.push(`${rel}: ${target} may be imported at runtime only by ${restricted.who}, with a static import, and re-exported by none (types are fine)`);
      }
      // A pure file only under its exact name: a look-alike in another case is another file on Linux.
      if (typeOnly || targetFolder === folder || allowed.includes('*') || allowed.includes(targetFolder) || Object.hasOwn(PURE_FILES, target)) {
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
  // C2 (review L): the reserve's per-position exit budget is what the reserve HOLDS, never an allowance
  // to spend, so only risk/ may import it; app/caps.ts has its own failed-fee budget (6d-2)
  const isReserve = (spec: string): boolean =>
    folder !== 'risk' && spec.startsWith('.') && path.relative(SRC, path.resolve(SRC, path.dirname(rel), spec)).split(path.sep).join('/').toLowerCase() === 'risk/reserve.ts';
  const BUDGET_RULE = 'positionExitBudget stays inside risk/ (C2): the reserve holds it, nothing spends it';

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      checkSpecifier(node.moduleSpecifier.text, clause?.isTypeOnly === true);
      if (clause !== undefined && !clause.isTypeOnly && isReserve(node.moduleSpecifier.text)) {
        const named = clause.namedBindings;
        if (clause.name !== undefined || (named !== undefined && ts.isNamespaceImport(named))) {
          problems.push(`${rel}: import risk/reserve.ts by name outside risk/: ${BUDGET_RULE}`);
        } else if (named !== undefined && ts.isNamedImports(named) && named.elements.some((e) => !e.isTypeOnly && (e.propertyName ?? e.name).text === 'positionExitBudget')) {
          problems.push(`${rel}: ${BUDGET_RULE}`);
        }
      }
      if (isCrypto(node.moduleSpecifier) && clause !== undefined && !clause.isTypeOnly) {
        const bindings = clause.namedBindings;
        if (clause.name !== undefined || (bindings !== undefined && ts.isNamespaceImport(bindings))) {
          problems.push(`${rel}: import named functions from node:crypto (no default or namespace import)`);
        } else if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const imported = (element.propertyName ?? element.name).text;
            if (rel === RNG_FILE ? !RNG_CRYPTO.has(imported) : !element.isTypeOnly && !CRYPTO_ALLOWED.has(imported)) {
              problems.push(rel === RNG_FILE ? `${rel}: core/rng.ts imports randomBytes only from node:crypto (not ${imported})` : `${rel}: ${imported} from node:crypto is not allowed outside core/rng.ts`);
            }
          }
        }
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      checkSpecifier(node.moduleSpecifier.text, node.isTypeOnly, true);
      if (isCrypto(node.moduleSpecifier) && !node.isTypeOnly) {
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
          checkSpecifier(arg.text, false, false, true);
          if (isCrypto(arg)) {
            problems.push(`${rel}: node:crypto may not be imported dynamically`);
          }
          if (isReserve(arg.text)) {
            problems.push(`${rel}: risk/reserve.ts is not imported dynamically outside risk/: ${BUDGET_RULE}`);
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
    if (!CLOCK_EXEMPT.has(rel)) {
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
      !CLOCK_EXEMPT.has(rel)
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
      if (!CLOCK_EXEMPT.has(rel) && !isTypePosition(node)) {
        const problem = clockProblem(node);
        if (problem !== null) {
          problems.push(`${rel}: ${problem} outside core/clock.ts`);
        }
      }
      if (node.text === 'crypto' && !inTypeContext(node)) {
        problems.push(`${rel}: the global crypto (randomness) is never used: core/rng.ts imports randomBytes`);
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
    if (!CLOCK_EXEMPT.has(rel) && (dotted || indexed)) {
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
        problems.push(`${rel}: ${owner}.${member} outside core/clock.ts`);
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
    // `arguments` hands every argument on as any: a database handle among them would pass the typed rules unseen (review Q re-check, security R2)
    if (ts.isIdentifier(node) && node.text === 'arguments' && !isPropertyName(node)) {
      problems.push(`${rel}: no "arguments" (it hands every argument on as any, past the typed rules)`);
    }
    // the wrapper over a connection that is already open is for the fault-injection tests: no source file uses it
    if (rel !== SQLITE_FILE && (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === 'wrapConnection') {
      problems.push(`${rel}: wrapConnection is for the storage tests only (the bot opens databases with openDb)`);
    }
    // no "any": a value cast to it hides its type from the typed rules (the SQL rule below), and from the type check
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      problems.push(`${rel}: no "any" (every value keeps a type the checks can see)`);
    }
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) &&
      CONFLICT_CLAUSE.test(node.text)
    ) {
      problems.push(`${rel}: no OR REPLACE, OR IGNORE or other conflict clause in SQL (ON CONFLICT (...) DO NOTHING or DO UPDATE instead)`);
    }
    // multi-statement SQL skips the one-statement checks: only the schema runner may run it
    if (!SCRIPT_FILES.has(rel)) {
      const isScript = (n: ts.Node | undefined): boolean =>
        n !== undefined && (ts.isIdentifier(n) || ts.isStringLiteralLike(n)) && n.text === 'script';
      if (
        (ts.isPropertyAccessExpression(node) && node.name.text === 'script') ||
        (ts.isElementAccessExpression(node) && isScript(node.argumentExpression)) ||
        (ts.isBindingElement(node) && isScript(node.propertyName ?? node.name))
      ) {
        problems.push(`${rel}: only storage/migrations.ts runs multi-statement SQL (tx.script)`);
      }
    }
    // the authority is made in one place only (names compared exactly: this is our own code), and that
    // place calls the factory under its own name and hands out built authorities, never the factory
    if (ts.isIdentifier(node) && node.text === 'createApprovalAuthority') {
      const parent = node.parent;
      const plainImport = ts.isImportSpecifier(parent) && parent.propertyName === undefined;
      const call = ts.isCallExpression(parent) && parent.expression === node;
      if (!AUTHORITY_FILES.has(rel)) {
        problems.push(`${rel}: only app/authority.ts creates the approval authority (it binds the token store and the slot source)`);
      } else if (rel === 'app/authority.ts' && !plainImport && !call) {
        problems.push(`${rel}: app/authority.ts calls the factory and hands out built authorities, never the factory itself`);
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

/** Paths that differ only in case: one file on Windows and macOS, two on Linux, so a rule keyed by name could miss one. */
function caseCollisions(files: readonly string[]): string[] {
  const seen = new Map<string, string>();
  const clashes: string[] = [];
  for (const file of files) {
    const key = file.toLowerCase();
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, file);
    } else {
      clashes.push(`${first} and ${file}`);
    }
  }
  return clashes;
}

// ---------------------------------------------------------------- the SQL rule (typed)

/** The compiler options of tsconfig.json: the typed rule sees the code exactly as the type check does. */
function compilerOptions(): ts.CompilerOptions {
  const parsed = ts.getParsedCommandLineOfConfigFile(path.resolve(SRC, '../tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
  assert.ok(parsed !== undefined, 'tsconfig.json parses');
  return parsed.options;
}

const SQL_METHODS = new Set(['get', 'all', 'run', 'script']);
/** The wrapper's handle types: their get, all, run and script take SQL text. */
const HANDLE_TYPES = new Set(['Reader', 'Tx', 'Db']);
/** The files that may run SQL: the repositories, the audit chain and the schema runner (and the wrapper itself). */
const SQL_FILE = /^storage\/(?:repo-[a-z0-9-]+|audit-[a-z0-9-]+|migrations)\.ts$/;

// ---------------------------------------------------------------- which file writes what (review Q, security finding 2)

interface SqlToken {
  readonly kind: 'word' | 'name' | 'string' | 'number' | 'param' | 'punct';
  readonly text: string;
}

const SQL_TOKEN_PATTERNS: readonly (readonly [SqlToken['kind'], RegExp])[] = [
  ['word', /^[A-Za-z_][A-Za-z0-9_$]*/],
  ['number', /^(?:0[xX][0-9A-Fa-f]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/],
  ['param', /^[?:@$#][A-Za-z0-9_]*/],
  ['punct', /^(?:<>|!=|==|<=|>=|\|\||<<|>>|->>|->|\S)/],
];

/**
 * SQL as tokens: keywords and plain names as lower-case words, quoted names (lower case), 'strings',
 * numbers, parameters and punctuation. Comments are skipped (the wrapper refuses them anyway).
 */
function sqlTokens(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    const skip = /^(?:\s+|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))/.exec(rest)?.[0];
    const open = sql.charAt(i);
    if (skip !== undefined) {
      i += skip.length;
    } else if (open === "'" || open === '"' || open === '`' || open === '[') {
      const close = open === '[' ? ']' : open;
      let text = '';
      let j = i + 1;
      while (j < sql.length) {
        const c = sql.charAt(j);
        j += 1;
        if (c !== close) {
          text += c;
        } else if (close !== ']' && sql.charAt(j) === close) {
          text += c; // a doubled quote stands for one
          j += 1;
        } else {
          break;
        }
      }
      tokens.push(open === "'" ? { kind: 'string', text } : { kind: 'name', text: text.toLowerCase() });
      i = j;
    } else {
      let kind: SqlToken['kind'] = 'punct';
      let text = open;
      for (const [k, pattern] of SQL_TOKEN_PATTERNS) {
        const found = pattern.exec(rest)?.[0];
        if (found !== undefined) {
          kind = k;
          text = found;
          break;
        }
      }
      tokens.push({ kind, text: kind === 'word' ? text.toLowerCase() : text });
      i += Math.max(1, text.length);
    }
  }
  return tokens;
}

const isWordToken = (t: SqlToken | undefined, ...words: readonly string[]): boolean => t?.kind === 'word' && words.includes(t.text);
const isPunctToken = (t: SqlToken | undefined, text: string): boolean => t?.kind === 'punct' && t.text === text;
const isNameToken = (t: SqlToken | undefined): t is SqlToken => t?.kind === 'word' || t?.kind === 'name';
/** The same tokens; a quoted name and a plain one are the same name. */
const sameTokens = (a: readonly SqlToken[], b: readonly SqlToken[]): boolean =>
  a.length === b.length &&
  a.every((t, k) => {
    const u = b[k];
    return u !== undefined && t.text === u.text && (t.kind === u.kind || (isNameToken(t) && isNameToken(u)));
  });

interface SetItem {
  /** The column, or null when the item is not `column = value` (the (a, b) = (...) form). */
  readonly column: string | null;
  readonly value: readonly SqlToken[];
}

interface SqlWrite {
  /** The table written ([schema.]table: the table's own name), or null when the rule cannot read it. */
  readonly table: string | null;
  readonly kind: 'insert' | 'update' | 'delete';
  readonly sets: readonly SetItem[];
  readonly where: readonly SqlToken[];
}

/** An UPDATE's SET clause, item by item (split at the commas outside brackets). */
function setItems(clause: readonly SqlToken[]): SetItem[] {
  const items: SetItem[] = [];
  let depth = 0;
  let start = 0;
  for (let k = 0; k <= clause.length; k += 1) {
    const t = clause[k];
    if (k === clause.length || (depth === 0 && isPunctToken(t, ','))) {
      const item = clause.slice(start, k);
      const first = item[0];
      const named = isNameToken(first) && isPunctToken(item[1], '=');
      items.push(named ? { column: first.text, value: item.slice(2) } : { column: null, value: item });
      start = k + 1;
    } else if (isPunctToken(t, '(')) {
      depth += 1;
    } else if (isPunctToken(t, ')')) {
      depth -= 1;
    }
  }
  return items;
}

/** Every INSERT, UPDATE and DELETE in the SQL text; an upsert's DO UPDATE updates the table of its INSERT. */
function sqlWrites(tokens: readonly SqlToken[]): SqlWrite[] {
  const writes: SqlWrite[] = [];
  // the first top-level word of `stops` from `from` on (or the bracket that closes an outer level)
  const stopAt = (from: number, stops: readonly string[]): number => {
    let depth = 0;
    for (let k = from; k < tokens.length; k += 1) {
      const t = tokens[k];
      if (isPunctToken(t, '(')) {
        depth += 1;
      } else if (isPunctToken(t, ')')) {
        if (depth === 0) {
          return k;
        }
        depth -= 1;
      } else if (depth === 0 && isWordToken(t, ...stops)) {
        return k;
      }
    }
    return tokens.length;
  };
  const tableAt = (k: number): string | null => {
    const first = tokens[k];
    const second = isPunctToken(tokens[k + 1], '.') ? tokens[k + 2] : undefined;
    if (!isNameToken(first)) {
      return null;
    }
    if (second === undefined) {
      return first.text;
    }
    return isNameToken(second) ? second.text : null;
  };
  const afterOr = (k: number): number => (isWordToken(tokens[k], 'or') ? k + 2 : k);
  let insertTable: string | null = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (isWordToken(t, 'insert', 'replace') && isWordToken(tokens[afterOr(i + 1)], 'into')) {
      i = afterOr(i + 1); // INSERT OR REPLACE INTO is one insert, not two
      insertTable = tableAt(i + 1);
      writes.push({ table: insertTable, kind: 'insert', sets: [], where: [] });
    } else if (isWordToken(t, 'update') && !isWordToken(tokens[i - 1], 'before', 'after', 'of')) {
      // (BEFORE, AFTER and INSTEAD OF UPDATE name a trigger's event, not a write)
      const table = isWordToken(tokens[i - 1], 'do') ? insertTable : tableAt(afterOr(i + 1));
      const set = stopAt(i + 1, ['set']); // past an alias or INDEXED BY
      const end = stopAt(set + 1, ['where', 'from', 'returning', 'order', 'limit', 'on']);
      const where = isWordToken(tokens[end], 'where') ? tokens.slice(end + 1, stopAt(end + 1, ['returning', 'order', 'limit', 'on'])) : [];
      writes.push({ table, kind: 'update', sets: setItems(tokens.slice(set + 1, end)), where });
    } else if (isWordToken(t, 'delete') && isWordToken(tokens[i + 1], 'from')) {
      const end = stopAt(i + 2, ['where', 'returning', 'order', 'limit']); // past an alias or INDEXED BY
      const where = isWordToken(tokens[end], 'where') ? tokens.slice(end + 1, stopAt(end + 1, ['returning', 'order', 'limit'])) : [];
      writes.push({ table: tableAt(i + 2), kind: 'delete', sets: [], where });
    }
  }
  return writes;
}

/** The files that lift what only the owner lifts (STORAGE_DESIGN s.12.1): the owner's commands and the owner at the server. */
const OWNER_WRITERS: readonly string[] = ['storage/repo-owner.ts', 'storage/repo-server.ts'];
/** Config versions: the owner's commands, the setup at the server, and the engine's checked due step (STORAGE_DESIGN s.14). */
const CONFIG_VERSION_WRITERS: readonly string[] = [...OWNER_WRITERS, 'storage/repo-config.ts'];
/** The day state: the engine's own writer, and the owner's resume and the server's reset with their restarts. */
const DAY_STATE_WRITERS: readonly string[] = ['storage/repo-day.ts', ...OWNER_WRITERS];
/** The start of the one WHERE that may close a position in this step (the abandon's). */
const OPENING_WHERE = sqlTokens("id = ? AND status = 'opening'");
/** A position's amounts: in this step only the abandon moves them (review S, risk 5). */
const POSITION_MONEY: readonly string[] = [
  'token_units',
  'cost_basis',
  'rent_locked',
  'realized',
  'bought',
  'sold',
  'venue_fees',
  'network_fees',
  'failed_fees',
  'tips',
  'rent_paid',
  'rent_refunded',
  'tokens_bought',
  'tokens_sold',
  'exit_fees',
  'basis_released',
];

/**
 * What a statement writes that its file may not (review Q, security finding 2). The database checks
 * an audit row's id, link and actor but not its hash, so a raw INSERT INTO audit_log anywhere could
 * forge the owner's row that a clear needs; the import rules alone do not stop that. So: audit rows
 * only from audit-chain.ts; lifting a halt, clearing KILL or the pause, the time halts were lifted and
 * a strategy's mode only from the owner's and the server's files (the engine's file may only demote,
 * live to paper); a gate start only moves later; the flags row and the mode rows are the migration's.
 */
function writeProblems(rel: string, sql: string): string[] {
  const out: string[] = [];
  const one = sqlTokens('1');
  for (const w of sqlWrites(sqlTokens(sql))) {
    // every assignment to the column: SQLite accepts one column twice in a SET and takes the last (VERIFIED_FACTS)
    const items = (column: string): readonly SetItem[] => w.sets.filter((s) => s.column === column);
    const has = (...columns: readonly string[]): boolean => columns.some((c) => items(c).length > 0);
    const named = w.sets.flatMap((s) => (s.column === null ? [] : [s.column]));
    if (w.table === null) {
      out.push(`${rel}: write to a table named plainly (the write rules could not read this one)`);
    } else if (w.table === 'audit_log') {
      if (rel !== 'storage/audit-chain.ts') {
        out.push(`${rel}: only storage/audit-chain.ts writes audit_log (everything else calls its writers)`);
      }
    } else if (w.table === 'halt_reasons') {
      if (w.kind !== 'insert' && !OWNER_WRITERS.includes(rel)) {
        out.push(`${rel}: only repo-owner.ts and repo-server.ts lift a halt (DELETE or UPDATE on halt_reasons)`);
      }
    } else if (w.table === 'entry_bans') {
      if (w.kind === 'delete' && rel !== 'storage/repo-flags.ts') {
        out.push(`${rel}: only repo-flags.ts deletes entry bans (its prune keeps them a day after they end)`);
      }
    } else if (w.table === 'config_versions') {
      if (w.kind !== 'insert' || !CONFIG_VERSION_WRITERS.includes(rel)) {
        out.push(`${rel}: config versions are only added, by repo-owner.ts (the owner's commands), repo-server.ts (the setup) and repo-config.ts (the engine's checked due step)`);
      }
    } else if (w.table === 'pending_changes') {
      const queues = w.kind === 'insert' && rel === 'storage/repo-owner.ts';
      const removes = w.kind === 'delete' && (rel === 'storage/repo-owner.ts' || rel === 'storage/repo-config.ts');
      if (!queues && !removes) {
        out.push(`${rel}: only repo-owner.ts queues a loosening, and only it and repo-config.ts (a due row) delete one; none is changed`);
      }
      // each deleted row is one the code checked first (review R, security 5)
      if (removes && !sameTokens(w.where, sqlTokens('path = ?'))) {
        out.push(`${rel}: a waiting change is deleted one at a time, by its path (WHERE path = ?)`);
      }
    } else if (w.table === 'equity_snapshots') {
      if (w.kind === 'update' || rel !== 'storage/repo-day.ts') {
        out.push(`${rel}: only repo-day.ts adds and prunes equity snapshots; none is changed`);
      }
    } else if (w.table === 'ledger_accounts') {
      // the setup writes both accounts once; T3's settlement and Phase 8's transfers get their own reviewed rules (6c-2b-2)
      if (w.kind !== 'insert' || rel !== 'storage/repo-server.ts') {
        out.push(`${rel}: only repo-server.ts writes the ledger accounts, once, at the setup (no UPDATE or DELETE until T3 and the transfers of Phase 8)`);
      }
    } else if (w.table === 'positions') {
      if (rel !== 'storage/repo-book.ts' || w.kind === 'delete') {
        out.push(`${rel}: only repo-book.ts writes positions, and none is deleted`);
        continue;
      }
      if (w.kind === 'update') {
        if (w.sets.some((s) => s.column === null)) {
          out.push(`${rel}: set each column of positions on its own (no (a, b) = (...))`);
        }
        if (new Set(named).size !== named.length) {
          out.push(`${rel}: set each column of positions once (SQLite takes the last of two)`);
        }
        if (items('status').some((s) => !sameTokens(s.value, sqlTokens("'closed'")))) {
          out.push(`${rel}: a position's status is written only as 'closed' in this step (never 'stuck', 'opening' or a parameter; T3 adds its own)`);
        }
        // until T3: only an opening position is closed (the abandon), and only the abandon moves its money (review S, risk 5).
        // The pinned start is a whole clause: the WHERE ends there or goes on with AND, so nothing continues its last
        // comparison (`status = 'opening' = 0` reads as `(status = 'opening') = 0`; review S confirmation, security S8)
        const fromOpening =
          sameTokens(w.where.slice(0, OPENING_WHERE.length), OPENING_WHERE) &&
          (w.where.length === OPENING_WHERE.length || isWordToken(w.where[OPENING_WHERE.length], 'and')) &&
          !w.where.some((t) => isWordToken(t, 'or'));
        if (has('status') && !fromOpening) {
          out.push(`${rel}: a position is closed here only from opening (WHERE id = ? AND status = 'opening' ..., no OR), the abandon`);
        }
        if (has(...POSITION_MONEY) && !has('status')) {
          out.push(`${rel}: a position's amounts move here only with its abandon (T3 adds its own reviewed writes)`);
        }
        if (items('exit_seq').some((s) => !sameTokens(s.value, sqlTokens('exit_seq + 1')))) {
          out.push(`${rel}: a position's exit number only moves up by one (exit_seq + 1)`);
        }
        if (has('id', 'mint', 'strategy', 'mode', 'opened_at', 'max_spend', 'p95_exit_cost')) {
          out.push(`${rel}: a position keeps its id, mint, strategy, mode, opening time, held-back spend and p95 exit cost`);
        }
      }
    } else if (w.table === 'intents' || w.table === 'risk_decisions') {
      if (w.kind !== 'insert' || rel !== 'storage/repo-orders.ts') {
        out.push(`${rel}: only repo-orders.ts adds intents and decisions; none is changed or deleted`);
      }
    } else if (w.table === 'approvals') {
      const issues = w.kind === 'insert' && rel === 'storage/repo-orders.ts';
      const consumes =
        w.kind === 'update' &&
        rel === 'storage/repo-redeem.ts' &&
        w.sets.length === 2 &&
        items('consumed_at').length === 1 &&
        items('consumed_slot').length === 1 &&
        w.sets.every((s) => sameTokens(s.value, sqlTokens('?'))) &&
        sameTokens(w.where, sqlTokens('token_id = ? AND consumed_at IS NULL'));
      if (!issues && !consumes) {
        out.push(`${rel}: only repo-orders.ts adds approvals, and only repo-redeem.ts uses one (consumed_at = ?, consumed_slot = ? WHERE token_id = ? AND consumed_at IS NULL)`);
      }
    } else if (w.table === 'orders') {
      if (w.kind !== 'insert' || rel !== 'storage/repo-redeem.ts') {
        out.push(`${rel}: only repo-redeem.ts adds orders; no status moves in this step, and none is deleted`);
      }
    } else if (w.table === 'flags' || w.table === 'strategy_modes' || w.table === 'day_state') {
      if (w.kind !== 'update') {
        out.push(
          w.table === 'day_state'
            ? `${rel}: the day state rows are the migration's (no INSERT or DELETE)`
            : `${rel}: the flags row and the strategy modes are the migration's (no INSERT or DELETE)`,
        );
        continue;
      }
      if (w.sets.some((s) => s.column === null)) {
        out.push(`${rel}: set each column of ${w.table} on its own (no (a, b) = (...))`);
      }
      if (new Set(named).size !== named.length) {
        out.push(`${rel}: set each column of ${w.table} once (SQLite takes the last of two)`);
      }
      if (w.table === 'flags') {
        const kill = items('kill');
        const paused = items('paused');
        if (kill.some((s) => !sameTokens(s.value, one)) && rel !== 'storage/repo-server.ts') {
          out.push(`${rel}: only repo-server.ts clears KILL (anywhere else kill = 1 only)`);
        }
        if (kill.length === 0 && has('kill_at', 'kill_source', 'kill_audit_id')) {
          out.push(`${rel}: kill_at, kill_source and kill_audit_id change only together with kill`);
        }
        if (paused.some((s) => !sameTokens(s.value, one)) && rel !== 'storage/repo-owner.ts') {
          out.push(`${rel}: only repo-owner.ts clears the pause (anywhere else paused = 1 only)`);
        }
        if (paused.length === 0 && has('paused_at')) {
          out.push(`${rel}: paused_at changes only together with paused`);
        }
        if (has('halt_cleared_at') && !OWNER_WRITERS.includes(rel)) {
          out.push(`${rel}: only repo-owner.ts and repo-server.ts record when halts were lifted (it starts the recovery wait)`);
        }
      } else if (w.table === 'day_state') {
        if (!DAY_STATE_WRITERS.includes(rel)) {
          out.push(`${rel}: only repo-day.ts, repo-owner.ts and repo-server.ts write the day state`);
        }
        // the engine's writer sets it from a parameter and refuses a lift in its code (repo-day.ts); a written 0 is a lift
        const lifts = items('streak_halt').some((s) => !sameTokens(s.value, one) && !sameTokens(s.value, sqlTokens('?')));
        if (lifts && !OWNER_WRITERS.includes(rel)) {
          out.push(`${rel}: only repo-owner.ts and repo-server.ts lift the two-day halt (streak_halt set to anything but 1)`);
        }
      } else {
        const mode = items('mode');
        const demotes =
          rel === 'storage/repo-flags.ts' &&
          mode.length > 0 &&
          mode.every((s) => sameTokens(s.value, sqlTokens("'paper'"))) &&
          sameTokens(w.where, sqlTokens("strategy = ? AND mode = 'live'"));
        if (mode.length > 0 && rel !== 'storage/repo-owner.ts' && !demotes) {
          out.push(`${rel}: only repo-owner.ts sets a strategy's mode (repo-flags.ts only demotes: mode = 'paper' WHERE strategy = ? AND mode = 'live')`);
        }
        if (mode.length === 0 && has('changed_by', 'changed_at')) {
          out.push(`${rel}: changed_by and changed_at change only together with the mode`);
        }
        if (items('gate_since').some((s) => !sameTokens(s.value, sqlTokens('max(gate_since, ?)')))) {
          out.push(`${rel}: a gate start only moves later (gate_since = max(gate_since, ?))`);
        }
        if (has('strategy')) {
          out.push(`${rel}: a strategy's row keeps its strategy`);
        }
      }
    }
  }
  return out;
}

interface TypedRuleResult {
  readonly problems: string[];
  /** Handle calls the constant-SQL rule checked. */
  readonly calls: number;
  /** Writes (INSERT, UPDATE, DELETE) the write rules read. */
  readonly writes: number;
  /** Values of a handle's type whose use was checked. */
  readonly uses: number;
  /** Direct calls to a restricted file's functions. */
  readonly restrictedCalls: number;
  /** Calls of the chain's row writer whose actor was checked. */
  readonly auditCalls: number;
}

/** The expression is the callee of a call: `f(...)` or `ns.f(...)`. */
const isDirectCallee = (e: ts.Node): boolean => ts.isCallExpression(e.parent) && e.parent.expression === e;

/**
 * The typed rules, with the type checker, so the wrapper's methods are told apart from a map's get:
 * - constant SQL (review O, security condition 4; reviews P, condition 8a): every use of a handle's
 *   get, all, run or script is a direct call (no alias, no reference, no [] access, no
 *   destructuring), and only in the files of SQL_FILE: everything else calls a repository. Its SQL is
 *   a literal, or a top-level const of a source file built from literals, other such consts,
 *   templates and + (never a value: values go in parameters), and the text it adds up to has no
 *   conflict clause; the schema runner may also run a migration's own `sql` (each is pinned by its
 *   sha256). A get, all, run or script on a value of type any is refused (with "any" banned, only
 *   JSON.parse and the like make one);
 * - which file writes what (writeProblems; review Q, security finding 2), read from that same text;
 * - a database handle keeps its type (review Q, security finding 4): a value with a handle's methods
 *   has them called directly, goes only to a parameter typed Reader, Tx or Db of storage/sqlite.ts
 *   (or a type parameter constrained to one), and is kept only where the type is one of those (a
 *   variable, field, property, element or return value; one without a written type keeps the
 *   handle's own). So Reflect, Object.*, an assertion or a hand-written structural type cannot carry
 *   it past the rules above, and only sqlite.ts extends or implements the handle types;
 * - a restricted file's functions (RESTRICTED_FILES) are only called where they are imported, never
 *   exported again, aliased, stored, bound or passed on, and a namespace import of one is used only
 *   as ns.name(...) (review Q, security finding 1c);
 * - each writer of the audit chain writes only as its own actors (AUDIT_ACTORS; re-check, R1);
 * - nothing calls a value of type any: its arguments, a handle among them, would go unchecked
 *   (re-check, R2; with "any" and `arguments` banned, only JSON.parse, Reflect and the like make one).
 * Returns the problems, and how much each rule saw (so a rule that sees nothing fails).
 */
export function sqlProblems(program: ts.Program, srcRoot: string): TypedRuleResult {
  const checker = program.getTypeChecker();
  const relOf = (sf: ts.SourceFile): string => path.relative(srcRoot, sf.fileName).split(path.sep).join('/');
  const isHandleMethod = (symbol: ts.Symbol | undefined): boolean =>
    symbol !== undefined &&
    SQL_METHODS.has(symbol.name) &&
    (symbol.declarations ?? []).some(
      (d) => ts.isMethodSignature(d) && ts.isInterfaceDeclaration(d.parent) && HANDLE_TYPES.has(d.parent.name.text) && relOf(d.getSourceFile()) === SQLITE_FILE,
    );
  const isTopLevelConst = (d: ts.VariableDeclaration): boolean =>
    ts.isVariableDeclarationList(d.parent) &&
    (d.parent.flags & ts.NodeFlags.Const) !== 0 &&
    ts.isVariableStatement(d.parent.parent) &&
    ts.isSourceFile(d.parent.parent.parent);
  /** The text a constant SQL expression adds up to, or null when it is not one. */
  const constantText = (expr: ts.Expression, seen: Set<ts.Node>): string | null => {
    const e = ts.isParenthesizedExpression(expr) ? expr.expression : expr;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
      return e.text;
    }
    if (ts.isTemplateExpression(e)) {
      let out = e.head.text;
      for (const span of e.templateSpans) {
        const part = constantText(span.expression, seen);
        if (part === null) {
          return null;
        }
        out += part + span.literal.text;
      }
      return out;
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = constantText(e.left, seen);
      const right = constantText(e.right, seen);
      return left === null || right === null ? null : left + right;
    }
    if (ts.isIdentifier(e)) {
      let symbol = checker.getSymbolAtLocation(e);
      if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
        symbol = checker.getAliasedSymbol(symbol);
      }
      const d = symbol?.valueDeclaration;
      if (d === undefined || !ts.isVariableDeclaration(d) || d.initializer === undefined || !isTopLevelConst(d) || relOf(d.getSourceFile()).startsWith('..') || seen.has(d)) {
        return null;
      }
      seen.add(d);
      return constantText(d.initializer, seen);
    }
    return null;
  };
  /**
   * The runner's own scripts: `m.sql` where m is a Migration of storage/migrations.ts, or a top-level
   * const of that file (the version table, built from schema fragments). Each one's exact text is
   * pinned by its sha256 in a test, which is what makes it constant.
   */
  const isPinnedScript = (e: ts.Expression): boolean => {
    if (ts.isPropertyAccessExpression(e)) {
      return (
        e.name.text === 'sql' &&
        (checker.getSymbolAtLocation(e.name)?.declarations ?? []).some(
          (d) => ts.isPropertySignature(d) && ts.isInterfaceDeclaration(d.parent) && d.parent.name.text === 'Migration' && relOf(d.getSourceFile()) === 'storage/migrations.ts',
        )
      );
    }
    const d = ts.isIdentifier(e) ? checker.getSymbolAtLocation(e)?.valueDeclaration : undefined;
    return d !== undefined && ts.isVariableDeclaration(d) && isTopLevelConst(d) && relOf(d.getSourceFile()) === 'storage/migrations.ts';
  };
  /** An object literal on the left of `=` (perhaps inside another one there): a destructuring assignment. */
  const isAssignmentTarget = (literal: ts.Node): boolean => {
    let child = literal;
    let parent = literal.parent;
    while (ts.isParenthesizedExpression(parent)) {
      child = parent;
      parent = parent.parent;
    }
    if (ts.isBinaryExpression(parent)) {
      return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === child;
    }
    return ts.isObjectLiteralExpression(literal) && ts.isPropertyAssignment(parent) && parent.initializer === child && isAssignmentTarget(parent.parent);
  };
  /** The type a destructuring pattern takes apart: the value it is given, or the parameter's own type. */
  const destructured = (pattern: ts.ObjectBindingPattern): ts.Type | undefined => {
    const owner = pattern.parent;
    if (ts.isVariableDeclaration(owner)) {
      return owner.initializer === undefined ? undefined : checker.getTypeAtLocation(owner.initializer);
    }
    return ts.isParameter(owner) || ts.isBindingElement(owner) ? checker.getTypeAtLocation(owner) : undefined;
  };

  // ---- a handle keeps its type
  const isHandleInterface = (d: ts.Declaration): boolean => ts.isInterfaceDeclaration(d) && HANDLE_TYPES.has(d.name.text) && relOf(d.getSourceFile()) === SQLITE_FILE;
  /** The value has a handle's methods: it is, or may be, a database handle. */
  const carriesHandle = (type: ts.Type): boolean => (type.isUnion() ? type.types.some(carriesHandle) : [...SQL_METHODS].some((m) => isHandleMethod(type.getProperty(m))));
  /** Reader, Tx or Db of storage/sqlite.ts (undefined or null besides is fine), or a type parameter constrained to one. */
  const isHandleSlot = (type: ts.Type): boolean => {
    if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
      const constraint = checker.getBaseConstraintOfType(type);
      return constraint !== undefined && constraint !== type && isHandleSlot(constraint);
    }
    if (type.isUnion()) {
      const rest = type.types.filter((t) => (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0);
      return rest.length > 0 && rest.every(isHandleSlot);
    }
    return (type.getSymbol()?.declarations ?? []).some(isHandleInterface);
  };
  /** The written type of the parameter an argument goes to (in the declaration, before inference); none for a rest parameter or one with no type written. */
  const parameterType = (call: ts.CallExpression | ts.NewExpression, arg: ts.Expression): ts.Type | undefined => {
    const args: readonly ts.Expression[] = call.arguments ?? [];
    const parameter = checker.getResolvedSignature(call)?.getDeclaration()?.parameters[args.indexOf(arg)];
    return parameter?.type === undefined || parameter.dotDotDotToken !== undefined ? undefined : checker.getTypeFromTypeNode(parameter.type);
  };
  const PASSES_ON = new Set([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.CommaToken]);
  const COMPARES = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken]);
  /** Why this use of a value with a handle's type could hand the handle on under another type, or null. */
  const handleUseProblem = (use: ts.Expression): string | null => {
    const p = use.parent;
    if (ts.isPropertyAccessExpression(p) && p.expression === use) {
      // a method is called, never taken; a data property (db.file) is only read
      const data = (checker.getSymbolAtLocation(p.name)?.declarations ?? []).every((d) => ts.isPropertySignature(d));
      return isDirectCallee(p) || data ? null : "call a database handle's methods directly (no reference, .call or .bind)";
    }
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(use) === true) {
      const slot = parameterType(p, use);
      return slot !== undefined && isHandleSlot(slot) ? null : 'a database handle goes only to a parameter typed Reader, Tx or Db (or a type parameter constrained to one)';
    }
    if (ts.isAsExpression(p) || ts.isTypeAssertionExpression(p) || ts.isSatisfiesExpression(p)) {
      return 'no type assertion on a database handle';
    }
    if (ts.isVariableDeclaration(p) && p.initializer === use && !ts.isIdentifier(p.name)) {
      return 'do not destructure a database handle';
    }
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.left === use) {
      return null; // written to: what is written is checked
    }
    const kept =
      ((ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isParameter(p)) && p.initializer === use) ||
      ts.isReturnStatement(p) ||
      (ts.isArrowFunction(p) && p.body === use) ||
      (ts.isPropertyAssignment(p) && p.initializer === use) ||
      ts.isShorthandPropertyAssignment(p) ||
      ts.isArrayLiteralExpression(p) ||
      (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === use);
    if (kept) {
      const slot = checker.getContextualType(use);
      return slot === undefined || isHandleSlot(slot) ? null : 'a database handle is kept only where the type is Reader, Tx or Db';
    }
    // it flows on inside a larger expression of the handle's type (checked in turn), or is only tested
    const passes =
      (ts.isBinaryExpression(p) && (PASSES_ON.has(p.operatorToken.kind) || COMPARES.has(p.operatorToken.kind))) ||
      ts.isConditionalExpression(p) ||
      ts.isAwaitExpression(p) ||
      ts.isExpressionStatement(p) ||
      ts.isExportAssignment(p) ||
      ts.isTypeOfExpression(p) ||
      ts.isVoidExpression(p) ||
      (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) ||
      ((ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) && p.expression === use);
    return passes ? null : 'a database handle goes only to a parameter, variable or return value typed Reader, Tx or Db, or has its methods called';
  };
  /** A value expression whose own type is read (a name that is only a key, a declaration or a type is not one). */
  const isValueExpression = (node: ts.Node): node is ts.Expression =>
    ts.isIdentifier(node) ? !isPropertyName(node) && !isDeclarationName(node) && !inTypeContext(node) : ts.isExpression(node) && !inTypeContext(node);

  // ---- a restricted file's functions are only called
  const resolvedSymbol = (symbol: ts.Symbol | undefined): ts.Symbol | undefined =>
    symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
  /** The restricted file a function comes from, or null (for its data and for everything else). */
  const restrictedFunctionFile = (symbol: ts.Symbol | undefined): string | null => {
    const target = resolvedSymbol(symbol);
    const d = target?.valueDeclaration;
    if (target === undefined || d === undefined || !Object.hasOwn(RESTRICTED_FILES, relOf(d.getSourceFile()))) {
      return null;
    }
    return checker.getTypeOfSymbolAtLocation(target, d).getCallSignatures().length > 0 ? relOf(d.getSourceFile()) : null;
  };
  const isRestrictedNamespace = (symbol: ts.Symbol | undefined): boolean =>
    (resolvedSymbol(symbol)?.declarations ?? []).some((d) => ts.isSourceFile(d) && Object.hasOwn(RESTRICTED_FILES, relOf(d)));

  const problems: string[] = [];
  let calls = 0;
  let writes = 0;
  let uses = 0;
  let restrictedCalls = 0;
  let auditCalls = 0;
  for (const sf of program.getSourceFiles()) {
    const rel = relOf(sf);
    if (sf.isDeclarationFile || rel.startsWith('..') || rel === SQLITE_FILE) {
      continue;
    }
    const checkCall = (access: ts.PropertyAccessExpression, method: string): void => {
      const call = access.parent;
      if (!ts.isCallExpression(call) || call.expression !== access) {
        problems.push(`${rel}: call ${method} directly on the database handle (no alias and no reference)`);
        return;
      }
      calls += 1;
      if (!SQL_FILE.test(rel)) {
        problems.push(`${rel}: only the storage repositories run SQL (storage/repo-*.ts); everything else calls them`);
      }
      const arg = call.arguments[0];
      if (method === 'script' && rel === 'storage/migrations.ts' && arg !== undefined && isPinnedScript(arg)) {
        return;
      }
      const text = arg === undefined ? null : constantText(arg, new Set());
      if (text === null) {
        problems.push(`${rel}: the SQL of ${method} must be a literal or a top-level const built from literals (values go in parameters)`);
      } else if (CONFLICT_CLAUSE.test(text)) {
        problems.push(`${rel}: no OR REPLACE, OR IGNORE or other conflict clause in SQL (ON CONFLICT (...) DO NOTHING or DO UPDATE instead)`);
      } else {
        writes += sqlWrites(sqlTokens(text)).length;
        problems.push(...writeProblems(rel, text));
      }
    };
    const visit = (node: ts.Node): void => {
      if (isValueExpression(node) && !ts.isParenthesizedExpression(node.parent) && !ts.isNonNullExpression(node.parent) && carriesHandle(checker.getTypeAtLocation(node))) {
        uses += 1;
        const problem = handleUseProblem(node);
        if (problem !== null) {
          problems.push(`${rel}: ${problem}`);
        }
      }
      if (ts.isHeritageClause(node) && node.types.some((t) => carriesHandle(checker.getTypeAtLocation(t)))) {
        problems.push(`${rel}: only storage/sqlite.ts extends or implements Reader, Tx or Db (a look-alike type carries a handle past the rules)`);
      }
      if (ts.isCallExpression(node)) {
        if ((checker.getTypeAtLocation(node.expression).flags & ts.TypeFlags.Any) !== 0) {
          problems.push(`${rel}: a call of a value of type any (its arguments, a database handle among them, would go unchecked)`);
        }
        const callee = resolvedSymbol(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression));
        const d = callee?.valueDeclaration;
        if (d !== undefined && ts.isFunctionDeclaration(d) && d.name?.text === 'appendAuditRow' && relOf(d.getSourceFile()) === 'storage/audit-chain.ts' && rel !== 'storage/audit-chain.ts') {
          // the actor is the third argument: its type must be one of the file's own literals, or a union of them
          auditCalls += 1;
          const allowed = AUDIT_ACTORS[rel];
          const actor = node.arguments[2];
          const type = actor === undefined ? undefined : checker.getTypeAtLocation(actor);
          const parts = type === undefined ? [] : type.isUnion() ? type.types : [type];
          if (allowed === undefined || parts.length === 0 || !parts.every((t) => t.isStringLiteral() && allowed.includes(t.value))) {
            const who = allowed === undefined ? "nobody (this file is not one of the chain's writers)" : allowed.join(' or ');
            problems.push(`${rel}: appendAuditRow's actor here must be ${who}, as a literal type (never a string or a wider union)`);
          }
        }
      }
      const parent = node.parent; // undefined only at the file itself
      const imported = ts.isIdentifier(node) && (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent));
      if (ts.isIdentifier(node) && !imported && !inTypeContext(node)) {
        const symbol = ts.isShorthandPropertyAssignment(parent) && parent.name === node ? checker.getShorthandAssignmentValueSymbol(parent) : checker.getSymbolAtLocation(node);
        const from = restrictedFunctionFile(symbol);
        if (from !== null && from !== rel) {
          // ns.f(...) is the call of f; anything but a direct call hands the function on
          const use = ts.isPropertyAccessExpression(parent) && parent.name === node ? parent : node;
          if (isDirectCallee(use)) {
            restrictedCalls += 1;
          } else {
            problems.push(`${rel}: ${node.text} of ${from} is only called where it is imported, never handed on (no export, alias, value, binding or callback)`);
          }
        } else if (from === null && isRestrictedNamespace(symbol) && !(ts.isPropertyAccessExpression(parent) && parent.expression === node)) {
          problems.push(`${rel}: a restricted file's namespace is used only as ${node.text}.name(...)`);
        }
      }
      if (ts.isPropertyAccessExpression(node) && SQL_METHODS.has(node.name.text)) {
        if ((checker.getTypeAtLocation(node.expression).flags & ts.TypeFlags.Any) !== 0) {
          problems.push(`${rel}: .${node.name.text} on a value of type any (a database handle keeps its type)`);
        } else if (isHandleMethod(checker.getSymbolAtLocation(node.name))) {
          checkCall(node, node.name.text);
        }
      } else if (ts.isElementAccessExpression(node)) {
        const type = checker.getTypeAtLocation(node.expression);
        if ([...SQL_METHODS].some((m) => isHandleMethod(type.getProperty(m)))) {
          problems.push(`${rel}: a database handle is used through its named methods only (no [] access)`);
        }
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const key = node.propertyName ?? node.name;
        if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && SQL_METHODS.has(key.text) && isHandleMethod(destructured(node.parent)?.getProperty(key.text))) {
          problems.push(`${rel}: do not take ${key.text} off a database handle`);
        }
      } else if ((ts.isShorthandPropertyAssignment(node) || ts.isPropertyAssignment(node)) && isAssignmentTarget(node.parent)) {
        // ({ run } = tx) or ({ run: r } = tx): a destructuring assignment
        const name = node.name;
        if (ts.isIdentifier(name) && SQL_METHODS.has(name.text) && isHandleMethod(checker.getPropertySymbolOfDestructuringAssignment(name))) {
          problems.push(`${rel}: do not take ${name.text} off a database handle`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { problems, calls, writes, uses, restrictedCalls, auditCalls };
}

export interface NoCatchResult {
  readonly problems: string[];
  /** Transaction callbacks found in app/ and cli/. */
  readonly callbacks: number;
  /** Function bodies followed from them. */
  readonly followed: number;
}

/**
 * No catch inside a transaction (C32; STORAGE_DESIGN s.16.7.4), with the type checker, over app/ and
 * cli/. A repository's precondition refusal is thrown before its statement runs, so the runtime
 * backstop (a statement that threw sinks its transaction even if caught) cannot see it being
 * swallowed; this rule can:
 * 1. the argument of every call of Db.transaction (resolved to storage/sqlite.ts) is an arrow function
 *    or a function expression written in place;
 * 2. its body, nested functions included, has no try statement and calls no member named catch, then
 *    or finally;
 * 3. every call (or `new`) in it of a function, method or class declared in app/ or cli/ is followed,
 *    with a visited set, and that body is held to rules 2 to 4;
 * 4. an argument that could hand the transaction on is passed only to a function declared in
 *    storage/, app/ or cli/ (followed by rule 3) or in TypeScript's own lib files (Promise's members
 *    excepted): a function written in place, any value that can be called (a closure over the
 *    transaction kept in a variable, a bound function), and any value that holds a Reader, Tx or Db
 *    of storage/sqlite.ts (the handle itself, or an object or array holding one, three levels deep).
 *    So an interface method, a parameter or a variable of function type never receives the
 *    transaction or a closure over it (review U, security 1: a closure in a variable, an object
 *    holding the handle and a bound function used to get past);
 * 5. in storage/ (sqlite.ts and migrations.ts excepted) every catch block ends with a throw.
 * LIMIT, written down: code behind an interface or reached through `this` is not followed; rule 4
 * keeps the transaction and every function value from it, but not a handle hidden deeper than three
 * levels or behind a type rewritten by hand (app/ has no classes with such methods); review is the
 * guard there.
 */
export function noCatchProblems(program: ts.Program, srcRoot: string): NoCatchResult {
  const checker = program.getTypeChecker();
  const relOf = (sf: ts.SourceFile): string => path.relative(srcRoot, sf.fileName).split(path.sep).join('/');
  const inSrc = (rel: string): boolean => !rel.startsWith('..') && !path.isAbsolute(rel);
  const problems: string[] = [];
  let callbacks = 0;
  let followed = 0;
  const visited = new Set<ts.Node>();

  const declarationOf = (callee: ts.Expression): ts.Declaration | undefined => {
    const at = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
    let symbol = checker.getSymbolAtLocation(at);
    if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  };
  /** The body a call of this declaration runs, when it is one the rule can follow. */
  const bodyOf = (d: ts.Declaration): ts.Node | undefined => {
    if ((ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) && d.body !== undefined) {
      return d.body;
    }
    if (ts.isVariableDeclaration(d) && d.initializer !== undefined && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
      return d.initializer.body;
    }
    if (ts.isClassDeclaration(d)) {
      return d.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m))?.body;
    }
    return undefined;
  };
  const folderOf = (rel: string): string => rel.split('/')[0] ?? '';
  const isPromiseMember = (d: ts.Declaration): boolean => {
    for (let n: ts.Node | undefined = d.parent; n !== undefined; n = n.parent) {
      if ((ts.isInterfaceDeclaration(n) || ts.isClassDeclaration(n)) && n.name !== undefined && n.name.text.includes('Promise')) {
        return true;
      }
    }
    return false;
  };
  const isHandleType = (type: ts.Type): boolean =>
    (type.isUnion() ? type.types : [type]).some((t) => {
      const symbol = t.getSymbol() ?? t.aliasSymbol;
      return symbol !== undefined && HANDLE_TYPES.has(symbol.name) && (symbol.declarations ?? []).some((d) => relOf(d.getSourceFile()) === SQLITE_FILE);
    });
  /** The handle itself, or an object or array whose properties or elements hold one, up to `depth` levels down. */
  const holdsHandle = (type: ts.Type, depth: number): boolean =>
    isHandleType(type) ||
    (depth > 0 &&
      (type.isUnion() ? type.types : [type]).some(
        (t) =>
          [t.getNumberIndexType(), t.getStringIndexType()].some((e) => e !== undefined && holdsHandle(e, depth - 1)) ||
          t.getProperties().some((p) => {
            const d = p.valueDeclaration ?? p.declarations?.[0];
            return d !== undefined && holdsHandle(checker.getTypeOfSymbolAtLocation(p, d), depth - 1);
          }),
      ));
  const isCallable = (type: ts.Type): boolean => (type.isUnion() ? type.types : [type]).some((t) => t.getCallSignatures().length > 0);
  /** Rule 4: an argument that could hand the transaction on. */
  const handsOn = (a: ts.Expression): boolean => {
    if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) {
      return true;
    }
    const type = checker.getTypeAtLocation(a);
    return isCallable(type) || holdsHandle(type, 3);
  };
  const isTransactionCall = (call: ts.CallExpression): boolean => {
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'transaction') {
      return false;
    }
    const d = declarationOf(call.expression);
    return d !== undefined && relOf(d.getSourceFile()) === SQLITE_FILE;
  };

  const checkBody = (rel: string, where: string, root: ts.Node): void => {
    const visit = (node: ts.Node): void => {
      if (ts.isTryStatement(node)) {
        problems.push(`${rel}: no try inside a transaction callback (${where})`);
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const callee = node.expression;
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(callee) && ['catch', 'then', 'finally'].includes(callee.name.text)) {
          problems.push(`${rel}: no .${callee.name.text}( inside a transaction callback (${where})`);
        }
        const d = declarationOf(callee);
        const dRel = d === undefined ? '' : relOf(d.getSourceFile());
        const body = d === undefined ? undefined : bodyOf(d);
        const carries = (node.arguments ?? []).some(handsOn);
        if (carries) {
          const ours = d !== undefined && body !== undefined && inSrc(dRel) && ['storage', 'app', 'cli'].includes(folderOf(dRel));
          const lib = d !== undefined && program.isSourceFileDefaultLibrary(d.getSourceFile()) && !isPromiseMember(d);
          if (!ours && !lib) {
            problems.push(`${rel}: the transaction, a function or a value holding the transaction goes only to a function of storage/, app/ or cli/, or of TypeScript's own lib (${where})`);
          }
        }
        if (body !== undefined && inSrc(dRel) && ['app', 'cli'].includes(folderOf(dRel)) && !visited.has(body)) {
          visited.add(body);
          followed += 1;
          checkBody(dRel, `followed from ${rel}`, body);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
  };

  for (const sf of program.getSourceFiles()) {
    const rel = relOf(sf);
    if (!inSrc(rel) || sf.isDeclarationFile) {
      continue;
    }
    const folder = folderOf(rel);
    if (folder === 'storage' && rel !== SQLITE_FILE && rel !== 'storage/migrations.ts') {
      const visitCatch = (node: ts.Node): void => {
        if (ts.isCatchClause(node)) {
          const last = node.block.statements.at(-1);
          if (last === undefined || !ts.isThrowStatement(last)) {
            problems.push(`${rel}: a catch block in storage/ ends with a throw (a repository never swallows a refusal)`);
          }
        }
        ts.forEachChild(node, visitCatch);
      };
      visitCatch(sf);
    }
    if (folder !== 'app' && folder !== 'cli') {
      continue;
    }
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isTransactionCall(node)) {
        callbacks += 1;
        const fn = node.arguments[0];
        if (fn === undefined || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
          problems.push(`${rel}: a transaction callback is written in place (an arrow function or a function expression)`);
        } else {
          checkBody(rel, 'a transaction callback', fn.body);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { problems, callbacks, followed };
}

/** A program over virtual source files (for the canaries), checked with the project's options. */
function virtualProgram(files: Readonly<Record<string, string>>): { readonly program: ts.Program; readonly srcRoot: string } {
  const srcRoot = path.join(tmpdir(), 'fomo-sql-canary', 'src');
  const options = { ...compilerOptions(), types: [] };
  const host = ts.createCompilerHost(options);
  const contents = new Map(Object.entries(files).map(([rel, text]) => [path.join(srcRoot, rel), text]));
  const realGet = host.getSourceFile.bind(host);
  const realExists = host.fileExists.bind(host);
  const realRead = host.readFile.bind(host);
  host.getSourceFile = (fileName, version, onError, create) => {
    const text = contents.get(path.resolve(fileName));
    return text === undefined ? realGet(fileName, version, onError, create) : ts.createSourceFile(fileName, text, version, true, ts.ScriptKind.TS);
  };
  const realDirectory = host.directoryExists?.bind(host);
  host.fileExists = (fileName) => contents.has(path.resolve(fileName)) || realExists(fileName);
  host.readFile = (fileName) => contents.get(path.resolve(fileName)) ?? realRead(fileName);
  // the resolver looks for the folder first: without this every import between virtual files fails,
  // the types become errors (which count as any), and a canary would be caught for the wrong reason
  host.directoryExists = (dir) => [...contents.keys()].some((file) => file.startsWith(path.resolve(dir) + path.sep)) || (realDirectory?.(dir) ?? false);
  const program = ts.createProgram([...contents.keys()], options, host);
  const unresolved = ts.getPreEmitDiagnostics(program).filter((d) => d.code === 2307).map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
  assert.deepEqual(unresolved, [], 'every import between the virtual files resolves');
  return { program, srcRoot };
}

const flagged = (cases: readonly (readonly [string, string])[]): void => {
  for (const [rel, text] of cases) {
    assert.ok(checkSource(rel, text).length > 0, `should flag ${rel}: ${text}`);
  }
};

/** Each case is caught for its own reason: one of its problems names the rule (review Q, security finding 5). */
const flaggedFor = (cases: readonly (readonly [string, string, string])[]): void => {
  for (const [rel, text, why] of cases) {
    const problems = checkSource(rel, text);
    assert.ok(
      problems.some((p) => p.startsWith(`${rel}: `) && p.includes(why)),
      `should flag ${rel} because "${why}": ${text}\n  got: ${problems.join('\n  got: ')}`,
    );
  }
};

/** The same for the typed rules: each file has a problem that names its rule. */
const typedFlaggedFor = (problems: readonly string[], cases: Readonly<Record<string, readonly [string, ...string[]]>>): void => {
  for (const [rel, [text, ...whys]] of Object.entries(cases)) {
    for (const why of whys) {
      assert.ok(
        problems.some((p) => p.startsWith(`${rel}: `) && p.includes(why)),
        `should flag ${rel} because "${why}": ${text}\n  got: ${problems.filter((p) => p.startsWith(`${rel}: `)).join('\n  got: ')}`,
      );
    }
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

  it('CANARY: core/rng.ts is held to the pure rules, with randomBytes from node:crypto its only door (6d-1, STORAGE_DESIGN s.16.7.4)', () => {
    flaggedFor([
      ['core/rng.ts', "import { randomUUID } from 'node:crypto';", 'core/rng.ts imports randomBytes only from node:crypto (not randomUUID)'],
      ['core/rng.ts', "import { createHash } from 'node:crypto';", 'core/rng.ts imports randomBytes only'],
      ['core/rng.ts', "import { randomBytes as r, randomInt } from 'node:crypto';", 'not randomInt'],
      ['core/rng.ts', "import * as c from 'node:crypto';", 'import named functions from node:crypto'],
      ['core/rng.ts', "import c from 'node:crypto';", 'import named functions from node:crypto'],
      ['core/rng.ts', "export { randomBytes } from 'node:crypto';", 'node:crypto may not be re-exported'],
      ['core/rng.ts', "export const c = async (): Promise<unknown> => import('node:crypto');", 'no dynamic import in core/'],
      ['core/rng.ts', "import { readFileSync } from 'node:fs';", 'node:fs is not allowed in core/'],
      ['core/rng.ts', 'export const r = (): number => Math.random();', 'Math may only be Math.<member>, never random'],
      ['core/rng.ts', 'export const t = (): number => Date.now();', 'Date may only be'],
      ['core/rng.ts', 'export const v = (): Uint8Array => crypto.getRandomValues(new Uint8Array(4));', 'the global crypto'],
      ['core/rng.ts', 'export const p = (): number => process.pid;', 'process is not allowed in core/'],
      ['core/rng.ts', "export const b = (): unknown => Buffer.from('x');", 'the global Buffer is not allowed in core/'],
    ]);
    // what the real file does stays allowed
    assert.deepEqual(checkSource('core/rng.ts', "import { randomBytes } from 'node:crypto';\nimport { hexOf } from './encode.ts';\nexport const id = (): string => hexOf(randomBytes(16));"), []);
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

  it('config/caps.ts is the one file of config/ that pure code may import at runtime, and it is held to the pure rules itself', () => {
    assert.deepEqual(checkSource('risk/x.ts', "import { HARD_CAPS } from '../config/caps.ts';"), []);
    assert.deepEqual(checkSource('portfolio/x.ts', "import { HARD_CAPS } from '../config/caps.ts';"), []);
    assert.deepEqual(checkSource('config/caps.ts', "import type { Lamports } from '../core/units.ts'; export const x = 1;"), []); // types are erased
    flagged([
      ['config/caps.ts', "import { readFileSync } from 'node:fs';"],
      ['config/caps.ts', 'export const now = Date.now();'],
      ['config/caps.ts', 'console.log(1);'],
      ['risk/x.ts', "import { load } from '../config/tunables-loader.ts';"],
    ]);
  });

  it('CANARY: the caps exception cannot be widened (REVIEWS.md L, security finding 1)', () => {
    flagged([
      // a: a look-alike name is another file on Linux: never granted the exception, and held to the pure rules itself
      ['risk/x.ts', "import { HARD_CAPS } from '../config/Caps.ts';"],
      ['risk/x.ts', "import { HARD_CAPS } from '../Config/caps.ts';"],
      ['config/Caps.ts', "import { readFileSync } from 'node:fs';"],
      // b: caps.ts imports nothing at runtime, not even along config/'s own edges
      ['config/caps.ts', "import { readFileSync } from '../storage/fsx.ts';"],
      ['config/caps.ts', "import { lamports } from '../core/units.ts';"],
      ['config/caps.ts', "import { x } from 'some-package';"],
      ['config/caps.ts', "const m = import('../storage/fsx.ts');"],
      // c: nor does it re-export another file, of its own folder or any other
      ['config/caps.ts', "export { loader } from './loader.ts';"],
      ['config/caps.ts', "export * from './loader.ts';"],
      ['config/caps.ts', "export * as all from '../storage/fsx.ts';"],
    ]);
    assert.deepEqual(caseCollisions(['config/caps.ts', 'config/Caps.ts', 'risk/a.ts']), ['config/caps.ts and config/Caps.ts']);
  });

  it('CANARY: only app/authority.ts creates the approval authority (REVIEWS.md K, security findings 2 and 3; N, finding 3)', () => {
    flagged([
      ['app/engine.ts', "import { createApprovalAuthority } from '../risk/approval.ts';"],
      ['app/x.ts', "import { createApprovalAuthority as make } from '../risk/approval.ts'; export const a = make;"],
      ['cli/x.ts', "import { createApprovalAuthority } from '../risk/approval.ts';"],
      ['risk/approve.ts', 'export const again = createApprovalAuthority;'],
      // every other way to reach the factory: a namespace, a computed key, a dynamic import, a re-export, a non-type import of a type
      ['app/engine.ts', "import * as approval from '../risk/approval.ts'; export const f = approval['create' + 'ApprovalAuthority'];"],
      ['app/engine.ts', "export const load = async () => (await import('../risk/approval.ts'))['create' + 'ApprovalAuthority'];"],
      ['risk/x.ts', "export * from './approval.ts';"],
      ['app/engine.ts', "import { type ApprovalToken } from '../risk/approval.ts'; export const t = (x: ApprovalToken): ApprovalToken => x;"],
      // the authority file hands out built authorities, never the factory, under its own name or another
      ['app/authority.ts', "import { createApprovalAuthority } from '../risk/approval.ts'; export const make = createApprovalAuthority;"],
      ['app/authority.ts', "import { createApprovalAuthority as make } from '../risk/approval.ts'; export const a = make({} as never);"],
      ['app/authority.ts', "export { createApprovalAuthority } from '../risk/approval.ts';"],
    ]);
    assert.deepEqual(checkSource('app/authority.ts', "import { createApprovalAuthority } from '../risk/approval.ts'; export const paper = createApprovalAuthority({} as never);"), []);
  });

  it('CANARY: a relative import is a plain path: a query, fragment, escape, space or backslash would load a second module past the rules (REVIEWS.md N)', () => {
    flagged([
      ['risk/sneak.ts', "import * as a from './approval.ts?x=.ts'; export const f = a['create' + 'ApprovalAuthority'];"],
      ['risk/sneak.ts', "import * as a from './approval.ts#.ts'; export const f = a;"],
      ['risk/x.ts', "import { systemClock } from '../core/clock.ts?fresh=.ts';"],
      ['risk/x.ts', "import { x } from './a%2Eb.ts';"],
      ['risk/x.ts', "import { x } from './a b.ts';"],
      ['risk/x.ts', "import { x } from '.\\\\approve.ts';"],
      ['risk/x.ts', "import { x } from './approve';"],
      ['risk/x.ts', "import { x } from './approve.ts.json';"],
    ]);
    assert.deepEqual(checkSource('risk/x.ts', "import { approveBuy } from './approve.ts'; import { HARD_CAPS } from '../config/caps.ts'; export const a = [approveBuy, HARD_CAPS];"), []);
    assert.deepEqual(checkSource('app/engine.ts', "import type { ApprovalVerifier } from '../risk/approval.ts'; export const v = (x: ApprovalVerifier): ApprovalVerifier => x;"), []);
  });

  it('CANARY: only storage/sqlite.ts imports node:sqlite, and only storage/migrations.ts runs scripts (STORAGE_DESIGN.md s.5)', () => {
    flagged([
      ['storage/repo-x.ts', "import { DatabaseSync } from 'node:sqlite';"],
      ['storage/codec.ts', "import type { DatabaseSync } from 'node:sqlite'; export type D = DatabaseSync;"],
      ['storage/x.ts', "export { DatabaseSync } from 'node:sqlite';"],
      ['app/x.ts', "export const load = async () => import('node:sqlite');"],
      ['storage/x.ts', "import * as s from 'sqlite'; export const t = s;"],
      ['storage/SQLite.ts', "import { DatabaseSync } from 'node:sqlite'; export const d = DatabaseSync;"], // a look-alike name is another file
      ['app/x.ts', "import type { Tx } from '../storage/sqlite.ts'; export const f = (tx: Tx): void => tx.script('DROP TABLE a');"],
      ['app/x.ts', "import type { Tx } from '../storage/sqlite.ts'; export const f = (tx: Tx): void => tx['script']('DROP TABLE a');"],
      ['storage/repo-x.ts', "import type { Tx } from './sqlite.ts'; export const f = (tx: Tx): void => { const { script } = tx; script('x'); };"],
      ['storage/repo-x.ts', "import type { Tx } from './sqlite.ts'; export const f = (tx: Tx): void => { const { script: s } = tx; s('x'); };"],
    ]);
    assert.deepEqual(checkSource('storage/sqlite.ts', "import { DatabaseSync } from 'node:sqlite'; export const d = DatabaseSync;"), []);
    assert.deepEqual(
      checkSource('storage/migrations.ts', "import type { Tx } from './sqlite.ts'; export const f = (tx: Tx): void => tx.script('CREATE TABLE a (x TEXT) STRICT;');"),
      [],
    );
    assert.deepEqual(checkSource('app/x.ts', 'export const o = { script: 1 };'), []); // a key named script runs nothing
    // the wrapper hands nothing of node:sqlite on, and the test-only seam is not used in src/ (review O)
    flagged([
      ['storage/sqlite.ts', "export { DatabaseSync } from 'node:sqlite';"],
      ['storage/sqlite.ts', "export * from 'node:sqlite';"],
      ['storage/sqlite.ts', "export type { DatabaseSync } from 'node:sqlite';"],
      ['app/x.ts', "import { wrapConnection } from '../storage/sqlite.ts'; export const w = wrapConnection;"],
      ['storage/repo-x.ts', "import * as s from './sqlite.ts'; export const w = s['wrapConnection'];"],
    ]);
  });

  it('src/ holds only .ts files: a .js or .mjs file there would never be checked by these rules (review O)', () => {
    const others = readdirSync(SRC, { recursive: true, withFileTypes: true })
      .filter((entry) => !entry.isDirectory() && !entry.name.endsWith('.ts'))
      .map((entry) => path.join(entry.parentPath, entry.name));
    assert.deepEqual(others, []);
  });

  it('no two source files differ only in case (one file on Windows and macOS, two on Linux)', () => {
    assert.deepEqual(caseCollisions(sourceFiles()), []);
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

  it('CANARY: app/ cannot hand risk/ values on, only cli/ reaches app/ at runtime, and nothing outside cli/ reaches cli/ (review Q, security 1a)', () => {
    flagged([
      ['app/x.ts', "export { createApprovalAuthority } from '../risk/approval.ts';"],
      ['app/x.ts', "export * from '../risk/approval.ts';"],
      ['execution/y.ts', "import { build } from '../app/x.ts';"],
      ['signer/y.ts', "import { build } from '../app/x.ts';"],
    ]);
    // app/ may import every folder, so only this rule stops the engine from picking up a command that wraps the server's writers
    flaggedFor([
      ['app/engine.ts', "import { reset } from '../cli/reset.ts'; export const r = reset;", 'may be imported at runtime only from cli'],
      ['app/engine.ts', "export { reset } from '../cli/reset.ts';", 'may be imported at runtime only from cli'],
      ['app/engine.ts', "export const load = async () => import('../cli/reset.ts');", 'may be imported at runtime only from cli'],
      ['app/engine.ts', "import { reset } from '../CLI/reset.ts'; export const r = reset;", 'may be imported at runtime only from cli'], // case
    ]);
    assert.deepEqual(checkSource('app/x.ts', "export type { ApprovalToken } from '../risk/approval.ts';"), []); // types are fine
    assert.deepEqual(checkSource('app/x.ts', "import { approveBuy } from '../risk/approve.ts'; export const build = () => approveBuy;"), []); // using it is the point of app/
    assert.deepEqual(checkSource('cli/y.ts', "import { build } from '../app/x.ts';"), []);
    assert.deepEqual(checkSource('cli/main.ts', "import { reset } from './reset.ts'; export const r = reset;"), []);
    assert.deepEqual(checkSource('app/x.ts', "import type { Reset } from '../cli/reset.ts'; export const f = (r: Reset): Reset => r;"), []); // types are fine
    assert.deepEqual(checkSource('risk/z.ts', "export { approveBuy } from './approve.ts';"), []); // risk/ itself may
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
      checkSource('app/x.ts', "import { approveBuy as c } from '../risk/approve.ts'; export { c };"),
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

  it('CANARY: the audit writers reach only their callers: the chain only its three files, the owner\'s only app/owner.ts and cli/, the server\'s only cli/, app/owner.ts only its wiring file; none is re-exported or imported dynamically (reviews P, Q)', () => {
    const only = 'may be imported at runtime only by';
    flaggedFor([
      ['storage/repo-flags.ts', "import { appendAuditRow } from './audit-chain.ts'; export function f(): number { return appendAuditRow(); }", only],
      ['app/engine.ts', "import { appendAuditRow } from '../storage/audit-chain.ts'; export function f(): number { return appendAuditRow(); }", only],
      ['app/engine.ts', "import { resumeHalt } from '../storage/repo-owner.ts'; export function f(): boolean { return resumeHalt(); }", only],
      ['app/day-tx.ts', "import { appendOwnerAudit } from '../storage/repo-owner.ts'; export function f(): number { return appendOwnerAudit(); }", only],
      ['app/owner.ts', "import { clearKill } from '../storage/repo-server.ts'; export function f(): void { clearKill(); }", only], // Telegram never clears KILL
      // also outside telegram/'s folder edges: this proves the file rule, not the folder rule
      ['telegram/x.ts', "import { clearKill } from '../storage/repo-server.ts'; export function f(): void { clearKill(); }", `${only} cli/`],
      ['storage/repo-audit.ts', "export { appendAuditRow } from './audit-chain.ts';", only], // an allowed importer, but a re-export
      ['storage/repo-owner.ts', "export * from './audit-chain.ts';", only],
      ['cli/x.ts', "export { clearKill } from '../storage/repo-server.ts';", only],
      ['app/engine.ts', "export const load = async () => import('../storage/repo-server.ts');", only],
      ['cli/x.ts', "export const load = async () => import('../storage/repo-server.ts');", 'with a static import'], // an allowed importer, but the whole module as a value
      ['app/engine.ts', "import { resumeHalt } from '../storage/Repo-Owner.ts'; export function f(): boolean { return resumeHalt(); }", only], // case
      ['app/Owner.ts', "import { resumeHalt } from '../storage/repo-owner.ts'; export function f(): boolean { return resumeHalt(); }", only], // a look-alike importer
      // app/owner.ts is restricted itself: only its Telegram wiring file (Phase 3) may reach it (review Q, security 1b)
      ['app/engine.ts', "import { onOwnerUpdate } from './owner.ts'; export function f(): void { onOwnerUpdate(); }", `${only} its one Telegram wiring file`],
      ['cli/x.ts', "import { onOwnerUpdate } from '../app/owner.ts'; export function f(): void { onOwnerUpdate(); }", `${only} its one Telegram wiring file`],
      // the money path (6c-2b-2): only the bound token store uses a token; only app/ writes intents, decisions, approvals and positions
      ['app/approve-tx.ts', "import { redeemApproval } from '../storage/repo-redeem.ts'; export function f(): boolean { return redeemApproval(); }", `${only} app/token-store.ts`],
      ['execution/x.ts', "import { redeemApproval } from '../storage/repo-redeem.ts'; export function f(): boolean { return redeemApproval(); }", `${only} app/token-store.ts`],
      ['app/token-store.ts', "export { redeemApproval } from '../storage/repo-redeem.ts';", only],
      ['execution/x.ts', "import { insertApproval } from '../storage/repo-orders.ts'; export function f(): void { insertApproval(); }", `${only} app/`],
      ['storage/repo-book.ts', "import { insertDecision } from './repo-orders.ts'; export function f(): void { insertDecision(); }", `${only} app/`],
      ['execution/x.ts', "import { abandonOpening } from '../storage/repo-book.ts'; export function f(): void { abandonOpening(); }", only],
      ['storage/repo-day.ts', "import { readPosition } from './repo-book.ts'; export function f(): void { readPosition(); }", only],
      ['app/engine.ts', "import { createSqliteTokenStore } from './token-store.ts'; export function f(): void { createSqliteTokenStore(); }", `${only} app/authority.ts`],
      ['cli/x.ts', "import { createSqliteTokenStore } from '../app/token-store.ts'; export function f(): void { createSqliteTokenStore(); }", `${only} app/authority.ts`],
      // 6d-1: randomness only in app/ and cli/; one authority, one boot and one engine per process
      ['execution/x.ts', "import { newId } from '../core/rng.ts'; export function f(): string { return newId('token'); }", `${only} app/ and cli/`],
      ['telegram/x.ts', "import { systemRng } from '../core/rng.ts'; export const r = systemRng;", `${only} app/ and cli/`],
      ['app/x.ts', "export { newId } from '../core/rng.ts';", only],
      ['app/x.ts', "import { createEngineAuthority } from './authority.ts'; export function f(): void { createEngineAuthority(); }", `${only} app/engine.ts`],
      ['cli/x.ts', "import { createEngineAuthority } from '../app/authority.ts'; export function f(): void { createEngineAuthority(); }", `${only} app/engine.ts`],
      ['app/approve-tx.ts', "import { bootStorage } from './storage-boot.ts'; export function f(): void { bootStorage(); }", `${only} app/engine.ts`],
      ['app/x.ts', "import { startPaperEngine } from './engine.ts'; export function f(): void { startPaperEngine(); }", `${only} cli/`],
      ['app/engine.ts', "export { createEngineAuthority } from './authority.ts';", only],
    ]);
    // the typed rule (below) checks that what is imported is only called; these are the import rules alone
    const fine: [string, string][] = [
      ['storage/repo-owner.ts', "import { appendAuditRow } from './audit-chain.ts'; export function f(): number { return appendAuditRow(); }"],
      ['storage/repo-server.ts', "import { appendAuditRow } from './audit-chain.ts'; export function f(): number { return appendAuditRow(); }"],
      ['app/owner.ts', "import { resumeHalt } from '../storage/repo-owner.ts'; export function onResume(): boolean { return resumeHalt(); }"],
      ['cli/reset.ts', "import { clearKill } from '../storage/repo-server.ts'; import { unpause } from '../storage/repo-owner.ts'; export function reset(): void { clearKill(); unpause(); }"],
      ['app/engine.ts', "import type { OwnerActor } from '../storage/repo-owner.ts'; export const x = (a: OwnerActor): OwnerActor => a;"],
      ['app/engine.ts', "import type { OwnerHandler } from './owner.ts'; export const x = (h: OwnerHandler): OwnerHandler => h;"],
      ['app/token-store.ts', "import { redeemApproval } from '../storage/repo-redeem.ts'; export function consume(): boolean { return redeemApproval(); }"],
      ['app/authority.ts', "import { createSqliteTokenStore } from './token-store.ts'; export function f(): void { createSqliteTokenStore(); }"],
      ['app/approve-tx.ts', "import { insertApproval } from '../storage/repo-orders.ts'; import { insertOpening } from '../storage/repo-book.ts'; export function f(): void { insertOpening(); insertApproval(); }"],
      ['storage/repo-orders.ts', "import { readPosition } from './repo-book.ts'; export function f(): void { readPosition(); }"],
      ['storage/repo-redeem.ts', "import { readPosition } from './repo-book.ts'; export function f(): void { readPosition(); }"],
      ['execution/x.ts', "import type { StoredOrder } from '../storage/repo-orders.ts'; export const x = (o: StoredOrder): StoredOrder => o;"],
      ['app/engine.ts', "import { createEngineAuthority } from './authority.ts'; import { bootStorage } from './storage-boot.ts'; export function f(): void { bootStorage(); createEngineAuthority(); }"],
      ['cli/start.ts', "import { startPaperEngine } from '../app/engine.ts'; import { systemRng } from '../core/rng.ts'; export function f(): void { startPaperEngine(systemRng); }"],
      ['app/x.ts', "import { newId } from '../core/rng.ts'; export function f(): string { return newId('token'); }"],
      ['app/faults.ts', "import { RngError } from '../core/rng.ts'; export const isRng = (e: unknown): boolean => e instanceof RngError;"],
      ['execution/x.ts', "import type { Rng } from '../core/rng.ts'; export const x = (r: Rng): string => r.orderId();"],
    ];
    for (const [rel, text] of fine) {
      assert.deepEqual(checkSource(rel, text), [], rel);
    }
  });

  it('CANARY: no conflict clause in SQL text, no "any", no directive that switches the type check off', () => {
    const conflict = 'no OR REPLACE, OR IGNORE or other conflict clause';
    flaggedFor([
      ['storage/repo-x.ts', "export const Q = 'INSERT OR IGNORE INTO halt_reasons (reason) VALUES (?)';", conflict],
      ['storage/repo-x.ts', "export const Q = 'insert or replace into t (a) values (?)';", conflict],
      ['storage/repo-x.ts', "export const Q = 'UPDATE OR ROLLBACK t SET a = ?';", conflict],
      ['storage/repo-x.ts', 'export const Q = `REPLACE INTO t (a) VALUES (?)`;', conflict],
      ['storage/schema-v2.ts', 'export const S = `CREATE TABLE t (a TEXT UNIQUE ON CONFLICT REPLACE) STRICT`;', conflict],
      ['app/x.ts', 'export const f = (x: any): number => x;', 'no "any"'],
      ['app/x.ts', 'export const f = (x: unknown): number => x as any;', 'no "any"'],
      ['app/x.ts', 'export type A = Array<any>;', 'no "any"'],
      ['app/x.ts', '// @ts-ignore\nexport const n: number = "x";', 'no @ts-ignore, @ts-expect-error or @ts-nocheck'],
      ['app/x.ts', '/* @ts-expect-error */\nexport const n: number = "x";', 'no @ts-ignore, @ts-expect-error or @ts-nocheck'],
      ['app/x.ts', '// @ts-nocheck\nexport const n = 1;', 'no @ts-ignore, @ts-expect-error or @ts-nocheck'],
    ]);
    // the helpers check the reason, not only that something was flagged (review Q, security 5)
    assert.throws(() => flaggedFor([['app/x.ts', 'export const f = (x: any): number => x;', conflict]]), assert.AssertionError);
    assert.throws(() => typedFlaggedFor(['storage/repo-x.ts: another rule'], { 'storage/repo-x.ts': ['text', 'the rule it should name'] }), assert.AssertionError);
    for (const text of [
      "export const Q = 'INSERT INTO halt_reasons (reason) VALUES (?) ON CONFLICT (reason) DO NOTHING';",
      "export const Q = 'SELECT replace(a, ?, ?) AS b FROM t WHERE a OR replace(b, ?, ?)';",
      "export const S = 'an error or ignore it'.length;",
      'export const f = (x: unknown): unknown => x;',
    ]) {
      assert.deepEqual(checkSource('storage/repo-x.ts', text), [], text);
    }
  });

  it('every call to a database handle runs constant SQL, in a storage repository, writing only what its file may; handles keep their type; restricted functions are only called (reviews O, P, Q)', () => {
    const files = sourceFiles().map((rel) => path.join(SRC, rel));
    const { problems, calls, writes, uses, restrictedCalls, auditCalls } = sqlProblems(ts.createProgram(files, compilerOptions()), SRC);
    assert.deepEqual(problems, []);
    // non-vacuity: each rule saw the repositories and the runner
    assert.ok(calls >= 30, `the rule saw ${calls} handle calls`);
    assert.ok(writes >= 20, `the write rules read ${writes} writes`);
    assert.ok(uses >= 60, `the handle rule checked ${uses} uses`);
    assert.ok(restrictedCalls >= 4, `the restricted-function rule saw ${restrictedCalls} calls`);
    assert.ok(auditCalls >= 3, `the actor rule saw ${auditCalls} calls of the chain's writer`); // the engine's, the owner's and the server's
  });

  it('CANARY: each table is written only by the file whose job it is: audit rows, halt lifts, KILL and pause clears, the halt-clear time, modes and gate starts (review Q, security 2; risk 1 and 2)', () => {
    const bad: readonly (readonly [string, string, string])[] = [
      ['storage/repo-x.ts', "INSERT INTO audit_log (id, at, actor, action, detail_json, prev_hash, hash) VALUES (?, ?, 'owner-server', 'server:clear-kill', '{}', ?, ?)", 'only storage/audit-chain.ts writes audit_log'],
      ['storage/repo-owner.ts', 'INSERT INTO "audit_log" (id) VALUES (?)', 'only storage/audit-chain.ts writes audit_log'], // the owner's file calls the chain too
      ['storage/repo-flags.ts', 'DELETE FROM halt_reasons WHERE reason = ?', 'only repo-owner.ts and repo-server.ts lift a halt'],
      ['storage/repo-x.ts', 'WITH old AS (SELECT reason FROM halt_reasons) DELETE FROM main.halt_reasons WHERE reason IN (SELECT reason FROM old)', 'only repo-owner.ts and repo-server.ts lift a halt'],
      ['storage/repo-x.ts', 'INSERT INTO halt_reasons (reason, set_at, set_audit_id) VALUES (?, ?, ?) ON CONFLICT (reason) DO UPDATE SET set_audit_id = excluded.set_audit_id', 'only repo-owner.ts and repo-server.ts lift a halt'],
      ['storage/repo-flags.ts', 'UPDATE flags SET kill = 0, kill_at = NULL, kill_source = NULL, kill_audit_id = NULL, updated_at = ? WHERE id = 1', 'only repo-server.ts clears KILL'],
      ['storage/repo-owner.ts', 'UPDATE flags SET kill = 0, kill_at = NULL, kill_source = NULL, kill_audit_id = NULL WHERE id = 1', 'only repo-server.ts clears KILL'], // Telegram never clears KILL
      ['storage/repo-x.ts', 'update   "main"."flags"\nset "kill"=?', 'only repo-server.ts clears KILL'],
      ['storage/repo-x.ts', 'UPDATE flags SET kill = 1 - kill WHERE id = 1', 'only repo-server.ts clears KILL'],
      // SQLite accepts a column twice and takes the last: every assignment is read, and twice is refused
      ['storage/repo-flags.ts', 'UPDATE flags SET kill = 1, kill = 0 WHERE id = 1', 'only repo-server.ts clears KILL'],
      ['storage/repo-flags.ts', 'UPDATE flags SET kill = 1, kill = 0 WHERE id = 1', 'set each column of flags once'],
      ['storage/repo-flags.ts', 'UPDATE flags SET paused = 1, paused = 0 WHERE id = 1', 'only repo-owner.ts clears the pause'],
      ['storage/repo-flags.ts', 'UPDATE strategy_modes SET gate_since = max(gate_since, ?), gate_since = ? WHERE strategy = ?', 'a gate start only moves later'],
      ['storage/repo-flags.ts', "UPDATE strategy_modes SET mode = 'paper', mode = 'live', changed_by = 'auto-demote', changed_at = ? WHERE strategy = ? AND mode = 'live'", "only repo-owner.ts sets a strategy's mode"],
      ['storage/repo-owner.ts', 'UPDATE strategy_modes SET mode = ?, mode = ?, changed_by = ?, changed_at = ? WHERE strategy = ?', 'set each column of strategy_modes once'],
      ['storage/repo-x.ts', 'UPDATE flags AS f SET kill = 0 WHERE f.id = 1', 'only repo-server.ts clears KILL'],
      ['storage/repo-x.ts', 'UPDATE flags SET kill_audit_id = ? WHERE id = 1', 'kill_at, kill_source and kill_audit_id change only together with kill'],
      ['storage/repo-x.ts', 'UPDATE flags SET (kill, kill_at) = (0, NULL) WHERE id = 1', 'set each column of flags on its own'],
      ['storage/repo-flags.ts', 'UPDATE flags SET paused = 0, paused_at = NULL WHERE id = 1', 'only repo-owner.ts clears the pause'],
      ['storage/repo-server.ts', 'UPDATE flags SET paused = ?, paused_at = NULL WHERE id = 1', 'only repo-owner.ts clears the pause'],
      ['storage/repo-x.ts', 'UPDATE flags SET paused_at = ? WHERE id = 1', 'paused_at changes only together with paused'],
      ['storage/repo-flags.ts', 'UPDATE flags SET halt_cleared_at = ?, updated_at = ? WHERE id = 1', 'only repo-owner.ts and repo-server.ts record when halts were lifted'],
      ['storage/repo-x.ts', 'INSERT INTO flags (id, kill) VALUES (1, 0) ON CONFLICT (id) DO UPDATE SET kill = 0', "the flags row and the strategy modes are the migration's"],
      ['storage/repo-x.ts', 'INSERT INTO flags (id, kill) VALUES (1, 0) ON CONFLICT (id) DO UPDATE SET kill = 0', 'only repo-server.ts clears KILL'], // the upsert's update is read too
      ['storage/repo-x.ts', 'DELETE FROM strategy_modes WHERE strategy = ?', "the flags row and the strategy modes are the migration's"],
      ['storage/repo-x.ts', "UPDATE strategy_modes SET mode = 'live', changed_by = 'owner-golive', changed_at = ? WHERE strategy = ?", "only repo-owner.ts sets a strategy's mode"],
      ['storage/repo-flags.ts', "UPDATE strategy_modes SET mode = 'paper', changed_by = 'auto-demote', changed_at = ? WHERE strategy = ?", "only repo-owner.ts sets a strategy's mode"], // off to paper is no demotion
      ['storage/repo-flags.ts', "UPDATE strategy_modes SET mode = 'paper', changed_by = 'auto-demote', changed_at = ? WHERE strategy = ? AND mode = 'live' OR 1 = 1", "only repo-owner.ts sets a strategy's mode"],
      ['storage/repo-flags.ts', "UPDATE strategy_modes SET mode = ?, changed_by = 'auto-demote', changed_at = ? WHERE strategy = ? AND mode = 'live'", "only repo-owner.ts sets a strategy's mode"],
      ['storage/repo-x.ts', "UPDATE strategy_modes SET changed_by = 'owner-golive' WHERE strategy = ?", 'changed_by and changed_at change only together with the mode'],
      ['storage/repo-flags.ts', 'UPDATE strategy_modes SET gate_since = ? WHERE strategy = ?', 'a gate start only moves later'],
      ['storage/repo-owner.ts', 'UPDATE strategy_modes SET mode = ?, changed_by = ?, changed_at = ?, gate_since = min(gate_since, ?) WHERE strategy = ?', 'a gate start only moves later'],
      ['storage/repo-x.ts', 'UPDATE strategy_modes SET strategy = ? WHERE strategy = ?', "a strategy's row keeps its strategy"],
      ['storage/repo-x.ts', "DELETE FROM entry_bans WHERE kind = 'mint-cooldown'", 'only repo-flags.ts deletes entry bans'],
      ['storage/repo-x.ts', 'UPDATE (SELECT 1) SET x = 1', 'write to a table named plainly'],
      // the config, the day state and the snapshots (6c-2b-1, STORAGE_DESIGN s.14)
      ['storage/repo-flags.ts', 'INSERT INTO config_versions (id) VALUES (?)', 'config versions are only added, by repo-owner.ts'], // the engine's own file
      ['storage/repo-owner.ts', "UPDATE config_versions SET author = 'owner' WHERE id = ?", 'config versions are only added'],
      ['storage/repo-config.ts', 'DELETE FROM config_versions WHERE id = ?', 'config versions are only added'],
      ['storage/repo-config.ts', 'INSERT INTO pending_changes (path) VALUES (?)', 'only repo-owner.ts queues a loosening'], // the engine never queues one
      ['storage/repo-flags.ts', 'DELETE FROM pending_changes WHERE path = ?', 'only repo-owner.ts queues a loosening'],
      ['storage/repo-owner.ts', 'UPDATE pending_changes SET apply_at = ? WHERE path = ?', 'only repo-owner.ts queues a loosening'],
      ['storage/repo-config.ts', 'DELETE FROM pending_changes', 'a waiting change is deleted one at a time, by its path'],
      ['storage/repo-config.ts', 'DELETE FROM pending_changes WHERE apply_at <= ?', 'a waiting change is deleted one at a time, by its path'],
      ['storage/repo-owner.ts', 'DELETE FROM pending_changes WHERE path = ? OR 1 = 1', 'a waiting change is deleted one at a time, by its path'],
      ['storage/repo-owner.ts', 'DELETE FROM pending_changes AS p WHERE p.path = ? RETURNING path', 'a waiting change is deleted one at a time, by its path'],
      ['storage/repo-flags.ts', 'UPDATE day_state SET peak = ? WHERE mode = ?', 'only repo-day.ts, repo-owner.ts and repo-server.ts write the day state'],
      ['storage/repo-day.ts', 'UPDATE day_state SET daily_stop_streak = 0, streak_halt = 0 WHERE mode = ?', 'only repo-owner.ts and repo-server.ts lift the two-day halt'],
      ['storage/repo-day.ts', 'UPDATE day_state SET streak_halt = ?, streak_halt = 0 WHERE mode = ?', 'set each column of day_state once'],
      ['storage/repo-day.ts', 'UPDATE day_state SET (streak_halt, peak) = (0, NULL) WHERE mode = ?', 'set each column of day_state on its own'],
      ['storage/repo-day.ts', "DELETE FROM day_state WHERE mode = 'paper'", "the day state rows are the migration's"],
      ['storage/repo-day.ts', "INSERT INTO day_state (mode, shape) VALUES ('paper', 1)", "the day state rows are the migration's"],
      ['storage/repo-flags.ts', 'INSERT INTO day_state (mode) VALUES (?)', "the day state rows are the migration's"],
      ['storage/repo-flags.ts', 'INSERT INTO equity_snapshots (mode, at) VALUES (?, ?)', 'only repo-day.ts adds and prunes equity snapshots'],
      ['storage/repo-flags.ts', 'DELETE FROM equity_snapshots WHERE at < ?', 'only repo-day.ts adds and prunes equity snapshots'],
      ['storage/repo-day.ts', 'UPDATE equity_snapshots SET equity = ? WHERE at = ?', 'only repo-day.ts adds and prunes equity snapshots; none is changed'],
      // the book and the money path (6c-2b-2, STORAGE_DESIGN s.15.11)
      ['storage/repo-day.ts', 'INSERT INTO ledger_accounts (mode) VALUES (?)', 'only repo-server.ts writes the ledger accounts'],
      ['storage/repo-book.ts', 'UPDATE ledger_accounts SET total_deposits = ? WHERE mode = ?', 'only repo-server.ts writes the ledger accounts'],
      ['storage/repo-server.ts', 'UPDATE ledger_accounts SET sol = ? WHERE mode = ?', 'only repo-server.ts writes the ledger accounts, once'],
      ['storage/repo-orders.ts', 'INSERT INTO positions (id) VALUES (?)', 'only repo-book.ts writes positions'],
      ['storage/repo-book.ts', 'DELETE FROM positions WHERE id = ?', 'only repo-book.ts writes positions, and none is deleted'],
      ['storage/repo-book.ts', "UPDATE positions SET status = 'stuck' WHERE id = ?", "a position's status is written only as 'closed'"],
      ['storage/repo-book.ts', 'UPDATE positions SET status = ? WHERE id = ?', "a position's status is written only as 'closed'"],
      ['storage/repo-book.ts', "UPDATE positions SET status = 'opening' WHERE id = ?", "a position's status is written only as 'closed'"],
      ['storage/repo-book.ts', 'UPDATE positions SET exit_seq = ? WHERE id = ?', "a position's exit number only moves up by one"],
      ['storage/repo-book.ts', 'UPDATE positions SET exit_seq = exit_seq - 1 WHERE id = ?', "a position's exit number only moves up by one"],
      ['storage/repo-book.ts', 'UPDATE positions SET mint = ? WHERE id = ?', 'a position keeps its id, mint'],
      ['storage/repo-book.ts', 'UPDATE positions SET max_spend = NULL WHERE id = ?', 'a position keeps its id, mint'],
      ['storage/repo-book.ts', "UPDATE positions SET status = 'closed', status = 'closed' WHERE id = ?", 'set each column of positions once'],
      ['storage/repo-book.ts', "UPDATE positions SET (status, closed_at) = ('closed', ?) WHERE id = ?", 'set each column of positions on its own'],
      ['storage/repo-book.ts', 'INSERT INTO intents (id) VALUES (?)', 'only repo-orders.ts adds intents and decisions'],
      ['storage/repo-orders.ts', 'DELETE FROM intents WHERE id = ?', 'only repo-orders.ts adds intents and decisions; none is changed'],
      ['storage/repo-orders.ts', 'UPDATE risk_decisions SET approved = 1 WHERE intent_id = ?', 'only repo-orders.ts adds intents and decisions; none is changed'],
      ['storage/repo-redeem.ts', 'INSERT INTO approvals (token_id) VALUES (?)', 'only repo-orders.ts adds approvals'],
      ['storage/repo-redeem.ts', 'UPDATE approvals SET consumed_at = NULL, consumed_slot = NULL WHERE token_id = ? AND consumed_at IS NULL', 'only repo-redeem.ts uses one'],
      ['storage/repo-redeem.ts', 'UPDATE approvals SET consumed_at = ?, consumed_slot = ? WHERE token_id = ?', 'only repo-redeem.ts uses one'],
      ['storage/repo-redeem.ts', 'UPDATE approvals SET consumed_at = ?, consumed_slot = ?, max_spend = ? WHERE token_id = ? AND consumed_at IS NULL', 'only repo-redeem.ts uses one'],
      ['storage/repo-orders.ts', 'UPDATE approvals SET consumed_at = ?, consumed_slot = ? WHERE token_id = ? AND consumed_at IS NULL', 'only repo-redeem.ts uses one'],
      ['storage/repo-orders.ts', 'INSERT INTO orders (id) VALUES (?)', 'only repo-redeem.ts adds orders'],
      ['storage/repo-redeem.ts', 'UPDATE orders SET status = ? WHERE id = ?', 'only repo-redeem.ts adds orders; no status moves'],
      ['storage/repo-x.ts', "UPDATE orders SET status = 'landed' WHERE id = ?", 'only repo-redeem.ts adds orders; no status moves'],
      ['storage/repo-redeem.ts', 'DELETE FROM orders WHERE id = ?', 'only repo-redeem.ts adds orders; no status moves in this step, and none is deleted'],
      // review S: a close only from opening, the amounts only with it; upserts and deletes on the money path
      ['storage/repo-book.ts', "UPDATE positions SET status = 'closed', closed_at = ? WHERE id = ?", 'a position is closed here only from opening'],
      ['storage/repo-book.ts', "UPDATE positions SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'opening' OR 1 = 1", 'a position is closed here only from opening'],
      ['storage/repo-book.ts', "UPDATE positions SET status = 'closed', closed_at = ? WHERE status = 'opening'", 'a position is closed here only from opening'],
      // a comparison that continues the pinned start turns it round (review S confirmation, security S8)
      ['storage/repo-book.ts', "UPDATE positions SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'opening' = 0", 'a position is closed here only from opening'],
      ['storage/repo-book.ts', "UPDATE positions SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'opening' IS 0", 'a position is closed here only from opening'],
      ['storage/repo-book.ts', "UPDATE positions SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'opening' IN (0)", 'a position is closed here only from opening'],
      ['storage/repo-book.ts', "UPDATE positions SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'opening' <> 1 AND closed_at IS NULL", 'a position is closed here only from opening'],
      ['storage/repo-book.ts', "UPDATE positions SET status = 'closed', cost_basis = '0' WHERE id = ? AND status = 'opening' IS NOT 1", 'a position is closed here only from opening'],
      ['storage/repo-book.ts', 'UPDATE positions SET cost_basis = ? WHERE id = ?', "a position's amounts move here only with its abandon"],
      ['storage/repo-book.ts', "UPDATE positions SET token_units = '0', updated_at = ? WHERE id = ? AND status = 'opening'", "a position's amounts move here only with its abandon"],
      ['storage/repo-orders.ts', 'INSERT INTO approvals (token_id) VALUES (?) ON CONFLICT (token_id) DO UPDATE SET consumed_at = ?', 'only repo-redeem.ts uses one'],
      ['storage/repo-redeem.ts', "INSERT INTO orders (id) VALUES (?) ON CONFLICT (id) DO UPDATE SET status = 'landed'", 'no status moves in this step'],
      ['storage/repo-orders.ts', 'DELETE FROM approvals WHERE token_id = ?', 'only repo-orders.ts adds approvals'],
      ['storage/repo-orders.ts', 'DELETE FROM risk_decisions WHERE intent_id = ?', 'none is changed or deleted'],
      ['storage/repo-server.ts', "DELETE FROM ledger_accounts WHERE mode = 'live'", 'only repo-server.ts writes the ledger accounts, once'],
    ];
    for (const [rel, sql, why] of bad) {
      const problems = writeProblems(rel, sql);
      assert.ok(problems.some((p) => p.startsWith(`${rel}: `) && p.includes(why)), `should flag ${rel} because "${why}": ${sql}\n  got: ${problems.join('\n  got: ')}`);
    }
    const fine: readonly (readonly [string, string])[] = [
      ['storage/audit-chain.ts', 'INSERT INTO audit_log (id, at, actor, action, detail_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)'],
      ['storage/repo-flags.ts', 'UPDATE flags SET kill = 1, kill_at = ?, kill_source = ?, kill_audit_id = ?, updated_at = ? WHERE id = 1 AND kill = 0'], // the WHERE is not the SET
      ['storage/repo-flags.ts', 'UPDATE flags SET paused = 1, paused_at = ?, updated_at = ? WHERE id = 1 AND paused = 0'],
      ['storage/repo-flags.ts', 'UPDATE flags SET entries_stopped = ?, updated_at = ? WHERE id = 1'],
      ['storage/repo-flags.ts', 'INSERT INTO halt_reasons (reason, set_at, set_audit_id) VALUES (?, ?, ?)'],
      ['storage/repo-flags.ts', "UPDATE strategy_modes SET mode = 'paper', changed_by = 'auto-demote', changed_at = ?, gate_since = max(gate_since, ?) WHERE strategy = ? AND mode = 'live'"],
      ['storage/repo-flags.ts', 'UPDATE strategy_modes SET gate_since = max(gate_since, ?) WHERE strategy = ?'],
      ['storage/repo-flags.ts', "DELETE FROM entry_bans WHERE kind IN ('mint-cooldown', 'strategy-pause', 'strategy-off') AND until <= ?"],
      ['storage/repo-x.ts', 'INSERT INTO entry_bans (kind, key, until, reason, set_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (kind, key) DO UPDATE SET until = max(until, excluded.until)'],
      ['storage/repo-owner.ts', 'DELETE FROM halt_reasons WHERE reason = ?'],
      ['storage/repo-owner.ts', 'UPDATE flags SET paused = 0, paused_at = NULL, updated_at = ? WHERE id = 1 AND paused = 1'],
      ['storage/repo-owner.ts', 'UPDATE flags SET halt_cleared_at = ?, updated_at = ? WHERE id = 1'],
      ['storage/repo-owner.ts', 'UPDATE strategy_modes SET mode = ?, changed_by = ?, changed_at = ? WHERE strategy = ?'],
      ['storage/repo-server.ts', 'UPDATE flags SET kill = 0, kill_at = NULL, kill_source = NULL, kill_audit_id = NULL, updated_at = ? WHERE id = 1 AND kill = 1'],
      ['storage/repo-server.ts', 'DELETE FROM halt_reasons'],
      ['storage/repo-x.ts', "SELECT kill FROM flags WHERE kill = 0 AND paused = 0 AND halt_cleared_at IS NULL"],
      ['storage/repo-x.ts', 'SELECT replace(a, ?, ?) AS b, "update" FROM t'], // a function and a column named like keywords
      ['storage/repo-owner.ts', 'INSERT INTO config_versions (id, created_at, author, values_json, changed_json, undo_to) VALUES (?, ?, ?, ?, ?, ?)'],
      ['storage/repo-server.ts', "INSERT INTO config_versions (id, created_at, author, values_json, changed_json, undo_to) VALUES (1, ?, 'default', ?, ?, NULL)"],
      ['storage/repo-config.ts', 'INSERT INTO config_versions (id, created_at, author, values_json, changed_json, undo_to) VALUES (?, ?, ?, ?, ?, ?)'],
      ['storage/repo-config.ts', 'DELETE FROM pending_changes WHERE path = ?'],
      ['storage/repo-owner.ts', 'INSERT INTO pending_changes (path, from_value, to_value, source, requested_at, apply_at) VALUES (?, ?, ?, ?, ?, ?)'],
      ['storage/repo-owner.ts', 'DELETE FROM pending_changes WHERE path = ?'],
      ['storage/repo-day.ts', 'UPDATE day_state SET day = ?, peak = ?, daily_stop_streak = ?, streak_halt = ?, updated_at = ? WHERE mode = ?'],
      ['storage/repo-owner.ts', 'UPDATE day_state SET daily_stop_streak = 0, streak_halt = 0, updated_at = ? WHERE mode = ?'],
      ['storage/repo-server.ts', "UPDATE day_state SET peak = last_equity, updated_at = ? WHERE mode = ? AND jump_pending = 0 AND last_equity <> '0'"],
      ['storage/repo-day.ts', 'INSERT INTO equity_snapshots (mode, at, equity, stop_equity) VALUES (?, ?, ?, ?) ON CONFLICT (mode, at) DO NOTHING'],
      ['storage/repo-day.ts', 'DELETE FROM equity_snapshots WHERE at < ?'],
      ['storage/repo-server.ts', 'INSERT INTO ledger_accounts (mode, sol, total_deposits, total_withdrawals, updated_at) VALUES (?, ?, ?, ?, ?)'],
      ['storage/repo-book.ts', "INSERT INTO positions (id, mint, strategy, mode, status, opened_at, max_spend, p95_exit_cost, updated_at) VALUES (?, ?, ?, ?, 'opening', ?, ?, ?, ?)"],
      ['storage/repo-book.ts', "UPDATE positions SET exit_seq = exit_seq + 1, updated_at = ? WHERE id = ? AND exit_seq = ? AND status IN ('open', 'exiting')"],
      [
        'storage/repo-book.ts',
        "UPDATE positions SET status = 'closed', closed_at = ?, cost_basis = '0', realized = ?, basis_released = ?, updated_at = ? WHERE id = ? AND status = 'opening' AND cost_basis = ? AND realized = ? AND basis_released = ?",
      ],
      ['storage/repo-book.ts', "UPDATE positions SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ? AND status = 'opening'"],
      ['storage/repo-orders.ts', "INSERT INTO intents (id, kind, mode, strategy, mint, position_id, size_hint, confidence_bps, created_at, inputs_as_of, reasons_json, inputs_json) VALUES (?, 'entry', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"],
      ['storage/repo-orders.ts', 'INSERT INTO risk_decisions (intent_id, at, approved, stage, reasons_json, size, limited_by, binding, slot, config_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'],
      ['storage/repo-orders.ts', 'INSERT INTO approvals (token_id, intent_id, position_id, mode, kind, reduce_only, plan_hash, max_spend, min_out, quote_slot, expires_at_slot, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'],
      ['storage/repo-redeem.ts', 'UPDATE approvals SET consumed_at = ?, consumed_slot = ? WHERE token_id = ? AND consumed_at IS NULL'],
      ['storage/repo-redeem.ts', "INSERT INTO orders (id, intent_id, token_id, position_id, mode, kind, status, plan_hash, plan_json, in_amount, min_out, max_spend, quote_slot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?, ?)"],
    ];
    for (const [rel, sql] of fine) {
      assert.deepEqual(writeProblems(rel, sql), [], `${rel}: ${sql}`);
    }
  });

  it('CANARY: the constant-SQL rule catches every way to put a value into SQL or to reach a handle around it', () => {
    const STUB = [
      'export type SqlParam = string | bigint | null;',
      'export interface Reader { get(sql: string, ...p: SqlParam[]): unknown; all(sql: string, ...p: SqlParam[]): readonly unknown[]; }',
      'export interface Tx extends Reader { run(sql: string, ...p: SqlParam[]): number; script(sql: string): void; }',
      'export interface Db extends Reader { transaction<T>(fn: (tx: Tx) => T): T; }',
    ].join('\n');
    const HEAD = "import type { Db, Reader, Tx } from './sqlite.ts';\n";
    const literal = 'must be a literal or a top-level const built from literals';
    const conflict = 'no OR REPLACE, OR IGNORE or other conflict clause';
    const bad: Record<string, readonly [string, string]> = {
      'storage/repo-b1.ts': [`${HEAD}export const f = (tx: Tx, t: string): number => tx.run(\`DELETE FROM \${t}\`);`, literal],
      'storage/repo-b2.ts': [`${HEAD}export const f = (r: Reader, id: string): unknown => r.get('SELECT a FROM t WHERE id = ' + id);`, literal],
      'storage/repo-b3.ts': [`${HEAD}let Q = 'SELECT 1 AS x'; Q = Q + ''; export const f = (r: Reader): unknown => r.get(Q);`, literal],
      'storage/repo-b4.ts': [`${HEAD}export const f = (r: Reader): unknown => { const Q = 'SELECT 1 AS x'; return r.get(Q); };`, literal],
      'storage/repo-b5.ts': [`${HEAD}const A = 'SELECT 1 AS x'; const B = 'SELECT 2 AS x'; export const f = (r: Reader, k: boolean): unknown => r.get(k ? A : B);`, literal],
      'storage/repo-b6.ts': [`${HEAD}export const f = (r: Reader): unknown => r.get(String(1));`, literal],
      'storage/repo-b7.ts': [`${HEAD}export const f = (tx: Tx): number => { const run = tx.run; return run('DELETE FROM t'); };`, 'call run directly on the database handle'],
      'storage/repo-b8.ts': [`${HEAD}export const f = (tx: Tx): number => { const { run } = tx; return run('DELETE FROM t'); };`, 'do not take run off a database handle'],
      'storage/repo-b9.ts': [`${HEAD}export const f = (tx: Tx): number => tx['run']('DELETE FROM t');`, 'used through its named methods only (no [] access)'],
      'storage/repo-b10.ts': [`${HEAD}export const f = (tx: Tx, args: [string]): number => tx.run(...args);`, literal],
      'storage/repo-b11.ts': [`${HEAD}const Q = 'INSERT OR ' + 'REPLACE INTO t (a) VALUES (?)'; export const f = (tx: Tx): number => tx.run(Q, 1n);`, conflict],
      'storage/repo-b11t.ts': [`${HEAD}const OR = 'OR'; const Q = \`INSERT \${OR} IGNORE INTO t (a) VALUES (?)\`; export const f = (tx: Tx): number => tx.run(Q, 1n);`, conflict], // split around a value: only the added-up text shows it
      'storage/repo-b8p.ts': [`${HEAD}export const f = ({ run }: Tx): number => run('DELETE FROM t');`, 'do not take run off a database handle'],
      'storage/repo-b8a.ts': [`${HEAD}export const f = (tx: Tx): number => { let run: Tx['run'] = (): number => 0; ({ run } = tx); return run('DELETE FROM t'); };`, 'do not take run off a database handle'],
      'storage/repo-b12.ts': [`${HEAD}export const f = (s: string): unknown => JSON.parse(s).run('DELETE FROM t');`, 'of type any'],
      'storage/repo-b13.ts': [`${HEAD}export const f = (tx: Tx): number => tx.run.call(tx, 'DELETE FROM t');`, 'call run directly on the database handle'],
      'storage/repo-b13a.ts': [`${HEAD}export const f = (r: Reader, g: (q: string, fn: unknown) => unknown): unknown => g('SELECT 1 AS x', r.get);`, 'call get directly on the database handle'], // handed on as an argument
      'storage/repo-b14.ts': [`${HEAD}export const f = (db: Db): unknown => db.transaction((tx) => tx.get(\`SELECT \${'a' + Math.random()} AS x\`));`, literal],
      'storage/migrations.ts': [`${HEAD}export interface Migration { readonly sql: string }\nexport const f = (tx: Tx, n: string): void => tx.script(\`CREATE TABLE \${n} (a TEXT) STRICT\`);`, literal],
      'app/b15.ts': ["import type { Reader } from '../storage/sqlite.ts';\nexport const f = (r: Reader): unknown => r.get('SELECT 1 AS x');", 'only the storage repositories run SQL'],
      'risk/b16.ts': ["import type { Db } from '../storage/sqlite.ts';\nexport const f = (db: Db): unknown => db.all('SELECT 1 AS x');", 'only the storage repositories run SQL'],
      // the write rules read the text a call adds up to, through a const, in get as in run (review Q, security 2)
      'storage/repo-w1.ts': [`${HEAD}const LIFT = 'DELETE FROM ' + 'halt_reasons';\nexport const f = (tx: Tx): number => tx.run(LIFT);`, 'only repo-owner.ts and repo-server.ts lift a halt'],
      'storage/repo-w2.ts': [`${HEAD}export const f = (tx: Tx): unknown => tx.get('UPDATE flags SET kill = 0 WHERE id = 1 RETURNING kill');`, 'only repo-server.ts clears KILL'],
    };
    const ok: Record<string, string> = {
      'storage/repo-ok.ts': [
        "import type { Reader, Tx } from './sqlite.ts';",
        "import { SHARED } from './repo-shared.ts';",
        "const COLUMNS = 'id, n';",
        'const BY_ID = `SELECT ${COLUMNS} FROM t WHERE id = ?`;',
        "const COUNT = 'SELECT count(*) AS n ' + 'FROM t';",
        "export const a = (r: Reader): unknown => r.get('SELECT 1 AS x');",
        "export const b = (r: Reader): unknown => r.get(BY_ID, 'x');",
        'export const c = (r: Reader): unknown => r.all(COUNT);',
        "export const d = (tx: Tx): number => tx.run(SHARED, 'x');",
        'export const e = (tx: Tx): unknown => tx.get((BY_ID), null);',
        'export const g = (k: string): number | undefined => new Map<string, number>().get(k);',
        'export const h = (dyn: string): number => ({ run: (s: string): number => s.length }).run(dyn);',
      ].join('\n'),
      'storage/repo-shared.ts': "export const SHARED = 'DELETE FROM t WHERE id = ?';",
      'storage/audit-x.ts': "import type { Tx } from './sqlite.ts';\nexport const f = (tx: Tx): number => tx.run('INSERT INTO t (id) VALUES (?)', 'x');",
    };
    const { program, srcRoot } = virtualProgram({ 'storage/sqlite.ts': STUB, ...Object.fromEntries(Object.entries(bad).map(([rel, [text]]) => [rel, text])), ...ok });
    const { problems } = sqlProblems(program, srcRoot);
    typedFlaggedFor(problems, bad);
    // and only the JSON.parse value is untyped
    const untyped = problems.filter((p) => p.includes('of type any')).map((p) => p.slice(0, p.indexOf(':')));
    assert.deepEqual([...new Set(untyped)], ['storage/repo-b12.ts']);
    for (const rel of Object.keys(ok)) {
      assert.deepEqual(problems.filter((p) => p.startsWith(`${rel}:`)), [], rel);
    }
    // the runner may run a migration's own pinned sql, and constant scripts
    const runner = virtualProgram({
      'storage/sqlite.ts': STUB,
      'storage/migrations.ts': `${HEAD}export interface Migration { readonly sql: string }\nconst V = 'CREATE TABLE v (a TEXT) STRICT;';\nexport const f = (tx: Tx, m: Migration): void => { tx.script(V); tx.script(m.sql); };`,
    });
    assert.deepEqual(sqlProblems(runner.program, runner.srcRoot).problems, []);
  });

  const HANDLE_STUB = [
    'export type SqlParam = string | bigint | null;',
    'export interface Reader { get(sql: string, ...p: SqlParam[]): unknown; all(sql: string, ...p: SqlParam[]): readonly unknown[]; }',
    'export interface Tx extends Reader { run(sql: string, ...p: SqlParam[]): number; script(sql: string): void; }',
    'export interface Db extends Reader { readonly file: string; transaction<T>(fn: (tx: Tx) => T): T; close(): void; }',
  ].join('\n');

  it('CANARY: a database handle keeps its type: no Reflect, Object.*, assertion, look-alike interface or structural slot carries it past the SQL rules (review Q, security 4)', () => {
    const HEAD = "import type { Db, Reader, Tx } from './sqlite.ts';\n";
    const param = 'a database handle goes only to a parameter typed Reader, Tx or Db';
    const kept = 'a database handle is kept only where the type is Reader, Tx or Db';
    const bad: Record<string, readonly [string, ...string[]]> = {
      'storage/repo-f1.ts': [`${HEAD}export const f = (tx: Tx, q: string): unknown => Reflect.get(tx, 'run')(q);`, param],
      'app/f2.ts': ["import type { Tx } from '../storage/sqlite.ts';\nexport const f = (tx: Tx): unknown => Reflect.apply(Reflect.get(tx, 'run'), tx, ['DELETE FROM t']);", param],
      'storage/repo-f3.ts': [`${HEAD}export const f = (tx: Tx, q: string): void => { for (const m of Object.values(tx)) { m(q); } };`, param],
      'storage/repo-f4.ts': [
        `${HEAD}interface MyTx extends Tx { run(sql: string): number }\nconst g = (x: MyTx, q: string): number => x.run(q);\nexport const f = (tx: Tx, q: string): number => g(tx, q);`,
        'only storage/sqlite.ts extends or implements Reader, Tx or Db',
        param,
      ],
      'storage/repo-f5.ts': [`${HEAD}export const f = (tx: Tx, q: string): number => (tx as unknown as { run(s: string): number }).run(q);`, 'no type assertion on a database handle'],
      'storage/repo-f6.ts': [`${HEAD}export const f = (tx: Tx, q: string): unknown => Object.getOwnPropertyDescriptor(tx, 'run')?.value(q);`, param],
      'storage/repo-f7.ts': [`${HEAD}const kept: { m?: unknown } = {};\nexport const f = (tx: Tx): void => { kept.m = Reflect.get(tx, 'run'); };`, param],
      // what the LIMIT of reviews P allowed: a helper with a hand-written structural parameter
      'storage/repo-f8.ts': [`${HEAD}const g = (x: { run(sql: string): number }, t: string): number => x.run(t);\nexport const f = (tx: Tx, t: string): number => g(tx, t);`, param],
      'storage/repo-f9.ts': [`${HEAD}export const f = (tx: Tx, q: string): number => { const x: { run(sql: string): number } = tx; return x.run(q); };`, kept],
      'storage/repo-f10.ts': [`${HEAD}const g = (tx: Tx): { run(sql: string): number } => tx;\nexport const f = (tx: Tx, q: string): number => g(tx).run(q);`, kept],
      'storage/repo-f11.ts': [`${HEAD}function sneak<T>(x: T, q: string): unknown { return Reflect.get(x as object, 'run')(q); }\nexport const f = (tx: Tx, q: string): unknown => sneak(tx, q);`, param], // generic, unconstrained
      'storage/repo-f12.ts': [`${HEAD}export const f = (db: Db): unknown => db.transaction.bind(db);`, "call a database handle's methods directly"],
      'storage/repo-f13.ts': [`${HEAD}export const f = (db: Db): unknown => { const { transaction } = db; return transaction; };`, 'do not destructure a database handle'],
      'storage/repo-f14.ts': [`${HEAD}export const f = (tx: Tx): unknown => ({ ...tx });`, 'a database handle goes only to a parameter, variable or return value typed'],
      'app/f15.ts': ["import type { Db } from '../storage/sqlite.ts';\nexport const f = (db: Db, log: (x: unknown) => void): void => log(db);", param],
      'storage/repo-f16.ts': [
        `${HEAD}export class LooseTx implements Tx { get(): undefined { return undefined; } all(): readonly unknown[] { return []; } run(): number { return 0; } script(): void {} }`,
        'only storage/sqlite.ts extends or implements Reader, Tx or Db',
      ],
      'storage/repo-f17.ts': [`${HEAD}export const f = (tx: Tx): unknown[] => { const list: unknown[] = [tx]; return list; };`, kept],
      'storage/repo-f18.ts': [`${HEAD}export const f = (r: Reader): string => \`\${String(r)}\`;`, param],
      // the re-check's R2: `arguments` aliases the handle as any (checkSource bans the name too)
      'storage/repo-f19.ts': [`${HEAD}export function viaArguments(tx: Tx, t: string): unknown { const f = Reflect.get(arguments[0], 'run'); return f('DELETE FROM ' + t); }`, 'a call of a value of type any'],
    };
    const ok: Record<string, string> = {
      'storage/repo-ok.ts': [
        HEAD,
        "const ONE = 'SELECT 1 AS x';",
        'const read = (r: Reader): unknown => r.get(ONE);',
        'const inTx = <T extends Reader>(r: T): unknown => r.get(ONE);',
        'export const a = (tx: Tx): unknown => read(tx);', // a Tx where a Reader is asked
        'export const b = (tx: Tx): unknown => inTx(tx);',
        'export const c = (db: Db): unknown => db.transaction((tx) => read(tx));',
        'export const d = (tx: Tx): unknown => { const t = tx; const u: Reader = t; return read(u); };',
        'export const e = (db: Db): string => db.file;', // a data property is only read
        'export const g = (db: Db | undefined): void => { if (db !== undefined) { db.close(); } db?.close(); };',
        'export const h = (db: Db): Db => db;',
        'export const i = (db: Db): { readonly db: Db } => ({ db });',
        'export const j = (db: Db): readonly Db[] => [db];',
        'export const k = (db: Db, other: Db | null): Db => other ?? db;',
        'export class Holder { readonly db: Db; constructor(db: Db) { this.db = db; } read(): unknown { return read(this.db); } }',
        'export const l = (db: Db): Holder => new Holder(db);',
      ].join('\n'),
    };
    const { program, srcRoot } = virtualProgram({ 'storage/sqlite.ts': HANDLE_STUB, ...Object.fromEntries(Object.entries(bad).map(([rel, [text]]) => [rel, text])), ...ok });
    const { problems } = sqlProblems(program, srcRoot);
    typedFlaggedFor(problems, bad);
    assert.deepEqual(problems.filter((p) => p.startsWith('storage/repo-ok.ts:')), []);
  });

  it('CANARY: a restricted file\'s functions are only called where they are imported, never exported again, aliased, stored, bound or passed on (review Q, security 1c)', () => {
    const HEAD = "import type { Tx } from './sqlite.ts';\n";
    const handed = 'is only called where it is imported, never handed on';
    const files: Record<string, string> = {
      'storage/sqlite.ts': HANDLE_STUB,
      'storage/repo-server.ts': `${HEAD}export const SERVER_AUDIT_ACTIONS = Object.freeze(['server:clear-kill'] as const);\nexport function clearKill(tx: Tx): number { return tx.run('DELETE FROM t'); }\nexport const again = clearKill; // its own file may`,
      'storage/repo-owner.ts': `${HEAD}export function unpause(tx: Tx): number { return tx.run('DELETE FROM t'); }`,
      'storage/audit-chain.ts': `${HEAD}export const AUDIT_GENESIS = '0'.repeat(64);\nexport function appendAuditRow(tx: Tx): number { return tx.run('DELETE FROM t'); }`,
      'storage/repo-redeem.ts': `${HEAD}export function redeemApproval(tx: Tx): number { return tx.run('DELETE FROM t'); }`,
      'core/rng.ts': "export function newApprovalKey(): Uint8Array { return new Uint8Array(32); }\nexport const systemRng = Object.freeze({ approvalKey: newApprovalKey });",
      'cli/ok.ts': [
        "import type { Tx } from '../storage/sqlite.ts';",
        "import { clearKill, SERVER_AUDIT_ACTIONS } from '../storage/repo-server.ts';",
        "import * as owner from '../storage/repo-owner.ts';",
        "import { AUDIT_GENESIS } from '../storage/audit-chain.ts';",
        'export const reset = (tx: Tx): number => clearKill(tx) + owner.unpause(tx);',
        'export const data = [SERVER_AUDIT_ACTIONS, AUDIT_GENESIS];', // data, not a capability
        'export type Clear = typeof clearKill;',
      ].join('\n'),
    };
    const SERVER = "import { clearKill } from '../storage/repo-server.ts';\n";
    const bad: Record<string, readonly [string, ...string[]]> = {
      'cli/b1.ts': [`${SERVER}export const k = clearKill;`, handed],
      'cli/b2.ts': [`${SERVER}export default clearKill;`, handed],
      'cli/b3.ts': ["import { clearKill as c } from '../storage/repo-server.ts';\nexport { c };", handed],
      'cli/b4.ts': [`${SERVER}export const all = [clearKill];`, handed],
      'cli/b5.ts': [`${SERVER}export const o = { clearKill };`, handed],
      'cli/b6.ts': [`${SERVER}export const k = clearKill.bind(null);`, handed],
      'cli/b7.ts': [`${SERVER}export const later = (f: (fn: unknown) => void): void => f(clearKill);`, handed],
      'cli/b8.ts': ["import * as server from '../storage/repo-server.ts';\nexport const s = server;", "a restricted file's namespace is used only as server.name(...)"],
      'cli/b9.ts': ["import * as server from '../storage/repo-server.ts';\nexport const k = server.clearKill;", handed],
      'cli/b10.ts': ["import * as server from '../storage/repo-server.ts';\nexport const k = server['clearKill'];", "a restricted file's namespace is used only as server.name(...)"],
      'cli/b11.ts': ["import { again } from '../storage/repo-server.ts';\nexport const k = again;", handed], // a const that holds a function
      // the reviewer's reproduction: the owner's handler file handing an owner writer to whoever imports it
      'app/owner.ts': ["import { unpause } from '../storage/repo-owner.ts';\nexport const u = unpause;", handed],
      'storage/repo-b12.ts': ["import { appendAuditRow } from './audit-chain.ts';\nexport const a = appendAuditRow;", handed],
      // the token store handing T2 on to whoever imports it (s.15.11; review S, security 6)
      'app/token-store.ts': ["import { redeemApproval } from '../storage/repo-redeem.ts';\nexport const r = redeemApproval;", handed],
      // the key maker handed on to whoever imports this app/ file (6d-1, STORAGE_DESIGN s.16.7.4)
      'app/x.ts': ["import { newApprovalKey } from '../core/rng.ts';\nexport const k = newApprovalKey;", handed],
    };
    const { program, srcRoot } = virtualProgram({ ...files, ...Object.fromEntries(Object.entries(bad).map(([rel, [text]]) => [rel, text])) });
    const { problems, restrictedCalls } = sqlProblems(program, srcRoot);
    typedFlaggedFor(problems, bad);
    for (const rel of ['cli/ok.ts', 'storage/repo-server.ts', 'storage/repo-owner.ts', 'storage/audit-chain.ts']) {
      assert.deepEqual(problems.filter((p) => p.startsWith(`${rel}:`)), [], rel);
    }
    assert.equal(restrictedCalls, 2); // clearKill(tx) and owner.unpause(tx)
  });

  it('CANARY: each writer of the audit chain writes only as its own actors, never as a value it is handed (review Q re-check, security R1)', () => {
    const HEAD = "import type { Tx } from './sqlite.ts';\nimport { appendAuditRow, type AuditActor } from './audit-chain.ts';\n";
    const CHAIN = [
      "import type { Tx } from './sqlite.ts';",
      "export type AuditActor = 'owner-telegram' | 'owner-server' | 'engine' | 'ai';",
      "export function appendAuditRow(tx: Tx, at: number, actor: AuditActor, action: string): number { return tx.run('INSERT INTO audit_log (id) VALUES (?)', String(at) + actor + action); }",
    ].join('\n');
    const actor = "appendAuditRow's actor here must be";
    // one program per case, so each pins its file's exact set: one actor too many anywhere is caught
    const bad: readonly (readonly [string, string, string])[] = [
      // the re-check's reproduction: a wrapper that takes the actor as a value
      ['storage/repo-audit.ts', `${HEAD}export const anyActor = (tx: Tx, who: AuditActor, action: string): number => appendAuditRow(tx, 0, who, action);`, `${actor} engine`],
      ['storage/repo-audit.ts', `${HEAD}export const asServer = (tx: Tx): number => appendAuditRow(tx, 0, 'owner-server', 'server:clear-kill');`, `${actor} engine`],
      ['storage/repo-server.ts', `${HEAD}export const asOwner = (tx: Tx): number => appendAuditRow(tx, 0, 'owner-telegram', 'owner:set');`, `${actor} owner-server`],
      ['storage/repo-owner.ts', `${HEAD}export const asWho = (tx: Tx, who: string): number => appendAuditRow(tx, 0, who as AuditActor, 'owner:set');`, `${actor} owner-telegram or owner-server`],
      ['storage/repo-owner.ts', `${HEAD}export const asEngine = (tx: Tx): number => appendAuditRow(tx, 0, 'engine', 'engine:kill-set');`, `${actor} owner-telegram or owner-server`],
      ['storage/repo-config.ts', `${HEAD}export const asEngine = (tx: Tx): number => appendAuditRow(tx, 0, 'engine', 'engine:apply-due');`, `${actor} nobody`],
    ];
    for (const [rel, text, why] of bad) {
      const wrong = virtualProgram({ 'storage/sqlite.ts': HANDLE_STUB, 'storage/audit-chain.ts': CHAIN, [rel]: text });
      typedFlaggedFor(sqlProblems(wrong.program, wrong.srcRoot).problems, { [rel]: [text, why] });
    }
    const right = virtualProgram({
      'storage/sqlite.ts': HANDLE_STUB,
      'storage/audit-chain.ts': CHAIN,
      'storage/repo-audit.ts': `${HEAD}export const asEngine = (tx: Tx, action: string): number => appendAuditRow(tx, 0, 'engine', action);`,
      'storage/repo-owner.ts': `${HEAD}type OwnerActor = 'owner-telegram' | 'owner-server';\nexport const asOwner = (tx: Tx, who: OwnerActor): number => appendAuditRow(tx, 0, who, 'owner:set');`,
      'storage/repo-server.ts': `${HEAD}export const asServer = (tx: Tx): number => appendAuditRow(tx, 0, 'owner-server', 'server:reset-halt');`,
    });
    const fine = sqlProblems(right.program, right.srcRoot);
    assert.deepEqual(fine.problems, []);
    assert.equal(fine.auditCalls, 3);
  });

  it('CANARY: no "arguments" in src/, which hands every argument on as any (review Q re-check, security R2)', () => {
    flaggedFor([
      ['storage/repo-x.ts', "export function f(tx: unknown): unknown { return Reflect.get(arguments[0], 'run'); }", 'no "arguments"'],
      ['app/x.ts', 'export function n(): number { return arguments.length; }', 'no "arguments"'],
    ]);
    assert.deepEqual(checkSource('app/x.ts', 'export const o = { arguments: 1 }; export const n = o.arguments;'), []); // a key named so is fine
  });

  it('LIMIT, written down: a handle inside another value whose type is rewritten by hand, or a function looser than the signature it is called through, is not seen; review is the guard there', () => {
    // The handle rule follows a value of a handle's own type, and checks a call against the signature
    // it resolves to. Here (f) the handle sits in an object whose inferred type is { tx: Tx }, and that
    // object goes to a parameter of a hand-written type, and (w) a list of handles is widened to a list
    // of objects (the re-check's R3): only a deep comparison of the two types would see either. And (h)
    // the call resolves to an overload that takes a Tx, while the body that runs takes unknown (a class
    // method behind an interface, or a function kept in a variable of a function type, works the same
    // way). All need deliberate code. If this starts to be flagged, update STORAGE_DESIGN s.13.
    const { program, srcRoot } = virtualProgram({
      'storage/sqlite.ts': HANDLE_STUB,
      'storage/repo-limit.ts': [
        "import type { Tx } from './sqlite.ts';",
        'const g = (d: { tx: { run(sql: string): number } }, t: string): number => d.tx.run(t);',
        'export const f = (tx: Tx, t: string): number => { const deps = { tx }; return g(deps, t); };',
        'function pass(tx: Tx, t: string): unknown;',
        "function pass(x: unknown, t: string): unknown { return (Reflect.get(x as object, 'run') as (s: string) => unknown)(t); }",
        'export const h = (tx: Tx, t: string): unknown => pass(tx, t);',
        "export const w = (tx: Tx, t: string): unknown => { const xs = [tx]; const ys: readonly object[] = xs; const y = ys[0]; return y === undefined ? 0 : (Reflect.get(y, 'run') as (s: string) => unknown)(t); };",
      ].join('\n'),
    });
    assert.deepEqual(sqlProblems(program, srcRoot).problems, []);
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

describe('architecture: the approval transactions of step 6d-2 (STORAGE_DESIGN s.16.7.4)', () => {
  it('CANARY: positionExitBudget stays inside risk/ (C2, review L): by name, by namespace, by default or dynamically', () => {
    const why = 'positionExitBudget stays inside risk/';
    flaggedFor([
      ['app/x.ts', "import { positionExitBudget } from '../risk/reserve.ts';", why],
      ['app/x.ts', "import { positionExitBudget as budget } from '../risk/reserve.ts';", why],
      ['app/x.ts', "import * as reserve from '../risk/reserve.ts';", why],
      ['app/x.ts', "import reserve from '../risk/reserve.ts';", why],
      ['app/x.ts', "export const f = (): unknown => import('../risk/reserve.ts');", why],
      ['app/x.ts', "import { positionExitBudget } from '../risk/RESERVE.ts';", why],
    ]);
    for (const [rel, text] of [
      ['risk/x.ts', "import { positionExitBudget } from './reserve.ts';"],
      ['app/x.ts', "import { BASE_FEE_PER_SIGNATURE, RiskError, attemptCost } from '../risk/reserve.ts';"],
      ['app/x.ts', "import type { ReserveCaps } from '../risk/reserve.ts';"],
    ] as const) {
      assert.deepEqual(checkSource(rel, text), [], text);
    }
  });

  it('no catch inside a transaction: every app/ transaction callback is written in place and followed, and nothing in it catches (C32)', () => {
    const files = sourceFiles().map((rel) => path.join(SRC, rel));
    const { problems, callbacks, followed } = noCatchProblems(ts.createProgram(files, compilerOptions()), SRC);
    assert.deepEqual(problems, []);
    // non-vacuity: the token store's T2 and the seven of app/approve-tx.ts, and the helpers they call
    assert.ok(callbacks >= 8, `the rule saw ${callbacks} transaction callbacks`);
    assert.ok(followed >= 8, `the rule followed ${followed} function bodies`);
  });

  it('CANARY: each way to catch inside a transaction is caught for its own reason (C32; V7)', () => {
    const STUB = [
      'export type SqlParam = string | bigint | null;',
      'export interface Reader { get(sql: string, ...p: SqlParam[]): unknown; all(sql: string, ...p: SqlParam[]): readonly unknown[]; }',
      'export interface Tx extends Reader { run(sql: string, ...p: SqlParam[]): number; script(sql: string): void; }',
      'export interface Db extends Reader { readonly file: string; transaction<T>(fn: (tx: Tx) => T): T; close(): void; }',
    ].join('\n');
    const HEAD = "import type { Db, Tx } from '../storage/sqlite.ts';\nimport { write } from '../storage/repo-ok.ts';\n";
    const tryIn = 'no try inside a transaction callback';
    const handed = 'goes only to a function of storage/, app/ or cli/';
    const bad: Record<string, readonly [string, ...string[]]> = {
      'app/c1.ts': [`${HEAD}export const f = (db: Db): number => db.transaction(() => { try { return 1; } catch { return 2; } });`, tryIn],
      'app/c2.ts': [`${HEAD}export const f = (db: Db): number => db.transaction(() => { const g = (): number => { try { return 1; } catch { return 2; } }; return g(); });`, tryIn],
      'app/c3.ts': [`${HEAD}const step = (tx: Tx): number => tx.run('UPDATE t SET x = 1');\nexport const f = (db: Db): number => db.transaction(step);`, 'a transaction callback is written in place'],
      'app/c4.ts': [`${HEAD}const helper = (): number => { try { return 1; } catch { return 2; } };\nexport const f = (db: Db): number => db.transaction(() => helper());`, `${tryIn} (followed from app/c4.ts)`],
      'app/c5.ts': [
        `${HEAD}function inner(): number { try { return 1; } catch { return 2; } }\nconst outer = (): number => inner();\nexport const f = (db: Db): number => db.transaction(() => outer());`,
        tryIn,
      ],
      'app/c6.ts': [`${HEAD}export const f = (db: Db, g: (t: Tx) => void): void => db.transaction((tx) => g(tx));`, handed],
      'app/c7.ts': [`${HEAD}interface Each { each(fn: () => void): void }\nexport const f = (db: Db, e: Each): void => db.transaction((tx) => e.each(() => write(tx, 'x')));`, handed],
      'app/c8.ts': [`${HEAD}export const f = (db: Db): number => db.transaction(() => { void Promise.resolve(1).catch(() => 0); return 1; });`, 'no .catch( inside a transaction callback', handed],
      'app/c9.ts': [`${HEAD}export const f = (db: Db): void => db.transaction(() => { void Promise.resolve(1).then(() => 0).finally(() => undefined); });`, 'no .then(', 'no .finally('],
      'app/c10.ts': [`${HEAD}class Swallow { constructor() { try { void 0; } catch { void 0; } } }\nexport const f = (db: Db): Swallow => db.transaction(() => new Swallow());`, tryIn],
      // a variable of function type: what it holds is not known, so it never receives the transaction
      'app/c11.ts': [`${HEAD}const send = (x: unknown): void => { void x; };\nexport const f = (db: Db): void => db.transaction((tx) => { const sink: (t: Tx) => void = send; sink(tx); });`, handed],
      'storage/repo-c12.ts': ["export function f(): number { try { return 1; } catch { return 2; } }", 'a catch block in storage/ ends with a throw'],
      // V7: the callee is found through an aliased import, a namespace member and an object's method
      'app/c13-lib.ts': ['export function risky(): number { try { return 1; } catch { return 2; } }', `${tryIn} (followed from app/c13.ts)`],
      'app/c14-lib.ts': ['export function risky(): number { try { return 1; } catch { return 2; } }', `${tryIn} (followed from app/c14.ts)`],
      'app/c15.ts': [`${HEAD}const o = { m(): number { try { return 1; } catch { return 2; } } };\nexport const f = (db: Db): number => db.transaction(() => o.m());`, `${tryIn} (followed from app/c15.ts)`],
      // review U, security 1: the reviewer's three reproductions, and three more ways to the same end
      'app/c16.ts': [`${HEAD}interface Each { each(fn: () => void): void }\nexport const f = (db: Db, e: Each): void => db.transaction((tx) => { const w = (): void => write(tx, ''); e.each(w); write(tx, 'after'); });`, handed],
      'app/c17.ts': [`${HEAD}interface Holder { run(o: { readonly tx: Tx }): void }\nexport const f = (db: Db, h: Holder): void => db.transaction((tx) => { h.run({ tx }); write(tx, 'after'); });`, handed],
      'app/c18.ts': [`${HEAD}interface Each { each(fn: () => void): void }\nexport const f = (db: Db, e: Each): void => db.transaction((tx) => { const w = write.bind(null, tx, ''); e.each(w); });`, handed],
      'app/c19.ts': [`${HEAD}interface Each { each(fn: () => void): void }\nexport const f = (db: Db, e: Each): void => db.transaction((tx) => e.each(write.bind(null, tx, '')));`, handed],
      'app/c20.ts': [`${HEAD}interface Holder { run(o: unknown): void }\nexport const f = (db: Db, h: Holder): void => db.transaction((tx) => { const box = { inner: { tx } }; h.run(box); });`, handed],
      'app/c21.ts': [`${HEAD}interface Holder { run(o: readonly Tx[]): void }\nexport const f = (db: Db, h: Holder): void => db.transaction((tx) => h.run([tx]));`, handed],
    };
    const callers: Record<string, string> = {
      'app/c13.ts': `${HEAD}import { risky as r } from './c13-lib.ts';\nexport const f = (db: Db): number => db.transaction(() => r());`,
      'app/c14.ts': `${HEAD}import * as lib from './c14-lib.ts';\nexport const f = (db: Db): number => db.transaction(() => lib.risky());`,
    };
    const ok: Record<string, string> = {
      'storage/repo-ok.ts': [
        "import type { Tx } from './sqlite.ts';",
        "export function write(tx: Tx, x: string): void { tx.run('INSERT INTO t VALUES (?)', x); }",
        "export function read(text: string): unknown { try { return JSON.parse(text); } catch { throw new Error('bad'); } }",
      ].join('\n'),
      'app/ok.ts': [
        HEAD,
        // a try around the whole transaction call is how errors are handled: after the rollback
        'export const a = (db: Db, rows: readonly string[]): void => { try { db.transaction((tx) => { rows.forEach((x) => write(tx, x)); }); } catch (e) { void e; } };',
        'const helper = (tx: Tx, x: string): void => write(tx, x);',
        'export const b = (db: Db): void => db.transaction((tx) => helper(tx, \'y\'));',
        'export const c = (db: Db): string[] => db.transaction(() => [1, 2].map((n) => String(n)));',
        // a named function to the lib, and an object of functions that holds no handle to an outside call
        'export const d = (db: Db): string[] => db.transaction(() => [1, 2].map(String));',
        'interface Issuer { issue(x: string): string }',
        'interface Risk { decide(input: { readonly n: number }, issuer: Issuer): string }',
        "export const e = (db: Db, risk: Risk, issuer: Issuer): string => db.transaction((tx) => { write(tx, 'y'); return risk.decide({ n: 1 }, issuer); });",
      ].join('\n'),
    };
    const { program, srcRoot } = virtualProgram({ 'storage/sqlite.ts': STUB, ...Object.fromEntries(Object.entries(bad).map(([rel, [text]]) => [rel, text])), ...callers, ...ok });
    const { problems } = noCatchProblems(program, srcRoot);
    typedFlaggedFor(problems, bad);
    assert.deepEqual(problems.filter((p) => p.startsWith('app/ok.ts:') || p.startsWith('storage/repo-ok.ts:')), []);
  });
});
