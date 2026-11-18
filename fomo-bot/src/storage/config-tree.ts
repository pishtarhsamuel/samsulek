// The tunables in their stored form, as plain JSON trees (STORAGE_DESIGN.md s.14): storage cannot
// import the config module at runtime, so it checks what it can on the stored form itself, group by
// group and name by name, in the stored order. A value is a whole number (bps, counts, times) or
// decimal text (lamports, as jsonParam writes a bigint); two values are the same only when both their
// kind and their text are. Pure: no SQL, no I/O.
import { jsonParam } from './codec.ts';
import { StorageError, type StorageErrorCode } from './sqlite.ts';

export type TunableTree = Readonly<Record<string, Readonly<Record<string, number | string>>>>;

/** group.name, as the CHECK on pending_changes.path takes it (letters and digits, one dot, 3-64 characters). */
const PATH = /^[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$/;
const DIGITS = /^(?:0|[1-9][0-9]*)$/;

export function isConfigPath(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 3 && v.length <= 64 && PATH.test(v);
}

const isPlainObject = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/**
 * The tree of a tunables object: its exact stored form (jsonParam's text, parsed again), checked to be
 * groups of named whole numbers or decimal text. `code` says whose fault a bad tree is: a stored row's
 * (bad-cell) or a caller's (bad-param).
 */
export function treeOf(values: unknown, code: Extract<StorageErrorCode, 'bad-cell' | 'bad-param'>): TunableTree {
  const bad = (): StorageError => new StorageError(code, 'expected tunables: groups of named whole numbers or decimal text');
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonParam(values)); // plain data only, in its stored form (bigints as decimal text)
  } catch {
    throw bad();
  }
  if (!isPlainObject(parsed)) {
    throw bad();
  }
  for (const group of Object.keys(parsed)) {
    const names = parsed[group];
    if (!isPlainObject(names) || Object.keys(names).length === 0) {
      throw bad();
    }
    for (const name of Object.keys(names)) {
      const value = names[name];
      const whole = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
      if (!isConfigPath(`${group}.${name}`) || !(whole || (typeof value === 'string' && DIGITS.test(value)))) {
        throw bad();
      }
    }
  }
  return parsed as TunableTree;
}

/** Every tunable's path, in the stored order. */
export function pathsOf(tree: TunableTree): readonly string[] {
  return Object.keys(tree).flatMap((group) => Object.keys(tree[group] ?? {}).map((name) => `${group}.${name}`));
}

/** The value at a path, or undefined when the tree has no such tunable. */
export function valueAt(tree: TunableTree, path: string): number | string | undefined {
  const [group = '', name = ''] = path.split('.');
  const names = Object.hasOwn(tree, group) ? tree[group] : undefined;
  return names !== undefined && Object.hasOwn(names, name) ? names[name] : undefined;
}

/** The value at a path holds this amount (a number or decimal text alike). */
export function holds(tree: TunableTree, path: string, amount: bigint): boolean {
  const value = valueAt(tree, path);
  return value !== undefined && String(value) === amount.toString(10);
}

/**
 * The tree with one value replaced by this amount, kept in the value's own kind (a number stays a
 * number); null when there is no such tunable or a number tunable cannot hold the amount exactly.
 */
export function withAmount(tree: TunableTree, path: string, amount: bigint): TunableTree | null {
  const [group = '', name = ''] = path.split('.');
  const current = valueAt(tree, path);
  if (current === undefined) {
    return null;
  }
  const value = typeof current === 'number' ? Number(amount) : amount.toString(10);
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || BigInt(value) !== amount)) {
    return null;
  }
  return { ...tree, [group]: { ...tree[group], [name]: value } };
}

/**
 * The paths whose value differs between two trees, in the stored order; null when the trees do not
 * hold the same tunables in the same order (a version keeps every tunable, in place).
 */
export function changedPathsOf(before: TunableTree, after: TunableTree): readonly string[] | null {
  const paths = pathsOf(before);
  const afterPaths = pathsOf(after);
  if (paths.length !== afterPaths.length || paths.some((p, i) => p !== afterPaths[i])) {
    return null;
  }
  return paths.filter((p) => {
    const a = valueAt(before, p);
    const b = valueAt(after, p);
    return typeof a !== typeof b || String(a) !== String(b);
  });
}
