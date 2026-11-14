// The only place stored text and integers turn into amounts, times, slots and codes, and back
// (STORAGE_DESIGN.md s.1.2; RISK_POLICY invariant 7). Amounts are canonical decimal TEXT (SQLite's
// INTEGER is signed 64-bit, a u64 is not); times, slots, counts and flags are INTEGER. Each column
// kind has three parts defined side by side: a reader, a writer and the SQL CHECK fragment, and a
// property test proves the CHECK accepts exactly what the reader accepts. A reader names the
// column, never the value: the database is not trusted to be clean. Free text has no writer at
// all (reasons are codes). JSON is the one kind where the CHECK is looser than the reader on
// purpose: the CHECK is a tripwire, and jsonCell reads back only the exact text jsonParam writes.
//
// Each fragment first pins the storage class (typeof), so it holds even outside a STRICT table, and
// a TEXT one then checks octet_length(c) = length(c): length() and GLOB stop at a NUL character, so
// without it '12<NUL>abc' would pass the digit checks; the same test also refuses any non-ASCII.
import { types } from 'node:util';
import { isDay } from '../core/day.ts';
import { isIdText } from '../core/ids.ts';
import { secretKinds } from '../core/redact.ts';
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

const MAX_JSON = 8_192;
/** What jsonParam writes: plain records, never deep. */
const MAX_JSON_WRITE_DEPTH = 16;
const PRINTABLE = /^[\x20-\x7e]*$/;

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) {
      deepFreeze(inner);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * A JSON column, read back only in the exact form jsonParam writes (review P, security 4): what the
 * json fragment also lets in (a NUL or bidi escape, 1e400, 1,000 levels, spaces) is refused here.
 * Deep-frozen.
 */
export function jsonCell(r: Row, col: string): unknown {
  const want = 'JSON in the exact form jsonParam writes';
  const text = textOf(r, col, want);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw badCell(col, want);
  }
  let again: string;
  try {
    again = jsonParam(value);
  } catch {
    throw badCell(col, want);
  }
  if (again !== text) {
    throw badCell(col, want);
  }
  return deepFreeze(value);
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

/** Text that is about to be stored must not look like a key, a token, a URL or a seed phrase (core/redact). */
function noSecret(text: string, what: string): string {
  const kinds = secretKinds(text);
  if (kinds.length > 0) {
    throw badParam(`${what} that does not look like a secret (it looks like one: ${kinds.join(', ')})`);
  }
  return text;
}

/** Ids are scanned too: a key pasted where a mint belongs is refused (ids stay under 64 characters). */
export function idParam(v: string): string {
  return noSecret(checkedParam(v, isIdText, 'an id (1-128 of A-Z a-z 0-9 _ -)'), 'an id');
}

/** Reasons are codes, never prose: free text cannot be stored at all. */
export function codeParam(v: string): string {
  return noSecret(checkedParam(v, isCodeText, 'a code (1-64 of a-z 0-9 : . _ -)'), 'a code');
}

/**
 * Plain data only: what JSON.stringify would change or drop silently is refused instead. The walk
 * reads property descriptors, never properties (no getter runs), refuses proxies (no trap runs),
 * and spends a budget of the characters the text will need, so a huge or self-repeating value is
 * refused after a bounded amount of work (review P, security 7).
 */
interface Budget {
  left: number;
}

function spend(budget: Budget, chars: number): void {
  budget.left -= chars;
  if (budget.left < 0) {
    throw badParam(`JSON of at most ${MAX_JSON} characters`);
  }
}

function plainJson(value: unknown, depth: number, budget: Budget): unknown {
  switch (typeof value) {
    case 'string':
      if (!PRINTABLE.test(value)) {
        throw badParam('JSON text of printable ASCII only');
      }
      spend(budget, value.length + 2);
      return value;
    case 'boolean':
      spend(budget, value ? 4 : 5);
      return value;
    case 'bigint': {
      const text = value.toString(10); // amounts travel as decimal text
      spend(budget, text.length + 2);
      return text;
    }
    case 'number':
      if (!Number.isFinite(value)) {
        throw badParam('finite numbers in JSON');
      }
      spend(budget, String(value).length);
      return value;
    case 'object':
      spend(budget, value === null ? 4 : 2);
      return value === null ? null : plainContainer(value, depth, budget);
    default:
      throw badParam(`plain data in JSON, not a ${typeof value}`);
  }
}

/**
 * The plain value of one own property, read from its descriptor (a getter or a hidden property is
 * refused); `first` says whether a comma comes before it. The budget counts the text exactly but for
 * escaped quotes and backslashes, so the final length check stays the authority.
 */
function plainProperty(value: object, name: string, first: boolean, depth: number, budget: Budget): unknown {
  const property = Object.getOwnPropertyDescriptor(value, name);
  if (property === undefined || !property.enumerable || !('value' in property)) {
    throw badParam('JSON of plain, visible values (no getters, holes or hidden properties)');
  }
  spend(budget, first ? 0 : 1);
  return plainJson(property.value, depth + 1, budget);
}

/** `depth` counts the containers around this one: at most 16 levels in all. */
function plainContainer(value: object, depth: number, budget: Budget): unknown {
  if (depth >= MAX_JSON_WRITE_DEPTH) {
    throw badParam(`JSON nested at most ${MAX_JSON_WRITE_DEPTH} deep`);
  }
  if (types.isProxy(value)) {
    throw badParam('JSON without proxies');
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_JSON) {
      throw badParam('plain JSON arrays of at most 8192 elements');
    }
    if (Object.getOwnPropertySymbols(value).length > 0 || Object.getOwnPropertyNames(value).length !== value.length + 1) {
      throw badParam('plain JSON arrays without holes or extra properties');
    }
    return Array.from({ length: value.length }, (_v, i) => plainProperty(value, String(i), i === 0, depth, budget));
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw badParam('plain JSON objects only (no class instances, dates, maps or byte arrays)');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw badParam('JSON without symbol keys');
  }
  const out = Object.create(null) as Record<string, unknown>; // a "__proto__" key stays a key
  Object.getOwnPropertyNames(value).forEach((name, i) => {
    if (!PRINTABLE.test(name)) {
      throw badParam('JSON keys of printable ASCII only');
    }
    spend(budget, name.length + 3); // the quotes and the colon
    out[name] = plainProperty(value, name, i === 0, depth, budget);
  });
  return out;
}

