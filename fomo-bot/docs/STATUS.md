# Status

Updated: 2026-11-14

**Phase 2 (foundations, tests first): in progress.** Paper-only building blocks; nothing
can trade, and no key or account exists anywhere.

- Done: the toolchain the security reviewer approved (Node 26.13.0, TypeScript 6.0.3,
  fast-check; 5 dev packages, exact pins, no install scripts), with gates that keep it that
  way: lockfile allowlist, per-file coverage gate, architecture rules, a no-secrets test setup.
- Done (steps 1-3 of 6): money units and checked math; venue quote math (pools, the pump.fun
  curve, fee tiers); the portfolio ledger (every cost line, cost basis, rent, realized profit
  and loss, deposits and withdrawals) and equity with stale or missing prices. Property tests
  run 1,000 cases each; coverage 100% of lines.
- Reviews: steps 1-2 were committed before their risk and security sign-offs (a process
  gap); steps 1-3 were reviewed together on 2026-11-09, both APPROVED with conditions, and
  the findings due now are fixed (REVIEWS.md, entry D).
- Root project: 31 of its tests failed on some days because its demo prices follow the real
  date; they now use a fixed date (tests only). All 2,065 root tests pass.
- Step 4 (risk engine), six parts built: the fee reserve that keeps selling affordable and
  entry sizing (every cap, rounded down; a pool can refuse an entry but never stop the
  bot); the entry blocks (kill, halt, pause, daily stop, breakers, modes, cooldowns,
  counters; every reason listed, selling never blocked); the sell rules (a sell or an
  account close is always allowed, but only from our own token account to our own wallet,
  never more than is held); the plan re-check and approval tokens (risk re-derives every
  number from its own quote and the approved pool, only a plan that passes can get a token,
  a token works once in one mode); the equity and day state (daily stop, peak halt, sanity
  limits, the "+50% in an hour" hold, deposits and withdrawals, Athens midnight on 23- and
  25-hour days; two bad days in a row stay a halt until you resume); and the approval step
  that puts blocks, sizing, the fee reserve, the plan re-check and the token together on one
  snapshot (every open and in-flight position counted, the SOL a buy still holds kept back).
- Review of the work written by Sonnet 5.5 (REVIEWS.md K): the last two pieces (plan
  re-check and tokens, equity and day state) were written on Sonnet 5.5 and approved by
  Sonnet-run reviewers, so you asked whether Opus 5.5 would have done as well. Two Opus 5.5
  reviewers looked cold and found real gaps (about four meaningful ones in the money code,
  a few medium ones in the guardrail tests); all are fixed except two design points about
  who holds the token store and the slot clock, which must be done before any code that
  sends orders exists (REVIEWS.md K, findings 2 and 3). Plain answer: not as good as a
  top-tier first draft, good enough once an independent model reviews it, and nothing was
  at risk because nothing can trade yet. From now on new money code is reviewed by Opus.
  The Opus reviewers then re-checked the fixes and the new approval step: approved with
  notes; the one due in the config step is now done (next point).
- Step 5a, the hard-limits file (`config/caps.ts`, created with your OK): every hard limit
  lives in one protected file, and the risk engine caps every setting at it, so a setting
  that asks for more gets the hard limit (40 open positions acts as 4). Live trades get the
  stricter live limits: 5% of the account per trade, EUR 5 per position and EUR 10 in total,
  5 entries a day, -3% daily stop, -15% peak halt; no euro price that day means no live
  trades. 537 tests pass, run with frozen built-ins and no code from strings; each new limit
  check was broken on purpose and a test caught it. Both Opus reviewers approved with notes
  (REVIEWS.md L): the one fix due now, a gap in the architecture test, is done and
  confirmed; two notes are due before live (warn when a setting is capped, and a SOL
  backstop for the euro caps in case a price feed is wrong).
- Stricter than the design, for you to know: trade sizes use the lower of this morning's
  and the current account value, so a price spike never makes trades bigger; and a single
  buy can never exceed 0.06 SOL, fall under 0.01 SOL or cost more than 0.07 SOL in the worst
  case, whatever the sizing says (the 0.07 SOL ceiling is new, a margin above the 0.0617 SOL
  of limit 2; it loosens nothing); and sizing always assumes the highest allowed fees, never
  the fees an order plan claims it will pay.
- Step 5b, the settings you can change (/set) and the AI's suggestions: 36 settings, each with
  its allowed range, which direction is safer, and what the AI may do with it. While live
  trading is possible, a risk or exit setting made riskier waits 24 hours (you can cancel it);
  a strategy's own settings apply at once but put that strategy back on paper if it is live.
  The AI may change a setting by at most a quarter, once a week, at most 3 suggestions per
  review, and never the paper-trading model, which nothing can make less pessimistic. Every
  change is a saved version, and /rollback goes back one version (riskier values again wait
  24 hours in live). Nothing here can switch a strategy to live. Both Opus reviewers approved
  with notes (REVIEWS.md M); everything they found is fixed (exit settings now wait too, undo
  can no longer soften the paper model, stored records are checked strictly).
