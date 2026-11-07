# Feasibility: what this bot can realistically do on $5-10 a month

Phase 0 result, 2026-11-06. Every number comes from `docs/VERIFIED_FACTS.md` and the
research notes in `docs/research/`. Nothing here is a performance claim: no strategy has
been tested, and none has a proven edge.

## Bottom line

- **The FOMO signal is real and free to watch.** Every FOMO trade carries one unique
  on-chain marker, so a single free data stream sees all ~650,000 FOMO trades a day
  within seconds. Only about half of them can be decoded (who, what, buy or sell)
  without paying for more data.
- **Costs are the hard part.** A $3-5 trade on pump.fun or a freshly graduated coin
  costs about **4.5-4.7% per round trip**: 1.25% venue fee each way, about 1% slippage
  each way (assumed, not yet measured), plus network fees. So every trade has to gain
  about 5% just to break even. Bigger trades don't fix this, because fees and slippage
  grow with size. Mature tokens on cheaper pools cost about 2.6%.
- **Running cost fits the budget:** about $4.40-8.40 a month (server $4.30-8.30 with
  Greek VAT, data and alerts $0, AI review about $0.05).
- **Honest expectation:** the most likely result of paper testing is that no strategy
  passes its go-live gate. That is a good outcome for a test that costs only the
  server: it would mean the pipeline did its job and kept your money.
- **The two strongest candidates to test are FOMO crowd flow and momentum on mature
  tokens.** Copy-trading individual FOMO users has the weakest edge case and the biggest
  terms-of-service problem.

## 1. What one trade really costs

Round trip = buy, then sell everything and close the token account. Assumptions: 1%
adverse slippage per side (not measured yet; each extra 1% per side adds about 2%),
priority fee capped at 30,000 lamports, Helius SWQOS-only tip of 5,000 lamports, SOL
about $90 (LOW confidence).

| Venue | Fees, round trip | Slippage | Network | Total, 0.03 SOL (~$2.70) | Total, 0.05 SOL (~$4.50) |
|---|---|---|---|---|---|
| pump.fun curve, or PumpSwap below 420 SOL market cap (1.25% per side) | 2.46% | 1.97% | 0.07-0.27% | **4.5-4.7%** | **4.5-4.6%** |
| Same, busy network without a cap (150k-lamport priority + tip, per the venues note) | 2.46% | 1.97% | 1.10% | 5.5% (fails the 5% rule) | 5.1% |
| Mature pool, Raydium CPMM 0.25% | 0.49% | 1.99% | 0.07-0.27% | 2.6-2.8% | 2.5-2.6% |
| Any of the above through Jupiter `/order`, token under 24 h old | +1.0% | | | +1.0% | +1.0% |
| Any trade via a 0.001 SOL "MEV-protected" sender | | | +6.7% / +4.0% | not allowed | not allowed |

Other costs that do not show in that table:
- **Token-account rent:** about 0.0015 SOL per new token, which is 5% of a 0.03 SOL
  position. It comes back only after selling everything and closing the account. A
  moonbag keeps it locked: a 50% + 40% + 10%-moonbag exit costs 9.4-10.9% on pump.fun
  once the locked rent is counted. **No moonbags at this size.**
- **Failed attempts** still pay network fees (0.02-0.6% each). 72% of the transactions
  touching pump.fun fail, mostly competing bots; our own failure rate is unknown.
- **Launch fees on Meteora's bonding curve** can be up to 99% (anti-sniper schedules):
  read the pool's current fee before every buy, or skip those pools.

## 2. Data and running costs

| Item | Choice | Per month |
|---|---|---|
| Server | netcup VPS nano, Nuremberg (2 GB; 6-month minimum, about EUR 23 up front), or Hetzner CX23 (4 GB; monthly, cancel any time) | ~$4.30 or ~$8.30 incl. 24% VAT |
| FOMO trade stream | Public Solana websocket: free and unmetered, but "not intended for production" and can block us without notice | $0 |
| Everything else on-chain | Helius Free (about 27% of its 1M monthly credits without the FOMO stream) | $0 |
| Prices, trending | Jupiter Price v3, GeckoTerminal, DexScreener (free tiers) | $0 |
| Dead-man heartbeat | Healthchecks.io free plan | $0 |
| Telegram | Bot API, long polling (no open ports) | $0 |
| Daily AI review | Claude Haiku 5.5, one call a day | ~$0.05-0.10 |
| **Total** | | **~$4.40-8.40** |

