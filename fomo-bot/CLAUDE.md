# CLAUDE.md - fomo-bot (FOMO-edge Solana memecoin bot)

Start every session by reading this file, `fomo-bot/docs/STATUS.md` and
`fomo-bot/docs/DECISIONS.md` (owner decisions; they override the brief); read
`fomo-bot/BUILD_PROMPT.md` (the owner's full brief) before any design or build work.
The root `CLAUDE.md` applies too: see "Relationship to the root project" below.
All paths here are relative to the repository root.

## What this is

A safety-first, fully automated Solana memecoin bot, controlled by the owner from
Telegram and meant to run 24/7 on a ~$5/month VPS near Frankfurt. Its hoped-for edge
is the activity of FOMO (fomo.family) users, observed only through public on-chain
data. Switchable strategies: FOMO crowd flow, momentum, smart launch sniping (second
wave, never block zero); copy-trading is skipped (decision D1). Paper first; each goes
live only through its gate and the owner's tap. Bankroll under $50; running cost
$5-10/month. Not affiliated with FOMO. Most memecoin trading loses money: the bot must
prove an edge on paper, after every cost, before it touches real money.

## Hard rules (BUILD_PROMPT.md section 3; if a task seems to need breaking one, stop and tell the owner)

FOMO compliance
- Never call FOMO's private API (e.g. `prod-api.fomo.family`); never automate
  fomo.family or the FOMO app in any way, including browser automation.
- Never request, store or use FOMO login, session, ID or Privy tokens; never use
  unofficial "FOMO API" tools, MCP servers or CLIs.
- FOMO signals come only from public Solana data and wallet addresses the owner types
  in by hand. Reading FOMO's public legal and help pages is fine.

Market integrity
- No wash or self-trading, fake volume, misleading launch bundling, sandwiching,
  front-running pending transactions, coordinated pumps or promotional spam.
  Copy-trading reacts only to already-confirmed public transactions.

Money safety
- Every order passes through the one risk engine; nothing else can reach the signer.
- The only outbound transfer is `/withdraw` to the single owner address in the server
  config file (not changeable from Telegram), with a confirmation step.
- On-chain amounts are bigint base units. No floats for amounts, fees or balances;
  convert for display only at the edges.
- The chain is the source of truth: reconcile after every trade and every restart.
- Fail closed: stale data, a failing check or anything ambiguous means no entry;
  exits are managed conservatively.
- The first real-money transaction needs the owner's explicit OK.

Secrets
- The live key exists only on the server; the owner creates it with one command that
  prints only the public address, and backs it up with an owner-run command.
- Claude and every subagent never read, print, cat, grep, copy, log or transmit key
  files or `.env` files, locally or over SSH, and never ask for a private key or seed
  phrase. If the owner pastes one anywhere, tell them to rotate it immediately.
- Paper mode needs no key; development and paper testing run keyless.
- Commit `fomo-bot/env.example` (no leading dot) with placeholders only. Secret
  scanning (gitleaks) goes in as a pre-commit hook and in CI once security-auditor
  approves the tool.

Supply chain
- TypeScript on Node.js LTS, strict mode. Only well-known, maintained packages; the
  security-auditor approves each new dependency (npm page, maintainers, downloads,
  repository, install scripts). Exact versions, committed lockfile, `npm ci`.
- Never copy code from random "sniper / copy-trading bot" repos, gists or Telegram
  posts; never use a service that asks for the private key.

Verify, don't assume
- Confirm every program ID, account layout, endpoint, fee, rate limit, quota, price
  and model ID from official docs or live read-only data, and record it in
  `fomo-bot/docs/VERIFIED_FACTS.md` (fact, value, source URL, date, confidence).
  Mark the rest UNVERIFIED and design around it.
- The cloud build environment blocks many docs sites. Say so; never fill gaps from
  memory.

Honest reporting
- Say what was tested, how, and what is unproven. Keep paper and live separate.
  Include every cost: DEX/launchpad fees, priority fees, tips, failed-transaction
  fees, unrecovered rent, slippage. Never promise returns.

## Relationship to the root project (samsulek)

- The repository root holds a separate Python research project with its own plan
  (`docs/PLAN.md`), tests and guardrails. Its non-negotiable rules (paper by default,
  the risk engine as the only path to a broker, kill switch, fail closed, security, no
  manipulation, brutal honesty) apply here as well.
- Conflicts between the two briefs are listed in `fomo-bot/docs/FEASIBILITY.md` and
  belong to the owner. Until the owner resolves one, the stricter rule applies. Above
  all: Claude never starts live trading, never moves funds, never creates or funds
  wallets, and cloud sessions never hold live credentials (so no SSH into a server
  that holds the live key unless the owner explicitly decides otherwise).
- The root guard hook (`.claude/hooks/guard.py`) also covers this folder. Never name a
  folder `state` (writes to any `state/` path are blocked), nor `secrets`, `backups`,
  `build` or `dist` inside source trees (the .gitignore files would silently drop it);
  use the Grep tool, not recursive grep; keep `.env` out of shell commands; use
  `git commit -F <file>`. Start Claude Code at the repository root: the deny rules and
  the hook resolve paths from there.
- Before every commit the root checks must still pass (`uv run pytest`,
  `uv run ruff check src tests`, `uv run mypy`), plus this project's own checks.

## Team (BUILD_PROMPT.md section 4; definitions in `.claude/agents/` and `.claude/skills/`)

- Agents: researcher, architect, execution-engineer, quant-strategist,
  risk-guardian (veto), security-auditor (veto), test-engineer, devops.
- Skills: `/status-report`, `/review-trades`, `/go-live-check <strategy>`.
- researcher runs before any integration code; architect before any new module;
  tests come first for amount math, accounting and risk.
- risk-guardian and security-auditor must both approve every change touching money,
  keys, dependencies or deployment. Verdicts go in `fomo-bot/docs/REVIEWS.md`.
  BLOCKED stops the merge.
- Independent research runs in parallel subagents; the main session integrates,
  decides and talks to the owner.

## Conventions

- Everything for this bot lives under `fomo-bot/` (`src/`, `tests/`, `docs/`).
- Node.js LTS pinned to an exact version; TypeScript strict; ES modules.
- Money types are bigint base units (lamports, token base units) with distinct
  types per unit; display conversion only in formatting code.
- Every network call has an explicit timeout. Every decision is logged (JSONL) with
  its inputs and reasons, so any trade can be explained in one Telegram message.
- Each strategy has a mode `off | paper | live`; there is a global pause; live needs a
  server flag plus the owner's Telegram go-live. One position per token.
- UTC internally; Europe/Athens for the owner (daily reset at 00:00 Athens).
- LF line endings; ASCII CLI output and logs; anything the owner runs locally must
  work on Windows (PowerShell).
- Never commit data, logs, SQLite files, backups, `node_modules/` or secrets.

## Definition of Done (every phase; BUILD_PROMPT.md section 15)

Tests pass (show the output); typecheck and lint clean; required sign-offs in
`fomo-bot/docs/REVIEWS.md`; `fomo-bot/docs/STATUS.md` updated; a plain-English summary
has gone to the owner; git commit. Never claim something works without running it.
Stop after each phase and wait for the owner's OK.

Phases: 0 team and reality check (no trading code); 1 design in plan mode (no code
until the owner approves); 2 foundations, tests first; 3 data and safety;
4 strategies one at a time (copy, crowd flow, momentum, launch); 5 exit tournament,
AI review, reports; 6 security audit and pre-mortem; 7 VPS paper soak; 8 live
readiness, only with the owner's explicit OK.

## How to talk to the owner (BUILD_PROMPT.md section 16)

- Plain English, at most 10 lines per update; define technical terms in a few words.
- One question at a time, always with a recommended answer.
- Say exactly what to click or type and what they should see.
- Before a permission prompt that runs something important, say in one line what it
  does.
- Warn before anything that costs money or touches real funds; get an explicit yes.
- Never ask for a private key, seed phrase or FOMO login.
- When unsure, say so and propose how to test it.