- Step 6, the database, is designed (docs/STORAGE_DESIGN.md, by the architect): one small file
  talks to the built-in database, every money decision is written in one locked transaction,
  and the database adds its own safety checks (one position per token, a token works once, no
  live mode except /golive, a waiting change really waits 24 hours). It is built in five parts.
  Part 6a is done: the approval tokens' single-use record and their slot clock are now fixed
  when the bot starts, so the part that sends orders can never bring its own (this closes the
  open item of the security review K). Both Opus reviewers approved (REVIEWS.md N); their
  fixes are in (the order sender gets a redeem-only key, impossible slot numbers are ignored,
  stricter import rules), and one item waits for part 6d: the slot feed must reject a
  wrong-but-possible slot number by comparing it with the clock and a second provider.
  602 tests pass.
- Part 6b, the database core, is built (tests first): one file opens the database and checks
  every command before the database sees it (one command at a time, no hidden settings
  changes, never a decimal number for money), and every write is one all-or-nothing step; if
  the disk fills up halfway, nothing of that step is saved. A second file is the only place
  where stored text turns into amounts, and a test proves the database's own checks and the
  code agree on what a valid amount is. Layout upgrades of the database only go forward,
  after a health check and a private copy. Building it turned up three traps in the built-in
  database, now blocked and tested: a second command in one text is silently skipped, a
  settings change acts even when only prepared, and "insert or replace" can delete a row
  that is meant to be permanent. Both Opus reviewers checked it (REVIEWS.md O). The risk
  reviewer first blocked it over one real gap: if the code inside a database step caught an
  error and carried on, the rest of the step was still saved (say, a new position without the
  count that limits positions). Now any error sinks the whole step. That and every other fix
  they asked for are done, and both then approved, with notes for the next parts (the tables
  in 6c, the start-up checks in 6d). 700 tests pass; 101 of 102 planted bugs are caught (the
  one left is the disk sync of a backup copy, which only a power cut could show).
- Part 6c-1, the database tables, is built (tests first): 17 tables for settings, flags and
  halts, strategy modes, the day state, the book, positions, the order path and an audit log.
  The database itself refuses what must never happen, under the code's own checks: a second
  position in one token, a fifth position, a second buy for a position, two sells at once, an
  approval used twice or after it expired, an order without its approval, a strategy going live
  except through /golive, more than 12 entries a day. KILL and a halt can be lifted only right
  after your own audited command; per your decision D4, the live halts only at the server.
  Nothing that looks like a key, a seed phrase, a bot token or a web address can be written. I
  found and closed a gap in the design: a halt could have been deleted when no audit record
  existed at all. Both Opus reviewers first blocked it (REVIEWS.md P). They found ways to lift a
  halt or KILL without you (rename or backdate a halt, rewrite the KILL time, or forge an audit
  record with a chosen number or the wrong sender). They also found a way to hide a settings
  change inside a database upgrade script. All of it is fixed and tested. Halts and KILL now
  keep their name and time; audit records must come in order and say who wrote them; an
  approval must match its own approved decision and position. The re-check found one more:
  had the server clock ever jumped ahead, the database would have refused a KILL afterwards.
  Now KILL and halts follow the audit records' numbers instead of the clock, and no clock
  jump can block a safety write. 798 tests pass. 159 of 161 planted bugs are caught; the two
  left are harmless by design, because another rule already does what they remove. After the
  fixes both Opus reviewers approved, with notes for the next parts (REVIEWS.md P; the list is
  in STORAGE_DESIGN.md s.12.1).
- For you to know before live: at 5% per trade, live trading needs at least 0.4 SOL in the
  account with the 0.02 SOL minimum trade (0.2 SOL if you lower it to 0.01); below that the
  bot makes no trades. Paper and live entries share one daily count, so paper trades can use
  up the 5 live entries, never the reverse (separate counts would need your OK).
- Next: the rest of step 6 (6c-2 the code that reads and writes the tables, 6d the approval
  transaction, 6e settings and day-state transactions); then chain clients, the paper engine,
  Telegram and logging.
- Before Phase 3: four guard-hook fixes (REVIEWS.md A). No lint script yet: eslint is
  deferred until it is reviewed.
- For you to do: make the GitHub repository private; send the Helius email when you like;
  before Phase 7, turn on GitHub 2FA.
- Unproven: whether any strategy makes money. Nothing has run on paper yet.
