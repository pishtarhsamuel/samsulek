# Phase 0 research: FOMO on-chain signal

Researcher: `researcher` (Claude, cloud sandbox). Date checked: 2026-11-04 (live chain reads 00:45-09:12 UTC; FOMO terms and the Bitquery page read at 09:04 UTC after the owner opened those hosts). Blocked for me: lite-api.jup.ag and api.jup.ag (proxy 403); per the main session also docs.anza.xyz, solscan.io, spl.solana.com, github.com web pages, mainnet.helius-rpc.com (solana.com answered 429). Not retried at the end (stopped early on the coordinator's instruction).

All live reads went to the public endpoint https://api.mainnet-beta.solana.com, read-only, 313 calls in total. Raw data and scripts: scratch dir only (not in the repo).

## Facts

| # | Fact | Value | Source URL | Checked | Confidence | How confirmed |
|---|---|---|---|---|---|---|
| 1 | FOMO signer still active | AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51: newest tx 00:45:46 UTC (about 1 s before the reply) and again 09:01:20 UTC | https://api.mainnet-beta.solana.com | 2026-11-04 | HIGH | live getSignaturesForAddress, slots 465105131 and 465244030 |
| 2 | Signer tx rate, failures | 8.79 tx/s, 0.94% failed (00:36:17-00:45:46 UTC, n=5,000); 4.30 tx/s, 0.47% failed (08:49:42-09:01:20 UTC, n=3,000) | same | 2026-11-04 | HIGH | live getSignaturesForAddress, 8 pages |
| 3 | Fee payer and signers | 113/113 sampled txs: account index 0 (fee payer) = AgmLJ...; exactly 2 signers = AgmLJ... plus the user's wallet; 0/113 use address lookup tables | same | 2026-11-04 | HIGH | live getTransaction jsonParsed, n=113 |
| 4 | Trades are "version 1" txs | 97/97 trade txs are v1; 16/16 non-trades are v0. With maxSupportedTransactionVersion 0 the RPC refuses them: error -32015 "Transaction version (1) is not supported by the requesting client" | same | 2026-11-04 | HIGH | live getTransaction (97 refused, refetched with value 1) |
| 5 | v1 is SIMD-0385 | Helius SDK README: "1 also opts in to v1 (SIMD-0385) transactions" | https://github.com/helius-labs/helius-sdk (README.md @87cb392) | 2026-11-04 | MEDIUM | SDK docs; SIMD text not read |
| 6 | v1 fee fields | v1 message has transactionConfig {computeUnitLimit, heapSize, loadedAccountsDataSizeLimit, priorityFee}; no ComputeBudget instructions; fee = 5,000 lamports x 2 signatures + priorityFee (410,000 = 10,000 + 400,000) | api.mainnet-beta.solana.com | 2026-11-04 | HIGH | live jsonParsed field names; fee arithmetic on 97 txs |
| 7 | FOMO marker account | jitodontfront1111111111111111111TradeonFomo is in 97/97 trade txs (failed ones too) and 0/16 non-trades; it is not an existing account (getAccountInfo null) | same | 2026-11-04 | HIGH | live getTransaction, getAccountInfo |
| 8 | Meaning of "jitodontfront" | Jito: add "any valid Solana public key that starts with `jitodontfront`" to an instruction to request protection from front-running/sandwiching | https://github.com/jito-labs/jito-docs (docs/source/lowlatencytxnsend.md @9b923b8) | 2026-11-04 | HIGH | docs source (clone) |
| 9 | Marker = trades; signer = superset | 500 s window 08:53:00-09:01:20 UTC: signer 2,038 txs; marker 1,826 (100% also signed by AgmLJ...); fee account 1,828 (100% signed by AgmLJ...); marker and fee overlap 1,814; signer txs without marker 212 (10.4%) | api.mainnet-beta.solana.com | 2026-11-04 | HIGH | live getSignaturesForAddress on 3 addresses |
| 10 | Fee account | HrTf9CzXR1dRH4Sof5QrpmGWwpwAf3qZzwCsEjQpXcSq: SPL Token account, mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v (USDC), owner R4rNJHaffSUotNmqSKNEfDcJE8A7zJUkaoM5Jkd7cYX, balance 42,132.42 USDC; 3.69 tx/s (2,000 txs in 542 s) | same | 2026-11-04 | HIGH | live getAccountInfo jsonParsed, slot 465244046 |
| 11 | Wallet balances | R4rN...: system wallet, 11.23 SOL. Signer AgmLJ...: system wallet, 4,972.8 SOL | same | 2026-11-04 | HIGH | live getAccountInfo, slots 465244050 and 465244060 |
| 12 | FOMO fee per trade | Top-level USDC transferChecked from the user to HrTf9... in 90/90 trades. Min 0.10, median 0.10 (52/90 exactly 0.10), mean 0.30, max 2.93 USDC. As % of trade value: median 1.75%; 3.7% under $5, 2.0% at $5-10, 1.0% at $10-20, 0.8-0.9% at $20-100, 0.22% over $100 (range 0.07-0.86%) | same | 2026-11-04 | HIGH | live token-balance deltas, n=90 |
| 13 | FOMO's fee wording | Terms s.7: the fee "depends on factors including the size and type of the transaction, the token involved, and how the transaction is routed", shown before you confirm | https://fomo.family/terms | 2026-11-04 | HIGH | docs read directly |
| 14 | Quote asset | USDC in 90/90 successful trades (3 of them SOL<->USDC). Users hold USDC | api.mainnet-beta.solana.com | 2026-11-04 | HIGH | live token deltas |
| 15 | Buy/sell split | 44 buys, 46 sells (n=90) | same | 2026-11-04 | HIGH | live |
| 16 | Aggregator split | DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH 49/90 (54%, 95% CI 44-64%); Jupiter v6 JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 27/90 (30%); unidentified proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u 14/90 (16%, logs "SwapTob"/"SwapTobV3") | same | 2026-11-04 | HIGH | live top-level program IDs |
| 17 | DF1ow4... is DFlow's program | Fits the vanity prefix and Bitquery's "dflow" label; no official DFlow source read | DFlow docs not checked | - | UNVERIFIED | inference only |
| 18 | Venue split | Trades touching each venue (n=90; 84 use 2-5 venues, e.g. USDC->SOL->token): Meteora DLMM 42, PumpSwap 42, BiSoNHVpsVZW2F7rx2eQ59yQwKxzU5NvBcmKshCSUypi 36 (unlabelled AMM), pump.fun curve 15, Raydium CLMM 15, TessVdML9pBGgG9yGks7o4HewRaXVAMuoVj4x83GLQH 14, Orca Whirlpool 11, Jupiter Lend AMM 10, Raydium CPMM 6, others <=5 | same | 2026-11-04 | HIGH (counts) | live inner instructions |
| 19 | pump.fun / PumpSwap IDs | pump.fun 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P; PumpSwap pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA | https://github.com/pump-fun/pump-public-docs (idl/pump.json, idl/pump_amm.json @639b87f) | 2026-11-04 | HIGH | official IDL "address" fields |
| 20 | Jupiter Lend IDs | AMM jupZ4m2GqUCJ5iueMfzQf8khFfH31d4XAQt3RzCT9Vd; Liquidity jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC | https://github.com/jup-ag/docs (lend/program-addresses.mdx @acbe702) | 2026-11-04 | HIGH | docs source |
| 21 | Meteora/Raydium/Orca labels | DLMM LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo, Raydium CLMM CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK, CPMM CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C, Orca whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc | no official page read | 2026-11-04 | LOW | well-known IDs, not re-verified here |
| 22 | Trade size | USD value per trade (USDC leg): median 9.54, p25 3.59, p75 54.58, p90 149.72, mean 66.99, max 1,565.58 (n=90); buys median 7.64, sells 13.50. About 0.10 SOL at the median | api.mainnet-beta.solana.com | 2026-11-04 | HIGH (USD), LOW (SOL) | live token deltas; SOL price from row 23 |
| 23 | SOL price used | about 91.8 USD/SOL, implied by 3 FOMO users' SOL->USDC swaps at 00:33-00:44 UTC (91.76 / 91.80 / 91.84, after the 0.10 fee) | same | 2026-11-04 | LOW | inference from live data; no price API read |
| 24 | Network fee FOMO pays | Per trade: median 410,000 lamports (0.00041 SOL, about $0.04), mean 0.00079 SOL, max 0.0195 SOL. priorityFee median: DFlow 400,000 (65% exactly that), Jupiter 14,954, proVF4 45,439. CU used median 237k (limit median 354k) | same | 2026-11-04 | HIGH | live meta.fee and transactionConfig |
| 25 | Non-trade txs | 9/100 random txs (10.4% at 09:00): all v0, user-signed USDC outflows with FOMO paying gas: plain transfers to other wallets (3/9); "DepositToken" into program 99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2 (5/9); USDC to one collector BWocXaSJ46XRSnTUA92ffLzLriM7V8tHVLoUnS9HoWQz with memo {"intentId":...} (1/9). Also seen: USDC to EW1aiQ8whb8i8x5D5tjpJ7GhMxB1pFKxjN3rWuwA2bDf with a 24-hex-digit memo | same | 2026-11-04 | HIGH (structure), UNVERIFIED (who the counterparties are) | live getTransaction, n=16 |
| 26 | Log size, truncation | 0/113 logs truncated. Trade txs: mean 6,589 B of log text (p90 8,957, max 11,564), about 85 lines. As a logsNotification JSON message: mean 7,118 B (p90 9,589, max 12,292) | same | 2026-11-04 | HIGH | live meta.logMessages |
| 27 | How events are emitted | pump.fun TradeEvent and PumpSwap Buy/SellEvent: in logs ("Program data:") AND as self-CPI. DFlow (discriminator 40c6cde8260871e2), Jupiter v6 (982f4eebc0606e6a), Meteora DLMM and proVF4: self-CPI only (emit_cpi), so NOT in logs. Token-program legs, including the FOMO fee, log no amounts | same + pump IDLs (row 19) | 2026-11-04 | HIGH | live inner instructions decoded with IDL discriminators |
| 28 | Logs-only parsability | Of 90 trades, logs alone give: user wallet 52 (58%); mint 21 (23%), or 58 (64%) if each PumpSwap pool is looked up once; side 52 (58%); token amount 65 (72%); USDC amount 12 (13%); user+side+amount 42 (47%); all four 14 (16%). Pump-family trades (55): user 44, side 52. Other venues (35): user 8, side 0 | same | 2026-11-04 | HIGH | logs of the samples parsed offline |
| 29 | Full-tx parsability | User wallet = 2nd signer in 90/90; mint, side and size from pre/post token balances in 90/90 | same | 2026-11-04 | HIGH | live |
| 30 | Trades per day now | 12 points, every 2 h from 11-03 08:59 to 11-04 07:01 UTC, 1,000 marker txs each (86-271 s): 3.69-11.63 tx/s, mean 7.55/s = about 653k/day incl. about 1.2% failed. Low 09-13 UTC, high 19-23 UTC | same | 2026-11-04 | MEDIUM | live getBlock (as cursor) + getSignaturesForAddress; short windows |
| 31 | Source of the brief's 0.9-1.2M/day | Bitquery: Trading API counted about 925,000-1.21M FOMO trades/day on 23-28 Sep 2026; 12:00-13:00 UTC 29 Sep: about 33,600 signed txs, 26,000 trades, 22,000 via DFlow | https://docs.bitquery.io/docs/blockchain/Solana/fomo-api/ | 2026-11-04 | HIGH (what Bitquery says) | docs read directly |
| 32 | Bitquery's other claims | Addresses found from chain data; "FOMO has not published or confirmed them". DFlow-row owner = fee-paying wallet in 94% of 1,166 trades; about 25,900 fee payments in that hour; DEX-trade data about 12 h back; Trading API about 30 days, no user wallet; API token needed outside the IDE; "Some trades also send a second, smaller fee to another account" | same | 2026-11-04 | HIGH | docs read directly |
| 33 | Public RPC limits | Live headers: x-ratelimit-tier free, rps-limit 250, method-limit 150 (getSlot) but 10 (getSignaturesForAddress, getTransaction), conn-limit 40, connrate-limit 40, pubsub-limit 5; 429 replies carry retry-after: 10. My calls drew 26 x 429 on getSignaturesForAddress and 19 x 429 on getTransaction, no 403 (the team shares one IP) | https://api.mainnet-beta.solana.com | 2026-11-04 | HIGH (headers), MEDIUM (10 s window, inferred) | live response headers |
| 34 | Jupiter label API | lite-api.jup.ag and api.jup.ag (program-id-to-label): proxy 403 | - | 2026-11-04 09:10 UTC | HIGH | curl |
| 35 | FOMO terms: date, party | "Last updated: October 26, 2026." FOMO Labs Inc., "a Delaware corporation". "Services" = the fomo.family websites, mobile apps, accounts, wallet and trading interfaces, social features, software | https://fomo.family/terms | 2026-11-04 | HIGH | docs read directly |
| 36 | FOMO on public chain data | s.27: "Public blockchain records may remain available after an account or app record is deleted." Nothing else found on wallets being public | same | 2026-11-04 | HIGH | docs read directly |
| 37 | Bitquery free tier, limits, streams, terms | not read (ran out of time) | docs.bitquery.io | - | UNVERIFIED | see last section |

FOMO Terms of Service, section 16 "Prohibited Uses", verbatim (apostrophes made ASCII). "You agree not to, and you shall not permit others to:"
- "Attempt to access or search the Services or download content from the Services using any unauthorized or automated means, such as bots, crawlers, or data mining tools;"
- "Use automated scripts, bots, software, or any other automated means to create accounts, send messages, post content, execute trades, or otherwise control or interact with account activity on the Services, except through functionality we expressly authorize;"
- "Use any automated tool, scraper, crawler, spider, or unauthorized third-party application to extract, collect, harvest, or compile data from the Services, including but not limited to user-generated content, transaction data, pricing information, or account information;"
- "Use or permit a third-party trading extension, bot, script, or other trading or data-extraction tool to access or interact with the Services, retrieve data, or submit transactions, except through an integration or functionality expressly authorized by Fomo. You must not supply, disclose, transfer, or permit a third party to obtain or use your authentication tokens, session tokens, session cookies, API keys, or other account-access credentials for those purposes without Fomo's express authorization. [...] An account holder's consent does not authorize access or activity prohibited by these Terms."
- "Attempt to decipher, decompile, disassemble, or reverse-engineer any of the software or underlying technology used to provide the Services;"
- "Reverse look-up, track, or seek to track any information on any other user of or visitor to the Services;"
- "Engage in market manipulation practices such as pump and dump schemes, wash trading, self-trading, front-running, quote stuffing, spoofing, or layering;"

## Measurements

Windows and samples (all 2026-11-04 UTC unless noted):
- W1 signer: 00:36:17-00:45:46, 5,000 signatures, 8.79/s, 47 failed (0.94%); full minutes 476-584 txs.
- Sample: 100 signatures drawn uniformly at random from W1 (seed 20261104), plus 6 failed and 8 memo txs as extra strata = 113 getTransaction (jsonParsed). Random 100: 90 successful trades, 1 failed trade, 9 non-trades.
- W2 signer: 08:49:42-09:01:20, 3,000 signatures, 4.30/s, 14 failed (0.47%). Overlap of signer, marker and fee account: row 9.
- 24 h marker profile (tx/s), 11-03 -> 11-04: 08:59 3.69, 10:59 4.29, 12:59 4.41, 15:00 8.40, 17:00 8.70, 19:00 10.53, 21:01 11.63, 23:01 10.42, 01:01 6.85, 03:01 9.71, 05:01 7.14, 07:01 4.90. Mean 7.55/s. Failed per window 0.3-3.3%.
- Indexing delay: the newest signature was about 1 s old (by blockTime) when getSignaturesForAddress answered (2 observations). Websocket latency not measured.

Websocket bandwidth (computed, not measured), logsSubscribe on the marker at "confirmed":
- messages/s = trade rate: mean 7.55, quiet 3.7, peak 11.6.
- bytes/s = 7.55 x 7,118 B = about 54 KB/s on average (26 KB/s quiet, 83 KB/s peak), about 4.6 GB/day of JSON payload, before websocket/TLS framing and without compression.
- Subscribing to the signer instead adds the non-trades (about 11% more messages, each about 1 KB): about 8.4 messages/s, about 4.7 GB/day.

Full transaction for every trade (getTransaction, jsonParsed):
- about 653,000 calls/day (7.6/s mean, 11.6/s peak); responses mean 30.0 KB (median 32.9 KB, max 50 KB, n=113): about 19.6 GB/day.
- Public RPC: getTransaction method-limit 10 (per 10 s, inferred) = at most about 86,000 calls/day for the whole shared IP. It cannot keep up (needs 7.6/s), and would be abuse of a shared free service.
- Paid provider: cost = 653k calls/day x credits per getTransaction. ASSUMPTION for scale only: at 1 credit per call that is about 19.6M credits/month. The provider researcher has the real prices.
- Sampling 1 trade in 50: about 13,000 calls/day (0.15/s), about 0.4 GB/day.

Budget used: 313 RPC calls (limit 600), paced at <=1.33/s; 45 x HTTP 429 with back-off, no 403.

## What this means for the bot

1. The signal exists and is easy to detect today. One FOMO wallet (AgmLJ...) pays gas for every sampled FOMO trade, and every trade carries the marker account jitodontfront...TradeonFomo. The marker is the better filter: it selects trades only (incl. failed), while about 10% of what the signer signs are USDC withdrawals and deposits.
2. It is unofficial. FOMO has published none of these addresses (Bitquery says so too). FOMO can rotate the signer, drop the marker or change aggregator any day, and our signal goes to zero silently. All 113 sampled txs used the same fee payer; every fee-account tx in the 500 s window was signed by AgmLJ...; I found no second FOMO fee payer. That says nothing about tomorrow.
3. The brief is out of date in three places. (a) DFlow routes about 54% of trades now, not "most" (Bitquery: about 85% on 29 Sep); Jupiter has 30% and an unidentified aggregator 16%. Bitquery's queries filter on the DFlow row, so they would now miss about 46% of trades. (b) Volume is about 0.65M trades/day (Nov 3-4), not 0.9-1.2M. (c) FOMO trades are v1 transactions (SIMD-0385): any code that sends maxSupportedTransactionVersion 0, or a parser/SDK without v1 support, silently loses about 90% of FOMO activity.
4. Logs alone are not enough for copy-trading. A logs-only websocket tells us THAT a FOMO trade happened (100%), but only 58% of trades reveal the user wallet and the side, 23% the mint (64% with a cached pool lookup), and 16% all four fields. Those 58% are almost all pump.fun/PumpSwap legs; DFlow and Jupiter keep their events out of the logs. Expect the crowd-flow signal to be biased toward pump-family tokens.
5. Full detail for every trade does not fit a $0 budget: about 653k getTransaction calls and about 20 GB a day.
6. Who we would be copying: retail. Median trade about $9.5 (about 0.10 SOL); 58% of trades pay FOMO's $0.10 minimum fee; the median fee is 1.75% of the trade. Most trades hop 2-5 pools (USDC -> SOL -> token), so each FOMO user pays DEX fees twice or more. A follower acts at least one block (0.2-0.4 s) after the FOMO user's trade has already moved the price, plus our own landing time. Nothing here shows an edge; it must be forward-recorded and paper-tested before any money is used.
7. Terms risk. We never touch FOMO's Services (the app, the website, their API) and that is the main ban in s.16. But s.16 also bans "Reverse look-up, track, or seek to track any information on any other user of or visitor to the Services". That is broad. If the owner holds a FOMO account, a bot that tracks FOMO users' wallets could be read as a breach. Not legal advice: the owner should decide, and could ask FOMO in writing.
8. Health monitor (independent anchors): (a) marker tx rate against the same hour's baseline; (b) count of USDC inflows to the fee account HrTf9... (different account, written by the user's own transfer); (c) signer tx rate, plus the ratios marker/signer (about 0.90) and fee-account/marker (about 1.0). If any anchor drops below about 30% of its baseline for 10 minutes, or a ratio moves by more than 20%: treat it as rotation or an outage, stop trading (fail closed) and alert the owner.

