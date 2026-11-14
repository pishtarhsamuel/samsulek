// The only place stored text and integers turn into amounts, times, slots and codes, and back
// (STORAGE_DESIGN.md s.1.2; RISK_POLICY invariant 7). Amounts are canonical decimal TEXT (SQLite's
// INTEGER is signed 64-bit, a u64 is not); times, slots, counts and flags are INTEGER. Each column
// kind has three parts defined side by side: a reader, a writer and the SQL CHECK fragment, and a
// property test proves the CHECK accepts exactly what the reader accepts. A reader names the
// column, never the value: the database is not trusted to be clean. Free text has no writer at
// all (reasons are codes); JSON arrives with core/redact.ts in step 6c.
//
// Each fragment first pins the storage class (typeof), so it holds even outside a STRICT table, and
// a TEXT one then checks octet_length(c) = length(c): length() and GLOB stop at a NUL character, so
// without it '12<NUL>abc' would pass the digit checks; the same test also refuses any non-ASCII.
import { isDay } from '../core/day.ts';
import { isIdText } from '../core/ids.ts';
import { MAX_TIMESTAMP_MS, isTimestamp } from '../core/time.ts';
import {
  U64_MAX,
  lamportsFromText,
  signedLamportsFromText,
  tokenUnitsFromText,
  type Lamports,
  type SignedLamports,
  type TokenUnits,
} from '../core/units.ts';
import { StorageError, type Row, type SqlCell } from './sqlite.ts';

const I64_MAX = 2n ** 63n - 1n;
const CODE_TEXT = /^[a-z0-9][a-z0-9:._-]{0,63}$/;
const HEX64_TEXT = /^[0-9a-f]{64}$/;

/** A reason or status code: lower case, digits and ":._-", 1-64 characters, starting with a letter or digit. */
export function isCodeText(value: unknown): value is string {
  return typeof value === 'string' && CODE_TEXT.test(value);
}

// ---------------------------------------------------------------- readers

function cellOf(r: Row, col: string): SqlCell {
  if (!Object.hasOwn(r, col)) {
    throw new StorageError('bad-cell', `column ${col} is missing from the row`);
  }
  return r[col] as SqlCell;
}

const badCell = (col: string, want: string): StorageError => new StorageError('bad-cell', `column ${col} does not hold ${want}`);

function textOf(r: Row, col: string, want: string): string {
  const cell = cellOf(r, col);
  if (typeof cell !== 'string') {
    throw badCell(col, want);
  }
  return cell;
}

function integerOf(r: Row, col: string, want: string): bigint {
  const cell = cellOf(r, col);
  if (typeof cell !== 'bigint') {
    throw badCell(col, want);
  }
  return cell;
}

function amountOf<T>(r: Row, col: string, parse: (text: string) => T, want: string): T {
  const text = textOf(r, col, want);
  try {
    return parse(text);
  } catch {
    throw badCell(col, want); // the parser's own message would echo the stored text
  }
}

export function lamportsCell(r: Row, col: string): Lamports {
  return amountOf(r, col, lamportsFromText, 'a canonical u64 amount');
}

export function lamportsCellOrNull(r: Row, col: string): Lamports | null {
  return cellOf(r, col) === null ? null : lamportsCell(r, col);
}

export function tokenUnitsCell(r: Row, col: string): TokenUnits {
  return amountOf(r, col, tokenUnitsFromText, 'a canonical u64 amount');
}

export function signedCell(r: Row, col: string): SignedLamports {
  return amountOf(r, col, signedLamportsFromText, 'a canonical signed amount within +-u64');
}

export function msCell(r: Row, col: string): number {
  const v = integerOf(r, col, 'a timestamp in milliseconds');
  if (v < 0n || v > BigInt(MAX_TIMESTAMP_MS)) {
    throw badCell(col, 'a timestamp from 1970 to 2200');
  }
  return Number(v);
}

export function msCellOrNull(r: Row, col: string): number | null {
  return cellOf(r, col) === null ? null : msCell(r, col);
}

export function intCell(r: Row, col: string, min: number, max: number): number {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
    throw new StorageError('bad-option', 'intCell needs whole-number bounds with min <= max');
  }
  const v = integerOf(r, col, 'a whole number');
  if (v < BigInt(min) || v > BigInt(max)) {
    throw badCell(col, `a whole number from ${min} to ${max}`);
  }
  return Number(v);
}

export function slotCell(r: Row, col: string): bigint {
  const v = integerOf(r, col, 'a slot');
  if (v < 0n) {
    throw badCell(col, 'a slot (0 or more)');
  }
  return v;
}

export function boolCell(r: Row, col: string): boolean {
  const v = integerOf(r, col, 'a flag (0 or 1)');
  if (v !== 0n && v !== 1n) {
    throw badCell(col, 'a flag (0 or 1)');
  }
  return v === 1n;
}

function checkedText(r: Row, col: string, ok: (text: string) => boolean, want: string): string {
  const text = textOf(r, col, want);
  if (!ok(text)) {
    throw badCell(col, want);
  }
  return text;
}

export function idCell(r: Row, col: string): string {
  return checkedText(r, col, isIdText, 'an id (1-128 of A-Z a-z 0-9 _ -)');
}

export function codeCell(r: Row, col: string): string {
  return checkedText(r, col, isCodeText, 'a code (1-64 of a-z 0-9 : . _ -)');
}

export function dayCell(r: Row, col: string): string {
  return checkedText(r, col, isDay, 'a calendar day YYYY-MM-DD');
}

export function hex64Cell(r: Row, col: string): string {
  return checkedText(r, col, (t) => HEX64_TEXT.test(t), 'a sha256 in lower-case hex');
}

// ---------------------------------------------------------------- writers

