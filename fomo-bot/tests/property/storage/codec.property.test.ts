// Invariant 7 at the storage edge (STORAGE_DESIGN.md s.1.2 and s.5): every amount survives a round
// trip through a real column exactly, and for every column kind the SQL CHECK accepts exactly what
// the codec reads back, so the database and the code can never disagree about what a valid value
// is: random text with leading zeros, signs, spaces, exponents, Unicode digits, NUL characters and
// lengths around the limits, and random 64-bit integers around every bound. JSON is the one
// exception, on purpose (review P): its CHECK is a looser tripwire, and the reader takes only the
// writer's own form, so there the property is an implication plus a round trip.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { MAX_TIMESTAMP_MS } from '../../../src/core/time.ts';
import { U64_MAX } from '../../../src/core/units.ts';
import {
  amountParam,
  bool,
  boolCell,
  code,
  codeCell,
  day,
  dayCell,
  hex64,
  hex64Cell,
  id,
  idCell,
  int,
  intCell,
  json,
  jsonCell,
  jsonParam,
  lamportsCell,
  lamportsCellOrNull,
  ms,
  msCell,
  msCellOrNull,
  msOrNull,
  signed,
  signedCell,
  signedParam,
  slot,
  slotCell,
  tokenUnitsCell,
  u64,
  u64AtMost,
  u64NotAbove,
  u64OrNull,
} from '../../../src/storage/codec.ts';
import { StorageError, type Row, type SqlCell } from '../../../src/storage/sqlite.ts';
import { memDb } from '../../unit/storage/helpers.ts';

fc.configureGlobal({ numRuns: 1_000 }); // TEST_PLAN.md s.4 (this file's process only)

const db = memDb();
after(() => db.close());

type Kind = 'TEXT' | 'INTEGER';
interface Pair {
  readonly name: string;
  readonly kind: Kind;
  readonly fragment: string; // the CHECK built for column v
  readonly read: (r: Row) => unknown;
  readonly nullable: boolean;
  readonly valid: fc.Arbitrary<SqlCell>; // values the rule should take, so acceptance is exercised too
}

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
const charsFrom = (alphabet: string): fc.Arbitrary<string> => fc.constantFrom(...alphabet);
const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const CODE_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789:._-';
const HEX_CHARS = '0123456789abcdef';
const validDay = fc
  .date({ min: new Date(Date.UTC(100, 0, 1)), max: new Date(Date.UTC(9999, 11, 31)), noInvalidDate: true })
  .map((d) => d.toISOString().slice(0, 10));
const unsignedText = fc.bigInt({ min: 0n, max: U64_MAX }).map((v) => v.toString());
const signedText = fc.bigInt({ min: -U64_MAX, max: U64_MAX }).map((v) => v.toString());

const PAIRS: readonly Pair[] = [
  { name: 'u64', kind: 'TEXT', fragment: u64('v'), read: (r) => lamportsCell(r, 'v'), nullable: false, valid: unsignedText },
  { name: 'u64_tokens', kind: 'TEXT', fragment: u64('v'), read: (r) => tokenUnitsCell(r, 'v'), nullable: false, valid: unsignedText },
  { name: 'u64_or_null', kind: 'TEXT', fragment: u64OrNull('v'), read: (r) => lamportsCellOrNull(r, 'v'), nullable: true, valid: unsignedText },
  { name: 'signed', kind: 'TEXT', fragment: signed('v'), read: (r) => signedCell(r, 'v'), nullable: false, valid: signedText },
  {
    name: 'id',
    kind: 'TEXT',
    fragment: id('v'),
    read: (r) => idCell(r, 'v'),
    nullable: false,
    valid: fc.string({ unit: charsFrom(ID_CHARS), minLength: 1, maxLength: 128 }),
  },
  {
    name: 'code',
    kind: 'TEXT',
    fragment: code('v'),
    read: (r) => codeCell(r, 'v'),
    nullable: false,
    valid: fc.tuple(charsFrom(CODE_CHARS.slice(0, 36)), fc.string({ unit: charsFrom(CODE_CHARS), maxLength: 63 })).map(([a, b]) => a + b),
  },
  { name: 'day', kind: 'TEXT', fragment: day('v'), read: (r) => dayCell(r, 'v'), nullable: false, valid: validDay },
  {
    name: 'hex64',
    kind: 'TEXT',
    fragment: hex64('v'),
    read: (r) => hex64Cell(r, 'v'),
    nullable: false,
    valid: fc.string({ unit: charsFrom(HEX_CHARS), minLength: 64, maxLength: 64 }),
  },
  { name: 'ms', kind: 'INTEGER', fragment: ms('v'), read: (r) => msCell(r, 'v'), nullable: false, valid: fc.bigInt({ min: 0n, max: BigInt(MAX_TIMESTAMP_MS) }) },
  {
    name: 'ms_or_null',
    kind: 'INTEGER',
    fragment: msOrNull('v'),
    read: (r) => msCellOrNull(r, 'v'),
    nullable: true,
    valid: fc.bigInt({ min: 0n, max: BigInt(MAX_TIMESTAMP_MS) }),
  },
  { name: 'slot', kind: 'INTEGER', fragment: slot('v'), read: (r) => slotCell(r, 'v'), nullable: false, valid: fc.bigInt({ min: 0n, max: I64_MAX }) },
  { name: 'bool', kind: 'INTEGER', fragment: bool('v'), read: (r) => boolCell(r, 'v'), nullable: false, valid: fc.constantFrom(0n, 1n) },
  {
    name: 'int_small',
    kind: 'INTEGER',
    fragment: int('v', -1000, 1000),
    read: (r) => intCell(r, 'v', -1000, 1000),
    nullable: false,
    valid: fc.bigInt({ min: -1000n, max: 1000n }),
  },
];

