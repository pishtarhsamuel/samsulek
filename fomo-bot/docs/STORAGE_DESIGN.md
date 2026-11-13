# Phase 2 step 6 design: storage layer and composition-root transactions

Status: PROPOSED by the architect (2026-11-12); built in sub-steps 6a-6e (section 7), each
reviewed by risk-guardian and security-auditor before its commit. 6a is done (REVIEWS.md N).
The owner accepted the four decisions of section 8 on 2026-11-13 (DECISIONS.md D5). Where this
file and ARCHITECTURE.md differ, ARCHITECTURE.md wins until a sub-step's review moves the
change there.

The design rests only on facts in docs/VERIFIED_FACTS.md (node:sqlite rows) and docs/research/phase0-toolchain.md F5-F10. Items marked UNVERIFIED are listed in section 9 for a scratch test.

Files read: fomo-bot/CLAUDE.md, docs/ARCHITECTURE.md (s.2-4, 7, 8, 11, 12), docs/RISK_POLICY.md (s.4 contracts 1-9, s.6 step 5, s.8, s.12), docs/REVIEWS.md (K, K re-review, L, M), docs/TEST_PLAN.md (s.3-4), docs/VERIFIED_FACTS.md (node:sqlite rows), src/risk/{approve,approval,daystate,blocks,recheck}.ts, src/config/{changes,tunables}.ts, src/core/{units,ids}.ts, src/portfolio/ledger.ts, tests/architecture/import-graph.test.ts, package.json.

## 0. In plain English, and what I would cut

- One file (`storage/sqlite.ts`) talks to the built-in database module. A second file (`storage/codec.ts`) is the only place amounts turn from text into bigint. Repositories are dumb typed SQL. Every money decision is written in one locked transaction in `app/`.
- The database adds its own tripwires on top of the code: one active position per mint, at most one buy order per position, at most one exit in flight per position, tokens usable once and never after their expiry slot, an order only with a consumed matching token, no mode reaches live except through go-live, and pending loosenings wait at least 24 h.
- The K gate: the token store and the slot source are bound when the authority is created in `app/`. The executor can no longer pass its own store or its own slot.
- Cuts, so it stays small:
  - no breakers table (breakers stay in memory until live owner-tap breakers exist, Phase 8);
  - no `fills`, `attempts` or `cost_lines` (they come with T3 in the paper-engine step);
  - no `ai_proposals` (Phase 5);
  - no daily `backup()` (ops step); only a synchronous `VACUUM INTO` before migrations;
  - no real clock (tests inject one).
- More I could cut if reviewers prefer: the audit hash chain (keep a plain append-only log), the audit-gated KILL and HALT triggers, and the DB copies of three hard caps (section 2.3).

## 1. Module layout

```
src/storage/            (imports core/ only at runtime; `import type` from risk/ and config/ is allowed)
  sqlite.ts             the ONLY importer of node:sqlite: openDb, Db, Tx, transaction(), quickCheck, vacuumInto, StorageError
  codec.ts              the ONLY TEXT<->bigint place: cell readers, param writers, and the SQL CHECK fragments
  migrations.ts         MIGRATIONS (ordered, literal), migrate(): version table, checksums, backup, quick_check
  schema-v1.ts          migration 1's SQL (built from codec.ts fragments; sha256 pinned in a test)
  repo-config.ts        config_versions, pending_changes
  repo-flags.ts         flags, halt_reasons, strategy_modes, entry_bans, entry_counts
  repo-day.ts           day_state, equity_snapshots
  repo-book.ts          ledger_accounts, positions
  repo-orders.ts        intents, risk_decisions, approvals, orders
  repo-audit.ts         audit_log (append, verify chain)
src/core/
  redact.ts             (new, pure) assertNoSecrets(text): refuses, never masks
  rng.ts                (new, 6d) the approval key, token ids, position and order ids
src/app/
  storage-boot.ts       open, quick_check, foreign_key_check, backup + migrate, required rows present
  authority.ts          the ONLY createApprovalAuthority call: binds the store and the slot source
  slots.ts              SlotSource: highest slot from WS and HTTP, null when older than maxAgeMs
  snapshot.ts           reads BuyWorld and EntryFlags inside a Tx
  approve-tx.ts         T1: approveBuyTx, approveExitTx, abandonOpeningTx, recordRefusalTx
  token-store.ts        T2: createSqliteTokenStore (the whole T2 runs inside consume)
  day-tx.ts             observeDayTx, confirmJumpTx, applyTransferTx, resumePeakTx, resumeStreakTx
  config-tx.ts          setTx, rollbackTx, cancelPendingTx, applyDueTx (aiApproveTx in Phase 5)
```

### 1.1 `storage/sqlite.ts`

```ts
export type SqlParam = string | bigint | null | Uint8Array;  // no `number`: nothing float-like can enter
export type SqlCell  = string | bigint | null | Uint8Array;  // a REAL cell (JS number) is refused on read
export type Row = Readonly<Record<string, SqlCell>>;

export type StorageErrorCode =
  | 'busy' | 'full' | 'io' | 'corrupt' | 'not-a-database' | 'readonly' | 'constraint'
  | 'async-in-transaction' | 'nested-transaction' | 'tx-closed' | 'poisoned' | 'closed'
  | 'bad-param' | 'bad-cell' | 'pragma' | 'foreign-file' | 'other';
export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly detail: string;  // SQLite's errstr / RAISE text via echoText, never a bound value
}

export interface Reader {
  get(sql: string, ...params: SqlParam[]): Row | undefined;
  all(sql: string, ...params: SqlParam[]): readonly Row[];
}
export interface Tx extends Reader {
  /** One statement; returns the rows changed as a checked number. */
  run(sql: string, ...params: SqlParam[]): number;
  /** Several statements: migrations.ts only (code rule, reviewed). */
  script(sql: string): void;
}
export type NotPromise<T> = T extends PromiseLike<unknown> ? never : T;

export interface Db extends Reader {      // reads outside a transaction are autocommit, for status only
  readonly file: string;                  // ':memory:' or an absolute path
  transaction<T>(fn: (tx: Tx) => NotPromise<T>): NotPromise<T>;
  quickCheck(): readonly string[];        // [] = ok
  foreignKeyCheck(): readonly string[];
  vacuumInto(file: string): void;         // outside a transaction only
  close(): void;
}
export interface OpenOptions {
  readonly busyTimeoutMs: number;         // 5_000 in the bot; 100-200 in tests
  readonly create: boolean;               // false: a missing file is an error (never silently a new DB)
  readonly readOnly?: boolean;            // CLI status
}
export function openDb(file: string, options: OpenOptions): Db;
```

`openDb` does the following and refuses on any surprise:

- Constructs the Node class with `{ timeout: busyTimeoutMs, readBigInts: true, enableForeignKeyConstraints: true, defensive: true, allowExtension: false, readOnly }`. The class name on 26.13.0 is `Database`, with `DatabaseSync` as a deprecated alias (F7); see U1.
- Sets these pragmas: `journal_mode = WAL` (must return `wal`; `memory` only for `':memory:'`), `synchronous = FULL` (money path: no lost commit on power loss), `foreign_keys = ON` (read back as 1), `trusted_schema = OFF`, `application_id = 0x464F4D4F`.
- On a non-empty file, a different application_id gives `foreign-file`. On a file it creates, it sets the application_id. On Linux it chmods the file to 0600; the start script also sets umask 077 so `-wal` and `-shm` inherit it.

The transaction helper is the only way to write:

```ts
transaction<T>(fn: (tx: Tx) => NotPromise<T>): NotPromise<T> {
  if (this.poisoned) throw new StorageError('poisoned', '...');
  if (this.active) throw new StorageError('nested-transaction', '...');
  this.conn.exec('BEGIN IMMEDIATE');  // waits up to the busy timeout, then SQLITE_BUSY -> 'busy'
  this.active = true;
  const tx = this.makeTx();           // run/get/all/script; each checks tx.open
  let committed = false;
  try {
    const out = fn(tx);
    if (isThenable(out)) throw new StorageError('async-in-transaction', '...');  // the promise is never awaited
    this.conn.exec('COMMIT');
    committed = true;
    return out;
  } finally {
    tx.open = false;                  // a leaked tx (callback, timer) throws 'tx-closed'
    this.active = false;
    if (!committed) {
      try { this.conn.exec('ROLLBACK'); }
      catch { this.poisoned = true; } // every later call throws; app latches entries off, alerts, exits
    }
  }
}
```

A throw anywhere in `fn` (a RiskError from `approveBuy`, a CHECK or UNIQUE failure, a RAISE in a trigger, SQLITE_FULL) or in `COMMIT` ends in ROLLBACK. An `async` fn is refused before COMMIT. No `await` can sit between BEGIN and COMMIT, because `fn` runs to completion synchronously before `transaction` returns. Statements are prepared once per SQL text and cached. All SQL is constant text with `?` parameters, never built from values.

### 1.2 `storage/codec.ts`

