# Step 7 design: chain/ (the chain clients and the budget governor)

Architect, 2026-11-24. Design only, no code. Facts used: `docs/VERIFIED_FACTS.md` s.3, s.4, s.5 and
s.9 (`docs/research/phase2-chain.md`). Everything else is marked UNVERIFIED (s.12).

## 0. In plain English

This step builds the part of the bot that reads the Solana blockchain over the internet. It only reads:
it cannot send, and it never signs anything. A "budget governor" counts every request, so the bot stays
well under the free public server's limits. Requests for exits and prices always get through ahead of
everything else. Anything odd in an answer (wrong shape, too big, too old, the wrong network) is refused
and counts as "no data", never as a guess, and new buys stop. A live connection watches each new block;
if it goes quiet for 5 seconds, the bot reconnects. The bot also compares its own clock with the
chain's time. No owner decision is needed for this step.

## 1. Facts used

Every number below comes from VERIFIED_FACTS s.9 and its 13 design implications (limits, header
limits, the 429 body, HTTP 200 for every JSON-RPC answer, the error codes, the u64 digits and the
reviver, fetch and WebSocket without size caps, `close` that may never fire, the node never pinging, the
4,096-byte client frame limit, the commitment defaults, 100 keys per getMultipleAccounts, 150 fee floors,
the genesis hash). It also uses s.3 (rent: (128 + bytes) x 5,080 lamports), s.4 (a blockhash lives 150
blocks; expiry goes by block height) and s.5 (simulate with `sigVerify: false` needs only a funded fee
payer). The window behind the header limits is UNVERIFIED and assumed to be 10 s.

## 2. Files

