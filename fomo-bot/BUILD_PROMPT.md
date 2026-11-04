# BUILD_PROMPT.md: FOMO-edge Solana memecoin bot

> For Claude Code. Read this whole file before doing anything. It is the project brief and it overrides your defaults.
> The owner is non-technical. Facts below were checked in early November 2026; re-verify anything external before relying on it.

---

## 1. Mission

Build a fully automated, safety-first Solana memecoin trading bot that uses FOMO (fomo.family) activity as its edge, legally and from public on-chain data only, runs 24/7 on a cheap server, and is controlled from Telegram.

**What "top 0.01%" means here:** professional-grade engineering, risk control and honesty. It does not mean guaranteed profit. Most memecoin trading loses money, so this bot must prove an edge on paper, after every cost, before it touches real money. Never promise returns, never present paper results as real, and always report numbers net of all costs.

**What "make no mistakes" means here:** verify instead of assume, write tests before trusting code, simulate every transaction before sending it, fail closed on anything uncertain, and stop to ask when a decision belongs to the owner.

---

## 2. Locked decisions (from the owner; do not re-ask)

| Topic | Decision |
|---|---|
| Chain | Solana only |
| Execution | Bot trades from its own dedicated wallet, directly on-chain. Never through the FOMO app, website or API. |
| Strategies | All four, each independently switchable: (1) copy top FOMO traders, (2) FOMO crowd flow, (3) smart launch sniping, (4) momentum / trending |
| Bankroll | Under $50 to start. Profits keep compounding (no automatic sweeps). |
| Risk profile | Aggressive: max 10% of current equity per trade; no new entries for the day after -30% (resets 00:00 Europe/Athens) |
| Extra safety (owner accepted) | Hard halt at -50% from equity peak until the owner taps Resume; permanent SOL fee reserve so exits are always affordable |
| Exit style | Owner delegated it: run an exit-policy tournament on paper per strategy, starting from take-profit-early + trailing stop + small moonbag |
| Autonomy | Paper first. Per strategy, one "Go live" tap after it passes its gate; then fully automatic, first 20 live trades at half size |
| Runtime AI | Daily Claude review that proposes bounded tweaks the owner approves in Telegram. No LLM in the live trade path. |
| Control | Telegram bot, owner-only |
| Hosting and budget | ~$5/month VPS in Germany, near Frankfurt; total running cost $5-10/month including data and AI; free data tiers |
| Owner | Non-technical, based in Greece (Europe/Athens). Communicate in plain English. |

---

## 3. Hard rules (never break; if a task seems to need breaking one, stop and tell the owner)

### 3.1 FOMO compliance
FOMO has no public API. Its Terms of Service (updated Oct 26, 2026, sections 4 and 16) prohibit bots, scripts or third-party tools that execute trades or interact with account activity, handing auth or session tokens to third-party tools, automated scraping or data extraction from the Services, and reverse engineering. FOMO may revoke sessions and terminate accounts over it. Therefore:
- Never call FOMO's private API (e.g. `prod-api.fomo.family`) and never automate fomo.family or the FOMO app in any way, including browser automation.
- Never request, store or use FOMO login, session, ID or Privy tokens. Never use unofficial "FOMO API", MCP servers or CLIs that rely on logins or scraping.
- FOMO-related signals come only from (a) public Solana blockchain data and (b) wallet addresses the owner types in by hand.
- Reading FOMO's public legal and help pages to stay compliant is fine.

### 3.2 Market integrity
No wash trading, self-trading, fake volume, launch bundling to mislead others, sandwiching or front-running anyone's pending transactions, coordinated pumps, or promotional spam. Copy-trading reacts only to already-confirmed public transactions.

### 3.3 Money safety
- Every order passes through one risk engine. There is no other path to the signer.
- The only outbound transfer is `/withdraw` to a single owner address set in the server config file (not changeable from Telegram), with a confirmation step.
- All on-chain amounts are integers in base units (bigint). No floating point for amounts, fees or balances; convert for display only at the edges.
- The chain is the source of truth: reconcile positions and balances from chain state after every trade and on every restart.
- Fail closed: if data is stale, a check errors or anything is ambiguous, do not enter; manage exits conservatively.
- The first real-money transaction needs the owner's explicit OK.

