# Risk policy (Phase 1 design)

Every number the risk engine enforces, its kind, and why. Same code for paper and live.
"(P)" = proposed by the architect, **the owner confirms**. Amounts in SOL are bigint
lamports in code. Example sizes assume the paper bankroll of 0.55 SOL (~$50, LOW-confidence
SOL price); the bot's bankroll counts toward the owner's EUR 50 total (FEASIBILITY.md s.5).

## 1. In plain English

- Your numbers are ceilings in the code; config, Telegram and the AI cannot go above them.
  The root project adds stricter safety nets on top, and live uses those until you decide.
- Each trade: at most 10% of the account and 0.06 SOL, at most 4 open, at most 0.5% of the
  pool. Allowed only if its expected total cost is at most 5% (many pump.fun trades fail).
- Selling is always allowed, and money to pay for selling is always kept aside. Going live
  needs paper proof at double costs and against random entries, on settings frozen in advance.

## 2. Kinds of limit

| Kind | Meaning | Who can change it |
|---|---|---|
| H (hard ceiling or floor) | constant in `src/config/caps.ts` (`HARD_CAPS`, `TUNABLE_BOUNDS`, `LIVE_CAPS`) | code change only: owner's OK in chat plus risk-guardian and security-auditor |
| T [min, max] (tunable bound) | versioned DB value; /set and approved AI proposals stay inside [min, max] | owner by /set (confirmed); AI only as section 12 |
| D (default) | starting value of a tunable | as T |

Every tunable, including every strategy and exit parameter in section 12, has its [min, max]
in `TUNABLE_BOUNDS`, and a test asserts max <= its H ceiling (for floors: min >= the H floor).
Rounding: caps and sizes round down; costs, fees and the fee reserve round up.

Paper uses the brief's numbers. Live uses `LIVE_CAPS` (the root's stricter values) until
owner decision 9 (ARCHITECTURE.md s.14): 5% and EUR 5 per position, 20% and EUR 10 (~0.12
SOL) exposure, 5 entries/day, -3% daily, -15% peak, 0.5% of pool. EUR caps are converted at
`arm-live` and each 00:00 Athens (Jupiter SOL/USD, ECB EUR/USD, rounded down); the lower of
the SOL and EUR cap applies; no price means no live entries.

