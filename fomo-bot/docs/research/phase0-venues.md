# Phase 0 research: launchpads, AMMs and base costs

Researcher: `researcher` (Claude), date checked 2026-11-04 (live reads 00:50-00:55 and 09:00-09:09 UTC; SOL price 2026-11-06 23:03 UTC). Blocked from the sandbox (proxy 403/DNS): fomo.family (never contacted), bitquery.io, docs.meteora.ag, docs.raydium.io, api-v3.raydium.io, dev.orca.so, docs.orca.so, mainnet.block-engine.jito.wtf, api.llama.fi, solscan.io, docs.anza.xyz, spl.solana.com; solana.com answered 429. Re-probed once on 2026-11-06: all still blocked except docs.jito.wtf (200, not re-read; its source repo was used instead). Item 4 (per-transaction measurements) was NOT done: see the last section.

Source keys used in the table (all read-only):
- [PD] https://github.com/pump-fun/pump-public-docs/blob/639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22/ (official pump.fun docs repo, HEAD on 2026-11-04)
- [RPC] https://api.mainnet-beta.solana.com (public JSON-RPC; method and slot given per row)
- [RSDK] https://github.com/raydium-io/raydium-sdk-V2/blob/HEAD/ and [CPS] https://github.com/raydium-io/raydium-cp-swap/blob/HEAD/programs/cp-swap/src/ (fetched 2026-11-04)
- [DBC] https://github.com/MeteoraAg/dynamic-bonding-curve/blob/HEAD/ and [DAMM] https://github.com/MeteoraAg/damm-v2/blob/HEAD/ (fetched 2026-11-04)
- [ORCA] https://github.com/orca-so/whirlpools/blob/HEAD/README.md
- [SOLDOCS] https://github.com/solana-foundation/solana-com/blob/1da0a7a4b974aac992a86ed02e23a8475c89286f/apps/docs/content/docs/en/core/fees/ (source of https://solana.com/docs/core/fees)
- [JITO] https://github.com/jito-labs/jito-docs/blob/9b923b88c07492eaa5804bfbed88edfcff36c51a/docs/source/lowlatencytxnsend.md (source of https://docs.jito.wtf/lowlatencytxnsend/)
- [T22] https://github.com/solana-program/token-2022/blob/f052d0aa91884157861bd724b70c016026517697/program/src/processor.rs
- [GT] https://api.geckoterminal.com/api/v2/networks/solana/ (new_pools, dexes/{id}/pools)

## Facts