| File | Holds | Rules |
|---|---|---|
| core/json.ts, core/solana.ts, core/encode.ts (+) | lossless parse and stringify; `Address`, `Signature`, `Slot`, `BlockHeight` brands; strict base58 and base64 decoders (canonical forms only) | pure (core) |
| core/clock.ts | `systemWall`, `systemMono`, `systemTimers` | the clock-exempt file; runtime import by cli/ only |
| chain/limits.ts, chain/providers.ts | `METHOD_TABLE` and our caps (frozen, pinned by a test); `PUBLIC_MAINNET`, `MAINNET_GENESIS_HASH` | pure |
| chain/budget.ts, chain/rpc.ts, chain/decode.ts | the governor; request encoding, envelope and error classification; one strict decoder per method | pure; injected `MonoClock` |
| chain/client.ts, chain/ws.ts | the paper `ReadClient` (given an `HttpTransport`); the stream state machine (given a `SocketFactory`) | pure |
| chain/time.ts, chain/expiry.ts | `toChainTime` (contract 8's reading, used by `chainTime`); `provablyExpired` | pure |
| chain/http.ts, chain/ws-socket.ts | the only file naming `fetch`; the only file naming `WebSocket` | network files |
| app/time-guard.ts | the production `TimeGuard` and the `GuardedClock` | app/ |

"Pure" means the existing PURE rules of `tests/architecture/import-graph.test.ts`: no timers, no
`process`, no clock, plain ECMAScript globals only. Timeouts, timers, jitter and clocks are passed in,
so every chain/ test is deterministic. Only the two network files touch the outside world.

## 3. Interfaces and types

Every field is `readonly` and every returned object frozen (left out below for width).

```ts
// ---- core/json.ts
export type Json = null | boolean | string | number | bigint | readonly Json[] | { [k: string]: Json };
/** JSON.parse with the source-text reviver: a number whose source matches /^-?(0|[1-9][0-9]*)$/ and is not
 *  "-0" becomes a bigint; any other number (1e3, 1.50, -0) stays a JS number, which no integer field accepts.
 *  Throws SyntaxError (a RangeError from deep nesting is rethrown as one). */
export function parseLossless(text: string): Json;
export function stringifyLossless(v: Json): string;   // bigint as digits through JSON.rawJSON

// ---- core/solana.ts (the makers throw TypeError and never echo the value)
export type Address = string & { __kind: 'address' };          // canonical base58 of exactly 32 bytes
export type Signature = string & { __kind: 'signature' };      // canonical base58 of exactly 64 bytes
export type Slot = bigint & { __unit: 'slot' };                // 0 .. 2^63 - 1
export type BlockHeight = bigint & { __unit: 'block-height' }; // never mixed with Slot (expiry vs tokens)
export function address(v: unknown): Address;  export function signature(v: unknown): Signature;
export function slot(v: unknown): Slot;        export function blockHeight(v: unknown): BlockHeight;

// ---- core/clock.ts (runtime import by cli/ only)
export interface WallClock { now(): number }   // UTC ms, the shape of app/slots.ts Clock
export interface MonoClock { nowMs(): number } // monotonic ms
export interface Timers { timeoutSignal(ms: number): AbortSignal; after(ms: number, fn: () => void): () => void }

// ---- chain/limits.ts and chain/providers.ts
export type ProviderId = 'public-mainnet';      // a code: the only provider name that reaches events
export type Priority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
export type ReadMethod = 'getGenesisHash' | 'getSlot' | 'getBlockHeight' | 'getBlockTime' | 'getMultipleAccounts'
  | 'getRecentPrioritizationFees' | 'getMinimumBalanceForRentExemption'
  | 'getSignaturesForAddress' | 'getTransaction' | 'simulateTransaction' | 'getProgramAccounts'; // last four: 7h
export interface MethodRule { capPer10s: number; p0Reserve: number; timeoutMs: number; maxResponseBytes: number;
  mostUrgent: Priority }                        // the most urgent priority allowed; getProgramAccounts: 'P1'
export const METHOD_TABLE: Readonly<Record<ReadMethod, MethodRule>>;   // s.5, pinned by a test
export const REFUSED_METHODS: readonly string[];                      // ['getTokenLargestAccounts']
export interface ProviderEndpoint { id: ProviderId; httpUrl: string; wsUrl: string;
  secretParts: readonly string[] }              // empty for the public endpoint (D3)
export const PUBLIC_MAINNET: ProviderEndpoint;  // https://api.mainnet-beta.solana.com, wss://api.mainnet-beta.solana.com/
export const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

// ---- chain/budget.ts
export type ShedLevel = 0 | 1 | 2 | 3;          // 1: P4 off; 2: + P3; 3: + P2. P0 and P1 are never shed
export type DenyReason = 'refused-method' | 'shed' | 'method-cap' | 'total-cap' | 'data-cap'
  | 'connections' | 'retry-after' | 'blocked';
export interface Ticket { __ticket: unique symbol }  // opaque, single use
export type Grant = { ok: true; ticket: Ticket } | { ok: false; reason: DenyReason; retryAtMs: number };
export interface RateHeaders {                  // parsed in chain/http.ts from digits only, else null
  methodLimit: number | null;                   // x-ratelimit-method-limit (the exact recorded name)
  methodRemaining: number | null;               // x-ratelimit-method-remaining (may be negative)
  retryAfterSec: number | null }                // retry-after, delta-seconds only
export interface BudgetGovernor {
  acquire(method: ReadMethod, p: Priority): Grant; // 1 request, 1 connection slot, maxResponseBytes reserved
  settle(t: Ticket, s: { decodedBytes: number; status: number | null; rate: RateHeaders | null }): void;
  chargeStream(bytes: number): void;            // WebSocket bytes, after receipt
  shedLevel(): ShedLevel; usage(): readonly BucketUsage[] }  // health, the 80% alert, the daily report
export function createBudgetGovernor(o: { provider: ProviderId; mono: MonoClock; events: ChainEvents }): BudgetGovernor;

// ---- chain/http.ts (network file); never throws, never rejects
export type HttpOutcome =
  | { kind: 'response'; status: number; rate: RateHeaders; bodyText: string | null; bytes: number } // text: 200 + JSON type
  | { kind: 'timeout' | 'shutdown' | 'transport' | 'too-large' | 'content-type' | 'utf8'; bytes: number };
export interface HttpTransport { post(r: { bodyText: string; timeoutMs: number; maxBytes: number }): Promise<HttpOutcome> }
export function createHttpTransport(o: { endpoint: ProviderEndpoint; timers: Timers; shutdown: AbortSignal }): HttpTransport;

// ---- chain/rpc.ts, chain/decode.ts, chain/client.ts
export type ChainFailure =
  | { kind: 'unverified' | 'wrong-cluster' | 'blocked' | 'shutdown' | 'timeout' | 'transport' | 'too-large' }
  | { kind: 'denied'; reason: DenyReason; retryAtMs: number } | { kind: 'rate-limited'; retryAtMs: number }
  | { kind: 'http'; status: number }
  | { kind: 'bad-response'; code: 'content-type' | 'utf8' | 'json' | 'envelope' | 'id' | 'shape' | 'count' | 'went-back' }
  | { kind: 'our-bug'; code: number }           // s.4's table; HTTP 400/405/413/415
  | { kind: 'node-behind'; code: -32016 | -32005; nodeSlot: Slot | null }
  | { kind: 'not-readable'; code: -32001 | -32004 | -32007 | -32009 | -32011 | -32014 | -32019; permanent: boolean }
  | { kind: 'stale'; contextSlot: Slot } | { kind: 'rpc'; code: number };
export type ChainResult<T> = { ok: true; value: T; contextSlot: Slot | null; latencyMs: number }
  | { ok: false; failure: ChainFailure };
export type Feature = 'boot' | 'exit-marks' | 'plan-reread' | 'slot' | 'expiry' | 'clock' | 'fees' | 'rent'
  | 'safety' | 'anchors' | 'audit' | 'launch' | 'crowdflow' | 'momentum' | 'twins';
export interface CallOpts { priority: Priority; feature: Feature }
export interface Account { lamports: Lamports; owner: Address; executable: boolean; rentEpoch: bigint;
  space: number /* the full length, even with a slice */; data: Uint8Array /* a fresh copy */ }
export interface ReadClient {                   // the paper client: no send, no sign, no generic rpc(method)
  readonly provider: ProviderId;
  verifyCluster(): Promise<ChainResult<'mainnet-beta'>>;                // every other call waits for it
  slot(o: CallOpts): Promise<ChainResult<Slot>>;                        // confirmed; reported as 'http'
  blockHeight(o: CallOpts): Promise<ChainResult<BlockHeight>>;          // confirmed
  finalizedBlockHeight(o: CallOpts): Promise<ChainResult<BlockHeight>>; // only for provablyExpired
  chainTime(o: CallOpts): Promise<ChainTimeReading>;                    // s.8
  accounts(keys: readonly Address[], o: CallOpts & { slice?: { offset: number; length: number } }):
    Promise<ChainResult<readonly (Account | null)[]>>;                  // 1..100 distinct keys, request order
  priorityFees(writable: Address, o: CallOpts): Promise<ChainResult<readonly { slot: Slot; fee: MicroLamportsPerCu }[]>>;
  rentExemptMinimum(dataBytes: number, o: CallOpts): Promise<ChainResult<Lamports>> }
export interface SlotReporter { report(channel: 'stream' | 'http' | 'http-2', slot: unknown): void } // app/slots.ts fits
export interface SlotView { currentSlot(): bigint | null }
export function createReadClient(o: { endpoint: ProviderEndpoint; transport: HttpTransport; budget: BudgetGovernor;
  mono: MonoClock; wall: WallClock; slots: SlotReporter & SlotView; events: ChainEvents }): ReadClient;

// ---- events: codes only; the app maps them to AlertSink, rate-limited (chain/ cannot import app/)
export type ChainEventCode = 'chain-429' | 'chain-blocked' | 'chain-unblocked' | 'chain-shed-up' | 'chain-shed-down'
  | 'chain-budget-80' | 'chain-p0-denied' | 'chain-limit-learned' | 'chain-wrong-cluster' | 'chain-api-version'
  | 'chain-shape' | 'chain-our-bug' | 'chain-stale' | 'chain-rent-formula' | 'chain-ticket-bug' | 'chain-ws-up'
  | 'chain-ws-down' | 'chain-ws-stall' | 'chain-ws-flapping' | 'chain-ws-oversize' | 'chain-ws-unknown-sub'
  | 'chain-time-none';
export interface ChainEvent { code: ChainEventCode; provider: ProviderId; method?: ReadMethod; priority?: Priority;
  apiVersion?: string /* only if /^[0-9]{1,4}(\.[0-9]{1,4}){2}$/ */ }
export interface ChainEvents { event(e: ChainEvent): void }  // every call wrapped in try/catch

// ---- chain/ws.ts (state machine) and chain/ws-socket.ts (the real factory)
export interface SocketHandlers { open(): void; message(data: unknown): void; closed(): void; error(): void }
export interface SocketHandle { send(text: string): boolean; terminate(): void }  // terminate: close() and detach
export type SocketFactory = (url: string, h: SocketHandlers) => SocketHandle;
export type StreamState = 'idle' | 'connecting' | 'subscribing' | 'live' | 'backoff' | 'stopped';
export interface StreamClient { start(): void; stop(): void; state(): StreamState; stats(): StreamStats }
export function createStreamClient(o: { endpoint: ProviderEndpoint; socket: SocketFactory; timers: Timers;
  mono: MonoClock; jitter: () => number /* [0, 1) */; slots: SlotReporter;
  budget: Pick<BudgetGovernor, 'chargeStream'>; events: ChainEvents }): StreamClient;

// ---- chain/time.ts, chain/expiry.ts, app/time-guard.ts
export type ChainTimeReading = { kind: 'time'; slot: Slot; blockTimeMs: number; wallAtMs: number; monoAtMs: number }
  | { kind: 'none'; why: 'null-time' | 'not-readable' | 'failed' | 'implausible' };
export function provablyExpired(lastValid: BlockHeight, finalized: BlockHeight): boolean; // finalized > lastValid
export type GuardedClock = WallClock & { __guarded: unique symbol };   // minted only in app/time-guard.ts
export type TimeVerdict = 'trusted' | 'no-reading' | 'stale-reading' | 'wall-mono-skew' | 'chain-skew';
export function createTimeGuard(o: { raw: WallClock; mono: MonoClock }): { clock: GuardedClock;
  guard: TimeGuard & { verdict(now: number): TimeVerdict }; note(r: ChainTimeReading): void };
```

The paper type has no send capability: `ReadClient` has no `send*`, `requestAirdrop` or generic
`rpc(method)` member, `ReadMethod` has no sending method, and the encoder takes only `ReadMethod`.
Phase 8's sending client is a separate type built in app/ live, never in chain/ (ARCHITECTURE s.3).

## 4. The HTTP path

```mermaid
sequenceDiagram
  participant C as Caller (exit loop)
  participant RC as ReadClient
  participant B as BudgetGovernor
  participant T as HttpTransport
  participant N as Public RPC
  C->>RC: accounts(keys, {P0, exit-marks})
  RC->>RC: verified cluster? keys 1..100, distinct, Address-typed
  RC->>B: acquire(getMultipleAccounts, P0)
  B-->>RC: ticket (or denied: P0 denied -> event, entries off)
  RC->>T: post(body <= 48 KiB, 5 s, 1 MiB)
  T->>N: POST, redirect error, AbortSignal.any(timeout, shutdown)
  N-->>T: 200 application/json, streamed, decoded bytes counted
  T-->>RC: outcome (status, rate headers, text or a failure kind)
  RC->>B: settle(ticket, bytes, status, headers)
  RC->>RC: classify, decode strictly, context.slot >= minContextSlot, staleness
  RC->>RC: slots.report('http', context.slot); apiVersion change -> event
  RC-->>C: ChainResult (never a default value)
```

Transport (chain/http.ts), each rule a test:
- `fetch(httpUrl, { method: 'POST', body, redirect: 'error', credentials: 'omit', signal:
  AbortSignal.any([timers.timeoutSignal(rule.timeoutMs), shutdown]), headers: { 'content-type':
  'application/json', accept: 'application/json' } })`. Keep-alive is undici's default (connection reuse
  UNVERIFIED, U8). No proxy (the VPS needs none).
