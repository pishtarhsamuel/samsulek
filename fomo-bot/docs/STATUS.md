# Status

Updated: 2026-11-20

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
- Part 6c-2a is built (tests first). It adds the code that reads and writes the flags, halts,
  strategy modes, bans, the daily entry count and the audit log:
  - The database checks every statement before it runs, as a second line behind the code's
    own checks. A normal statement can only read and write the bot's rows; settings changes,
    other files and new tables are refused.
  - SQL is always fixed text, written only in the storage files (a test enforces it).
  - Every audit record is chained to the one before it, so a changed or removed record is found.
  - Only your own commands can lift a halt or clear KILL: the engine's code cannot even reach
    the files that write your records.
  Both Opus reviewers checked it (REVIEWS.md Q). The risk reviewer blocked it over two small
  gaps in what the engine's code was allowed to do: it could have shortened the 15-minute wait
  after you lift a halt, and moved a strategy's go-live count back in time. Both are fixed:
  only your commands record when a halt was lifted, and a count's start can only move later.
  Also fixed: a strategy goes live only from paper; leaving live, by you or automatically,
  restarts its go-live count; ended cooldowns are deleted only a day later, so a clock jump
  cannot erase a running one. The security reviewer approved with notes, and the ones due now
  are done: a test now checks which code file may write which part of the database, and that
  the database connection cannot be passed around in disguise. I also fixed two tests that
  failed now and then by chance. 852 tests pass. 141 of 142 planted bugs are caught; the one
  left repeats a refusal another check already makes. After the fixes both reviewers approved,
  with notes for later steps (REVIEWS.md Q; the list is in STORAGE_DESIGN.md s.13.1).
- Part 6c-2b-1 is built (tests first): storing the settings and each day's totals.
  - Settings: version 1 is written once at the server; your /set, /rollback, /cancel and AI
    approvals each record your audit entry first, in files the engine cannot reach. The engine
    can only apply a loosening you queued, exactly as queued, once its 24 hours are up; storage
    checks this itself, so a bug in the engine cannot change a setting you did not ask for.
  - Day totals: your /resume and the server reset restart the peak or the streak in the same
    step, as the risk rules require.
  - Your decision D6 is in: clearing KILL now also starts the 15-minute wait.
  Both Opus reviewers checked it (REVIEWS.md R). The risk reviewer blocked it: the engine's code
  could still have cleared today's daily stop or a held equity jump, or kept the "two bad days"
  halt from ever firing, because those live only in the day totals. Fixed: every write of the
  day totals is compared with the stored ones and refused if it is looser than the risk rules
  could make it in one step. A test runs thousands of random days of the risk rules through it
  and shows it never refuses a real step. Also fixed: a waiting setting change must be asked for
  now and wait a full day; a new settings version is dated sensibly; your /set and /rollback
  replace the waiting changes they should. Building this I found and fixed a small gap in the
  risk rules: a deposit right after a large withdrawal could have shrunk the day's loss limit.
  On the re-check both reviewers approved with notes. Two small gaps they found are fixed too: a
  day's totals can no longer start at zero (that would have switched the daily stop off for the
  day), and no date can be written past today (that would have frozen the bot for good). 899
  tests pass. 70 of 73 new planted bugs are caught; the three left repeat a check another line
  already makes. Both reviewers then approved the final version (REVIEWS.md R); their notes for
  later steps are in STORAGE_DESIGN.md s.14.1.
