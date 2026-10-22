# Plan: samsulek

Status: **approved by the owner (capital raised to EUR 50, Windows machine).
M1 built; see §6.**

## 1. Decisions from your answers

| Topic | Decision | Why |
|---|---|---|
| Capital | €50 total | Your answer (raised from €10). Shapes everything below. |
| Broker | **Trading 212** (Invest account, EUR) | EU-regulated and serves Greece. €0 commission, fractional shares, EUR deposits, a free **demo** account with API access for paper trading. IBKR's minimum commission (~€1+/order) would eat 2% of €50 on every trade. Alpaca only takes USD deposits, and an international wire can cost €10-30. |
| Account type | Cash (Invest), long-only, no leverage | Safest. No margin calls, no shorting. |
| What we trade first | **Stocks, specifically EUR-listed UCITS ETFs** | EU retail investors generally can't buy US-domiciled ETFs (PRIIPs/KID rules), and EUR listings avoid Trading 212's FX fee. |
| Memecoins | **Solana, simulation only** | Even at €50, fees, token-account rent and MEV eat most of a small trade. See §2. |
| Strategy speed | Daily bars, one scheduled run per trading day | You check twice a day. Nothing should need you watching. |
| Paper phase | 1 month minimum on Trading 212 demo | Your answer. Extended if too few trades happen to compare. |
| Data | €0: free daily ETF data + a free Solana recorder we run ourselves | Your budget. Sources confirmed in M2. |
| Alerts | Telegram bot | Free, reaches your phone, can accept a `/kill` command locked to your chat ID. |
| Where it runs | Your Windows machine (PowerShell; Git for Windows installed) | This cloud session is for building only and never holds live keys. |
| LLM/AI signals | Not now; the architecture leaves room for them later | Your answer. |

## 2. Honest assessment (read this one)

- **€50 can't make meaningful money, whatever the strategy.** A very good
  strategy earning 15% a year makes €7.50 a year. That's fine *if* we're clear
  about what the €50 is for: an end-to-end test that real orders, real fills,
  reconciliation, and the kill switch all work with real money, at a risk you
  can shrug off. Everything before M6 (research, backtests, paper trading)
  costs €0. What €50 changes vs €10: 3-4 ETF positions of €10-15 each become
  practical, and the €1 minimum order is 2% of the account instead of 10%.
- **Likely research outcome:** simple, well-known strategies on ETFs usually
  show a small edge after costs at best, or none. A realistic good outcome is
  trend-following that cuts drawdowns compared with buy-and-hold, not one that
  beats it on raw return. If M4 says "no edge", the pipeline worked: it saved
  you money.
- **Memecoins:** for an automated retail system that isn't competing on speed,
  I expect negative expected returns once fees, rugs, MEV, and failed
  transactions are counted. On top of that, at €50 each new token account
  locks a small SOL deposit, and buying SOL then moving it to a wallet costs
  exchange and withdrawal fees. So: we build the safety filter, recorder, and
  simulator properly, test honestly, and **no live memecoin execution code gets
  written** unless the simulation shows an edge that survives 2x costs.
- **Free data has limits.** Free sources rarely include delisted stocks, which
  is why we start with broad ETFs (they rarely disappear). Many UCITS ETFs only
  exist since ~2010. For longer history we use long-running indices/US ETFs as
  *research proxies*, converted to EUR with free ECB FX rates. The gap between
  proxy and the real tradable ETF gets measured, not ignored.
- **Trading 212's API is in beta.** Per its docs it works for Invest/ISA
  accounts, has separate demo and live keys, places orders by quantity, and
  only trades in the account's main currency. I couldn't confirm whether it
  offers price data, which order types work in live, or its exact rate limits.
  This environment's network policy blocks `docs.trading212.com`. We verify
  all of that against the real docs before M5 and design around whatever we
  find.

## 3. How it works

