// The one place stored text and integers turn into amounts, times, slots and codes (STORAGE_DESIGN.md
// s.1.2; RISK_POLICY invariant 7): readers refuse anything non-canonical with the column name and
// never the value; writers refuse anything out of range; each SQL CHECK fragment is built from a
// plain column name only. The agreement with the SQL side is in tests/property/storage.
// Written before src/storage/codec.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TIMESTAMP_MS } from '../../../src/core/time.ts';
import { U64_MAX } from '../../../src/core/units.ts';
import {
  amountParam,
  bool,
  boolCell,
  boolParam,
  code,
  codeCell,
  codeParam,
  day,
  dayCell,
  dayParam,
  hex64,
  hex64Cell,
  hex64Param,
  id,
  idCell,
  idParam,
  int,
  intCell,
  intParam,
  lamportsCell,
  lamportsCellOrNull,
  ms,
  msCell,
  msCellOrNull,
  msOrNull,
  msParam,
  signed,
  signedCell,
  signedParam,
  slot,
  slotCell,
  slotParam,
  tokenUnitsCell,
  u64,
  u64OrNull,
} from '../../../src/storage/codec.ts';
import type { Row, SqlCell } from '../../../src/storage/sqlite.ts';
import { memDb, storageError } from './helpers.ts';

const row = (cell: SqlCell): Row => Object.freeze({ v: cell });
const HEX = 'ab'.repeat(32);