The code enforces this whatever the config says (Phase 2 step 5; REVIEWS.md K, N1, and L):
sizing and the independent limit check clamp every configured cap to its H value (a live
entry: also to `LIVE_CAPS` and today's EUR caps in lamports, and a live entry without them is
refused, `sizing:no-live-price`); the entry blocks count at most 12 entries a day (a live entry
5) and 4 positions; the fee reserve never counts below its H inputs; the day state refuses a
threshold looser than its H value (live: than `LIVE_CAPS`). Two consequences to know before
live: at 5% per trade a live entry needs at least 0.4 SOL of equity at the 0.02 SOL minimum
trade (0.2 SOL at the 0.01 SOL floor), below that all entries stop (s.6 step 4); and the day's
entry count is every entry, paper and live, so paper entries can use up the 5 live ones (never
the other way round; counting per mode needs the owner's OK).

## 3. Limits

| # | Limit | Value | Kind | Source, why |
|---|---|---|---|---|
| 1 | Size per trade | at most 10% of equity (0.055 SOL at 0.55 SOL); size = the swap input; equity for sizing = the lower of start-of-day and current equity, so a mark pumped by someone else never raises sizes | H 10%; T [1%, 10%]; D 10% | brief; stricter sizing equity: reviews 2026-11-09 |
| 2 | Absolute size per position | 0.06 SOL swap input (worst-case spend with rent and every attempt about 0.0617 SOL) | H | root style: holds even if equity is misread (about EUR 5) |
| 3 | Open positions | 4 (opening positions count) | H 4; T [1, 4] | brief |
| 4 | Total exposure | 50% of equity; opening positions count at their maxSpend | H 50%; T [10%, 50%] | brief |
| 5 | Absolute exposure | 0.30 SOL (~EUR 24); live until decision 9: EUR 10 (~0.12 SOL) | H | root style; root memecoin cap |
| 6 | One position per token, no adding to a position | - | H (partial unique index, ARCHITECTURE s.4) | brief, root |
| 7 | Pool share | position at most 0.5% of pool liquidity (liquidity = 2 x real SOL reserve), so 0.055 SOL needs 5.5 SOL real reserve | H 0.5%; T [0.1%, 0.5%] | root: exits must be possible |
| 8 | Launch strategy exposure | at most 25% of the exposure cap (12.5% of equity: one launch position) | H | brief |
| 9 | Daily stop | -30% vs start-of-day equity (00:00 Europe/Athens): no new entries until 00:00; two days in a row: entries wait for /resume (P) | H 30%; T [5%, 30%] | brief; root halts until a manual reset |
| 10 | Peak halt | -50% from the equity peak: entries halted until /resume, which rebases the peak | H 50%; T [10%, 50%] | brief; who may resume: decision 4 |
| 11 | Fee reserve | computed after the buy, new position included (section 3a); buys can never spend it | H floor 0.01 SOL, multiplier 2, retry budget 9 x 3 | brief: exits always affordable |
| 12 | Equity sanity | equity at most 2.0 SOL and at most 3 x the configured bankroll; +50% within 1 h (section 4) | H | root: a bug or unannounced deposit halts |
| 13 | Entries per day | 8 (P); live until decision 9: 5 | H 12; T [1, 12] | root (8 trades/day; memecoin 5) |
| 14 | Cost rule | expected round trip at most 5% (section 5) | H 5%; T [2%, 5%] | brief |
| 15 | Minimum trade | smallest size that meets the cost rule, never below 0.02 SOL (P) | H floor 0.01 SOL | brief |
| 16 | Buy slippage tolerance (minOut) | 2% (P); the plan's minOut is at least expectedOut x (1 - declared slippage), so a plan cannot declare 2% and accept anything | H 3%; T [0.5%, 3%] | root 300 bps |
| 17 | Sell slippage tolerance | 3% normal (P); protective and emergency 10% (the same minOut floor) | H 5% normal, 10% emergency; T [1%, 5%] | root flatten 1000 bps |
| 18 | Landing spend per transaction | priority + tip at most 0.2% of the position (P) for buys and normal exits; CU price at most 200,000 uL/CU (exits 400,000); CU limit 1.2 x simulated, at most 300,000. A protective or emergency exit keeps only the absolute caps (exits are always allowed: at the minimum trade 0.6% could be less than one attempt at the caps). An exit's percentage base is the larger of its expected proceeds and the position's cost basis, so a price collapse cannot forbid every priority fee | H 0.3% (exits 0.6%); T [0.05%, 0.3%] | phase0-execution |
| 19 | Tips | exactly 0 (none), 1,000 (Jito) or 5,000 (Helius SWQOS-only) lamports, never another amount and never a 0.001 SOL service | H | VERIFIED_FACTS s.4 |
| 20 | Data freshness | plan reserves and approval tokens at most 25 slots old; marks: 30 s stale = entries off, 60 s = protective exit | H | root 30 s quote age |
| 21 | Price cross-check | entry only if our reserve price is within 3% of Jupiter Price v3 | H 5%; T [1%, 5%]; D 3% (P) | manipulation guard |
| 22 | Token age | crowdflow 10 min, launch 3 min, momentum 24 h (avoids Jupiter's young-token fee) (P) | H floor 3 min; T [3 min, 30 days] | brief |
| 23 | Curve progress | no new pump-curve entries above 90% progress (P) | H 95%; T [10%, 90%] | graduation timing UNVERIFIED |
| 24 | Token types rejected | unknown Token-2022 extensions; any transfer fee above 0 bps (P, stricter than the research's 100 bps: withheld fees block closing the account); mayhem-mode coins (P); non-SOL quote pools; unsupported venues | H | safety research |
| 25 | Universal hard stop | -35% from cost basis (P) | H 40%; T [10%, 40%]; AI tighter only | brief P1 |
| 26 | Universal time stop | 30 min if under +10% (P) | H 240 min; T [5, 240] min | brief P1 |
| 27 | Moonbags | not allowed live at this size; tournament may test them only when charged their locked rent | H | rent is ~5% of a 0.03 SOL position |
| 28 | Strategy live loss budget | a strategy's cumulative realized live loss over 0.05 SOL (P) demotes it, from its first live trade | H | ramp protection before trade 20 |
| 29 | Paper model floors | p_fail >= 0.20 per attempt; latency >= measured + 2.0 s; competition >= 0.5% per leg | H floors | paper must not flatter |
| 30 | Signer caps (Phase 8) | buys' max-in plus fees <= 0.35 SOL/day; reduce-only sells and closes have their own fee budget per day of (max open positions + max entries per day) x 3,380,000 lamports plus close-account fees, derived from HARD_CAPS and LIVE_CAPS (a test asserts it covers s.3a for both), so the signer never refuses an exit the retry budget allows; all other fees and tips <= 0.02 SOL/day; <= 150 signatures/hour for non-exit transactions; alert at 80% of each cap | H (signer's own copy) | bounds a compromised bot without blocking protective exits |

### 3a. Fee reserve (limit 11), worked out

- One exit attempt at the caps: 5,000 (one signature) + 400,000 uL/CU x 300,000 CU / 10^6
  = 5,000 + 120,000 = **125,000 lamports**.
- Retry budget per position: 9 blockhash windows (~32 s each, ~5 min) x 3 attempts = 27 x
  125,000 = 3,375,000, plus one landed tip of 5,000 = **3,380,000 lamports**.
- Reserve, N = positions including the new one: `max(10,000,000; 2 x sum of p95 exit costs;
  N x 3,380,000 + 1,488,440 wSOL helper rent if any exit needs it)`, rounded up. N = 4:
  13,520,000 + 1,488,440 = **15,008,440 lamports (~0.0150 SOL)**, ~2.7% of 0.55 SOL; N = 3:
  11,628,440; N = 1 or 2: the 0.01 SOL floor.
- Failed-fee budget: at most 3,375,000 lamports of failed exit attempts per position per Athens
  day. A stuck position is re-simulated every 5 min (free) and gets a real attempt only after a
  passing sell simulation while budget remains; then it waits a day, the owner gets steps.
  After 2 Athens days without a successful exit, automatic attempts stop for that position and
  the owner decides, so a stuck position cannot bleed fees below the reserve day after day.

## 4. Equity

- Equity = SOL (paper balance; live min(ledger, chain)) + every open position at its exact
  full-size sell quote after venue and exit network fees (not mid price). Unknown mints (no
  position: spam, address-poisoning dust) never count and are never sold, closed or touched.
- If any position cannot be valued, equity is "unknown": entries are blocked and stops are
  not evaluated on a guess. A position stale for over 5 min is valued 0 for the stops.
  A mark counts only if it quotes exactly the tokens held now (one taken before a partial
  sell is stale). A position with no mark yet, or with a mark stamped in the future (a
  clock problem), is unknown for the stops, never 0, so a restart cannot trip a stop.
  The state machine (src/risk/daystate.ts) evaluates the stops on this separate stop-equity
  and never lets it move the baseline, the peak or the last equity. The day is the
  Europe/Athens calendar day (src/core/day.ts: 23- and 25-hour days included).
- Start-of-day baseline = the higher of the last equity seen and the first observation of
  the day (root rule: an overnight gap down counts against today).
- A withdrawal lowers the day baseline, the peak and the last equity by its amount; a
  confirmed deposit raises all three by its amount. A withdrawal larger than the last known
  equity cannot be real and would wipe the baseline (and with it the daily stop and the peak
  halt), so it fails closed: the engine halts and the owner reconciles. A deposit that would
  pass 2^64 - 1 is refused too. Any other unmatched increase is UNEXPECTED_BALANCE (HALT); the
  owner classifies it at the server. A sanity breach (over 2.0 SOL or 3 x bankroll) halts and
  never moves baseline or peak (root `observe_equity`).
- "+50% in 1 h" (vs equity 1 h earlier): entries pause; the bot re-reads the wallet and
  re-quotes every position from two fresh samples 10 s apart that agree with Jupiter within 3%.
  If fills, confirmed deposits and these verified marks explain the rise, it clears by itself
  and only then may the peak move; otherwise HALT (owner at the server). Until then baseline
  and peak stay put, so real pumps count only once verified. The state remembers the latest
  held observation (its equity and time). A confirmation is only possible for a held jump,
  within five minutes after that observation (never before it; else observe again first), from
  a fresh, fully valued read within the sanity limits, and it records the LOWER of the verified
  level and what the held observation saw, so a confirmation can never vouch for more than was
  observed (and still clears after a pump that collapses, where the verified level is lower).
  For the next hour a rise is measured from the higher of the hour-ago snapshot and that
  record, so the same rise is not held again and again while the snapshot is still from before
  it (a livelock); a further rise of more than 50% above the record holds again.
- Two daily stops on consecutive days set a STICKY halt for the owner: it is reported on every
  observation until the owner's /resume, so a quiet day or a gap in between cannot lift it (the
  streak itself restarts on a gap, the halt does not).
- The owner's /resume has two separate effects, never both at once: after a peak halt the
  peak restarts at the last accepted equity (fully valued and sanity-checked; no caller can
  supply a value, so a tiny wrong one cannot weaken the halt), refused while a jump is held
  or when no equity is known; after a daily stop on two days in a row the halt is lifted and
  the streak starts again. Today's daily stop still holds until Athens midnight.
- A daily stop also holds if the clock then reads an earlier time or day (it stepped back), and
  entries stay blocked while the clock reads earlier than the last observation's day, until the
  next observation reports the clock problem.
- Clock moving backwards across a day boundary halts (root rule). A clock before 1970 or
  after the year 2200 is refused as a clock problem, so a wild clock cannot lock a stored day
  ahead of real time. A clock that jumps forward by a little less (say to 2199) is accepted
  by this module and then every real observation reads as backwards: that fails closed, and
  the guard against it belongs to the clock (contract 8 below).

### Engine contracts for the equity and day state (REVIEWS.md I)

The state machine only reports. Trips are level-triggered (reported on every observation
while they hold), so the engine sets and keeps the persistent flags itself.

1. After every observation, held or not, the returned state is saved in the same SQLite
   transaction as the flags. The stored shape is versioned (T2); a state saved before a
   field existed needs a migration, never a default.
2. HALT on equity-zero, sanity-max, sanity-bankroll and clock-backwards (the stops are
   skipped on those paths). Pause entries on equity-jump and start the verification above.
   daily-stop sets DAILY_STOP and entries stay blocked through dailyStopActive until 00:00
   Athens. daily-stop-twice (state.streakHalt, sticky, reported on every observation) blocks
   entries until the owner's streak restart; peak-halt keeps PEAK_HALT until the owner's peak
   restart. A RiskError from any of these functions turns entries off and alerts the owner.
   Exits always continue. If both equity and stop-equity are null, entries are off. Between
   observations entries are gated by dailyStopActive (which also holds through a clock that
   stepped back) and by the saved flags.
3. confirmEquityJump is called only by the verification routine (or by the owner at the
   server), with the fully valued equity of a fresh read taken by that verification, never the
   held observation itself, and the current clock, within five minutes after the latest held
   observation (observe again first if the verification took longer). No strategy, Telegram
   or AI path can call it. The engine observes again right after it; if no observation lands
   within the hour the hold returns and needs another confirmation.
4. The peak restart runs only on the owner's /resume (live: after the 24 h wait with notice,
   s.12), right after a tick that observed a fully valued equity. The streak restart is a
   separate owner action. Neither runs automatically.