```
         ┌────────── same code in backtest, paper, and live ───────────┐
data ──► signals ──► strategy ──► RISK ENGINE ──► order router ──► broker/sim
 │       (point-in-   (target      (hard limits,    (only path to     │
 │        time)        weights)     halt, kill)      a broker)        │
 │                                                                    ▼
 └──────────────── staleness checks ◄──── portfolio state ◄── fills / reconcile
                                                 │
                                    decision log (JSONL) + Telegram + HTML dashboard
```

A trading day (stocks, paper or live):
1. **Before the open:** reconcile local state with the broker. Any mismatch →
   halt and alert. Download yesterday's closing data. Data stale or broken →
   halt and alert.
2. The strategy computes target weights from data up to yesterday's close.
3. The risk engine checks every proposed order against the hard limits, the
   halt flag, and the kill flag. Each rejection is logged with its reason.
4. **Shortly after the open** (after the opening auction settles), the router
   places limit orders with a price collar (the max-slippage cap).
5. **After the close:** reconcile again, update PnL, send the Telegram summary,
   refresh the dashboard.

### Safety layers (each one works even if the others fail)

1. **Live credentials never exist where Claude runs.** This is the strongest
   layer.
2. **Live mode needs four things:** `LIVE=true`, `--mode live`, a typed phrase
   read from a real terminal (so piped input or an AI agent can't fake it), and
   a fully signed go-live checklist.
3. **Claude Code guardrails:** `.claude/settings.json` deny rules plus the
   `.claude/hooks/guard.py` hook (tested, fails closed). Already active.
4. **Risk engine:** percentage limits *and* absolute EUR caps, so a bug that
   reads your equity as €10,000 still can't place a €5,000 order.
5. **Persistent halt and kill flags,** checked before every order and cleared
   only by you, by hand.

## 4. Proposed default risk limits (you approve these; changing them later needs your OK)

Stocks/ETFs (`config/risk.yaml`):

| Limit | Default | At €50 |
|---|---|---|
| Max position | 30% of equity | €15 |
| Max position, absolute | €20 | €20 |
| Max total exposure | 100% of equity (no leverage) | €50 |
| Max total exposure, absolute | €60 | €60 |
| Order size, absolute | €1 min, €20 max | |
| Max daily loss (overnight gaps count) | 3% → halt until you run `samsulek reset-halt` | €1.50 |
| Max drawdown from peak | 15% → halt | €7.50 |
| Equity sanity check | equity above €200 → halt (bug, or a deposit you didn't announce) | |
| Max trades per day | 6 stocks, 8 total | |
| Max slippage per order | 0.5% from the reference price (limit-price collar); emergency exits 2% | |
| Price staleness | reference price older than 15 minutes → refuse | |
| Data staleness | the latest daily bar must be the previous Xetra session's (calendar-aware; Q11) → halt | |
| Market orders | not allowed (limit orders only) | |

Memecoins (simulation): max position 5% of equity (€2.50, cap €5) and 0.5% of
pool liquidity; max exposure 20%; max slippage 3%; prices older than 30 s are
stale; every buy needs a passing safety-filter result. The safety filter rejects by default. Minimum liquidity, token
age, and holder-concentration thresholds are set in M2 from what the recorder
actually sees.

## 5. File structure

```
samsulek/
├── CLAUDE.md                     # rules (done)
├── README.md                     # beginner setup: install, run, stop, what to check
├── pyproject.toml / uv.lock      # exact pinned deps with hashes
├── env.example                   # names of the env vars you'll set (no values)
├── .claude/
│   ├── settings.json             # deny rules + hook wiring (done)
│   └── hooks/                    # guard.py + run-guard.sh launcher, works on Windows (done)
├── config/
│   ├── default.yaml              # mode, universe, schedule, data sources
│   └── risk.yaml                 # hard limits (owner-approved edits only)
├── ops/
│   ├── go_live_checklist.md      # every box ticked and dated by you before live
│   └── runbook.md                # what to do when an alert fires
├── research/
│   ├── experiments.md            # every experiment, failures included
│   ├── holdout.md                # locked out-of-sample dates
│   └── reports/                  # committed backtest reports (HTML/MD)
├── src/samsulek/
│   ├── cli.py                    # run | kill | reset-halt | reconcile | backtest | report | record-solana
│   ├── config.py                 # typed config (pydantic), secrets as masked values
│   ├── credentials.py            # env-only secret access + log redaction
│   ├── logging_setup.py          # JSONL decision log, redaction filter
│   ├── clock.py                  # real vs simulated time, exchange calendars
│   ├── types.py                  # Bar, Signal, TargetWeights, Order, Fill, Position
│   ├── data/                     # sources, Parquet/DuckDB store, quality + staleness checks
│   ├── signals/                  # pure point-in-time feature functions
│   ├── strategies/               # emit target weights only, no broker access
│   ├── risk/                     # limits, engine, persistent halt/kill state
│   ├── execution/                # router (only broker path), sim broker, trading212 adapter
│   ├── costs/                    # fees, spread, slippage, AMM/bonding-curve impact, FX
│   ├── portfolio/                # positions, cash, PnL, reconciliation
│   ├── backtest/                 # event loop, metrics, baselines, walk-forward, deflated Sharpe
│   ├── memecoin/                 # safety filter, Solana recorder, pool simulator
│   ├── alerts/                   # Telegram
│   └── dashboard/                # static HTML report (no web server to secure)
└── tests/                        # risk engine, sizing, orders, no-lookahead, guard hook
```

## 6. Milestones

Each one ends with a short summary, how to run it, and a stop for your OK.

**M1: skeleton, config, secrets, risk engine, kill switch, tests**
- Package, typed config, env-only secrets with log redaction, JSONL decision
  log.
- Risk engine with every limit in §4, persistent halt/kill flags,
  `samsulek kill [--flatten]` and `samsulek reset-halt`.
- Router plus simulated broker. A test proves strategy modules can't import
  execution code, and another proves orders without a risk approval are
  refused.
- Live-mode gate: env + flag + TTY phrase + checklist. Tested to refuse without
  each one.
- Tests: unit and property-based (Hypothesis) tests for limits, sizing,
  rounding, and halt behavior.
- Dependencies, each checked on PyPI before adding: `pydantic`, `PyYAML`,
  `tzdata` (Windows has no built-in timezone database); dev-only `pytest`,
  `hypothesis`, `ruff`, `mypy`, `types-PyYAML`. Managed with `uv`, locked with
  hashes, and never newer than a 14-day supply-chain cooldown.
- One run at a time (an operating-system lock the OS releases if a run dies);
  orders last one run, except the kill switch's exits, which no run cancels.
- Reviewed by three independent adversarial review passes: 41, then 32, then
  12 confirmed findings, all fixed, with regression tests. The later rounds'
  tests were checked to fail when the bug is put back.
- **Status: built.** README.md has the Windows steps to run it.

**M2: data pipeline**
- Free daily data for the ETF universe and research proxies, ECB FX rates, and
  the exchange calendar. Stored in Parquet/DuckDB with point-in-time
  timestamps. Quality checks for gaps, spikes, and stale data.
- Solana recorder: logs every new token/pool from the main launchpads and DEXes
  from now on (rugs included), plus periodic snapshots, using free endpoints
  over plain JSON-RPC/HTTP. No Solana SDK, so less supply-chain risk. It needs
  your machine to stay on; gaps get recorded as gaps.
- Survivorship notes for every dataset.
- **Status: built except ETF prices.** Done: the point-in-time store
  (DuckDB/Parquet, one new dependency: `duckdb`), the Xetra calendar, ECB FX
  rates (`samsulek data update`), data-quality checks, and the Solana recorder
  (`samsulek record solana`): GeckoTerminal new pools for discovery,
  DexScreener for snapshots, Solana RPC for mint facts, pump.fun bonding
  curves, holder lists and a launch counter that measures what discovery
  misses. Dataset notes: `research/data_notes.md`. **ETF daily prices have no
  verified free source yet**: every option checked so far either forbids
  automated downloads or couldn't be reached from the build environment, so
  the owner is checking Stooq from their own PC.
- Reviewed: each source adapter by a second, skeptical pass; then M2 as a
  whole by independent reviewers (point-in-time correctness, fail-closed
  behaviour, security, then Windows and weeks-long running, plus a check of
  the fixes): 25 confirmed issues, all fixed with tests. The tests were checked
  to fail when each fix is undone (44 deliberate re-introductions, all caught).

**M3: backtester**
- Event-driven, reusing M1's strategy, risk, and sim-broker code. Decisions at
  the close, fills at the next open or later. Cost model: spread, slippage, FX,
  failed-transaction and priority-fee models for memecoins.
- Every result also run at 2x costs. Baselines: buy-and-hold and random entries
  (many seeds). The full metrics list. Deflated Sharpe. Walk-forward. Locked
  holdout.
- Tests with planted lookahead and planted leakage that the checks must catch.

**M4: honest tests of 2–3 strategy families**
- ETF trend-following (time-series momentum), cross-asset dual momentum, and a
  short-term mean-reversion test (expected to be weak after costs).
- One simple memecoin hypothesis on the recorder data, simulation only.
- Everything logged in `research/experiments.md`. A plain-language verdict for
  each, including "no edge" verdicts.

**M5: paper trading (≥ 1 month)**
- Only for a strategy that survived M4. Trading 212 demo adapter, built after
  checking the current docs. Scheduled runs on your machine. Reconciliation,
  Telegram alerts with `/kill`, daily summary, dashboard.
- Compare paper vs backtest on the same days: fills, slippage, trade count,
  PnL.
- Before the Trading 212 client logs anything: harden redaction for quoted
  names (`"api_key": "..."`), `Authorization: Bearer/Basic` headers, and encoded
  forms of each secret (base64 of `key:secret`, URL-encoded). Found in review
  of M1; nothing in M1 sends a secret anywhere yet.

**M6: go-live checklist**
- Before live: anchor the one allowed project folder outside the repository
  (an owner-written setting), so a second installed copy of the bot with looser
  limits can't trade the real account. M1 only checks that code, config and
  checklist come from the same folder.
- You sign off on every item: paper roughly matches the backtest, the kill
  switch was tested for real, halts were tested, reconciliation mismatch was
  tested, and alerts arrive.
- Live with tiny sizes, started by you. You make the €50 deposit yourself.
  Scale up only with money you can afford to lose, gradually, based on live
  results.

## 7. What you'll need to do, and when

- **Done:** plan approved, Windows confirmed.
- **M1 (now):** install Git, Python 3.12 and `uv`, then run the tests and a
  simulated cycle. README.md has exact copy-paste steps.
- **M5:** open a Trading 212 account and create a **demo** API key, then create
  a Telegram bot. You put both into `.env` yourself, never in chat.
- **M6:** deposit, switch to live, and run the go-live checklist. All you, by
  hand.

## 8. Things to verify before integrating (don't trust memory)

- Trading 212 API: price data availability, live order types, fractional
  quantities, rate limits, demo fill realism, instrument tickers for UCITS ETFs.
- Free ETF data source terms and reliability, and free Solana RPC limits.
- Current Trading 212 fee schedule for the Greek (CySEC) entity.
- Greek tax treatment: not my job to advise, but the system keeps a full trade
  ledger you can export for an accountant.

## 9. Known limits of the guardrails

The hook is pattern-based. It blocks the obvious and the lightly obfuscated, but
a sufficiently creative command could evade it. That's why the layers in §3
don't depend on it: no live keys where Claude runs, plus a TTY-only live
confirmation.
