// Migration 1: the step 6 schema (STORAGE_DESIGN.md s.2, with the changes of s.11). Every table
// is STRICT, and every rule here is a tripwire under the code's own checks (s.2.2 says which rule
// lives where). The SQL is built once from the codec fragments and literal lists, and its sha256
// is pinned in a test: a released migration never changes, so a stricter rule or a fragment fix
// needs a new migration. The SQL carries no comments (scripts may not); the notes are here:
// - the literals copied from config/caps.ts and config/changes.ts (4 active positions, 12 entries
//   a day, 0.07 SOL for a buy, 25 slots of freshness, the 24 h wait) and the lists copied from
//   core/ids and risk/plan are compared with their sources in tests; the 4-position and entry
//   limits count paper and live together (stricter, review L);
// - the version table belongs to the runner (migrations.ts), not to this file;
// - strategies start switched off (owner decision D5); a mode becomes live only through /golive;
// - day_state starts as emptyEquityState() for both modes; ledger rows and config version 1 are
//   written by the owner's one-time setup (step 6d), never by a migration;
// - KILL is cleared, and a halt lifted, only while the newest audit row of all is the owner's own
//   command, written after the KILL or halt was set: each names the newest audit id at that moment
//   and the owner's row must have a larger id (audit ids and hashes run in order). Ids, not clock
//   times, give the order, so a clock that steps forward or back can neither block a KILL, a halt
//   or the owner's command nor let an old row stand in (reviews P, security P-R1). A halt is lifted
//   by the server's reset; the paper peak halt and the paper streak halt also by the owner's
//   resumes from Telegram, the live ones only at the server (decision D4, and the 24 h wait of a
//   live /resume arrives in Phase 8); an action of the server or the owner must carry that actor;
// - times are recorded, never ordered across rows (a protective write must never fail on a clock
//   fault); within a row only a token's use after its issue is checked (a retry gets a new token);
// - a token needs an approved decision for its own intent, position and mode, and the position
//   must be able to take the order (a buy only while it opens, an exit only while it holds tokens);
// - append-only tables refuse UPDATE and DELETE; with recursive triggers on (storage/sqlite.ts),
//   INSERT OR REPLACE cannot delete past those guards either.
import { bool, code, day, hex64, id, int, json, ms, msOrNull, signed, slot, u64, u64AtMost, u64NotAbove, u64OrNull } from './codec.ts';
import type { Migration } from './migrations.ts';

/** The values this schema copies, for the tests that tie them to their sources. */
export const SCHEMA_V1_COPIES = Object.freeze({
  openPositions: 4,
  entriesPerDay: 12,
  buyMaxSpendLamports: 70_000_000n,
  planFreshSlots: 25,
  looseningDelayMs: 86_400_000,
  strategies: Object.freeze(['crowdflow', 'momentum', 'launch'] as const),
  modes: Object.freeze(['paper', 'live'] as const),
  orderKinds: Object.freeze(['buy', 'sell', 'close-account'] as const),
  urgencies: Object.freeze(['normal', 'protective', 'emergency'] as const),
});

const C = SCHEMA_V1_COPIES;
/**
 * A literal list for IN: only plain code-like words, so no value can break out of its quotes (review
 * P, security 9). Exported for its test only.
 */
export function inList(values: readonly string[]): string {
  if (values.length === 0) {
    throw new Error('schema-v1: an IN list is never empty');
  }
  for (const v of values) {
    if (typeof v !== 'string' || !/^[a-z0-9:._-]+$/.test(v)) {
      throw new Error('schema-v1: an IN list holds only plain words');
    }
  }
  return `(${values.map((v) => `'${v}'`).join(', ')})`;
}
const list = inList;
const oneOf = (c: string, values: readonly string[]): string => `(${c} IN ${list(values)})`;
const orNull = (c: string, check: string): string => `(${c} IS NULL OR ${check})`;
const STRATEGIES = C.strategies;
const MODES = C.modes;
const ACTIVE = ['opening', 'open', 'exiting', 'stuck'] as const;
const raise = (message: string): string => `BEGIN SELECT RAISE(ABORT, '${message}'); END;`;
const never = (table: string, what: 'UPDATE' | 'DELETE', message: string): string =>
  `CREATE TRIGGER ${table}_no_${what.toLowerCase()} BEFORE ${what} ON ${table}\n  ${raise(message)}`;
