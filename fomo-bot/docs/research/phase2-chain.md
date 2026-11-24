# Phase 2 research: chain client facts (JSON-RPC, WebSocket, budget)

Researcher: `researcher` (Claude, read-only). Checked 2026-11-24; live calls 09:50-09:55Z from the
cloud sandbox (shared US egress IP; the public RPC answered from node pit186). Facts are in
`docs/VERIFIED_FACTS.md` section 9; this note gives sources, method and implications.

## Sources (exact versions)

- Docs: github.com/solana-foundation/solana-com at `e52cba1c403b4edbc27144c413a8ad2e9ab1f70e`
  (2026-11-23), `apps/docs/content/docs/en/rpc/` and `references/clusters.mdx` (the source of
  https://solana.com/docs/rpc and /docs/references/clusters). Their trees are byte-identical to
  Phase 0's `1da0a7a` (rpc `ba89828`, references `fd25c7a`): diff later checks against `e52cba1`.
- agave: github.com/anza-xyz/agave tag `v4.4.0` (`9ef6312`, what the public nodes report as
  `apiVersion`) and master `b421011` (2026-11-24): rpc/src/rpc.rs, rpc_pubsub.rs,
  rpc_pubsub_service.rs, rpc_service.rs, rpc-client-api/src/custom_error.rs,
  rpc-client-types/src/{request,response}.rs, account-decoder, runtime/src/prioritization_fee*.rs.
  The docs' "Source" links still point at v3.1.8.
- Crates read from static.crates.io, each sha256 equal to agave's Cargo.lock: jsonrpc-core 18.0.0,
  jsonrpc-http-server 18.0.0, solana-commitment-config 3.1.1, solana-cluster-type 3.2.1 (master
  lock), solana-transaction 5.0.0 (v4.4.0 lock).
- Local: the pinned Node 26.13.0 (V8 14.6.202.34-node.40, undici 8.12.2), scripts in the
  scratchpad `research-chain/node-tests/` (reviver.mjs, fetch-local.mjs, ws-local.mjs; live-http.mjs,
  live-ws.mjs, live-ws2.mjs), run with and without `--frozen-intrinsics
  --disallow-code-generation-from-strings`.

## Live calls (read-only, at least 5 s apart, Retry-After honoured; nothing sent or signed)

13 HTTP calls to api.mainnet-beta.solana.com (getGenesisHash, getSlot x3, getMultipleAccounts x3,
getBlockTime, getRecentPrioritizationFees, getTokenLargestAccounts, getSignaturesForAddress,
getTransaction, getProgramAccounts), 2 WebSocket sessions (about 9 s and 8 s), 2 attempts at
api.mainnet.solana.com (refused by the sandbox proxy). One 429 (getTokenLargestAccounts, expected).
Our mistake: the getProgramAccounts check (owner = pump fee program, no filter) matched 1,063,083
accounts and returned 243 MB of JSON in 28.6 s. It succeeded, but used a large share of the
shared IP's data allowance; the bot must never send such a query.

## What changed since Phase 0 (P1, P3, P4, P5)

- P1: unchanged (docs identical). P6: api.mainnet.solana.com is still refused here (proxy 403).
- P3: unchanged. getTokenLargestAccounts is 429 every time (method limit 0); getProgramAccounts,
  getSignaturesForAddress and getTransaction answer. Header limits are as in Phase 0; newly seen:
  getBlockTime 10, getGenesisHash 150. No getTransaction 429 this time at 5 s spacing.
- P4: unchanged; full -32015 text recorded (VERIFIED_FACTS s.9).
- P5: unchanged, plus: no compression, no server pings in 17 s, subscription ids shared between
  clients, and `pubsub-limit` did not move with the number of subscriptions (most likely counts
  connections, MEDIUM).
- First recorded: nodes run agave 4.4.0; the 429 body is a JSON-RPC error with code 429; master
  (not v4.4.0) dropped the vote-transaction skip in the priority-fee cache; the SPL Token program
  account is now owned by the upgradeable loader (incidental, authority not checked).

## Still UNVERIFIED

- Long-run public WebSocket behaviour: idle timeouts, proxy pings, forced drops, 24/7 survival
  (17 s observed); what the 6th connection gets; slotNotification pacing (median 350 ms in one
  6 s window while HTTP slots advanced about every 217 ms). Phase 7 soak from the VPS.
- The window behind `rps-limit 250` and the header method limits; how the 100 MB/30 s data limit
  is measured (wire or decoded bytes) and what exceeding it returns; the body and length of a 403.
- Not called live (source and docs only): getBlockHeight, getBlockTime's -32004/-32007/-32009 and
  null cases, -32601. The marker logsSubscribe (ARCHITECTURE s.13) was not tested.
- Windows behaviour of fetch and WebSocket (Linux only here); api.mainnet.solana.com (VPS).

## Refusals and blocks met

- gh API for solana-foundation/solana-com and anza-xyz/agave: "GitHub access to this repository
  is not enabled for this session" (HTTP 403); plain `git clone` over HTTPS worked.
- api.mainnet.solana.com:443: egress proxy connect_rejected, HTTP 403.
- Guard hook (not network): twice "Blocked: recursive grep ignores .gitignore and can read .env;
  use the Grep tool." and once "Blocked: a wildcard in this command could match the .env file.
  Name files explicitly."

## Design implications for chain/ (ProviderClient, BudgetGovernor)

1. Parse every body with the source-text reviver: u64 fields become bigint only from digits-only source (reject `1e3`, `-0`, `1.50`); about 31 us per KB, negligible for the FOMO stream.
2. Every call: `AbortSignal.any([AbortSignal.timeout(perMethod), shutdown])`, `redirect: 'error'`, a streaming body reader with a decoded-byte cap per method (no built-in cap; gzip inflated 1,000x), a JSON content-type check.
3. Classify: HTTP 200 + `error` = node error by code; 429 (body code 429, Retry-After) = close that bucket for Retry-After and shed; 403 = provider blocked; other statuses or bad JSON = provider error.
4. Never retry -32600/-32601/-32602 (our bug or unsupported); -32016/-32005 = node behind, wait or switch, never accept stale data; -32004/-32007/-32009/-32014/-32001 = not readable, never a default.
5. Always send commitment and `encoding: base64` (the default is finalized; getAccountInfo defaults to legacy binary); getMultipleAccounts at most 100 keys; keep each batch's one `context.slot` and use minContextSlot so reads never go backwards.
6. Buckets: lower of the documented 40 per method / 100 total per 10 s and the header method limits (getMultipleAccounts 50, fees 20, getBlockTime/getTransaction/getSignaturesForAddress/getProgramAccounts 10, getTokenLargestAccounts 0 = refused locally); data bucket on decoded bytes (100 MB/30 s); learn downward from x-ratelimit-* only.
7. Connections: reuse keep-alive; HTTP and the WebSocket share the 40-connection limit; requests stay under the 50 KiB body cap.
8. getProgramAccounts only with narrow filters and a hard byte cap; plan for slow answers (28.6 s seen), so its 15 s timeout fails closed.
9. Start-up and per provider: getGenesisHash must equal `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`, else refuse; log apiVersion and alert when it changes.
10. WebSocket: one connection with all subscriptions (pubsub-limit likely counts connections); client messages under 4,096 bytes; one address per `mentions`; budget uncompressed bytes (no deflate).
11. Liveness is ours: the node never pings and `close` may never fire, so a slotNotification gap over 5 s (max seen 495 ms) or an unanswered subscribe terminates and reconnects with jitter, then resubscribes (ids change; ids are shared node-wide, so map per connection).
12. The built-in WebSocket has no incoming size cap (70 MB accepted, buffered whole): drop messages over 64 KB after receipt and rely on the memory limit and flood breaker; a frame-level client only if the soak shows huge frames.
13. Priority fees are per-slot floors: one writable account per call, a percentile over the up to 150 slots, then clamp; getBlockTime `null` or an error means no time, never an estimate.
