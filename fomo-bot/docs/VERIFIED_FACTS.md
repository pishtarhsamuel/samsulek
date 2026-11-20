# Verified facts

Every external fact the bot relies on: value, source, date checked, confidence. Rule
(BUILD_PROMPT.md section 3.6): code may only use program IDs, endpoints, fees, limits,
quotas, prices and model IDs that are recorded here. Anything UNVERIFIED must be designed
around. Append new checks and mark old rows superseded; never delete history.

Confidence: **HIGH** = official docs read directly, official SDK/program source, or a
live read-only call. **MEDIUM** = an official page seen only through search, or several
consistent reputable secondary sources. **LOW** = one secondary source, or inference.
**UNVERIFIED** = not confirmed.

Phase 0 checks ran 2026-11-04 (a few on 2026-11-06), from a cloud sandbox whose network
blocked many docs sites; official GitHub docs repos were read instead where possible.
Full evidence, measurements and method: `docs/research/phase0-*.md`. Source keys in the
tables: **[fomo]** phase0-fomo-signal.md, **[prov]** phase0-providers.md, **[venues]**
phase0-venues.md, **[exec]** phase0-execution.md, **[safety]** phase0-token-safety.md,
**[ai]** phase0-anthropic.md, **[ops]** phase0-ops-hosting.md, **[tool]**
phase0-toolchain.md. Each research row gives the exact URL, commit or slot.

## 1. FOMO signal (unofficial: FOMO has published none of these addresses)