- Request: `stringifyLossless` text, UTF-8 length at most 49,152 bytes (under the 50 KiB cap); longer
  is refused before acquire as `our-bug` 413.
- Response: a `content-length` over the cap is refused unread. Otherwise `getReader()` counts decoded
  bytes (after undici's inflation); past `maxResponseBytes`: abort, cancel, `too-large`. A 200 needs
  `application/json` (parameters allowed), then `TextDecoder('utf-8', { fatal: true })`. A non-200
  body is read up to 4 KiB and dropped. Every body is consumed or cancelled (the connection returns).
- An abort is `shutdown` if the shutdown signal fired, else `timeout`. Any other rejection (network,
  redirect) is `transport`. The error object is dropped unlogged: undici's messages can name the URL.

Envelope and errors (chain/rpc.ts, pure):
- 200 + text: `parseLossless` (SyntaxError gives `json`). Must be an object with exactly `jsonrpc` ("2.0"),
  `id` (the bigint we sent), and exactly one of `result` or `error`, else `envelope` or `id`.
  `error` = `{ code: bigint, message: string up to 1 KiB, data? }`. The message is never logged or
  alerted: it may echo our parameters.
- Status 429, or a body error code 429: `rate-limited` (Retry-After goes to the governor). 403:
  `blocked`. 400/405/413/415: `our-bug` (never retried, a bug event). Any other status: `http`.

| Codes | Kind | Retried? |
|---|---|---|
| -32700, -32600, -32601, -32602 | our-bug | never: our request is wrong or unsupported; bug event |
| -32015 | our-bug | never: a new transaction version, event "upgrade needed" (ARCH s.12) |
| -32016 (`data.contextSlot`), -32005 (`data.numSlotsBehind`) | node-behind | next tick; the data is never used |
| -32004, -32014, -32001, -32011, -32019 | not-readable, not permanent | next tick |
| -32007, -32009 | not-readable, permanent | never for that slot |
| everything else, -32603 included | rpc | next tick; counts toward the RPC_ERRORS breaker |

chain/ never retries on its own (R5): a failure goes back with `retryAtMs` where known.

## 5. Methods, parameters and limits

Our caps (requests per 10 s, from ARCHITECTURE s.6, with R3): the lower of the documented 40, the
header limit and the table below. Commitment is fixed by chain/, never chosen by a caller (R6):
`confirmed` for every read, so it is "at least as fresh as the stream" (risk 6, the stream is
`confirmed` too). `finalized` is used only inside `chainTime` and `finalizedBlockHeight`.

| Method | Step | Params sent (always explicit) | Cap | P0 | Timeout | Max bytes |
|---|---|---|---|---|---|---|
| getGenesisHash | 7e | `[]` | 1 | 1 | 5 s | 1 KiB |
| getSlot | 7e | `[{commitment, minContextSlot}]` | 6 | 6 | 5 s | 1 KiB |
| getBlockHeight | 7e | `[{commitment, minContextSlot}]` | 2 | 2 | 5 s | 1 KiB |
| getBlockTime | 7g | `[slot]` (takes no commitment) | 1 | 1 | 5 s | 1 KiB |
| getMultipleAccounts | 7e | `[keys<=100, {commitment, encoding:'base64', dataSlice?, minContextSlot}]` | 20 | 8 | 5 s | 1 MiB |
| getRecentPrioritizationFees | 7e | `[[one writable address]]` (no commitment) | 4 | 2 | 5 s | 64 KiB |
| getMinimumBalanceForRentExemption | 7e | `[bytes, {commitment}]` (shape U7) | 1 | 1 | 5 s | 1 KiB |
| getSignaturesForAddress | 7h | `[addr, {commitment, limit<=100, before?, until?, minContextSlot}]` | 3 | 2 | 5 s | 256 KiB |
| getTransaction | 7h | `[sig, {commitment, encoding:'base64', maxSupportedTransactionVersion: 1}]` | 3 | 2 | 5 s | 256 KiB |
| simulateTransaction | 7h | `[tx, {encoding:'base64', commitment, sigVerify:false, replaceRecentBlockhash:true, minContextSlot}]` | 4 | 2 | 5 s | 256 KiB |
| getProgramAccounts | 7h | `[program, {commitment, encoding:'base64', filters (dataSize + 1..4 memcmp), dataSlice, withContext:true, minContextSlot}]` | 4 | 0 | 15 s | 2 MiB |
| getTokenLargestAccounts | never | refused before encoding (header limit 0) | 0 | - | - | - |

Total: our cap 60/10 s (documented 100); the method caps add up to 49. P0 reserve on the total is 27.
Phase 8 methods (getLatestBlockhash, getSignatureStatuses, getBalance, getTokenAccountsByOwner) and
getBlock come later. Each joins the table with its own review. getBlock and getTransaction always
carry `maxSupportedTransactionVersion: 1`, written by the encoder, not the caller.

Decoders (chain/decode.ts) are hand-written, with no zod (R8). An integer field needs a bigint in
range: u64 up to 2^64 - 1, Slot up to 2^63 - 1, `space` up to 10 MiB. A text field needs a string of a
bounded length. Small fixed shapes are exact: no missing key and no extra key (R7). These are the
envelope, `context` = `{apiVersion, slot}`, the account object (`data, executable, lamports, owner,
rentEpoch, space`), `data` = `[base64, "base64"]`, and the fee entry `{slot, prioritizationFee}`. Large
shapes that change over time (7h: transaction meta, simulation) are read field by field, also
strictly, and their other keys are ignored. Specific rules:
- getMultipleAccounts: `value.length` equals the number of keys, in order. `null` means a missing
  account. The data must be canonical base64. Its length is `space`, or with a slice
  `min(length, max(0, space - offset))`.
- getSlot, getBlockHeight: a bare u64. getGenesisHash: base58 of 32 bytes. Fees: at most 150 entries,
  distinct slots, sorted locally (the order is UNVERIFIED, U13).
- Rent: u64 lamports. If it differs from (128 + bytes) x 5,080, the chain's value is returned (the chain
  is the truth) and a `chain-rent-formula` event fires.