describe('cell readers: canonical values only, the column named, the value never echoed', () => {
  it('amounts: canonical decimal text of a u64 (lamports, token units) or a signed amount within +-u64', () => {
    assert.equal(lamportsCell(row('0'), 'v'), 0n);
    assert.equal(lamportsCell(row('18446744073709551615'), 'v'), U64_MAX);
    assert.equal(tokenUnitsCell(row('1000000'), 'v'), 1_000_000n);
    assert.equal(signedCell(row('-18446744073709551615'), 'v'), -U64_MAX);
    assert.equal(signedCell(row('42'), 'v'), 42n);
    assert.equal(lamportsCellOrNull(row(null), 'v'), null);
    assert.equal(lamportsCellOrNull(row('5'), 'v'), 5n);
    for (const bad of ['', '01', '-0', '-1', '1.5', '1e3', ' 1', '18446744073709551616', '١', 'x', '1\u0000']) {
      const e = storageError(() => lamportsCell(row(bad), 'amount_in'), 'bad-cell');
      assert.match(e.detail, /amount_in/);
      storageError(() => tokenUnitsCell(row(bad), 'v'), 'bad-cell');
      storageError(() => lamportsCellOrNull(row(bad), 'v'), 'bad-cell');
    }
    for (const bad of ['-0', '-01', '--1', '+1', '-18446744073709551616']) {
      storageError(() => signedCell(row(bad), 'v'), 'bad-cell');
    }
    // the wrong storage type: an INTEGER where text belongs, bytes, NULL
    for (const bad of [5n, new Uint8Array([1]), null] as SqlCell[]) {
      storageError(() => lamportsCell(row(bad), 'v'), 'bad-cell');
      storageError(() => signedCell(row(bad), 'v'), 'bad-cell');
    }
    storageError(() => lamportsCellOrNull(row(5n), 'v'), 'bad-cell');
  });

  it('a reader never puts the stored value into its error (the database is not trusted to be clean)', () => {
    const secret = 'api_key=SECRET1234567890';
    for (const read of [lamportsCell, signedCell, idCell, codeCell, dayCell, hex64Cell]) {
      const e = storageError(() => read(row(secret), 'v'), 'bad-cell');
      assert.doesNotMatch(`${e.message} ${e.detail} ${String(e.stack)}`, /SECRET/);
    }
  });

  it('a missing column is a bad cell too (a query that forgot it), not undefined', () => {
    storageError(() => lamportsCell(row('1'), 'other'), 'bad-cell');
    storageError(() => msCell(row(1n), 'other'), 'bad-cell');
    const inherited = Object.freeze(Object.assign(Object.create({ v: '1' }) as Record<string, SqlCell>, {}));
    storageError(() => lamportsCell(inherited, 'v'), 'bad-cell');
  });

  it('timestamps: INTEGER milliseconds from 0 to 2200-01-01', () => {
    assert.equal(msCell(row(0n), 'v'), 0);
    assert.equal(msCell(row(BigInt(MAX_TIMESTAMP_MS)), 'v'), MAX_TIMESTAMP_MS);
    assert.equal(msCellOrNull(row(null), 'v'), null);
    assert.equal(msCellOrNull(row(5n), 'v'), 5);
    for (const bad of [-1n, BigInt(MAX_TIMESTAMP_MS) + 1n, 2n ** 62n, '5', null] as SqlCell[]) {
      storageError(() => msCell(row(bad), 'v'), 'bad-cell');
    }
    storageError(() => msCellOrNull(row('5'), 'v'), 'bad-cell');
  });

  it('whole numbers in a range, slots (INTEGER >= 0) and booleans (0 or 1 only)', () => {
    assert.equal(intCell(row(-3n), 'v', -5, 5), -3);
    assert.equal(intCell(row(5n), 'v', -5, 5), 5);
    for (const bad of [6n, -6n, '1', null] as SqlCell[]) {
      storageError(() => intCell(row(bad), 'v', -5, 5), 'bad-cell');
    }
    for (const [min, max] of [[1.5, 2], [0, Number.MAX_SAFE_INTEGER + 1], [3, 2], [Number.NaN, 1]] as [number, number][]) {
      storageError(() => intCell(row(1n), 'v', min, max), 'bad-option');
    }
    assert.equal(slotCell(row(0n), 'v'), 0n);
    assert.equal(slotCell(row(2n ** 63n - 1n), 'v'), 2n ** 63n - 1n);
    for (const bad of [-1n, '5', null] as SqlCell[]) {
      storageError(() => slotCell(row(bad), 'v'), 'bad-cell');
    }
    assert.equal(boolCell(row(0n), 'v'), false);
    assert.equal(boolCell(row(1n), 'v'), true);
    for (const bad of [2n, -1n, '1', 'true', null] as SqlCell[]) {
      storageError(() => boolCell(row(bad), 'v'), 'bad-cell');
    }
  });

  it('ids, codes, calendar days and sha256 hex', () => {
    assert.equal(idCell(row('Mint_A-1'), 'v'), 'Mint_A-1');
    assert.equal(idCell(row('x'.repeat(128)), 'v'), 'x'.repeat(128));
    for (const bad of ['', 'x'.repeat(129), 'a b', 'a.b', 'a/b', 'é', 'a\u0000']) {
      storageError(() => idCell(row(bad), 'v'), 'bad-cell');
    }
    assert.equal(codeCell(row('storage-busy'), 'v'), 'storage-busy');
    assert.equal(codeCell(row(`a${'b'.repeat(63)}`), 'v'), `a${'b'.repeat(63)}`);
    for (const bad of ['', '-x', ':x', '.x', '_x', 'Upper', 'a b', `a${'b'.repeat(64)}`, 'a\u0000']) {
      storageError(() => codeCell(row(bad), 'v'), 'bad-cell');
    }
    assert.equal(dayCell(row('2026-11-13'), 'v'), '2026-11-13');
    assert.equal(dayCell(row('2024-02-29'), 'v'), '2024-02-29');
    for (const bad of ['2026-02-29', '2026-13-01', '2026-11-31', '0099-12-31', '2026-1-13', '2026-11-13T00', '']) {
      storageError(() => dayCell(row(bad), 'v'), 'bad-cell');
    }
    assert.equal(hex64Cell(row(HEX), 'v'), HEX);
    for (const bad of [HEX.toUpperCase(), HEX.slice(1), `${HEX}0`, `${HEX.slice(1)}g`]) {
      storageError(() => hex64Cell(row(bad), 'v'), 'bad-cell');
    }
  });
});

