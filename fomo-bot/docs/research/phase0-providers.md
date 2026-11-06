# Phase 0 research: RPC and market-data providers

Researcher: `researcher` (Claude, read-only). Date checked: 2026-11-04 (live checks); blocked-host retry pass 2026-11-06 23:02Z. Blocked from the sandbox even at the retry pass (proxy 403): www.quicknode.com, www.alchemy.com, legal.alchemy.com, chainstack.com, docs.chainstack.com, www.ankr.com, drpc.org, docs.shyft.to, docs.syndica.io, getblock.io, docs.birdeye.so, docs.coingecko.com, www.coingecko.com, api.coingecko.com, api.jup.ag, api.mainnet.solana.com, docs.helius.xyz, the GitBook files host behind docs.dexscreener.com; apiguide.geckoterminal.com only answers with a 301 to docs.coingecko.com. www.helius.dev became reachable during the run (the owner approved it) and was read directly. Wherever a provider publishes its docs on GitHub, that source was read instead (commit given).

## Facts

| # | Fact | Value | Source URL | Checked | Confidence | How confirmed |
|---|---|---|---|---|---|---|
| H1 | Helius Free plan: price, credits | $0/month, 1M credits/month. Paid: Developer $49/10M, Business $499/100M, Professional $999/200M | https://www.helius.dev/docs/billing/plans ; helius-sdk 3.4.0 (87cb392) src/auth/planCatalog.ts | 2026-11-04 09:04Z | HIGH | docs (.md page) + SDK source |
| H2 | Helius Free rate limits | RPC 10 req/s; DAS and Enhanced APIs 2 req/s; sendTransaction 1/s; getProgramAccounts 5/s; sendBundle not on Free; 429 when exceeded | https://www.helius.dev/docs/billing/rate-limits | 2026-11-04 09:04Z | HIGH | docs |
| H3 | Helius Free WebSockets | Standard Solana methods (logsSubscribe, accountSubscribe, signatureSubscribe...) included on Free. Helius extensions (transactionSubscribe, enhanced accountSubscribe) need Developer+. 5 concurrent connections, 1,000 subscriptions per connection, 10-minute inactivity disconnect | plans + rate-limits pages; https://www.helius.dev/docs/faqs/websockets | 2026-11-04 09:04Z | HIGH | docs |
| H4 | Helius WebSocket billing | NOT free: 2 credits per 0.1 MB of uncompressed streamed data on every plan, plus 1 credit per new connection. Same rate for LaserStream gRPC | https://www.helius.dev/docs/billing/credits ; faqs/websockets | 2026-11-04 09:04Z | HIGH | docs |
| H5 | When WebSocket metering started | All WSS traffic metered from 2026-04-07 (legacy plans from 2026-05-01) | https://www.helius.dev/blog/laserstream-websockets | 2026-11-04 | MEDIUM | search summary |
| H6 | Helius credits per method | Standard RPC 1 (this covers getTokenLargestAccounts, getMultipleAccounts...: "all RPC calls except those listed separately"); getTransaction 1; getSignaturesForAddress 1; getBlock 1; getProgramAccounts 10 (paginated getProgramAccountsV2 1); Priority Fee API 1; DAS (getAsset, getTokenAccounts...) 10; Enhanced Transactions 100 (legacy); Parsed Events 10/request; getTransactionsForAddress 10 per 100 txs; Wallet API 100 | https://www.helius.dev/docs/billing/credits | 2026-11-04 09:04Z | HIGH | docs |
| H7 | Helius webhooks on Free | Available. Max 5 webhooks, 100k addresses each; 1 credit per event sent (even if your endpoint fails); 100 credits per create/edit/delete | rate-limits + credits pages | 2026-11-04 09:04Z | HIGH | docs |
| H8 | Helius Parsed Streams (decoded txs over WSS) | All plans, 1 credit per delivered event; Free: 5 connections, 25 subscriptions each; host wss://beta.helius-rpc.com | plans + credits + rate-limits pages | 2026-11-04 09:04Z | HIGH | docs |
| H9 | Helius LaserStream gRPC | Not on Free. Devnet from Developer; mainnet from Business ($499/mo), 10 connections. Regions include laserstream-mainnet-fra (Frankfurt). helius-labs/core-ai plans.ts says mainnet needs Professional: Helius sources disagree | plans + rate-limits pages; github.com/helius-labs/core-ai (1e1b9f2) helius-skills/shared/references/laserstream.md | 2026-11-04 | HIGH | docs + official repo |
| H10 | Helius Sender on Free | Yes, 0 credits. Keyless 1 req/s; with API key 50 req/s per region. Minimum tip: Sender Max 0.001 SOL; SWQOS-only 0.000005 SOL. (core-ai skill file of 2026-11-03 still says 0.0002 SOL: stale) | https://www.helius.dev/docs/sending-transactions/sender | 2026-11-04 09:05Z | HIGH | docs |
| H11 | Helius endpoints near Frankfurt | Sender: http://fra-sender.helius-rpc.com/fast (also ams, lon), plain HTTP; HTTPS only at https://sender.helius-rpc.com/fast (auto-routed). RPC/WSS: one global host mainnet.helius-rpc.com (+ beta.helius-rpc.com); no Frankfurt RPC host is documented | sender page; https://www.helius.dev/docs/llms.txt ; helius-sdk src/transactions/types.ts (EU_CENTRAL) | 2026-11-04 09:05Z | HIGH | docs + SDK source |
| H12 | Helius terms: personal use | Clause (xi): customer will not "use or access the Services in any personal, household, or familial capacity, or for any purpose other than a lawful business purpose"; (v) no circumventing usage limits (so no multiple free accounts). Last updated 2026-09-28 | https://www.helius.dev/terms | 2026-11-04 09:08Z | HIGH | docs |
| H13 | Helius top-ups | Agent tier: $10 one-time (USDC), 1M credits, 10 RPS; prepaid credits $10 per 1M | github.com/helius-labs/core-ai helius-cli/src/commands/plans.ts, credits.ts | 2026-11-04 | HIGH | SDK/CLI source |
| P1 | Public mainnet endpoint: official limits | https://api.mainnet.solana.com. Per IP: 100 requests/10 s, 40/10 s for one method, 40 concurrent connections, 40 new connections/10 s, 100 MB per 30 s. "Not intended for production applications"; can block without notice; 403 = blocked, 429 = slow down (Retry-After) | https://solana.com/docs/references/clusters (source: github.com/solana-foundation/solana-com 1da0a7a, clusters.mdx) | 2026-11-04 | HIGH | docs source |
| P2 | Public endpoint: live rate-limit headers | api.mainnet-beta.solana.com, node pit186 (Pittsburgh). x-ratelimit-tier free; rps-limit 250; conn-limit 40; connrate-limit 40; pubsub-limit 5. Method limits: getSlot/getVersion/getHealth/minimumLedgerSlot/getFirstAvailableBlock 150, getLatestBlockhash 100, getMultipleAccounts 50, getRecentPrioritizationFees 20, getProgramAccounts 10, getTransaction 10, getTokenLargestAccounts 0 | api.mainnet-beta.solana.com | 2026-11-04 00:51-00:53Z | HIGH | live read-only calls |
| P3 | Public endpoint: what it refuses today | getTokenLargestAccounts: always 429 (limit 0, retry-after 10). getProgramAccounts: now ALLOWED (200, filtered query; the 2026-10 record said 403). getSignaturesForAddress and getTransaction: allowed, but getTransaction gave 429 three times at about 1 call per 2.5 s (the IP is shared with the team) | api.mainnet-beta.solana.com | 2026-11-04 00:51-00:53Z | HIGH | live read-only calls |
| P4 | Version 1 transactions | getTransaction without maxSupportedTransactionVersion 1 fails with -32015 "Transaction version (1) is not supported" (3 of 7 Jupiter txs); 3 of 4 pump.fun txs were v1 | api.mainnet-beta.solana.com | 2026-11-04 00:52Z | HIGH | live read-only calls |
| P5 | Public WebSocket | wss://api.mainnet-beta.solana.com/ answers 101; logsSubscribe works. Docs: "mentions" takes exactly one address; failed txs are included; blockSubscribe is unstable (needs node flags) | live; solana-com rpc/websocket/logssubscribe.mdx, blocksubscribe.mdx | 2026-11-04 09:02Z | HIGH | live call + docs source |
| P6 | Documented host api.mainnet.solana.com | Not reachable from the sandbox (proxy 403). Whether it serves the same limits is UNVERIFIED | - | 2026-11-04, 2026-11-06 | UNVERIFIED | test once from the VPS |
| A1 | Alchemy Free | 30M CU/month; 300 CU/s (10-second token bucket, 3,000 CU per 10 s); 5 apps; 5 webhooks; archive data. Search results also show 500 CU/s and 300M CU: conflicting | github.com/alchemyplatform/docs (e96fb88) pricing-plans.mdx, throughput.mdx | 2026-11-04 | HIGH | docs source |
| A2 | Alchemy Solana CU per call | getAccountInfo/getBalance/getTokenAccountsByOwner/getRecentPrioritizationFees 10; getMultipleAccounts/getProgramAccounts/getTokenLargestAccounts/sendTransaction/getSlot/getLatestBlockhash 20; getTransaction/getSignaturesForAddress/getBlock 40 | alchemyplatform/docs compute-unit-costs.mdx | 2026-11-04 | HIGH | docs source |
| A3 | Alchemy Solana WebSockets | wss://solana-mainnet.streaming.alchemy.com/v2/KEY, standard PubSub incl. logsSubscribe; billed by bandwidth at 0.0002 CU per byte (200 CU per MB). Yellowstone gRPC: $75/TB (paid). Free-tier connection limits and card requirement: UNVERIFIED | alchemyplatform/docs compute-unit-costs.mdx, solana-subscription-api-endpoints.mdx | 2026-11-04 | HIGH | docs source |
| Q1 | QuickNode free | "Free trial": 10M API credits, 15 req/s, 1 endpoint, no card, labelled "1 month free" (time-limited, not a lasting free tier) | https://www.quicknode.com/pricing | 2026-11-04 | MEDIUM | search summary |
| Q2 | QuickNode Solana WebSocket billing | Since 2026-07-01: 15 credits per 0.1 MB uncompressed (before: 20 credits per message) | https://www.quicknode.com/docs/solana/websocket-billing | 2026-11-04 | MEDIUM | search summary |
| C1 | Chainstack Developer (free) | 3M request units/month, no credit card (pricing page); Solana mainnet capped at 5 req/s on Developer; 1 RU per call, 2 RU for archive (getSignaturesForAddress always 2); EVERY WebSocket notification = 1 RU; getTokenLargestAccounts only on dedicated nodes | github.com/chainstack/dev-portal (b3b2d06) docs/limits.mdx, docs/request-units.mdx; https://chainstack.com/pricing/ | 2026-11-04 | HIGH (quota, card: MEDIUM) | docs source + search summary |
| K1 | Ankr Freemium | 200M API credits/month, sign-in without top-up; HTTPS + WSS (the keyless Public plan is HTTPS only); Solana about 1,800 req/min; every Solana method 500 credits (= 400k calls/month); WSS: 500 credits per subscription AND per notification | github.com/Ankr-network/ankr-docs (0af3485, 2026-09-10) pages/rpc-service/service-plans.mdx | 2026-11-04 | HIGH (docs source may lag the site) | docs source |
| S1 | Syndica Standard (free) | 10M requests/month, 100 req/s, 100 GB data transfer/month; adding a card does not start billing. WSS caps and whether notifications count as requests: UNVERIFIED | https://docs.syndica.io/platform/solana-rpc/rate-limits | 2026-11-04 | MEDIUM | search summary |
| S2 | Shyft free | 10 RPC req/s (a homepage snippet says 20), "unlimited credits", 1 API req/s, no gRPC | https://shyft.to/solana-rpc-grpc-pricing | 2026-11-04 | LOW | search summary, conflicting |
| D1 | dRPC free | 210M CU per 30 days (2025 announcement) vs 50M CU (2026 third-party page); WSS on free: UNVERIFIED | https://drpc.org/blog/upcoming-changes-to-drpcs-free-plan-effective-june-1-2025/ | 2026-11-04 | LOW | search summary, conflicting |
| M1 | DexScreener rate limits | pairs, search, token-pairs, tokens: 300 req/min. token-profiles, community-takeovers, ads, token-boosts (latest/top), orders, metas: 60 req/min | https://docs.dexscreener.com/api/reference | 2026-11-04 09:09Z | HIGH | docs |
| M2 | DexScreener API terms (last updated 2023-08-18) | s.1 may not build a product that competes with DexScreener; s.2 may not make "the API Services, or any portion thereof, available for third parties"; s.4 "may be used for both non-commercial and commercial purposes"; s.5 access can end "at any time, with or without notice"; s.6 notice of breaking changes only for paying customers. No clause on automated use | https://docs.dexscreener.com/api/api-terms-and-conditions | 2026-11-04 09:08Z | HIGH | docs |
| M3 | GeckoTerminal (free, no key) | About 10 calls/min (spec, 2026-10 record). Live: trending_pools (also duration=5m), new_pools, simple token_price all answer; 20 pools per page; Cloudflare cache max-age 30, s-maxage 60, Age 18-38 s; first call got 429 (retry-after 0), probably the shared IP | https://api.geckoterminal.com/api/v2 | 2026-11-04 09:09-09:10Z | HIGH | live read-only calls |
| M4 | Jupiter Price API | V3: GET https://api.jup.ag/price/v3?ids=up to 50 mints; usdPrice, blockId, decimals, priceChange24h, liquidity; tokens that fail Jupiter's heuristics get no price. No key: 0.5 req/s (30/min). Free key: 1 req/s, $0. 60-s sliding window per organisation, one bucket shared by Price, Tokens and Swap; x-ratelimit-* headers | github.com/jup-ag/docs (acbe702) price/index.mdx, portal/rate-limits.mdx, portal/plans.mdx | 2026-11-04 | HIGH | docs source; api.jup.ag blocked here |
| M5 | Jupiter hosts and trending | lite-api.jup.ag is being phased out; use api.jup.ag. Trending: /tokens/v2/{toptrending,toptraded,toporganicscore}/{5m,1h,6h,24h}; new tokens: /tokens/v2/recent | jup-ag/docs portal/migration.mdx, api-reference/tokens/category.mdx, recent.mdx | 2026-11-04 | HIGH | docs source |
| M6 | Jupiter API licence | s.3.2(d): may not "sell, lease, share, transfer or sublicense ... any content obtained through the API" to third parties | jup-ag/docs legal/sdk-api-license-agreement.mdx | 2026-11-04 | HIGH | docs source |
| M7 | CoinGecko Demo API, Birdeye free tier (incl. paywalled token-security endpoint), GetBlock | Not established in this run | docs.coingecko.com, docs.birdeye.so, getblock.io | 2026-11-04 | UNVERIFIED | blocked; see last section |