| # | Fact | Value | Source URL | Checked | Confidence | How confirmed |
|---|---|---|---|---|---|---|
| 1 | pump.fun bonding-curve program | 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P, executable, upgradeable loader (pump.fun can change it any time) | [PD] docs/PUMP_PROGRAM_README.md; [RPC] | 2026-11-04 | HIGH | docs + live getMultipleAccounts, slot 465,244,606 (~09:05 UTC) |
| 2 | PumpSwap (pump AMM) program | pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA, executable, upgradeable | [PD] docs/PUMP_SWAP_README.md; [RPC] | 2026-11-04 | HIGH | docs + live getMultipleAccounts, slot 465,244,606 |
| 3 | pump fee program (holds fee tiers) | pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ, executable; FeeConfig PDAs ["fee_config", program id]: curve 8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt, PumpSwap 5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx | [PD] idl/pump_fees.json, idl/pump.json; [RPC] | 2026-11-04 | HIGH | IDL seeds, PDAs derived offline, accounts read live |
| 4 | pump.fun bonding-curve fee, per side | 1.25% = protocol 0.95% + creator 0.30% + LP 0. The curve FeeConfig has ONE tier (threshold 0): NOT market-cap dependent on the curve | [RPC] FeeConfig 8Wf5...VwTt; [PD] docs/FEE_PROGRAM_README.md | 2026-11-04 | HIGH | live getMultipleAccounts slot 465,244,853, decoded with IDL pump_fees.json |
| 5 | Buyback part of the protocol fee | Global.buyback_basis_points = 5000: half of the protocol fee is paid out in the trade as "buyback"; it is part of the 0.95%, not an extra fee | [PD] docs/instructions/SWEEP_FEES.md; [RPC] Global | 2026-11-04 | HIGH | docs text + live Global decode (slot 465,244,853) |
| 6 | PumpSwap fees, canonical (graduated pump) pools | Market-cap tiers, 25 of them: 1.25% (LP 0.02 / protocol 0.93 / creator 0.30) below 420 SOL mcap; 1.20% at 420-1,470 SOL; 1.15% at 1,470-2,460; ... 1.00% at 4,420-9,820; ... 0.30% (0.20/0.05/0.05) at >= 98,240 SOL. Identical to the 2025-09-01 table in [PD] docs/fees.png | [RPC] FeeConfig 5PHi...aTjx; [PD] docs/FEE_PROGRAM_README.md | 2026-11-04 | HIGH | live decode slot 465,244,853 |
| 7 | PumpSwap fees, non-canonical pools | flat 0.30% (LP 0.25 + protocol 0.05, creator 0); "exotic" flat 0.30% (0.20/0.05/0.05); legacy GlobalConfig ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw: LP 20, protocol 5, creator 5 bps, disable_flags 0 | [RPC]; [PD] idl/pump_amm.json | 2026-11-04 | HIGH | live decode slot 465,244,853 |
| 8 | Canonical pool definition and address | pool.creator == PDA("pool-authority", mint) under the pump program; pool = PDA("pool", u16 index 0, pool_authority, base_mint, quote_mint) under PumpSwap; LP mint PDA("pool_lp_mint", pool) | [PD] idl/pump.json (migrate, migrate_v2); docs/FEE_PROGRAM_README.md | 2026-11-04 | HIGH | IDL PDA seeds (SDK/IDL source) |
| 9 | Curve start parameters (Global 4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf) | virtual SOL 30; virtual tokens 1,073,000,000; real tokens 793,100,000; supply 1,000,000,000 (6 decimals); create_v2 enabled; max_curve_depth 2 | [RPC]; [PD] docs/PUMP_PROGRAM_README.md | 2026-11-04 | HIGH | live decode slot 465,244,853 |
| 10 | Graduation trigger | curve.complete set at the end of the buy that makes real_token_reserves == 0; then every curve trade fails (BondingCurveComplete) until migration | [PD] docs/PUMP_PROGRAM_README.md, docs/SYNTHETIC_MIGRATION.md | 2026-11-04 | HIGH | docs |
| 11 | Graduation size (SOL-paired, non-mayhem coin) | ~85.0 SOL real SOL raised (fees excluded); implied market cap ~411 SOL at completion, i.e. just under PumpSwap's 420 SOL tier: a fresh pool charges 1.25% | computed from row 9 | 2026-11-04 | MEDIUM | arithmetic on live parameters; no live migration examined |
| 12 | Migration mechanics | migrate / migrate_v2 are permissionless and idempotent; they create the canonical PumpSwap pool and burn the LP tokens; pool_migration_fee 15,000,001 lamports (0.015 SOL) comes out of the curve's SOL, not from traders; v3 buys may overshoot into the future pool ("synthetic migration") | [PD] docs/PUMP_PROGRAM_README.md, docs/SYNTHETIC_MIGRATION.md; [RPC] Global | 2026-11-04 | HIGH | docs + live Global |
| 13 | Time from curve completion to tradable pool | not measured | - | - | UNVERIFIED | see last section |
| 14 | Token program of new pump.fun mints | create_v2 makes a Token-2022 mint, 6 decimals, metadata pointer set to the mint itself; other extensions not checked live | [PD] docs/instructions/COIN_CREATION.md | 2026-11-04 | HIGH (docs) | docs |
| 15 | Recommended CU limit, pump buy/sell | static 100,000 CU (CU use varies with mint/user PDA bumps) | [PD] docs/FAQ.md | 2026-11-04 | HIGH | docs |
| 16 | pump.fun launches | ~19.4 creations/min (~28k/day): the mint-authority PDA TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM had 1,000 signatures in 51.6 min, 4% failed | [RPC] | 2026-11-04 | HIGH (crude) | live getSignaturesForAddress, newest 09:07:51 UTC |
| 17 | Launchpad share, live sample | new pools seen by GeckoTerminal 00:44-00:49 UTC (146 pools, 2 of 10 pages lost to 429): pump-fun 68.5%, meteora-damm-v2 16.4%, pumpswap 6.8%, meteora-dbc 4.8%, raydium-launchlab 1.4%, bags-fm 0.7%, raydium-clmm 0.7%, orca 0.7% | [GT] new_pools?page=1..10 | 2026-11-04 | MEDIUM | live API; small and incomplete sample |
| 18 | Launchpad share, reports | Bitquery (1 Nov 2025 - 7 Oct 2026): pump.fun made 78% of ~11.5M new Solana tokens (65% Nov -> 90% Aug); 1 in 58 graduate; 79% of pump.fun tokens trade only on day one. Blockworks Bonk Q3 2026 report: pump.fun 92.8% of bonding-curve share, BONKfun 0.38% (~107 launches/day) | https://bitquery.io/investigations/solana-launchpad-year ; https://solanacompass.com/news/bonk-q3-2026-revenue-falls-to-191m-as-bonkfun-launched-tokens-trade-962m-blockworks-report-shows | 2026-11-04 | MEDIUM (direction) / LOW (numbers) | search summaries only; originals blocked |
| 19 | Raydium LaunchLab (LetsBonk, StonkFun, Raydium) | LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj, executable; owns the pools GeckoTerminal labels letsbonk-fun, raydium-launchlab, stonkfun | [RSDK] src/common/programId.ts; [RPC] | 2026-11-04 | HIGH | SDK + live owner of 9 sampled pools |
| 20 | LaunchLab fees | global config 6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX: trade (protocol) fee 0.25%, migrate fee 0; platform fee on top: letsbonk.fun (FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1) 1.25%, creator 0 -> ~1.5% per side if additive; Raydium platform 0.75%; StonkFun 1.00%; Float 0.60% + 0.15% creator | [RSDK] src/raydium/launchpad/layout.ts; [RPC] | 2026-11-04 | HIGH (values) / MEDIUM (additivity) | live decode slots 465,244,853 and batch 3 |
| 21 | LaunchLab graduation | a graduated letsbonk SOL pool shows 85 SOL raised (totalFundRaisingB) and migrateType 1 = Raydium CPMM; letsbonk's post-graduation CPMM config (index 15): 0.50% trade fee + 0.75% creator fee | [RPC]; [RSDK] layout.ts | 2026-11-04 | MEDIUM | one pool decoded live |
| 22 | Meteora Dynamic Bonding Curve (DBC) | dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN, executable; owns pools labelled meteora-dbc, bags-fm, moonshot (Moonshot now launches on DBC) and clanker-solana | [DBC] README.md; [RPC] | 2026-11-04 | HIGH | README + live owner of 10 sampled pools |
| 23 | DBC fees and graduation | per-partner config: base fee 0.25% min, 99% max (fee schedulers / anti-sniper fees can start very high); protocol takes 20% of the trading fee (a referral host gets 20% of that); graduates to DAMM v2 at a partner-set migration_quote_threshold; migrated-pool fee 0.25/0.3/1/2/4/6% or custom 0.1-10%; SPL or Token-2022 per config | [DBC] README.md, programs/dynamic-bonding-curve/src/constants.rs | 2026-11-04 | HIGH (source) | program source; per-pool values must be read live |
| 24 | Meteora DAMM v2 | cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG, executable; pool fee 0.01% min, 50% (v0) / 99% (v1) max, fee scheduler up to 1 day; protocol 20% of fee | [DAMM] README.md, programs/cp-amm/src/constants.rs; [RPC] | 2026-11-04 | HIGH | source + live |
| 25 | Meteora DLMM | LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo owns the pools GeckoTerminal labels meteora; fee tiers not checked | [RPC] | 2026-11-04 | HIGH (id) | live owner of 3 pools |
| 26 | Raydium CPMM | CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C, executable; AmmConfig PDA ("amm_config", u16 big-endian); live configs: #0 0.25%, #1 1%, #2 2%, #3 4%, #4 0.5%, #5 0.3%, #11 0.25% + 1% creator, #13 0.03% + 0.97% creator, #15 0.5% + 0.75% creator; protocol 12% and fund 4% of the trade fee; creator fee only if the pool has enable_creator_fee; pool creation fee 0.15 SOL; trade fee rounded up | [CPS] lib.rs, states/config.rs, curve/fees.rs, states/pool.rs; [RPC] | 2026-11-04 | HIGH | source + live decode |
| 27 | Raydium AMM v4 and CLMM | 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 and CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK, executable; fees not checked | [RSDK] programId.ts; [RPC] | 2026-11-04 | HIGH (ids) | SDK + live |
| 28 | Orca Whirlpools | whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc, executable; fee tiers not checked | [ORCA]; [RPC] | 2026-11-04 | HIGH (id) | README + live |
| 29 | Minor launchpads (live activity) | Boop boop8hVGQGqehUK2iVEMEnMrL5RbjywRzHKBmBE7ry4: last 1,000 tx span ~121 days (near dead); Moonit MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG (the old Moonshot program): ~0.1 tx/min; memefun MEME4gfGe6itEpxgM1xaBVmiFF5XuCTc4oVXUE5w56F: 3.7 tx/min, 996 of 1,000 failed; Wavebreak waveQX2yP3H1pVU8djGvEHmYg8uamQ84AuyGtpsrXTF: not measured (429); Heaven: GeckoTerminal lists it but returned 0 pools | [RPC]; [GT] | 2026-11-04 | HIGH (ids as pool owners) | live owners + getSignaturesForAddress |
| 30 | Base fee and priority fee | 5,000 lamports per signature (50% burned) + priority fee = ceil(CU price in micro-lamports x requested CU limit / 1,000,000), 100% to the validator, paid on the LIMIT not the use, and paid even when the tx fails; default limit 200,000 CU per non-builtin instruction, max 1,400,000 | [SOLDOCS] fee-structure.mdx, compute-budget.mdx | 2026-11-04 | HIGH | official docs source |
| 31 | Rent-exempt minimum (live) | now (128 + bytes) x 5,080 lamports: 0 B 650,240; 165 B (SPL token account) 1,488,440; 170 B (Token-2022 account + ImmutableOwner) 1,513,840; 182 B (+ TransferFeeAmount) 1,574,800. Rent sysvar shows only lamportsPerByte 5080. The old 2,039,280 (165 B) used in many guides is out of date | [RPC] getMinimumBalanceForRentExemption x4; getMultipleAccounts(SysvarRent) slot 465,245,345 | 2026-11-04 | HIGH | live calls |
| 32 | Associated Token Account program | ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL, executable, BPFLoader2 (not upgradeable) | [RPC] | 2026-11-04 | HIGH | live |
| 33 | Token programs | SPL Token TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA and Token-2022 TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb executable; SPL Token is now owned by the upgradeable loader (36-byte account), reason not checked | [RPC] | 2026-11-04 | HIGH (observation) | live |
| 34 | Wrapped SOL | native mint So11111111111111111111111111111111111111112 (82-byte mint owned by SPL Token); a wSOL account is a 165-byte token account (rent 1,488,440); closing it returns balance + rent. pump.fun curve trades use native SOL (no wSOL); PumpSwap/CPMM use a wSOL account the SDK wraps and unwraps | [RPC]; [PD] README.md, docs/instructions/MULTI_HOP_SWAP.md | 2026-11-04 | HIGH (ids) / MEDIUM (flow) | live + docs |
| 35 | Closing a token account | refunds ALL its lamports to the destination; blocked by a non-zero token balance (non-native), CPI Guard (close via CPI), confidential-transfer state, or withheld Token-2022 transfer fees (harvest first) | [T22] process_close_account | 2026-11-04 | HIGH | program source |
| 36 | Jito tips | 8 tip accounts = PDAs "TIP_ACCOUNT_0".."_7" of T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt (executable); list matches docs; minimum tip 1,000 lamports; docs suggest a 70/30 priority-fee/tip split | [JITO]; [RPC] | 2026-11-04 | HIGH | docs source + live owner check + offline PDA derivation |
| 37 | SOL/USD | 90.04 at 2026-11-06 23:03:52 UTC | https://api.geckoterminal.com/api/v2/simple/networks/solana/token_price/So11111111111111111111111111111111111111112 | 2026-11-06 | LOW | one aggregator reading |
| 38 | Per-buy CU used, CU price, total fee, ATA-in-tx, Jito tips (pump curve, PumpSwap, CPMM, LaunchLab) | not measured | - | - | UNVERIFIED | see last section |