This file wraps core/units (`toText`, `lamportsFromText`, `tokenUnitsFromText`, `signedLamportsFromText`, which already require canonical text and at most 21 characters). It is the only file that converts amounts.

```ts
export function lamportsCell(r: Row, col: string): Lamports;            // also tokenUnitsCell, signedCell
export function lamportsCellOrNull(r: Row, col: string): Lamports | null;
export function msCell(r: Row, col: string): number;    // INTEGER bigint -> number, isTimestamp
export function intCell(r: Row, col: string, min: number, max: number): number;
export function slotCell(r: Row, col: string): bigint;  // INTEGER >= 0
export function boolCell(r: Row, col: string): boolean; // 0n | 1n only
export function textCell(r: Row, col: string): string;
export function amountParam(v: bigint): string;         // u64-checked canonical text
export function signedParam(v: bigint): string;
export function msParam(v: number): bigint;
export function intParam(v: number): bigint;
export function boolParam(v: boolean): bigint;
export function codeParam(v: string): string;   // /^[a-z0-9][a-z0-9:._-]{0,63}$/: reasons are codes, never prose
export function jsonParam(v: unknown): string;  // bigints as text, ASCII only, <= 8 KiB, then assertNoSecrets
// SQL fragments; schema-v1.ts uses them, so each column's constraint and its codec are defined side by side:
const U64_MAX_TEXT = '18446744073709551615';
export const u64 = (c: string) =>
  `(length(${c}) BETWEEN 1 AND 20 AND ${c} NOT GLOB '*[^0-9]*' AND (${c} = '0' OR ${c} NOT GLOB '0*')` +
  ` AND (length(${c}) < 20 OR ${c} <= '${U64_MAX_TEXT}'))`;
export const u64OrNull = (c: string) => `(${c} IS NULL OR ${u64(c)})`;
export const signed = (c: string) => `(${u64(c)} OR (${c} GLOB '-[1-9]*' AND ${u64(`substr(${c}, 2)`)}))`;
export const ms     = (c: string) => `(${c} BETWEEN 0 AND 7258118400000)`;  // core/time MAX_TIMESTAMP_MS
export const msOrNull = (c: string) => `(${c} IS NULL OR ${ms(c)})`;
export const bool   = (c: string) => `(${c} IN (0, 1))`;
export const id     = (c: string) => `(length(${c}) BETWEEN 1 AND 128 AND ${c} NOT GLOB '*[^A-Za-z0-9_-]*')`; // = isIdText
export const code   = (c: string) => `(length(${c}) BETWEEN 1 AND 64 AND ${c} NOT GLOB '*[^a-z0-9:._-]*')`;
export const day    = (c: string) => `(${c} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')`;
export const hex64  = (c: string) => `(length(${c}) = 64 AND ${c} NOT GLOB '*[^0-9a-f]*')`;
export const json   = (c: string) => `(json_valid(${c}) AND ${c} NOT GLOB '*[^ -~]*')`;
```

Text comparison against `U64_MAX_TEXT` is only done when the lengths are equal (20 digits), where text order equals numeric order. Slots stay INTEGER: they need numeric comparison in SQL, and a slot above 2^63-1 is refused at bind (ERR_INVALID_ARG_VALUE, F10), which fails closed. Timestamps are INTEGER ms.

### 1.3 `storage/migrations.ts`

```ts
export interface Migration { readonly version: number; readonly name: string; readonly sql: string }
export const MIGRATIONS: readonly Migration[];  // 1..N, consecutive, frozen; no '\r' in any sql (test)
export interface MigrateOptions {
  readonly now: () => number;
  readonly backupDir: string | null;  // null only for ':memory:'
  readonly nodeVersion: string;
}
export interface MigrateResult { readonly from: number; readonly to: number; readonly backup: string | null }
export function migrate(db: Db, options: MigrateOptions): MigrateResult;
```

The rules:

- An empty file (no rows in sqlite_schema) is a new DB.
- Tables but no `schema_migrations` means `foreign-file`: refuse.
- A recorded sha256 that differs from the code's means an applied migration was edited: refuse to start.
- A DB version above the code's latest means old code on a newer DB: refuse to start.
- Pending migrations: `quick_check` first, then `VACUUM INTO <backupDir>/pre-migration-v<from>-v<to>-<YYYYMMDDTHHMMSSZ>.sqlite` (no colons, so it works on Windows), then each migration in its own `transaction()` that also inserts its schema_migrations row. Then `quick_check` and `foreign_key_check` again.
- A second run is a no-op (idempotent).
- There is no down migration, ever.

### 1.4 Repositories

Plain functions of `(r: Reader | tx: Tx, ...)` returning typed rows (core types; `import type` for EquityState and similar). They never validate domain rules; the pure checkers (`checkHistory`, `checkPending`, `observeEquity` input checks, `approveBuy` input checks) re-validate everything that comes back. Each write function asserts its `changes` count: a delete or update that should hit exactly 1 row throws otherwise. A missing required row (`flags`, `day_state` for the mode, `ledger_accounts` for the mode, version 1) throws. It is never replaced by a default (contract 1).

## 2. DDL for step 6 (migration 1)

This is shown as the template string in `schema-v1.ts`. `${...}` are the codec.ts fragments above. Every table is STRICT.

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version >= 1),
  name TEXT NOT NULL CHECK ${code('name')},
  sha256 TEXT NOT NULL CHECK ${hex64('sha256')},
  applied_at INTEGER NOT NULL CHECK ${ms('applied_at')},
  node_version TEXT NOT NULL, sqlite_version TEXT NOT NULL
) STRICT;

-- config (matches ConfigVersion and PendingChange of config/changes.ts)
CREATE TABLE config_versions (
  id INTEGER PRIMARY KEY CHECK (id >= 1),
  created_at INTEGER NOT NULL CHECK ${ms('created_at')},
  author TEXT NOT NULL CHECK (author IN ('default','owner','ai-approved','rollback')),
  values_json TEXT NOT NULL CHECK ${json('values_json')},    -- encodeTunables(): lamports as decimal text
  changed_json TEXT NOT NULL CHECK ${json('changed_json')},  -- TunablePath[]
  undo_to INTEGER REFERENCES config_versions(id),
  CHECK ((id = 1) = (author = 'default')),
  CHECK (undo_to IS NULL OR undo_to < id),
  CHECK (id <> 1 OR (undo_to IS NULL AND changed_json = '[]'))
) STRICT;  -- the active version is the newest one (no "active" column)
CREATE TRIGGER config_versions_in_order BEFORE INSERT ON config_versions
  WHEN NEW.id <> (SELECT COALESCE(MAX(id), 0) + 1 FROM config_versions)
    OR NEW.created_at < (SELECT COALESCE(MAX(created_at), 0) FROM config_versions)
  BEGIN SELECT RAISE(ABORT, 'config version out of order'); END;
CREATE TRIGGER config_versions_no_update BEFORE UPDATE ON config_versions BEGIN SELECT RAISE(ABORT, 'config versions are immutable'); END;
CREATE TRIGGER config_versions_no_delete BEFORE DELETE ON config_versions BEGIN SELECT RAISE(ABORT, 'config versions are immutable'); END;

CREATE TABLE pending_changes (
  path TEXT PRIMARY KEY CHECK (length(path) <= 64 AND path GLOB '[a-z]*.[a-zA-Z]*' AND path NOT GLOB '*[^a-zA-Z0-9.]*'),
  from_value TEXT NOT NULL CHECK ${u64('from_value')},  -- every tunable is a non-negative integer
  to_value TEXT NOT NULL CHECK ${u64('to_value')},
  source TEXT NOT NULL CHECK (source IN ('owner','ai-approved','rollback')),
  requested_at INTEGER NOT NULL CHECK ${ms('requested_at')},
  apply_at INTEGER NOT NULL CHECK ${ms('apply_at')},
  CHECK (apply_at - requested_at >= 86400000)            -- LOOSENING_DELAY_MS, also enforced here
) STRICT;  -- PRIMARY KEY(path): at most one pending row per tunable

-- flags (kill, pause, entries stopped, halt cleared; the arm flag is the server's and is NOT stored)
CREATE TABLE flags (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  kill INTEGER NOT NULL CHECK ${bool('kill')},
  kill_at INTEGER CHECK ${msOrNull('kill_at')},
  kill_source TEXT CHECK (kill_source IS NULL OR kill_source IN ('cli','telegram','sentinel')),
  paused INTEGER NOT NULL CHECK ${bool('paused')},
  paused_at INTEGER CHECK ${msOrNull('paused_at')},
  entries_stopped INTEGER NOT NULL CHECK ${bool('entries_stopped')},
  halt_cleared_at INTEGER CHECK ${msOrNull('halt_cleared_at')},
  updated_at INTEGER NOT NULL CHECK ${ms('updated_at')},
  CHECK ((kill = 1) = (kill_at IS NOT NULL AND kill_source IS NOT NULL)),
  CHECK ((paused = 1) = (paused_at IS NOT NULL))
) STRICT;
INSERT INTO flags VALUES (1, 0, NULL, NULL, 0, NULL, 0, NULL, 0);

CREATE TABLE halt_reasons (
  reason TEXT PRIMARY KEY CHECK ${code('reason')},  -- e.g. 'sanity-max:paper', 'peak-halt:paper', 'disk-db'
  set_at INTEGER NOT NULL CHECK ${ms('set_at')}
) STRICT;  -- HALT = at least one row; global (both modes), the stricter reading

CREATE TABLE strategy_modes (
  strategy TEXT PRIMARY KEY CHECK (strategy IN ('crowdflow','momentum','launch')),
  mode TEXT NOT NULL CHECK (mode IN ('off','paper','live')),
  changed_at INTEGER NOT NULL CHECK ${ms('changed_at')},
  changed_by TEXT NOT NULL CHECK (changed_by IN ('migration','owner-off','owner-paper','owner-golive','auto-demote')),
  gate_since INTEGER NOT NULL CHECK ${ms('gate_since')},  -- go-live count restarts (Effects.restartGate)
  CHECK (mode <> 'live' OR changed_by = 'owner-golive')    -- invariant 24 as a DB tripwire
) STRICT;
INSERT INTO strategy_modes VALUES ('crowdflow','off',0,'migration',0), ('momentum','off',0,'migration',0), ('launch','off',0,'migration',0);

CREATE TABLE entry_bans (  -- cooldowns and blocklists that EntryState needs
  kind TEXT NOT NULL CHECK (kind IN ('mint-cooldown','mint-ban','creator-ban','strategy-pause','strategy-off')),
  key TEXT NOT NULL CHECK ${id('key')},  -- a mint, a creator address or a strategy id
  until INTEGER CHECK ${msOrNull('until')},
  reason TEXT NOT NULL CHECK ${code('reason')},
  set_at INTEGER NOT NULL CHECK ${ms('set_at')},
  PRIMARY KEY (kind, key),
  CHECK ((until IS NULL) = (kind IN ('mint-ban','creator-ban'))),
  CHECK (kind NOT IN ('strategy-pause','strategy-off') OR key IN ('crowdflow','momentum','launch'))
) STRICT;

CREATE TABLE entry_counts (  -- one shared count per Athens day (paper and live together, review L)
  day TEXT PRIMARY KEY CHECK ${day('day')},
  count INTEGER NOT NULL CHECK (count BETWEEN 1 AND 12)  -- 12 = HARD_CAPS.entriesPerDay (test ties them)
) STRICT;
CREATE TRIGGER entry_counts_first BEFORE INSERT ON entry_counts WHEN NEW.count <> 1
  BEGIN SELECT RAISE(ABORT, 'a day starts at one entry'); END;
CREATE TRIGGER entry_counts_step BEFORE UPDATE ON entry_counts WHEN NEW.count <> OLD.count + 1 OR NEW.day <> OLD.day
  BEGIN SELECT RAISE(ABORT, 'entries count up by exactly one'); END;
CREATE TRIGGER entry_counts_no_delete BEFORE DELETE ON entry_counts BEGIN SELECT RAISE(ABORT, 'entry counts are kept'); END;

-- day state (EquityState of risk/daystate.ts, one row per ledger mode; contract 1 and 9)
CREATE TABLE day_state (
  mode TEXT PRIMARY KEY CHECK (mode IN ('paper','live')),
  shape INTEGER NOT NULL CHECK (shape = 1),  -- the stored shape; a new field = a migration with a backfill, never a code default
  day TEXT CHECK (day IS NULL OR ${day('day')}),
  day_start TEXT NOT NULL CHECK ${u64('day_start')},
  last_equity TEXT NOT NULL CHECK ${u64('last_equity')},
  peak TEXT CHECK ${u64OrNull('peak')},
  jump_pending INTEGER NOT NULL CHECK ${bool('jump_pending')},
  jump_held_equity TEXT CHECK ${u64OrNull('jump_held_equity')},
  jump_held_at INTEGER CHECK ${msOrNull('jump_held_at')},
  jump_ack_equity TEXT CHECK ${u64OrNull('jump_ack_equity')},
  jump_ack_at INTEGER CHECK ${msOrNull('jump_ack_at')},
  daily_stop_day TEXT CHECK (daily_stop_day IS NULL OR ${day('daily_stop_day')}),
  daily_stop_streak INTEGER NOT NULL CHECK (daily_stop_streak >= 0),
  streak_halt INTEGER NOT NULL CHECK ${bool('streak_halt')},
  updated_at INTEGER NOT NULL CHECK ${ms('updated_at')},
  CHECK ((jump_held_equity IS NULL) = (jump_held_at IS NULL)),
  CHECK ((jump_ack_equity IS NULL) = (jump_ack_at IS NULL)),
  CHECK (jump_pending = (jump_held_equity IS NOT NULL))  -- "set exactly while jumpPending"
) STRICT;
INSERT INTO day_state VALUES ('paper',1,NULL,'0','0',NULL,0,NULL,NULL,NULL,NULL,NULL,0,0,0),
                             ('live', 1,NULL,'0','0',NULL,0,NULL,NULL,NULL,NULL,NULL,0,0,0);
CREATE TRIGGER day_state_no_delete BEFORE DELETE ON day_state BEGIN SELECT RAISE(ABORT, 'day state is never deleted'); END;

CREATE TABLE equity_snapshots (  -- contract 6: raw, fully valued snapshots, the only source of equityAnHourAgo
  mode TEXT NOT NULL CHECK (mode IN ('paper','live')),
  at INTEGER NOT NULL CHECK ${ms('at')},
  equity TEXT CHECK ${u64OrNull('equity')},
  stop_equity TEXT CHECK ${u64OrNull('stop_equity')},
  PRIMARY KEY (mode, at)
) STRICT;

-- book
CREATE TABLE ledger_accounts (  -- rows are created by the app at first boot (paper: paperStartingLamports as a deposit)
  mode TEXT PRIMARY KEY CHECK (mode IN ('paper','live')),
  sol TEXT NOT NULL CHECK ${u64('sol')},
  total_deposits TEXT NOT NULL CHECK ${u64('total_deposits')},
  total_withdrawals TEXT NOT NULL CHECK ${u64('total_withdrawals')},
  updated_at INTEGER NOT NULL CHECK ${ms('updated_at')}
) STRICT;

CREATE TABLE positions (  -- the Position of portfolio/ledger.ts plus mode, status 'stuck', max_spend, p95, exit_seq
  id TEXT PRIMARY KEY CHECK ${id('id')},
  mint TEXT NOT NULL CHECK ${id('mint')},
  strategy TEXT NOT NULL CHECK (strategy IN ('crowdflow','momentum','launch')),
  mode TEXT NOT NULL CHECK (mode IN ('paper','live')),
  status TEXT NOT NULL CHECK (status IN ('opening','open','exiting','stuck','closed')),
  opened_at INTEGER NOT NULL CHECK ${ms('opened_at')},
  closed_at INTEGER CHECK ${msOrNull('closed_at')},
  max_spend TEXT CHECK ${u64OrNull('max_spend')},
  p95_exit_cost TEXT NOT NULL CHECK ${u64('p95_exit_cost')},
  exit_seq INTEGER NOT NULL DEFAULT 0 CHECK (exit_seq >= 0),
  token_units TEXT NOT NULL DEFAULT '0' CHECK ${u64('token_units')},
  cost_basis TEXT NOT NULL DEFAULT '0' CHECK ${u64('cost_basis')},
  rent_locked TEXT NOT NULL DEFAULT '0' CHECK ${u64('rent_locked')},
  realized TEXT NOT NULL DEFAULT '0' CHECK ${signed('realized')},
  bought TEXT NOT NULL DEFAULT '0' CHECK ${u64('bought')},
  sold TEXT NOT NULL DEFAULT '0' CHECK ${u64('sold')},
  venue_fees TEXT NOT NULL DEFAULT '0' CHECK ${u64('venue_fees')},
  network_fees TEXT NOT NULL DEFAULT '0' CHECK ${u64('network_fees')},
  failed_fees TEXT NOT NULL DEFAULT '0' CHECK ${u64('failed_fees')},
  tips TEXT NOT NULL DEFAULT '0' CHECK ${u64('tips')},
  rent_paid TEXT NOT NULL DEFAULT '0' CHECK ${u64('rent_paid')},
  rent_refunded TEXT NOT NULL DEFAULT '0' CHECK ${u64('rent_refunded')},
  tokens_bought TEXT NOT NULL DEFAULT '0' CHECK ${u64('tokens_bought')},
  tokens_sold TEXT NOT NULL DEFAULT '0' CHECK ${u64('tokens_sold')},
  exit_fees TEXT NOT NULL DEFAULT '0' CHECK ${u64('exit_fees')},
  basis_released TEXT NOT NULL DEFAULT '0' CHECK ${u64('basis_released')},
  updated_at INTEGER NOT NULL CHECK ${ms('updated_at')},
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CHECK (status <> 'opening' OR max_spend IS NOT NULL),
  CHECK (max_spend IS NULL OR length(max_spend) < 8 OR (length(max_spend) = 8 AND max_spend <= '70000000'))  -- 0.07 SOL backstop
) STRICT;
CREATE UNIQUE INDEX positions_one_per_mint ON positions(mint) WHERE status IN ('opening','open','exiting','stuck');
CREATE TRIGGER positions_born_opening BEFORE INSERT ON positions WHEN NEW.status <> 'opening'
  BEGIN SELECT RAISE(ABORT, 'a position starts as opening'); END;
CREATE TRIGGER positions_cap BEFORE INSERT ON positions
  WHEN (SELECT COUNT(*) FROM positions WHERE status IN ('opening','open','exiting','stuck')) >= 4  -- HARD_CAPS.openPositions
  BEGIN SELECT RAISE(ABORT, 'more than 4 active positions'); END;
CREATE TRIGGER positions_identity BEFORE UPDATE OF id, mint, strategy, mode, opened_at ON positions
  BEGIN SELECT RAISE(ABORT, 'a position keeps its identity'); END;
CREATE TRIGGER positions_closed_final BEFORE UPDATE ON positions WHEN OLD.status = 'closed'
  BEGIN SELECT RAISE(ABORT, 'a closed position is final'); END;
CREATE TRIGGER positions_no_delete BEFORE DELETE ON positions BEGIN SELECT RAISE(ABORT, 'positions are kept'); END;

-- money path
CREATE TABLE intents (
  id TEXT PRIMARY KEY CHECK ${id('id')},  -- entry: hash(strategy, mint, side, window); exit: hash(positionId, exitSeq)
  kind TEXT NOT NULL CHECK (kind IN ('entry','exit')),
  mode TEXT NOT NULL CHECK (mode IN ('paper','live')),
  strategy TEXT CHECK (strategy IS NULL OR strategy IN ('crowdflow','momentum','launch')),
  mint TEXT NOT NULL CHECK ${id('mint')},
  position_id TEXT NOT NULL CHECK ${id('position_id')},  -- no FK: an entry's position exists only if approved
  size_hint TEXT CHECK (size_hint IS NULL OR size_hint IN ('min','normal')),
  confidence_bps INTEGER CHECK (confidence_bps IS NULL OR confidence_bps BETWEEN 0 AND 10000),
  exit_seq INTEGER CHECK (exit_seq IS NULL OR exit_seq >= 0),
  fraction_bps INTEGER CHECK (fraction_bps IS NULL OR fraction_bps BETWEEN 1 AND 10000),
  urgency TEXT CHECK (urgency IS NULL OR urgency IN ('normal','protective','emergency')),
  created_at INTEGER NOT NULL CHECK ${ms('created_at')},
  inputs_as_of INTEGER CHECK ${msOrNull('inputs_as_of')},
  reasons_json TEXT NOT NULL CHECK ${json('reasons_json')},
  inputs_json TEXT NOT NULL CHECK ${json('inputs_json')},
  CHECK ((kind = 'entry') = (strategy IS NOT NULL AND size_hint IS NOT NULL AND exit_seq IS NULL)),
  CHECK ((kind = 'exit') = (exit_seq IS NOT NULL AND fraction_bps IS NOT NULL AND urgency IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX intents_one_per_exit_seq ON intents(position_id, exit_seq) WHERE kind = 'exit';
CREATE TRIGGER intents_no_update BEFORE UPDATE ON intents BEGIN SELECT RAISE(ABORT, 'intents are immutable'); END;
CREATE TRIGGER intents_no_delete BEFORE DELETE ON intents BEGIN SELECT RAISE(ABORT, 'intents are immutable'); END;

CREATE TABLE risk_decisions (  -- one decision per intent
  intent_id TEXT PRIMARY KEY REFERENCES intents(id),
  at INTEGER NOT NULL CHECK ${ms('at')},
  approved INTEGER NOT NULL CHECK ${bool('approved')},
  stage TEXT CHECK (stage IS NULL OR stage IN ('blocked','sizing','plan','duplicate','error')),
  reasons_json TEXT NOT NULL CHECK ${json('reasons_json')},  -- fixed codes only: block names, sizing:x, plan:x
  size TEXT CHECK ${u64OrNull('size')},
  limited_by TEXT CHECK (limited_by IS NULL OR ${code('limited_by')}),
  binding TEXT CHECK (binding IS NULL OR ${code('binding')}),
  slot INTEGER NOT NULL CHECK (slot >= 0),
  config_version INTEGER NOT NULL REFERENCES config_versions(id),
  CHECK ((approved = 1) = (stage IS NULL))
) STRICT;
CREATE TRIGGER risk_decisions_no_update BEFORE UPDATE ON risk_decisions BEGIN SELECT RAISE(ABORT, 'decisions are immutable'); END;
CREATE TRIGGER risk_decisions_no_delete BEFORE DELETE ON risk_decisions BEGIN SELECT RAISE(ABORT, 'decisions are immutable'); END;

CREATE TABLE approvals (  -- tokens; the MAC is not stored (per-boot key: worthless after a restart)
  token_id TEXT PRIMARY KEY CHECK ${id('token_id')},
  intent_id TEXT NOT NULL UNIQUE REFERENCES risk_decisions(intent_id),
  position_id TEXT NOT NULL REFERENCES positions(id),
  mode TEXT NOT NULL CHECK (mode IN ('paper','live')),
  kind TEXT NOT NULL CHECK (kind IN ('buy','sell','close-account')),  -- withdraw has its own path
  reduce_only INTEGER NOT NULL CHECK ${bool('reduce_only')},
  plan_hash TEXT NOT NULL CHECK ${hex64('plan_hash')},
  max_spend TEXT NOT NULL CHECK ${u64('max_spend')},
  min_out TEXT NOT NULL CHECK ${u64('min_out')},
  quote_slot INTEGER NOT NULL CHECK (quote_slot >= 0),
  expires_at_slot INTEGER NOT NULL,
  issued_at INTEGER NOT NULL CHECK ${ms('issued_at')},
  consumed_at INTEGER CHECK ${msOrNull('consumed_at')},
  consumed_slot INTEGER,
  CHECK (reduce_only = (kind IN ('sell','close-account'))),
  CHECK (expires_at_slot >= quote_slot AND expires_at_slot - quote_slot <= 25),  -- HARD_CAPS.planFreshSlots
  CHECK ((consumed_at IS NULL) = (consumed_slot IS NULL)),
  CHECK (consumed_slot IS NULL OR consumed_slot <= expires_at_slot)               -- never consumed after expiry
) STRICT;
CREATE TRIGGER approvals_single_use BEFORE UPDATE ON approvals
  WHEN OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
    OR NEW.token_id IS NOT OLD.token_id OR NEW.intent_id IS NOT OLD.intent_id OR NEW.position_id IS NOT OLD.position_id
    OR NEW.mode IS NOT OLD.mode OR NEW.kind IS NOT OLD.kind OR NEW.plan_hash IS NOT OLD.plan_hash
    OR NEW.max_spend IS NOT OLD.max_spend OR NEW.min_out IS NOT OLD.min_out OR NEW.expires_at_slot IS NOT OLD.expires_at_slot
  BEGIN SELECT RAISE(ABORT, 'a token is consumed once and otherwise immutable'); END;
CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals BEGIN SELECT RAISE(ABORT, 'tokens are kept'); END;

CREATE TABLE orders (
  id TEXT PRIMARY KEY CHECK ${id('id')},  -- plan.orderId
  intent_id TEXT NOT NULL UNIQUE REFERENCES intents(id),
  token_id TEXT NOT NULL UNIQUE REFERENCES approvals(token_id),
  position_id TEXT NOT NULL REFERENCES positions(id),
  mode TEXT NOT NULL CHECK (mode IN ('paper','live')),
  kind TEXT NOT NULL CHECK (kind IN ('buy','sell','close-account')),
  status TEXT NOT NULL CHECK (status IN ('approved','submitted','landed','failed','expired')),
  plan_hash TEXT NOT NULL CHECK ${hex64('plan_hash')},
  plan_json TEXT NOT NULL CHECK ${json('plan_json')},  -- canonicalJson(validated plan)
  in_amount TEXT NOT NULL CHECK ${u64('in_amount')},
  min_out TEXT NOT NULL CHECK ${u64('min_out')},
  max_spend TEXT NOT NULL CHECK ${u64('max_spend')},
  quote_slot INTEGER NOT NULL CHECK (quote_slot >= 0),
  created_at INTEGER NOT NULL CHECK ${ms('created_at')},
  updated_at INTEGER NOT NULL CHECK ${ms('updated_at')}
) STRICT;
CREATE UNIQUE INDEX orders_one_buy_per_position ON orders(position_id) WHERE kind = 'buy';  -- K finding 4, "ever"
CREATE UNIQUE INDEX orders_one_exit_in_flight ON orders(position_id)
  WHERE kind IN ('sell','close-account') AND status IN ('approved','submitted');
CREATE TRIGGER orders_need_consumed_token BEFORE INSERT ON orders
  WHEN NOT EXISTS (SELECT 1 FROM approvals a WHERE a.token_id = NEW.token_id AND a.consumed_at IS NOT NULL
    AND a.intent_id = NEW.intent_id AND a.position_id = NEW.position_id AND a.mode = NEW.mode
    AND a.kind = NEW.kind AND a.plan_hash = NEW.plan_hash AND a.max_spend = NEW.max_spend AND a.min_out = NEW.min_out)
    OR NEW.status <> 'approved'
  BEGIN SELECT RAISE(ABORT, 'an order needs its consumed, matching token'); END;
CREATE TRIGGER orders_status_forward BEFORE UPDATE OF status ON orders
  WHEN NOT ((OLD.status = 'approved' AND NEW.status IN ('submitted','failed','expired'))
         OR (OLD.status = 'submitted' AND NEW.status IN ('landed','failed','expired')))
  BEGIN SELECT RAISE(ABORT, 'order status moves forward only'); END;
CREATE TRIGGER orders_identity BEFORE UPDATE OF id, intent_id, token_id, position_id, mode, kind, plan_hash, plan_json,
  in_amount, min_out, max_spend, quote_slot, created_at ON orders BEGIN SELECT RAISE(ABORT, 'an order is immutable'); END;
CREATE TRIGGER orders_no_delete BEFORE DELETE ON orders BEGIN SELECT RAISE(ABORT, 'orders are kept'); END;

-- audit (config commands and dangerous commands; hash-chained)
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL CHECK ${ms('at')},
  actor TEXT NOT NULL CHECK (actor IN ('owner-telegram','owner-server','engine','ai')),
  action TEXT NOT NULL CHECK ${code('action')},
  detail_json TEXT NOT NULL CHECK ${json('detail_json')},
  prev_hash TEXT NOT NULL CHECK ${hex64('prev_hash')},
  hash TEXT NOT NULL UNIQUE CHECK ${hex64('hash')}  -- sha256(prev_hash '\n' canonical(at, actor, action, detail))
) STRICT;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;

-- owner-only clears must leave an audit row first, in the same transaction (tripwire; could be cut)
CREATE TRIGGER flags_kill_clear BEFORE UPDATE OF kill ON flags WHEN OLD.kill = 1 AND NEW.kill = 0
  AND (SELECT action FROM audit_log ORDER BY id DESC LIMIT 1) IS NOT 'server:clear-kill'
  BEGIN SELECT RAISE(ABORT, 'KILL is cleared only by reset-halt --clear-kill'); END;
CREATE TRIGGER halt_reasons_clear BEFORE DELETE ON halt_reasons
  WHEN (SELECT action FROM audit_log ORDER BY id DESC LIMIT 1) NOT IN ('server:reset-halt','owner:resume-peak','owner:resume-streak')
  BEGIN SELECT RAISE(ABORT, 'a halt is cleared only by the owner'); END;
```

### 2.1 Tables that wait for later steps

- `attempts`, `fills`, `cost_lines`: T3 settle, paper engine.
- `marks`: exit loop.
- `shadow_fills`, `twin_trades`, `tournament_results`: Phase 5.
- `tokens` (mint facts), `safety_verdicts`, `flow_minutes`, `health_events`, `budget_usage`: Phase 3.
- `breakers`: Phase 8 owner-tap breakers.
- `telegram_auth`, `confirmations`, `outbox`: Telegram step.
- `ai_reviews`, `ai_proposals` (the "approved at most once" column): Phase 5.
- A live `/resume` pending row: Phase 8.
- Rich creator-blocklist detail: Phase 3. `entry_bans` covers what T1 reads.

### 2.2 Who enforces what

| Rule | Database | Code only |
|---|---|---|
| One active position per mint | partial unique index | approveBuy one-per-mint |
| At most 4 active positions | `positions_cap` trigger (hard value) | blocks + buyLimitViolations (config, live caps) |
| One buy order per position, ever | `orders_one_buy_per_position` | re-check `buyOrdersForPosition` |
| One exit in flight per position | `orders_one_exit_in_flight` (sell and close) | re-check `inFlightExits` |
| Token single use, never after expiry, immutable | approvals CHECKs + `approvals_single_use` | verifier (MAC, plan hash, mode, kind, slot) |
| Order only with a consumed matching token | `orders_need_consumed_token`, UNIQUE(intent_id), UNIQUE(token_id) | T2 compares the snapshot with the row |
| Entry count +1 only, at most 12 | entry_counts CHECK + triggers | blocks (tunable, live 5) |
| Opening max_spend at most 0.07 SOL | CHECK | re-check backstop |
| No live mode except /golive | strategy_modes CHECK | changes.ts writes no mode |
| Pending waits at least 24 h, one per tunable | CHECK, PK(path) | changes.ts checkPending |
| Versions consecutive, immutable, first is default | triggers + CHECKs | checkHistory (changed equals the actual diff) |
| Amounts canonical u64 / signed text, no floats | CHECK fragments, STRICT, no REAL columns | codec.ts, wrapper refuses `number` |
| Day state shape and jump consistency | CHECKs, shape = 1 | observeEquity |
| KILL / HALT cleared only by the owner | audit-gated triggers (tripwire) | only owner CLI functions call clear |
| Caps, sizing, reserve, exposure, equity, freshness | no | risk/ (pure) |
| Exit fraction vs plan size (K finding 9) | no | exit plan builder (open) |

## 3. The app/ transactions

Shared dependencies:

```ts
export interface Clock { now(): number }              // the guarded clock arrives with contract 8; tests inject
export interface MarkReader {                         // synchronous, in memory (the exit loop's cache)
  /** The exact sell quote of exactly `tokenUnits` after fees; null if none, stale, future-stamped or a different amount. */
  value(positionId: string, tokenUnits: TokenUnits, now: number): Lamports | null;
}
export interface EngineDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly slots: SlotSource;                        // the same instance bound into the authority
  readonly issuer: ApprovalIssuer;                   // from app/authority.ts
  readonly marks: MarkReader;
  readonly liveArmed: () => boolean;                 // the server's arm flag; paper: () => false
  readonly liveSol: () => LiveSolCaps | null;        // today's EUR caps (live only)
}
```

Everything the transaction reads, it reads inside the transaction. Inputs from outside are only the intent, the untrusted plan, and risk's own market read (BuyMarket / exit quote), which carry their own slots and are checked by the re-check. Alerts and replies go out only after COMMIT.

### 3.1 T1 approve buy

```ts
export interface BuyRequest {
  readonly intent: TradeIntent;   // strategy output; its id is the deterministic hash
  readonly positionId: string;    // engine-made (core/rng)
  readonly plan: OrderPlan;       // untrusted
  readonly market: BuyMarket;     // risk's own read (safety, quote, fee config, rent, p95)
}
export type BuyOutcome =
  | { readonly kind: 'approved'; readonly token: ApprovalToken; readonly plan: CheckedPlan; readonly positionId: string }
  | { readonly kind: 'refused'; readonly stage: 'blocked' | 'sizing' | 'plan'; readonly reasons: readonly string[] }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'error'; readonly code: string };  // rolled back; recorded by recordRefusalTx
export function approveBuyTx(deps: EngineDeps, req: BuyRequest): BuyOutcome;
```

Inside one `db.transaction` (BEGIN IMMEDIATE):

1. `now = clock.now()`, `day = athensDay(now)`, `slot = slots.currentSlot()`. A null slot throws, which rolls back and becomes `error: slot-unknown`.
2. If `intents` already has `intent.id`, return `duplicate` (the PK is the backstop). Otherwise insert the intent (reasons and inputs through `jsonParam`, so the redactor runs).
3. Read `flags`, `halt_reasons`, `strategy_modes`, the `entry_bans` with `until` > now or null, `entry_counts[day]` (0 if none), and every position where status is in (opening, open, exiting, stuck). Read `ledger_accounts[mode]` (walletSol; live later: min(ledger, chain)), `day_state[mode]` (dayStart, dailyStopActive, jumpPending) and the newest `config_versions` row (decodeTunables gives entriesPerDay, maxPositions, the caps).
4. Build ActivePosition[]: an opening position carries `maxSpend`; open and exiting ones carry `marks.value(id, token_units, now)`; a stuck one is 0. Any null mark makes `equity.current = null` (blocked).
5. `decision = approveBuy({ intent, plan, world, market, caps }, deps.issuer)`. This is pure and synchronous. It throws on malformed input.
6. If approved:
   - INSERT positions (opening, max_spend = opening.maxSpend, p95 from market);
   - UPSERT entry_counts: `INSERT ... VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1`, then assert the stored count equals `decision.entriesToday`;
   - INSERT risk_decisions (approved, size, limitedBy, binding, slot, config_version);
   - INSERT approvals (token fields, issued_at, quote_slot = plan.quoteSlot).
7. If refused: INSERT risk_decisions (stage, reasons).
8. COMMIT. Return the token and plan only now. The token is useless without its approvals row anyway, because T2 requires it.

A throw at any point (RiskError, AmountError, ConfigError, StorageError: partial index, positions_cap, entry_counts trigger, SQLITE_FULL) rolls back steps 2-7 entirely. The caller then runs `recordRefusalTx(deps, intent, 'error', [code])` in a new tiny transaction (intent + decision, fixed code) and alerts. If that also fails, the in-memory latch `entriesBlocked = true` is set and the owner is alerted outside the DB (section 6).

```mermaid
sequenceDiagram
  participant Eng as Engine (async tick)
  participant App as app/approve-tx (sync)
  participant DB as SQLite (one connection)
  participant Risk as risk/approveBuy (pure)
  Eng->>Eng: await safety, quote, fee config (BuyMarket)
  Eng->>App: approveBuyTx(deps, req)
  App->>DB: BEGIN IMMEDIATE (busy timeout 5 s)
  App->>DB: intent exists? insert intent
  App->>DB: read flags, halts, modes, bans, count, positions, ledger, day_state, config
  App->>App: marks (memory, sync), slot (SlotSource)
  App->>Risk: approveBuy(world, market, caps, issuer)
  Risk-->>App: decision (token issued last)
  alt approved
    App->>DB: insert position (opening), count +1, decision, approval row
  else refused
    App->>DB: insert decision (stage, reasons)
  end
  App->>DB: COMMIT
  Note over App,DB: any throw before COMMIT: ROLLBACK, nothing written; then recordRefusalTx
  App-->>Eng: outcome (token and plan only after COMMIT)
```

### 3.2 T1 approve exit

```ts
export interface ExitRequest {
  readonly positionId: string;
  readonly fractionBps: Bps;
  readonly urgency: PlanUrgency;
  readonly reason: string;  // a code
  readonly origin: ExitOrigin;
  readonly plan: OrderPlan;
  readonly quote: QuoteContext; readonly quotedOut: bigint; readonly pool: ApprovedPool;
  readonly attemptsAllowed: number; readonly simulatedCu: number | null;
}
export type ExitOutcome =
  | { readonly kind: 'approved'; readonly token: ApprovalToken; readonly plan: CheckedPlan }
  | { readonly kind: 'refused'; readonly problems: readonly string[] }
  | { readonly kind: 'error'; readonly code: string };
export function approveExitTx(deps: EngineDeps, req: ExitRequest): ExitOutcome;
```

Inside the transaction:

1. Read the position (must be open, exiting or stuck) with its `exit_seq`, `token_units` and `cost_basis`.
2. Compute `intentId = exitIntentId(positionId, exit_seq)` in app/, never taken from the caller.
3. Read the in-flight exits from orders (count, and the sum of `in_amount` for in-flight sells as token units). chainTokens = ledger in paper; live comes from the reconciler.
4. Build PlanContext. Call `approveExit` (no flag input, s.9).
5. Insert the intent, the decision and, if approved, the approval row.

There are no flag reads, so no flag can block a valid exit. The exit fee-budget inputs (`budgetLeft`, `automaticStopped`) need T3's cost lines. Until then 6d passes them from `positions.failed_fees` against the hard budget. Flagged as open for T3.

`abandonOpeningTx(deps, positionId)`: closes an opening position whose token was refused or expired unredeemed, or that has no order at boot. It uses ledger.ts `abandonOpening` with no fees, and the entry still counts.

### 3.3 T2 submit (inside the bound TokenStore)

```ts
export function createSqliteTokenStore(db: Db, clock: Clock): TokenStore;
// consume(tokenId, s: RedeemSnapshot): boolean, as one db.transaction:
//   row = approvals[tokenId]; missing -> throw (store-error)
//   row.consumed_at not null -> return false (already-consumed; nothing written)
//   row fields must equal s (intent, position, mode, kind, reduceOnly, planHash, maxSpend, minOut, expiresAtSlot),
//     and planHash(s.plan) === row.plan_hash (app may call risk/plan.ts), else throw
//   UPDATE approvals SET consumed_at = now, consumed_slot = s.slot WHERE token_id = ? AND consumed_at IS NULL  -> exactly 1
//   INSERT orders from s.plan (status 'approved', plan_json = canonicalJson(s.plan))   -> triggers and unique indexes
//   return true
```

The order row is written from the verifier's validated snapshot, never from the executor's object. A CHECK on `consumed_slot <= expires_at_slot` makes a late consume impossible even if the verifier were wrong. Flags are not re-read in T2: the executor re-checks KILL, HALT, PAUSE and the daily stop before every attempt (s.8).

```mermaid
sequenceDiagram
  participant Ex as Executor (verifier only)
  participant V as risk verifier (bound store, slots)
  participant S as app TokenStore
  participant DB as SQLite
  Ex->>V: redeem(token, plan)
  V->>V: parse, MAC, validatePlan, hash, mode, kind, slot from SlotSource, expiry
  V->>S: consume(tokenId, snapshot)
  S->>DB: BEGIN IMMEDIATE; approval row matches? consume; insert order; COMMIT
  S-->>V: true (anything else, or a throw: refused)
  V-->>Ex: ok + frozen plan
```

### 3.4 Config commands (RISK_POLICY s.12 engine contracts)

```ts
export interface ConfigDeps { readonly db: Db; readonly clock: Clock; readonly liveArmed: () => boolean }
export type Actor = 'owner-telegram' | 'owner-server';
export function setTx(d: ConfigDeps, path: unknown, value: unknown, actor: Actor): PlanResult & { readonly versionId: number | null };
export function rollbackTx(d: ConfigDeps, actor: Actor): RollbackResult & { readonly versionId: number | null };
export function cancelPendingTx(d: ConfigDeps, path: unknown, actor: Actor): { readonly ok: boolean };
export function applyDueTx(d: ConfigDeps): DueResult & { readonly versionIds: readonly number[] };
// Phase 5: aiApproveTx(d, proposalId), reading the stored proposal and marking it approved in the same transaction.
```

Each is one transaction. It reads the full history (ascending, an unbroken stretch ending at the active version), the pending rows (each converted to number or bigint by its tunable's kind) and `liveStrategies` from strategy_modes. `ctx = { now: clock.now(), liveArmed: d.liveArmed(), liveStrategies }`. It calls the pure planner, then the shared writer:

```ts
function writeChangePlan(tx: Tx, active: ConfigVersion, p: ChangePlan, source: ChangeSource, now: number, undoTo?: number | null): number | null {
  for (const row of p.cancelled) repoConfig.deletePending(tx, row.path);   // exactly 1 each; before the inserts (PK)
  const v = p.applied.length > 0 ? nextVersion(active, p.values, source, now, undoTo ?? active.id) : null;
  if (v) repoConfig.insertVersion(tx, v);  // rollback with every field waiting: no version (contract M5)
  for (const row of p.pending) repoConfig.insertPending(tx, row);
  repoFlags.demote(tx, p.demote, now);     // live -> paper, changed_by 'auto-demote'
  repoFlags.restartGate(tx, p.restartGate, now);
  repoAudit.append(tx, { action: `config:${source}`, detail: { applied, pending, cancelled, kept, demote } });
  return v?.id ?? null;
}
```

- `rollbackTx` passes `undoTo = result.undoTo`.
- `applyDueTx` writes one version per step (author = the row's source, chained `active = v`), deletes each applied row and each stale row, applies the demotions and gate restarts, and audits. A ConfigError (a clock that stepped back makes `requestedAt > now`) rolls back and becomes a clock alert with entries off.
- Refusals are returned with no writes.
- The Telegram and email notice of a new pending loosening is sent after COMMIT.

### 3.5 Day-state observation (contract 1)

```ts
export function observeDayTx(deps: EngineDeps, mode: 'paper' | 'live',
  equity: Lamports | null, stopEquity: Lamports | null): EquityResult;
```

In one transaction:

1. `now = clock.now()`. Read `day_state[mode]`. A missing row or a shape other than 1 throws.
2. `equityAnHourAgo` = the `equity_snapshots` row of this mode nearest to now - 1 h with non-null equity. It comes from the DB, never from the caller (contract 6).
3. `policy` = built from the active config for the row's own `mode`: `mode: 'live'` is held to LIVE_CAPS (contract 9). It never comes from a caller.
4. `r = observeEquity(state, { now, equity, stopEquity, equityAnHourAgo }, policy)`.
5. UPDATE day_state with `r.state`. INSERT the equity_snapshots row.
6. For each trip, level-triggered: `equity-zero`, `sanity-max`, `sanity-bankroll`, `clock-backwards`, `peak-halt` and `daily-stop-twice` go into halt_reasons as `<trip>:<mode>` (INSERT OR IGNORE). `equity-jump` and `daily-stop` need no row: they are derived from the state (`jumpPending`, `dailyStopActive`).

A RiskError rolls back and is followed by a separate transaction that inserts `day-state-error:<mode>` into halt_reasons, plus an alert (contract 2). `confirmJumpTx`, `applyTransferTx`, `resumePeakTx` and `resumeStreakTx` have the same shape. The resumes delete their halt reason after appending the owner's audit row (the trigger requires it).

## 4. The K gate: exact API change to risk/approval.ts (stays pure)

```ts
/** The highest slot seen, from the chain stream and HTTP; null when unknown or stale. */
export interface SlotSource { currentSlot(): bigint | null }

/** What redeem validated: T2 records the order from this, never from the executor's objects. */
export interface RedeemSnapshot {
  readonly intentId: string; readonly positionId: string;
  readonly mode: PlanMode; readonly kind: PlanKind; readonly reduceOnly: boolean;
  readonly planHash: string; readonly maxSpendLamports: Lamports; readonly minOut: bigint;
  readonly expiresAtSlot: bigint;
  /** The slot redeem judged the expiry at (from the bound SlotSource). */
  readonly slot: bigint;
  /** The frozen, validated plan. */
  readonly plan: OrderPlan;
}
/** true: recorded now (first use). false: already used. Anything else, or a throw: refused. */
export interface TokenStore { consume(tokenId: string, snapshot: RedeemSnapshot): boolean }

export interface ApprovalOptions {
  readonly mode: PlanMode; readonly key: Uint8Array; readonly newTokenId: () => string; readonly planFreshSlots: number;
  readonly slots: SlotSource;   // NEW: bound once
  readonly store: TokenStore;   // NEW: bound once
}
export interface ApprovalIssuer { issue(plan: CheckedPlan): ApprovalToken }      // the slot argument is removed
export interface ApprovalVerifier {
  readonly mode: PlanMode;                                                      // so app/ can assert the wiring
  verify(token: ApprovalToken, plan: OrderPlan): readonly TokenProblem[];       // VerifyContext is removed
  redeem(token: ApprovalToken, plan: OrderPlan): RedeemResult;                  // the store argument is removed
}
export type TokenProblem = /* existing */ | 'slot-unknown';
```

Inside `createApprovalAuthority`:

- `slots.currentSlot` and `store.consume` are checked to be functions and copied once (`const readSlot = slots.currentSlot.bind(slots)`), so a later mutation of either object changes nothing.
- `slotNow()` calls `readSlot()` in a try. A throw or a non-u64 result gives null. Otherwise it returns `highest = max(highest, s)`: a ratchet, so a source that goes backwards can never lengthen a token's life.
- `issue` throws RiskError when the slot is null. `verify` and `redeem` return `slot-unknown`.
- `redeem` builds the frozen `RedeemSnapshot` from the parsed token and the validated plan, then calls `consume(id, snapshot)`. Only `true` counts, as today.

Call sites in approve.ts: `issuer.issue(checked.plan)` in approveBuy and approveExit. `BuyWorld.currentSlot` and `PlanContext.currentSlot` stay (the re-check's freshness); app/ fills them from the same SlotSource inside T1. The ratchet can only make the issuer's slot higher, which is stricter.

`app/authority.ts` is the only `createApprovalAuthority` call. It uses the core/rng key and token ids, `createSqliteTokenStore(db, clock)` and the shared SlotSource. The executor receives only `verifier`. `app/slots.ts` returns null when the newest slot is older than `maxAgeMs` (proposal: 10 s). The exit loop's P0 HTTP polling must feed it during DATA_STALE, or exits stall. The approval.ts tests move to the new API with an in-memory test store.

## 5. Test plan (tests first)

storage/ unit tests, on `':memory:'` and on a temp file in `mkdtempSync(path.join(os.tmpdir(), 'fomo-db-'))`, never under fomo-bot/data/:

- Open: the pragmas read back (wal, or memory for `':memory:'`; foreign_keys 1; synchronous FULL); a foreign application_id is refused; `create: false` on a missing file throws.
- Transaction:
  - commit;
  - a throw rolls back (row count and a logical dump are unchanged);
  - an async fn is refused and rolled back;
  - nesting is refused;
  - a leaked tx used after the end throws;
  - a forced ROLLBACK failure poisons the handle;
  - `number` params and REAL cells are refused.
- Codec (property, invariant 7):
  - fast-check bigint 0..2^64-1 and signed -(2^64-1)..2^64-1 round-trip exactly through a real column;
  - random strings (including '01', '-0', '1e3', ' 1', '', '1.5', '18446744073709551616' and Unicode digits): the SQL CHECK accepts exactly what the codec accepts (agreement property).
- Migrations:
  - fresh -> v1;
  - a second run is a no-op;
  - an edited migration (checksum) is refused;
  - a DB newer than the code is refused;
  - tables without schema_migrations are refused;
  - a failing migration rolls back only itself and the backup file exists;
  - quick_check and foreign_key_check are clean;
  - the pinned sha256 of migration 1 equals a constant;
  - no `\r` in any SQL.
- Constraints:
  - each partial unique index (a second active position on a mint fails, a closed one may share it; a second buy order ever fails; a second in-flight exit fails, one after `landed` passes);
  - every trigger;
  - every CHECK;
  - the DB copies (12, 4, 0.07 SOL, 25 slots) equal config/caps.ts.

Rollback leaves nothing (exhaustive fault injection): wrap `Tx` with a counter that throws at write k, for every k from 1 to the number of writes, in T1 buy (5 writes), T1 exit, T2, setTx, rollbackTx, applyDueTx and observeDayTx. Each time the logical dump is identical to before. A crash test: a child process opens a transaction, writes and calls `process.exit(1)` without COMMIT. On reopen nothing is persisted and quick_check is ok.

Races:

- Deterministic: connection A inside its transaction tries B's `transaction()` with a 100 ms busy timeout. It gets `busy`. After A commits, B re-runs and sees A's opening row, so the cap refuses.
- Parallel: 2-6 child processes, started on one barrier with the test flags, each runs approveBuyTx for a different mint when only one slot of room is left. Exactly one is approved, the rest are refused by cap or count, and the DB invariants hold. 50 seeded rounds (TEST_PLAN invariant 17).
- `fomo kill` from another process between ticks: the next T1 is refused with `kill`.

T1/T2 properties (on SQLite):

- invariant 1: no order without exactly one approved decision and a consumed, matching, unexpired token, even with a fake executor;
- invariants 2 and 17 over random portfolios;
- a duplicate intent gives `duplicate` and no second decision;
- a token missing from approvals is refused;
- a slot source that goes backwards does not revive an expired token;
- a slot source that is null or throws refuses issue and redeem.

Config and day state:

- random command sequences through the transactions match the pure plans;
- cancelled rows are gone in the same commit;
- an all-waiting rollback makes no version;
- a missing day_state row throws;
- a round trip of EquityState through the row is exact;
- trips become halt reasons level-triggered.

Secrets canary: put fake key-shaped values (a base58 64-byte key, a JSON 64-number array, a bot token, an RPC URL with api-key) into intents, inputs and reasons. Every write is refused, and a scan of every TEXT cell after a full scenario finds none.

Windows (the owner runs `npm test` in PowerShell):

- temp paths with a space and Greek letters;
- `path.join` only;
- close every handle before `rmSync(..., { maxRetries })` (EBUSY);
- backup names without colons;
- the 0600 assertion is skipped on win32 (the only skip);
- the parallel race uses child processes, which work on Windows.

Architecture test (new rules, see 6a):

- only `storage/sqlite.ts` imports `node:sqlite` (no such rule exists in tests/architecture/import-graph.test.ts today);
- only `app/authority.ts` calls `createApprovalAuthority`;
- a canary for each.

## 6. Failure modes

| What fails | Detected by | What the bot does |
|---|---|---|
| SQLITE_BUSY (CLI or backup holds the write lock over 5 s) | StorageError 'busy' at BEGIN IMMEDIATE | that T1 refused `storage-busy`, exits retried next tick; 3 in 10 min: DISK_DB, alert. The wait blocks the event loop (loop-lag monitor covers it) |
| Disk full / IOERR on a write or COMMIT | 'full' / 'io' | ROLLBACK; in-memory latch `entriesBlocked`; try to insert halt `disk-db`; alert sent directly, NOT via the DB outbox |
| ROLLBACK itself fails | caught in transaction() | handle poisoned: every call throws; latch; alert; controlled exit; restart runs the boot checks |
| Corruption, not a database | quick_check at boot and daily; 'corrupt' / 'not-a-database' at runtime | boot: refuse to start, alert with restore steps; runtime: latch + halt; never auto-restore; live (Phase 8) rebuilds from chain |
| Migration fails | its own transaction rolls back | refuse to start; earlier migrations and the pre-migration backup stay |
| Edited migration, or DB newer than code | checksum / version | refuse to start (rollback.sh restores the DB only if a migration ran) |
| Wrong or foreign file; WAL not possible (network share, odd FS) | application_id; journal_mode read back | refuse to open |
| Required row missing or a cell non-canonical | repo throws, codec throws | entries off, alert (tampering or a bug); never a default |
| Constraint or trigger fires in T1 or T2 | 'constraint' + RAISE text | rolled back, refusal recorded with a code; the "cannot fire if the parts agree" ones also alert as a bug |
| Async code or a leaked tx in a transaction | 'async-in-transaction' / 'tx-closed' | rolled back; alert (programming error) |
| Clock stepped back (pending row in the future, ms out of range) | ConfigError / CHECK | rolled back; clock alert; entries off |
| Slot source stale or unknown | SlotSource null | no token issued or redeemed; exits need the HTTP slot feed |
| Second instance | OS run lock (existing); BEGIN IMMEDIATE as the backstop | second exits; the money path stays serialized anyway |
| DB in a OneDrive-synced folder (native Windows) | path check at boot (heuristic) | warn and refuse in paper too (recommended), see owner item 3 |
| node:sqlite changes on a Node upgrade | storage tests on the pinned Node | Node pinned exactly; one replaceable file |

Never in the database:

- private keys, seed phrases, keypair arrays, the signer policy;
- API keys, RPC URLs (they can carry keys: store the provider id only);
- the Telegram bot token, `.env` content, environment variables;
- the per-boot HMAC key and token MACs;
- FOMO users' wallets, user tags and raw decode samples (D1);
- FOMO or Privy tokens;
- exception messages verbatim (they can echo inputs): only the error class plus a fixed code;
- transaction signatures in free text (typed `signature` columns arrive with T3).

Free text is reason codes only (`codeParam`). JSON columns are ASCII, at most 8 KiB, and pass `core/redact.ts assertNoSecrets`. It refuses base58 runs of 64 characters or more, hex runs of 64 or more (hashes live in typed hex64 columns), arrays of 64 small integers, PEM headers, `api-key`/`api_key`/`token=`, the bot-token shape, and URLs. A hit throws, so the write and its command are refused (fail closed). Backups hold the owner's Telegram id and wallet address later (THREAT_MODEL); they get file mode 0600.

## 7. Proposed split of step 6

Every sub-step's Definition of Done:

- `npm test` passes, output shown;
- `npm run typecheck` is clean;
- the architecture test passes;
- the coverage gate is extended to the new files;
- risk-guardian and security-auditor verdicts are in REVIEWS.md;
- STATUS.md is updated;
- the owner gets a plain-English summary;
- a commit; no new dependency.

The steps:

- **6a K gate (pure, first).** The approval.ts API of section 4, the approve.ts call sites, an in-memory test store, rewritten approval tests (the slot ratchet, `slot-unknown`, the store bound once, a hostile store or slot source, the snapshot equal to the validated plan). It closes K security findings 2 and 3 at the API level. Extra DoD: the security-auditor re-runs its K reproductions (`{consume: () => true}`, `currentSlot: 0n`) and both are refused.
- **6b Storage core.** `storage/sqlite.ts`, `storage/codec.ts`, `storage/migrations.ts` (runner only, plus a one-table test migration), the architecture rule for `node:sqlite`, and every test of section 5 that needs no schema: open, transaction, codec property and agreement, migrations, busy, crash, corruption, SQLITE_FULL via `max_page_count`, Windows paths. Extra DoD: the scratch confirmations of section 9 are recorded in VERIFIED_FACTS.md, with Windows rows run by the owner or marked UNVERIFIED.
- **6c Schema v1 and repositories.** `schema-v1.ts`, the six repo files, `core/redact.ts`, and the constraint tests (indexes, triggers, CHECKs, cap copies equal to caps.ts, the secrets canary on writes).
- **6d T1 and T2.** `core/rng.ts`, `app/authority.ts`, `app/slots.ts`, `app/snapshot.ts`, `app/approve-tx.ts` (buy, exit, abandon, recordRefusal), `app/token-store.ts`, `app/storage-boot.ts`. Tests: exhaustive fault injection, the deterministic and parallel races, invariants 1, 2 and 17 on SQLite, the KILL from another process. Extra DoD: the K gate is closed in REVIEWS.md (store bound, slot injected, T2 records from validated data), and the review L OPEN item is tested: the helper rent comes only from the chain read and positionExitBudget is never an allowance.
- **6e Day state and config transactions.** `app/day-tx.ts`, `app/config-tx.ts`, the audit chain, fault injection, sequence properties against the pure plans.

## 8. Decisions for the owner (plain English, each with a recommendation)

1. **How strategies start the first time.** Off, until you send /paper (fails closed), or already on paper. Recommended: off. Paper cannot lose money, but this way you choose when it starts.
2. **If the database breaks, exits stop too.** The rule "nothing happens before it is written down" means a broken database blocks new sell orders as well. In paper nothing real is at risk. For live money (Phase 8) we need an emergency path that does not depend on the database (for example the signer selling everything on KILL). Recommended: accept for paper; decide before Phase 8.
3. **On your own PC, keep the bot's data folder out of OneDrive and network drives.** Synced folders can damage this kind of database. Recommended: Docker Desktop (decision 11); natively, the bot refuses to start from such a folder.
4. **A halt is shared by paper and live.** A paper -50% halt would also stop live entries. This is stricter, and it only matters in Phase 8. Recommended: accept for now.

## 9. UNVERIFIED about node:sqlite (scratch test before code depends on it)

VERIFIED_FACTS line 142 already covers on Linux, Node 26.13.0: loading under the test flags, WAL, foreign keys, readBigInts, the >2^63-1 bind refusal, TEXT 2^64-1, the simple GLOB CHECK, a partial unique index, ROLLBACK, a second connection's BEGIN IMMEDIATE busy and its success after commit, and quick_check. Still to confirm:

- U1: the class name and options on 26.13.0 (`Database` vs the deprecated `DatabaseSync`; any runtime warning under the flags); `defensive` and `allowExtension` options.
- U2: `run()` result types with readBigInts (changes and lastInsertRowid as bigint?); COUNT(*) returned as bigint.
- U3: whether a JS `number` param binds as INTEGER or REAL. We refuse numbers, but confirm that nothing slips through `exec`.
- U4: an `isTransaction`-style getter exists, and its name.
- U5: STRICT tables on 3.54 together with the stricter CHECK fragments: the canonical no-leading-zero rule, the 20-digit u64 bound by text comparison, the signed form, and GLOB classes with a trailing `-` (`[^A-Za-z0-9_-]`) and the range `[^ -~]`.
- U6: the error object shape (`code`, `errcode`, `errstr`) for CHECK, UNIQUE (the partial-index message text) and `RAISE(ABORT, ...)` from triggers.
- U7: `VACUUM INTO` on a WAL database with an open connection (synchronous, consistent output; file mode on Linux; fails if the target exists).
- U8: `PRAGMA max_page_count` gives SQLITE_FULL (our disk-full simulation); `PRAGMA application_id` set and read back; `trusted_schema` and `synchronous = FULL` take effect.
- U9: `exec()` runs a multi-statement migration script, including CREATE TRIGGER ... BEGIN ... END.
- U10: the busy timeout across PROCESSES, not only connections, and child processes under `--frozen-intrinsics` opening the same file.
- U11: Windows: WAL with -shm on NTFS, deleting files after `close()` (EBUSY), non-ASCII (Greek) and space-containing paths, `':memory:'` journal_mode returning `memory`.
- U12: `ALTER TABLE ... ADD COLUMN` with NOT NULL DEFAULT and CHECK on a STRICT table (future migrations).
- U13: `json_valid` available in the bundled build.
- U14: the async `backup()` signature (for the later daily backup).

## 10. Inconsistencies found while reading (for the main session)

- `portfolio/ledger.ts` `PositionStatus` has no `'stuck'`. ARCHITECTURE s.3, approve.ts and this schema do. One must change before T3.
- The architecture test does not yet enforce "only storage/sqlite.ts imports node:sqlite" (TEST_PLAN line 103 wants it). Added to 6b.
- ARCHITECTURE s.7 lists config_versions columns "parent, active". changes.ts uses `undoTo`, and the active version is the newest, so this design has no active column. s.7 should be updated.
- ARCHITECTURE s.4's in-flight index is `kind = 'sell'`. I propose sell plus close-account (one exit in flight per position, as s.12 says). This is stricter.
- `fomo apply-pending` (apply now at the server) has no pure plan in changes.ts. It must never be built by passing a faked `now`. It needs a reviewed `planApplyNow` (open).
- When a due pending row from a `/rollback` applies, `applyDuePending` makes a version with the default `undoTo = active.id`. Whether that keeps invariant 11 ("restores the earlier values exactly") with rollback chains needs a risk-guardian ruling.
- The exit fee-budget inputs (`budgetLeft`, `automaticStopped`) have no stored source until T3's cost lines exist.
- Phase 8: T1 must read the intent mode's own SOL and exposure, while one-per-mint and the 4-position trigger stay global (stricter).

Key files the main session will touch when merging: /home/user/samsulek/fomo-bot/docs/ARCHITECTURE.md (s.4, s.7, s.12), /home/user/samsulek/fomo-bot/src/risk/approval.ts, /home/user/samsulek/fomo-bot/src/risk/approve.ts, /home/user/samsulek/fomo-bot/tests/architecture/import-graph.test.ts, /home/user/samsulek/fomo-bot/docs/VERIFIED_FACTS.md (section 9 results), /home/user/samsulek/fomo-bot/docs/REVIEWS.md (K gate closure).