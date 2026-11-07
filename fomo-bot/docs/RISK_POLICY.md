# Risk policy (Phase 1 design)

Every number the risk engine enforces, its kind, and why. Same code for paper and live.
"(P)" = proposed by the architect, **the owner confirms**. Amounts in SOL are bigint
lamports in code. Example sizes assume the paper bankroll of 0.55 SOL (~$50, LOW-confidence
SOL price); the bot's bankroll counts toward the owner's EUR 50 total (FEASIBILITY.md s.5).

## 1. In plain English

- Your numbers are ceilings in the code; config, Telegram and the AI cannot go above them.
  The root project adds stricter safety nets on top.
- Each trade: at most 10% of the account and 0.06 SOL, at most 4 open, at most 0.5% of the
  pool. Allowed only if its expected total cost is at most 5% (many pump.fun trades fail).
- Selling is always allowed. Going live needs paper proof at double costs and against
  random entries.

## 2. Kinds of limit

| Kind | Meaning | Who can change it |
|---|---|---|
| H (hard ceiling) | constant in `src/config/caps.ts` (`HARD_CAPS`) | code change only: owner's OK in chat plus risk-guardian and security-auditor |
| T [min, max] (tunable bound) | versioned DB value; /set and approved AI proposals stay inside [min, max]; max <= H | owner by /set (confirmed); AI only as below |
| D (default) | starting value of a tunable | as T |

Paper runs with the brief's numbers. Live limits are owner decision 9 (ARCHITECTURE.md):
the brief's numbers, or the root project's stricter ones (5% per position, -3% daily,
-15% peak, 20% exposure).

## 3. Limits

