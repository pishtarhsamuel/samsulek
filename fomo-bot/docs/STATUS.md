# Status

Updated: 2026-11-26

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
    usage limit before confirming the fixes; with your OK (decision D8) this part was saved as
    "review pending". On Nov 23 both re-checked it: the security reviewer CONFIRMED, the risk
    reviewer APPROVED WITH NOTES. Their new notes are small conditions for the exit and health
    loops (keep the slot reading fresh during long outages, and alert in two quiet failure cases).
- Part 6d-2 is built (tests first) and REVIEWED: both reviewers approved it with notes on Nov 23,
  and it joined the main work with their two fixes (below). It holds the steps that turn a
  strategy's buy or a sell into an approval:
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
  - The review found two things to fix, both done and confirmed: a sell that can never pass (its
    fee budget is spent) no longer uses up the position's sell numbers, so it can always still be sold
    later; and the check that no code inside a database step can swallow an error now also catches
    three sneakier ways of handing that step on. Their other notes are conditions for later parts.
- Part 6d-3 is built (tests first) and REVIEWED: both reviewers approved it with notes on Nov 23,
  and it joined the main work. Their notes are small fixes for the start command, which comes
  later (refuse a second start in one process, check the folders above the data folder, refuse
  untested systems, and a few more). It holds the start-up checks and the engine's start:
  - Before it does anything, the bot checks its data folder: on this computer (not a network share or
    OneDrive), private to the bot's own user, with no shortcut or second name for the database. Then the
    database's health and layout, every record it needs, its safety log, that KILL and every halt point
    at their own log entries, and that both books add up (paper has its one deposit; live holds nothing,
    not even a position). Any failure: it refuses to start and alerts you with a short code.
  - After each start, KILL and halt, the bot writes a small bookmark of its safety log. If the log is
    ever shorter than the bookmark, or the database is an older copy, it refuses to start.
  - A buy that was approved but never sent before a crash is cancelled at the next start; one that was
    sent stays counted until its result is known.
  - The engine makes exactly one approval key per run, and the part that sends orders gets only "use
    an approval", never "make one". Nothing can start the bot yet: the start command comes with the
    server setup.
  - 1,223 tests pass. 123 deliberate bugs were planted; the tests catch 114, and the other 9 change
    nothing because another check already does their job (each reason is written down). The first run
    found four weak tests and one missing check (a live position with an empty live account would have
    passed the start); all fixed.
  - At start-up the bot cancels a stale buy without knowing the chain's clock; both reviewers
    accepted that: the old run's approvals died with it, and a test shows the database refuses
    such an approval even if the old run were somehow still alive.
  - The Windows-only checks (shortcuts called junctions, OneDrive, network paths) are tested with a
    stand-in for Windows; a real run on your PC comes with the setup guide. If a guess is wrong, the bot
    refuses to start rather than running somewhere unsafe.