- Part 6c-2b-2 is built (tests first): storing the money and the money path.
  - Your setup at the server writes the paper bankroll once, and live at zero. Nothing can change
    either account afterwards yet: deposits and withdrawals arrive with live trading in Phase 8,
    with their own record so one transfer is never counted twice.
  - Positions, what a strategy asked for, what the risk engine decided, the one-time approval and
    the order are stored. Only the token store inside the risk engine's own check can use an
    approval and create an order, and storage checks the plan's fingerprint itself.
  - What the bot records about why it wanted a trade holds only numbers and short labels, never
    another person's wallet address, so no FOMO user's wallet can end up in the database (the
    orders hold the bot's own public addresses, which explain a trade).
  - 968 tests pass, and every line and branch of the five new storage files is tested. Both Opus
    reviewers checked it (REVIEWS.md S) and approved with notes; the fixes they asked for went in
    first: a strategy's reasons could have slipped free text (an error message or an address)
    into the database; a decision could have been read two ways; an approval for a different
    token than its position's would have been accepted; the paper bankroll had no upper limit
    (now at most 2 SOL, the hard sanity limit); and the rule on who may close a position is
    tighter. 105 of 109 planted bugs are caught; the four left repeat a check another line
    already makes. Their notes for the code that will record trade results are conditions in
    STORAGE_DESIGN.md s.15.18. Your decision D7 is in: the paper bankroll stays fixed.
- Step 6d connects the risk engine to the database, in three parts (the design is
  STORAGE_DESIGN.md s.16). Part 6d-1 is built (tests first): the one-time approvals.
  - The bot makes exactly one approval authority per run, with a fresh random key that is never
    stored; the key is also put on the secret filter's own list, so no text the bot saves or sends
    can contain it in any common encoding.
  - Using an approval and recording its order happen in one database step, from what the risk
    engine checked, never from the trading code's own objects. While new entries are stopped, or
    after KILL (the KILL file included), no buy approval can be used; a sell always can.
  - The bot's view of the chain's current slot (its clock for how old a quote is) accepts a new
    reading only when it is plausible, or when two sources agree; one wild reading is ignored.
  - Every failure is sorted into a fixed code: refuse this one trade, stop new entries until a
    restart, or stop the bot. Alerts carry codes only, never data.
  - 1,065 tests pass. Both Opus reviewers checked it (REVIEWS.md T). The security reviewer
    approved with notes and confirmed that the trading code cannot misuse an approval. The risk
    reviewer blocked it: the slot clock could be walked far ahead, or stalled by a clock that
    steps back, and a buy approval ignored a KILL or halt written by another process. All of it is
    fixed, and 34 of 34 planted bugs in the fixes are caught. Both reviewers then hit the weekly
    usage limit before confirming the fixes; with your OK (decision D8) this part is saved as
    "review pending", and the re-check comes after Nov 23. Nothing builds on it until both confirm.
- Part 6d-2 is built (tests first), and NOT YET REVIEWED: with your OK (decision D9) it is saved on
  its own branch, `claude/exciting-hamilton-2d7lto-6d2-unreviewed`, and joins the main work only
  after both reviewers approve it. It holds the steps that turn a strategy's buy or a sell into an
  approval:
  - A buy is one locked database step: it reads your limits, halts, KILL, pause, the day's count,
    the positions and the money, asks the risk engine, and writes the result. If anything fails half
    way, nothing of it is saved, and the approval only goes out after the save.
  - A sell reads no stop at all, so KILL or a halt can never keep a position from being sold. An
    unknown chain slot or a bad request writes nothing, and every refused sell alerts you; five in a
    row for one position raise an "exit blocked" alert.
  - Tested hard: every database statement made to fail in turn in five ways; up to six processes
    racing for the last free slot (exactly one wins, 50 rounds); a KILL from another process; a crash
    in the middle; 200 random runs checking that no limit is ever broken; a new rule that no code
    inside a database step can swallow an error. 1,165 tests pass. 130 deliberate bugs were planted
    one at a time, and the tests caught every one in the end; the first runs found four weak tests
    and one rule that should be stricter, all fixed. Building it also turned up a trap: a sell for a
    position that is not open would have stopped all new buys; now it just alerts.
- For you to know: in paper, the "free SOL" limit can never be the one that stops a buy, because the
  50% exposure limit always stops it first. That is fine, and the reason is written down for the
  reviewers.
- For you to know before live: at 5% per trade, live trading needs at least 0.4 SOL in the
  account with the 0.02 SOL minimum trade (0.2 SOL if you lower it to 0.01); below that the
  bot makes no trades. Paper and live entries share one daily count, so paper trades can use
  up the 5 live entries, never the reverse (separate counts would need your OK).
- Next: the reviewers' re-check of 6d-1 and their review of 6d-2 (after Nov 23); then 6d-3 (the
  start-up checks) and 6e (the settings and day-state transactions); then chain clients, the paper
  engine, Telegram and logging.
- Before Phase 3: four guard-hook fixes (REVIEWS.md A). No lint script yet: eslint is
  deferred until it is reviewed.
- For you to do: make the GitHub repository private; send the Helius email when you like;
  before Phase 7, turn on GitHub 2FA.
- Progress, roughly, by building effort: Phases 0 and 1 done; Phase 2 about 55% (settings,
  accounting, risk engine, the storage files and the approval transactions done, the last two parts
  awaiting review; the start-up checks next); the whole build about 26-30%. Proving an edge on paper
  takes weeks on top of that.
- Unproven: whether any strategy makes money. Nothing has run on paper yet.
