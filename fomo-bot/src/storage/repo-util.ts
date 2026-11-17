// What every repository checks (STORAGE_DESIGN.md s.1.4): a write changed exactly the rows it must,
// a required row is there (never replaced by a default, contract 1), and a value from a fixed list
// is one of them, both on the way in (bad-param) and on the way out (bad-cell, naming the column).
// A repository checks a command's preconditions before its first write, so a refusal leaves nothing
// written even when a caller catches it.
import { codeCell } from './codec.ts';
import { StorageError, type Row } from './sqlite.ts';

/** Audit ids stay exact as JS numbers, and the links to them in flags and halt_reasons take them. */
export const MAX_AUDIT_ID = Number.MAX_SAFE_INTEGER;

export function expectChanges(changes: number, want: number, what: string): void {
  if (changes !== want) {
    throw new StorageError('row-count', `${what}: ${changes} rows changed, ${want} expected`);
  }
}

export function required<T>(row: T | undefined, what: string): T {
  if (row === undefined) {
    throw new StorageError('row-missing', `${what} is missing`);
  }
  return row;
}

/** A value from a fixed list; a typed caller cannot get it wrong, anything else is refused. */
export function oneOf<T extends string>(value: unknown, list: readonly T[], what: string): T {
  if (typeof value !== 'string' || !(list as readonly string[]).includes(value)) {
    throw new StorageError('bad-param', `expected ${what}`);
  }
  return value as T;
}

/** A stored code from a fixed list: anything else is a bad cell, never a guess. */
export function cellOneOf<T extends string>(r: Row, col: string, list: readonly T[]): T {
  const text = codeCell(r, col);
  if (!(list as readonly string[]).includes(text)) {
    throw new StorageError('bad-cell', `column ${col} does not hold one of its known values`);
  }
  return text as T;
}
