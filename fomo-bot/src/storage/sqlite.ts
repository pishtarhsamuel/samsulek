// The only file that talks to node:sqlite (STORAGE_DESIGN.md s.1.1; architecture rule). Everything
// else gets a Db: reads outside a transaction, and one synchronous all-or-nothing transaction() as
// the only way to write. Facts it relies on are in VERIFIED_FACTS.md (node:sqlite rows):
// - a JS number binds as REAL and a boolean as 1, a missing parameter as NULL, and prepare() drops
//   everything after the first statement without a word, so parameters are checked one by one,
//   counted against the ? placeholders, and SQL is one statement without a semicolon;
// - a flag PRAGMA takes effect when it is prepared, before it runs, so the first word of every
//   statement is checked before SQLite sees it, and scripts may not name PRAGMA at all;
// - after SQLITE_FULL (and IOERR, BUSY, NOMEM) SQLite may roll the whole transaction back itself;
//   the next statement would then run and be saved on its own, so every statement first checks
//   that the transaction is still open;
// - INSERT OR REPLACE deletes a conflicting row without firing delete triggers unless
//   recursive_triggers is on, so it is on (the append-only tables rely on their delete triggers).
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** What may be bound: no `number` (it would be stored as a float), no boolean, no undefined. */
export type SqlParam = string | bigint | null | Uint8Array;
/** What a cell may hold: a REAL cell (a JS number) is refused on read. */
export type SqlCell = string | bigint | null | Uint8Array;
export type Row = Readonly<Record<string, SqlCell>>;

export type StorageErrorCode =
  | 'busy'
  | 'full'
  | 'io'
  | 'corrupt'
  | 'not-a-database'
  | 'readonly'
  | 'constraint'
  | 'async-in-transaction'
  | 'nested-transaction'
  | 'tx-closed'
  | 'tx-failed'
  | 'poisoned'
  | 'closed'
  | 'bad-param'
  | 'bad-cell'
  | 'bad-sql'
  | 'bad-option'
  | 'pragma'
  | 'foreign-file'
  | 'missing'
  | 'schema-edited'
  | 'schema-newer'
  | 'schema-broken'
  | 'other';

const MAX_DETAIL = 200;

/** Printable ASCII, at most 200 characters: a detail can travel into a log line or a Telegram reply. */
function cleanDetail(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0); // a character outside the BMP starts with a surrogate: not printable
    if (code >= 0x20 && code <= 0x7e) {
      out += ch;
    } else {
      out += code === 0x0a || code === 0x09 ? ' ' : '?';
    }
    if (out.length > MAX_DETAIL) {
      return `${out.slice(0, MAX_DETAIL - 3)}...`;
    }
  }
  return out;
}

/**
 * Every storage failure. `detail` is SQLite's own text (a constraint name, a RAISE message, "database
 * is locked") or a fixed sentence of this module, and `sqliteCode` is SQLite's extended result code.
 * The detail carries no bound or stored value only while two rules hold, because SQLite puts what it
 * evaluates into its text: every trigger's RAISE message is one quoted literal, and JSON paths are
 * written into the SQL, never bound (both to be checked over the migrations in step 6c; review O).
 * It must reach a log or Telegram only through the redactor (core/redact.ts, step 6c).
 */
export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly detail: string;
  readonly sqliteCode: number | null;

  constructor(code: StorageErrorCode, detail: string, sqliteCode: number | null = null) {
    const clean = cleanDetail(detail);
    super(`storage ${code}: ${clean}`);
    this.name = 'StorageError';
    this.code = code;
    this.detail = clean;
    this.sqliteCode = sqliteCode;
  }
}

/** SQLite primary result codes (the low byte of the extended code) and what they mean here. */
const PRIMARY: Readonly<Record<number, StorageErrorCode>> = {
  5: 'busy', // SQLITE_BUSY: another connection holds the write lock past the busy timeout
  6: 'busy', // SQLITE_LOCKED
  8: 'readonly',
  10: 'io', // SQLITE_IOERR
  11: 'corrupt',
  13: 'full',
  14: 'io', // SQLITE_CANTOPEN
  19: 'constraint',
  18: 'bad-param', // SQLITE_TOOBIG: a value above the size limit
  26: 'not-a-database',
};