Not free: streaming the FOMO trades through Helius would cost about 2.8x its free plan,
because Helius bills websockets by data volume (2 credits per 0.1 MB). Alchemy's free
tier could carry the stream as a fallback, but it would use about 92% of its month.
Paid data (Helius Developer $49, LaserStream $499) is far outside the budget.

## 3. Strategy by strategy

### 3.1 Copy top FOMO traders
- **Data:** feasible. One websocket subscription per followed wallet: about 4 wallets on
  the public endpoint, about 50 on Helius Free at about 2% of its credits. Finding
  wallets: decode a 1-2% sample of FOMO trades, then back-fill a candidate's history
  (about 200 credits per wallet).
- **Who we would copy:** retail. Median FOMO trade $9.54; users pay FOMO a median 1.75%
  fee plus two or more pool hops. We act after their trade confirms (at least one
  block) plus our own detection and landing time.
- **Edge:** low. Few retail wallets have a lasting edge, and most of what they have
  disappears with our delay and a 4.5% round-trip cost. The copyability score will
  probably reject almost everyone.
- **Terms:** FOMO's terms (s.16) ban "Reverse look-up, track, or seek to track any
  information on any other user". Tracking specific FOMO users, especially wallets found
  through FOMO profiles in the app, is the most exposed part of this project if you hold
  a FOMO account. This is not legal advice; see question 1.
- **Verdict:** technically possible at $0, weakest case for an edge, highest terms risk.
  Don't build it first.

### 3.2 FOMO crowd flow
- **Data:** feasible at $0. One public-websocket subscription to the FOMO marker sees
  every trade (4.6 GB/day). Logs alone give user and side for 58% of trades and the token
  for 64% (after one cached pool lookup each), mostly pump.fun and PumpSwap trades. So
  the signal is biased toward pump-family tokens and needs a completeness score.
- **Edge:** unproven, but the most FOMO-specific idea: on a social app, early
  accelerating buying may precede a wider crowd. The opposite is also plausible: the
  crowd buys tops, and we would be buying from them.
- **Risks:** the free websocket may drop or block us; FOMO can change its signer or marker
  any day (the bot must then stop, not guess); half the trades can't be decoded.
- **Verdict:** the best candidate to test, and the cheapest to forward-record and paper
  trade. Probability of a real edge: low to medium.

### 3.3 Smart launch sniping (second wave)
- **Data:** discovery by polling GeckoTerminal and Jupiter plus pump.fun's mint
  authority (about 13% of Helius credits). Streaming launchpad programs is out of reach
  ($0 budget; PumpSwap alone is ~94 GB/day). Discovery will be incomplete.
- **Safety:** pump.fun coins pass the static checks (no mint or freeze authority)
  automatically. Real losses come from dumps, developer selling and bundles. Bundle and
  creator checks cost 15-30 calls per token, so only for a short list.
- **Edge:** low. The same public metrics are watched by professional bots; reported base
  rates are brutal (about 1 in 58 pump.fun tokens graduates, most trade for one day).
- **Verdict:** keep it last and at the smallest allocation (at most 25% of exposure), as
  the brief says.

### 3.4 Momentum / trending
- **Data:** free trending lists (Jupiter, GeckoTerminal cached 30-60 s, DexScreener) plus
  the FOMO flow.
- **Cost:** mature tokens trade on cheaper pools, so about 2.6-3.6% per round trip: the
  easiest strategy to fit under the 5% rule.
- **Edge:** low to medium. Everyone sees the same lists with the same delay; buying
  pullbacks instead of vertical candles helps a little.
- **Verdict:** cheap to test; a sensible second strategy.

## 4. Biggest risks, most likely first

1. **No edge after costs.** At about 4.6% per round trip on pump-family tokens, every
   trade needs a gross gain above that on average.
2. **The FOMO footprint is unofficial.** Signer, marker, fee account and transaction format
   were found on-chain, not published by FOMO, and can change without notice. The
   health monitor must stop trading when they vanish.
3. **FOMO's terms** (tracking clause), see question 1.
4. **The free websocket is not meant for production** and is the only $0 way to receive
   the full FOMO stream.
5. **Helius's terms** forbid personal or household use (clause xi), see question 3.
6. **This repository is public.** Anyone could read the entry rules and bait the bot,
   for example by staging fake FOMO buying on a token built to pass the safety filter.
   See question 2.
7. **Programs change under us.** pump.fun's programs are upgradeable and changed several
   times in 2026; Token-2022 was redeployed on 2026-10-23. Read fees and account layouts
   from the chain and fail closed on anything unknown.