## Measurements

All read-only, from the sandbox (shared egress IP, US; the public RPC served us from Pittsburgh, not Frankfurt). Totals: 33 HTTP calls to the public RPC (32 answered, 1 blocked by the proxy) and 1 WebSocket connection (15 s); 4 GeckoTerminal calls; 0 DexScreener API calls (docs only); 1 Jupiter call (blocked by the proxy).

| What | Result |
|---|---|
| Public RPC latency (2026-11-04 00:51Z) | light methods 124-173 ms; getFirstAvailableBlock 625 ms; getSignaturesForAddress 2.2-2.9 s; getTransaction 0.2-2.2 s (usually 0.3-0.6 s) |
| getTransaction response size (json) | 7.6-19.2 KB per transaction |
| Size of the logsNotification a tx would produce (from getTransaction logs) | pump.fun 0.6-3.3 KB (4 txs); PumpSwap 4.6-8.0 KB (5); Jupiter swaps 4.3-5.3 KB (3) |
| Failed transactions | pump.fun program: 41 of the last 50 signatures failed (00:52Z); PumpSwap: 5 of 50 |
| Live logsSubscribe, PumpSwap program, 09:02:09-09:02:25Z | 5,183 notifications in 15 s (345/s), 2,470 failed (48%), 16.4 MB (1.1 MB/s); size min 470 B, median 1,875 B, mean 3,168 B, p90 5,685 B, max 13,349 B; handshake 101 ms, subscribe ack 49 ms |
| 429s seen (no 403 from Solana) | getTokenLargestAccounts 00:51:41Z; getTransaction 00:52:31Z, 00:53:02Z, 00:53:23Z (all retry-after 10); GeckoTerminal trending_pools 09:09:58Z (retry-after 0) |
| GeckoTerminal freshness | latency 167-330 ms; cache HIT with Age 18-38 s, so data was 18-60+ s old |