5. applyTransfer is called only for an owner deposit or withdrawal confirmed by its signature,
   in chain order, before the next observation, never for a balance difference or a loss. A
   classification of a held jump waits for it. A deposit of more than 50% holds once, because
   the hour-ago snapshot predates it: resolve it with a confirmation or by adjusting the
   snapshots. If applyTransfer throws (for example a withdrawal while a jump is held and the
   last equity is still the pre-jump value), the engine HALTs and reconciles; the owner's
   withdrawal itself never depends on it and is never blocked or undone because of it.
6. equityAnHourAgo comes from raw, fully valued snapshots recorded by the engine every tick,
   never from an outside value. Null is acceptable only in the first hour after a start; if it
   stays null the +50% check is off, so the engine alerts.
7. By design (as in the root rule) the day baseline does not rise within a day: after a
   verified rise the daily stop still measures from the morning's baseline, and the peak halt
   guards the gains. Across midnight a held jump leaves the day unrolled until it is
   confirmed; the daily stop is not evaluated for the new day meanwhile, the peak halt is.
8. The clock guard (core/clock.ts, with the engine) accepts an observation only when the
   clock agrees with an independent time source, for example the latest block time the RPC
   reports (within about a minute); a reading that does not agree is a halt, not an
   observation. A cap on "days since the last observation" would be wrong, because a restart
   after days of downtime is legitimate. An owner-only day rebase for the case where the
   stored day really is ahead of real time is still to be written (open, before Phase 7).