/**
 * The newest audit row of all (ids are consecutive) came after audit id `since` and matches
 * `condition`: a halt or KILL is lifted only right after the owner's own command, never by an older
 * row, and no clock reading takes part (review P, risk 5 and security P-R1).
 */
const ownerAudited = (since: string, condition: string): string =>
  `(SELECT count(*) FROM (SELECT id, action, actor FROM audit_log ORDER BY id DESC LIMIT 1) AS newest WHERE newest.id > ${since} AND (${condition})) = 1`;
/** The id of the newest audit row (0 before the first): what a KILL or a halt names when it is set. */
const NEWEST_AUDIT_ID = '(SELECT coalesce(max(id), 0) FROM audit_log)';
const AUDIT_ID_MAX = Number.MAX_SAFE_INTEGER;
const SERVER = "newest.actor = 'owner-server'";
const OWNER = "newest.actor IN ('owner-telegram', 'owner-server')";
/** The position may take this order now: a buy only while it opens, an exit only while it holds tokens. */
const activeFor = (kind: string, status: string): string =>
  `((${kind} = 'buy' AND ${status} = 'opening') OR (${kind} IN ('sell', 'close-account') AND ${status} IN ('open', 'exiting', 'stuck')))`;
const GENESIS = '0'.repeat(64);