db.transaction((tx) => {
  for (const p of PAIRS) {
    tx.script(`CREATE TABLE ${p.name} (v ${p.kind}${p.nullable ? '' : ' NOT NULL'} CHECK ${p.fragment}) STRICT;`);
  }
  tx.script('CREATE TABLE amounts (u TEXT NOT NULL CHECK ' + u64('u') + ', s TEXT NOT NULL CHECK ' + signed('s') + ') STRICT;');
});

/** The SQL side: does the column take the value? (Only a CHECK or NOT NULL may refuse it.) */
function sqlAccepts(p: Pair, value: SqlCell): boolean {
  try {
    db.transaction((tx) => {
      tx.run(`INSERT INTO ${p.name} (v) VALUES (?)`, value);
      return tx.run(`DELETE FROM ${p.name}`);
    });
    return true;
  } catch (e) {
    assert.ok(e instanceof StorageError && e.code === 'constraint', `unexpected ${String(e)}`);
    return false;
  }
}

/** The code side: does the reader accept the same value as a stored cell? */
function codecAccepts(p: Pair, value: SqlCell): boolean {
  try {
    p.read(Object.freeze({ v: value }));
    return true;
  } catch (e) {
    assert.ok(e instanceof StorageError && e.code === 'bad-cell', `unexpected ${String(e)}`);
    return false;
  }
}

const DIGITS = '0123456789';
const SPECIAL_TEXT = [
  '', '0', '00', '01', '-0', '-00', '-01', '--1', '+1', ' 1', '1 ', '1e3', '1.5', '0x10', '1_000', '١', '０', '\u{1d7ce}',
  '18446744073709551615', '18446744073709551616', '18446744073709551614', '99999999999999999999', '100000000000000000000',
  '-18446744073709551615', '-18446744073709551616', '1\u0000', '1\u00002', '12\u0000abc', 'abc\u0000!!!', '\u0000', 'é',
  'a', 'A', 'storage-busy', '-x', 'x'.repeat(64), 'x'.repeat(65), 'a'.repeat(128), 'a'.repeat(129), 'a b', 'a.b', 'Mint_A-1',
  '2026-11-13', '2024-02-29', '2026-02-29', '2026-13-01', '0100-01-01', '0099-12-31', '9999-12-31', '2026-11-13\u0000',
  'ab'.repeat(32), 'AB'.repeat(32), `${'ab'.repeat(32)}\u0000`, `${'ab'.repeat(31)}a`, `${'ab'.repeat(32)}a`,
];

const textOf = (alphabet: string, maxLength: number): fc.Arbitrary<string> =>
  fc.string({ unit: fc.oneof({ weight: 12, arbitrary: charsFrom(alphabet) }, { weight: 1, arbitrary: charsFrom(' .-+e\u0000é١A/:') }), maxLength });