/** A JSON column's text: plain data, bigints as text, at most 8192 characters, and no secret in it. */
export function jsonParam(v: unknown): string {
  const text = JSON.stringify(plainJson(v, 0, { left: MAX_JSON })) as string;
  if (text.length > MAX_JSON) {
    throw badParam(`JSON of at most ${MAX_JSON} characters`);
  }
  return noSecret(text, 'JSON');
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

/**
 * Takes everything jsonCell reads, and more: printable ASCII, 1-8192 characters, valid JSON
 * (json_valid also caps nesting at 1000). jsonCell then takes only jsonParam's exact form.
 */
export function json(c: string): string {
  const n = column(c);
  return `(${ascii(n)} AND length(${n}) BETWEEN 1 AND ${MAX_JSON} AND ${n} NOT GLOB '*[^ -~]*' AND json_valid(${n}))`;
}

/** Column `a` is no larger than column `b`, both canonical u64 text (their own checks): compared by length, then as text. */
export function u64NotAbove(a: string, b: string): string {
  const x = column(a);
  const y = column(b);
  return `(length(${x}) < length(${y}) OR (length(${x}) = length(${y}) AND ${x} <= ${y}))`;
}

/** = u64 and at most `bound`: canonical text of equal length compares like the number. */
export function u64AtMost(c: string, bound: bigint): string {
  const n = column(c);
  if (typeof bound !== 'bigint' || bound < 0n || bound > U64_MAX) {
    throw new StorageError('bad-sql', 'u64AtMost needs a bound from 0 to 2^64-1');
  }
  const b = bound.toString(10);
  return `(${u64(n)} AND (length(${n}) < ${b.length} OR (length(${n}) = ${b.length} AND ${n} <= '${b}')))`;
}