## What this means for the bot

1. **The FOMO firehose is not free on Helius.** At 12 tx/s (about 1.04M/day) and 2-5 KB per notification (proxy sizes above; FOMO's own sizes are not measured), the stream is 2.1-5.2 GB/day. Monthly cost of that stream alone: Helius 1.2-3.1M credits (Free: 1M = 120-310%); QuickNode 9-23M credits (and its free trial ends after a month); Chainstack 31M RU (10x the free quota, since every notification counts); Ankr 518M credits per DAY (impossible); Alchemy 12-31M CU (42-104% of its 30M). Only the public endpoint is unmetered: about 1-2.6 MB per 30 s against a documented 100 MB/30 s, but it is "not intended for production" and can block us without notice.
2. **Knowing what each FOMO trade bought needs getTransaction (or decoding logs).** 1M getTransaction calls a day is impossible on any free tier (Helius Free allows about 33k credits/day in total). Budget about 3k/day for selected wallets and samples.
3. **Failed transactions are billed and must be filtered.** logsSubscribe delivers them too (48% of PumpSwap traffic in our sample).
4. **Launch sniping from on-chain streams is out of reach at $0.** PumpSwap alone was 1.1 MB/s, about 94 GB/day, which would cost about 1.9M Helius credits per day. Launch scanning must poll GeckoTerminal new_pools / Jupiter recent, plus cheap on-chain checks of each candidate.
5. **Trade costs at $3-5.** Sender Max needs at least 0.001 SOL per send: at $100-200/SOL (illustrative; no price was measured) that is $0.10-0.20, or 2-7% of the trade per side and 4-13% round trip, before slippage and FOMO-style fees. SWQOS-only (0.000005 SOL) is negligible but lands less reliably. The regional Sender hosts are plain HTTP, so an API key added to their URL travels unencrypted: use the HTTPS host.
6. **Terms risk.** Helius's terms forbid personal or household use (H12). A one-person hobby bot plausibly falls under that. The owner must decide, or ask Helius in writing, before relying on it. Alchemy's and QuickNode's terms are unchecked.
7. **Code consequences:** always pass maxSupportedTransactionVersion 1; treat x-ratelimit-* headers and Retry-After as binding; getTokenLargestAccounts is unavailable on the public RPC and on Chainstack's free plan (Helius: 1 credit).

Recommended $0 stack (binding limit in brackets):

| Role | Primary | Fallbacks, in order |
|---|---|---|
| FOMO firehose (logsSubscribe on the fee payer) | public wss [pubsub-limit 5/IP, 100 MB/30 s, no SLA] | Alchemy free WSS [about 0.66M CU/day of 30M/month]; Helius WSS only for short outages [about 2.8k credits/hour]; else pause crowd-flow |
| Wallet subscriptions (20-50), own-tx confirmations | Helius Free WSS [5 connections x 1,000 subscriptions] | Alchemy WSS; public wss |
| HTTP reads: getTransaction samples, balances, reconciliation, priority fees | Helius Free [10 req/s, 1M credits] | Alchemy [300 CU/s; getTransaction 40 CU]; Chainstack Developer [5 req/s, 3M RU]; public RPC [getTransaction 10 per window] |
| Sending | Helius Sender, HTTPS host, SWQOS-only tip [0 credits, 50 req/s with key] | Helius sendTransaction [1/s, 1 credit]; public RPC (untested: we never send) |
| Prices of open positions | Jupiter Price v3 [0.5 req/s keyless, 1 req/s with free key, 50 mints/call] | GeckoTerminal simple token_price [about 10/min, 30-60 s cache]; pool reserves via getMultipleAccounts (Helius, 1 credit) |
| Trending / momentum | Jupiter Tokens v2 toptrending/toptraded [same Jupiter bucket] | GeckoTerminal trending_pools [shares the 10/min]; DexScreener pairs [300/min, no redistribution] (boosts are paid promotion: never use them as a universe) |
| Launch scanning | GeckoTerminal new_pools [10/min, newest 200 pools] + Jupiter /tokens/v2/recent | Helius getSignaturesForAddress on the pump.fun mint authority every 30 s [1 credit each] |

Rough monthly budget (30 days; estimates, not measurements, except where marked):

| Feature | Assumption | Provider | Per day | Per 30 days | Share of free allowance |
|---|---|---|---|---|---|
| FOMO firehose | 1.04M notifications x 3.2 KB = 3.3 GB/day | public wss (Alchemy if it fails) | 0 (Alchemy: 0.66M CU) | 0 (Alchemy: 19.9M CU) | 0% (Alchemy: 66%) |
| same, if run on Helius | same | Helius | 66k credits | 2.0M credits | 199%: not possible |
| Selected getTransaction | 3,000/day | Helius | 3,000 | 90k | 9% |
| Wallet subscriptions | 50 wallets, about 10k notifications x 3 KB + reconnects | Helius WSS | about 650 | about 20k | 2% |
| Own trades: confirm + fetch | 20 trades x 2 sides | Helius | about 100 | 3k | under 1% |
| Reconciliation | 2 calls every 5 min | Helius | 576 | 17k | 2% |
| Priority-fee estimates | 300/day | Helius | 300 | 9k | 1% |
| Launch scan, on-chain part | signatures every 30 s + 1 getMultipleAccounts/min | Helius | 4,320 | 130k | 13% |
| Helius total (without firehose) | | Helius | about 9k | about 270k | 27%; leaves about 11 days of firehose fallback |
| Price checks | 1 call per 5 s (50 mints) | Jupiter keyless | 17,280 | | 40% of 43,200/day |
| Trending + recent | 1 call/min each | Jupiter | 2,880 | | 7% |
| New pools + trending | 1 call/30 s + 1 call/min | GeckoTerminal | 4,320 | | 30% of about 14,400/day (shared IP risk) |

Degradation order when a provider's month-to-date use runs ahead of its pro-rata line (owner's brief): (1) slow down, then stop, momentum/trending polling; (2) cut crowd-flow sampling (fewer getTransaction samples, no metered firehose fallback); (3) stop launch scanning. Never cut exits, price checks of open positions, confirmations or reconciliation: reserve 20% of the Helius credits for them, and if a price feed or the RPC fails, stop opening positions and alert (fail closed).