- getProgramAccounts (7h): the type requires `dataSize` and at least one `memcmp` (a typed filter
  list), so an unfiltered query cannot be written (the 243 MB answer). It also needs a `dataSlice` and
  P1 or lower, and the 2 MiB cap is hard.
- simulateTransaction (7h): refuses locally any transaction whose signatures are not all 64 zero bytes
  (R10). An RPC could broadcast a signed transaction it was asked to simulate.

Reads never go backwards. The client keeps one high-water mark of `confirmed` context slots (from
context-bearing results and getSlot) and sends it as `minContextSlot`. A result whose `context.slot` is
below what we sent is `went-back` (the node ignored it). Reads are 2-5 s apart, so only a node more
than about 9-23 slots behind answers -32016 (how often: U3). Staleness: when the feed's slot is known
and `context.slot + 150 < currentSlot()`, the result is `stale` (ARCHITECTURE s.12). Consumers keep
their tighter rules (plans: 25 slots, `HARD_CAPS.planFreshSlots`).

## 6. The budget governor (chain/budget.ts, pure, one per provider)

- Sliding-window logs (R2): each bucket keeps the grant times of its last window, at most `cap` of
  them, so no window of any alignment holds more than `cap`. Buckets: per method and total (10 s); data
  (30 s, our cap 50 MB of the documented 100 MB, P0 reserve 10 MB); connections (at most 6 HTTP
  requests in flight, P0 reserve 2, plus the one WebSocket, against the limit of 40; R13).
- `acquire(m, p)`, in this order. `REFUSED_METHODS`, or a priority more urgent than `mostUrgent`,
  gives `refused-method`. Provider blocked gives `blocked`. The method's Retry-After still running gives
  `retry-after`. `p` shed at the current level gives `shed`. Then the method, total, data and
  connection checks: a non-P0 grant must leave each bucket's P0 reserve free, while P0 may use the
  whole cap. A grant records the time, reserves `maxResponseBytes` in the data bucket and takes one
  connection slot.
- `settle`: frees the connection slot, replaces the reservation with the decoded bytes, and learns:
  - `methodLimit` lower than any seen before lowers the method cap to `min(table cap,
    floor(methodLimit / 2))` and its P0 reserve to at most that (event `chain-limit-learned`). The
    learned limit never rises within a process; a 0 refuses the method.
  - `methodRemaining <= 0` closes the method until its window empties.
  - 429 closes the method for Retry-After (missing or unparsable: 60 s; capped at 600 s), raises the
    shed level by one, and fires `chain-429`.
  - 403 marks the provider blocked for 15 min (`chain-blocked`, the app turns entries off). After that,
    one P0 probe is let through: success unblocks, another 403 blocks again.