Recommendation (cheapest workable path on a $0 data budget):
- Detection: one websocket logsSubscribe {"mentions": ["jitodontfront1111111111111111111TradeonFomo"]} at "confirmed". Expected: every FOMO trade, about 1-2 s after its block (untested), about 4.6 GB/day.
- Crowd flow: decode pump.fun TradeEvent and PumpSwap Buy/SellEvent from the logs (official IDLs, row 19). That gives user, side and size for about 47% of all trades; map PumpSwap pool -> mint with one cached lookup per new pool.
- Wallet discovery: getTransaction on a small random sample (1-2% of trades, 6-13k calls/day) to rank wallets.
- Copy-trading a short list: one extra logsSubscribe {"mentions": [wallet]} per followed wallet. The user's wallet signs every FOMO trade, so this catches all of that wallet's trades with no parsing gap. The public endpoint advertises pubsub-limit 5, so only about 4 wallets fit there; more needs a provider's free tier.
- Not recommended: getTransaction for every trade (cost); Bitquery as the main feed (API token needed, free tier unknown, about 12 h of trade history, and its DFlow filter now misses about 46%).
- Single biggest risk: the whole signal rests on FOMO's unofficial and unannounced on-chain footprint (signer, marker, fee account, v1 format). It can change without notice, so the bot must treat "no FOMO trades seen" as an outage and do nothing.