## Measurements

Activity, live getSignaturesForAddress (limit 1,000 each, newest blocks 09:07:50-09:08:27 UTC, 2026-11-04). Rate = 999 / span. A crude snapshot: for the busiest programs 1,000 signatures cover only 5-9 seconds. "Failed" counts every failed transaction that referenced the program (mostly competing bots).

| Program | Span of last 1,000 tx | tx/min | Failed |
|---|---|---|---|
| pump.fun curve | 9 s | ~6,660 | 72% |
| pump.fun creations (mint authority) | 3,096 s | ~19.4 | 4% |
| PumpSwap | 5 s | ~12,000 | 19% |
| Raydium LaunchLab | 1,176 s | ~51 | 27% |
| Raydium CPMM | 374 s | ~160 | 15% |
| Raydium AMM v4 | 165 s | ~363 | 12% |
| Raydium CLMM | 54 s | ~1,110 | 32% |
| Meteora DLMM | 37 s | ~1,620 | 41% |
| Meteora DAMM v2 | 24 s | ~2,500 | 7% |
| Orca Whirlpools | 44 s | ~1,360 | 32% |
| Meteora DBC, Wavebreak | not measured: HTTP 429 twice each | - | - |

RPC use: 28 of my 150-call budget (24 answered; getSignaturesForAddress for DBC and Wavebreak got HTTP 429 at ~09:08 UTC, retried once each after 10 s, still 429). No 403 from the RPC. GeckoTerminal answered HTTP 429 to 2 of 10 new_pools pages and to 9 of 31 dex-pool requests (retried once). Raw data: /tmp/claude-0/-home-user-samsulek/af2c66d8-107c-5a6c-8be8-9b8569253c0e/scratchpad/venues/out/ (rpc_batch1-4.json, rpc_sigs.json, gt_*.json).

