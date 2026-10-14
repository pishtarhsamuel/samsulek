# Data notes: what each dataset contains, misses, and when it was known

Read this before using any dataset in research. Every claim here was checked on
2026-10-12/13 against the provider's own documentation or a live response, unless
marked **unverified**. A result that ignores these notes is not a result.

General rules for every dataset:
- Stored point-in-time: each row carries `fetched_us` (when we received it). Research
  that simulates a past date must only use rows that were public AND stored by then.
- Revisions are kept as new versions; the old value stays. Never "fix" history by hand.
- Gaps are recorded as gaps. A gap means "not observed", never "nothing happened".

---

## ECB euro reference rates (`data/market/fx`)

- **Source:** ECB Data Portal, dataset EXR (`data-api.ecb.europa.eu`). Free, no key.
  Attribution: "Source: European Central Bank (ECB Data Portal, EXR)".
- **What:** units of USD/GBP/CHF per 1 EUR, one value per TARGET working day,
  from 1999-01-04. A snapshot around 14:10 Frankfurt time, published around 16:00.
- **Point in time:** a rate counts as public from 17:00 Frankfurt on its own day
  (16:00 publication plus one hour). Before 1 July 2016 it was published ~14:30, so
  this is conservative for older data.
- **Gaps by design:** no value on weekends and TARGET holidays. Recent data simply has
  no row; older data (seen for 1999-2001) has a row with an empty value instead. Both
  mean "no rate that day".
- **Revisions:** the ECB may republish a rate (rare). Each `data update` re-downloads
  the last 30 days, so a correction appears as a new version. `latest_fx` and `to_eur`
  answer "as known at the decision time" by default: a correction stored later is never
  used early. For history we downloaded after the fact (the 1999+ backfill) nothing was
  stored "at the time", so the first version we stored stands in for it.
- **Not the broker's rate:** the ECB says the rates are "for information purposes
  only". Trading 212 converts at its own rate and charges an FX fee. Backtests must
  add that cost (and rerun at 2x).
- **Survivorship:** none for USD/GBP/CHF. Asynchronous use: converting a US close
  (22:00 Frankfurt) with that day's 14:10 rate adds noise, but no lookahead.

## Xetra trading calendar (`src/samsulek/data/calendars.py`)

- Holiday rules match `exchange_calendars` 4.13.2 exactly for 2004-2027 (tested), but
  that package is volunteer-maintained and **not** the exchange. Deutsche Boerse's own
  calendar page could not be reached from the build environment (**unverified**).
- The calendar refuses years after `CHECKED_THROUGH_YEAR` (2026). Each December the
  owner compares next year's holidays with the official list, then raises it.
- Daily bars are labeled 10 minutes after the scheduled close (17:40 Berlin, 14:10 on
  the early-close day), because the official close comes from the closing auction.
- **Session times (unverified):** Deutsche Boerse's sites could not be reached from the
  build environment (DNS failure on 2026-10-14), so these come from search-result
  snippets only. Opening auction call from about 08:55 Berlin; continuous trading starts
  between 09:00 and 09:04 depending on the segment (random auction end). Closing auction
  call at 17:30, price around 17:35 (random end); a trade-at-close phase until 17:40
  exists only for DAX/MDAX/SDAX shares. Extended retail hours were added from
  1 December 2025; we do not use them.
- **Backtest execution time:** the backtester fills at the next session's open plus a
  delay, by default **09:05 Berlin**, after every segment's opening auction is over. It
  is a setting, not a constant: once the official times are checked, change the setting,
  not the code.

## ETF daily prices

- **Status: no source yet.** Every free option was checked:
  - justETF: its terms (clause 3.1) forbid automated price downloads. Facts only, by hand.
  - Trading 212 API: no price history at all (checked in the official OpenAPI spec).
  - Deutsche Boerse: unreachable from the build environment.
  - Stooq: blocks cloud servers; must be checked from the owner's PC first.
- **Candidate universe** (all accumulating, EUR lines on Xetra; facts from justETF,
  2026-10-12): VWCE (IE00BK5BQT80, since 2019-07-23), EUNL (IE00B4L5Y983, 2009-09-25),
  SXR8 (IE00B5BMR087, 2010-05-19), IS3N (IE00BKM4GZ66, 2014-05-30), XGLE
  (LU0290355717, 2007-05-22), XEON (LU0290358497, synthetic swap, 2007-05-25), 4GLD
  (DE000A0S9GB0, an ETC, not UCITS, 2007-11-27). Whether Trading 212 offers each one
  is **unverified** until M5.