## UNVERIFIED and how to confirm

1. DFlow program ID DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH: confirm from DFlow's official docs or GitHub (not checked).
2. Unidentified programs and accounts: proVF4pMXV... (aggregator), BiSoNHVpsV..., TessVdML9p..., 99vQwtBwYt... (DepositToken), collectors BWocXaSJ46... and EW1aiQ8whb..., and the extra token transfers in some trades (e.g. to snoy81BvFtwXXkoh9tcc3JkkLP83jjQYhCkfR3ubSS2; Bitquery calls this a "second, smaller fee"). Confirm with Jupiter's program-id-to-label API once lite-api.jup.ag opens, Solscan labels, or each project's docs.
3. Meteora, Raydium and Orca program IDs (row 21): check the official docs.
4. v1 format: read SIMD-0385 in solana-foundation/solana-improvement-documents, and check that the TS stack can decode v1 (@solana/kit and web3.js changelogs). A note in the jup-ag/docs repo says web3.js 1.x can read but not sign v1 (LOW: internal notes).
5. Websocket (task 5, skipped): does logsSubscribe accept the marker (an address with no account)? Measure messages/s, bytes/s and delay against blockTime for 60-120 s. Check whether pubsub-limit 5 is per IP or per connection, and the public endpoint's terms for production use.
6. Bitquery (task 8, partly done): points per month, rate limits, whether real-time subscriptions are free, latency, and terms for trading bots. docs.bitquery.io is reachable now: read its pricing and points pages.
7. FOMO fee formula and the second fee recipients: more samples, or FOMO's help pages.
8. Daily volume: 12 short windows only. A full count needs about 650 pages of fee-account signatures, or Bitquery's daily query.
9. "json" encoding (raw) response size: not measured; repeat about 15 calls with encoding "json".
10. What R4rN... signs or receives itself: 1,000 txs per 4.3 h in the morning, about 1,000 per 25-30 min in the US evening; not examined.
11. USD values in SOL terms rest on an implied price of about 91.8 USD/SOL (row 23); recheck against a timestamped price feed.