Per-transaction costs (item 4) were not measured: the work was cut short by usage limits. A ready read-only script is at /tmp/claude-0/-home-user-samsulek/af2c66d8-107c-5a6c-8be8-9b8569253c0e/scratchpad/venues/scripts/rpc_tx.py (getTransaction on ~20 recent successful transactions per venue; decodes pump TradeEvent / PumpSwap BuyEvent fees, CU limit/price, ATA creation, Jito tips).

## Worked cost example

Position 0.03 SOL = 30,000,000 lamports (~$2.70 at row 37). One signature per transaction. Because item 4 was not measured, network fees are two stated ASSUMPTIONS, not measured median/p75:
- S1 calm: priority 10,000 lamports (100,000 CU limit x 100,000 micro-lamports/CU), no tip -> 15,000 lamports per tx.
- S2 busy: priority 150,000 lamports (150,000 CU x 1,000,000 micro-lamports/CU) + 10,000 lamports Jito tip -> 165,000 lamports per tx.
- Slippage ASSUMPTION: 1% adverse fill per leg (price impact plus movement while the tx lands). The impact alone of 0.03 SOL on a fresh pump curve (30 virtual SOL) is ~0.1%; the rest is other traders.
- Venue fee on the sell is charged on the proceeds. Price is assumed flat, so the totals are pure cost.
- Rent: the token ATA is paid at the buy and refunded only when closed after a full exit (closed inside the last sell). A wSOL helper account (PumpSwap/CPMM) is opened and closed in the same tx: net 0, but it needs 1,488,440 lamports of free balance.