/** Text that is often almost right for every column kind. */
const nearText: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...SPECIAL_TEXT),
  fc.string({ unit: 'binary', maxLength: 24 }),
  fc.tuple(fc.constantFrom('', '', '', '-', '--', '+', ' ', '0'), textOf(DIGITS, 22), fc.constantFrom('', '', '', ' ', '\u0000', 'x', '.5')).map((p) => p.join('')),
  fc.bigInt({ min: 0n, max: U64_MAX + 10n }).map((v) => (U64_MAX - v).toString()),
  textOf('abcdefghijklmnopqrstuvwxyz0123456789:._-', 66),
  textOf('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-', 130),
  fc.tuple(textOf(DIGITS, 4), textOf(DIGITS, 2), textOf(DIGITS, 2), fc.constantFrom('', '', '', 'T', '\u0000', ' ')).map(([y, m, d, s]) => `${y.padStart(4, '0')}-${m.padStart(2, '0')}-${d.padStart(2, '0')}${s}`),
  fc.tuple(fc.integer({ min: 100, max: 9999 }), fc.integer({ min: 0, max: 13 }), fc.integer({ min: 0, max: 32 })).map(
    ([y, m, d]) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
  ),
  textOf('0123456789abcdef', 66),
  fc.tuple(textOf('0123456789abcdefABCDEF', 64), fc.constantFrom('', '', 'a', '\u0000', 'g')).map(([h, s]) => `${h.padEnd(64, 'a')}${s}`),
);

const SPECIAL_INT =[I64_MIN, -1001n, -1000n, -2n, -1n, 0n, 1n, 2n, 1000n, 1001n, BigInt(MAX_TIMESTAMP_MS) - 1n, BigInt(MAX_TIMESTAMP_MS), BigInt(MAX_TIMESTAMP_MS) + 1n, BigInt(Number.MAX_SAFE_INTEGER), I64_MAX];
const nearInt: fc.Arbitrary<bigint> = fc.oneof(
  fc.constantFrom(...SPECIAL_INT),
  fc.bigInt({ min: I64_MIN, max: I64_MAX }),
  fc.bigInt({ min: -1100n, max: 1100n }),
  fc.bigInt({ min: 0n, max: BigInt(MAX_TIMESTAMP_MS) + 1000n }),
);