8. **Solana itself changed recently:** version 1 transactions, ~214 ms slots (a blockhash
   lasts ~32 s), and a new consensus (Alpenglow). Libraries and timeouts must match.
9. **Supply-chain attacks** aimed at Solana developers (key-stealing npm packages, fake
   bot repositories). We pin exact versions, wait 7 days before adopting a release,
   run no install scripts, and avoid the pump.fun SDKs (they pull in old web3.js).
10. **Small capital.** With about 0.55 SOL and 4.6% costs per trade, a run of losers can
    reach the -30% daily stop or the -50% peak stop quickly.

## 5. Conflicts with the root project's rules

The root `CLAUDE.md` and `docs/PLAN.md` (the Python research project) were written
before this brief. Until you decide otherwise, the stricter rule applies:

| Topic | Root project | This brief | Default until you decide |
|---|---|---|---|
| Live memecoin trading | Simulation only until after M6; no live memecoin execution code unless a simulated edge survives 2x costs | Live per strategy after its gate | Paper only; no live sending code before Phase 8 and your explicit OK |
| Capital | EUR 50 total at risk | Bankroll under $50 for this bot | The bot's bankroll counts toward your EUR 50 |
| Memecoin limits | 5% per position (cap EUR 5), 0.5% of pool liquidity, 20% exposure, 3% slippage | 10% per trade, 50% exposure, 4 positions | Brief's numbers as ceilings, plus the root's pool-liquidity cap; you confirm before live |
| Where it runs | Your Windows PC | VPS near Frankfurt | VPS, keyless, for paper; live key only in Phase 8 |
| Claude and the server | Cloud sessions never hold live credentials | Claude may deploy over SSH with permission | You run server commands yourself from the guide; Claude never gets SSH access to a machine holding the live key |
| Testing standard | Every result rerun at 2x costs; must beat random entries | Not mentioned | Apply both to paper results and to the go-live gate |

## 6. What Phase 1 must change in the brief's design

- Detect FOMO trades with the marker account; use the signer and the fee account as
  independent health anchors.
- Read and parse version 1 transactions everywhere (`maxSupportedTransactionVersion: 1`,
  `@solana/kit` 8+).
- Put the FOMO stream on the public websocket, never on Helius.
- Priority fees from the trade's own writable accounts, clamped; tips only via Jito
  (1,000 lamports) or Helius SWQOS-only (5,000); never a 0.001 SOL tip.
- Time out transactions by block height (~32 s).
- Sell 100% and close the token account; drop moonbags at this size, or let the
  exit tournament charge them their locked rent.
- Read venue fees from on-chain fee configs on every run; parse mint bytes ourselves and
  reject unknown Token-2022 extensions.
- Use Jupiter `/build` (no Jupiter fee) for tokens under 24 hours old.
- Decide how to simulate sells in keyless paper mode (simulation needs a funded fee
  payer).
- Toolchain: Node 26.13.0, TypeScript 6.0.3, `node:sqlite` behind one small module,
  grammy, zod 4.6.6+, npm with a 7-day cooldown and no install scripts. Every dependency
  still needs the security-auditor's approval.
- Guardrails: extend the guard hook to `secrets/`, `*.key` and `*.pem` (needs your OK;
  see `docs/REVIEWS.md`).

## 7. Still unproven

Whether any strategy makes money; our real slippage, landing rate and delay; whether
the free websocket survives 24/7; DFlow's program ID; per-trade fee medians on each
venue; everything listed under UNVERIFIED in `docs/VERIFIED_FACTS.md`.

## 8. Questions for the owner

1. **FOMO's terms ban "tracking" other users.** How should we handle copy-trading?
   Recommended: build and paper-test crowd flow and momentum first, without copy-trading
   and without looking wallets up in FOMO profiles. Revisit copy-trading only with
   FOMO's written OK, or if you decide to accept the risk to your FOMO account.
2. **This GitHub repository is public.** Make it private before strategy code is
   written? Recommended: yes. GitHub, repository Settings, General, Danger Zone, Change
   visibility, Private.
3. **Helius's terms forbid personal use.** Start on free public endpoints (no sign-ups),
   and ask Helius by email before relying on it? Recommended: yes; I can draft the email.

**Owner's answers (2026-11-07), recorded in `docs/DECISIONS.md`:** (1) test crowd flow
and momentum first and skip copy-trading; (2) the owner will make the repository
private; (3) paper trading on free public Solana endpoints with no sign-ups, and email
Helius before relying on it (draft: `docs/drafts/helius-terms-question.md`).