Full exit (buy, then one sell that also closes the ATA): 2 transactions.

| Venue (fee per side) | Venue fees | Slippage | Network S1 / S2 | Total S1 | Total S2 |
|---|---|---|---|---|---|
| (a) pump.fun curve (1.25%) | 737,943 (2.46%) | 589,538 (1.97%) | 30,000 / 330,000 (0.10% / 1.10%) | 1,357,481 = 4.52% | 1,657,481 = 5.52% |
| (b) PumpSwap canonical, mcap < 420 SOL (1.25%) | 737,943 (2.46%) | 589,538 (1.97%) | same | 4.52% | 5.52% |
| (b') PumpSwap, mcap 420-1,470 SOL (1.20%) | 708,602 (2.36%) | 589,836 (1.97%) | same | 4.43% | 5.43% |
| (c) Raydium CPMM config #0 (0.25%, creator fee off) | 148,324 (0.49%) | 595,508 (1.99%) | same | 773,831 = 2.58% | 1,073,831 = 3.58% |
| (c') CPMM letsbonk config #15 (0.50% + 0.75% creator) | 737,943 (2.46%) | 589,538 (1.97%) | same | 4.52% | 5.52% |

ATA rent while the token is held: 1,513,840 lamports for a Token-2022 mint (5.05% of the position) or 1,488,440 for an SPL mint (4.96%). It comes back only after a full exit plus close.

Partial exit (buy; sell 50%; sell 40%; keep a 10% moonbag): 3 transactions, ATA cannot be closed.

| Venue | Costs S1 | Costs S2 | Plus locked ATA rent -> S1 / S2 |
|---|---|---|---|
| (a)/(b) 1.25% | 1,306,858 = 4.36% | 1,756,858 = 5.86% | +1,513,840 (5.05%) -> 9.40% / 10.90% |
| (c) CPMM 0.25% | 751,873 = 2.51% | 1,201,873 = 4.01% | +1,488,440 (4.96%) -> 7.47% / 8.97% |

The moonbag is worth 3,000,000 lamports at entry and its account rent is half of that. Each extra sell costs 15,000 (S1) to 165,000 (S2) lamports, i.e. 0.05-0.55% of the original position (up to 1.4% of a 40% slice). Sensitivity: each extra 1% of slippage per leg adds ~2% to a round trip; the 2x-cost rerun adds ~0.1% (S1) or ~1.0% (S2) from fees alone.

## What this means for the bot

- The 5% rule is met on pump.fun and PumpSwap only when the network is calm AND slippage stays near 1% per leg: venue fees alone are ~2.5% per round trip (1.25% each side). In busy conditions (S2) the same trade costs ~5.5% and fails the rule. Every extra 1% of slippage per leg breaks it.
- "Graduation" entries do not get cheaper fees: a pump.fun coin graduates at a ~411 SOL market cap, below PumpSwap's 420 SOL tier, so the new pool charges the same 1.25% as the curve. Fees fall only as the coin grows (1.00% from ~4,420 SOL, 0.30% from ~98,240 SOL).
- At 0.03 SOL, account rent is the hidden cost: ~5% of the position sits in the token account until it is closed. Moonbags break the 5% rule outright (7.5-11% including locked rent). Suggest: no moonbags at this size; always sell 100% and close the account in the same transaction; budget the close of any dust (burn + close) as one more transaction.
- Rent dropped (5,080 lamports/byte now, vs the 6,960 assumed in older code and guides): never hard-code rent; call getMinimumBalanceForRentExemption.
- Failed transactions are common: 72% of transactions touching the pump program failed in the sample (19% on PumpSwap). Each failed attempt still pays its fee: 0.05% (S1) to 0.55% (S2) of a 0.03 SOL position per attempt. The simulator must charge them.
- pump.fun keeps changing (v2/v3 trade instructions, buyback, holder rewards, pump-coin quote pairs in 2026) and all its programs are upgradeable. Read fees from the on-chain FeeConfig every run and fail closed on any unknown account layout.
- Meteora DBC pools (Bags, Moonshot, Clanker and others) can charge up to 99% at launch through fee schedulers: an early "second wave" entry there must read the pool's current fee first, or skip DBC entirely.
- Launch flow is concentrated: pump.fun is ~70-90% of new tokens; LetsBonk/LaunchLab is small; Boop and Moonit are near dead. Raydium CPMM 0.25% pools are much cheaper (~2.6% round trip) but they are not launch tokens.
- Brief conflict: at $90/SOL (row 37), $3-5 trades are 0.033-0.056 SOL, and 0.02-0.03 SOL is only $1.80-2.70. Bigger trades shrink the fixed costs (rent, network) as a % but not venue fees or slippage.

## UNVERIFIED and how to confirm

1. Item 4, per-transaction costs (CU used, CU price, total fee, ATA created in the tx, Jito tips; medians and ranges for about 10 buys per venue): run the ready script above (~80 RPC calls), or log them from the bot's own recorder. Until then the network costs above are assumptions.
2. Time from curve completion to a tradable PumpSwap pool, and a live migration example: getSignaturesForAddress on a recently completed bonding curve (or the withdraw authority 39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg), then compare the block times of CompleteEvent and CompletePumpAmmMigrationEvent.
3. Token-2022 extensions on new pump.fun mints and the real ATA size (170 B assumed): getAccountInfo (jsonParsed) on a new mint, and the createAccount space inside a first buy.
4. LaunchLab fee additivity (0.25% + platform 1.25%): read the curve math in raydium-sdk-V2 src/raydium/launchpad, or decode a LaunchLab trade event.
5. Fee tiers of Raydium AMM v4 (0.25% is often cited), CLMM, Meteora DLMM and Orca: read the program sources or the pool accounts live.
6. Meteora DBC and Wavebreak activity (RPC 429), and the DBC fee configs of Bags, Moonshot, Believe and Jupiter Studio: getSignaturesForAddress plus reading the configs of sampled pools.
7. Heaven: program id and activity (GeckoTerminal returned no pools); needs its docs or one sampled pool.
8. Why rent is now 5,080 lamports/byte and why SPL Token is now upgradeable-loader-owned: the Agave feature set or the SIMD repository. The values themselves are live and HIGH.
9. The user_volume_accumulator account in pump buys: whether a wallet's first buy creates it (a one-time rent): check the IDL and a wallet's first trade.
10. Launch-share figures (Bitquery, Blockworks): read the original reports (bitquery.io is blocked here).
11. SOL/USD: one GeckoTerminal reading; cross-check with a second source before using it for sizing.