describe('codec and SQL agree (invariant 7)', () => {
  for (const p of PAIRS) {
    it(`${p.name}: the column takes a value exactly when the codec reads it back`, () => {
      // every boundary value, every run (a random draw finds a length boundary only by chance)
      for (const value of [...(p.kind === 'TEXT' ? SPECIAL_TEXT : SPECIAL_INT), null]) {
        assert.equal(sqlAccepts(p, value), codecAccepts(p, value), `${p.name} disagrees on ${JSON.stringify(typeof value === 'bigint' ? `${value}n` : value)}`);
      }
      const seen = { accepted: 0, refused: 0 };
      const near: fc.Arbitrary<SqlCell> = p.kind === 'TEXT' ? nearText : nearInt;
      const values = fc.oneof({ weight: 15, arbitrary: near }, { weight: 5, arbitrary: p.valid }, { weight: 1, arbitrary: fc.constant(null) });
      fc.assert(
        fc.property(values, (value) => {
          const sql = sqlAccepts(p, value);
          assert.equal(sql, codecAccepts(p, value), `${p.name} disagrees on ${JSON.stringify(typeof value === 'bigint' ? `${value}n` : value)}`);
          seen[sql ? 'accepted' : 'refused'] += 1;
        }),
      );
      // non-vacuity: both sides of every rule were exercised
      assert.ok(seen.accepted >= 30, `${p.name}: only ${seen.accepted} accepted`);
      assert.ok(seen.refused >= 30, `${p.name}: only ${seen.refused} refused`);
    });
  }

  it('json: the column takes whatever the reader reads, the reader reads only what jsonParam writes, and that text comes back unchanged (review P)', () => {
    const p: Pair = { name: 'json_v', kind: 'TEXT', fragment: json('v'), read: (r) => jsonCell(r, 'v'), nullable: false, valid: fc.constant('{}') };
    const asciiJson = fc.json({ maxDepth: 4, stringUnit: 'grapheme-ascii' });
    // a valid document with one character dropped, doubled or replaced: mostly invalid, sometimes not
    const mutated = fc.tuple(asciiJson, fc.nat(), fc.constantFrom('', '"', ',', ']', '}', ' ', '\\', 'x', '0', '\u0000', 'é', '\t')).map(([text, at, ch]) => {
      const i = text.length === 0 ? 0 : at % text.length;
      return `${text.slice(0, i)}${ch}${text.slice(i + 1)}`;
    });
    const nested = fc.tuple(fc.integer({ min: 990, max: 1_010 }), fc.boolean()).map(([depth, array]) =>
      array ? `${'['.repeat(depth)}${']'.repeat(depth)}` : `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`,
    );
    const long = fc.integer({ min: 8_186, max: 8_196 }).map((n) => JSON.stringify('x'.repeat(n - 2)));
    const special = fc.constantFrom('', ' ', '01', '1.', '.5', 'NaN', "'a'", '{a:1}', '[1,]', '"\\ud800"', '"\\u0000"', '"\\x41"', 'true', ' null ', '1e400', '-0', '{"a":1,"a":2}');
    const values = fc.oneof(
      { weight: 6, arbitrary: asciiJson },
      { weight: 6, arbitrary: mutated },
      { weight: 2, arbitrary: fc.json({ maxDepth: 2, stringUnit: 'binary' }) },
      { weight: 2, arbitrary: nested },
      { weight: 2, arbitrary: long },
      { weight: 2, arbitrary: special },
      { weight: 1, arbitrary: fc.string({ unit: 'binary-ascii', maxLength: 12 }) },
    );
    db.transaction((tx) => tx.script(`CREATE TABLE ${p.name} (v TEXT NOT NULL CHECK ${p.fragment}) STRICT;`));
    // the CHECK on its own boundaries: printable ASCII, 1-8192 characters, valid JSON, nesting up to 1000
    const boundaries: [string, boolean][] = [
      [JSON.stringify('a '.repeat(4_095)), true], // 8,192 characters, the writer's longest text too
      [JSON.stringify(`${'a '.repeat(4_095)}a`), false], // 8,193
      [`${'['.repeat(1_000)}${']'.repeat(1_000)}`, true],
      [`${'['.repeat(1_001)}${']'.repeat(1_001)}`, false],
      [`${'{"a":'.repeat(1_000)}1${'}'.repeat(1_000)}`, true],
      [`${'{"a":'.repeat(1_001)}1${'}'.repeat(1_001)}`, false],
      ['"é"', false],
      ['"a\u0000"', false],
      ['{}', true],
      ['', false],
      ['{"a": 1}', true], // the CHECK takes it, the reader does not
    ];
    for (const [value, sql] of boundaries) {
      assert.equal(sqlAccepts(p, value), sql, `the CHECK on a boundary of ${value.length} characters`);
      assert.ok(!codecAccepts(p, value) || sql, `the reader takes what the column refuses (${value.length} characters)`);
    }
    assert.equal(codecAccepts(p, JSON.stringify('a '.repeat(4_095))), true);
    const seen = { read: 0, refused: 0, sqlOnly: 0, deep: 0 };
    fc.assert(
      fc.property(values, (value) => {
        const sql = sqlAccepts(p, value);
        const read = codecAccepts(p, value);
        assert.ok(!read || sql, `the reader takes what the column refuses: ${JSON.stringify(value.slice(0, 80))} (${value.length} characters)`);
        if (read) {
          assert.equal(jsonParam(jsonCell(Object.freeze({ v: value }), 'v')), value, 'what is read is written back as the same text');
        }
        seen[read ? 'read' : 'refused'] += 1;
        seen.sqlOnly += sql && !read ? 1 : 0;
        seen.deep += value.startsWith('[[[[[[[[[[') || value.startsWith('{"a":{"a":') ? 1 : 0;
      }),
    );
    assert.ok(seen.read >= 150 && seen.refused >= 200 && seen.sqlOnly >= 50 && seen.deep >= 30, JSON.stringify(seen));
    // the writer: plain values become text the column takes and the reader returns unchanged
    const written = { ok: 0, refused: 0 };
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 6, stringUnit: 'grapheme-ascii' }), (value) => {
        let text: string;
        try {
          text = jsonParam(value);
        } catch (e) {
          assert.ok(e instanceof StorageError && e.code === 'bad-param', `unexpected ${String(e)}`);
          written.refused += 1;
          return;
        }
        assert.ok(sqlAccepts(p, text), `the column refuses what jsonParam wrote: ${text.slice(0, 80)}`);
        const back = jsonCell(Object.freeze({ v: text }), 'v');
        assert.deepEqual(back, JSON.parse(text));
        assert.equal(jsonParam(back), text);
        written.ok += 1;
      }),
    );
    assert.ok(written.ok >= 500, JSON.stringify(written));
  });

  it('u64NotAbove: one canonical amount is no larger than another exactly when the numbers say so (a buy order\'s input and its max spend)', () => {
    db.transaction((tx) => tx.script(`CREATE TABLE not_above (a TEXT NOT NULL CHECK ${u64('a')}, b TEXT NOT NULL CHECK ${u64('b')}, CHECK ${u64NotAbove('a', 'b')}) STRICT;`));
    const takes = (a: bigint, b: bigint): boolean => {
      try {
        db.transaction((tx) => {
          tx.run('INSERT INTO not_above (a, b) VALUES (?, ?)', amountParam(a), amountParam(b));
          return tx.run('DELETE FROM not_above');
        });
        return true;
      } catch (e) {
        assert.ok(e instanceof StorageError && e.code === 'constraint', `unexpected ${String(e)}`);
        return false;
      }
    };
    const special = [0n, 1n, 9n, 10n, 11n, 99n, 100n, 70_000_000n, 70_000_001n, 10n ** 19n - 1n, 10n ** 19n, U64_MAX - 1n, U64_MAX];
    for (const a of special) {
      for (const b of special) {
        assert.equal(takes(a, b), a <= b, `${a} <= ${b}`);
      }
    }
    const amount = fc.oneof(fc.bigInt({ min: 0n, max: U64_MAX }), fc.bigInt({ min: 0n, max: 1_000n }), fc.constantFrom(...special));
    fc.assert(
      fc.property(amount, amount, fc.bigInt({ min: -2n, max: 2n }), (a, b, d) => {
        const near = b + d < 0n || b + d > U64_MAX ? b : b + d;
        assert.equal(takes(a, b), a <= b, `${a} <= ${b}`);
        assert.equal(takes(near, b), near <= b, `${near} <= ${b}`);
      }),
    );
  });

  it('u64AtMost: the column takes a canonical amount exactly when it is a u64 no larger than the bound', () => {
    const bounds = [0n, 1n, 9n, 10n, 70_000_000n, 99_999_999n, 10n ** 19n, U64_MAX];
    db.transaction((tx) => {
      bounds.forEach((bound, i) => tx.script(`CREATE TABLE at_most_${i} (v TEXT NOT NULL CHECK ${u64AtMost('v', bound)}) STRICT;`));
    });
    const seen = { accepted: 0, refused: 0 };
    const check = (i: number, value: string): void => {
      const bound = bounds[i] as bigint;
      const p: Pair = { name: `at_most_${i}`, kind: 'TEXT', fragment: '', read: (r) => lamportsCell(r, 'v'), nullable: false, valid: fc.constant('0') };
      const sql = sqlAccepts(p, value);
      const codec = codecAccepts(p, value) && BigInt(value) <= bound;
      assert.equal(sql, codec, `at most ${bound}: disagrees on ${JSON.stringify(value)}`);
      seen[sql ? 'accepted' : 'refused'] += 1;
    };
    bounds.forEach((bound, i) => {
      for (const value of [bound - 1n, bound, bound + 1n, bound * 10n, bound / 10n].filter((v) => v >= 0n).map(String)) {
        check(i, value);
      }
    });
    fc.assert(
      fc.property(fc.nat({ max: bounds.length - 1 }), fc.oneof(nearText, fc.bigInt({ min: 0n, max: U64_MAX }).map(String), fc.bigInt({ min: -2n, max: 2n })), (i, delta) => {
        check(i, typeof delta === 'bigint' ? ((bounds[i] as bigint) + delta).toString() : delta);
      }),
    );
    assert.ok(seen.accepted >= 100 && seen.refused >= 100, JSON.stringify(seen));
  });

  it('every u64 and every signed amount within +-u64 round-trips exactly through real columns', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: U64_MAX }), fc.bigInt({ min: -U64_MAX, max: U64_MAX }), (u, s) => {
        const back = db.transaction((tx) => {
          tx.run('DELETE FROM amounts');
          tx.run('INSERT INTO amounts (u, s) VALUES (?, ?)', amountParam(u), signedParam(s));
          return tx.get('SELECT u, s FROM amounts');
        });
        assert.ok(back !== undefined);
        assert.equal(lamportsCell(back, 'u'), u);
        assert.equal(tokenUnitsCell(back, 'u'), u);
        assert.equal(signedCell(back, 's'), s);
      }),
    );
  });
});
