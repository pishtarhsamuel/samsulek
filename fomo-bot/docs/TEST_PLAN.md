# Test plan (Phase 1 design)

How the bot is tested before anything is trusted. Invariant numbers refer to
RISK_POLICY.md section 15. Failure modes refer to ARCHITECTURE.md section 12.

## 1. In plain English

- The parts that touch money (amount math, accounting, risk limits, sizing) get their tests
  written first, and random-input tests try thousands of odd cases against every rule.
- Data decoding is tested against recorded mainnet data with every wallet, signature,
  blockhash and slot replaced by fakes, or against bytes we build ourselves.
- "Chaos" tests break things on purpose (dropped streams, rate limits, crashes mid-trade,
  a damaged database) and check that the bot stops new trades and keeps exits working.
- Tests can show the code does what we designed. They cannot show a strategy makes money:
  only the paper soak can, and only roughly.

## 2. Principles

- Tests first for `core/` amount math, `venues/` quote math, `portfolio/` accounting,
  `risk/` and sizing; each starts as a failing test (Phase 2).
- No network in unit, property, integration or chaos tests: providers, Telegram and
  Anthropic are in-process fakes (node:http for HTTP-level fakes). Opt-in `@network` tests
  are read-only, paced under the budget table, never in CI.
- No secrets: `tests/setup/no-secrets.ts`, loaded with `node --import`, makes the secrets loader throw (root `no_side_effects`
  pattern), so no test and no command Claude runs can load the owner's secret files.
- Deterministic: an injected clock (wall and monotonic), seeded random numbers (seed logged
  on failure), fixed fixtures. No `Date.now()` or `Math.random()` outside `core/clock` and
  `core/rng` (lint rule).
- Same code paths as production: tests construct the app through `app/` with fakes, never
  a test-only shortcut around the risk engine.
- Every bug fixed gets a regression test first. A limit is never changed to make a test pass.

## 3. Phase 2 order (tests first)

1. `core/units` and checked math: bigint brands (signed PnL separate), mulDiv, ceilDiv,
   rounding direction (caps down, costs up), bps conversion, u64 bounds, TEXT round trip.
2. `venues/` math: constant product (out, exact-inverse in, impact), pump curve on virtual
   reserves with the real-token cap and `complete`, venue-favoured rounding (port the root
   `costs/memecoin.py` cases), fee tiers by market cap from a decoded fee config.
3. `portfolio/` ledger: cost lines, cost basis, realized PnL (negative too), rent paid and
   refunded, equity with unknown and stale marks, unknown mints, deposits and withdrawals.
4. `risk/` engine and sizing: every limit in RISK_POLICY.md section 3 at, just below and
   just above its value; the fee-reserve arithmetic of section 3a to the lamport; flags;
   breakers; approval transaction T1 and tokens; reduce-only rules.