| # | Limit | Value | Kind | Source, why |
|---|---|---|---|---|
| 1 | Size per trade | at most 10% of equity (0.055 SOL at 0.55 SOL) | H 10%; T [1%, 10%]; D 10% | brief |
| 2 | Absolute size per position | 0.06 SOL | H | root style: holds even if equity is misread (about EUR 5) |
| 3 | Open positions | 4 | H 4; T [1, 4] | brief |
| 4 | Total exposure | 50% of equity | H 50%; T [10%, 50%] | brief |
| 5 | Absolute exposure | 0.30 SOL | H | root style (root memecoin cap would be about 0.12 SOL) |
| 6 | One position per token, no adding to a position | - | H (DB unique index) | brief, root |
| 7 | Pool share | position at most 0.5% of pool liquidity (liquidity = 2 x real SOL reserve), so 0.055 SOL needs 5.5 SOL real reserve | H 0.5%; T [0.1%, 0.5%] | root: exits must be possible |
| 8 | Launch strategy exposure | at most 25% of the exposure cap (12.5% of equity: one launch position) | H | brief |
| 9 | Daily stop | -30% vs start-of-day equity (00:00 Europe/Athens): no new entries until 00:00; two days in a row: entries wait for /resume (P) | H 30%; T [5%, 30%] | brief; root halts until a manual reset |
| 10 | Peak halt | -50% from the equity peak: entries halted until /resume, which rebases the peak | H 50%; T [10%, 50%] | brief; who may resume: decision 4 |
| 11 | Fee reserve | max(0.01 SOL, 2 x p95 cost to exit every open position + 1,488,440 lamports wSOL helper rent if any exit needs one); buys can never spend it | H floor 0.01 SOL | brief: exits always affordable |
| 12 | Equity sanity | equity at most 2.0 SOL and at most 3 x the configured bankroll; +50% within 1 h without matching fills | H | root: a bug or unannounced deposit halts |
| 13 | Entries per day | 8 (P) | H 12; T [1, 12] | root (8 trades/day) |
| 14 | Cost rule | expected round trip at most 5% (section 5) | H 5%; T [2%, 5%] | brief |
| 15 | Minimum trade | smallest size that meets the cost rule, never below 0.02 SOL (P) | H floor 0.01 SOL | brief |
| 16 | Buy slippage tolerance (minOut) | 2% (P) | H 3%; T [0.5%, 3%] | root 300 bps |
| 17 | Sell slippage tolerance | 3% normal (P); protective and emergency 10% | H 5% normal, 10% emergency | root flatten 1000 bps |
| 18 | Landing spend per transaction | priority + tip at most 0.2% of the position (P); CU price at most 200,000 uL/CU; CU limit 1.2 x simulated, at most 300,000; exits may use 2 x | H 0.3% (exits 0.6%) | phase0-execution |
| 19 | Tips | 0, 1,000 (Jito) or 5,000 (Helius SWQOS-only) lamports; never a 0.001 SOL service | H | VERIFIED_FACTS s.4 |
| 20 | Data freshness | plan reserves at most 25 slots old; open-position marks: 30 s stale = entries off, 60 s = protective exit | H | root 30 s quote age |
| 21 | Price cross-check | entry only if our reserve price is within 3% of Jupiter Price v3 | T [1%, 5%]; D 3% (P) | manipulation guard |
| 22 | Token age | crowdflow 10 min, launch 3 min, momentum 24 h (avoids Jupiter's young-token fee) (P) | T [3 min, 30 days] | brief |
| 23 | Curve progress | no new pump-curve entries above 90% progress (P) | H 95%; T [10%, 90%] | graduation timing UNVERIFIED |
| 24 | Token types rejected | unknown Token-2022 extensions; any transfer fee above 0 bps (P, stricter than the research's 100 bps: withheld fees block closing the account); mayhem-mode coins (P); non-SOL quote pools; unsupported venues | H | safety research |
| 25 | Universal hard stop | -35% from cost basis (P) | T [10%, 40%] | brief P1 |
| 26 | Universal time stop | 30 min if under +10% (P) | T [5, 240] min | brief P1 |
| 27 | Moonbags | not allowed live at this size; tournament may test them only when charged their locked rent | H | rent is ~5% of a 0.03 SOL position |

## 4. Equity

- Equity = SOL balance + every open position marked at its exact full-size sell quote after
  venue fees and exit network fees (not mid price). Paper uses the paper SOL balance.
- If any position cannot be valued, equity is "unknown": entries are blocked and stops are
  not evaluated on a guess. A position stale for over 5 min is valued 0 for the stops.
- Start-of-day baseline = the higher of the last equity seen and the first observation of
  the day (root rule: an overnight gap down counts against today).
- A withdrawal lowers the day baseline and the peak by the amount withdrawn. Any other
  balance increase without a matching fill halts entries until the owner confirms it.
- Clock moving backwards across a day boundary halts (root rule).

## 5. The 5% cost rule: exactly what it counts

cost_bps = 10,000 x (sum of the items below) / position size. Entry only if cost_bps <= the
cost rule. The same estimate at 2x costs is logged for every intent but does not gate it.

| Item | Counted as |
|---|---|
| Venue fees, both legs | current on-chain fee config: buy on the input, sell on expected proceeds at an unchanged price |
| Price impact, both legs | exact venue math on current reserves at the intended size, our own buy included in the exit quote |
| Adverse slippage allowance | 1.0% per leg (P) until our own fills are measured, then their p75 |
| Network fees | (5,000 x signatures + clamped priority estimate + tip) x expected attempts 1 / (1 - p_fail), per leg |
| Jupiter platform fee | only if the route is `/order` (never for tokens under 24 h) |
| Token-account rent | ATA rent x 10% (P: the chance the account is never closed) |
| Rent that is never recovered | 100%: any account the venue creates for us and keeps (UNVERIFIED for pump's user volume account), and the full rent for policies that keep a moonbag |
| Extra sells | one full transaction cost per planned partial sell |
| Not counted | FOMO's fee (we never trade through FOMO); the wSOL helper rent (opened and closed in the same transaction); taxes |

Honest note: pump.fun and PumpSwap trades start at about 2.5% in venue fees alone, so with
1% slippage per leg they sit near 4.5%; in busy conditions they fail the rule.

## 6. Sizing order (risk/)

1. Blocked first: kill, halt, pause, daily stop, open breakers, strategy mode, cooldowns,
   token already held, entries-per-day count, launch room.
2. size = lowest of: 10% x equity; 0.06 SOL; exposure room (percent and absolute); launch
   room; 0.5% x pool liquidity; free SOL minus fee reserve, rent and fees.
3. Live ramp: half of that for a strategy's first 20 live trades. `sizeHint: 'min'` uses
   the minimum trade.
4. If the result is below the minimum trade: reject. If that is because 10% of equity is
   below the minimum, stop all entries and tell the owner once.
5. The planner builds the plan for that size; risk re-checks the plan (spend, minOut,
   slippage, fees, cost rule) and only then issues the single-use approval token bound to
   the plan hash. Confidence never raises a size; agreeing strategies only add reasons.

## 7. Cooldowns (P)

3 losing trades in a row pause that strategy 2 h; 6 losing trades in a day switch it off
until 00:00 Athens. No re-entry into a token for 6 h after any exit; never after an
emergency or rug exit (its creator is blocklisted too). After a halt clears: 15 min of clean
data before entries; after a breaker closes: 5 min.

## 8. Circuit breakers

All of them stop entries only; exits continue. Every trip and clear is logged and alerted.

| Breaker | Trips when | Stops | Clears |
|---|---|---|---|
| DATA_STALE | no slot notification for 5 s; RPC context more than 150 slots behind | all entries | 60 s healthy |
| FOMO_SIGNAL | an anchor under 30% of its hour-of-day baseline for 10 min; marker/signer or fee/marker ratio moved over 20%; WS coverage under 80% | crowdflow | 30 min at 70% of baseline (paper); owner tap (live) |
| DECODE | decode rate 20 points below baseline for 10 min | crowdflow | 30 min normal |
| RPC_ERRORS | errors over 20% in 2 min, or a P0 request denied | all entries | 5 min clean |
| PROVIDER_BLOCKED | HTTP 403 | all entries | retry after 15 min |
| PRICE_DIVERGENCE | reserve price vs Jupiter over 3% for 2 min | that token | 5 min agreement |
| VENUE_CHANGED | program redeploy, unknown discriminator or account size, fee layout change | that venue | self-test passes 30 min (paper); owner tap (live) |
| CLOCK | drift over 2 s (over 10 s: HALT) | all entries | drift under 1 s for 5 min; HALT: owner |
| SEND_FAILURES (live) | 3 failed landings in a row for a strategy; 5 across strategies in 1 h | that strategy to paper; all live entries | owner |
| RECONCILE_MISMATCH (live) | any token amount mismatch, or SOL difference over 0.0005 SOL unexplained | HALT | owner at the server (`fomo reset-halt`) |
| UNEXPECTED_BALANCE | SOL or token balance change without a matching fill or confirmed withdraw | HALT | owner at the server |
| DISK_DB | free space under 300 MB, a failed write, corruption | HALT entries | owner |
| TELEGRAM_DOWN | owner channel unreachable 30 min (decision 7) | all entries | 5 min reachable |
| RESOURCES | event-loop lag over 5 s for 30 s; over 3 restarts in 30 min | all entries | 10 min normal |

Persistent flags: KILL (set by `fomo kill`, Telegram /kill, or the kill sentinel file
`data/run/KILL`; checked before every order, in the executor and, live, in the signer;
cleared only by the owner at the server with `fomo reset-halt --clear-kill`), HALT (reasons
listed; cleared at the server, or by /resume for the peak halt per decision 4), PAUSE
(Telegram), DAILY_STOP (00:00 Athens).

## 9. Exits are always allowed

Reduce-only sells are approved under kill, halt, pause, daily stop and every breaker. They
still need a quote no older than the freshness rule (or protective mode after 60 s of
staleness), a sell amount no larger than the holding, and the slippage cap (10% emergency).
The fee reserve pays for them; the budget governor never sheds them. /panic sells every
position within the emergency cap, then pauses. A position that cannot be sold for 5 min
is marked stuck and valued 0; live, the owner gets manual steps.

## 10. Live ramp and auto-demote

- Phase 8 starts with one minimum-size buy and sell on a deep-liquidity token, only with the
  owner's explicit OK in chat, to verify the live path and cost accounting.
- Each strategy's first 20 live trades are at half size.
- Auto-demote to paper and notify the owner when any of these holds:
  - after 30 live trades, live expectancy after all costs is below zero;
  - from 20 live trades, the live mean PnL per trade is below the shadow-paper mean for the
    same signals by more than 2 percentage points, or below the 5th percentile of the
    shadow mean's bootstrap distribution (P);
  - one trade loses more than the hard stop plus 10 points (execution failure) (P);
  - SEND_FAILURES trips for that strategy.
- A demoted strategy returns to live only through a fresh gate and a new Go live tap.

## 11. Go-live gate (per strategy)

All must hold; they can be tightened, never loosened without the owner:
1. At least 50 closed paper trades over at least 7 days, at least 30 of them on the current
   config version (P).
2. Positive expectancy after all costs; profit factor at least 1.2; paper max drawdown
   within -40%; bootstrap confidence interval reported honestly.
3. Positive expectancy in the 2x-cost shadow ledger.
4. Mean PnL per trade above the 95th percentile of the random-entry distribution (at least
   200 seeded resamples of the twins).
5. The number of config versions tried during the paper period is reported; more than 5
   versions means at least 100 trades are required (P, multiple-testing guard).
6. Data health: FOMO stream coverage at least 90% of the period (crowdflow); trades made
   while a breaker was open are reported separately.
7. No open critical or high issues; current risk-guardian and security-auditor sign-offs.
8. Live preconditions: second data provider (decision 3), signer container, signed
   go-live checklist, `FOMO_LIVE=true`, `fomo arm-live` at the server TTY.
9. The owner reads a plain-English Telegram summary and taps the single Go live button.

## 12. Bounds for /set and AI proposals

AI rules: only the parameters marked AI; risk parameters only in the safer direction; at
most 25% relative change per proposal; at most 3 proposals per review; at most one approved
change per parameter per 7 days; every change is a new config version (/rollback restores
the previous one). Never via /set or AI: a mode to live, HARD_CAPS, withdraw address,
providers, tips, the AI's own cap or model (the owner may /set the model).

| Parameter | /set bound | AI |
|---|---|---|
| risk: tradePct [1%, 10%], openPositions [1, 4], exposurePct [10%, 50%], entriesPerDay [1, 12], costRule [2%, 5%], poolShare [0.1%, 0.5%], priceCrossCheck [1%, 5%] | as listed | lower only |
| risk: dailyStop [5%, 30%], peakHalt [10%, 50%], buySlippage [0.5%, 3%], sellSlippage [1%, 5%] | as listed | tighter only |
| risk.landingSpend | [0.05%, 0.3%] | yes |
| crowdflow: minDistinctBuyers5m [3, 50]; maxTopBuyerShare, maxSameSlotShare, maxIdenticalSizeShare [10%, 60%] each; minAcceleration [0%, 500%]; maxRun15m [10%, 200%]; minCompleteness [30%, 90%] | as listed | yes |
| momentum: minAge [24 h, 30 days]; pullback [5%, 40%]; minLiquidity [20, 2,000] SOL | as listed | yes |
| launch: minHolders [20, 500]; maxTop10Share [10%, 50%]; maxCreatorShare [0%, 10%]; curveProgressWindow within [10%, 90%] | as listed | yes |
| exits: hardStop [10%, 40%]; takeProfit [20%, 300%]; trail [10%, 50%]; timeStop [5, 240] min; timeStopMinGain [0%, 20%] | as listed | yes |
| exits.livePolicy | tournament winner only | proposal only, needs the test in section 13 |
| ai.model | haiku-5-5 or sonnet-5-5 | no |

Default values for strategy parameters are placeholders in git; tuned values live only in
the database (D2).

## 13. Exit-policy change test

A strategy's live exit policy changes only through an approved proposal, and only if the
challenger beats the incumbent on the same entries: at least 40 shared entries, and the 90%
bootstrap confidence interval (10,000 resamples, seeded) of the per-trade PnL difference
after costs lies entirely above zero, at both 1x and 2x costs (P).

## 14. Withdraw policy

- Live only. SOL only (sell tokens first). Destination: the single `withdrawAddress` in the
  server file (read-only mount, validated as a 32-byte on-curve public key, not the bot's
  wallet). It cannot be changed from Telegram; a changed address is announced in Telegram
  and blocks withdrawals for 24 h (P).
- `/withdraw <amount|all>`: "all" means all SOL above the fee reserve and rent needs when
  positions are open, and the whole balance minus the network fee when none are.
- Shows amount and the abbreviated address; needs a Confirm tap within 60 s; one pending at a
  time; passes the risk engine as a WithdrawIntent; the signer allows a System transfer only
  to that exact address. Allowed during halt and kill (it only reduces risk).

## 15. Invariants to property-test (fast-check)

1. No order executes without exactly one approved decision and a consumed, unexpired token
   whose plan hash matches; a token never works twice or for another intent.
2. Every buy satisfies limits 1-8 and 11 at approval time, for any portfolio, equity and
   price inputs; open positions <= 4; one position per mint.
3. After any buy, SOL >= fee reserve. Reserve math never underflows.
4. No buy is approved while kill, halt, pause, daily stop, a blocking breaker or mode off
   applies; a valid reduce-only sell is always approved.
5. Sell amount <= held amount; balances never negative.
6. Ledger conservation (paper exact): starting SOL + sum of fills - sum of cost lines =
   current SOL; cost basis = sum of the position's buy-side cost lines.
7. All amounts are bigint, non-negative, at most 2^64 - 1; no NaN or Infinity anywhere a
   size is computed; SQLite TEXT round-trips exactly.
8. Venue math: output never exceeds the reserve; monotone in input; amount_in is the exact
   inverse; fees round in the venue's favour; minOut <= expectedOut.
9. The cost estimate at 2x is >= the estimate at 1x; the 2x shadow PnL <= the 1x PnL for
   every trade.
10. Rent is refunded only after a 100% sell plus close.
11. Every effective config value is within HARD_CAPS and its bounds; any accepted change
    creates a version; rollback restores the previous version exactly.
12. The only SOL transfer to a non-tip address is the withdraw, to the configured address.
13. Replaying the same event stream (with duplicates and reordering) yields the same intents
    and orders, never more.
14. Day roll happens at 00:00 Europe/Athens on DST days too; a backwards clock halts.
15. Non-owner Telegram updates never change state; validated AI proposals are always inside
    their bounds and direction rules.
16. Sizing never exceeds any single cap, and more equity or liquidity never lowers a cap.