- **Survivorship:** every candidate is a large fund that still exists. Choosing big,
  broad funds before looking at returns limits the bias but doesn't remove it; there
  is no free list of closed or merged UCITS ETFs. Histories are short (VWCE: 2019), so
  longer tests need proxies, and the gap between proxy and fund must be measured.
- Accumulating funds reinvest dividends, so their price is already a total return;
  splits still need checking per fund.

## Solana new pools (`data/solana`, the recorder)

What is recorded, and from where:

| Stream | Source | Coverage |
|---|---|---|
| `pools` | GeckoTerminal new pools, pages 1-10 | every pool the feed showed us |
| `mint_facts` | Solana RPC, jsonParsed mint | every discovered token |
| `pump_creations` | Solana RPC, signatures of the pump.fun mint authority | counts only |
| `pair_snapshots` | DexScreener pairs | a 25% random sample, at fixed ages |
| `curve_states` | Solana RPC, pump.fun bonding curve | pump.fun pools in the sample |
| `holders` | Solana RPC, token accounts by mint | a 5% random sample |
| `coverage` | the recorder itself | heartbeats and every gap |

Known limits, stated plainly:
- **Discovery is incomplete.** GeckoTerminal's free feed only shows the newest 200
  pools (about 4 minutes) at ~10 calls per minute, while Solana creates roughly 35-55
  new pools per minute (one 8-minute sample, 2026-10-12). When the feed moves past us
  faster than we read it, the recorder writes a `discovery_overrun` gap. The pump.fun
  creation counter measures how many launches the feed missed.
- **Only DEXes GeckoTerminal indexes** are covered (38 Solana venues listed live).
- **Rugs and dead tokens are included** by construction (we record forward, at birth).
  This is the only kind of memecoin data valid for research: never backtest on a list
  of tokens that still exist.
- **Sampling is by a hash of the pool address**, so which pools are followed can't
  depend on how they turned out.
- **Absent is not rugged:** DexScreener returns nothing for pools it doesn't list.
  That is recorded as `pair_missing`, a separate state.
- **On time or not at all:** every snapshot, curve state and holder list labelled
  with a target age was observed within that age's tolerance (2 min, or a quarter of
  the age), checked again when the answer arrived. Anything later is in
  `snapshot_skipped` (`what` = pair/curve/holders, with the reason: `late`,
  `late_answer`, `source_error`, `task_disabled`, `holder_queue_full`, `stopped`), never
  stored under the label. Curve and holder records carry `due_at` and `fetched_at`.
- **Gaps in creation time vs. clock time:** `discovery_overrun` and
  `discovery_incomplete` (a round that failed or was cut off part-way) are gaps in
  pool *creation* time: pools created inside them may never have been seen.
  `not_running`, `source_down` and `task_off` (a task switched off until the next
  restart, e.g. a blocked RPC method) are gaps in *clock* time. Use both.
  `not_running` with `reason: stalled` means the process lived but its loop froze
  (the PC slept with the window open). Gaps flagged `open_at_crash` were closed by
  the next start after an unclean exit, at the last heartbeat. A `stop` event says
  why the run ended (`ctrl_c`, `time_limit`, or `error` with the error).
- **The pump.fun launch counter** starts a new baseline after every restart, so no
  counting window spans downtime.
- **DexScreener has no liquidity figure** for pump.fun bonding-curve and Meteora DBC
  pools; the bonding-curve state from the chain fills that gap for pump.fun.
- **Times:** snapshot values are as of `Date - Age` of the HTTP response (CDN caches up
  to 30-60 s), never our own clock. GeckoTerminal sees a new pool 10 s to ~2 min after
  creation. On-chain reads carry the slot they reflect.
- **No backfill is possible:** none of these sources offers past state for free. If the
  recorder is off, that period is lost; the gap log says so.
- **Untrusted text:** token names and symbols are chosen by whoever made the token.
  They are cut to 40 plain characters; links and descriptions are never stored.
- **Terms:** DexScreener forbids passing its data to third parties: do not publish
  recordings. GeckoTerminal/CoinGecko terms are **unverified** (their docs were
  unreachable); treat recordings as private research.
- **Never used as the universe:** DexScreener's "latest profiles/boosts" feeds are paid
  promotion (about 1% of new pools) and would bias any study toward survivors.