5. `config/`: HARD_CAPS and TUNABLE_BOUNDS enforcement, direction rules, versions, rollback,
   modes only in the flags table. Done in step 5a: the tables' values, bounds and freezing;
   every risk check given a config far above the hard values (and live caps, and a live entry
   without today's EUR caps) decides exactly as under the hard values, in unit tests and in the
   sizing, entry-block and approval properties, with planted bugs for each clamp. Done in step
   5b: the tunables (each rule pinned to s.12, strict checks, the stored form), /set, AI review
   and approval, /rollback, versions and the 24 h live loosening, at every boundary; properties
   over random command sequences for invariants 11, 15 and 24; planted bugs for each rule.
6. `storage/`: migrations, WAL, TEXT amounts, partial unique indexes, crash during write,
   quick_check failure. Done in step 6b (the core, no schema yet): the settings read back at
   open, foreign, missing, empty, damaged and read-only files; a transaction all or nothing
   (a throw, an async callback, nesting, a kept tx, a statement error the callback swallows,
   a ROLLBACK that fails, SQLite rolling back by itself after a full disk, a COMMIT that
   fails with the transaction kept or lost, busy between two handles and two processes, a
   process that dies mid-write); one checked statement per call, on every call (parameters,
   placeholders, first word, a refused PRAGMA or pragma_ function has no effect, REAL cells,
   duplicate columns, the 500-statement cap); scripts without transaction control or comments; the
   fragments pin the storage class outside STRICT tables; errors carry codes and never a
   bound value; owner-only copies; the migration runner (fresh only with the setup flag,
   no-op, edited, newer, foreign, broken, failing, two runners at once, damaged or orphaned
   data, the health check after migrating, the pinned version table); a property that each
   SQL CHECK accepts exactly what its codec reads (invariant 7); 101 of 102 planted bugs
   caught (the one left is the disk sync of a copy, which only a power cut could show).
   Done in step 6c-1 (the schema): every table STRICT, amounts TEXT with their checks; the
   starting rows; the hard-limit copies equal config/caps.ts; every index, trigger and CHECK
   at its boundary (one position per token, at most 4, one buy ever, one exit in flight, a
   token used once inside its life, an order only with its consumed matching token, the entry
   count, live only by /golive, KILL and halts lifted only while the owner's own command is the
   newest audit row and came after the KILL or halt, decision D4 for the peak and streak
   halts); the migration text (literal RAISE messages, BEGIN and END paired, no NOT IN after a
   sub-expression) with canaries; the secret filter with fake canaries of every kind and
   hostile long text; the JSON codec (the reader takes only the writer's form; the walk runs no
   getter or proxy trap and stops early on a huge value). After review P, every reviewer probe
   is a test:
   - halts are never renamed, backdated, upserted or replaced, and KILL keeps its time, source
     and audit link;
   - audit ids and hashes come in order, and each action names its actor;
   - KILL and halts name the newest audit id: an older owner row cannot stand in, and a clock a
     year ahead, a year behind or at the largest timestamp blocks neither a KILL, a halt nor the
     owner's command (P-R1);
   - a token matches its approved decision, intent, position, mode and kind, and is used only
     while its position can take the order; a buy order spends at most its max spend;
   - pending changes, snapshots, bans, ledger modes and the move back to opening are each tried
     at their boundary;
   - the script check is tried with brackets, backticks, a single-quoted pragma_ function, and a
     settings change it then catches.
   Planted bugs: 159 of 161 caught. The two left are equivalent by design: the audit CHECK
   already does what they remove.
   Done in step 6c-2a:
   - The authorizer: a decision table over every action code and scope, and denials on the real
     connection when the wrapper and its text checks are skipped. The wrapper's own work still
     runs and the scope always comes back. A denial through the wrapper is `denied`.
   - The second-line script checks, tested on a stand-in without the authorizer.
   - The audit chain: ids, links and hashes recomputed in the test, and tampering with a detail,
     an action, an actor, a time, a hash, a link or a row found by the chain check, naming the
     row, never a value.
   - The flags: required rows, bad stored values, KILL and halts with their own audit rows and
     no second write, the pause and the low-equity stop, modes (demote, the gate), bans
     (lengthened, never shortened; only ended ones pruned) and the entry count up to 12.
   - The owner's and the server's writers: their actions and actors only, each command's own
     audit row, and a refused command that leaves nothing even when its caller catches it.
   - The architecture rules: constant SQL with the type checker, no conflict clauses, no `any`,
     no check-off directives, and the restricted writers. Each has canaries, and each canary is
     caught for its own reason.
   - Planted bugs: 98 of 99 caught. The one left repeats a refusal another check already makes.
   Added after review Q:
   - No write in the engine's file moves a safety time back: a test pins that file's exports; an
     earlier gate restart keeps the later start; demote writes its own audit row and starts the
     gate again; pruning keeps ended cooldowns and pauses a day (a clock a few hours ahead erases
     nothing); live only from paper, with nothing written when refused, and leaving live starts
     the gate again, even with a clock that stepped back.
   - Every ALTER TABLE form is refused through the wrapper, and leaves the table as it was.
   - The architecture rules: cli/ only from cli/; app/owner.ts reached by nothing yet; restricted
     files only through static imports, and their functions only called; which file writes which
     table and column, read from each call's SQL text (upserts, quoted names, prefixes, CTEs,
     aliases and a column set twice included); a database handle keeps its type (Reflect, Object.*, assertions,
     look-alike interfaces, structural parameters, unconstrained generics, spreads and
     destructuring are flagged). Every canary names the rule it expects, and the helpers are
     shown to refuse a case caught for another reason.
   - The flaky property test (rollbacks over random sequences) has a floor of 200: ten measured
     runs gave 303 to 388, and the old floor of 300 failed now and then.
   - A second flaky check, found in the full run (once in 31 runs): the plan re-check property's
     `inFlightSell` fault put a fixed 10,000,000 tokens in flight, which caused a refusal only
     when a sale nearly emptied the holding, so in a rare run it never did and the "every fault
     causes a refusal" check failed. The fault now puts exactly one token more in flight than
     the sale leaves room for (any for an account close), so it always refuses where it applies:
     0 failures in 40 runs, and a sale or a close that ignores the sells in flight is caught
     (`mut/run20.py`).
   - Planted bugs: 141 of 142 caught (the same equivalent one is left), every one added for a
     review Q fix among the caught.
   - After the re-check: each writer of the audit chain writes only as its own actors (one
     program per case, so one actor too many in any writer's set is caught); no `arguments` and
     no call of a value of type `any`. Planted bugs for these two rules: 9 of 9 caught.
   Done in step 6c-2b-1 (the config and the day state):
   - Version 1 only from the setup at the server, once; the history read back exactly as written
     (round trip through `nextVersion`, `withValue` and `decodeTunables`); a gap, an unknown author,
     text `jsonParam` never writes and a changed list that is no list of names refused on read.
   - The owner's config commands: each refusal alone, with nothing written even when a careless
     caller catches it (the author, the id, the undo, a version that changes nothing, drops a
     tunable or lists more or less than it changed, a waiting row from another value or source, for
     less than a day, twice, a cancel of nothing). Review R: a waiting row asked for before or
     after the command; a version dated before the active one or after the command, and dated as
     the active one while the clock is behind it; a set that leaves the waiting row of a tunable it
     sets, a tunable applied and queued at once, a rollback that leaves a waiting row.
   - The engine's due step: only the queued change, once due (a moment early refused), each wrong
     field alone; dated before the active version or after now refused, and as the active version
     when the clock is behind it; a stale row refused and dropped instead; the engine's own audit
     rows.
   - The day state: a full state round trip, walked one step at a time; the engine cannot lift the
     two-day halt; a row changed behind the bot's back refused; the resume and the reset restart
     the peak and the streak exactly as risk/daystate.ts does, and are refused while a jump is held
     or the equity is zero (the refusal names the mode).
   - Review R, the day-state guard, each refusal alone with nothing written: the day or stop day
     moved back or cleared; a streak below the stop days' count (the same stop day, the next one, a
     gap, after the owner's resume) or two days without the halt; a hold cleared without its
     confirmation, before the hold, over 5 minutes after it (risk/daystate.ts's own window, pinned)
     or above it; an acknowledgement moved, raised or cleared at any other time; the peak lowered,
     cleared, below the last equity, or in a withdrawal's shape; a new day's baseline below the
     higher of the last equity and the observation, or without a peak; the same day's baseline
     lower, or set again below that after a reset. A property test (200 random runs of 20 to 80
     steps) puts the risk module's own steps through the write: none refused, each read back.
   - risk/daystate.ts: a deposit leaves a reset baseline reset (review R).
   - Snapshots: one per millisecond, the nearest known one (older on a tie), kept a day.
   - Clearing KILL starts the recovery wait (decision D6).
   - The write rules for the four new tables, with canaries (review R: a waiting change deleted one
     at a time by its path; an INSERT into day_state; a snapshot DELETE from another file); the
     engine files' exports pinned.
   - Planted bugs: 66 of 68 caught; the two left repeat a check another one already makes.
     Review R: 61 of 62 caught; the one left is equivalent (a waiting row's day counted from its
     own time, which must already equal the command's). The re-check's notes: 9 of 11 caught; the
     two left only narrow a type.
   - Re-check of review R: a new day at zero equity; a day moved past the write's own day (one
     day early, far ahead), a new stop day that is not the state's own day, or while the clock is
     behind it; a day the clock is behind may stay.

   Done in step 6c-2b-2 (the book and the money path, STORAGE_DESIGN s.15):
   - The plan text: buy, sell and close round-trip to risk's own text and hash; the largest plans
     (about 1,030 characters) pass the secret filter; any other text of the same plan is refused
     (spaces, unsorted keys or tip keys, an amount as a number, a missing, extra or renamed key);
     a withdraw, a bad mode, amount or slot, an id of 64 characters or with a credential word. A
     property test (1,000 random valid plans) ties the record to canonicalPlan and planHash.
   - The book: the setup once (the server's row first, paper's one deposit, live at zero, the day
     state untouched); accounts and positions changed behind the bot's back refused by column; a
     stuck row refused on every read, never mapped; the opening at its boundaries (the held-back
     spend 0, 1, 0.07 SOL and one more; ids of 63 and 64; a mode without its account; an existing
     id; a second position on a mint; a fifth active one); the exit number (stale, the last one,
     opening and closed positions); abandoning exactly as ledger.ts, with a failed fee in the
     basis, before it opened, holding rent, and against each status of the buy.
   - Intents and decisions: each field and each optional column; inputs that nest, list, hold a
     fraction, an address, a getter, a symbol or another kind of record, or 33 names; the largest
     intent; an entry onto an existing position; an exit's mode and mint from its position and its
     number used up; each outcome against each intent kind, a null slot, an old config version,
     reasons empty, repeated or no codes.
   - Approvals: risk's own tokens; each token field against the text, the hash (also for a text
     that differs only where storage binds nothing), a buy's held-back spend, a refused or missing
     decision, a position in another mode or that cannot take the order; the MAC in no cell.
   - T2 through risk's own verifier: the order from the text; once only; each snapshot field, the
     slot edges and one past them, a clock behind the issue, an abandoned position, a buy above
     its token's spend (a tampered row), a snapshot whose plan object disagrees (the text wins).
   - Each write of the setup, a buy's T1, an exit intent and T2 failing in turn: nothing left.
   - A property test of random T1 and T2 sequences on SQLite: invariant 1 and the book's
     conservation after every step.
   - The write rules for the six tables and the restricted files (only the bound token store uses
     a token; only app/ writes the money path), with canaries.
   - Planted bugs: 78 of 81 caught; the three left repeat a check another line already makes.
   - Review S, each refusal alone with nothing written: reason lists that are not plain lists
     (their own map or toJSON, a proxy, a subclass, another prototype, a getter or hidden element,
     an extra or symbol property, a hole, a list-like object) for entry intents, exit intents and
     refused decisions; a decision whose outcome answers one way and then another is read once and
     stored as checked; a buy, sell or close plan for another mint than its position's, at the
     approval and at T2 (an approval row written by hand), also through risk's verifier; the paper
     bankroll at 1 lamport and at the 2.0 SOL sanity limit, one lamport more refused, the limit
     pinned to config/caps.ts; the token store's one importer, upserts and DELETEs on the money
     tables, a position closed from any status but opening (or with an OR, or with a comparison
     that continues the pinned start: `= 0`, `IS 0`, `IN (0)`, `<> 1`, `IS NOT 1`), and a
     position's amounts moved by any update but the abandon (canaries); a known slot of 0 for any
     decision (a stored 0 means unknown); an exit intent with an inputs time and an exit token for
     an exiting position (both had been reached only by some random runs). Planted bugs: run25's
     81 again on the fixed code plus 28 for the fixes, 105 of 109 caught; the four left repeat a
     check another line makes (or, for the order's values after the consume, cannot throw there).

   Done in step 6d-1 (the K gate in app/, STORAGE_DESIGN s.16.13):
   - The encoders: hex, base64 and base64url equal to Node's Buffer on the RFC 4648 vectors and on
     1,000 random byte strings; base58 on vectors from an independent implementation (leading
     zeros, 32 zero bytes, 32 bytes of 0xff) and on 1,000 random strings against a second,
     carry-based algorithm; bytes only, never changed.
   - The own-secret list: a registered key found in hex, base64 with and without padding,
     base64url and base58, in any case, inside JSON; a text secret as itself and in each encoding
     of its bytes; 'own-secret' last among the kinds; a refusal never repeats the text; 15 or
     1,025 bytes or characters refused; the same secret 40 times adds nothing; the forms past 32
     refused whole, earlier ones kept.
   - Randomness: a 32-byte key, a plain array of its own, new each call; an all-zero or short draw
     drawn once more, then refused, each draw wiped; ids of each kind in shape, 1,000 all different,
     never holding the key's forms; an id spelling a registered secret refused; the 8th refused draw
     fails closed.
   - The fault rules: every storage code, every app code, risk's hard-limit backstop, look-alike and
     hostile errors, each to its code, scope and alerts; the latch sticky and sorted; the sink per
     scope; the busy storm at the third refusal within ten minutes, once; a throwing alert sink or
     callback contained.
   - The slot feed: the cold start by two channels (whichever reports the higher first) and by one
     channel twice 500 ms apart; a wild first or second reading never adopted; the bound at its edge
     (from the same channel, so no agreement hides it); a held reading adopted only by another
     fresh channel within 150 slots; malformed readings and the alert once a minute; stale at
     2,001 ms; a clock behind; a smaller maxAgeMs; 1,000 random reports never throw; a throwing clock
     or alert sink contained; every option outside its range refused.
   - T2 and the authority, with risk's real verifier on SQLite: the order row from the snapshot and
     the text; a replay; extra arguments ignored; the executor's plan object changed after redeem; a
     token the database does not hold; a second exit in flight; buy tokens refused while latched,
     after KILL, with the KILL file (exits still redeem); expiry against the feed; a stale feed; one
     wild slot does not stop an exit; the stream stale and HTTP alive; a second authority's token
     fails its MAC; the key registered and wiped; tokens expire 25 slots after the quote.
   - The architecture rules: core/rng.ts pure, randomBytes its only import from node:crypto; core/rng.ts
     importable only by app/ and cli/, the authority and the boot only by app/engine.ts, the engine
     only by cli/; the key maker handed on (typed canary).
   - Planted bugs: 106 planted, 104 caught (two weak tests the first run showed were fixed); the
     two left repeat a check another rule makes.
   - Review T (STORAGE_DESIGN s.16.14): the slot feed's advance budget (150 at once, refilled at 10
     a second, never more); W1 (a walk in 151-slot and 150-slot steps) and W2 (an hour at 10 slots
     a second against a chain at 4.7: never more than about 150 ahead, slot-behind raised); the lead
     cap; agreement only from a channel above the accepted slot, spending the whole budget; the floor
     (F1, one slot every 1,900 ms, and a source that turns slow after a healthy minute; a chain at
     2.5 a second stays known); a clock one hour back (known again within 1 s, with two channels or
     one) and one day ahead; 15 s of unknown back to a cold start; a cold-start base that expires
     after 5 s and a pair a fresh channel disputes; slot-behind at once past 150 and after 10 s past
     25 (not before, and not at 25); a clock without whole milliseconds. T2 refuses a buy token when
     the database holds KILL (written by another connection, then remembered in the latch), a halt
     of either mode, the pause or the low-equity stop, with nothing written; exit tokens still
     redeem. A redeem 15,001 ms after the token's issue is refused, 15,000 ms passes, and the
     arithmetic is pinned to the hard 25 slots. Exit-path faults alert once a minute per site and
     code; late redeems and a clock behind the issue warn rather than alert as bugs. The recheck
     property's coverage check no longer depends on its random draws. A slot-feed property (500
     random runs of one channel): over any stretch the slot stays known it rises at most the budget
     plus the rate, never goes down, and is always a reported reading. Planted bugs: 34, all caught
     (two weak tests the first run showed were fixed); the property alone also catches both
     budget bugs.

   Done in step 6d-2 (the approval transactions, STORAGE_DESIGN s.16.15; UNREVIEWED, owner decision
   D9, on its own branch until both reviewers approve):
   - The caps: every field of the buy, plan and day caps from its tunable or its hard value; every
     tunable at both bounds stays inside the hard values; the chain rent changes the reserve and
     nothing else, and no tunable can change it (review L); the failed-fee budget 3,375,000, below
     the reserve's 3,380,000; paper's bankroll from the stored deposit, refused for a withdrawal, a
     zero deposit, a deposit over 2 SOL, the live account and the live mode.
   - The snapshot: each entry flag from its row (KILL stored or seen, every halt row of either mode,
     each mode's streak halt, the recovery wait after a cleared KILL, the pause, the low-equity stop,
     the paper day's daily stop and held jump, the modes, the five kinds of ban, the day's count, the
     active config's limits); openings at their held-back spend, open positions at a fresh mark; a
     missing, stale or wrong-holding mark makes equity unknown (30 s exactly is fresh); a live
     position, a live mode, a stuck row, a missing account or config refused.
   - T1 buy: exactly the intent, the opening, the count, the decision and the approval, the stored
     p95 the market's, the token after COMMIT and redeemable; the identity over a market's wallet;
     a duplicate and a latched entry write nothing (the database untouched when latched); the KILL
     file stores KILL first; KILL from another connection marks the latch; each refusal stage
     recorded; a live request, an unknown rent, a p95 of 4,999 (5,000 passes), an unknown slot (slot
     0) and a throw after the slot read (the slot kept) recorded with no inputs; a malformed request
     unrecorded; a secret-looking input recorded without it; a count that moved latches as a bug;
     a COMMIT of unknown outcome returns no token and calls onFatal once; risk's words for
     impossible position lists are bugs, pinned against risk's own throws.
   - T1 exit: the number used up when approved and when refused, mint and mode from the position; a
     plan for a stale number refused wrong-intent; an unused unexpired exit token blocks, an expired
     one does not, a used one counts as its order; no flag (KILL, a halt, the pause, the latch, the
     KILL file) stops an exit; an owner exit, a malformed request, an unknown slot (an hour of
     retries) and a missing position run nothing; the fee budget at its edge (3,375,000 over the
     position's life), automatic exits stopped, the fee-budget alert; a failed sell simulation
     refused; a secret-looking planner input retried without it, with a bug alert; a live position
     refused and recorded; exit number 10,000 warns; a throwing alert sink latches as a bug; an
     approved exit ends the run of refusals.
   - Abandon: only after the buy token's expiry slot (at the expiry slot still refused), at
     max(now, opened_at), never with a buy order of any status, never without a known slot.
   - The small writes: the refusal record (one code, no inputs, slot 0 only when unknown, a
     duplicate, its own failure latches); KILL and halts set and already; a failed write latches and
     alerts; a full disk while the halt is written asks for it once.
   - The exit watch: refusals warn once a minute per position and codes; fee-budget refusals say so;
     five in a row raise exit-blocked once in ten minutes; an approval ends the run; a throwing sink
     latches as a bug. The bug storm: five bug-class intent faults in ten minutes latch entries once.
   - Fault injection: every statement of a successful T1 buy, T1 exit, T2, abandon, refusal record
     and KILL write failed in turn with full, io, constraint, bad-param and busy.
   - Races: on two connections, for the position cap, the entry count and the exposure cap; 50
     seeded rounds of two to six processes (exactly one approved, none busy: V3); KILL from another
     process; a process killed inside T1; a second connection's read does not wait (V8).
   - Invariants 1, 2 and 17 on SQLite after every step of 200 random runs, with counts that prove
     the runs approved, redeemed and sold.
   - The architecture rules: no catch inside a transaction (12 canaries and a no-false-positive
     file; the real src/ with at least 8 callbacks and 8 followed bodies); positionExitBudget only
     inside risk/.
   - An exit of an opening or closed position runs nothing and latches nothing; an exiting position
     gets its account close; errors after the position was read count toward exit-blocked; the bug
     window keeps faults the clock puts in the future; the no-catch rule follows an aliased import, a
     namespace member and an object's method (V7).
   - Planted bugs: 130 in two runs, every one caught in the end; the first runs caught 126 and showed
     four weak tests (fixed) and one rule to make stricter (the bug window, changed).

   Done after review U (both APPROVED WITH NOTES, 2026-11-23; STORAGE_DESIGN s.16.15):
   - A spent fee budget: the exit is not-run (`auto-exits-stopped`) with nothing written, the
     fee-budget alert kept; an hour of asks every 2 s leaves the database and the exit number
     unchanged, the fee-budget alert once a minute, exit-blocked once in ten minutes.
   - The no-catch rule's rule 4: six new canaries (a closure over the transaction in a variable, an
     object holding it, a bound function kept and inline, a nested object, an array), two allowed
     cases (a named function to the lib, an object of functions without a handle).
   - Two buy tokens for one position are refused by `buyTokenExpiry`.
   - Planted bugs for these fixes: 10, all caught.

   Done in step 6d-3 (the boot and the engine start, STORAGE_DESIGN s.16.16; built unreviewed under owner
   decision D10, reviewed 2026-11-23 (REVIEWS.md V), both approved with notes):
   - The run files: the KILL file reads present for any error but "no such file"; the anchor is
     written 0600 through a temp file and a rename (a leftover 0666 temp made 0600), read back strictly
     (extra keys, an id of 0 or a fraction, an upper-case hash, a time out of range, bad JSON, an
     unreadable file: each throws), and null with no file; the probe's link count, links, file-system
     type and missing paths.
   - The audit reader: one row as stored, frozen, null past the newest, bad ids refused; `newestAt` is
     the newest row's time. KILL and halts move the anchor, from a check of the whole chain; a failed
     anchor write only warns.
   - The boot, every refusal on its own (18 codes; each alerts with its code and leaves no handle on
     the file): built-ins that can be changed (a child without the flag); no run lock; the path (a
     relative folder; a file name that is a path, a dot name, a trailing dot, a Windows device name;
     one folder for two names; a missing folder; a link on the way, a linked database or run folder; a
     hard link on the database or its -wal; a database or run folder of another user; a chmod that
     fails; no uid; NFS, FUSE or no type, also mounted on the run folder or the database); open (a
     missing or foreign file); health (a foreign key); migrations (a changed migration); required rows
     (no accounts; the flags row, a strategy mode or a day-state row gone); config; the audit chain (an
     edited row, an empty log); the anchor (past the newest row, another hash, a malformed file); the
     KILL and halt links (another row, another source or reason); the book (a stuck row);
     conservation (paper and live); the paper account (a withdrawal, no deposit, above 2 SOL; exactly
     2 SOL passes); the live account (money, or a live position with no money); the abandon and the
     KILL file write at a clock past 2200. Also: a bot file that was never migrated (migrations); an
     engine audit row with the KILL's or a halt's detail but another action (the links); the boot's
     own chmod calls, a stray -wal included.
   - The healthy start: the report, the first-start warning, the anchor written and named in the boot
     alert, folders 0700 and files 0600, a second start with no warning; KILL stored or the KILL file
     (stored as the sentinel's, the anchor on its row); halts listed; stale openings both ways (no
     order: abandoned at max(now, opened_at); an order: counted, with a warning); a buy token an old
     process still holds is refused once its position is closed; a clock behind the newest row only
     warns, even at the largest time; a failing anchor write warns; a throwing alert sink latches.
   - Windows through a fake probe: under the profile passes (a name starting with two dots too); UNC
     in three forms, a profile redirected to a network share (both slashes), another drive, a profile
     next door, OneDrive by root or by name in any case, no profile, a hard link, a junction, and two
     names for one folder where case does not count: each refused.
   - The engine: one paper authority (one key, wiped), exactly the deps, frozen, one feed shared, the
     anchor file in the run folder, ids from the Rng; a buy approved and redeemed end to end; the boot's
     latch (KILL stored); the KILL file in the run folder stops buys; a busy storm and a disk-full
     fault store the disk-db halt and move the anchor; onFatal once; the K gate against its redeemer
     (extra arguments, an expired token, another engine's token); a refused boot comes through with no
     key drawn; 14 bad inputs refused before the boot touches anything; a throw after the boot closes
     the database and alerts, and a throwing sink does not hide it; `assertPaperAuthority`'s refusals.
   - C18: the chmod failure for real (a uid 65534 child, a root-owned 0666 file; root on POSIX only).
   - Planted bugs: 123 in two runs; 114 caught, 9 equivalent (another check does the same job, each
     reason written down). The first run showed four weak tests and one missing check (a live
     position), all fixed, and one freeze that did nothing (removed).

   Done in step 6e-1 (the equity observation, STORAGE_DESIGN s.17.12; UNREVIEWED, owner decision D11, on
   the same branch):
   - The snapshot readers: the nearest known row at or before now with its own time (the older on a
     tie, a row after now never used, now before the target, unknown rows skipped), the newest row at or
     before now with unknown equity; both against a brute-force oracle on 1,000 random row sets.
   - The low-equity stop: off at 0.2 SOL of sizing equity at 10% per trade, on one lamport below; the
     day's baseline as the sizing equity; 5% needs 0.4 SOL; agreement with sizeEntry's
     equity-below-minimum on 1,000 random equities, baselines and shares.
   - The observation: the first one sets the day, its baseline and the peak, at one clock reading (a
     clock that would answer differently is read once); each halting trip as its halt row with its own
     audit row first, level-triggered; two halts in one tick interleave with their rows (C28); the daily
     stop and the jump hold in the day state; anomalies stored as unknown snapshots; a clock back across
     midnight halts, stores no snapshot and prunes nothing; a same-day baseline of 0 set again (C39);
     the base missing, ok at exactly the tolerance, far one millisecond past it, and never a row after
     now (C42); unknown equity (the stops idle at under 5 minutes, on the stops equity after); the
     low-equity stop on, kept by the day's baseline, off on a new day, one alert per turn-on (C33).
   - The failures (C40): an untrusted clock writes nothing and warns at most every 10 minutes; a live
     position, a day-state write storage refuses (a planted state) and a marks reader that throws each
     set the day-state-error halt with its row and the anchor, and the next tick observes the stored
     state again; busy writes nothing and halts nothing; a failed anchor write only warns.
   - Athens midnight on 2026-03-29 (23 hours) and 2026-10-25 (25 hours): the daily stop lasts until
     local midnight, never an hour early or late.
   - The watch: each alert, its severity and codes, the rate limit and its edges, a hold's first tick,
     unknown equity over 5 minutes, the base alerts only after the first hour, a throwing sink.
   - Fault injection: every statement of the richest observation (two halts, the stop, a snapshot, the
     prune) failed in turn with full, io, constraint, bad-param and busy: only the failure's halts and
     their audit rows stay, and the latch is as s.17.5.6 says.
   - The day-sequence property: 200 random runs of up to 40 steps (across both time-change nights) and
     two fixed sequences, against the pure functions on a model, after every step.
   - Planted bugs: 43; 42 caught, 1 equivalent (paper's caps are inside the hard values). The first run
     showed two weak tests (a missing live account; the watch's first-hour edge), both fixed.

   Done in step 6e-2 (the jump confirmation and T1's freshness, STORAGE_DESIGN s.17.13; UNREVIEWED, D11):
   - T1's freshness: refused `day-state-stale` with no paper snapshot (a live one never counts), one
     30,001 ms old, one with unknown equity, one only after now, or a valued older one behind an unvalued
     newest one; accepted at 30,000 ms. Every 6d-2 T1 test passes with a fresh snapshot in its world.
   - The confirmation: at the hold and 5 minutes after it, the lower of the verified and the held level;
     refused 5 minutes and 1 ms after, before the hold, with no hold and above the sanity limits, writing
     nothing and setting no halt; it works while KILL, a halt and the pause are set (C41); the clock read
     once; the next observation moves the baseline and the peak again; an untrusted clock writes
     nothing; a value that is not lamports halts with day-state-error; busy does not, and three busy
     confirmations make a busy storm.
   - The race: inside an observation that trips the daily stop or the peak halt, a buy on a second
     connection is busy and unrecorded; after the commit it is refused by that stop.
   - The import rule: only cli/ imports app/jump-tx.ts (three canaries, one allowed import).
   - Planted bugs: 18, every one caught after two weak tests were fixed.

   Done in step 6e-3 (the engine's config step, STORAGE_DESIGN s.17.14; UNREVIEWED, D11):
   - `readConfigState`: the setup read back (version 1 active, nothing waiting, nothing live, all frozen);
     the newest version active; a lamport amount kept as a bigint (up to the u64 maximum) and any other
     made a number up to 2^53 - 1, one past it refused in `from` or `to`; a paper or off strategy never
     counted as live; ConfigError for a waiting row that names no tunable, values that do not decode and a
     `changed` list with a name that is no tunable (each on a database file changed behind the bot's back).
   - `commandTime`: the latest of now, the active version's time and every waiting row's request time.
   - `applyDueTx`: nothing waiting and a row 1 ms before its time write nothing; one row applied at its
     time exactly as queued (the next version by the row's source, undoing to the active one, the row
     gone, the engine's row, the anchor, an info alert); two rows chained in the order they fall due,
     then the tunables' order, each undoing to the one before, every stored version decoding to the
     plan's values; a clock behind the active version dates the step as that version; a stale row and an
     out-of-bounds row dropped with the engine's row; an exit value demotes every live strategy (not a
     paper one) and restarts every gate, a risk value neither; the clock read once; an untrusted clock
     and a waiting row asked for after now write nothing (the second warns, neither latches); a version
     that does not decode and an amount past 2^53 - 1 are `error:config` with entries latched as a bug; a
     failed anchor write only warns; `LIVE_ARMED_IN_PAPER` is false.
   - Fault injection: every statement of the richest step (two versions, a dropped row, a demotion, every
     gate, a waiting row kept) failed in each of full, io, constraint, bad-param and busy: the database as
     before (plus only the disk-db halt for full and io), no anchor moved, the latch and the alerts as
     s.17.5.6 says.
   - `planCancel`: an unknown name, nothing to cancel, the row returned, malformed rows and context throw.
   - The import rule: app/config-tx.ts cannot import repo-owner.ts (a canary); app/ may import it.
   - Planted bugs: 35, every one caught after one missing test (a paper strategy) was added.

   Done in step 6e-4 (the owner's commands, STORAGE_DESIGN s.17.15; UNREVIEWED, D11):
   - `setTx`: in paper a value applies at once (safer or riskier; a lamport value kept whole; from
     Telegram or the server), as the next version by the owner, undoing to the active one, with the
     owner's row and the anchor; a strategy's own value restarts its count, an exit value and the paper
     model every count; nine refusals (unknown name, a mode, not a number in three forms, out of bounds
     either side, no change, a paper model less pessimistic) write nothing; while a strategy is live a
     riskier risk value waits a day and a safer one then applies and replaces it; a /set to the current
     value cancels its waiting row; a live strategy's own value demotes it, the engine's row after the
     owner's; a clock behind the active version or a waiting row runs the command at that time and warns,
     and dates a demotion and a gate restart as the command, not the clock;
     a stored version that does not decode is `error:config` at the owner site; an actor that is not the
     owner is a TypeError for all four commands.
   - `rollbackTx`: nothing to roll back at the setup; one step back (author rollback, the earlier undo
     target); two steps along the undo chain, then nothing left; a paper-model-only rollback refused;
     with a strategy live, a rollback whose fields all wait makes only waiting rows.
   - `cancelPendingTx`: the row deleted with the owner's cancel row; an unknown name and nothing waiting
     refused; a row the engine applied first is gone.
   - `resumeTx`: the peak refused, writing nothing and never as a bug, when not halted, with a held jump,
     no known equity, no money check, one 60,001 ms old, or a newest one that could not value everything;
     resumed at 60,000 ms exactly as `resumePeak` computes, with the clear time, the owner's row and the
     anchor; the streak resumed as `resumeStreak` computes without a money check, the live halt left; a
     halt that storage then cannot find is `error:bad-request`; a wrong kind is a TypeError;
     `RESUME_FRESH_MS` is 60,000.
   - The race: the due step and /cancel on one due row, both orders: the inner one is busy and writes
     nothing; afterwards it finds no row.
   - Fault injection: every statement of the richest /set, /rollback, /cancel and /resume failed in each
     of full, io, constraint, bad-param and busy: the database as before (plus only the disk-db halt for
     full and io), no anchor moved, the latch and the alerts as s.17.5.6 says.
   - The command-sequence property (200 runs of up to 30 steps, two fixed sequences first): random /set,
     /rollback, /cancel, due steps, clock moves both ways and strategies set live, against the planners
     on a model at the same command time: outcomes, history, waiting rows, modes and gates equal after
     every step; storage never refuses a planner's plan; the owner's row comes first. The day-sequence
     property now resumes through `resumeTx`.
   - The import rules: app/owner-tx.ts only from app/owner.ts and cli/ (six canaries, three allowed
     imports, two "handed on" canaries); nothing in src/ imports it at runtime yet (a scan of the real
     files, which sees app/owner-tx.ts's own import of app/config-tx.ts).
   - The no-catch rule's new clause (C32): a function parameter, a variable holding a returned function,
     a destructured method and a parameter called in a followed helper are each flagged inside a
     transaction; an interface method and a function written in place in a variable are not.
   - Planted bugs: 42 on the final code, every one caught; the first draft's run found one missing test
     (a demotion with the clock behind), added.

   Done in the review W fix (STORAGE_DESIGN s.17.16; on the unreviewed branch, re-checked by both
   reviewers before 6e joins the working branch):
   - The three day-state files: their exports pinned (the readers in repo-day.ts, the observation's
     writes in repo-observe.ts, the confirmation's write in repo-jump.ts).
   - The observation's writer never clears a held jump, not even in a confirmation's exact shape, and
     refuses the reviewer's reproduction (two hours after the hold, the acknowledgement dated at the
     hold); the acknowledgement changes at no other time (not moved, raised, cleared, or set with a new
     hold; a new hold keeps it).
   - The confirmation's writer: refused with nothing written (even when a careless caller catches the
     refusal and commits) with no held jump, a time before the hold, more than 5 minutes after it, the
     reviewer's case, or an equity above the held level; at the edges (the held level, exactly 5 minutes,
     a level of 0 at the hold itself) only the jump columns change, the acknowledgement and updated_at at
     the write's own time, the other mode untouched; a write that finds no row is refused (row-count);
     risk/daystate.ts's confirmation at the 5-minute edge is written exactly as it makes it.
   - The day-sequence property confirms through the confirmation's writer; every 6e-1 and 6e-2 test
     runs on the split files unchanged.
   - The import rules: repo-observe.ts only from app/day-tx.ts, repo-jump.ts only from app/jump-tx.ts
     (nine canaries, a re-export among them; three allowed imports); the write rules: only repo-observe.ts
     adds and prunes snapshots, the day state is written only by repo-observe.ts, repo-jump.ts,
     repo-owner.ts and repo-server.ts, and repo-jump.ts runs only its one clearing UPDATE (eight canaries,
     the readers' file writing nothing among them).
   - The no-catch rule's indirect calls (security W2 note 2): a handed-in function called through call,
     apply or Reflect.apply, through an element, the result of a call or a namespace import, or under a
     cast; a function with a try reached through call, Reflect.apply, bind, a lib method given it by name,
     or a lib method on a value holding the transaction; a function value handed to the lib; an interface
     method handed to a lib method on a value holding the transaction: each flagged (15 canaries). A
     function written in place and called at once, call and Reflect.apply of a function the rule follows,
     the lib's own apply, and a named function handed to the lib are not (seven fine cases), and the real
     src/ is clean.
   - Planted bugs: 33 in the split (scratchpad `mut/run38.py`), 32 caught on the first run; the one left
     (no row-count check) cannot happen with a real database, whose CHECK ties jump_pending to the held
     pair, so a test with a write that finds no row was added: 33 of 33. 15 in the rule (`mut/run39.py`):
     15 of 15 on the first run.

   Done in step 7a (the building blocks of chain/, CHAIN_DESIGN.md s.16; UNREVIEWED, on the unreviewed
   branch, reviewed with the design):
   - `parseLossless`: 2^64 - 1, 9007199254740993 and a 30-digit number exact; `1e3`, `1E3`, `1.50`,
     `1.0`, `2e-1`, `-0` and `1e400` stay numbers; `-32016` is a bigint; inside arrays and objects, all
     frozen; strings, booleans and null untouched; a `__proto__` key stays an own property; nesting of 64
     passes and 65 (arrays or objects) or 200,000 is a SyntaxError, brackets inside strings (escaped
     quotes included) not counted; eleven kinds of invalid JSON are SyntaxErrors, a non-string a
     TypeError. Property (1,000 runs each): random integers around the u53, i64 and u64 edges in seven
     spellings, alone and in arrays: a bigint exactly when the source is plain digits, equal to it.
   - `stringifyLossless`: bigints as digits, an RPC request written exactly, escapes as JSON.stringify;
     round trip; NaN, the infinities, undefined, functions, symbols, an array hole, a Date, a Map, an
     object with a prototype and a typed array refused (an object without a prototype is plain); 64 deep
     passes, 65 refused.
   - `base58Exact`: the system program, the wSOL mint, the token program and the genesis hash decode to 32
     bytes and encode back; 500 random 32- and 64-byte values with leading zero bytes round-trip and never
     decode as the other length; a short number without its leading "1", an extra "1", 31 and 33 bytes,
     ten foreign characters first or anywhere in an address, an empty text and a text too long for its
     length (refused at once, under 50 ms for 200,000 characters) are null; a non-string or a bad length
     is a TypeError.
   - `base64Strict`: 500 random values up to 300 bytes agree with Buffer; an empty account; stray bits,
     bad padding, whitespace, base64url and foreign characters null; the byte bound exact and checked
     before decoding; a non-string or a bad bound a TypeError.
   - core/solana.ts: program ids, mints and the genesis hash are addresses; signatures of 64 bytes; other
     lengths, a padded short number, foreign characters and non-strings refused without the value in the
     message; slots and block heights from 0 to 2^63 - 1, numbers, negatives and 2^63 refused; the types
     keep slots, block heights, bigints and strings apart (compile-time).
   - core/clock.ts: whole UTC milliseconds; a monotonic clock that never goes back and does not count from
     the epoch; frozen; a timeout signal and a timer that fire on time and not before; a cancel that
     works (twice harmlessly); delays that are not whole milliseconds from 0 to 2^31 - 1 refused.
   - The architecture rules 1 to 5 (CHAIN_DESIGN s.10): 48 canaries (chain/ pure, each network file with
     only its globals, the network globals, `globalThis.` and `global[...]` members, a bare global object,
     fifteen network modules, dynamic imports and re-exports, chain/ importing config/, node:crypto even
     as a type, sending method names in any case, the real clocks outside cli/) and eleven fine cases; the
     real src/ is clean.
   - Planted bugs (scratchpad `mut/run40.py`): 50 in the first run, 46 caught. One weak test (a foreign
     character in the middle of a base58 text, where the decoded number keeps its length) was fixed; one
     unreachable line was removed (a RangeError conversion that the depth check makes impossible); two are
     equivalent (base64's character and length checks, which its final re-encoding also enforces). Final:
     49, 47 caught, 2 equivalent, each with its reason in the script.

   Done in step 7b (the budget governor, CHAIN_DESIGN.md s.18; UNREVIEWED, on the unreviewed branch):
   - The table pinned to s.5: each method's cap, P0 reserve, timeout, byte cap and most urgent priority;
     the caps add to 49 and the reserves to 27; every cap at most half the method's header limit; the
     refused getTokenLargestAccounts; the fixed numbers of s.6; all frozen.
   - Windows: a method's cap over a sliding 10 s (the 7th getSlot refused with the time a slot frees,
     granted exactly then; non-P0 never gets getSlot); non-P0 leaves each method's P0 reserve free; the
     total with its reserve (tightened); data reserved at the byte cap and settled at the decoded bytes
     for 30 s, with the P0 reserve; the stream's bytes; when to try again (never for an answer bigger
     than the budget, soon when only requests in flight hold it); 6 in flight, 2 of them P0's.
   - The provider: a 429's Retry-After (30 s, missing, not whole, negative, over 600 s, 0); a 403's
     15-minute block, P0 included, then one P0 probe (a 5xx keeps it blocked, a 403 blocks again, a 200
     reopens; a 200 from before the block does not); header limits only lowering the cap to half, 0
     refusing the method for good; a remaining count of 0 or below closing it until its window empties.
   - Shedding: levels 1 to 3 and what each sheds, P1 and P0 never, at most 3, one step down per 5 minutes
     (also over a long quiet stretch); 80% for a minute raising it once a minute (connections held), and
     slot polling that keeps a P0-only method over 80% never doing so; every P0 denial alerting.
   - Refusals, tickets and inputs: unknown and refused methods and P0 on getProgramAccounts before any
     count; a second or forged settle alerting and changing nothing; impossible byte counts, statuses,
     stream bytes and priorities as TypeErrors; a clock stepping back held (grants made then dated at the
     held reading); a throwing sink ignored; `usage()` for all 14 buckets; tightening only downward.
   - Property (1,000 runs each since review Y, risk 9, 300 before; with and without learning, with and
     without tightening): random acquires of every method and priority, settles with random statuses and headers, clock steps: after every
     grant no window over its cap, the total, data and in-flight caps held; P0 never shed; a P0 refused
     for a full window had its whole reserve.
   - Planted bugs (scratchpad `mut/run42.py`): 46 in the first run, 38 caught, 2 equivalent; three weak
     tests fixed and a second guard that hid the first removed. Final: 46, 43 caught, 3 equivalent.

   Done in step 7c (the providers and the fetch transport, CHAIN_DESIGN.md s.19; UNREVIEWED), against a
   real in-process HTTP server on 127.0.0.1, never the network:
   - A POST of the JSON body with JSON content type and accept headers; a 200's text and its rate
     headers (a negative remaining count kept); the headers read from digits only (twelve malformed
     forms, a date-form Retry-After among them, are missing).
   - An error status (429, 403, 500) with its headers, its body dropped: unread when its content-length
     is over 4 KiB, else stopped at the first chunk past it; a 204 with no body.
   - Refusals: a redirect (its target never reached), a 200 that is not JSON (four types; the type is
     case-insensitive), a content-length over the cap (unread), a gzip bomb (20 MiB of spaces in 20 KiB,
     stopped past 64 KiB of decoded bytes), exactly the cap read and one byte more refused (with and
     without a content-length), invalid UTF-8 inside the text and at its very end, a request over 48 KiB
     in UTF-8 bytes (never sent; exactly 48 KiB goes).
   - Ends: a stalled body as a timeout or as shutdown, no answer at all as a timeout, a refused
     connection and the real fetch at a closed local port as transport failures, nothing sent once
     stopping; impossible arguments as TypeErrors.
   - The provider URL: the public endpoint pinned (https, no key, frozen) and the genesis hash a
     canonical 32-byte value; another scheme, a user, a fragment, an unlisted query value or a too-short
     secret refused without naming the URL; a key in the query registered as an own secret, and no
     outcome naming the URL or the key, a redirect's error included.
   - Planted bugs (scratchpad `mut/run43.py`): 30, 29 caught on the first run, 1 equivalent.

   Done in step 7d (the JSON-RPC layer and the strict decoders, CHAIN_DESIGN.md s.20; UNREVIEWED):
   - Requests: the exact request text for each Phase 2 method, bigints as digits; getTransaction's
     version 1 written over the caller's; a sending, refused, inherited or unknown method, a bad id and
     params that are not a list refused. The builders: commitment `confirmed` and encoding `base64` on
     the wire, `minContextSlot` always sent; 0 or 101 keys, a key twice, a key that is not an address,
     a slice or size outside 10 MiB refused; a full batch of 100 fits the request cap; all frozen.
   - Envelope: every transport outcome to its kind; 429 with Retry-After (10 s, missing, over 600 s),
     403, 400/405/413/415 and other statuses; bad JSON; 15 malformed envelopes; a wrong, missing, text,
     float or null id (null accepted only with -32700 and -32600); every code row of s.4's table to its
     kind, -32016 with and without a valid slot; a body 429; codes at and past the 32-bit edges; no
     failure carrying the node's message; everything frozen.
   - Decoders: the genesis hash, slots and block heights at 0 and 2^63 - 1 and past them, respelled
     integers refused; rent at 0 and u64 max, the formula at 0, 165, 170 bytes and 10 MiB; accounts in
     request order with null for a missing one, data a fresh copy, u64 lamports above 2^53 exact; the
     count against the keys; 18 malformed tops and contexts and 30 malformed accounts (each key missing,
     an extra one, floats, 1e3, strings, negatives, past u64, owner not 32 bytes, data not exactly
     `[base64, "base64"]` or not canonical, its length off by one); with a slice, the length
     `min(length, max(0, space - offset))` at the start, the tail, the end and past it, off by one either
     way, and the size bounds on their own; fees: 150 in reverse order sorted, 151 refused, a slot twice,
     12 malformed entries.
   - Property tests (1,000 cases each): random valid batches and fee lists decode to exactly their
     values; a random structural mutation (a key removed, added or renamed, another JSON type, an
     integer respelled as 1e0, 1.0, 1.00, 1E+0 or a string) is always refused. core/json.ts: a run of
     more than 20 digits stays a JS number (a million digits under a second); stringify refuses -0.
   - The fixture scan: no 32- or 64-byte base58 literal in src/ or tests/ outside its allowlist of
     eight; a canary built from bytes (found once however often it appears; 33 bytes and joined runs not
     found).
   - Planted bugs (scratchpad `mut/run44.py`): 106, 102 caught, 4 equivalent.

   Done in the review Y fix (CHAIN_DESIGN.md s.21): past the byte cap the connection is released at once,
   for a 200 and for an error body, against a server that never stops sending and timers that never fire;
   a body whose cancel itself fails is let go on both release paths with no throw; prefixed content types
   refused; a timeout above 2^31 - 1 ms and a byte cap above 16 MiB are TypeErrors
   at once, and every method's limits fit inside them. Planted bugs (scratchpad `mut/run45.py`): 6, 6
   caught.

   Done in step 7e (the governor conditions and the read client, CHAIN_DESIGN.md s.22; UNREVIEWED):
   - Governor (review Y, risk 2 to 9): a 429 closes its method for at least 10 s, Retry-After 0, 3 and 10
     included (and the envelope dates it the same way); a learned limit of 0 or 1 refuses the method and,
     for a method P0 uses, fires `chain-p0-blind` (getProgramAccounts does not); half the limit rounds
     down (13 gives 6); a method learned down to its P0 reserve counts for the 80% rule again; nothing
     granted before a finite clock reading (`clock`); the shed timer refreshed at level 3, the 80% hold
     reset below 80%, a full window's exact retry time, -32016's slot never clamped; the property tests
     at 1,000 runs.
   - The genesis lock: every call `unverified` and nothing sent (not even the budget asked) until the hash
     is mainnet-beta; a failed check leaves it unverified; another hash latches `wrong-cluster` (one
     event, no more requests, a right answer later changes nothing); a hash of the wrong shape is `shape`;
     due again after exactly one hour; a failed re-check keeps reads open; a wrong re-check latches.
   - The wire: the exact request text of each method (commitment `confirmed`, encoding `base64`,
     minContextSlot always), each method's timeout and byte cap, a fresh id each time; bad call options
     refused before anything is sent.
   - The mark (review X, risk 1): one wild context slot raises it only to the feed's slot, so the next
     honest read succeeds; it does not move while the feed has no slot, and rises with the feed.
     `went-back` for a context and for getSlot below the slot sent (equal is fine); `stale` past 150
     slots behind the feed (exactly 150 is fresh; no feed slot, no judgement); neither is reported.
     Reports go to 'http' only, for slot() and context slots, never for the other reads.
   - The budget: a request over the (tightened) size cap is our bug before the budget is asked, with its
     event; a denial comes back as `denied` with its reason and time and nothing sent; a body 429 closes
     the method like a status 429; a throwing or rejecting transport is settled (the connection comes
     back); latency on the monotonic clock.
   - Answers: accounts in key order with null for a missing one; fees sorted and an empty list empty;
     rent from the chain even off the formula (with its event); shape, count and id refusals with
     `chain-shape`; our bug with `chain-our-bug`; node-behind, timeouts and the rest with no event;
     apiVersion events once per change, the version only in plain form; a throwing sink ignored;
     everything frozen; `FAILURE_RULES` pinned for all 16 kinds; the type has no send, sign or rpc member
     (`@ts-expect-error`, `Extract` checks) and exactly its eight members.
   - JSON: a duplicate key, the last one wins (written down). The fixture scan: base64 runs of 64 or more
     characters refused outside their allowlist, hex left alone, a hyphen ending a run; both allowlists
     checked by one function the canaries call.
   - Planted bugs: scratchpad `mut/run46.py` (7e-1) 15, 15 caught; `mut/run47.py` (7e-2) 51, 50 caught on
     the first run, the 64-character canary added, final 51, 51 caught.

## 4. Property-based tests (fast-check)

| Invariant | Generators | Property |
|---|---|---|
| 1 approval tokens | random intents, plans, token reuse, expiry slots, tampered plan fields, wrong mode | executor accepts exactly the matching, unexpired, unused token of the same mode and kind |
| 2 caps | portfolios (0-4 open or opening positions), equity 0..2^63, prices, pool reserves, config versions within bounds | every approved buy satisfies limits 1-8, 11 and 13-24; never more than 4 positions, never two on one mint |
| 3 reserve | balances near the reserve, fee estimates, rent, N = 1..4 | SOL after a buy >= the reserve computed with the new position; no underflow |
| 4 blocks and exits | random flag and breaker combinations | buys rejected when any block applies; valid reduce-only exits always approved |
| 5 no shorting | random sell sizes, concurrent exit attempts | sell <= sellable; in-flight sells <= holding; balances never negative |
| 6 conservation | random sequences of fills, failed attempts, fees, rent refunds | starting SOL + fills - cost lines = current SOL, exactly; a planted mismatch trips PAPER_LEDGER |
| 7 amount hygiene | bigint 0..2^64-1, negative PnL, boundary values, malformed strings | no NaN, Infinity or negative sizes; signed PnL round trip; TEXT round trip exact; out-of-range input throws |
| 8 venue math | reserves 1..2^64-1, fee bps 0..9,999, inputs | output < reserve; monotone; inverse exact; rounding never in our favour; minOut <= expectedOut |
| 9 2x costs | random trades | 2x estimate >= 1x; 2x shadow PnL <= 1x PnL |
| 10 rent | random exit sequences | refund only after 100% sell plus close |
| 11 config | random /set and AI changes, rollbacks | effective config always within bounds; every TUNABLE_BOUNDS max <= its H; rollback exact |
| 12 signer policy | random and adversarial messages: lookup tables, AdvanceNonceAccount, Transfer, TransferChecked, Approve, SetAuthority, foreign CloseAccount, wSOL transfer to a foreign or unclosed account, tips over 5,000 or to non-allowlisted accounts, value accounts not ours, re-serialized bytes, oversize requests, cap and rate exhaustion, KILL file missing, restart without arming | the signer refuses every one; it signs exactly the validated bytes; counters and caps hold across restarts |
| 13 idempotency | event streams with duplicates and shuffles; failing exits | same intents and orders as the clean stream; every failed or expired exit yields exitSeq + 1 |
| 14 day roll | instants across Athens DST changes, clock jumps | day boundary at local 00:00; backwards day halts |
| 15 Telegram, AI | random updates from other ids, group chats, wrong pairing codes; random AI outputs | no state change; 5 wrong codes burn the code; accepted proposals within bounds and direction; paper model untouched |
| 16 sizing | equity, liquidity, caps | result never above any single cap; more equity or liquidity never lowers a cap |
| 17 concurrency | interleavings of 2-6 approvals and fills on one SQLite file | the caps hold together; one in-flight order per mint |
| 18 rounding | random amounts | caps round down, costs and reserve round up |
| 19 reduce-only | random tokens and plans | a reduce-only token never executes a buy or another mint |
| 20 withdraw | balances, reserves, amount strings (exponents, signs, 10+ decimals, spaces) | amount <= free SOL - reserve; parse rejects malformed input; paper refuses |
| 21 flags mid-buy | KILL, HALT, PAUSE, daily stop set at each attempt index | no further paper attempt and no live resend |
| 22 baseline and peak | withdraw, deposit, sanity breach, equity jump, dust | exact adjustments; breaches never move them; unknown mints never in equity |
| 23 counterfactual ledgers | shadow, twin, tournament paths | no OrderPlan or token can be built from them (type test and runtime test) |
| 24 modes | random sequences of /set, /approve, /rollback, AI proposals, restarts, migrations | no mode ever becomes live except through /golive |

Each property runs 1,000 cases in CI (10,000 in a nightly local run); shrunk
counterexamples become fixed regression tests.

## 5. Unit tests by module

| Module | Must cover |
|---|---|
| chain/ | budget buckets, P0 reserve, shed levels 1-3, header learning, Retry-After, 403 handling, every getTransaction/getBlock carries `maxSupportedTransactionVersion: 1`, getTokenLargestAccounts refused, timeouts, strict rejection by the hand-written decoders (no zod: CHAIN_DESIGN.md R8), context-slot staleness, block-height expiry; the paper ProviderClient type has no send method (type test); the full list per sub-step is CHAIN_DESIGN.md s.13 |
| fomo/ | invoke-stack parser (nested CPIs, truncated logs, failed tx), pump TradeEvent and PumpSwap Buy/Sell decoding by discriminator, unknown discriminator, completeness flags, pool-to-mint cache, user tags never leave memory, raw samples never persisted, decoder error logs without addresses or signatures, windows 1/5/15, sybil metrics, watermark and late events, anchors and ratios, coverage audit |
| safety/ | raw TLV parser for all 29 extension types, the REJECT/ALLOW/ALLOW-IF table, unknown type 29+, bad lengths, jsonParsed-without-extensions trap, authorities, metadata mutability, holder exclusions (curve, pool vaults, PDAs off-curve, mayhem vault), holder-sim picks (never creator, top-10 or launch-slot buyers; holder not logged), probe bytes with zeroed signatures, sell-probe result parsing, cost rule items, TTL |
| strategies/ | pure: same input, same output; no imports outside the allowed list; each entry rule and its reasons |
| exits/ | universal exits first; each policy; stale-price protective path; two-sample confirmation for take-profit and trailing |
| execution/ | planner minOut, fees and maxSpend; canonical planHash covers every field (changing any field changes it); T1-T3 transactions; paper latency, landing rolls, failed attempts, rent, own-impact overlay, 2x shadow, twins; order state machine; stuck retry only after a passing simulation and within the failed-fee budget |
| telegram/ | pairing (10+ base32 characters, expiry, constant-time compare, 5 wrong attempts in total, private chat only, `allowed_updates`), owner-only, rate limits, nonce expiry and reuse, callback answered, 409 handling, outbox throttling, live loosening queued 24 h with the `fomo-notice` ping, alert text without third-party strings, `parse_mode` unset, previews off, AI text ASCII and length-capped without URLs |
| ai-review/ | cost guard at the cap, refusal and error paths, schema failure, bounds, step and direction rules, no names, symbols or third-party data in the prompt |
| ops/ | run lock on Windows and Linux, heartbeat semantics, disk thresholds, backup rotation (7), weekly DB copy refused when a planted secret pattern is present |
| secrets, redactor | loader reads files once, refuses without `--load-secrets`, refuses `--heapsnapshot-signal`, `--report` and `--inspect`; canary secrets (bot token, `sk-ant-`, hc-ping URL, 64-byte key as base58 and JSON array) never appear in logs, DB text columns, Telegram text, errors, exports or prompts; Solscan links built after redaction |
| signer/ (Phase 8) | every rule of THREAT_MODEL s.5 accepted at its edge and refused just past it; ATA derivation against fixtures; arming and KILL latch; counters file missing or corrupt means no buys |
| import graph | parses every import; fails on a forbidden edge (strategies or ai-review into chain, execution, signer, storage, telegram; anything but storage importing `node:sqlite`; signer importing any npm package) |

## 6. Fixtures and replay tests

Recorded read-only from mainnet with `npm run fixtures:record` (paced under the budget table).
The recorder keeps raw data in memory and writes only scrubbed output: user wallets,
signatures, blockhashes and slots are replaced by fixed fakes inside the bytes (or the
fixture is synthetic), because the repository may be public (D1, D2). Public program,
fee-config and token-mint addresses stay.

| Fixture | Source (VERIFIED_FACTS, research) | Tests |
|---|---|---|
| FOMO v1 trades: pump-curve leg, PumpSwap leg, DFlow-only, Jupiter-only, failed trade, signer-only non-trade | fresh recordings, Phase 3 | decoder, completeness, `maxSupportedTransactionVersion: 1`; scrubbed as above |
| pump.fun create_v2 launch (phase0-token-safety row 15), mayhem mint `897tnAdpiAETR2E3nHropcXWdwpikQFMCSd6raXwpump` | phase0-token-safety rows 15-16 | launch event, Token-2022 mint with metadata extensions, mayhem rejection |
| Launch-slot pattern, mint `5w3sGrqfkJZhaTis1nZa4YbVY6VAP21qrmbjEkmApump` | phase0-token-safety row 34 | same-slot identical buys; buyer addresses scrubbed |
| Curve FeeConfig `8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt`, PumpSwap FeeConfig `5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx`, Global `4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf`, a canonical PumpSwap pool | VERIFIED_FACTS s.3 | fee tiers, layouts, PDA derivation |
| PYUSD `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo` | row 23 | reject: permanent delegate, confidential transfers, hook authority |
| BERN `CKfatsPMUf8SkiURsDXs7eK6GWb4Jsd6UDbs7twMCWxo` | row 37 | reject: transfer fee with live authority |
| LIBRA `Bo9jh3wsmcC2AjakLWzNmKJ3SgtZmXEcSaW7L2FAvUsU` | row 38 | passes static checks, mutable metadata logged: "static pass is not safe" |
| TUCAT `6oEkKhW6yvs64oNPjaj4oQZZjBrKUt9X5BnBfNQHTfzp` | row 39 | reject: freeze authority |
| Fartcoin `9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump` | row 21 | legacy pump token, curve complete: graduated path |
| USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | row 22 | reject: mint and freeze authority |
| Synthetic mints and messages | built in tests | unknown extension type, bad TLV length, Token-2022 mint over 82 bytes without extensions; adversarial signer messages (invariant 12) |
| Failed and partial fills | recorded pump and PumpSwap failures (scrubbed); synthetic curve near completion | minOut failure pays fees; buy capped by real tokens; BondingCurveComplete |

Rules: third-party API recordings with redistribution limits (DexScreener, Jupiter) and
unchecked terms (GeckoTerminal) are withheld from git the way the root project's
`tests/withheld.py` does it: a `tests/withheld.ts` list, tests skip with a clear reason when
the file is absent. The official pump IDL files are not committed (licence UNVERIFIED);
tests compare our hand-written layouts with the IDL's hash and fields when the file is
present locally. A fixture lint fails if a committed fixture contains an address that is not
on the public allowlist above. Replay tests feed recorded streams through the real pipeline
at 1x and 10x speed with a fake clock and must produce identical decisions.

## 7. Integration tests

- Full pipeline with fakes: FOMO notifications to intent, safety, risk, plan, paper fill,
  exits, ledger, Telegram alert, in one process.
- Restart: kill the process at each order state (intent saved, T1 committed, token consumed,
  order submitted, fill written) and restart; expect no duplicate order, the opening row
  resolved, and the rules of ARCHITECTURE.md diagram (e).
- Races: two intents for the last cap room, and two for one mint, approved concurrently: one
  wins, the other is rejected with a logged reason.
- KILL, HALT, PAUSE and daily stop set between paper attempts 1 and 2: no attempt 2.
- Telegram against a local fake Bot API: pairing, every command, confirmations, 409, live
  loosening queued 24 h and cancellable.
- AI review against a fake Messages API: valid, refusal, error, invalid schema, over cap.
- Config: /set, AI approve, rollback, restart with each version; modes unchanged by all of them.
- Live loosening by /rollback: rolling back to a looser risk version (e.g. tradePct, poolShare,
  slippage) queues each looser field for 24 h with the notice; safer fields apply at once.
- Signer budgets (Phase 8 code, test written with the caps in Phase 2): the exit fee budget
  covers (max open positions + max entries per day) x 3,380,000 plus close fees for both
  HARD_CAPS and LIVE_CAPS; a disarmed signer rejects a buy whose request says "sell".

## 8. Chaos tests

| Scenario | Injected | Expected |
|---|---|---|
| WebSocket drop | close mid-stream, reconnect after 1-60 s | crowdflow entries off, gap recorded, warm-up, exits continue |
| Silent stall | socket open, no messages | DATA_STALE within 5 s, reconnect |
| Partial loss | fake drops 30% of marker messages | coverage audit under 80%: FOMO_SIGNAL |
| 429 storm | every method 429 with Retry-After | shed levels in order, P0 kept, entries off when P0 denied |
| 403 | provider blocked | all entries off, alert, marks degraded |
| Stale data | reserves frozen, lagging context slot | entries off; protective exit at 60 s; valued 0 at 5 min |
| Price manipulation | one-sample spike up and down | no take-profit on one sample; no entry on divergence |
| Equity jump | +60% in 1 h, once verified by marks, once unexplained | first clears by itself; second halts; baseline and peak unchanged until cleared |
| Duplicates and reorder | every event twice, shuffled within 20 slots | identical decisions to the clean run |
| Exit failures | every sell attempt fails for 10 min | exitSeq rises, attempts stop at the failed-fee budget, stuck, alert; reserve never breached |
| Dust and spam | unknown mint deposited; 0.0001 SOL dust; 0.001 SOL dust | first two ignored and out of equity; third trips UNEXPECTED_BALANCE |
| FOMO marker silence | marker rate to 0, signer normal | FOMO_SIGNAL in 10 min, recovery with hysteresis |
| Decode drift | unknown discriminators appear | DECODE breaker |
| Program upgrade | account size or discriminator change | venue off, self-test path |
| Restart mid-trade | crash at each order state | section 7 rules, no double order |
| SQLite damage | corrupt page, read-only file, disk full | halt entries, alert, no auto-restore |
| Clock jump | wall clock +/- 1 h, monotonic steady; drift 3 s and 12 s | timers unaffected; entries off; halt over 10 s |
| Memory pressure | many tokens tracked | cold-token shedding, bounded memory |
| Telegram outage | API unreachable 31 min | entries off, heartbeat `/fail` |

## 9. Paper-engine pessimism tests

- A fill is never better than the exact math on reserves read after the latency, minus the
  competition allowance; at 2x it is never better than at 1x.
- A failed reserve re-read at t + L is a failed attempt with fees, never a fill at the
  decision quote.
- Every failed attempt charges base and priority fees, priority on the requested CU limit;
  tips only on landed attempts; p_fail rises when the priority clamp binds.
- The model never runs below its HARD_CAPS floors; /set cannot lower them; any change
  restarts the gate count.
- Rent is charged on every buy and refunded only after a full sell plus close.
- Moonbag policies carry their locked rent in their score.
- The paper engine never reads data stamped after the decision (look-ahead guard test feeds
  future events and expects them ignored).
- Random twins use the same size, exit policy and cost model as the real entry.
- Golden-file test: a recorded hour replays to the same PnL to the lamport.

## 10. Coverage targets

At least 90% lines and branches on `core/`, `venues/` math, `portfolio/`, `risk/`,
`config/` caps and bounds, and the Phase 8 signer policy; at least 80% elsewhere. Coverage
is a floor, not proof: the property and chaos tests above are required regardless.

## 11. Commands and CI

Locally: inside Docker (`docker compose run --rm --build test`, which runs the test stage)
or, for development only, natively from `fomo-bot/` with `npm ci --ignore-scripts`,
`npm run typecheck` (`tsc --noEmit`), `npm test` (Node's built-in `node:test`, running the
`.ts` files directly), `npm run test:coverage` (Node's coverage, then
`tests/tools/check-coverage.ts` checks every file of the lcov report against s.10) and
`npm run check:lockfile`. The import rules are a node:test test using the TypeScript
compiler API; eslint is deferred until it has its own review. Root checks before every
commit (repository root): `uv run pytest`, `uv run ruff check src tests`, `uv run mypy`.

Secret scanning: a committed `.gitleaks.toml` extends the default rules with: JSON arrays of
64 integers, base58 strings of 87-88 characters, `hc-ping.com/` URLs, Telegram bot tokens
and `sk-ant-` keys (known public signatures in research notes go in `.gitleaksignore` by
fingerprint after review). The pre-commit hook (`gitleaks git --pre-commit --redact --staged
--verbose`) is installed with `git config core.hooksPath` to a committed hooks folder (after
checking the root project uses no other git hooks) and fails closed if the binary is missing.
gitleaks v8.30.1's SHA256 is verified against its release checksums before install.

CI (GitHub Actions; actions pinned by commit SHA; `permissions: contents: read`; no
`pull_request_target`; GitHub-hosted runners only; no secrets in CI):
1. Supply chain: `.npmrc` has `registry=https://registry.npmjs.org/`; every lockfile entry's
   name@version+integrity must be in the committed approved list `fomo-bot/ops/approved-packages.txt`
   (new transitive packages fail the build), integrity sha512 only, every `resolved` URL on
   registry.npmjs.org; `npm ci --ignore-scripts`; `npm audit signatures`;
   `npm audit --audit-level=moderate`. The image build's first stage runs the same checks.
2. Checks: typecheck, the node:test suite with the per-file coverage gate (and its canary
   tests), and a check that `.npmrc` holds no `_auth`, `_authToken` or `//host:` lines, on ubuntu-latest and
   windows-latest (paths, LF endings, ASCII output, run lock); the Docker build with its
   no-network test stage on ubuntu-latest.
3. Secrets: `gitleaks git --redact --verbose` with `.gitleaks.toml` over the full history
   (fetch depth 0).
4. Root project: `uv sync --locked`, `uv run pytest`, `uv run ruff check src tests`,
   `uv run mypy`.
5. Once the owner approves ARCHITECTURE.md s.14 decisions 13-14: a root hook test
   (`tests.test_guard_hook`) for every new block and deny rule, each blocked and each
   harmless look-alike allowed.
6. Compose file: a test parses it: no `docker.sock` mount anywhere, `/srv/fomo-signer`
   mounted only into the signer, no published ports, the signer has `network_mode: none` and
   logging `none`, and a `test` service with no secrets and no network (`ops/update.sh` and
   the compose file come from the deployed tag).

## 12. What tests cannot show

Whether any strategy has an edge, real landing rates and latency, whether the public
WebSocket survives weeks, and how often baits and sandwiches hit us. Those come only from
the paper soak (Phase 7) and the owner-approved minimum live test (Phase 8).