| Fact | Value | Source | Checked | Confidence |
|---|---|---|---|---|
| FOMO signer and fee payer | `AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51`: active; fee payer on 113/113 sampled txs; exactly 2 signers (FOMO + the user's wallet, always the 2nd signer) | [fomo] rows 1-3, live RPC | 2026-11-04 | HIGH |
| FOMO trade marker | `jitodontfront1111111111111111111TradeonFomo` appears in every FOMO trade (97/97, failed ones too) and in no non-trade (0/16); it is not a real account (a Jito anti-sandwich tag) | [fomo] rows 7-9 | 2026-11-04 | HIGH |
| FOMO fee account | `HrTf9CzXR1dRH4Sof5QrpmGWwpwAf3qZzwCsEjQpXcSq`: USDC token account, owner `R4rNJHaffSUotNmqSKNEfDcJE8A7zJUkaoM5Jkd7cYX` | [fomo] row 10 | 2026-11-04 | HIGH |
| FOMO fee | Separate USDC transfer from the user: minimum $0.10 (58% of trades pay exactly that), median 1.75% of the trade | [fomo] row 12 | 2026-11-04 | HIGH |
| Transaction format | FOMO trades are **version 1** transactions; reading them needs `maxSupportedTransactionVersion: 1` (version 0 gets error -32015) | [fomo] row 4 | 2026-11-04 | HIGH |
| Volume | About 653k trades/day (mean 7.55/s, range 3.7-11.6/s over 24 h); the brief's 0.9-1.2M/day was Bitquery's figure for 23-28 Sep 2026 | [fomo] rows 30-31 | 2026-11-04 | MEDIUM (short windows) |
| Trades | Quote asset USDC in 90/90; 44 buys / 46 sells; median $9.54, mean $67; most hop 2-5 pools | [fomo] rows 14-18, 22 | 2026-11-04 | HIGH |
| Routing | DFlow ~54%, Jupiter v6 ~30%, unidentified `proVF4...` ~16% (the brief said "most via DFlow") | [fomo] row 16 | 2026-11-04 | HIGH (counts) |
| DFlow program ID | `DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH` (vanity prefix, Bitquery label) | [fomo] row 17 | 2026-11-04 | UNVERIFIED |
| Logs-only decoding | From logs alone: user + side in 58% of trades, mint in 23% (64% with one cached pool lookup), all four fields in 16%. pump.fun/PumpSwap events are in logs; DFlow, Jupiter and Meteora DLMM events are not | [fomo] rows 27-28 | 2026-11-04 | HIGH |
| Stream size | One logsNotification per trade, mean 7,118 bytes: about 54 KB/s, 4.6 GB/day | [fomo] row 26, measurements | 2026-11-04 | HIGH (computed from measured sizes) |
| FOMO Terms of Service | Last updated 26 Oct 2026. s.16 bans automated access to the Services, bots, scrapers, third-party trading tools, sharing session tokens, reverse engineering, and also: "Reverse look-up, track, or seek to track any information on any other user of or visitor to the Services" | https://fomo.family/terms, [fomo] s.16 quotes | 2026-11-04 | HIGH |
| Bitquery free tier | Points, limits, streams, terms | docs.bitquery.io | - | UNVERIFIED |

## 2. Data providers

| Fact | Value | Source | Checked | Confidence |
|---|---|---|---|---|
| Helius Free | $0; 1M credits/month; RPC 10 req/s; DAS 2 req/s; sendTransaction 1/s; 5 websocket connections, 1,000 subscriptions each | https://www.helius.dev/docs/billing/plans, /rate-limits | 2026-11-04 | HIGH |
| Helius websocket billing | **Metered on every plan**: 2 credits per 0.1 MB streamed + 1 credit per connection. The full FOMO stream (4.6 GB/day) would cost ~2.8M credits/month, about 2.8x the free plan | https://www.helius.dev/docs/billing/credits | 2026-11-04 | HIGH |
| Helius credits per call | Standard RPC (incl. getTransaction, getSignaturesForAddress, getTokenLargestAccounts) 1; getProgramAccounts 10; DAS 10; Enhanced Transactions 100; webhooks 1 per event (max 5 on Free) | same | 2026-11-04 | HIGH |
| Helius terms | Clause (xi): no use "in any personal, household, or familial capacity, or for any purpose other than a lawful business purpose" (updated 2026-09-28) | https://www.helius.dev/terms | 2026-11-04 | HIGH |
| Helius Sender | Free (0 credits), keyless 1 req/s. Minimum tip: Sender Max 0.001 SOL; SWQOS-only 0.000005 SOL. HTTPS host `https://sender.helius-rpc.com/fast`; regional hosts (incl. `fra-sender`) are plain HTTP | https://www.helius.dev/docs/sending-transactions/sender | 2026-11-04 | HIGH |
| Helius LaserStream gRPC | Not on Free; mainnet from Business ($499/month) | plans page | 2026-11-04 | HIGH |
| Public mainnet RPC | `api.mainnet-beta.solana.com`: per IP 100 req/10 s, 40/10 s per method, 40 connections, 100 MB/30 s; "not intended for production", may block without notice. Live method limits: getTransaction 10, getSignaturesForAddress 10, getProgramAccounts 10, getTokenLargestAccounts 0 (always refused); pubsub-limit 5 | https://solana.com/docs/references/clusters (source repo) + live headers | 2026-11-04 | HIGH |
| Public websocket | logsSubscribe works (`mentions` takes exactly one address; failed txs included); unmetered | live + docs source | 2026-11-04 | HIGH |
| Public RPC change | Filtered getProgramAccounts (memcmp on a mint) now answers (it was 403 on 2026-10-12) | [prov] P3, [safety] row 25 | 2026-11-04 | HIGH |
| Alchemy Free | 30M CU/month; websockets billed 200 CU per MB (the FOMO stream alone would use ~92% of the month); getTransaction 40 CU. Terms not checked | github.com/alchemyplatform/docs | 2026-11-04 | HIGH (terms UNVERIFIED) |
| Other free RPC tiers | QuickNode: one-month trial only (MEDIUM). Chainstack: 3M RU, every websocket notification costs 1 RU (HIGH). Ankr: 500 credits per notification (HIGH). Syndica, Shyft, dRPC: conflicting or unchecked | [prov] Q1-D1 | 2026-11-04 | see row |
| DexScreener API | 300 req/min (pairs, search, tokens), 60 req/min (profiles, boosts). Terms: commercial use allowed; may not make the API data available to third parties | https://docs.dexscreener.com/api/reference, /api-terms-and-conditions | 2026-11-04 | HIGH |
| GeckoTerminal API | Free, no key, about 10 calls/min; responses cached 30-60 s; trending_pools and new_pools endpoints | live + 2026-10 record | 2026-11-04 | HIGH |
| Jupiter Price API v3 | `https://api.jup.ag/price/v3?ids=` up to 50 mints; keyless 0.5 req/s, free key 1 req/s, one bucket shared with Tokens and Swap; trending via `/tokens/v2/toptrending/{5m,1h,6h,24h}` | github.com/jup-ag/docs (acbe702) | 2026-11-04 | HIGH (live call blocked) |
| Jupiter API licence | No sharing or sublicensing content obtained through the API with third parties (s.3.2(d)); no excessive request volume (3.2(e)) | same | 2026-11-04 | HIGH |

## 3. Launchpads, AMMs and chain costs

| Fact | Value | Source | Checked | Confidence |
|---|---|---|---|---|
| pump.fun bonding curve | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` (upgradeable; last deploy 2026-10-19) | github.com/pump-fun/pump-public-docs (639b87f) + live | 2026-11-04 | HIGH |
| pump.fun Global / mint authority PDA | Global `4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf`; mint-authority PDA `TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM` | same | 2026-11-04 | HIGH |
| PumpSwap AMM | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | same | 2026-11-04 | HIGH |
| pump fee program | `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`; FeeConfig: curve `8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt`, PumpSwap `5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx` | same + live decode | 2026-11-04 | HIGH |
| pump.fun curve fee | **1.25% per side** (protocol 0.95% + creator 0.30%), one tier, not market-cap dependent | live FeeConfig decode, slot 465,244,853 | 2026-11-04 | HIGH |
| PumpSwap fee (graduated pump coins) | Market-cap tiers: 1.25% below 420 SOL mcap, 1.20% to 1,470, ... 1.00% from 4,420, ... 0.30% from 98,240 SOL. Non-canonical pools: flat 0.30% | live decode | 2026-11-04 | HIGH |
| Graduation | When real token reserves reach 0: about 85 SOL raised, implied mcap ~411 SOL (so a fresh pool still charges 1.25%); migration is permissionless; 0.015 SOL migration fee paid from the curve; time to tradable pool not measured | [venues] rows 10-13 | 2026-11-04 | HIGH (rules), MEDIUM (85/411 computed), UNVERIFIED (timing) |
| New pump.fun mints | create_v2: Token-2022 mint, 6 decimals, extensions metadataPointer + tokenMetadata only; mint authority and metadata update authority revoked inside the creation tx; no freeze authority. "Mayhem mode" coins have 2B supply, half in a vault traded by pump.fun's program `MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e` | [safety] rows 15-16, [venues] row 14 | 2026-11-04 | HIGH |
| Launch rate | ~19.4 pump.fun creations/min (~28k/day); pump.fun ~70-90% of new tokens; LetsBonk/LaunchLab small; Boop and Moonit nearly dead | [venues] rows 16-18, 29 | 2026-11-04 | HIGH (crude) / MEDIUM (shares) |
| Raydium | LaunchLab `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj` (0.25% + platform fee, e.g. letsbonk 1.25%); CPMM `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` (configs 0.25%, 0.3%, 0.5%, 1%, 2%, 4%, some with creator fees); AMM v4 `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`; CLMM `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` | raydium-sdk-V2, raydium-cp-swap source + live | 2026-11-04 | HIGH (ids); AMM v4/CLMM fees UNVERIFIED |
| Meteora | Dynamic Bonding Curve `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` (per-launch fee 0.25% up to **99%**, e.g. anti-sniper schedules); DAMM v2 `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`; DLMM `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` | MeteoraAg source + live | 2026-11-04 | HIGH (ids); DLMM fees UNVERIFIED |
| Orca Whirlpools | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` | README + live | 2026-11-04 | HIGH (id) |
| Jupiter v6 program | `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` | jup-ag/docs + live | 2026-11-04 | HIGH |
| Token programs | SPL Token `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`; Token-2022 `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` (upgradeable, last deploy 2026-10-23); Associated Token Account `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`; wrapped SOL `So11111111111111111111111111111111111111112`; Metaplex Token Metadata `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` | live + source | 2026-11-04 | HIGH |
| Network fees | 5,000 lamports per signature + priority fee = CU price (micro-lamports) x requested CU limit / 1,000,000; paid on the limit, and paid even when the tx fails. pump.fun recommends a 100,000 CU limit | solana-com docs source, pump docs | 2026-11-04 | HIGH |
| Rent | (128 + bytes) x **5,080** lamports: SPL token account (165 B) **1,488,440**; Token-2022 ATA (170 B) **1,513,840**. Older guides' 2,039,280 is out of date: always call getMinimumBalanceForRentExemption | live calls | 2026-11-04 | HIGH |
| Failed transactions | 72% of txs touching the pump.fun program failed (19% PumpSwap) in a 1,000-signature sample, mostly competing bots; failed txs still pay fees | live | 2026-11-04 | HIGH (crude) |
| SOL price | $90.04 (2026-11-06, one GeckoTerminal reading); FOMO swaps implied ~$91.8 on 2026-11-04 | [venues] row 37, [fomo] row 23 | 2026-11-06 | LOW (cross-check before sizing) |

## 4. Execution and sending

| Fact | Value | Source | Checked | Confidence |
|---|---|---|---|---|
| Jupiter swap API | Swap API V2 `https://api.jup.ag/swap/v2`: `/order` + `/execute` (managed landing) or `/build` (raw instructions). Ultra and V1 unmaintained; lite-api.jup.ag being phased out | jup-ag/docs (acbe702) | 2026-11-04 | HIGH (live call blocked) |
| Jupiter fees | `/order`: 10 bps for most pairs, **50 bps for tokens under 24 hours old**; `/build`: no Jupiter fee. Keyless 0.5 req/s; free key 1 req/s | same | 2026-11-04 | HIGH |
| Jito Block Engine | `https://mainnet.block-engine.jito.wtf/api/v1` (`/transactions`, `/bundles`); Frankfurt `https://frankfurt.mainnet.block-engine.jito.wtf`; 1 req/s per IP per region; minimum tip 1,000 lamports; tip program `T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt` with 8 tip accounts (fetch with getTipAccounts) | https://docs.jito.wtf/lowlatencytxnsend/ | 2026-11-04 | HIGH |
| 0.001 SOL tip services | Helius Sender Max, Jupiter tx.jup.ag (HIGH), Nozomi, bloXroute (MEDIUM) all need at least 0.001 SOL per tx = 3.33% of a 0.03 SOL trade | [exec] facts 8, 28, 30, 31 | 2026-11-04 | see row |
| MEV protection that fits the budget | Tight minimum-out caps; Jito `jitodontfront` accounts (Jito bundles only, "not guaranteed"); Helius `?mev-protect=true` on SWQOS-only sends (free) | [exec] facts 26, 29 | 2026-11-04 | HIGH |
| Priority-fee estimates | getRecentPrioritizationFees tracks only **write-locked** accounts: passing program IDs returns 0. Pass the trade's pool or bonding-curve account, one per call, and clamp the result (a single observed max would have cost 101-202% of a 0.03 SOL trade) | agave source + live | 2026-11-04 | HIGH |
| Slot time and expiry | Slots ~214 ms (measured); a blockhash lasts 150 blocks, about **32 s**; time out by block height, not seconds | live | 2026-11-04 | HIGH |
| Consensus | Alpenglow reported live since 2026-10-21; observed: no vote txs, finalized as fresh as confirmed | news + live | 2026-11-04 | MEDIUM (event) |
| v1 share | 46% of transactions in sampled blocks were v1; getBlock/getTransaction need `maxSupportedTransactionVersion: 1` | live | 2026-11-04 | HIGH |
| Safe retry | Resend the same signed tx until block height passes lastValidBlockHeight; re-sign only after the old blockhash has provably expired | solana-com cookbook source | 2026-11-04 | HIGH |
| Jito tip floor, landing rates | Current values | bundles.jito.wtf blocked; real sends needed | - | UNVERIFIED |

## 5. Token safety

| Fact | Value | Source | Checked | Confidence |
|---|---|---|---|---|
| Token-2022 extension types | 29 types (0-28), newest PermissionedBurn (28); full REJECT/ALLOW/ALLOW-IF table in [safety] | solana-program/token-2022 (f052d0a) | 2026-11-04 | HIGH |
| When extensions change | Fixed-size mint extensions only at creation; authorities can be changed until set to null, and a null authority can never return | same | 2026-11-04 | HIGH |
| Transfer fees | Up to 100%; a new fee takes effect 2 epochs later (~26-51 h at today's slot time) | same | 2026-11-04 | HIGH |
| jsonParsed trap | If a mint holds an extension type the RPC node doesn't know, the node omits the whole extensions list, so the mint looks clean. Parse raw bytes; reject unknown types | anza-xyz/agave account-decoder source | 2026-11-04 | HIGH |
| Sell simulation | simulateTransaction with sigVerify false needs no signature, only an existing, funded fee payer (a random key gets AccountNotFound) | live experiment | 2026-11-04 | HIGH |
| Holder lists | getTokenLargestAccounts refused on the public RPC; a getProgramAccounts memcmp-on-mint query returns all Token-2022 holders in one call | live | 2026-11-04 | HIGH |
| Third-party scanners | RugCheck, GoPlus, Birdeye, Solana Tracker, SolSniffer: free tier, limits, terms | blocked | - | UNVERIFIED |

## 6. Anthropic (daily AI review)

| Fact | Value | Source | Checked | Confidence |
|---|---|---|---|---|
| Model IDs | `claude-haiku-5-5` (default), `claude-sonnet-5-5` | https://platform.claude.com/docs/en/about-claude/models/overview | 2026-11-04 | HIGH |
| Prices | Haiku 5.5: $0.10 in / $0.50 out per MTok (prompts up to 100k tokens). Sonnet 5.5: $2 / $10. Batch 50% off | https://platform.claude.com/docs/en/about-claude/pricing | 2026-11-04 | HIGH |
| Strict JSON output | Structured outputs (`output_config.format`, json_schema) stable on both models | https://platform.claude.com/docs/en/build-with-claude/structured-outputs | 2026-11-04 | HIGH |
| Daily review cost | Haiku: ~$0.04-0.09/month. Sonnet with thinking off ~$0.60, with thinking ~$1.50 (over the $1 cap) | [ai] | 2026-11-04 | HIGH (prices), estimate |
| Retirement | Haiku 5.5 not before 2027-10-07; Sonnet 5.5 not before 2027-09-28 | models overview | 2026-11-04 | HIGH |
| Minimum credit purchase, account spend cap | - | Console at sign-up | - | UNVERIFIED |

## 7. Hosting and operations

| Fact | Value | Source | Checked | Confidence |
|---|---|---|---|---|
| VAT | EU B2C hosting is taxed where the customer lives; Greece 24% | EU VAT pages via search | 2026-11-04 | MEDIUM |
| netcup VPS nano G11.5s | Nuremberg; 2 vCore, 2 GB, 60 GB; EUR 3.10 net, ~EUR 3.84 (~$4.30) with Greek VAT; **6-month minimum term** | netcup product page via search | 2026-11-04 | MEDIUM |
| Hetzner Cloud CX23 | Nuremberg/Falkenstein (no Frankfurt site); 2 vCPU, 4 GB; EUR 5.99 net incl. IPv4, EUR 7.43 (~$8.30) with VAT; hourly billing; 2026 stock limits for new customers reported | Hetzner pages via search | 2026-11-04 | MEDIUM |
| Frankfurt options | DigitalOcean FRA1 $6 (1 GB) = $7.44 with VAT; Vultr Frankfurt $5 = $6.20 | via search | 2026-11-04 | MEDIUM / LOW |
| Frankfurt infrastructure | Jito Frankfurt block engine; Helius `fra` Sender and LaserStream; Jupiter's EU gateway is AWS Frankfurt | official docs/repos | 2026-11-04 | HIGH |
| Heartbeat | Healthchecks.io free "Hobbyist": 20 checks; ping `https://hc-ping.com/<uuid>`; Telegram integration exists (free-plan scope UNVERIFIED). UptimeRobot heartbeats are paid | healthchecks source repo; search | 2026-11-04 | HIGH / MEDIUM |
| Telegram Bot API | Version 10.3 (2026-08-24); ~1 msg/s per chat; 4,096-char messages; callback_data 1-64 bytes; long polling needs no inbound port; a second poller gets "Conflict"; authorize by numeric user id, never username; bots can delete incoming private messages under 48 h old | https://core.telegram.org/bots/api, /bots/faq | 2026-11-04 | HIGH |
| Ubuntu | 26.04.1 LTS (support to May 2031; chrony; fail2ban not preinstalled; unattended-upgrades and ufw preinstalled); 24.04.5 LTS (to May 2029) | ubuntu.com, cloud image manifests | 2026-11-04 | HIGH |
| Docker | docker-ce 29.9.3, compose plugin 5.7.0 (official apt repo); **published container ports bypass ufw** | download.docker.com, Docker docs source | 2026-11-04 | HIGH |
| EUR/USD | 1.1179 (ECB, 2026-11-03) | ECB | 2026-11-04 | HIGH |

## 8. Toolchain and supply chain

| Fact | Value | Source | Checked | Confidence |
|---|---|---|---|---|
| Node.js | 26.x Active LTS since 2026-10-28, EOL 2029-04-30, latest 26.13.0 (npm 11.20.0). 24.x Maintenance LTS, EOL 2028-04-30, latest 24.22.2 | nodejs.org/dist/index.json, nodejs/Release | 2026-11-04 | HIGH |
| node:sqlite | Built in, no flag on 24/26, but still Experimental ("1.2 Release candidate"); WAL compiled in; INTEGER is signed 64-bit, so token amounts above 2^63-1 need TEXT | Node docs/source at release tags | 2026-11-04 | HIGH |
| node:sqlite behaviour on 26.13.0 | Under the test flags (`--frozen-intrinsics --disallow-code-generation-from-strings`) it loads with no warning; bundled SQLite 3.54.0; `PRAGMA journal_mode = WAL` returns `wal`; `enableForeignKeyConstraints` on; `readBigInts` returns INTEGER as bigint (2^63-1 exact); a bigint above 2^63-1 is refused with ERR_INVALID_ARG_VALUE; TEXT keeps 2^64-1 exactly; `CHECK (x GLOB '[0-9]*' AND x NOT GLOB '*[^0-9]*')` refuses '-1', '1.5', '', '1e3', ' 1'; a partial unique index on `mint WHERE status IN (...)` is enforced and a closed row may share the mint; ROLLBACK leaves nothing; a second connection's `BEGIN IMMEDIATE` fails with SQLITE_BUSY (errcode 5, "database is locked") after its 200 ms timeout and succeeds after the first commits; `PRAGMA quick_check` = ok | local scratch run of the pinned Node (linux-x64) on a temp file | 2026-11-12 | HIGH (Linux); Windows UNVERIFIED |
| node:sqlite details on 26.13.0 (STORAGE_DESIGN.md s.9, U1-U10, U12-U14) | U1: exports `Database` and `DatabaseSync` (the same class), `Statement`, `StatementSync`, `Session`, `backup`, `constants`; options `defensive: true` and `allowExtension: false` accepted, `loadExtension` then throws ERR_INVALID_STATE. U2: `run()` returns `{ changes, lastInsertRowid }` as bigint with `readBigInts`; COUNT(*) is bigint. U3: a JS number binds as REAL (`typeof` = real); a STRICT INTEGER column refuses 1.5 (errcode 3091) but stores 7 as integer, so the wrapper must refuse `number` parameters. U4: `isTransaction` getter (false, true inside BEGIN). U5: STRICT tables with the u64 fragment (1-20 digits, no leading zero, text compare against 18446744073709551615 at 20 digits), the signed form, the id class `[^A-Za-z0-9_-]`, and `json_valid(x) AND x NOT GLOB '*[^ -~]*'` accept and refuse exactly as designed (2^64, '01', '-0', '-01', '--1', 21 digits, an Arabic-Indic digit, invalid JSON, non-ASCII refused; '0', '-5', u64 max accepted). U6: errors are `code` ERR_SQLITE_ERROR with extended `errcode` (275 CHECK, 1555 PRIMARY KEY, 1811 trigger RAISE with its own text as the message, 3091 datatype, 13 FULL, 5 BUSY, 1 logic) and `errstr`. U7: `VACUUM INTO` works with an open WAL connection, the copy passes quick_check, it is created with mode 0644 (umask; chmod 0600 needed), and an existing target fails "output file already exists". U8: `synchronous = FULL` reads 2, `trusted_schema` 0, `application_id` set and read back; `max_page_count` gives SQLITE_FULL (errcode 13). U9: `exec()` runs a multi-statement script with CREATE TRIGGER ... BEGIN ... END. U10: a second PROCESS (started with `--frozen-intrinsics`) holding BEGIN IMMEDIATE makes ours fail with errcode 5 after the 150 ms timeout, and ours succeeds after it commits. U12: `ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT 0 CHECK (...)` works on a STRICT table. U13: `json_valid` is built in. U14: `backup` is an exported function of 2 parameters. `':memory:'` reports journal_mode `memory` | local scratch run of the pinned Node (linux-x64), test flags | 2026-11-13 | HIGH (Linux); U11 (Windows: NTFS WAL, deleting files after close, Greek and space paths) UNVERIFIED |
| node:sqlite behaviours the step 6b wrapper guards against (26.13.0, SQLite 3.54.0) | `prepare()` runs only the first statement of a text and drops the rest without an error (a trailing `;` is fine; empty text throws ERR_INVALID_ARG_VALUE); a missing parameter binds as NULL and an extra one fails (errcode 25); `true` binds as 1, `undefined` as NULL, an object as named parameters (ERR_INVALID_STATE); a flag PRAGMA (`ignore_check_constraints`, `foreign_keys`, `recursive_triggers`) takes effect when it is only prepared, never run (a CHECK then let -1 in); `INSERT OR REPLACE` deletes a row past a `BEFORE DELETE ... RAISE` trigger unless `recursive_triggers` is on (then the trigger fires, errcode 1811); after SQLITE_FULL inside a transaction SQLite rolled the whole transaction back (`isTransaction` false) and the next statement ran on its own and was saved; a deferred foreign key fails at COMMIT (errcode 787) and the transaction stays open; ROLLBACK with no transaction fails ("cannot rollback - no transaction is active"); `VACUUM INTO ?` takes the file name as a bound parameter, fills an existing empty file and keeps its 0600 mode, refuses inside a transaction; `chmod 0600` before WAL starts gives the -wal and -shm files 0600; the constructor creates a 0-byte file at once (no create flag), a read-only open of a missing file fails (errcode 14) and makes none; `BEGIN IMMEDIATE` succeeds on a read-only connection; rows are null-prototype objects (a column named `__proto__` is a plain key) and two result columns with one name collapse into one (`columns()` lists both); `trusted_schema` defaults to 1; a flag setting cannot be changed through its `pragma_*` table function (`pragma_ignore_check_constraints(1)`: "too many arguments"), but a pragma that takes an argument runs with it: `SELECT * FROM pragma_optimize(65538)` (also as `"pragma_optimize"(65538)`) ran ANALYZE and created `sqlite_stat1` (found by the security review O, confirmed); `#a` is a parameter too, bound as NULL when missing; `length()` and GLOB stop at a NUL inside TEXT (`'12<NUL>abc'`: length 2, octet_length 6, matches `[0-9][0-9]`); a damaged page header makes `PRAGMA quick_check` itself fail (errcode 11), damage inside a page is listed line by line; a cached statement survives `ALTER TABLE ADD COLUMN` | local scratch runs of the pinned Node (linux-x64), test flags; the agreement property and planted bugs of step 6b repeat the NUL, PRAGMA and REPLACE ones in the test suite | 2026-11-13 | HIGH (Linux); Windows UNVERIFIED |
| SQLite JSON and size limits on 26.13.0 (step 6c) | `json_valid(x)` agrees with `JSON.parse` on 43 edge cases of printable ASCII (leading zeros, `1.`, `.5`, `1e400`, `-0`, lone `\ud800` and `\u0000` escapes, `'a'`, trailing commas, comments, duplicate keys, scalars at the top) but refuses nesting deeper than 1,000 (arrays or objects), which `JSON.parse` accepts; the `limits: { length }` option sets SQLite's limit on a string, blob or row, a larger bound value fails with SQLITE_TOOBIG (errcode 18), and `db.limits.length` reads it back | local scratch run of the pinned Node (linux-x64); the JSON agreement property of step 6c repeats it | 2026-11-14 | HIGH (Linux); Windows UNVERIFIED |
| node:sqlite `setAuthorizer` on 26.13.0 (step 6c-2, security condition 8b) | `DatabaseSync.prototype.setAuthorizer(callback | null)` exists. The callback gets `(action, arg1, arg2, dbName, triggerOrView)` and returns `constants.SQLITE_OK` (0), `SQLITE_DENY` (1) or `SQLITE_IGNORE` (2); `constants` names every action code from `SQLITE_CREATE_INDEX` (1) to `SQLITE_RECURSIVE` (33). What it reports: BEGIN, COMMIT and ROLLBACK as 22 (arg1 the verb); SAVEPOINT and RELEASE as 32; a PRAGMA as 19 with its name and value; a `pragma_*` table function as 19 with the pragma's name, quoted or not (`'pragma_optimize'(65538)` gives 19 "optimize"); ATTACH as 24, and VACUUM INTO as 24 with the file name; DDL as its CREATE code plus writes to `sqlite_master`; a trigger body's statements during the outer statement's prepare, with the trigger's name as the fifth argument. It is asked at prepare time, and again when SQLite re-prepares a cached statement after a schema change. The exception: a `pragma_*` table function is checked only when the statement runs (prepare passes; the first step fails with 23). A denial fails the statement with errcode 23 (SQLITE_AUTH), "not authorized" ("authorization denied" for VACUUM INTO), and the setting stays unchanged. A denied BEGIN leaves no transaction open. A callback that throws makes prepare throw that error; returning a non-integer or an unknown code also throws | local scratch run of the pinned Node (linux-x64, SQLite 3.54.0); the storage tests repeat the denials on the real connection | 2026-11-16 | HIGH (Linux); Windows UNVERIFIED |
| node:sqlite authorizer calls during ALTER TABLE on 26.13.0 (review Q, security finding 3) | Each form reports `SQLITE_ALTER_TABLE` (26) with the database in the first argument and the table in the second (`main`, `t`). ADD COLUMN on a STRICT table also runs SQLite's own nested check: a read of `pragma_quick_check` and `PRAGMA quick_check` (19) on the table. RENAME TABLE and RENAME COLUMN read and update `sqlite_temp_master`, with the database name `temp`. DROP COLUMN reports 26 as `(main, t, b)`: the dropped column's name arrives where the database name goes. All of them also write `sqlite_master` and call SQLite's internal functions (`sqlite_rename_table`, `sqlite_rename_test`, `sqlite_rename_quotefix`, `sqlite_rename_column`, `sqlite_drop_column`, and `printf`, `substr`, `like`, `glob`). So the 6c-2a policy refuses every form: it refuses PRAGMA, every database but `main` and, since review Q, ALTER itself in a script. A test runs each form through the wrapper | local scratch run of the pinned Node (linux-x64, SQLite 3.54.0), every callback recorded on an in-memory database; the sqlite.ts tests | 2026-11-17 | HIGH |
| SQLite UPDATE with one column twice on 26.13.0 (review Q, the write rules) | `UPDATE f SET kill = 1, kill = 0` is accepted (STRICT table, defensive mode) and the last assignment wins: `kill` ends at 0. So the architecture test's write rules check every assignment to a column and refuse a column set twice on the guarded tables | local scratch run of the pinned Node (linux-x64, SQLite 3.54.0), in-memory database | 2026-11-17 | HIGH |
| SQLite conflict clauses on 26.13.0 (review P, the halt insert of 6c-2) | `INSERT OR IGNORE` skips a row that fails a CHECK silently (no error, 0 changes); `INSERT ... ON CONFLICT (key) DO NOTHING` skips only a duplicate key and still raises a CHECK (errcode 275) or NOT NULL (1299) failure; a trigger's `RAISE(ABORT)` raises under both (errcode 1811); `ON CONFLICT ... DO UPDATE` runs the table's UPDATE triggers; with `recursive_triggers` on, `INSERT OR REPLACE` runs the DELETE triggers of the row it replaces | local scratch run of the pinned Node (linux-x64, SQLite 3.54.0); the schema-v1 tests repeat each case on the real tables | 2026-11-14 | HIGH (Linux); Windows UNVERIFIED |
| Concurrency and randomness under the test flags on 26.13.0 (step 6d, STORAGE_DESIGN.md s.16.12 V6 and the race tests) | Two handles on one file in one thread: while one holds BEGIN IMMEDIATE, the other's BEGIN IMMEDIATE fails as `busy` after its own timeout (about 100 ms, no deadlock), and succeeds once the first commits. Worker threads (`node:worker_threads`, flags inherited) load the repository's storage code and node:sqlite under `--frozen-intrinsics`: eight workers racing to set KILL on one file gave exactly one "set" and seven "already", and the audit chain verified. A child process started with the same flags sets KILL on the file and an open handle in the parent sees it at its next read. `randomBytes`, `randomUUID` and `getRandomValues` of node:crypto work under `--frozen-intrinsics --disallow-code-generation-from-strings` in the main process, a worker and a child process, and core/rng.ts makes a 32-byte key and ids of the right shapes in a child process | local scratch runs of the pinned Node (linux-x64, SQLite 3.54.0) on temp files (scratchpad scratch-6d) | 2026-11-19 | HIGH (Linux); Windows UNVERIFIED |
| TypeScript | Latest 7.0.2 (native compiler); typescript-eslint 8.72.1 supports TS < 6.1, so pin 6.0.3; type stripping is stable in Node 24/26 for erasable syntax | npm registry, Node docs | 2026-11-04 | HIGH |
| Solana libraries | `@solana/kit` 8.6.0 (provenance); `@solana-program/*` (system 0.16.0, token 0.18.0, token-2022 0.20.0, compute-budget 0.20.0). `@solana/web3.js` latest is now 3.1.1 (built on Kit); 1.x gets critical fixes only. web3.js 1.x cannot sign v1 txs | npm registry | 2026-11-04 | HIGH |
| pump.fun SDKs | `@pump-fun/pump-sdk` 4.3.1 / `pump-swap-sdk` 2.2.0 pull web3.js 1.x + Anchor, no provenance, one pinned dependency without a repository field: avoid for now | npm registry | 2026-11-04 | HIGH |
| Other candidates | grammy 1.46.0 (current); telegraf: no release since 2024-02-29; zod 4.6.7 (use >= 4.6.6); no candidate's latest version has install scripts or an open advisory | npm registry + advisory feed | 2026-11-04 | HIGH |
| npm hardening | `min-release-age` (cooldown, npm 11.10+), `allowScripts`/`strict-allow-scripts` (11.16+); npm 12 blocks dependency install scripts by default | npm/cli source and changelog | 2026-11-04 | HIGH |
| Incidents | @solana/web3.js 1.95.6/1.95.7 key theft (2024-12-03, ~5 h); chalk/debug and 16 more (2025-09-08); Shai-Hulud worm (2025-09); Solana typosquats (2025-01); fake "pumpfun bot" repo with a poisoned lockfile; axios 1.14.1/0.30.4 (2026-03-31, ~3 h) | GitHub Advisory Database via npm | 2026-11-04 | HIGH / MEDIUM |
| gitleaks | v8.30.1, MIT, now security-patch-only (author moved to Betterleaks); hook command `gitleaks git --pre-commit --redact --staged --verbose`; gitleaks-action is EULA software | gitleaks repo clone | 2026-11-04 | HIGH |

## Superseded assumptions

| Earlier assumption | Where | Now |
|---|---|---|
| 0.9-1.2M FOMO trades/day | brief s.6 | ~0.65M/day (Nov 3-4) |
| Most FOMO trades go through DFlow | brief s.6 | ~54% DFlow |
| Helius Free includes standard websockets (implicitly free) | brief s.6 | included, but metered by data volume |
| Token-account rent about 0.002 SOL | brief s.10, older code | 0.00149-0.00151 SOL |
| Slot ~400 ms, blockhash valid 60-90 s | Solana docs | ~214 ms, ~32 s |
| Public RPC refuses getProgramAccounts | research/data_notes.md (2026-10) | filtered queries now answer |
| Copy delay 2-5 s | brief s.7.1 | still unmeasured (needs the paper engine) |

## UNVERIFIED: design around these

DFlow program ID and fees; Bitquery free tier; Jito tip floor; landing rates and
send-to-confirm latency (need real sends, owner-approved, later); per-trade CU and fee
medians on each venue; graduation-to-pool timing; fee tiers of Raydium AMM v4/CLMM,
Meteora DLMM and Orca; third-party token scanners; Alchemy and QuickNode terms; whether
the public websocket survives 24/7 and what "pubsub-limit 5" counts; Anthropic minimum
purchase; all VPS prices at checkout; Healthchecks.io free-plan Telegram; transitive
npm install scripts; whether Helius allows a personal trading bot.