const SQL = [
  // ---- config: ConfigVersion and PendingChange of config/changes.ts
  `CREATE TABLE config_versions (
  id INTEGER PRIMARY KEY CHECK (id >= 1),
  created_at INTEGER NOT NULL CHECK ${ms('created_at')},
  author TEXT NOT NULL CHECK ${oneOf('author', ['default', 'owner', 'ai-approved', 'rollback'])},
  values_json TEXT NOT NULL CHECK ${json('values_json')},
  changed_json TEXT NOT NULL CHECK ${json('changed_json')},
  undo_to INTEGER REFERENCES config_versions (id),
  CHECK ((id = 1) = (author = 'default')),
  CHECK (undo_to IS NULL OR undo_to < id),
  CHECK (id <> 1 OR (undo_to IS NULL AND changed_json = '[]'))
) STRICT;`,
  `CREATE TRIGGER config_versions_in_order BEFORE INSERT ON config_versions
  WHEN NEW.id IS NOT (SELECT coalesce(max(id), 0) + 1 FROM config_versions)
  ${raise('config versions are made in order')}`,
  never('config_versions', 'UPDATE', 'config versions are never changed'),
  never('config_versions', 'DELETE', 'config versions are never deleted'),
  `CREATE TABLE pending_changes (
  path TEXT NOT NULL PRIMARY KEY CHECK (typeof(path) = 'text' AND octet_length(path) = length(path) AND length(path) BETWEEN 3 AND 64 AND path GLOB '[a-z]*.[a-zA-Z]*' AND path NOT GLOB '*.*.*' AND path NOT GLOB '*[^a-zA-Z0-9.]*'),
  from_value TEXT NOT NULL CHECK ${u64('from_value')},
  to_value TEXT NOT NULL CHECK ${u64('to_value')},
  source TEXT NOT NULL CHECK ${oneOf('source', ['owner', 'ai-approved', 'rollback'])},
  requested_at INTEGER NOT NULL CHECK ${ms('requested_at')},
  apply_at INTEGER NOT NULL CHECK ${ms('apply_at')},
  CHECK (apply_at - requested_at >= ${C.looseningDelayMs})
) STRICT;`,
  never('pending_changes', 'UPDATE', 'a pending change is replaced, never changed'),

  // ---- flags, halts, modes, bans, counts
  `CREATE TABLE flags (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  kill INTEGER NOT NULL CHECK ${bool('kill')},
  kill_at INTEGER CHECK ${msOrNull('kill_at')},
  kill_source TEXT CHECK ${orNull('kill_source', oneOf('kill_source', ['cli', 'telegram', 'sentinel']))},
  kill_audit_id INTEGER CHECK ${orNull('kill_audit_id', int('kill_audit_id', 0, AUDIT_ID_MAX))},
  paused INTEGER NOT NULL CHECK ${bool('paused')},
  paused_at INTEGER CHECK ${msOrNull('paused_at')},
  entries_stopped INTEGER NOT NULL CHECK ${bool('entries_stopped')},
  halt_cleared_at INTEGER CHECK ${msOrNull('halt_cleared_at')},
  updated_at INTEGER NOT NULL CHECK ${ms('updated_at')},
  CHECK ((kill = 1) = (kill_at IS NOT NULL)),
  CHECK ((kill = 1) = (kill_source IS NOT NULL)),
  CHECK ((kill = 1) = (kill_audit_id IS NOT NULL)),
  CHECK ((paused = 1) = (paused_at IS NOT NULL))
) STRICT;`,
  'INSERT INTO flags (id, kill, kill_at, kill_source, kill_audit_id, paused, paused_at, entries_stopped, halt_cleared_at, updated_at) VALUES (1, 0, NULL, NULL, NULL, 0, NULL, 0, NULL, 0);',
  never('flags', 'DELETE', 'the flags row is never deleted'),
  `CREATE TRIGGER flags_kill_fixed BEFORE UPDATE OF kill_at, kill_source, kill_audit_id ON flags
  WHEN OLD.kill = 1 AND NEW.kill = 1 AND (NEW.kill_at IS NOT OLD.kill_at OR NEW.kill_source IS NOT OLD.kill_source OR NEW.kill_audit_id IS NOT OLD.kill_audit_id)
  ${raise('a KILL keeps its time, source and audit row')}`,
  `CREATE TABLE halt_reasons (
  reason TEXT NOT NULL PRIMARY KEY CHECK ${code('reason')},
  set_at INTEGER NOT NULL CHECK ${ms('set_at')},
  set_audit_id INTEGER NOT NULL CHECK ${int('set_audit_id', 0, AUDIT_ID_MAX)}
) STRICT;`,
  never('halt_reasons', 'UPDATE', 'a halt reason is never changed'),
  `CREATE TABLE strategy_modes (
  strategy TEXT NOT NULL PRIMARY KEY CHECK ${oneOf('strategy', STRATEGIES)},
  mode TEXT NOT NULL CHECK ${oneOf('mode', ['off', 'paper', 'live'])},
  changed_at INTEGER NOT NULL CHECK ${ms('changed_at')},
  changed_by TEXT NOT NULL CHECK ${oneOf('changed_by', ['migration', 'owner-off', 'owner-paper', 'owner-golive', 'auto-demote'])},
  gate_since INTEGER NOT NULL CHECK ${ms('gate_since')},
  CHECK (mode <> 'live' OR changed_by = 'owner-golive')
) STRICT;`,
  `INSERT INTO strategy_modes (strategy, mode, changed_at, changed_by, gate_since) VALUES ${STRATEGIES.map((s) => `('${s}', 'off', 0, 'migration', 0)`).join(', ')};`,
  never('strategy_modes', 'DELETE', 'strategy modes are never deleted'),
  `CREATE TABLE entry_bans (
  kind TEXT NOT NULL CHECK ${oneOf('kind', ['mint-cooldown', 'mint-ban', 'creator-ban', 'strategy-pause', 'strategy-off'])},
  key TEXT NOT NULL CHECK ${id('key')},
  until INTEGER CHECK ${msOrNull('until')},
  reason TEXT NOT NULL CHECK ${code('reason')},
  set_at INTEGER NOT NULL CHECK ${ms('set_at')},
  PRIMARY KEY (kind, key),
  CHECK ((until IS NULL) = (kind IN ('mint-ban', 'creator-ban'))),
  CHECK (kind NOT IN ('strategy-pause', 'strategy-off') OR key IN ${list(STRATEGIES)})
) STRICT;`,
  `CREATE TRIGGER entry_bans_kept BEFORE UPDATE ON entry_bans
  WHEN OLD.kind IN ('mint-ban', 'creator-ban') OR NEW.kind IS NOT OLD.kind OR NEW.key IS NOT OLD.key OR NEW.until < OLD.until
  ${raise('a ban stays, and a cooldown is never shortened')}`,
  `CREATE TRIGGER entry_bans_permanent BEFORE DELETE ON entry_bans WHEN OLD.kind IN ('mint-ban', 'creator-ban')
  ${raise('a ban stays')}`,
  `CREATE TABLE entry_counts (
  day TEXT NOT NULL PRIMARY KEY CHECK ${day('day')},
  count INTEGER NOT NULL CHECK ${int('count', 1, C.entriesPerDay)}
) STRICT;`,
  `CREATE TRIGGER entry_counts_first BEFORE INSERT ON entry_counts WHEN NEW.count <> 1
  ${raise('a day starts at one entry')}`,
  `CREATE TRIGGER entry_counts_step BEFORE UPDATE ON entry_counts WHEN NEW.count <> OLD.count + 1 OR NEW.day <> OLD.day
  ${raise('entries count up by exactly one')}`,
  never('entry_counts', 'DELETE', 'entry counts are kept'),

  // ---- day state: EquityState of risk/daystate.ts, one row per ledger mode
  `CREATE TABLE day_state (
  mode TEXT NOT NULL PRIMARY KEY CHECK ${oneOf('mode', MODES)},
  shape INTEGER NOT NULL CHECK (shape = 1),
  day TEXT CHECK ${orNull('day', day('day'))},
  day_start TEXT NOT NULL CHECK ${u64('day_start')},
  last_equity TEXT NOT NULL CHECK ${u64('last_equity')},
  peak TEXT CHECK ${u64OrNull('peak')},
  jump_pending INTEGER NOT NULL CHECK ${bool('jump_pending')},
  jump_held_equity TEXT CHECK ${u64OrNull('jump_held_equity')},
  jump_held_at INTEGER CHECK ${msOrNull('jump_held_at')},
  jump_ack_equity TEXT CHECK ${u64OrNull('jump_ack_equity')},
  jump_ack_at INTEGER CHECK ${msOrNull('jump_ack_at')},
  daily_stop_day TEXT CHECK ${orNull('daily_stop_day', day('daily_stop_day'))},
  daily_stop_streak INTEGER NOT NULL CHECK ${int('daily_stop_streak', 0, 1_000_000)},
  streak_halt INTEGER NOT NULL CHECK ${bool('streak_halt')},
  updated_at INTEGER NOT NULL CHECK ${ms('updated_at')},
  CHECK ((jump_held_equity IS NULL) = (jump_held_at IS NULL)),
  CHECK ((jump_ack_equity IS NULL) = (jump_ack_at IS NULL)),
  CHECK (jump_pending = (jump_held_equity IS NOT NULL))
) STRICT;`,
  `INSERT INTO day_state (mode, shape, day, day_start, last_equity, peak, jump_pending, jump_held_equity, jump_held_at, jump_ack_equity, jump_ack_at, daily_stop_day, daily_stop_streak, streak_halt, updated_at) VALUES ${MODES.map((m) => `('${m}', 1, NULL, '0', '0', NULL, 0, NULL, NULL, NULL, NULL, NULL, 0, 0, 0)`).join(', ')};`,
  never('day_state', 'DELETE', 'day state is never deleted'),
  `CREATE TABLE equity_snapshots (
  mode TEXT NOT NULL CHECK ${oneOf('mode', MODES)},
  at INTEGER NOT NULL CHECK ${ms('at')},
  equity TEXT CHECK ${u64OrNull('equity')},
  stop_equity TEXT CHECK ${u64OrNull('stop_equity')},
  PRIMARY KEY (mode, at)
) STRICT;`,
  never('equity_snapshots', 'UPDATE', 'an equity snapshot is never changed'),

  // ---- the book: ledger accounts and positions (the Position of portfolio/ledger.ts plus mode, stuck, max_spend, p95, exit_seq)
  `CREATE TABLE ledger_accounts (
  mode TEXT NOT NULL PRIMARY KEY CHECK ${oneOf('mode', MODES)},
  sol TEXT NOT NULL CHECK ${u64('sol')},
  total_deposits TEXT NOT NULL CHECK ${u64('total_deposits')},
  total_withdrawals TEXT NOT NULL CHECK ${u64('total_withdrawals')},
  updated_at INTEGER NOT NULL CHECK ${ms('updated_at')}
) STRICT;`,
  never('ledger_accounts', 'DELETE', 'ledger accounts are never deleted'),
  `CREATE TRIGGER ledger_accounts_identity BEFORE UPDATE OF mode ON ledger_accounts
  ${raise('a ledger account keeps its mode')}`,
  `CREATE TABLE positions (
  id TEXT NOT NULL PRIMARY KEY CHECK ${id('id')},
  mint TEXT NOT NULL CHECK ${id('mint')},
  strategy TEXT NOT NULL CHECK ${oneOf('strategy', STRATEGIES)},
  mode TEXT NOT NULL CHECK ${oneOf('mode', MODES)},
  status TEXT NOT NULL CHECK ${oneOf('status', [...ACTIVE, 'closed'])},
  opened_at INTEGER NOT NULL CHECK ${ms('opened_at')},
  closed_at INTEGER CHECK ${msOrNull('closed_at')},
  max_spend TEXT CHECK ${orNull('max_spend', u64AtMost('max_spend', C.buyMaxSpendLamports))},
  p95_exit_cost TEXT NOT NULL CHECK ${u64('p95_exit_cost')},
  exit_seq INTEGER NOT NULL DEFAULT 0 CHECK ${int('exit_seq', 0, 1_000_000)},
${[
  ['token_units', u64],
  ['cost_basis', u64],
  ['rent_locked', u64],
  ['realized', signed],
  ['bought', u64],
  ['sold', u64],
  ['venue_fees', u64],
  ['network_fees', u64],
  ['failed_fees', u64],
  ['tips', u64],
  ['rent_paid', u64],
  ['rent_refunded', u64],
  ['tokens_bought', u64],
  ['tokens_sold', u64],
  ['exit_fees', u64],
  ['basis_released', u64],
]
  .map(([column, check]) => `  ${column as string} TEXT NOT NULL DEFAULT '0' CHECK ${(check as (c: string) => string)(column as string)},`)
  .join('\n')}
  updated_at INTEGER NOT NULL CHECK ${ms('updated_at')},
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CHECK (status <> 'opening' OR max_spend IS NOT NULL)
) STRICT;`,
  `CREATE UNIQUE INDEX positions_one_per_mint ON positions (mint) WHERE status IN ${list(ACTIVE)};`,
  `CREATE TRIGGER positions_born_opening BEFORE INSERT ON positions WHEN NEW.status <> 'opening'
  ${raise('a position starts as opening')}`,
  `CREATE TRIGGER positions_cap BEFORE INSERT ON positions
  WHEN (SELECT count(*) FROM positions WHERE status IN ${list(ACTIVE)}) >= ${C.openPositions}
  ${raise(`more than ${C.openPositions} active positions`)}`,
  `CREATE TRIGGER positions_identity BEFORE UPDATE OF id, mint, strategy, mode, opened_at ON positions
  ${raise('a position keeps its identity')}`,
  `CREATE TRIGGER positions_closed_final BEFORE UPDATE ON positions WHEN OLD.status = 'closed'
  ${raise('a closed position is final')}`,
  `CREATE TRIGGER positions_no_reopening BEFORE UPDATE OF status ON positions WHEN NEW.status = 'opening' AND OLD.status <> 'opening'
  ${raise('a position never goes back to opening')}`,
  never('positions', 'DELETE', 'positions are kept'),

  // ---- the money path: intents, decisions, tokens, orders
  `CREATE TABLE intents (
  id TEXT NOT NULL PRIMARY KEY CHECK ${id('id')},
  kind TEXT NOT NULL CHECK ${oneOf('kind', ['entry', 'exit'])},
  mode TEXT NOT NULL CHECK ${oneOf('mode', MODES)},
  strategy TEXT CHECK ${orNull('strategy', oneOf('strategy', STRATEGIES))},
  mint TEXT NOT NULL CHECK ${id('mint')},
  position_id TEXT NOT NULL CHECK ${id('position_id')},
  size_hint TEXT CHECK ${orNull('size_hint', oneOf('size_hint', ['min', 'normal']))},
  confidence_bps INTEGER CHECK ${orNull('confidence_bps', int('confidence_bps', 0, 10_000))},
  exit_seq INTEGER CHECK ${orNull('exit_seq', int('exit_seq', 0, 1_000_000))},
  fraction_bps INTEGER CHECK ${orNull('fraction_bps', int('fraction_bps', 1, 10_000))},
  urgency TEXT CHECK ${orNull('urgency', oneOf('urgency', C.urgencies))},
  created_at INTEGER NOT NULL CHECK ${ms('created_at')},
  inputs_as_of INTEGER CHECK ${msOrNull('inputs_as_of')},
  reasons_json TEXT NOT NULL CHECK ${json('reasons_json')},
  inputs_json TEXT NOT NULL CHECK ${json('inputs_json')},
  CHECK ((kind = 'entry') = (strategy IS NOT NULL)),
  CHECK ((kind = 'entry') = (size_hint IS NOT NULL)),
  CHECK (kind = 'entry' OR confidence_bps IS NULL),
  CHECK ((kind = 'exit') = (exit_seq IS NOT NULL)),
  CHECK ((kind = 'exit') = (fraction_bps IS NOT NULL)),
  CHECK ((kind = 'exit') = (urgency IS NOT NULL))
) STRICT;`,
  "CREATE UNIQUE INDEX intents_one_per_exit_seq ON intents (position_id, exit_seq) WHERE kind = 'exit';",
  never('intents', 'UPDATE', 'intents are never changed'),
  never('intents', 'DELETE', 'intents are never deleted'),
  `CREATE TABLE risk_decisions (
  intent_id TEXT NOT NULL PRIMARY KEY REFERENCES intents (id),
  at INTEGER NOT NULL CHECK ${ms('at')},
  approved INTEGER NOT NULL CHECK ${bool('approved')},
  stage TEXT CHECK ${orNull('stage', oneOf('stage', ['blocked', 'sizing', 'plan', 'duplicate', 'error']))},
  reasons_json TEXT NOT NULL CHECK ${json('reasons_json')},
  size TEXT CHECK ${u64OrNull('size')},
  limited_by TEXT CHECK ${orNull('limited_by', code('limited_by'))},
  binding TEXT CHECK ${orNull('binding', code('binding'))},
  slot INTEGER NOT NULL CHECK ${slot('slot')},
  config_version INTEGER NOT NULL REFERENCES config_versions (id),
  CHECK ((approved = 1) = (stage IS NULL))
) STRICT;`,
  never('risk_decisions', 'UPDATE', 'decisions are never changed'),
  never('risk_decisions', 'DELETE', 'decisions are never deleted'),
  `CREATE TABLE approvals (
  token_id TEXT NOT NULL PRIMARY KEY CHECK ${id('token_id')},
  intent_id TEXT NOT NULL UNIQUE REFERENCES risk_decisions (intent_id),
  position_id TEXT NOT NULL REFERENCES positions (id),
  mode TEXT NOT NULL CHECK ${oneOf('mode', MODES)},
  kind TEXT NOT NULL CHECK ${oneOf('kind', C.orderKinds)},
  reduce_only INTEGER NOT NULL CHECK ${bool('reduce_only')},
  plan_hash TEXT NOT NULL CHECK ${hex64('plan_hash')},
  max_spend TEXT NOT NULL CHECK ${u64('max_spend')},
  min_out TEXT NOT NULL CHECK ${u64('min_out')},
  quote_slot INTEGER NOT NULL CHECK ${slot('quote_slot')},
  expires_at_slot INTEGER NOT NULL CHECK ${slot('expires_at_slot')},
  issued_at INTEGER NOT NULL CHECK ${ms('issued_at')},
  consumed_at INTEGER CHECK ${msOrNull('consumed_at')},
  consumed_slot INTEGER CHECK ${orNull('consumed_slot', slot('consumed_slot'))},
  CHECK (reduce_only = (kind IN ('sell', 'close-account'))),
  CHECK (kind <> 'buy' OR ${u64AtMost('max_spend', C.buyMaxSpendLamports)}),
  CHECK (expires_at_slot >= quote_slot AND expires_at_slot - quote_slot <= ${C.planFreshSlots}),
  CHECK ((consumed_at IS NULL) = (consumed_slot IS NULL)),
  CHECK (consumed_at IS NULL OR consumed_at >= issued_at),
  CHECK (consumed_slot IS NULL OR (consumed_slot >= quote_slot AND consumed_slot <= expires_at_slot))
) STRICT;`,
  `CREATE TRIGGER approvals_for_approved_intent BEFORE INSERT ON approvals
  WHEN NOT EXISTS (SELECT 1 FROM risk_decisions AS d JOIN intents AS i ON i.id = d.intent_id JOIN positions AS p ON p.id = NEW.position_id
    WHERE d.intent_id = NEW.intent_id AND d.approved = 1 AND i.mode = NEW.mode AND i.position_id = NEW.position_id
      AND i.mint = p.mint AND p.mode = NEW.mode AND ((i.kind = 'entry') = (NEW.kind = 'buy')) AND ${activeFor('NEW.kind', 'p.status')})
  ${raise('a token needs an approved decision for its own intent, position and mode')}`,
  `CREATE TRIGGER approvals_consumed_while_active BEFORE UPDATE OF consumed_at ON approvals
  WHEN NEW.consumed_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM positions AS p WHERE p.id = NEW.position_id AND ${activeFor('NEW.kind', 'p.status')})
  ${raise('a token is consumed only while its position may take the order')}`,
  `CREATE TRIGGER approvals_single_use BEFORE UPDATE ON approvals
  WHEN OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
    OR NEW.token_id IS NOT OLD.token_id OR NEW.intent_id IS NOT OLD.intent_id OR NEW.position_id IS NOT OLD.position_id
    OR NEW.mode IS NOT OLD.mode OR NEW.kind IS NOT OLD.kind OR NEW.reduce_only IS NOT OLD.reduce_only
    OR NEW.plan_hash IS NOT OLD.plan_hash OR NEW.max_spend IS NOT OLD.max_spend OR NEW.min_out IS NOT OLD.min_out
    OR NEW.quote_slot IS NOT OLD.quote_slot OR NEW.expires_at_slot IS NOT OLD.expires_at_slot OR NEW.issued_at IS NOT OLD.issued_at
  ${raise('a token is consumed once and otherwise never changed')}`,
  never('approvals', 'DELETE', 'tokens are kept'),
  `CREATE TABLE orders (
  id TEXT NOT NULL PRIMARY KEY CHECK ${id('id')},
  intent_id TEXT NOT NULL UNIQUE REFERENCES intents (id),
  token_id TEXT NOT NULL UNIQUE REFERENCES approvals (token_id),
  position_id TEXT NOT NULL REFERENCES positions (id),
  mode TEXT NOT NULL CHECK ${oneOf('mode', MODES)},
  kind TEXT NOT NULL CHECK ${oneOf('kind', C.orderKinds)},
  status TEXT NOT NULL CHECK ${oneOf('status', ['approved', 'submitted', 'landed', 'failed', 'expired'])},
  plan_hash TEXT NOT NULL CHECK ${hex64('plan_hash')},
  plan_json TEXT NOT NULL CHECK ${json('plan_json')},
  in_amount TEXT NOT NULL CHECK ${u64('in_amount')},
  min_out TEXT NOT NULL CHECK ${u64('min_out')},
  max_spend TEXT NOT NULL CHECK ${u64('max_spend')},
  quote_slot INTEGER NOT NULL CHECK ${slot('quote_slot')},
  created_at INTEGER NOT NULL CHECK ${ms('created_at')},
  updated_at INTEGER NOT NULL CHECK ${ms('updated_at')},
  CHECK (kind <> 'buy' OR ${u64NotAbove('in_amount', 'max_spend')})
) STRICT;`,
  "CREATE UNIQUE INDEX orders_one_buy_per_position ON orders (position_id) WHERE kind = 'buy';",
  "CREATE UNIQUE INDEX orders_one_exit_in_flight ON orders (position_id) WHERE kind IN ('sell', 'close-account') AND status IN ('approved', 'submitted');",
  `CREATE TRIGGER orders_need_consumed_token BEFORE INSERT ON orders
  WHEN NEW.status <> 'approved' OR NOT EXISTS (SELECT 1 FROM approvals AS a WHERE a.token_id = NEW.token_id AND a.consumed_at IS NOT NULL
    AND a.intent_id = NEW.intent_id AND a.position_id = NEW.position_id AND a.mode = NEW.mode AND a.kind = NEW.kind
    AND a.plan_hash = NEW.plan_hash AND a.max_spend = NEW.max_spend AND a.min_out = NEW.min_out AND a.quote_slot = NEW.quote_slot)
    OR NOT EXISTS (SELECT 1 FROM positions AS p WHERE p.id = NEW.position_id AND p.mode = NEW.mode AND ${activeFor('NEW.kind', 'p.status')})
  ${raise('an order needs its consumed, matching token and a position that may take it')}`,
  `CREATE TRIGGER orders_status_forward BEFORE UPDATE OF status ON orders
  WHEN NOT ((OLD.status = 'approved' AND NEW.status IN ('submitted', 'failed', 'expired'))
         OR (OLD.status = 'submitted' AND NEW.status IN ('landed', 'failed', 'expired')))
  ${raise('order status moves forward only')}`,
  `CREATE TRIGGER orders_identity BEFORE UPDATE OF id, intent_id, token_id, position_id, mode, kind, plan_hash, plan_json, in_amount, min_out, max_spend, quote_slot, created_at ON orders
  ${raise('an order is never changed but for its status')}`,
  never('orders', 'DELETE', 'orders are kept'),

  // ---- audit: config commands and dangerous commands, hash-chained by the repository
  `CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL CHECK ${ms('at')},
  actor TEXT NOT NULL CHECK ${oneOf('actor', ['owner-telegram', 'owner-server', 'engine', 'ai'])},
  action TEXT NOT NULL CHECK ${code('action')},
  detail_json TEXT NOT NULL CHECK ${json('detail_json')},
  prev_hash TEXT NOT NULL CHECK ${hex64('prev_hash')},
  hash TEXT NOT NULL UNIQUE CHECK ${hex64('hash')},
  CHECK ((action GLOB 'server:*' AND actor = 'owner-server') OR (action GLOB 'owner:*' AND actor IN ('owner-telegram', 'owner-server'))
      OR (action GLOB 'engine:*' AND actor = 'engine') OR (action GLOB 'ai:*' AND actor = 'ai'))
) STRICT;`,
  `CREATE TRIGGER audit_log_in_order BEFORE INSERT ON audit_log
  WHEN NEW.id IS NOT (SELECT coalesce(max(id), 0) + 1 FROM audit_log)
    OR NEW.prev_hash IS NOT coalesce((SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1), '${GENESIS}')
  ${raise('audit rows are appended in order, each naming the hash before it')}`,
  `CREATE TRIGGER flags_kill_names_audit BEFORE UPDATE OF kill ON flags
  WHEN OLD.kill = 0 AND NEW.kill = 1 AND NEW.kill_audit_id IS NOT ${NEWEST_AUDIT_ID}
  ${raise('a KILL names the newest audit row')}`,
  `CREATE TRIGGER halt_reasons_names_audit BEFORE INSERT ON halt_reasons
  WHEN NEW.set_audit_id IS NOT ${NEWEST_AUDIT_ID}
  ${raise('a halt names the newest audit row')}`,
  never('audit_log', 'UPDATE', 'the audit log is append-only'),
  never('audit_log', 'DELETE', 'the audit log is append-only'),
  `CREATE TRIGGER flags_kill_clear BEFORE UPDATE OF kill ON flags
  WHEN OLD.kill = 1 AND NEW.kill = 0 AND NOT ${ownerAudited('OLD.kill_audit_id', `newest.action = 'server:clear-kill' AND ${SERVER}`)}
  ${raise('KILL is cleared only by the owner at the server')}`,
  `CREATE TRIGGER halt_reasons_clear BEFORE DELETE ON halt_reasons
  WHEN NOT ${ownerAudited(
    'OLD.set_audit_id',
    `(newest.action = 'server:reset-halt' AND ${SERVER}) OR (newest.action = 'owner:resume-peak' AND ${OWNER} AND OLD.reason = 'peak-halt:paper') OR (newest.action = 'owner:resume-streak' AND ${OWNER} AND OLD.reason = 'daily-stop-twice:paper')`,
  )}
  ${raise('a halt is lifted only by the owner')}`,
].join('\n');

export const SCHEMA_V1: Migration = Object.freeze({ version: 1, name: 'schema-v1', sql: `${SQL}\n` });