describe('parameter writers: canonical out, anything out of range refused', () => {
  it('amounts as canonical text, timestamps, whole numbers, slots and booleans as INTEGER bigints', () => {
    assert.equal(amountParam(0n), '0');
    assert.equal(amountParam(U64_MAX), '18446744073709551615');
    assert.equal(signedParam(-U64_MAX), '-18446744073709551615');
    assert.equal(msParam(MAX_TIMESTAMP_MS), BigInt(MAX_TIMESTAMP_MS));
    assert.equal(intParam(-7), -7n);
    assert.equal(slotParam(2n ** 63n - 1n), 2n ** 63n - 1n);
    assert.equal(boolParam(true), 1n);
    assert.equal(boolParam(false), 0n);
    for (const bad of [-1n, U64_MAX + 1n, 5 as unknown as bigint]) {
      storageError(() => amountParam(bad), 'bad-param');
    }
    for (const bad of [U64_MAX + 1n, -U64_MAX - 1n, '5' as unknown as bigint]) {
      storageError(() => signedParam(bad), 'bad-param');
    }
    for (const bad of [-1, 1.5, MAX_TIMESTAMP_MS + 1, Number.NaN, 5n as unknown as number]) {
      storageError(() => msParam(bad), 'bad-param');
    }
    for (const bad of [1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, 5n as unknown as number]) {
      storageError(() => intParam(bad), 'bad-param');
    }
    for (const bad of [-1n, 2n ** 63n, 5 as unknown as bigint]) {
      storageError(() => slotParam(bad), 'bad-param');
    }
    storageError(() => boolParam(1 as unknown as boolean), 'bad-param');
  });

  it('ids, codes, days and hex are checked the same way as on read; free text has no writer', () => {
    assert.equal(idParam('Mint_A-1'), 'Mint_A-1');
    assert.equal(codeParam('sizing:no-live-price'), 'sizing:no-live-price');
    assert.equal(dayParam('2026-11-13'), '2026-11-13');
    assert.equal(hex64Param(HEX), HEX);
    storageError(() => idParam('a b'), 'bad-param');
    storageError(() => codeParam('Free text, not a code'), 'bad-param');
    storageError(() => dayParam('2026-02-30'), 'bad-param');
    storageError(() => hex64Param(HEX.toUpperCase()), 'bad-param');
    for (const write of [idParam, codeParam, dayParam, hex64Param]) {
      storageError(() => write(7 as unknown as string), 'bad-param');
      const e = storageError(() => write('api_key=SECRET1234567890'), 'bad-param');
      assert.doesNotMatch(`${e.message} ${e.detail}`, /SECRET/);
    }
  });
});