const badParam = (want: string): StorageError => new StorageError('bad-param', `expected ${want}`);

export function amountParam(v: bigint): string {
  if (typeof v !== 'bigint' || v < 0n || v > U64_MAX) {
    throw badParam('an amount from 0 to 2^64-1');
  }
  return v.toString(10);
}

export function signedParam(v: bigint): string {
  if (typeof v !== 'bigint' || v < -U64_MAX || v > U64_MAX) {
    throw badParam('a signed amount within +-(2^64-1)');
  }
  return v.toString(10);
}

export function msParam(v: number): bigint {
  if (!isTimestamp(v)) {
    throw badParam('a timestamp in whole milliseconds from 1970 to 2200');
  }
  return BigInt(v);
}

export function intParam(v: number): bigint {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
    throw badParam('a whole number');
  }
  return BigInt(v);
}

export function slotParam(v: bigint): bigint {
  if (typeof v !== 'bigint' || v < 0n || v > I64_MAX) {
    throw badParam('a slot from 0 to 2^63-1');
  }
  return v;
}

export function boolParam(v: boolean): bigint {
  if (typeof v !== 'boolean') {
    throw badParam('true or false');
  }
  return v ? 1n : 0n;
}

function checkedParam(v: string, ok: (text: string) => boolean, want: string): string {
  if (typeof v !== 'string' || !ok(v)) {
    throw badParam(want);
  }
  return v;
}

export function idParam(v: string): string {
  return checkedParam(v, isIdText, 'an id (1-128 of A-Z a-z 0-9 _ -)');
}

/** Reasons are codes, never prose: free text cannot be stored at all. */
export function codeParam(v: string): string {
  return checkedParam(v, isCodeText, 'a code (1-64 of a-z 0-9 : . _ -)');
}

export function dayParam(v: string): string {
  return checkedParam(v, isDay, 'a calendar day YYYY-MM-DD');
}

export function hex64Param(v: string): string {
  return checkedParam(v, (t) => HEX64_TEXT.test(t), 'a sha256 in lower-case hex');
}

// ---------------------------------------------------------------- SQL CHECK fragments

const COLUMN = /^[a-z][a-z0-9_]{0,62}$/;
const U64_MAX_TEXT = U64_MAX.toString(10);

/** A fragment is built from a plain column name, so no SQL can travel in through one. */
function column(c: string): string {
  if (typeof c !== 'string' || !COLUMN.test(c)) {
    throw new StorageError('bad-sql', 'a CHECK fragment takes a plain lower-case column name');
  }
  return c;
}

/** TEXT, with no NUL and no non-ASCII character in it (length() counts up to a NUL, octet_length() every byte). */
const ascii = (c: string): string => `typeof(${c}) = 'text' AND octet_length(${c}) = length(${c})`;
/** An INTEGER: outside a STRICT table, text compares above every number and a REAL could pass BETWEEN. */
const integer = (c: string): string => `typeof(${c}) = 'integer'`;

/** 1-20 ASCII digits, no leading zero, at most 2^64-1: text order equals number order at equal length. */
const digitsU64 = (e: string): string =>
  `length(${e}) BETWEEN 1 AND 20 AND ${e} NOT GLOB '*[^0-9]*' AND (${e} = '0' OR ${e} NOT GLOB '0*')` +
  ` AND (length(${e}) < 20 OR ${e} <= '${U64_MAX_TEXT}')`;

export function u64(c: string): string {
  const n = column(c);
  return `(${ascii(n)} AND ${digitsU64(n)})`;
}

export function u64OrNull(c: string): string {
  const n = column(c);
  return `(${n} IS NULL OR ${u64(n)})`;
}

export function signed(c: string): string {
  const n = column(c);
  return `(${ascii(n)} AND ((${digitsU64(n)}) OR (${n} GLOB '-[1-9]*' AND ${digitsU64(`substr(${n}, 2)`)})))`;
}

export function ms(c: string): string {
  const n = column(c);
  return `(${integer(n)} AND ${n} BETWEEN 0 AND ${MAX_TIMESTAMP_MS})`;
}

export function msOrNull(c: string): string {
  const n = column(c);
  return `(${n} IS NULL OR ${ms(n)})`;
}

export function slot(c: string): string {
  const n = column(c);
  return `(${integer(n)} AND ${n} >= 0)`;
}

export function bool(c: string): string {
  const n = column(c);
  return `(${integer(n)} AND ${n} IN (0, 1))`;
}

export function int(c: string, min: number, max: number): string {
  const n = column(c);
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
    throw new StorageError('bad-sql', 'an int fragment needs whole-number bounds with min <= max');
  }
  return `(${integer(n)} AND ${n} BETWEEN ${min} AND ${max})`;
}

/** = core/ids isIdText. */
export function id(c: string): string {
  const n = column(c);
  return `(${ascii(n)} AND length(${n}) BETWEEN 1 AND 128 AND ${n} NOT GLOB '*[^A-Za-z0-9_-]*')`;
}

/** = isCodeText. */
export function code(c: string): string {
  const n = column(c);
  return `(${ascii(n)} AND length(${n}) BETWEEN 1 AND 64 AND ${n} GLOB '[a-z0-9]*' AND ${n} NOT GLOB '*[^a-z0-9:._-]*')`;
}

/** = core/day isDay: a real calendar date from 0100-01-01 (date() normalizes 02-30 to 03-02, so it differs). */
export function day(c: string): string {
  const n = column(c);
  return `(${ascii(n)} AND ${n} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND ${n} >= '0100-01-01' AND date(${n}) IS ${n})`;
}

export function hex64(c: string): string {
  const n = column(c);
  return `(${ascii(n)} AND length(${n}) = 64 AND ${n} NOT GLOB '*[^0-9a-f]*')`;
}