function storageErrorOf(e: unknown): StorageError {
  const fields = typeof e === 'object' && e !== null ? (e as { code?: unknown; errcode?: unknown; message?: unknown }) : {};
  const message = typeof fields.message === 'string' ? fields.message : String(e);
  if (fields.code === 'ERR_SQLITE_ERROR' && typeof fields.errcode === 'number') {
    return new StorageError(PRIMARY[fields.errcode & 0xff] ?? 'other', message, fields.errcode);
  }
  if (fields.code === 'ERR_INVALID_STATE') {
    return new StorageError('closed', message); // "database is not open", "statement has been finalized"
  }
  return new StorageError('other', message);
}

function mapped<R>(fn: () => R): R {
  try {
    return fn();
  } catch (e) {
    throw storageErrorOf(e);
  }
}

// ---------------------------------------------------------------- statements

const MAX_SQL = 200_000;
const MAX_STATEMENTS = 500;

interface Shape {
  readonly first: string; // the first keyword, upper case
  readonly placeholders: number;
}

const badSql = (detail: string): StorageError => new StorageError('bad-sql', detail);

/** SQL is our own constant text: printable ASCII with LF line ends. Values go in parameters. */
function plainText(sql: unknown): string {
  if (typeof sql !== 'string' || sql.length === 0 || sql.length > MAX_SQL) {
    throw badSql(`SQL must be text of 1 to ${MAX_SQL} characters`);
  }
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql.charCodeAt(i);
    if (!(c === 0x09 || c === 0x0a || (c >= 0x20 && c <= 0x7e))) {
      throw badSql('SQL must be printable ASCII with LF line ends (values go in parameters)');
    }
  }
  return sql;
}

/**
 * One statement: no semicolon (prepare() would drop the rest silently), no comments, names quoted
 * with double quotes only, plain ? placeholders only (counted outside quotes). Quoted text may hold
 * anything.
 */
function shapeOf(sql: unknown): Shape {
  const text = plainText(sql);
  if (PRAGMA_FUNCTION.test(text)) {
    throw badSql('the pragma_ functions are not allowed: one of them (pragma_optimize) writes to the database');
  }
  let placeholders = 0;
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quote !== '') {
      quote = ch === quote ? '' : quote; // a doubled quote closes and reopens: still inside
      continue;
    }
    const next = text.charAt(i + 1);
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === ';') {
      throw badSql('one statement per call, written without a semicolon');
    } else if ((ch === '-' && next === '-') || (ch === '/' && next === '*')) {
      throw badSql('no comments in a statement');
    } else if (ch === '[' || ch === '`') {
      throw badSql('quote names with double quotes only');
    } else if (ch === ':' || ch === '@' || ch === '$' || ch === '#' || (ch === '?' && next >= '0' && next <= '9')) {
      throw badSql('use plain ? placeholders'); // SQLite reads :a @a $a #a ?1 as parameters (review O)
    } else if (ch === '?') {
      placeholders += 1;
    }
  }
  if (quote !== '') {
    throw badSql('a quote is not closed');
  }
  const first = /^\s*([A-Za-z]+)/.exec(text)?.[1];
  if (first === undefined) {
    throw badSql('a statement starts with a keyword');
  }
  return { first: first.toUpperCase(), placeholders };
}

/**
 * The pragma_* table functions, anywhere in the text (quoted names included): reading most of them is
 * harmless, but `SELECT ... FROM pragma_optimize(65538)` runs ANALYZE (security-auditor, review O).
 */
const PRAGMA_FUNCTION = /pragma_/i;

/**
 * What a migration script may not contain: transaction control (BEGIN as a statement, as opposed to
 * a trigger body, which always has a statement after it; END TRANSACTION; a lone END is caught after
 * the script), settings and the pragma_ functions, other files, VACUUM, and comments (a comment
 * between BEGIN and its semicolon hid the BEGIN; review O). Notes belong in the TypeScript around it.
 */
const SCRIPT_FORBIDDEN =
  /\b(?:COMMIT|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA|ATTACH|DETACH|VACUUM)\b|\bBEGIN\s*(?:;|$|(?:TRANSACTION|DEFERRED|IMMEDIATE|EXCLUSIVE)\b)|\bEND\s+TRANSACTION\b|--|\/\*/i;

