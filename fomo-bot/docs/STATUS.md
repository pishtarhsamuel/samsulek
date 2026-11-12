# Status

Updated: 2026-11-12

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
  notes; one must be done in the config step (clamp every cap against the hard values).
  501 tests pass, run with frozen built-ins and no code from strings.
- Stricter than the design, for you to know: trade sizes use the lower of this morning's
  and the current account value, so a price spike never makes trades bigger; and a single
  buy can never exceed 0.06 SOL, fall under 0.01 SOL or cost more than 0.07 SOL in the worst
  case, whatever the sizing says (the 0.07 SOL ceiling is new, a margin above the 0.0617 SOL
  of limit 2; it loosens nothing).
- Next: config caps (the protected file, which needs your OK when I change it), then storage
  (the database, where the approval step's effects are written in one transaction); then
  chain clients, the paper engine, Telegram and logging.
- Before Phase 3: four guard-hook fixes (REVIEWS.md A). No lint script yet: eslint is
  deferred until it is reviewed.
- For you to do: make the GitHub repository private; send the Helius email when you like;
  before Phase 7, turn on GitHub 2FA.
- Unproven: whether any strategy makes money. Nothing has run on paper yet.