9. The policy's mode is not checked against anything here (REVIEWS.md L, risk finding 3):
   the live ledger's day state always gets the live policy (`mode: 'live'`, held to
   `LIVE_CAPS`), taken from the same source as the live approval authority's mode, never
   from a strategy, Telegram or the AI.

## 5. The 5% cost rule: exactly what it counts

cost_bps = 10,000 x (sum of the items below) / position size, rounded up. Entry only if
cost_bps <= the cost rule. The same estimate at 2x costs is logged for every intent but does
not gate it.

| Item | Counted as |
|---|---|
| Venue fees, both legs | current on-chain fee config: buy on the input, sell on expected proceeds at an unchanged price |
| Price impact, both legs | exact venue math on current reserves at the intended size, our own buy included in the exit quote |
| Adverse slippage allowance | 1.0% per leg (P) until our own fills are measured, then their p75 |
| Network fees | (5,000 x signatures + priority on the requested CU limit + tip) x expected attempts 1 / (1 - p_fail), per leg |
| Jupiter platform fee | only if the route is `/order` (never for tokens under 24 h) |
| Token-account rent | ATA rent x 10% (P: the chance the account is never closed) |
| Rent that is never recovered | 100%: any account the venue creates for us and keeps (UNVERIFIED for pump's user volume account), and the full rent for policies that keep a moonbag |
| Extra sells | one full transaction cost per planned partial sell |
| Not counted | FOMO's fee (we never trade through FOMO); the wSOL helper rent (opened and closed in the same transaction); taxes |

Honest note: pump.fun and PumpSwap trades start at about 2.5% in venue fees alone, so with
1% slippage per leg they sit near 4.5%; in busy conditions they fail the rule.

## 6. Sizing order (risk/)

1. Blocked first: kill, halt, pause, daily stop, unknown equity (stale marks included) or a
   pending "+50% in 1 h" check (s.4), open breakers, strategy mode (flags table; an entry runs
   in exactly its strategy's mode), cooldowns, token already held or opening, entries-per-day
   count, open positions at the cap, launch room (checked in sizing). All reasons are listed.
2. size = lowest of: 10% x equity; 0.06 SOL (live: `LIVE_CAPS`); exposure room (percent and
   absolute, opening positions at maxSpend, the new position too); launch room; 0.5% x pool
   liquidity; free SOL (minus the maxSpend of buys in flight) minus the fee reserve after
   this buy, rent and the fees of all allowed attempts. Those fees are set aside at the hard
   fee caps (5,000 + 200,000 uL/CU x 300,000 CU + the 5,000 tip = 70,000 lamports per
   attempt), never at the fees the plan declares, so a planner cannot buy a larger size by
   declaring cheaper fees (REVIEWS.md K, N4). The binding cap is logged.
3. Live ramp: half of that for a strategy's first 20 live trades. `sizeHint: 'min'` uses
   the minimum trade (with the ramp on, only if the capped size is at least twice it).
4. If the result is below the minimum trade (the larger of the pool's cost-rule minimum and
   the configured minimum): reject this entry. Only if 10% of equity (live: 5%) is below the
   configured minimum: stop all entries and tell the owner once (a pool's cost rule can
   never stop the bot).
5. Risk re-checks the plan and issues the token in transaction T1 (ARCHITECTURE s.4),
   re-running every cap against open and opening positions. The re-check (src/risk/recheck.ts)
   never trusts the planner. It takes from the engine, never from the plan: the intent id,
   the pool and venue the safety filter approved (SOL-quoted), the position, wallet and own
   token account, risk's own quote of the plan's input (from the venue math) with the slot and
   the fee config it read, the exit intent's urgency and origin, and the cost basis from the
   ledger. It checks: mode, the intent id (a plan carries the engine's, never its own),
   ownership, route, a fresh quote and fee config (25 slots) that are the same ones risk read
   (a planner that declares a cheaper fee or another slot is refused); one buy order per
   position, ever; minOut against the declared slippage on risk's own quote (a planner that
   understates its expected output cannot buy a low minOut) and the buy slippage cap, both
   compared EXACTLY (a floor never rounds down, a cap never rounds up: the CU limit is at most
   1.2 x the simulated units, not its rounded-up value); the CU (a live plan needs a
   simulation), tip and landing-spend caps (limits 18 and 19); backstops that hold whatever
   sizing says (limits 2 and 15 "hold even if equity is misread"): a buy's swap input at most
   0.06 SOL and at least 0.01 SOL, its worst-case spend (input + rent + every attempt) at most
   0.07 SOL (a margin above limit 2's 0.0617; added in review K, loosens nothing); the
   attempts and the worst-case fees against what sizing reserved (buys) or the failed-fee
   budget left (automatic exits, s.3a: no automatic exits once stopped, a passing sell
   simulation, never a worthless sell); the input between the minimum trade and the sized
   amount; a buy only into an opening position; the rent exactly; and the rules for closing the
   account (only a sell of the whole holding, equal in the ledger and on chain, may close in
   the same transaction; a standalone close has no swap). Exits also run the reduce-only rules
   of s.9 on the same plan snapshot. A plan that passes becomes a CheckedPlan, the only thing a
   token can be issued for. The token (src/risk/approval.ts) binds plan hash, mode, kind,
   worst-case spend, minOut and an expiry slot <= quote slot + 25 under an HMAC; it works
   once, in one mode (an authority serves one mode), and the executor builds its transaction
   from the frozen plan that redeem returns. One re-check gives at most one token: issuing
   spends the plan's checked status, so a second order for the same plan needs its own
   re-check against fresh inputs. Confidence never raises a size.
   The approval step (src/risk/approve.ts) puts steps 1-5 together, in this order, on ONE
   snapshot of the world that the engine re-reads inside the T1 transaction: the entry blocks,
   sizing, the plan re-check, an independent check of the hard limits from the plan's own
   worst-case numbers, then the token. It counts every opening, open, exiting and stuck
   position (for the position cap, the exposure caps and one position per mint, and in the fee
   reserve, where the new position joins them), holds back the SOL that buys in flight will
   still spend before computing the free SOL (invariant 17), sizes from the lower of
   start-of-day and current equity, and blocks on unknown equity before sizing. It returns the
   opening position (at its worst-case spend) and the day's new entry count for the engine to
   write in the same transaction; any throw is a refusal. approveExit has no flag input at all:
   a valid reduce-only exit is always approved (s.9), and it issues tokens for sells and
   closes only. It is a thin wrapper: every exit fact (exits in flight, holdings, the intent
   id, the quote) comes from the caller, so the transaction around it must re-read them inside
   the transaction. The approval step passes "no earlier buy order" for a new position only
   because the position is new: the partial unique index on positions(mint) stays in T1. Its
   caps come from the config and are clamped to the hard values (s.2): once by the approval
   step itself and again inside sizing and the independent limit check, so one forgotten
   clamp cannot loosen a limit. The re-check's backstops hold on top.

## 7. Cooldowns (P)

3 losing trades in a row pause that strategy 2 h; 6 losing trades in a day switch it off
until 00:00 Athens. No re-entry into a token for 6 h after any exit; never after an
emergency or rug exit (its creator is blocklisted too). After a halt clears: 15 min of clean
data before entries; after a breaker closes: 5 min.

## 8. Circuit breakers and flags

All breakers stop entries only; exits continue. Every trip and clear is logged and alerted.

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
| RECONCILE_MISMATCH (live) | any token amount mismatch, or unexplained SOL differences over 0.0005 SOL cumulative since the last owner reset | HALT | owner at the server (`fomo reset-halt`) |
| UNEXPECTED_BALANCE | SOL or held-mint balance change without a matching fill, withdraw or confirmed deposit; equity jump not explained (section 4) | HALT | owner at the server |
| PAPER_LEDGER | paper conservation check (invariant 6) fails after a trade | HALT | owner |
| DISK_DB | free space under 300 MB, a failed write, corruption | HALT entries | owner |
| TELEGRAM_DOWN | owner channel unreachable 30 min (decision 7) | all entries | 5 min reachable |
| RESOURCES | event-loop lag over 5 s for 30 s; over 3 restarts in 30 min | all entries | 10 min normal |

Persistent flags: KILL (set by `fomo kill`, Telegram /kill, or the sentinel file
`data/run/KILL`, which only ever sets KILL: deleting it never clears it; checked before every
order and attempt, in the executor and, live, in the signer; cleared only by the owner at the
server with `fomo reset-halt --clear-kill`), HALT (reasons listed; cleared at the server, or
by /resume for the peak halt per decision 4), PAUSE (Telegram), DAILY_STOP (00:00 Athens),
strategy modes (off, paper, live).

Buys in flight: these flags and blocking breakers are re-checked before every paper attempt
and live resend. If set, paper stops (order failed, fees so far charged) and live stops
resending, lets the blockhash expire and reconciles; a new attempt needs a new approval.

## 9. Exits are always allowed

Reduce-only exits are approved under kill, halt, pause, daily stop and every breaker, only
if: kind `sell` or `close-account`; input = the position's mint, output = SOL; inAmount <=
sellable (min(ledger, chain) holding minus in-flight sells); one in-flight exit per position;
tokens only from our own token account and SOL only to our own wallet (sells and closes);
`close-account` only of our own token account, empty on chain and in the ledger (status
exiting, no sell in flight). A reduce-only token never authorizes a buy. Every exit needs a
fresh quote: after 60 s of stale marks an exit turns protective, which means it sells at the
next fresh quote within the 10% cap, never on an old price. Slippage cap: normal 1% to 5%,
protective and emergency from the normal cap to 10%. The fee reserve pays and the governor
never sheds them. An exit is either owner-ordered (an authenticated /panic or /sell: not
budget-limited, its fees still recorded) or automatic (bound by the failed-fee budget of
s.3a, the 2-day stop, a passing sell simulation, and never a sell that expects nothing). Its
urgency is the exit intent's: a plan cannot label itself emergency.
Exit intents are keyed by (position, exitSeq), so a failed exit is always re-issued. /panic
sells every position within the emergency cap, then pauses. A position unsellable for 5 min
is stuck, valued 0, and retries per section 3a; live, the owner gets manual steps.

## 10. Live ramp and auto-demote

- Phase 8 starts with one minimum-size buy and sell on a deep-liquidity token, only with the
  owner's explicit OK in chat. Each strategy's first 20 live trades are at half size.
- Auto-demote to paper and notify the owner (checked after every closed live trade) when:
  - from the 30th live trade on, live expectancy after all costs is below zero;
  - from 20 live trades, the live mean PnL per trade is below the shadow-paper mean for the
    same signals by more than 2 percentage points, or below the 5th percentile of the
    shadow mean's bootstrap distribution (P);
  - the strategy's cumulative realized live loss exceeds its loss budget (limit 28), from
    the first trade;
  - one trade loses more than the hard stop plus 10 points (execution failure) (P);
  - SEND_FAILURES trips for that strategy.
- A demoted strategy returns to live only through a fresh gate and a new Go live tap.

## 11. Go-live gate (per strategy)

All must hold (tighten freely, loosen only with the owner). Every statistic uses only paper
trades taken after the strategy's signal parameters, exit policy and the paper model were
frozen; changing any of them restarts the count.
1. At least 50 such closed paper trades over at least 7 days (P), all with the paper model at
   or above its floors (limit 29).
2. Positive expectancy after all costs; profit factor at least 1.2; paper max drawdown
   within -40%; bootstrap confidence interval reported honestly.
3. Positive expectancy in the 2x-cost shadow ledger.
4. Mean PnL per trade above the 95th percentile of the random-entry distribution (at least
   200 seeded resamples of the twins).
5. Trials: every config version and every exit policy evaluated during the paper period
   counts as a trial. The deflated Sharpe ratio using the total trial count is reported
   (root rule); more than 5 trials means at least 100 frozen trades (P).
6. Data health: FOMO stream coverage at least 90% of the period (crowdflow); trades made
   while a breaker was open are reported separately.
7. No open critical or high issues; current risk-guardian and security-auditor sign-offs.
8. Live preconditions: second data provider (decision 3), signer container, signed
   go-live checklist, `FOMO_LIVE=true`, `ops/arm-live.sh` at the server TTY (bot and signer).
9. The owner reads a plain-English Telegram summary and taps the single Go live button.

## 12. Bounds for /set and AI proposals

AI: only parameters marked AI; risk, safety, anti-sybil and `exits.hardStop` only safer; at
most 25% relative change, 3 proposals per review, one approved change per parameter per 7
days; every change is a new config version (/rollback restores the previous one). Never via
/set or AI: a mode (flags table; only /golive sets live), HARD_CAPS, withdraw address,
providers, tips, the AI's own cap or model (the owner may /set the model). Paper model: /set
only more pessimistic, AI never. Live: any unsafe-direction /set or approval, and /resume,
applies after 24 h with an immediate Telegram and email notice (ARCHITECTURE s.8). /rollback
is compared field by field like /set: every field it would move in the unsafe direction waits
24 h the same way; safer fields apply at once.

| Parameter | /set bound | AI |
|---|---|---|
| risk: tradePct [1%, 10%], openPositions [1, 4], exposurePct [10%, 50%], entriesPerDay [1, 12], costRule [2%, 5%], poolShare [0.1%, 0.5%], priceCrossCheck [1%, 5%] | as listed | lower only |
| risk: dailyStop [5%, 30%], peakHalt [10%, 50%], buySlippage [0.5%, 3%], sellSlippage [1%, 5%] | as listed | tighter only |
| risk.landingSpend | [0.05%, 0.3%] | yes |
| crowdflow: minDistinctBuyers5m [3, 50]; minCompleteness [30%, 90%] | as listed | raise only |
| crowdflow: maxTopBuyerShare, maxSameSlotShare, maxIdenticalSizeShare [10%, 60%] each | as listed | lower only |
| crowdflow: minAcceleration [0%, 500%]; maxRun15m [10%, 200%] | as listed | yes |
| momentum: minAge [24 h, 30 days], minLiquidity [20, 2,000] SOL / pullback [5%, 40%] | as listed | raise only / yes |
| launch: minHolders [20, 500] / maxTop10Share [10%, 50%], maxCreatorShare [0%, 10%] / curveProgressWindow within [10%, 90%] | as listed | raise only / lower only / yes |
| exits: hardStop [10%, 40%] / takeProfit [20%, 300%]; trail [10%, 50%]; timeStop [5, 240] min; timeStopMinGain [0%, 20%] | as listed | tighter only / yes |
| paper: pFail [20%, 95%], extraLatency [2 s, 10 s], competition [0.5%, 3%] per leg | raise only | no |
| exits.livePolicy | tournament winner only | proposal only, needs the test in section 13 |
| ai.model | haiku-5-5 or sonnet-5-5 | no |

Strategy defaults are placeholders in git; tuned values live only in the server file and the
DB (D2). If the repository is still public before Phase 8, the exact emergency-trigger values
(reserve drop, price jump, re-probe interval, Jupiter divergence) become placeholders in code
and these docs, with the real values in the server file.

## 13. Exit-policy change test

A strategy's live exit policy changes only through an approved proposal, and only if the
challenger beats the incumbent on at least 40 shared entries: the 90% bootstrap interval
(10,000 seeded resamples) of the per-trade PnL difference after costs lies entirely above
zero at 1x and 2x costs (P). The change demotes the strategy and restarts its gate count.

## 14. Withdraw policy

- Live only (paper has no WithdrawIntent path; the executor refuses one). SOL only. To the
  single `withdrawAddress` in the server file (read-only, a 32-byte on-curve public key, not
  the bot's wallet), pinned again in the signer's policy file; not changeable from Telegram;
  a changed address is announced in Telegram and blocks withdrawals for 24 h (P).
- `/withdraw <amount|all>`: amount = decimal SOL string matching `^[0-9]{1,10}(\.[0-9]{1,9})?$`,
  converted to lamports by integer string arithmetic (no float, exponent or sign), else
  rejected. Capped at free SOL minus the fee reserve and rent needs when positions are open,
  and at the whole balance minus the network fee when none are.
- Shows amount and the abbreviated address; needs a Confirm tap within 60 s; one pending at a
  time; passes the risk engine as a WithdrawIntent; the signer allows a System transfer only
  to that exact address. Allowed during halt and kill (it only reduces risk).

## 15. Invariants to property-test (fast-check)

1. No order executes without exactly one approved decision and a consumed token whose plan
   hash, mode and kind match and whose expiry slot has not passed; a token never works twice,
   for another intent, or in the other mode.
2. Every buy satisfies limits 1-8, 11 and 13-24 at approval time, for any portfolio, equity
   and price inputs; open plus opening positions <= 4; one position per mint.
3. After any buy, SOL >= the fee reserve computed after that buy. Reserve math never underflows.
4. No buy is approved while kill, halt, pause, daily stop, a blocking breaker or mode off
   applies; a valid reduce-only exit is always approved.
5. Sell amount <= sellable; the sum of in-flight sells <= holding; balances never negative.
6. Ledger conservation (paper exact), checked after every operation: starting SOL + sum of
   fills - sum of cost lines = current SOL; cost basis = the position's buy-side cost lines
   plus failed-order fees minus the basis released by sells; realized PnL = sale proceeds +
   rent refunded - exit fees - basis released; tokens held = bought - sold.
7. All amounts are bigint, at most 2^64 - 1, non-negative except signed PnL (`realized`); no
   NaN or Infinity anywhere a size is computed; SQLite TEXT round-trips exactly.
8. Venue math: output < reserve; monotone; exact inverse; venue-favoured fees; minOut <= expectedOut.
9. The cost estimate at 2x >= at 1x; the 2x shadow PnL <= the 1x PnL for every trade.
10. Rent is refunded only after a 100% sell plus close.
11. Every effective config value is within HARD_CAPS and its bounds; every TUNABLE_BOUNDS max
    <= its H; each accepted change creates a version; rollback restores the previous exactly.
12. The signer signs nothing outside its policy (THREAT_MODEL s.5): SOL leaves only to the
    own wSOL ATA (closed in the same transaction), an allowlisted tip <= 5,000 lamports, or
    the pinned withdraw address; its caps hold under any request sequence.
13. Replaying the same event stream (with duplicates and reordering) yields the same intents
    and orders, never more; a failed or expired exit always yields a new exit intent.
14. Day roll happens at 00:00 Europe/Athens on DST days too; a backwards clock halts.
15. Non-owner Telegram updates never change state; validated AI proposals are always inside
    their bounds and direction rules; the AI never changes the paper model.
16. Sizing never exceeds any single cap, and more equity or liquidity never lowers a cap.
17. Opening positions and pending orders count toward every cap: no interleaving of concurrent
    approvals exceeds a cap; at most one in-flight order per mint.
18. Caps and sizes round down; costs, fees and the reserve round up.
19. A reduce-only token never authorizes a buy, only its position's mint into SOL.
20. Withdraw <= free SOL minus the reserve (positions open); impossible in paper.
21. KILL, HALT, PAUSE or daily stop set during a buy: no further attempt or resend.
22. Withdraw lowers and a confirmed deposit raises baseline and peak by exactly the amount; a
    sanity breach never moves them; unknown mints never enter equity or a plan.
23. Shadow, twin and tournament ledgers can never build an OrderPlan or obtain a token.
24. No config operation except /golive ever produces a live mode (/set, /approve, /rollback,
    AI proposals, restarts, migrations).