/** The text with the inside of the chosen kinds of quotes blanked; both kinds are tracked, so neither hides in the other. */
function blankQuoted(text: string, blank: ReadonlySet<string>): string {
  let out = '';
  let quote = '';
  for (const ch of text) {
    if (quote === '') {
      quote = ch === "'" || ch === '"' ? ch : '';
      out += ch;
    } else if (ch === quote) {
      quote = ''; // a doubled quote closes and reopens: still inside
      out += ch;
    } else {
      out += blank.has(quote) ? ' ' : ch;
    }
  }
  return out;
}

const BOTH_QUOTES: ReadonlySet<string> = new Set(["'", '"']);

/**
 * Keywords and comments count only outside quotes (the value 'rollback' of a config source is
 * data). Names in [brackets] or `backticks` are refused: a quote inside one would put the quote
 * tracking out of step with SQLite and hide what follows. pragma_ is refused anywhere in the raw
 * text: SQLite reads even a single-quoted word as a name where a name belongs, so
 * 'pragma_optimize'(65538) runs ANALYZE (security-auditor, review P).
 */
function scriptText(sql: unknown): string {
  const text = plainText(sql);
  const bare = blankQuoted(text, BOTH_QUOTES);
  if (SCRIPT_FORBIDDEN.test(bare) || /[[`]/.test(bare) || PRAGMA_FUNCTION.test(text)) {
    throw badSql('a script may not control transactions, change settings, attach files, vacuum, carry comments or quote names with [ or `');
  }
  return text;
}

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

function checkParams(params: readonly unknown[], placeholders: number): void {
  if (params.length !== placeholders) {
    throw new StorageError('bad-param', `the statement has ${placeholders} placeholders but got ${params.length} parameters`);
  }
  for (let i = 0; i < params.length; i += 1) {
    const p = params[i];
    const ok = typeof p === 'string' || p === null || p instanceof Uint8Array || (typeof p === 'bigint' && p >= I64_MIN && p <= I64_MAX);
    if (!ok) {
      const what = typeof p === 'bigint' ? 'a bigint beyond 64 bits' : typeof p;
      throw new StorageError('bad-param', `parameter ${i + 1} must be text, a 64-bit bigint, null or bytes, not ${what}`);
    }
  }
}

function rowOf(raw: Record<string, unknown>): Row {
  const row = Object.create(null) as Record<string, SqlCell>;
  for (const key of Object.keys(raw)) {
    const cell = raw[key];
    if (typeof cell === 'string' || typeof cell === 'bigint' || cell === null || cell instanceof Uint8Array) {
      row[key] = cell;
    } else {
      const what = typeof cell === 'number' ? 'a REAL (floating-point) value' : `a ${typeof cell}`;
      throw new StorageError('bad-cell', `column ${key} holds ${what}; amounts are TEXT and counts INTEGER`);
    }
  }
  return Object.freeze(row);
}

// ---------------------------------------------------------------- the handle

export interface Reader {
  get(sql: string, ...params: SqlParam[]): Row | undefined;
  all(sql: string, ...params: SqlParam[]): readonly Row[];
}

export interface Tx extends Reader {
  /** One INSERT, UPDATE or DELETE; returns the number of rows it changed. */
  run(sql: string, ...params: SqlParam[]): number;
  /** Several DDL statements: storage/migrations.ts only (architecture rule). */
  script(sql: string): void;
}

/** A promise is not allowed as the result of a transaction: nothing may wait between BEGIN and COMMIT. */
export type NotPromise<T> = T extends PromiseLike<unknown> ? never : T;

export interface Db extends Reader {
  /** ':memory:' or an absolute path. */
  readonly file: string;
  readonly readOnly: boolean;
  /**
   * BEGIN IMMEDIATE, the callback, COMMIT. Any throw out of the callback, a returned promise, or any
   * statement of the tx that threw (even if the callback caught it) rolls everything back.
   */
  transaction<T>(fn: (tx: Tx) => NotPromise<T>): NotPromise<T>;
  /** The safety settings as SQLite reports them now (diagnostics and tests; the pragma_ functions are refused). */
  settings(): Readonly<Record<string, SqlCell>>;
  /** [] when SQLite finds nothing wrong. */
  quickCheck(): readonly string[];
  foreignKeyCheck(): readonly string[];
  /** A consistent copy into a new file only the owner can read (never over an existing file). */
  vacuumInto(file: string): void;
  close(): void;
}

export interface OpenOptions {
  readonly busyTimeoutMs: number; // 5_000 in the bot; 100-200 in tests
  readonly create: boolean; // false: a missing file is an error, never silently a new database
  readonly readOnly?: boolean; // CLI status
}

/** The calls the wrapper makes on a statement: node:sqlite's, or a test's stand-in. */
export interface Statement {
  run(...params: SqlParam[]): { readonly changes: number | bigint };
  get(...params: SqlParam[]): Record<string, unknown> | undefined;
  all(...params: SqlParam[]): Record<string, unknown>[];
  columns(): readonly { readonly name: string }[];
}

/** The calls the wrapper makes on a connection: node:sqlite's, or a test's stand-in. */
export interface Connection {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  readonly isTransaction: boolean;
  close(): void;
}

const DB_READ: ReadonlySet<string> = new Set(['SELECT']);
const TX_READ: ReadonlySet<string> = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
const TX_WRITE: ReadonlySet<string> = new Set(['INSERT', 'UPDATE', 'DELETE']);

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

interface TxState {
  open: boolean;
  /** The code of the first statement that threw: SQLite undoes only that statement, so the rest must not commit. */
  failed: string | null;
}

/** The settings openDb sets or relies on, read back at open and by settings(). */
const SETTINGS = [
  'journal_mode',
  'synchronous',
  'foreign_keys',
  'trusted_schema',
  'recursive_triggers',
  'ignore_check_constraints',
  'busy_timeout',
  'application_id',
] as const;

function readSettings(conn: Connection): Readonly<Record<string, SqlCell>> {
  const out = Object.create(null) as Record<string, SqlCell>;
  for (const name of SETTINGS) {
    out[name] = Object.values(conn.prepare(`PRAGMA ${name}`).get() as Record<string, SqlCell>)[0] as SqlCell; // each returns one row
  }
  return Object.freeze(out);
}

class SqliteDb implements Db {
  readonly file: string;
  readonly readOnly: boolean;
  readonly #conn: Connection;
  readonly #cache = new Map<string, { readonly stmt: Statement; readonly shape: Shape }>();
  #active = false;
  #poisoned = false;
  #closed = false;

  constructor(conn: Connection, file: string, readOnly: boolean) {
    this.#conn = conn;
    this.file = file;
    this.readOnly = readOnly;
  }

  #usable(): void {
    if (this.#closed) {
      throw new StorageError('closed', 'the database handle is closed');
    }
    if (this.#poisoned) {
      throw new StorageError('poisoned', 'a ROLLBACK failed or a transaction was broken earlier: restart the bot');
    }
  }

  #outside(what: string): void {
    this.#usable();
    if (this.#active) {
      throw new StorageError('nested-transaction', `${what} is not allowed inside a transaction (use the tx)`);
    }
  }

  /** Checks the text, the first word and the parameters before SQLite sees the statement, then prepares it once. */
  #statement(sql: unknown, allowed: ReadonlySet<string>, params: readonly unknown[]): Statement {
    const cached = typeof sql === 'string' ? this.#cache.get(sql) : undefined;
    const shape = cached?.shape ?? shapeOf(sql);
    if (!allowed.has(shape.first)) {
      throw badSql(`a ${shape.first} statement is not allowed here (only ${[...allowed].join(', ')})`);
    }
    checkParams(params, shape.placeholders);
    if (cached !== undefined) {
      return cached.stmt;
    }
    if (this.#cache.size >= MAX_STATEMENTS) {
      throw badSql(`more than ${MAX_STATEMENTS} different statements: SQL must be constant text, never built from values`);
    }
    const text = sql as string;
    const stmt = mapped(() => this.#conn.prepare(text));
    const names = stmt.columns().map((c) => c.name);
    if (new Set(names).size !== names.length) {
      throw badSql('two result columns share a name: one would silently replace the other');
    }
    this.#cache.set(text, { stmt, shape });
    return stmt;
  }

  get(sql: string, ...params: SqlParam[]): Row | undefined {
    this.#outside('a read on the handle');
    const stmt = this.#statement(sql, DB_READ, params);
    const raw = mapped(() => stmt.get(...params));
    return raw === undefined ? undefined : rowOf(raw);
  }

  all(sql: string, ...params: SqlParam[]): readonly Row[] {
    this.#outside('a read on the handle');
    const stmt = this.#statement(sql, DB_READ, params);
    return Object.freeze(mapped(() => stmt.all(...params)).map(rowOf));
  }

  /**
   * The transaction is still ours and whole: not ended, the handle healthy, no statement of it has
   * thrown, and SQLite still holds it.
   */
  #live(state: TxState): void {
    if (!state.open) {
      throw new StorageError('tx-closed', 'this transaction has ended: use the tx only inside its callback');
    }
    this.#usable();
    if (state.failed !== null) {
      throw new StorageError('tx-failed', `an earlier statement of this transaction failed (${state.failed}): nothing in it will be saved`);
    }
    if (!this.#holdsTransaction()) {
      throw new StorageError('tx-closed', 'SQLite no longer holds this transaction: nothing in it was saved');
    }
  }

  #holdsTransaction(): boolean {
    try {
      return this.#conn.isTransaction;
    } catch {
      return false;
    }
  }

  #tx(state: TxState): Tx {
    // SQLite undoes only the statement that failed (a CHECK, a trigger, a full disk) and may keep the
    // transaction open, so a callback that catches the error would commit the rest without it: any
    // throw marks the transaction failed, and every later statement and the commit are refused
    // (risk-guardian, review O).
    const guarded =
      <A extends unknown[], R>(op: (...args: A) => R) =>
      (...args: A): R => {
        this.#live(state);
        try {
          return op(...args);
        } catch (e) {
          state.failed = String((e as { code?: unknown }).code);
          throw e;
        }
      };
    const run = guarded((sql: string, ...params: SqlParam[]): number => {
      const stmt = this.#statement(sql, TX_WRITE, params);
      return Number(mapped(() => stmt.run(...params)).changes);
    });
    const get = guarded((sql: string, ...params: SqlParam[]): Row | undefined => {
      const stmt = this.#statement(sql, TX_READ, params);
      const raw = mapped(() => stmt.get(...params));
      return raw === undefined ? undefined : rowOf(raw);
    });
    const all = guarded((sql: string, ...params: SqlParam[]): readonly Row[] => {
      const stmt = this.#statement(sql, TX_READ, params);
      return Object.freeze(mapped(() => stmt.all(...params)).map(rowOf));
    });
    const script = guarded((sql: string): void => {
      const text = scriptText(sql);
      const before = mapped(() => readSettings(this.#conn));
      let failure: StorageError | null = null;
      try {
        this.#conn.exec(text);
      } catch (e) {
        failure = storageErrorOf(e);
      }
      // checked whether or not the script failed: an END in it commits what ran before, and an error
      // after that END does not undo it
      if (!this.#holdsTransaction()) {
        this.#poisoned = true;
        throw new StorageError('poisoned', 'a script ended the transaction itself: part of it may be saved');
      }
      // a script that changed a safety setting got past the text checks: nothing on this handle is trusted
      const after = mapped(() => readSettings(this.#conn));
      if (SETTINGS.some((name) => after[name] !== before[name])) {
        this.#poisoned = true;
        throw new StorageError('poisoned', 'a script changed a safety setting of the database');
      }
      if (failure !== null) {
        throw failure;
      }
    });
    return Object.freeze({ run, get, all, script });
  }

  #rollback(): void {
    try {
      if (this.#conn.isTransaction) {
        this.#conn.exec('ROLLBACK');
      }
    } catch {
      this.#poisoned = true; // every later call throws: the app latches entries off, alerts and exits
    }
  }

  transaction<T>(fn: (tx: Tx) => NotPromise<T>): NotPromise<T> {
    this.#outside('a transaction');
    if (this.readOnly) {
      throw new StorageError('readonly', 'this handle was opened read-only');
    }
    mapped(() => this.#conn.exec('BEGIN IMMEDIATE')); // waits up to the busy timeout, then 'busy'
    this.#active = true;
    const state: TxState = { open: true, failed: null };
    let committed = false;
    try {
      const out = fn(this.#tx(state));
      if (isThenable(out)) {
        out.then(undefined, () => undefined); // its later failure (a closed tx) is not an unhandled rejection
        throw new StorageError('async-in-transaction', 'the callback returned a promise: nothing may wait inside a transaction');
      }
      this.#live(state);
      try {
        this.#conn.exec('COMMIT');
      } catch (e) {
        // A deferred foreign key or a busy lock keeps the transaction open: rolled back below. If SQLite no
        // longer holds it (an I/O error during the commit), whether it reached the disk is unknown: the
        // handle is poisoned, so the app stops, restarts and reads the truth back (risk-guardian, review O).
        if (!this.#holdsTransaction()) {
          this.#poisoned = true;
        }
        throw storageErrorOf(e);
      }
      committed = true;
      return out;
    } finally {
      state.open = false;
      this.#active = false;
      if (!committed) {
        this.#rollback();
      }
    }
  }

  settings(): Readonly<Record<string, SqlCell>> {
    this.#outside('settings');
    return mapped(() => readSettings(this.#conn));
  }

  quickCheck(): readonly string[] {
    this.#outside('quickCheck');
    const rows = mapped(() => this.#conn.prepare('PRAGMA quick_check').all());
    const lines = rows
      .flatMap((r) => String(r['quick_check']).split('\n'))
      .map(cleanDetail)
      .filter((line) => line !== '');
    return Object.freeze(lines.length === 1 && lines[0] === 'ok' ? [] : lines);
  }

  foreignKeyCheck(): readonly string[] {
    this.#outside('foreignKeyCheck');
    const rows = mapped(() => this.#conn.prepare('PRAGMA foreign_key_check').all());
    return Object.freeze(
      rows.map((r) => cleanDetail(`${String(r['table'])}: row ${String(r['rowid'])} has no parent in ${String(r['parent'])} (constraint ${String(r['fkid'])})`)),
    );
  }

  vacuumInto(target: string): void {
    this.#outside('vacuumInto');
    const file = absolutePath(target, 'the copy');
    let fd: number;
    try {
      fd = openSync(file, 'wx', 0o600); // a new, empty, owner-only file: never over an existing one
    } catch (e) {
      throw new StorageError('io', `cannot create the copy file (${errnoOf(e)})`);
    }
    closeSync(fd);
    try {
      mapped(() => this.#conn.prepare('VACUUM INTO ?').run(file)); // SQLite fills an empty existing file
      syncFile(file); // on disk before anyone relies on it (risk-guardian, review O)
    } catch (e) {
      rmSync(file, { force: true }); // no partial copy that could pass for a good one
      throw e;
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    if (this.#active) {
      throw new StorageError('nested-transaction', 'close is not allowed inside a transaction');
    }
    this.#closed = true;
    this.#cache.clear();
    mapped(() => this.#conn.close());
  }
}

/** The errno name of a file-system error ("EEXIST"), never its message (which holds the path). */
function errnoOf(e: unknown): string {
  return String((e as { code?: unknown }).code);
}

function syncFile(file: string): void {
  try {
    const fd = openSync(file, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    throw new StorageError('io', `cannot write the copy to disk (${errnoOf(e)})`); // the errno, never the path (review O)
  }
}

const badOption = (detail: string): StorageError => new StorageError('bad-option', detail);

function absolutePath(file: unknown, what: string): string {
  if (typeof file !== 'string' || file.length === 0 || file.length > 4096 || file.includes('\0') || !path.isAbsolute(file)) {
    throw badOption(`${what} must be an absolute path`);
  }
  return file;
}

/**
 * Wraps a connection that is already open and set up. openDb() is how the bot opens a database; the
 * tests use this to put a stand-in connection under the wrapper (a ROLLBACK that fails, a full disk).
 * Only this file can make a real connection, so this hands nobody a way around the checks above.
 */
export function wrapConnection(conn: Connection, file: string, readOnly: boolean): Db {
  return new SqliteDb(conn, file, readOnly);
}

// ---------------------------------------------------------------- opening

/** PRAGMA application_id of every bot database: "FOMO" in ASCII. Another value means another program's file. */
export const APPLICATION_ID = 0x464f4d4f;
const MAX_BUSY_MS = 60_000;
/** SQLite's limit on any one string, blob or row (review O): far above any record, far below a runaway write. */
export const MAX_VALUE_BYTES = 1_048_576;

interface Opening {
  readonly busyTimeoutMs: number;
  readonly create: boolean;
  readonly readOnly: boolean;
}

function checkOpen(file: unknown, options: unknown, memory: boolean): Opening {
  if (typeof options !== 'object' || options === null) {
    throw badOption('openDb needs { busyTimeoutMs, create }');
  }
  const { busyTimeoutMs, create, readOnly = false } = options as { busyTimeoutMs?: unknown; create?: unknown; readOnly?: unknown };
  if (typeof busyTimeoutMs !== 'number' || !Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > MAX_BUSY_MS) {
    throw badOption(`busyTimeoutMs must be a whole number of milliseconds from 0 to ${MAX_BUSY_MS}`);
  }
  if (typeof create !== 'boolean' || typeof readOnly !== 'boolean') {
    throw badOption('create and readOnly are true or false');
  }
  if (readOnly && create) {
    throw badOption('a read-only handle never creates a file');
  }
  if (memory && (readOnly || !create)) {
    throw badOption("':memory:' is always a new, writable database");
  }
  if (!memory) {
    absolutePath(file, 'the database file');
  }
  return { busyTimeoutMs, create, readOnly };
}

/** The settings every handle must have; read back after they are set, so a silent refusal is caught. */
function setUp(conn: DatabaseSync, file: string, o: Opening, memory: boolean): void {
  if (!memory && !o.readOnly && process.platform !== 'win32') {
    try {
      chmodSync(file, 0o600); // before WAL starts: SQLite gives -wal and -shm the mode of the file
    } catch (e) {
      throw new StorageError('io', `cannot make the file readable by its owner only (${errnoOf(e)})`);
    }
  }
  const one = (sql: string): unknown => Object.values(conn.prepare(sql).get() as Record<string, unknown>)[0]; // each returns one row
  const appId = one('PRAGMA application_id');
  if (appId !== BigInt(APPLICATION_ID)) {
    if (appId !== 0n || one('SELECT count(*) AS n FROM sqlite_schema') !== 0n) {
      throw new StorageError('foreign-file', 'this SQLite file belongs to another program (its application id or its tables)');
    }
    if (!o.create) {
      throw new StorageError('missing', 'the file is not a bot database yet, and create is false');
    }
    conn.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
  }
  if (!o.readOnly) {
    conn.exec('PRAGMA journal_mode = WAL'); // kept in the file; a network share may refuse it (checked below)
  }
  conn.exec('PRAGMA synchronous = FULL'); // a commit survives a power cut
  conn.exec('PRAGMA trusted_schema = OFF');
  conn.exec('PRAGMA recursive_triggers = ON');
  const want: Readonly<Record<(typeof SETTINGS)[number], SqlCell>> = {
    journal_mode: memory ? 'memory' : 'wal',
    synchronous: 2n,
    foreign_keys: 1n,
    trusted_schema: 0n,
    recursive_triggers: 1n,
    ignore_check_constraints: 0n,
    busy_timeout: BigInt(o.busyTimeoutMs),
    application_id: BigInt(APPLICATION_ID),
  };
  const got = readSettings(conn);
  const wrong: string[] = SETTINGS.filter((name) => got[name] !== want[name]);
  if (conn.limits.length !== MAX_VALUE_BYTES) {
    wrong.push('the value size limit');
  }
  if (wrong.length > 0) {
    throw new StorageError('pragma', `the database refused these settings: ${wrong.join(', ')}`);
  }
}

/**
 * Opens the bot's database file (or ':memory:'), refusing a file of another program, a missing file
 * when create is false, and any setting SQLite does not confirm.
 */
export function openDb(file: string, options: OpenOptions): Db {
  const memory = file === ':memory:';
  const o = checkOpen(file, options, memory);
  if (!memory && !o.create && !existsSync(file)) {
    throw new StorageError('missing', 'the database file does not exist (create is false)');
  }
  const conn = mapped(
    () =>
      new DatabaseSync(file, {
        open: true,
        readOnly: o.readOnly,
        timeout: o.busyTimeoutMs,
        readBigInts: true,
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false,
        defensive: true,
        allowExtension: false,
        limits: { length: MAX_VALUE_BYTES },
      }),
  );
  try {
    setUp(conn, file, o, memory);
  } catch (e) {
    conn.close();
    throw e instanceof StorageError ? e : storageErrorOf(e);
  }
  return new SqliteDb(conn, file, o.readOnly);
}