Paid-plan context: Helius prepaid credits ($10 per 1M) would put the firehose at about $10-30/month, which breaks the $5-10 budget. Helius Developer is $49/month and Jupiter Developer $25/month: both are out of budget.

## UNVERIFIED and how to confirm

- FOMO's own notification size (cost model uses 2-5 KB proxies): sample 60 s of logsSubscribe on the fee payer, or 20 getTransaction calls, once its address is verified.
- Whether the public wss keeps one 24/7 subscription alive, and what "pubsub-limit 5" counts (connections or subscriptions): a 3-day soak test from the VPS, logging drops and reconnects.
- The window behind the public x-ratelimit numbers (rps-limit 250 vs the documented 100 per 10 s), and api.mainnet.solana.com itself: test from the VPS.
- Whether Helius counts 0.1 MB as 100,000 or 104,858 bytes (5% effect): ask Helius support, or compare a day's usage in the dashboard.
- Whether Helius clause (xi) excludes a private trading bot: written answer from Helius support. Alchemy terms (legal.alchemy.com) and QuickNode terms: read them from the owner's PC.
- Alchemy: free-tier WebSocket connection limit, card requirement, what happens at 30M CU (hard stop or overage), and the 300 vs 500 CU/s conflict: read the dashboard and www.alchemy.com/pricing from the owner's PC.
- QuickNode: whether anything stays free after the one-month trial, and Solana per-method credits: quicknode.com/pricing and /api-credits.
- Chainstack: WSS connection limit on Developer. Syndica: whether WSS notifications count against the 10M requests. Shyft, dRPC, GetBlock: the numbers conflict or were not checked.
- CoinGecko Demo API limits, GeckoTerminal/CoinGecko terms and attribution (www.coingecko.com/en/api_terms), Birdeye free tier and which endpoints (e.g. token security) are paywalled: docs blocked here; read them from the owner's PC.
- Jupiter live behaviour (api.jup.ag blocked here): one keyless call from the VPS, recording x-ratelimit-* headers, and whether keyless limits apply per IP.
- Latency Frankfurt VPS to fra-sender.helius-rpc.com/ping and to mainnet.helius-rpc.com: measure from the VPS.
- Helius dates for WebSocket metering (MEDIUM, blog via search): the blog post, now that www.helius.dev answers.