describe('SQL CHECK fragments', () => {
  it('are built from a plain lower-case column name only (no SQL can be smuggled in through a fragment)', () => {
    for (const make of [u64, u64OrNull, signed, ms, msOrNull, slot, bool, id, code, day, hex64]) {
      assert.match(make('amount_in'), /amount_in/);
      for (const bad of ['', 'Amount', '1a', 'a b', "a') OR 1=1 --", 'a;b', 'x'.repeat(64)]) {
        storageError(() => make(bad), 'bad-sql');
      }
    }
    assert.equal(int('n', -5, 5), "(typeof(n) = 'integer' AND n BETWEEN -5 AND 5)");
    storageError(() => int('n', 5, -5), 'bad-sql');
    storageError(() => int('n', 0.5, 1), 'bad-sql');
    storageError(() => int('N', 0, 1), 'bad-sql');
  });

  it('are plain ASCII on one line and the timestamp bound comes from core/time', () => {
    for (const make of [u64, u64OrNull, signed, ms, msOrNull, slot, bool, id, code, day, hex64]) {
      assert.match(make('c'), /^[\x20-\x7e]+$/);
    }
    assert.ok(ms('c').includes(String(MAX_TIMESTAMP_MS)));
  });

  it('pin the storage class, so they hold outside a STRICT table too: text, an integer, a float or bytes in the wrong kind of column are refused (review O)', () => {
    const db = memDb();
    try {
      // the same value in the wrong storage class: an integer, a float or bytes for a TEXT kind; text, a
      // float or bytes for an INTEGER kind (without the typeof guard, text and bytes compare above every
      // number, so slot >= 0 took them, and 5.0 passed BETWEEN and 1.0 passed IN (0, 1))
      const textWrong = ['5', '5.0', "CAST('5' AS BLOB)", "x'35'"];
      const integerWrong = ["'5'", '5.0', '1.0', "CAST('5' AS BLOB)", "x'01'"];
      const kinds: [string, string, readonly string[]][] = [
        [u64('v'), "'5'", textWrong],
        [signed('v'), "'5'", textWrong],
        [id('v'), "'5'", textWrong],
        [code('v'), "'5'", textWrong],
        [day('v'), "'2026-11-13'", textWrong],
        [hex64('v'), `'${HEX}'`, textWrong],
        [ms('v'), '5', integerWrong],
        [slot('v'), '5', integerWrong],
        [bool('v'), '1', integerWrong],
        [int('v', -5, 5), '1', integerWrong],
      ];
      kinds.forEach(([fragment, good, wrong], i) => {
        const table = `loose_${i}`; // no STRICT and no declared type: SQLite stores each value as given
        db.transaction((tx) => tx.script(`CREATE TABLE ${table} (v CHECK ${fragment});`));
        db.transaction((tx) => tx.run(`INSERT INTO ${table} (v) VALUES (${good})`));
        for (const value of wrong) {
          storageError(() => db.transaction((tx) => tx.run(`INSERT INTO ${table} (v) VALUES (${value})`)), 'constraint');
        }
      });
    } finally {
      db.close();
    }
  });

  it('work in a STRICT table on the bundled SQLite (smoke test; the full agreement is a property test)', () => {
    const db = memDb();
    try {
      db.transaction((tx) =>
        tx.script(
          `CREATE TABLE f (a TEXT NOT NULL CHECK ${u64('a')}, s TEXT NOT NULL CHECK ${signed('s')}, t INTEGER NOT NULL CHECK ${ms('t')},` +
            ` o TEXT CHECK ${u64OrNull('o')}, m INTEGER CHECK ${msOrNull('m')}, b INTEGER NOT NULL CHECK ${bool('b')},` +
            ` k INTEGER NOT NULL CHECK ${slot('k')}, i TEXT NOT NULL CHECK ${id('i')}, c TEXT NOT NULL CHECK ${code('c')},` +
            ` d TEXT NOT NULL CHECK ${day('d')}, h TEXT NOT NULL CHECK ${hex64('h')}, n INTEGER NOT NULL CHECK ${int('n', -5, 5)}) STRICT`,
        ),
      );
      const insert = 'INSERT INTO f (a, s, t, o, m, b, k, i, c, d, h, n) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
      const good = [amountParam(7n), signedParam(-7n), msParam(1), null, null, boolParam(true), slotParam(9n), idParam('x'), codeParam('ok'), dayParam('2026-11-13'), hex64Param(HEX), intParam(-5)];
      db.transaction((tx) => tx.run(insert, ...good));
      const r = db.get('SELECT * FROM f');
      assert.ok(r !== undefined);
      assert.equal(lamportsCell(r, 'a'), 7n);
      assert.equal(signedCell(r, 's'), -7n);
      assert.equal(msCell(r, 't'), 1);
      assert.equal(lamportsCellOrNull(r, 'o'), null);
      assert.equal(msCellOrNull(r, 'm'), null);
      assert.equal(boolCell(r, 'b'), true);
      assert.equal(slotCell(r, 'k'), 9n);
      assert.equal(idCell(r, 'i'), 'x');
      assert.equal(codeCell(r, 'c'), 'ok');
      assert.equal(dayCell(r, 'd'), '2026-11-13');
      assert.equal(hex64Cell(r, 'h'), HEX);
      assert.equal(intCell(r, 'n', -5, 5), -5);
      const bad: [number, unknown][] = [[0, '01'], [1, '-0'], [2, -1n], [3, 'x'], [4, BigInt(MAX_TIMESTAMP_MS) + 1n], [5, 2n], [6, -1n], [7, 'a b'], [8, 'X'], [9, '2026-02-30'], [10, HEX.toUpperCase()], [11, 6n]];
      for (const [index, value] of bad) {
        const params = [...good];
        params[index] = value as string;
        storageError(() => db.transaction((tx) => tx.run(insert, ...params)), 'constraint');
      }
    } finally {
      db.close();
    }
  });
});