- Shed level: +1 on a 429, or when any bucket stays over 80% of its cap for 60 s (that also fires
  `chain-budget-80`, the brief's 80% alert); -1 after 5 min without a trigger; at most 3. Each change
  fires an event. P0 and P1 are never shed (R15).
- A P0 denial for any reason fires `chain-p0-denied`, and the app turns all entries off until a P0 call
  succeeds again (ARCHITECTURE s.6).
- A double or unknown settle fires `chain-ticket-bug` and changes nothing. The client settles in
  `finally`; a ticket lost to a bug keeps its connection slot, which fails closed.
- Per-feature daily counters (requests, bytes) feed the daily report. They gate nothing: the public
  RPC has no daily quota. The governor has no timers: it reads the injected `MonoClock` on each call,
  so a test drives time by hand.

## 7. The WebSocket client (chain/ws.ts and chain/ws-socket.ts)

```mermaid
sequenceDiagram
  participant S as StreamClient
  participant W as Socket (generation g)
  participant N as Public WS
  participant F as Slot feed
  S->>W: factory(wsUrl) [connecting, open timeout 10 s]
  W->>N: upgrade (no compression offered by the node)
  N-->>W: open
  S->>W: slotSubscribe (id 1), then each logs spec (7h) [subscribing, ack timeout 5 s]
  N-->>W: result: subscription id (mapped for generation g only)
  loop each message (string, at most 65,536 chars, else dropped and counted)
    N-->>W: slotNotification {slot, parent, root}
    S->>F: report('stream', slot) [live]
  end
  alt no slotNotification for 5 s, ack timeout, error, close, binary data
    S->>W: terminate() (do not wait for close; late events of g are ignored)
    S->>S: backoff: jitter in [1 s, min(60 s, 2^n s)], then a new generation, resubscribe all
  end
```

- One connection carries every subscription (pubsub-limit most likely counts connections). A client
  message of 4,000 UTF-8 bytes or more is `our-bug` and is never sent (the node drops the connection
  at 4,096).
- Generations: handlers of an older socket do nothing, so a `close` that never fires, or fires late,
  changes nothing. Request ids and the subscription id map belong to one generation. Ids are node-wide,
  so an unknown one is dropped and counted (`chain-ws-unknown-sub`).
- The watchdog is ours (the node never pings): checked every 1 s, 5 s without a slotNotification
  while live (the most seen was 495 ms) is `chain-ws-stall`. More than 6 reconnects in 10 min is
  `chain-ws-flapping` (entries stay off, ARCHITECTURE s.12); the backoff resets after 60 s live.
- Incoming: `binaryType = 'arraybuffer'`; binary terminates. Every length goes to `chargeStream`.
  Then `parseLossless` and an exact decoder for `slotNotification` (`{result: {slot, parent, root},
  subscription}`, all u64, `parent < slot`, `root <= slot`); anything else is dropped and counted.
- 7h adds `logsSubscribe [{mentions: [one address]}, {commitment: 'confirmed'}]`, into a queue
  bounded at 5,000 (beyond it: drop and count, the incomplete-data breaker).
- The WebSocket URL comes from the same `ProviderEndpoint` as the HTTP host, so its genesis check
  covers it (there is no genesis call over WebSocket).

## 8. Slot feed, genesis, apiVersion and the clock

Slot channels (app/slots.ts `report`):
- `'stream'`: each slotNotification's `slot` (its commitment level relative to getSlot: U2).
- `'http'`: every successful `slot()` result and every `confirmed` `context.slot` of a read. Risk A
  (exits need a known slot after an outage) is met by two `slot()` readings 0.5 to 5 s apart, or by
  polling `slot()` every 2 s while positions are open (5 per 10 s, hence R3's getSlot cap of 6).
- `'http-2'`: not fed in step 7 (R4). One channel is one independent source. Two readings of the
  same host under two names would let one bad node "agree with itself" and adopt a jump past the
  advance budget. It is reserved for the second provider of decision 3 (or `api.mainnet.solana.com`
  once U11 shows it is a separate pool).

The cluster check (security 4). At start the engine calls `verifyCluster()` (getGenesisHash, P0).
Until it succeeds, every other call returns `unverified`, and the boot retries every 10 s with
entries off. If the hash equals `MAINNET_GENESIS_HASH`, the other calls unlock. Any other hash
latches `wrong-cluster` until a restart: the boot refuses, every call fails, and `chain-wrong-cluster`
fires. The check runs again every hour and after every unblock, with the same latch.

apiVersion: the first `context.apiVersion` seen is kept, and a different one fires `chain-api-version`
(info, once per change). The value goes into the event only when it matches the version pattern.

Clock (contract 8, security 5, security W1 note 4):
- `chainTime(P0, 'clock')` every 5 min (ARCHITECTURE s.2): `getSlot({commitment: 'finalized'})`, then
  `getBlockTime(thatSlot)`. A finalized block is rooted, so its time is recorded; a confirmed slot can
  give -32004 when the answering node lacks the bank. `null`, any failure, or a time outside 2020 to
  2200 gives `{kind: 'none'}`, never an estimate. `wallAtMs` and `monoAtMs` are read on receipt.
- `createTimeGuard` (app/time-guard.ts) holds the last good reading. `verdict(now)`:
  `no-reading` before the first one; `stale-reading` when it is over 10 min old (monotonic);
  `wall-mono-skew` when the wall clock and the monotonic clock have drifted apart by more than 2 s since
  the reading; `chain-skew` when `|wallAtMs - blockTimeMs| > 60 s` (contract 8's "about a minute"; R9);
  else `trusted`. `trusted(now)` is `verdict(now) === 'trusted'`. The app halts on the two skews
  (contract 8: "a halt, not an observation") and keeps entries off on the other two. Exits never
  consult it.
- The guarded clock is the feed's clock by construction (R11): `SlotFeedOptions.clock`, `DayDeps` and
  the loop take `GuardedClock`, minted only in app/time-guard.ts, so a raw clock does not type-check
  there. Rule 6 (s.10) keeps any other `TimeGuard`, a trust-everything fake included, out of src/.
- `provablyExpired` is `finalizedHeight > lastValid`. Once the finalized chain is past the last valid
  height, no block that could include the transaction can become final (s.4: re-sign only after
  provable expiry).

## 9. Secrets

- The public endpoint has no key (D3), so `secretParts` is empty; the code path is tested with a fake key.
- `ProviderEndpoint` is checked when the transport is made (http.ts and ws-socket.ts may use `URL`):
  https or wss only, no user name or password, no fragment, every query value and header value listed
  in `secretParts`. Each part goes to `registerOwnSecret` (16 to 1,024 characters; a shorter one is
  refused, since it cannot be registered), so `assertNoSecrets` then refuses it in any encoding.
- URLs, headers, node messages and error objects never leave the two network files. Events and
  failures carry codes, `ProviderId`, method names, priorities and numbers only. A test runs
  `assertNoSecrets` on every event and failure the suite produces, with the fake key registered.
- No signing anywhere in chain/: it imports no node:crypto (the global `crypto` is already refused
  everywhere), and simulate refuses non-zero signatures.

## 10. Architecture rules to add (tests/architecture/import-graph.test.ts), each with canaries

1. `PURE.chain = []`, except `NETWORK_FILES`: `chain/http.ts` may name `fetch`, `AbortSignal`,
   `URL`, `Headers`; `chain/ws-socket.ts` may name `WebSocket`, `URL`. Canaries: `setTimeout` in
   chain/budget.ts, `process.env` in chain/client.ts, `fetch` in chain/client.ts, `WebSocket` in
   chain/ws.ts.
2. Network door, in every folder: the globals `fetch`, `WebSocket`, `WebSocketStream`, `EventSource`,
   `XMLHttpRequest`, also as `globalThis.x` or `global.x`, and imports (static, `import type` excepted,
   or dynamic with a literal) of `node:http`, `node:https`, `node:http2`, `node:net`, `node:tls`,
   `node:dgram`, `node:dns`, `node:diagnostics_channel`, `node:worker_threads`, `node:child_process`,
   `node:vm`, `node:inspector` and `undici` are allowed only in NETWORK_FILES. Telegram and the
   Anthropic client add their own named file in their step. Canaries for each form, including
   `const g = globalThis; g.fetch(u)`. So rule 2 adds: a bare `globalThis` or `global` that is not
   directly member-accessed with a literal is flagged everywhere.
3. `ALLOWED.chain = ['core']` (narrowed from core, config: nothing in chain/ needs config, and a pure
   folder may import only pure folders). Canary: chain/x.ts importing config/tunables.ts.
4. chain/ imports no `node:crypto` at all. No chain/ string literal equals `sendTransaction`,
   `requestAirdrop` or `sendRawTransaction` (any case). Canaries for both.
5. `RESTRICTED_FILES['core/clock.ts']`: runtime import by cli/ only. Canaries: app/engine.ts and
   chain/x.ts importing it.
6. `RESTRICTED_FILES['app/time-guard.ts']`: only app/engine.ts. No object literal or class in src/
   implements `TimeGuard` outside it (a typed rule on contextual type). Canary: `const g: TimeGuard =
   { trusted: () => true }` in app/x.ts.

## 11. Failure modes

| What fails | Detected by | What the bot does |
|---|---|---|
| Wrong cluster or a hostile endpoint | genesis hash differs (start, hourly, after unblock) | boot refuses or `wrong-cluster` latched; every call fails; entries off; alert |
| Genesis unreadable at start | verifyCluster failure | every call `unverified`; retry every 10 s; entries off |
| 429 | status 429 or body code 429 | method closed for Retry-After, shed +1, event; P0 denied: entries off |
| 403 (IP blocked) | status 403 | provider blocked 15 min, entries off, alert; one P0 probe after |
| Our own over-use | sliding windows, data and connection buckets | denied locally before sending; P0 keeps its reserve |
| Header limit lower than our table | `x-ratelimit-method-limit` | cap lowered to half of it, never raised in-process; 0 refuses the method |
| Slow or hung answer | per-method timeout via injected signal | `timeout`; the loop retries next tick; errors over 20% in 2 min: RPC_ERRORS breaker (app) |
| Gzip bomb, redirect, non-JSON type, invalid UTF-8 | decoded-byte counter, content-length, `redirect: 'error'`, content-type, fatal decoder | `too-large`, `transport`, `content-type`, `utf8`; body cancelled; bytes read are charged |
| Imprecise integers, `1e3`, `-0`, floats; missing or extra field; wrong count | lossless reviver, exact decoders | `shape` or `count`, `chain-shape` event; never rounded, no partial data |
| Node behind, ignoring minContextSlot, or lagging | -32016, -32005, context below what we sent, `context.slot + 150 < feed slot` | `node-behind`, `went-back`, `stale`; never used; plans keep their 25 slots |
| Slot not recorded or skipped | -32004/-32007/-32009/... | `not-readable`; never a default; permanent ones not retried |
| Our request is wrong; new transaction version | -32600/-32601/-32602/-32700, 400/405/413/415, size checks; -32015 | `our-bug`, bug event, never retried; -32015 also "upgrade needed" (DECODE breaker, app) |
| apiVersion changes | `context.apiVersion` | info event; strict decoders catch real shape changes |
| WebSocket drops, never fires close, or flaps | error/close, watchdog 5 s, ack timeout; over 6 reconnects in 10 min | terminate, backoff 1-60 s with jitter, resubscribe; DATA_STALE entries off (app); exits on HTTP; flapping: entries stay off |
| WebSocket flood, huge frame, unknown subscription | length over 65,536, queue over 5,000 (7h), per-generation id map | dropped and counted after receipt; breaker (app); memory limit (ops) |
| Clock wrong, or block time missing | TimeGuard verdict; getBlockTime null or error | skew: halt (contract 8); no or stale reading (after 10 min): entries off; exits continue |
| A key in a URL or header (later) | `registerOwnSecret` at construction | refused everywhere it could leak; codes only in events |
| Ticket never settled (bug); shutdown mid-call | connection slots full; shutdown signal | P0 denied, entries off, bug event on double settle; `shutdown`, nothing retried |

## 12. UNVERIFIED, each with the scratch test that settles it (scratchpad scripts, never the bot)

| # | Item | Scratch test | Until then |
|---|---|---|---|
| U1 | fetch, WebSocket and the reviver on Windows | rerun `reviver.mjs`, `fetch-local.mjs`, `ws-local.mjs` on Windows Node 26.13.0 (CI windows runner, local only) | Linux behaviour assumed; Windows runs paper in Docker (D4.11) |
| U2 | Which commitment slotNotification's `slot` matches | 60 s from the VPS: compare the stream against getSlot processed and confirmed at the same moments | assume up to `processed` (ahead of `confirmed`: tokens expire early, fails closed) |
| U3 | How often minContextSlot gives -32016 on the load-balanced endpoint | 1 h at our cadence from the VPS, counting -32016 | treat it as a failed read; revisit if over 1% |
| U4 | The window behind the header limits and rps-limit; how the 100 MB/30 s is counted; what exceeding it returns | VPS soak at our caps, logging headers | sliding 10 s, decoded bytes, half the limits |
| U5 | A 403 body | none safe to provoke; observe in the soak | classify by status only |
| U6 | getBlockHeight, and getBlockTime's -32004/-32007/-32009/null cases, live | one call each on a known skipped slot and a fresh slot | decoders follow the docs and the agave source |
| U7 | Exact result shapes of getSignaturesForAddress, getTransaction (v1, base64), simulateTransaction, getProgramAccounts with `withContext`, getMinimumBalanceForRentExemption (and whether it accepts `commitment`) | researcher: docs at `e52cba1` plus one live call each on non-user accounts, recorded in VERIFIED_FACTS | 7h is not built; rent stays behind a decoder test against the recorded shape |
| U8 | Keep-alive reuse and the idle timeout of Node's fetch against the public RPC | count new connections over 100 calls (diagnostics_channel `undici:client:connected`, in the scratch script only) | the 6-in-flight cap bounds connections |
| U9 | `Uint8Array.fromBase64` and its `lastChunkHandling: 'strict'` on Node 26.13.0 | scratch run with padded, unpadded and non-canonical inputs | core/encode.ts hand-writes a strict decoder |
| U10 | The public WebSocket over 24/7 (idle drops, proxy pings, a 6th connection) | Phase 7 soak | the watchdog plus reconnect |
| U11 | `api.mainnet.solana.com` from the VPS, and whether it is a separate pool | getGenesisHash and headers from the VPS | not used; 'http-2' stays unfed |
| U12 | Whether WebSocket bytes count toward the 100 MB/30 s | not testable cheaply | counted anyway (`chargeStream`) |
| U13 | The order of getRecentPrioritizationFees entries | from the recorded live answer, or one call | sorted locally, duplicates refused |

## 13. Tests to write first (unit tests only, fake transports and in-process fake servers, never the network)

Fixtures are synthetic, built from the shapes and values recorded in VERIFIED_FACTS s.9: the genesis
hash, the wSOL mint and SPL Token accounts, the 429, -32016, -32602 and -32015 bodies, a 150-entry fee
answer. Transaction-bearing fixtures (7h) are synthetic only. A fixture-scan test refuses any base58
string of 32 or 64 bytes that is not on an allowlist (programs, mints, FOMO-owned accounts, the genesis
hash). So no FOMO user's or creator's address can get in (A16, D13).

| Sub-step | Tests (planted bugs where marked P) |
|---|---|
| 7a | `parseLossless`: 2^64 - 1, 9007199254740993 exact; `1e3`, `1.50`, `-0` stay numbers; `-32016` is a bigint; deep nesting gives SyntaxError (P). `stringifyLossless` round trip. Base58: 32 and 64 bytes exact, non-canonical and leading-zero cases refused (P). Strict base64 (P). Architecture canaries of s.10 (each P). |
| 7b | caps per method, total, data and connections; P0 reserve; shed levels 1-3 and decay; 80% for 60 s; Retry-After (missing, garbage, over 600 s); 403 block, probe, re-block; header learning only downward and 0 refuses; double settle; `getTokenLargestAccounts` refused; P0 refused for getProgramAccounts (all P). |
| 7c | in-process `node:http` server on 127.0.0.1: redirect refused, `text/html` refused, gzip bomb stopped at the cap counted in decoded bytes, content-length over the cap refused before reading, invalid UTF-8, a body that stalls (timeout through an injected signal, aborted by hand), shutdown, 429 and 403 bodies not read past 4 KiB, body always released; endpoint checks and secret registration; no URL in any outcome (P). |
| 7d | envelope: wrong `jsonrpc`, wrong or missing `id`, both or neither of `result`/`error`; each code row of s.4's table to its kind (P); every decoder: each field missing, extra, wrong type, float, out of range; account data length vs `space` and slice; 101 keys and duplicates refused before sending; fees over 150 or duplicate slots; rent formula event; the fixture scan. |
| 7e | genesis lock (unverified, wrong cluster latched, hourly re-check); commitment always `confirmed` and encoding always `base64` on the wire (asserted on the request text, P); minContextSlot sent and `went-back`; staleness at 150; reports to 'http' only, never 'http-2'; apiVersion event; settle in `finally` on a throwing transport; the type test (`@ts-expect-error` on `client.sendTransaction` and `client.rpc`; `Extract<keyof ReadClient, \`send${string}\`>` is never; `ReadMethod` has no send). |
| 7f | fake `SocketFactory`: slotSubscribe first; ack timeout; stall at 5 s; `close` never fires and late events of an old generation ignored (P); resubscribe with new ids; unknown subscription; oversize and binary; client message over 4,000 bytes refused; backoff bounds with a fixed jitter; flapping count; stop(). One integration test with a hand-written in-process WebSocket server (`node:http` upgrade, RFC 6455 frames, test code only): the real `webSocketFactory` connects, receives, and terminates when the server sends a close frame without the TCP close. |
| 7g | `chainTime`: null, -32004, error, implausible gives `none` (P); finalized slot then blockTime; TimeGuard verdicts at each boundary (2 s, 60 s, 10 min; P); a feed or DayDeps given a raw clock does not type-check; `provablyExpired` at equal and one above (P). |
| 7h | after U7: each new decoder as in 7d; getTransaction always carries version 1 (P); simulate refuses a non-zero signature (P); getProgramAccounts without `dataSize` or `memcmp` does not type-check and is refused at runtime too (P); logsSubscribe one address. |

Property tests (1,000 cases in CI, TEST_PLAN s.4 style):
- Budget bound: random acquire and settle sequences, random priorities, clock steps and header values.
  In every 10 s window, grants per method stay at or under the cap at that time and the total at or
  under 60. In every 30 s window, reserved plus settled bytes stay at or under 50 MB. In-flight
  requests never exceed 6.
- P0 never shed: a P0 acquire is never denied as `shed`. When it is denied as `method-cap` or
  `total-cap`, the P0 grants in that window are at least the reserve (non-P0 never ate it).
- Lossless parse: random u64 values and random JSON number spellings. A bigint comes out exactly when
  the source is canonical digits, and the value then equals `BigInt(source)`.
- Decoders: a random structural mutation of a valid fixture (a key removed, added or renamed, a type
  changed, an integer respelled as `1e3`, `1.0` or a string) is always refused. A random in-range value
  change decodes to exactly the changed value.
- Stream: random sequences of open, message, error, close, missing close and clock steps. At most one
  live generation; every live generation sent slotSubscribe first; no slot reported from an unmapped
  subscription.

## 14. The split (each sub-step reviewed on its own; all touch network access, so D14 keeps both reviewers and planted bugs)

| Step | Contents | Depends on |
|---|---|---|
| 7a | core/json.ts, core/solana.ts, strict decoders in core/encode.ts, core/clock.ts, architecture rules 1-5 | - |
| 7b | chain/limits.ts, chain/budget.ts | 7a |
| 7c | chain/providers.ts, chain/http.ts | 7a |
| 7d | chain/rpc.ts, chain/decode.ts (Phase 2 methods) | 7a |
| 7e | chain/client.ts: genesis lock, minContextSlot, staleness, slot reports, events | 7b-7d |
| 7f | chain/ws.ts, chain/ws-socket.ts: slotSubscribe, watchdog, reconnect | 7a, 7b |
| 7g | chain/time.ts, chain/expiry.ts, app/time-guard.ts, `GuardedClock` in slots.ts and day-tx.ts deps, rule 6 | 7e |
| 7h | getSignaturesForAddress, getTransaction v1, simulateTransaction, getProgramAccounts, logsSubscribe (may move into Phase 3 with their consumers) | U7, 7e, 7f |

## 15. Decisions to challenge

Each is recommended as written.
- R1. Typed methods instead of ARCHITECTURE s.3's generic `rpc<M>(method, params)`: one decoder and
  type test each, and no generic door a send could pass through.
- R2. Sliding-window logs instead of token buckets (a token bucket can grant 2N in one window).
- R3. ARCHITECTURE s.6's shared cap of 4/10 s for getSlot, getBlockHeight and getBlockTime is below
  the 5 that risk A's 2 s polling needs. Split it: getSlot 6 (all P0), getBlockHeight 2, getBlockTime
  1, getGenesisHash 1, rent 1. The total cap is 49 of our 60. ARCHITECTURE s.6 to be updated.
- R4. 'http-2' stays unfed until there is an independent source, never a second name for the same host.
  This differs from this step's brief ("two HTTP readings for 'http' and 'http-2'"). The two HTTP
  readings go on 'http', 0.5 to 5 s apart, which the feed's cold start already accepts.
- R5. chain/ never retries; the loops retry at their tick, so the budget is never spent twice.
- R6. Commitment is fixed by chain/ (`confirmed`), so no caller can read `finalized` on the exit path.
  ARCHITECTURE s.3's `RpcOptions.commitment` is dropped.
- R7. Exact keys for small shapes; field by field for big changing ones (7h). Trade-off: an upgrade that
  adds a field to an account pauses paper until a one-line decoder fix.
- R8. No zod (ARCHITECTURE s.12, THREAT_MODEL A9 and TEST_PLAN s.5 still say zod): it is not approved,
  and bigint needs hand-written decoders anyway. Those docs to be updated.
- R9. Block time (1 s resolution, a validator estimate, seconds old once finalized) cannot carry
  ARCHITECTURE s.12's 2 s and 10 s thresholds. Use 60 s against the chain (contract 8) and 2 s for
  wall against monotonic. ARCHITECTURE s.12 to be updated.
- R10. simulateTransaction refuses non-zero signatures: an RPC could broadcast what it simulates.
- R11. core/clock.ts at runtime for cli/ only, and the `GuardedClock` brand on the feed, the day
  observation and the loop, so contract 8's clock is the feed's clock by type (security 5, W1 note 4).
  This changes slots.ts's option type and day-tx.ts's DayDeps (7g, reviewed).
- R12. The data bucket reserves the method's byte cap first and settles to the actual bytes, so
  concurrent calls cannot overshoot. WebSocket bytes are charged after receipt.
- R13. Connections are capped by our own in-flight limit (6 + 1 WebSocket). No pool setting of the
  built-in fetch is recorded in VERIFIED_FACTS, and this limit needs none.
- R14. Jitter needs randomness, and chain/ cannot import core/rng.ts. Add an export `unitInterval()`
  (from randomBytes) to core/rng.ts, handed in by cli/: a small change to a reviewed file, in 7f.
- R15. P1 (the safety checks of a buy under way) is never shed but has no reserve. ARCHITECTURE s.6
  names only the three shed levels.

Owner question: none. The one trade-off the owner may care about (R7): strict checking can pause
paper trading after a provider upgrade until a small fix ships. It never trades on a misread answer.

## 16. As built in step 7a, and what changed

Status: UNREVIEWED, on `claude/exciting-hamilton-2d7lto-6d2-unreviewed`; reviewed with this design.

Built, tests first: core/json.ts (`parseLossless`, `stringifyLossless`, `JSON_MAX_DEPTH` = 64, `Json`),
core/solana.ts (`Address`, `Signature`, `Slot`, `BlockHeight` and their makers), core/encode.ts
(`base58Exact`, `base64Strict`), core/clock.ts (`WallClock`, `MonoClock`, `Timers`, `systemWall`,
`systemMono`, `systemTimers`), and rules 1 to 5 of s.10 with their canaries.

Differences from s.3 and s.10:
- Deep nesting is refused before the parse, by a scan that counts brackets outside strings, not by
  catching V8's RangeError: the reviver's walk is recursive, and a check that comes first is
  deterministic. Every parsed array and object is frozen.
- `stringifyLossless` is written by hand instead of through `JSON.rawJSON`: it refuses what
  JSON.stringify would drop or rewrite (NaN, the infinities, undefined, functions, symbols, array holes,
  objects with a prototype other than Object's or none) and nesting deeper than 64.
- The decoders return null for bad data and throw a TypeError only for a call that is not a string, or
  a bad length or bound; each checks its size bound before decoding (base58 needs at most two characters
  per byte).
- The timers refuse a delay that is not whole milliseconds from 0 to 2^31 - 1 (Node fires a longer one
  at once).
- Rule 2: `globalThis` and `global` are allowed only directly followed by a named member (a dot, or an
  index that is a string literal), in every folder; the module list holds the bare names too (`http`,
  `net`, `undici`).
- Rule 4 is stricter than written: any name, member, method signature or string in chain/ that equals a
  sending method in any case is refused.

Written down, for the reviewers:
- The docs that this design says to correct (ARCHITECTURE s.3, s.6 and s.12, THREAT_MODEL A9) are left as
  they are until the reviewers rule on R3, R6, R8 and R9; TEST_PLAN's chain row no longer names zod.
- core/clock.ts has no importer yet: cli/ hands the clocks in when the start command exists (Phase 7).

Tests: TEST_PLAN.md s.3, "Done in step 7a". Planted bugs (scratchpad `mut/run40.py`): 50 in the first
run, 46 caught; one weak test (a foreign character in the middle of a base58 text) was fixed, one
unreachable line was removed, and two are equivalent (base64's character and length checks, which its
re-encoding also enforces). Final: 49, 47 caught, 2 equivalent. Coverage: every line and branch of the
four files.