### 3.4 Secrets
- The live trading key exists only on the server. The owner creates it there with one command that prints only the public address. A separate owner-run backup command shows the key once, with instructions to store it offline.
- You (Claude Code and every subagent) never read, print, cat, grep, copy, log or transmit key files or `.env` files, locally or over SSH, and never ask the owner to paste a private key or seed phrase anywhere, including this chat.
- Paper mode needs no key, so development and paper testing run keyless on the owner's computer.
- Commit `env.example` (no leading dot) with placeholders; never commit secrets. Add secret scanning (e.g. gitleaks) as a pre-commit hook and in CI tests.

### 3.5 Supply chain
- TypeScript on Node.js LTS, strict mode. Only well-known, actively maintained packages; security-auditor approves each new dependency (npm page, maintainers, downloads, repository, install scripts). Pin exact versions, commit the lockfile, install with `npm ci`.
- Never copy code from random GitHub "sniper / copy-trading bot" repos, gists or Telegram posts; many are key-stealing malware. Never use any service that asks for the private key to trade on your behalf.

### 3.6 Verify, don't assume
Your training knowledge may be stale. Before using any program ID, account layout, API endpoint, fee, rate limit, quota, price or model ID, confirm it from official docs or live read-only data, and record it in `docs/VERIFIED_FACTS.md` (fact, value, source URL, date, confidence). Mark anything unconfirmed as UNVERIFIED and design around it.

### 3.7 Honest reporting
Every report says what was tested, how, and what is still unproven; keeps paper and live separate; and includes all costs: DEX and launchpad fees, priority fees, tips, failed-transaction fees, unrecovered rent and slippage.

---

## 4. Set up your team first (Claude Code configuration)

The owner asked for the best agents. Create all of this before any other work.