- Your answers of Nov 23 are recorded: D11 (build 6e now, on the same separate branch), D12 (refuse to
  start on a shorter safety log) and D13 (never another person's wallet address in the trade records).
- Step 6e (saving the daily money check and your setting changes) is designed by the architect, in four
  parts (STORAGE_DESIGN.md s.17), and its first part, 6e-1, is built (tests first) and NOT YET REVIEWED,
  on the same separate branch (D11):
  - Every few seconds the bot will write down, in one all-or-nothing step, what its paper money is
    worth, the day's starting value, the highest value so far, and any stop that this triggers: -30% in
    a day, -50% from the high, two stop days in a row, an impossible value (zero, above 2 SOL, over three
    times the bankroll) or a clock that ran backwards. A stop is saved in the same step as the value
    that caused it.
  - A value that cannot be real is never used as the reference for the "+50% in an hour" check.
  - If the check itself fails in any way (other than the database being busy for a moment), new buys
    halt and you get an alert; only the server can restart them. It never retries with edited numbers.
  - The time changes work: on the 23- and 25-hour days the daily stop lasts exactly until local midnight.
  - Nothing calls it yet: the bot's main loop comes later, and it needs a trustworthy clock first.
  - 43 deliberate bugs were planted: the tests catch 42, and the last one cannot matter in paper. The
    first run found two weak tests, both fixed.
- Part 6e-2 is built (tests first), NOT YET REVIEWED, on the same branch:
  - A buy is now refused when the last money check is more than 30 seconds old or could not value
    everything, so a stop can never be missed between two checks, and a broken check stops buying fast.
  - A held "+50% in an hour" jump is cleared only by a fresh check of the real balance within 5 minutes,
    from the server or (later) the verification routine; never by a strategy, Telegram or the AI. It
    never vouches for more than was seen, and it works even while the bot is halted.
  - 18 deliberate bugs were planted, and every one is caught (after two weak tests were fixed).
- Part 6e-3 is built (tests first), NOT YET REVIEWED, on the same branch:
  - The bot's own settings step: once a setting change you made while live trading was possible has
    waited its 24 hours, the bot applies it exactly as you asked, one saved version per change, each one
    undoable with /rollback. A change that no longer fits (the value moved since, or is now out of the
    allowed range) is dropped, never applied, and you are told either way.
  - A live strategy whose settings change goes back to paper at once, and its go-live count starts
    again; you get an alert.
  - Nothing applies on a doubtful clock, or when the clock is behind a saved change (it waits, and you
    are warned). A damaged settings row stops new buys and alerts you; it is never repaired by guessing.
  - In paper nothing ever waits (no strategy is live), so this step does nothing until Phase 8.
  - 35 deliberate bugs were planted, and every one is caught (after one missing test was added).
- Part 6e-4 is built (tests first), NOT YET REVIEWED, on the same branch. Step 6e is now complete:
  - Your setting commands are saved as all-or-nothing steps: /set, /rollback (one step back each time)
    and /cancel (drop a change that is still waiting). A bad name or value changes nothing. In paper a
    change applies at once; once anything is live, a riskier risk or exit change waits 24 hours.
  - The paper model can only become more cautious, whatever the command.
  - /resume restarts buying after the -50% halt only right after a money check (at most one minute
    old) that valued everything, and never while a "+50% jump" is unconfirmed. After two stop days in a
    row it needs no such check.
  - These commands work even while buying is blocked, and only your Telegram (after the owner check)
    and the server will be able to call them. Nothing calls them yet (Telegram comes in Phase 3).
  - 42 deliberate bugs were planted, and every one is caught (after one missing test was added).
    Building it also found a blind spot in one of the automatic code checks (it could not see code
    handed into a database step as a function); the check is now stricter, and nothing else tripped it.
- Step 6e is REVIEWED (Nov 23): both reviewers approved all four parts with notes (REVIEWS.md W). One
  thing had to be fixed before it could join the main work; it is fixed, both reviewers CONFIRMED the
  fix on Nov 24, and 6e has joined the main work:
  - The rule "only the server clears a held +50% jump" was enforced on the command, but the database
    writer under it could have been called by other parts of the bot, with a time of its own choosing.
    Now that writer sits in its own file that only the confirmation may use, it stamps its own time,
    and it refuses more than 5 minutes after the hold. The everyday money check can no longer clear a
    hold, and only it can write the money-check record that buys rely on. Nothing did this before; now
    nothing can.
  - While fixing a second, smaller note, I found that the automatic check "no code may swallow an error
    inside a database step" could be fooled by calling a function indirectly. It now covers those ways.
  - 48 deliberate bugs were planted in the fixes; every one is caught (after one test was added).
  - Their other notes are conditions for later parts, each written down with the step it is due by
    (STORAGE_DESIGN.md s.17.16). For example: a money check right before every buy, Telegram can never
    act as the server, and before live, setting changes that wait 24 hours need a trusted clock. The
    re-check added one small one: before Telegram is wired in, the code that handles your commands
    must be unable to touch the "+50% jump" fields at all.
- For you to know: in paper, a setting change from Telegram applies at once (within its allowed range);
  the 24-hour wait applies only once something is live.
- Your answer of Nov 24 is recorded as D15: if the money check itself breaks, only you at the server can
  restart buying (as built).
- Your answer of Nov 24 is recorded as D14: the full double review and planted-bug tests stay for
  everything touching money, keys, the risk engine, your commands, the network or the server; the rest
  gets only the reviews the rules require.
- For you to know: in paper, the "free SOL" limit can never be the one that stops a buy, because the
  50% exposure limit always stops it first. That is fine, and the reason is written down for the
  reviewers.
- For you to know before live: at 5% per trade, live trading needs at least 0.4 SOL in the
  account with the 0.02 SOL minimum trade (0.2 SOL if you lower it to 0.01); below that the
  bot makes no trades. Paper and live entries share one daily count, so paper trades can use
  up the 5 live entries, never the reverse (separate counts would need your OK).
- Step 7 (the bot's connection to the Solana blockchain) has started. The researcher checked today's
  facts (the free public server's limits, the exact form of its answers); the architect designed it in
  eight small parts (docs/CHAIN_DESIGN.md). Part 7a is built (tests first), NOT YET REVIEWED, on the
  separate branch:
  - Numbers in the blockchain's answers are read exactly, never rounded; anything that only looks like
    a whole number is refused rather than guessed.
  - Solana addresses and signatures are checked strictly: a typo or a non-standard form is refused.
  - New automatic checks: only two named files may ever talk to the internet, the blockchain code can
    never even name a "send" method, and only the start command gets the real clock.
  - 49 deliberate bugs were planted: 47 caught, and the other 2 cannot change any result (each reason is
    written down). One weak test was found and fixed.
- The design and part 7a are REVIEWED (Nov 24): both reviewers approved with notes (REVIEWS.md X), and
  they join the main work. Their notes are written into the design (CHAIN_DESIGN.md s.17), each with the
  part it is due by. The main ones: one wild answer from a node must never be able to stop every read,
  selling included (fixed in the design before part 7e); the start command will refuse settings that
  switch off the internet connection's certificate checks or reroute it; and a huge message on the live
  block feed is a crash risk, guarded by the memory limit.
- Parts 7b to 7d were reviewed together (Nov 26, REVIEWS.md Y). The risk reviewer approved with notes.
  The security reviewer stopped the merge over one fault: when the bot stopped reading an answer that was
  too big, the connection stayed open and kept downloading until its time limit. That is fixed, with a
  test; the security reviewer confirmed the fix the same day, and the three parts joined the main work. The
  other notes are written into the design (CHAIN_DESIGN.md s.21), each with the part it is due by; the
  main one: data from the live block feed must never use up the room kept for selling (due in part 7f).
- Part 7b is built (tests first) on the separate branch: the request budget. Every
  request to the free Solana server asks it first, so the bot stays well under the server's limits; room
  is always kept for selling and price checks, and the least important work is cut back first when it
  gets busy. If the server says "slow down" it waits as told; if it blocks the bot, nothing is sent for
  15 minutes and buying stops. 46 deliberate bugs were planted: 43 caught, 3 cannot change anything
  (each reason written down); three weak tests were found and fixed.
- Part 7c is built (tests first) on the separate branch: the internet connection
  itself, the only place in the bot allowed to talk to the internet. It only uses secure connections,
  refuses to be redirected, never reads more than each answer may be (a small compressed answer that
  would unpack to gigabytes is stopped at the limit), refuses anything that is not proper text, gives
  up on an answer that hangs, and never lets the server's address (which may one day hold a key) into a
  message or a log. 30 deliberate bugs were planted: 29 caught, 1 cannot change anything.
- Part 7d is built (tests first) on the separate branch: writing the questions to the
  Solana server and reading its answers. Every answer is checked field by field; anything missing,
  extra, of the wrong kind or out of range is refused, never guessed or rounded (large amounts stay
  exact). Each kind of server error is sorted (our mistake, server behind, slow down, data not there).
  A new test makes sure no real person's wallet address can ever sit in the code or the tests. 106
  deliberate bugs were planted: 102 caught, 4 cannot change anything (each reason written down); two
  weak tests were found and fixed.
- Your answer of Nov 26 is recorded as D16: against the blockchain's clock the bot halts only beyond 60
  seconds of difference; against the computer's own timer, over 2 seconds stops new buys (clearing by
  itself) and over 10 seconds halts. Built in part 7g.
- Part 7e is built (tests first) and REVIEWED (Nov 26, REVIEWS.md Z): both reviewers approved with notes,
  and it joined the main work. Their fixes were small and are in: two network checks that overlap can no
  longer undo the "wrong network" lock, and new tests prove the bot's request priorities, the server's
  limits and the size of every answer reach the request budget. Their main note for part 7f: if a lying
  server fools the bot right at start-up, before the live block feed exists, the reader must be able to
  recover without a restart. The read client is the one piece the paper bot will use to read the chain
  (it has no way to send). Nothing is read until the server has
  proved it is the real Solana network; the wrong network stops it for good until a restart. An answer
  older than what the bot already saw, or far behind the latest block, is refused. One wild answer can
  no longer make every honest server look behind (the reviewers' main note before this part). Every kind
  of failure now has a named rule for what the bot does with it. The request budget's notes from the
  review are in too: after "slow down" it waits at least 10 seconds, and it warns you if a limit ever
  leaves it unable to read prices for selling. 66 deliberate bugs were planted: all 66 caught (one weak
  test was found and fixed on the way).
- Next: part 7f (the live block feed), starting with the review notes due there. No question is open.
- Before Phase 3: four guard-hook fixes (REVIEWS.md A). No lint script yet: eslint is
  deferred until it is reviewed.
- For you to do: make the GitHub repository private; send the Helius email when you like;
  before Phase 7, turn on GitHub 2FA.
- Progress, roughly, by building effort: Phases 0 and 1 done; Phase 2 about 80% (settings,
  accounting, risk engine, the storage files, the approval transactions, the start-up checks, the
  daily money check, the bot's settings step and your setting commands done, reviewed and in the
  main work); the whole build about 36%. At the pace so far (Nov 4 to Nov 26),
  building takes roughly 6 more weeks (5 to 9), and proving an edge on paper at least 1 to 3 weeks
  more: at least 50 closed paper trades over at least 7 days per strategy before any live decision.
- Unproven: whether any strategy makes money. Nothing has run on paper yet.