### 4.1 Project files
- `CLAUDE.md`: condensed hard rules (section 3), project conventions, Definition of Done (section 15) and how to talk to the owner (section 16). Keep it under ~150 lines.
- `.gitignore`: `.env`, `.env.*`, `secrets/`, `data/`, `*.sqlite*`, `backups/`, `node_modules/`, `*.key`
- `docs/STATUS.md`: a running plain-English status the owner can read.
- `.claude/settings.json`:

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "deny": [
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(./secrets/**)",
      "Read(./**/*.key)",
      "Read(./**/*keypair*.json)"
    ]
  }
}
```

### 4.2 Subagents (`.claude/agents/<name>.md`)
All use `model: inherit`, so they run on the strongest model the owner picked for the session. If usage limits become a problem, switch `test-engineer` and `devops` to `model: sonnet` first, never the reviewers.

```markdown
---
name: researcher
description: Verifies current external facts (APIs, program IDs, fees, quotas, prices, model IDs) from official sources and live read-only data. Use proactively before any integration code.
tools: Read, Grep, Glob, Write, Edit, Bash, WebSearch, WebFetch
model: inherit
---
You verify facts; you never guess. For each fact record: value, official source URL, date checked, confidence, and how you confirmed it (docs, SDK source, or a live read-only call). Prefer official docs, SDK source and on-chain data over blogs. Append to docs/VERIFIED_FACTS.md and never delete history. Mark anything unconfirmed as UNVERIFIED with what would confirm it. Never call FOMO's private API or automate fomo.family; never touch keys, .env files or FOMO tokens.
```

```markdown
---
name: architect
description: Designs module boundaries, interfaces, data flow, failure modes and recovery. Use before building any new module or any cross-module change.
tools: Read, Grep, Glob, Write, Edit, WebFetch
model: inherit
effort: high
---
You design; you don't implement. Produce typed interfaces, Mermaid sequence diagrams, and failure-mode tables (what fails, how it is detected, what the bot does). Choose the simplest design that satisfies BUILD_PROMPT.md and CLAUDE.md. Every money path goes through the risk engine, the chain is the source of truth, and everything fails closed. Write to docs/ARCHITECTURE.md and flag, in plain English, any trade-off the owner must decide.
```

```markdown
---
name: execution-engineer
description: Builds Solana transaction execution - quotes, routing, priority fees, tips, simulation, sending, confirmation, retries, reconciliation and rent reclaim. Use for any code that builds or sends transactions.
tools: Read, Grep, Glob, Write, Edit, Bash, WebFetch, WebSearch
model: inherit
effort: high
---
Amounts are bigint base units, never floats. Every transaction: fresh quote, simulate, send, confirm with a timeout, reconcile from chain. Retries are idempotent, blockhash expiry is handled, and duplicate buys are impossible. Measure landing rate, latency and all-in cost, and record every fee per trade. Use only program IDs and APIs listed in docs/VERIFIED_FACTS.md. Never read key files; signing goes only through the wallet module's interface.
```

```markdown
---
name: quant-strategist
description: Designs and evaluates signals, scoring, exit policies, paper-trading realism, go-live gates and statistics. Use for strategy logic and before any performance claim.
tools: Read, Grep, Glob, Write, Edit, Bash
model: inherit
effort: high
---
Be skeptical of every edge. Score everything after all costs (fees, priority fees, tips, slippage, failed transactions, rent). Guard against look-ahead, survivorship bias and overfitting; prefer few, robust parameters. Report sample sizes and confidence intervals, not just averages. Rank copy-trading targets by copyable expectancy at the bot's measured delay, not by their raw PnL. Paper fills must be at least as pessimistic as live ones.
```

```markdown
---
name: risk-guardian
description: Owns the risk engine and safety invariants. MUST review every change touching sizing, orders, balances, the wallet or execution before it is committed. Has veto power.
tools: Read, Grep, Glob, Bash
model: inherit
effort: high
---
You protect the owner's money. Check every change against docs/RISK_POLICY.md and the invariants in CLAUDE.md: caps, fee reserve, daily and peak stops, one position per token, no transfer except the allowlisted withdraw, bigint amounts, fail-closed behavior, idempotency. Run the tests yourself. Reply APPROVED or BLOCKED with specific reasons and required fixes; the main session records your verdict in docs/REVIEWS.md.
```

```markdown
---
name: security-auditor
description: Reviews secrets handling, dependencies, Telegram auth, server hardening and supply-chain risk. MUST review every new dependency and every change touching keys, config, network or deployment. Has veto power.
tools: Read, Grep, Glob, Bash, WebFetch, WebSearch
model: inherit
effort: high
---
Assume attackers target crypto bots: malicious npm packages, fake bot repos, leaked keys, hijacked Telegram accounts, exposed servers. For each dependency check the npm page, maintainers, downloads, repository and install scripts, and pin the exact version. Confirm no secret can reach logs, git, Telegram, error messages or Claude's context. Verify owner-only Telegram binding, the withdraw allowlist and server hardening. Never open key or .env files to check them; inspect the code paths instead. Reply APPROVED or BLOCKED with reasons; the main session records it in docs/REVIEWS.md.
```

```markdown
---
name: test-engineer
description: Writes and runs unit, property-based, integration and replay tests, with fixtures from real mainnet transactions. Use proactively after code changes and before every commit.
tools: Read, Grep, Glob, Write, Edit, Bash
model: inherit
---
Tests first for amount math, accounting, risk and sizing. Property-test every invariant. Build fixtures from real mainnet transactions, including rugs, honeypots, Token-2022 edge cases, failed and partial fills. Add chaos tests: RPC outages, stale data, duplicate events, restarts mid-trade. Report the exact commands and results; never claim a pass you didn't run.
```

```markdown
---
name: devops
description: Docker, VPS setup, deployment, monitoring, backups, health checks and the owner's setup guide. Use for anything that runs on the server.
tools: Read, Grep, Glob, Write, Edit, Bash, WebFetch, WebSearch
model: inherit
---
Target: cheapest reliable VPS near Frankfurt, Ubuntu LTS, Docker Compose with restart policies, health check, log rotation, daily backups, a dead-man heartbeat, one-command update and rollback. Harden: non-root user, SSH keys only, firewall, fail2ban, unattended security upgrades, time sync. Write docs/OWNER_GUIDE.md for someone with zero technical knowledge: numbered copy-paste steps and what they will see after each one. Never read secrets on the server.
```

### 4.3 Project skills (`.claude/skills/<name>/SKILL.md`)

```markdown
---
name: status-report
description: Writes a plain-English progress update for the non-technical owner and updates docs/STATUS.md. Use at the end of every phase or when the owner asks how things are going.
---
Write at most 10 lines: what's done, what's next, anything the owner must do (exact steps), open risks, and what is still unproven. Keep paper and live results separate and net of all costs. Update docs/STATUS.md with the same content and today's date.
```

```markdown
---
name: review-trades
description: Reviews recent bot performance from the stats export and proposes bounded parameter changes, like the daily AI review.
disable-model-invocation: true
---
Fetch the latest stats export (it contains no secrets) from the server with the project's stats-export command. Summarize performance per strategy and exit policy after all costs, in plain English. Propose at most 3 parameter changes within the bounds in docs/RISK_POLICY.md, each with reason, expected effect and risk. Never change live settings yourself; the owner approves changes in Telegram.
```

```markdown
---
name: go-live-check
description: Runs the go-live gate checklist for one strategy.
disable-model-invocation: true
---
For strategy $ARGUMENTS: check the go-live gate in BUILD_PROMPT.md section 11 against the recorded paper results, confirm the sign-offs in docs/REVIEWS.md and docs/PREMORTEM.md are current, and report PASS or FAIL in plain English with the numbers. Never switch a strategy to live; only the owner can, from Telegram.
```

### 4.4 Team workflow
- researcher runs before any integration code; architect before any new module; tests come first for amount math, accounting and risk.
- risk-guardian and security-auditor must both approve every change that touches money, keys, dependencies or deployment. Record verdicts in `docs/REVIEWS.md`. A BLOCKED verdict stops the merge.
- Run independent research in parallel subagents. The main session integrates, decides and talks to the owner.

---

## 5. Architecture (architect may refine with written justification)

One Node.js service in Docker. Modules under `src/`:
- `config/`: zod-validated, versioned in the database; hard caps live in code and config cannot exceed them.
- `storage/`: SQLite with migrations (WAL mode) and daily backups.
- `chain/`: RPC and websocket clients, provider failover, credit and rate-limit governor, health metrics, clock-drift check.
- `ingest/`: streams normalized into `MarketEvent`s (tracked-wallet swaps, FOMO swaps, launches, migrations, trending snapshots, prices).
- `fomo/`: FOMO trade detection, on-chain FOMO wallet leaderboard, crowd-flow metrics, signal-health monitor.
- `safety/`: token vetting (section 8) with cached verdicts and TTLs.
- `strategies/`: copy, crowdflow, launch, momentum. Each emits `TradeIntent { token, side, sizeHint, confidence, reasons[], strategy }`.
- `risk/`: the only gate to execution (section 9).
- `execution/`: quote, build, simulate, send, confirm, reconcile (section 10), plus paper and shadow fills.
- `portfolio/`: positions, cost basis including every fee, PnL in SOL, USD and EUR, chain reconciliation.
- `exits/`: exit policies and the tournament (section 11).
- `telegram/`, `ai-review/`, `reports/`, `ops/` (health, heartbeat, backups).

Rules: every decision logs its inputs and reasons, so any trade can be explained in one Telegram message. Each strategy has a mode `off | paper | live`; there is a global pause; live trading needs two keys (a server flag plus the owner's Telegram go-live). One position per token. Every network call has an explicit timeout.

---

## 6. Data and infrastructure on $5-10/month

- **RPC:** start with Helius Free (as of 2026: 1M credits/month, 10 requests/s, 1 sendTransaction/s, standard WebSockets; Enhanced WebSockets and LaserStream gRPC are paid; verify). Add at least one other free provider as fallback. Use the public mainnet RPC only as a last-resort read fallback.
- **Budget governor:** account credits and requests per provider per feature, with daily budgets. Degrade in this order before hitting limits: momentum polling, then crowd-flow sampling, then launch scanning. Never degrade exits or reconciliation. Alert the owner at 80% of any budget.
- Prefer websocket subscriptions plus log parsing over per-transaction fetches. Standard `logsSubscribe` accepts one address per `mentions` filter, so plan subscription counts against provider limits.
- **Market data:** free sources (e.g. Jupiter quote/price, DexScreener, GeckoTerminal). Verify terms and limits; cache aggressively.
- **FOMO signal source** (from Bitquery's public on-chain analysis, checked Sept 29, 2026; NOT confirmed by FOMO):
  - Signer and fee payer on every FOMO Solana trade: `AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51`
  - FOMO fee account (USDC): `HrTf9CzXR1dRH4Sof5QrpmGWwpwAf3qZzwCsEjQpXcSq`, owned by `R4rNJHaffSUotNmqSKNEfDcJE8A7zJUkaoM5Jkd7cYX`
  - Most FOMO trades route through the DFlow aggregator; the user's own wallet appears as the owner on the DFlow leg. The signer also signs non-trade transactions, so count trades from swap data only.
  - Volume was roughly 0.9-1.2M FOMO trades/day on Solana in late Sept 2026 (about 10-14 per second), far too many to fetch one by one on a free tier.
  - Phase 0 must: confirm the signer is still active; test whether websocket logs alone identify user wallet, mint, side and size; measure what sampling rate the budget allows; evaluate Bitquery's free tier as an alternative; pick the best option and document latency, completeness and cost. Build a health monitor that, if no FOMO-signed trades are seen for 10 minutes (the address may rotate), alerts the owner, switches the crowd-flow strategy to paper and freezes leaderboard updates until the signal is back or re-verified.
- **Hosting:** cheapest reliable VPS (~$5/month) in Germany near Frankfurt, Ubuntu LTS, Docker Compose. Measure latency to the RPC and transaction-sending endpoints and pick the closest.
- **AI:** Anthropic API with `claude-haiku-5-5` by default (configurable to `claude-sonnet-5-5`), hard monthly cap of $1 (configurable). Verify model IDs and pricing at docs.claude.com.
- **`docs/UPGRADE_PATH.md`:** what each paid upgrade would add (faster streams, faster sending, higher limits), its monthly cost, and the paper evidence that would justify it. Never upgrade without the owner's OK.
- **Honest constraint:** on this budget the bot will not win first-block speed races. Its edge, if any, must come from selection: FOMO-specific signals, strict safety filtering and cost discipline.

---

## 7. Strategies

Common rules: each strategy emits intents with reasons; one position per token across all strategies; agreeing signals raise confidence but never size beyond the caps; PnL is attributed to the originating strategy.

### 7.1 Copy top FOMO traders
- **Leaderboard:** accumulate FOMO trades from on-chain data within budget. Per wallet compute realized PnL after fees, win rate, expectancy, profit factor, trade count, consistency over time, average hold time and entry market cap.
- **Copyability score:** re-simulate each of their trades with the bot's measured delay (detection to landing; assume 2-5 s until measured) and the bot's exit policy. Rank by copyable expectancy, not raw PnL.
- **Exclude:** small samples (<20 closed trades), edges that vanish with delay, likely insiders, devs or bundlers (funded by token creators, buying in the launch slot), wash-trading patterns, and long-term holders whose results can't be copied with ~$5 trades.
- The owner can `/follow <address> [label]` and `/unfollow` traders they like, e.g. when a FOMO profile shows a wallet address; they type it in by hand.
- **Entry:** tracked wallet's buy confirmed, then safety, then risk, then execute. Size scales with wallet score and their conviction (their size versus their usual), within caps.
- **Exit:** mirror their sells proportionally or follow the exit policy, whichever comes first; universal exits always apply.

### 7.2 FOMO crowd flow
- Per token, rolling 1/5/15-minute windows: distinct FOMO buyers, buys and sells, net flow, acceleration, share of top-scored wallets, time since first FOMO buy, FOMO share of total volume. Track data completeness as a confidence score.
- **Entry:** early acceleration from a low base, safety pass, enough liquidity, and not already up more than a configurable percentage in the last N minutes.
- **Exit:** sell into strength as the crowd peaks (buyers per minute rolling over, net flow turning negative, top wallets exiting), plus universal exits.

### 7.3 Smart launch sniping (launchpads and migrations)
- Verify current launchpads, program IDs, fees and graduation/migration mechanics in Phase 0; they change often.
- Don't race block zero. Enter in the "second wave" only when early metrics are healthy: growing unique buyers, no bundle pattern (many fresh wallets funded from one source buying in the same slot), dev holding below threshold and not selling, top-10 holders below threshold (excluding curve and pool accounts), creator not on the rug list, sane bonding-curve progress. Or enter on graduation/migration with healthy metrics.
- Smallest risk allocation by default (at most 25% of total exposure) until it proves itself.

### 7.4 Momentum / trending
- Candidates from free trending and volume sources plus FOMO flow. Require rising volume and holder count, liquidity above threshold and a healthy buy/sell balance. Prefer pullback entries over chasing vertical candles. Avoid tokens with recent dev sells or liquidity removal.

---

## 8. Token safety (every buy, no exceptions, fail closed)

- **Token program and Token-2022 extensions:** reject permanent delegate, transfer hooks (unless allowlisted after review), transfer fees above threshold, default-frozen accounts and non-transferable tokens. Mint and freeze authorities must be revoked, except where a verified launchpad program legitimately holds them during the bonding-curve phase.
- **Sellability:** a sell route must exist for the intended size with acceptable price impact; simulate the sell path where feasible; reject honeypots.
- **Liquidity:** estimated round-trip price impact for the intended size must be within limits.
- **Holders and people:** concentration, dev wallet behavior, bundle detection, creator history, token age, metadata mutability.
- **Cost rule:** expected round-trip cost (fees, priority fees, tips, slippage, unrecoverable rent) must be at most 5% of the position (configurable). With ~$5 positions this rule decides a lot; measure it, don't guess.
- Cache verdicts with a TTL. Log every rejection with reasons, and later measure what rejected tokens did, to tune filters with evidence rather than loosening them blindly.

---

## 9. Risk engine (owner's numbers are ceilings config cannot exceed)

- **Equity** = SOL balance plus positions marked conservatively (sell-quote value, not mid price).
- **Per trade:** at most 10% of equity. Minimum trade size is the smallest size that meets the cost rule; if equity is too small for it, stop entering and tell the owner.
- **Exposure:** at most 4 open positions, total exposure at most 50% of equity, one position per token.
- **Daily stop:** -30% versus start-of-day equity (00:00 Europe/Athens) means no new entries until reset; exits continue.
- **Peak stop:** -50% from the equity peak halts entries, alerts the owner and waits for `/resume`.
- **Fee reserve:** at least max(0.01 SOL, 2x the p95 cost to exit every open position), untouchable by buys.
- **Cooldowns:** per strategy after consecutive losses, and per token before re-entry.
- **Live ramp:** first 20 live trades per strategy at half size. Auto-demote a strategy to paper and notify the owner if, after 30 live trades, live expectancy after costs is below zero, or live results fall far below the shadow-paper results for the same signals.
- **Circuit breakers:** stale data, RPC error spikes, clock drift, repeated send failures, reconciliation mismatch or any unexpected balance change stop new entries and alert the owner.
- **Invariants (property-tested):** caps never exceeded; reserve never spent; no duplicate positions; no transfer except the allowlisted withdraw; no NaN, negative or overflowing sizes.

---

## 10. Execution

- **Routing:** compare an aggregator (verify Jupiter's current APIs and terms) against direct launchpad/AMM instructions for each token stage. Choose by measured landing rate, latency and all-in cost in shadow mode.
- **Pipeline:** fresh quote, build, simulate, send, confirm with a timeout, reconcile from chain. Priority fee from recent estimates, capped. Tips only when expected value justifies them, capped as a percentage of trade size; some fast-send services require minimum tips that are large next to a ~$5 trade, so account for that.
- **Slippage:** dynamic by liquidity and volatility, with a hard maximum. Use MEV-protected submission where it is available within budget.
- **Idempotency:** every intent has an ID; events are deduplicated; retries can never double-buy; blockhash expiry is handled safely.
- **Rent:** after a full exit, close the token account to reclaim its rent (about 0.002 SOL each; verify), burning dust first if needed.
- Record every cost per trade.

---

## 11. Exits, paper trading and go-live gates

**Universal exits (always on):** hard stop per position; rug signals (liquidity pulled, dev dump, freeze or authority change); time stop when flat; protective handling when the price feed goes stale.

**Exit-policy tournament:** run every candidate on every entry as a counterfactual, scored after costs, including the extra fees of partial sells (which matter a lot at ~$5 size).
- **P1 (default):** take profit early, trail, keep a moonbag. Sell ~50% at +100% to recover cost, trail the rest ~30% from peak, keep ~10% on a wide trail; hard stop -35%; time stop at 30 minutes if under +10%.
- **P2 scalp:** take profit at +30-50%, stop at -15-20%, short time stop.
- **P3 moonshot:** stop at -35-40%, no fixed take-profit, wide trail after 3x.
- **P4 signal-driven:** exit on the copied wallet's sell, FOMO-flow decay or momentum loss.

These are starting values; quant-strategist tunes them per strategy. A strategy's live exit policy changes only through a daily-review proposal the owner approves, and only when the challenger beats the incumbent by a statistically meaningful margin (define the test, e.g. a bootstrap confidence interval on expectancy with a minimum sample size).

**Paper engine realism:** decisions on live data; fills at the quote available after the measured latency; the real fee schedule; landing failures simulated at measured rates; rent and priority fees included; no look-ahead. In live mode, keep a shadow paper run for comparison.

**Go-live gate per strategy** (defaults; may be tightened, never loosened without the owner):
- at least 50 closed paper trades over at least 7 days;
- positive expectancy after all costs, profit factor at least 1.2, paper max drawdown within -40%, with the confidence interval reported honestly;
- no open critical or high issues, and current risk-guardian and security-auditor sign-offs;
- then the owner gets a plain-English Telegram summary and a single "Go live" button.

**Pre-mortem before any live money:** write `docs/PREMORTEM.md` listing the 15 most likely ways the bot could lose money unexpectedly, each with its mitigation and the test that proves the mitigation works.

---

## 12. Telegram (owner-only)

- **Pairing:** on first run the bot shows a one-time code only in the server console; the owner sends that code in Telegram to bind their account. After that, every other user is ignored. Commands are rate-limited; dangerous ones need a confirmation button.
- **Commands:** `/status`, `/pnl`, `/positions`, `/trades`, `/why <trade>`, `/strategies`, `/golive <strategy>`, `/paper <strategy>`, `/pause`, `/resume`, `/panic` (sell everything to SOL within a slippage cap, then pause), `/limits`, `/set <param> <value>` (bounded), `/follow`, `/unfollow`, `/watchlist`, `/proposals`, `/approve`, `/reject`, `/rollback`, `/report`, `/withdraw <amount|all>`, `/help`.
- **Alerts:** every entry and exit with a plain-English reason, size, price, fees, PnL and a Solscan link; daily summary at 09:00 Athens time (SOL, USD, EUR); warnings for degraded data, lost FOMO signal, budgets at 80%, stops hit, reconciliation mismatches and restarts; a weekly report.
- Short, phone-friendly messages. Never include secrets.

---

## 13. Daily AI review

- At 08:30 Athens time, build a compact stats JSON: per strategy and exit policy, trades, win rate, expectancy after costs, drawdown, cost breakdown, what rejected signals did afterwards, data quality, notable trades.
- Call the Anthropic API with a strict JSON schema: a plain-English summary of at most 8 lines plus up to 3 proposals `{ param, current, proposed, reason, expectedEffect, risk }`. Validate against bounds and drop anything invalid.
- Send to Telegram with Approve and Reject buttons. Approved changes create a new config version; `/rollback` restores the previous one.
- The AI only tunes parameters within bounds. It can never raise risk caps, switch a strategy to live, touch wallet or withdraw settings, add dependencies or change code.
- If no API key is set, skip the review and remind the owner they can run `/review-trades` in Claude Code.
- Provide a `stats:export` command that writes the same stats JSON (never any secrets), which the `/review-trades` skill uses.

---

## 14. Deployment and operations

- **`docs/OWNER_GUIDE.md`:** numbered copy-paste steps for someone with zero technical knowledge, with what they will see after each step: create the VPS; create a Helius free account; create the Telegram bot with @BotFather; get an Anthropic API key (optional); run one setup command; create the wallet on the server (shows the address only); back up the key offline with the owner-run backup command; set the one withdrawal address in the server config; fund the wallet with a small amount of SOL from an exchange or any wallet they control; start in paper mode; read Telegram; go live; pause and panic; withdraw; update; what to do if something looks wrong.
- You may run deployment over SSH with the owner's permission, but never read secrets on the server.
- **Server hardening:** non-root user, SSH keys only, firewall allowing only SSH inbound, fail2ban, unattended security updates, time sync, Docker restart policy, health check, log rotation, daily SQLite backup (keep 7).
- **Dead-man switch:** a free external heartbeat service (verify one) alerts the owner if the bot goes silent.
- One-command update with pre-flight tests, and one-command rollback.
- **Records:** CSV export of every trade (UTC and Athens time, SOL/USD/EUR values, every fee) for the owner's accountant. No tax advice.

---

## 15. Phases and Definition of Done

**Phase 0: team and reality check (no trading code)**
1. Create the files, agents and skills from section 4; `git init`.
2. Run researcher subagents in parallel to verify: FOMO signer activity and log parsability (section 6); free-tier limits of the chosen providers; current launchpads, program IDs, fees and migration mechanics; aggregator APIs and terms; Token-2022 extension handling; fast-send and MEV-protection options and their minimum tips; VPS prices; Anthropic model IDs and prices; a free heartbeat service.
3. Write `docs/VERIFIED_FACTS.md` and `docs/FEASIBILITY.md` (what each strategy can realistically do on $5-10/month, expected monthly cost, biggest risks).
4. Send the owner a plain-English summary of at most 10 lines, plus at most 3 questions, each with a recommended answer.

**Phase 1: design (plan mode; no code until the owner approves).** Ultrathink about failure modes. Write `docs/ARCHITECTURE.md`, `docs/RISK_POLICY.md`, `docs/TEST_PLAN.md` and `docs/THREAT_MODEL.md`; get risk-guardian and security-auditor reviews; the owner approves a 10-line summary.

**Phase 2: foundations (tests first).** Config, storage, chain clients with the budget governor, portfolio accounting, risk engine, execution in simulate-only mode, paper engine, basic Telegram, logging. At least 90% coverage on risk, accounting and amount math; property tests for every invariant in section 9.

**Phase 3: data and safety.** Ingest, the FOMO module with its health monitor, token safety with fixtures built from real mainnet transactions, including known rugs and honeypots.

**Phase 4: strategies, one at a time,** in this order: copy, crowd flow, momentum, launch. Each gets tests, a multi-hour local paper run, and quant-strategist plus risk-guardian review.

**Phase 5:** exit tournament, daily AI review, reports.

**Phase 6: security audit.** Full review, dependency audit, secret scan; fix every critical and high finding; write the pre-mortem.

**Phase 7: deploy to the VPS in paper mode.** 24-hour soak; verify alerts, restarts, backups, heartbeat and reconciliation; walk the owner through the guide.

**Phase 8: live readiness.** With the owner's explicit OK, make one minimum-size buy and sell on a deep-liquidity token to verify the full live path and cost accounting. Then strategies go live one at a time through their gates.

**Definition of Done (every phase):** tests pass (show the output); typecheck and lint are clean; required sign-offs are in `docs/REVIEWS.md`; `docs/STATUS.md` is updated; a plain-English summary has gone to the owner; git commit. Never claim something works without having run it.

---

## 16. How to talk to the owner

- Plain English, at most 10 lines per update; define any technical term in a few words.
- One question at a time, always with your recommended answer.
- Tell them exactly what to click or type and what they should see.
- Before a permission prompt that runs something important, say in one line what it does.
- Warn before anything that costs money or touches real funds, and get an explicit yes.
- Never ask for a private key, seed phrase or FOMO login.
- When unsure, say so and propose how to test it.
- Start every session by reading `CLAUDE.md` and `docs/STATUS.md`.

---

## 17. Reference sources (re-verify; things change)

- FOMO Terms of Service: https://fomo.family/terms
- Bitquery, FOMO trades on Solana: https://docs.bitquery.io/docs/blockchain/Solana/fomo-api/
- Helius plans and limits: https://helius.dev/docs/billing/plans
- Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- Claude Code skills: https://code.claude.com/docs/en/skills
- Claude Code settings and permissions: https://code.claude.com/docs/en/settings
- Claude API: https://docs.claude.com

---

## 18. Start now

Begin Phase 0. Set up the team (section 4), then run the reality checks in parallel. Do not write trading code yet. When Phase 0 is done, send me the plain-English summary and your questions.
