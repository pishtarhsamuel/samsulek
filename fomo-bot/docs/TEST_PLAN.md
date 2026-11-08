# Test plan (Phase 1 design)

How the bot is tested before anything is trusted. Invariant numbers refer to
RISK_POLICY.md section 15. Failure modes refer to ARCHITECTURE.md section 12.

## 1. In plain English

- The parts that touch money (amount math, accounting, risk limits, sizing) get their tests
  written first, and random-input tests try thousands of odd cases against every rule.
- Data decoding is tested against recorded mainnet data with every wallet, signature,
  blockhash and slot replaced by fakes, or against bytes we build ourselves.
- "Chaos" tests break things on purpose (dropped streams, rate limits, crashes mid-trade,
  a damaged database) and check that the bot stops new trades and keeps exits working.
- Tests can show the code does what we designed. They cannot show a strategy makes money:
  only the paper soak can, and only roughly.

## 2. Principles

- Tests first for `core/` amount math, `venues/` quote math, `portfolio/` accounting,
  `risk/` and sizing; each starts as a failing test (Phase 2).
- No network in unit, property, integration or chaos tests: providers, Telegram and
  Anthropic are in-process fakes (node:http for HTTP-level fakes). Opt-in `@network` tests
  are read-only, paced under the budget table, never in CI.
- No secrets: `tests/setup/no-secrets.ts`, loaded with `node --import`, makes the secrets loader throw (root `no_side_effects`
  pattern), so no test and no command Claude runs can load the owner's secret files.
- Deterministic: an injected clock (wall and monotonic), seeded random numbers (seed logged
  on failure), fixed fixtures. No `Date.now()` or `Math.random()` outside `core/clock` and
  `core/rng` (lint rule).
- Same code paths as production: tests construct the app through `app/` with fakes, never
  a test-only shortcut around the risk engine.
- Every bug fixed gets a regression test first. A limit is never changed to make a test pass.

## 3. Phase 2 order (tests first)

1. `core/units` and checked math: bigint brands (signed PnL separate), mulDiv, ceilDiv,
   rounding direction (caps down, costs up), bps conversion, u64 bounds, TEXT round trip.
2. `venues/` math: constant product (out, exact-inverse in, impact), pump curve on virtual
   reserves with the real-token cap and `complete`, venue-favoured rounding (port the root
   `costs/memecoin.py` cases), fee tiers by market cap from a decoded fee config.
3. `portfolio/` ledger: cost lines, cost basis, realized PnL (negative too), rent paid and
   refunded, equity with unknown and stale marks, unknown mints, deposits and withdrawals.
4. `risk/` engine and sizing: every limit in RISK_POLICY.md section 3 at, just below and
   just above its value; the fee-reserve arithmetic of section 3a to the lamport; flags;
   breakers; approval transaction T1 and tokens; reduce-only rules.
5. `config/`: HARD_CAPS and TUNABLE_BOUNDS enforcement, direction rules, versions, rollback,
   modes only in the flags table.
6. `storage/`: migrations, WAL, TEXT amounts, partial unique indexes, crash during write,
   quick_check failure.

## 4. Property-based tests (fast-check)

| Invariant | Generators | Property |
|---|---|---|
| 1 approval tokens | random intents, plans, token reuse, expiry slots, tampered plan fields, wrong mode | executor accepts exactly the matching, unexpired, unused token of the same mode and kind |
| 2 caps | portfolios (0-4 open or opening positions), equity 0..2^63, prices, pool reserves, config versions within bounds | every approved buy satisfies limits 1-8, 11 and 13-24; never more than 4 positions, never two on one mint |
| 3 reserve | balances near the reserve, fee estimates, rent, N = 1..4 | SOL after a buy >= the reserve computed with the new position; no underflow |
| 4 blocks and exits | random flag and breaker combinations | buys rejected when any block applies; valid reduce-only exits always approved |
| 5 no shorting | random sell sizes, concurrent exit attempts | sell <= sellable; in-flight sells <= holding; balances never negative |
| 6 conservation | random sequences of fills, failed attempts, fees, rent refunds | starting SOL + fills - cost lines = current SOL, exactly; a planted mismatch trips PAPER_LEDGER |
| 7 amount hygiene | bigint 0..2^64-1, negative PnL, boundary values, malformed strings | no NaN, Infinity or negative sizes; signed PnL round trip; TEXT round trip exact; out-of-range input throws |
| 8 venue math | reserves 1..2^64-1, fee bps 0..9,999, inputs | output < reserve; monotone; inverse exact; rounding never in our favour; minOut <= expectedOut |
| 9 2x costs | random trades | 2x estimate >= 1x; 2x shadow PnL <= 1x PnL |
| 10 rent | random exit sequences | refund only after 100% sell plus close |
| 11 config | random /set and AI changes, rollbacks | effective config always within bounds; every TUNABLE_BOUNDS max <= its H; rollback exact |
| 12 signer policy | random and adversarial messages: lookup tables, AdvanceNonceAccount, Transfer, TransferChecked, Approve, SetAuthority, foreign CloseAccount, wSOL transfer to a foreign or unclosed account, tips over 5,000 or to non-allowlisted accounts, value accounts not ours, re-serialized bytes, oversize requests, cap and rate exhaustion, KILL file missing, restart without arming | the signer refuses every one; it signs exactly the validated bytes; counters and caps hold across restarts |
| 13 idempotency | event streams with duplicates and shuffles; failing exits | same intents and orders as the clean stream; every failed or expired exit yields exitSeq + 1 |
| 14 day roll | instants across Athens DST changes, clock jumps | day boundary at local 00:00; backwards day halts |
| 15 Telegram, AI | random updates from other ids, group chats, wrong pairing codes; random AI outputs | no state change; 5 wrong codes burn the code; accepted proposals within bounds and direction; paper model untouched |
| 16 sizing | equity, liquidity, caps | result never above any single cap; more equity or liquidity never lowers a cap |
| 17 concurrency | interleavings of 2-6 approvals and fills on one SQLite file | the caps hold together; one in-flight order per mint |
| 18 rounding | random amounts | caps round down, costs and reserve round up |
| 19 reduce-only | random tokens and plans | a reduce-only token never executes a buy or another mint |
| 20 withdraw | balances, reserves, amount strings (exponents, signs, 10+ decimals, spaces) | amount <= free SOL - reserve; parse rejects malformed input; paper refuses |
| 21 flags mid-buy | KILL, HALT, PAUSE, daily stop set at each attempt index | no further paper attempt and no live resend |
| 22 baseline and peak | withdraw, deposit, sanity breach, equity jump, dust | exact adjustments; breaches never move them; unknown mints never in equity |
| 23 counterfactual ledgers | shadow, twin, tournament paths | no OrderPlan or token can be built from them (type test and runtime test) |
| 24 modes | random sequences of /set, /approve, /rollback, AI proposals, restarts, migrations | no mode ever becomes live except through /golive |

Each property runs 1,000 cases in CI (10,000 in a nightly local run); shrunk
counterexamples become fixed regression tests.

## 5. Unit tests by module

| Module | Must cover |
|---|---|
| chain/ | budget buckets, P0 reserve, shed levels 1-3, header learning, Retry-After, 403 handling, every getTransaction/getBlock carries `maxSupportedTransactionVersion: 1`, getTokenLargestAccounts refused, timeouts, zod rejection, context-slot staleness, block-height expiry; the paper ProviderClient type has no send method (type test) |
| fomo/ | invoke-stack parser (nested CPIs, truncated logs, failed tx), pump TradeEvent and PumpSwap Buy/Sell decoding by discriminator, unknown discriminator, completeness flags, pool-to-mint cache, user tags never leave memory, raw samples never persisted, decoder error logs without addresses or signatures, windows 1/5/15, sybil metrics, watermark and late events, anchors and ratios, coverage audit |
| safety/ | raw TLV parser for all 29 extension types, the REJECT/ALLOW/ALLOW-IF table, unknown type 29+, bad lengths, jsonParsed-without-extensions trap, authorities, metadata mutability, holder exclusions (curve, pool vaults, PDAs off-curve, mayhem vault), holder-sim picks (never creator, top-10 or launch-slot buyers; holder not logged), probe bytes with zeroed signatures, sell-probe result parsing, cost rule items, TTL |
| strategies/ | pure: same input, same output; no imports outside the allowed list; each entry rule and its reasons |
| exits/ | universal exits first; each policy; stale-price protective path; two-sample confirmation for take-profit and trailing |
| execution/ | planner minOut, fees and maxSpend; canonical planHash covers every field (changing any field changes it); T1-T3 transactions; paper latency, landing rolls, failed attempts, rent, own-impact overlay, 2x shadow, twins; order state machine; stuck retry only after a passing simulation and within the failed-fee budget |
| telegram/ | pairing (10+ base32 characters, expiry, constant-time compare, 5 wrong attempts in total, private chat only, `allowed_updates`), owner-only, rate limits, nonce expiry and reuse, callback answered, 409 handling, outbox throttling, live loosening queued 24 h with the `fomo-notice` ping, alert text without third-party strings, `parse_mode` unset, previews off, AI text ASCII and length-capped without URLs |
| ai-review/ | cost guard at the cap, refusal and error paths, schema failure, bounds, step and direction rules, no names, symbols or third-party data in the prompt |
| ops/ | run lock on Windows and Linux, heartbeat semantics, disk thresholds, backup rotation (7), weekly DB copy refused when a planted secret pattern is present |
| secrets, redactor | loader reads files once, refuses without `--load-secrets`, refuses `--heapsnapshot-signal`, `--report` and `--inspect`; canary secrets (bot token, `sk-ant-`, hc-ping URL, 64-byte key as base58 and JSON array) never appear in logs, DB text columns, Telegram text, errors, exports or prompts; Solscan links built after redaction |
| signer/ (Phase 8) | every rule of THREAT_MODEL s.5 accepted at its edge and refused just past it; ATA derivation against fixtures; arming and KILL latch; counters file missing or corrupt means no buys |
| import graph | parses every import; fails on a forbidden edge (strategies or ai-review into chain, execution, signer, storage, telegram; anything but storage importing `node:sqlite`; signer importing any npm package) |

## 6. Fixtures and replay tests

Recorded read-only from mainnet with `npm run fixtures:record` (paced under the budget table).
The recorder keeps raw data in memory and writes only scrubbed output: user wallets,
signatures, blockhashes and slots are replaced by fixed fakes inside the bytes (or the
fixture is synthetic), because the repository may be public (D1, D2). Public program,
fee-config and token-mint addresses stay.

| Fixture | Source (VERIFIED_FACTS, research) | Tests |
|---|---|---|
| FOMO v1 trades: pump-curve leg, PumpSwap leg, DFlow-only, Jupiter-only, failed trade, signer-only non-trade | fresh recordings, Phase 3 | decoder, completeness, `maxSupportedTransactionVersion: 1`; scrubbed as above |
| pump.fun create_v2 launch (phase0-token-safety row 15), mayhem mint `897tnAdpiAETR2E3nHropcXWdwpikQFMCSd6raXwpump` | phase0-token-safety rows 15-16 | launch event, Token-2022 mint with metadata extensions, mayhem rejection |
| Launch-slot pattern, mint `5w3sGrqfkJZhaTis1nZa4YbVY6VAP21qrmbjEkmApump` | phase0-token-safety row 34 | same-slot identical buys; buyer addresses scrubbed |
| Curve FeeConfig `8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt`, PumpSwap FeeConfig `5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx`, Global `4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf`, a canonical PumpSwap pool | VERIFIED_FACTS s.3 | fee tiers, layouts, PDA derivation |
| PYUSD `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo` | row 23 | reject: permanent delegate, confidential transfers, hook authority |
| BERN `CKfatsPMUf8SkiURsDXs7eK6GWb4Jsd6UDbs7twMCWxo` | row 37 | reject: transfer fee with live authority |
| LIBRA `Bo9jh3wsmcC2AjakLWzNmKJ3SgtZmXEcSaW7L2FAvUsU` | row 38 | passes static checks, mutable metadata logged: "static pass is not safe" |
| TUCAT `6oEkKhW6yvs64oNPjaj4oQZZjBrKUt9X5BnBfNQHTfzp` | row 39 | reject: freeze authority |
| Fartcoin `9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump` | row 21 | legacy pump token, curve complete: graduated path |
| USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | row 22 | reject: mint and freeze authority |
| Synthetic mints and messages | built in tests | unknown extension type, bad TLV length, Token-2022 mint over 82 bytes without extensions; adversarial signer messages (invariant 12) |
| Failed and partial fills | recorded pump and PumpSwap failures (scrubbed); synthetic curve near completion | minOut failure pays fees; buy capped by real tokens; BondingCurveComplete |

Rules: third-party API recordings with redistribution limits (DexScreener, Jupiter) and
unchecked terms (GeckoTerminal) are withheld from git the way the root project's
`tests/withheld.py` does it: a `tests/withheld.ts` list, tests skip with a clear reason when
the file is absent. The official pump IDL files are not committed (licence UNVERIFIED);
tests compare our hand-written layouts with the IDL's hash and fields when the file is
present locally. A fixture lint fails if a committed fixture contains an address that is not
on the public allowlist above. Replay tests feed recorded streams through the real pipeline
at 1x and 10x speed with a fake clock and must produce identical decisions.

## 7. Integration tests

- Full pipeline with fakes: FOMO notifications to intent, safety, risk, plan, paper fill,
  exits, ledger, Telegram alert, in one process.
- Restart: kill the process at each order state (intent saved, T1 committed, token consumed,
  order submitted, fill written) and restart; expect no duplicate order, the opening row
  resolved, and the rules of ARCHITECTURE.md diagram (e).
- Races: two intents for the last cap room, and two for one mint, approved concurrently: one
  wins, the other is rejected with a logged reason.
- KILL, HALT, PAUSE and daily stop set between paper attempts 1 and 2: no attempt 2.
- Telegram against a local fake Bot API: pairing, every command, confirmations, 409, live
  loosening queued 24 h and cancellable.
- AI review against a fake Messages API: valid, refusal, error, invalid schema, over cap.
- Config: /set, AI approve, rollback, restart with each version; modes unchanged by all of them.
- Live loosening by /rollback: rolling back to a looser risk version (e.g. tradePct, poolShare,
  slippage) queues each looser field for 24 h with the notice; safer fields apply at once.
- Signer budgets (Phase 8 code, test written with the caps in Phase 2): the exit fee budget
  covers (max open positions + max entries per day) x 3,380,000 plus close fees for both
  HARD_CAPS and LIVE_CAPS; a disarmed signer rejects a buy whose request says "sell".

## 8. Chaos tests

| Scenario | Injected | Expected |
|---|---|---|
| WebSocket drop | close mid-stream, reconnect after 1-60 s | crowdflow entries off, gap recorded, warm-up, exits continue |
| Silent stall | socket open, no messages | DATA_STALE within 5 s, reconnect |
| Partial loss | fake drops 30% of marker messages | coverage audit under 80%: FOMO_SIGNAL |
| 429 storm | every method 429 with Retry-After | shed levels in order, P0 kept, entries off when P0 denied |
| 403 | provider blocked | all entries off, alert, marks degraded |
| Stale data | reserves frozen, lagging context slot | entries off; protective exit at 60 s; valued 0 at 5 min |
| Price manipulation | one-sample spike up and down | no take-profit on one sample; no entry on divergence |
| Equity jump | +60% in 1 h, once verified by marks, once unexplained | first clears by itself; second halts; baseline and peak unchanged until cleared |
| Duplicates and reorder | every event twice, shuffled within 20 slots | identical decisions to the clean run |
| Exit failures | every sell attempt fails for 10 min | exitSeq rises, attempts stop at the failed-fee budget, stuck, alert; reserve never breached |
| Dust and spam | unknown mint deposited; 0.0001 SOL dust; 0.001 SOL dust | first two ignored and out of equity; third trips UNEXPECTED_BALANCE |
| FOMO marker silence | marker rate to 0, signer normal | FOMO_SIGNAL in 10 min, recovery with hysteresis |
| Decode drift | unknown discriminators appear | DECODE breaker |
| Program upgrade | account size or discriminator change | venue off, self-test path |
| Restart mid-trade | crash at each order state | section 7 rules, no double order |
| SQLite damage | corrupt page, read-only file, disk full | halt entries, alert, no auto-restore |
| Clock jump | wall clock +/- 1 h, monotonic steady; drift 3 s and 12 s | timers unaffected; entries off; halt over 10 s |
| Memory pressure | many tokens tracked | cold-token shedding, bounded memory |
| Telegram outage | API unreachable 31 min | entries off, heartbeat `/fail` |

## 9. Paper-engine pessimism tests

- A fill is never better than the exact math on reserves read after the latency, minus the
  competition allowance; at 2x it is never better than at 1x.
- A failed reserve re-read at t + L is a failed attempt with fees, never a fill at the
  decision quote.
- Every failed attempt charges base and priority fees, priority on the requested CU limit;
  tips only on landed attempts; p_fail rises when the priority clamp binds.
- The model never runs below its HARD_CAPS floors; /set cannot lower them; any change
  restarts the gate count.
- Rent is charged on every buy and refunded only after a full sell plus close.
- Moonbag policies carry their locked rent in their score.
- The paper engine never reads data stamped after the decision (look-ahead guard test feeds
  future events and expects them ignored).
- Random twins use the same size, exit policy and cost model as the real entry.
- Golden-file test: a recorded hour replays to the same PnL to the lamport.

## 10. Coverage targets

At least 90% lines and branches on `core/`, `venues/` math, `portfolio/`, `risk/`,
`config/` caps and bounds, and the Phase 8 signer policy; at least 80% elsewhere. Coverage
is a floor, not proof: the property and chaos tests above are required regardless.

## 11. Commands and CI

Locally: inside Docker (`docker compose run --rm --build test`, which runs the test stage)
or, for development only, natively from `fomo-bot/` with `npm ci --ignore-scripts`,
`npm run typecheck` (`tsc --noEmit`), `npm test` (Node's built-in `node:test`, running the
`.ts` files directly), `npm run test:coverage` (Node's coverage, then
`tests/tools/check-coverage.ts` checks every file of the lcov report against s.10) and
`npm run check:lockfile`. The import rules are a node:test test using the TypeScript
compiler API; eslint is deferred until it has its own review. Root checks before every
commit (repository root): `uv run pytest`, `uv run ruff check src tests`, `uv run mypy`.

Secret scanning: a committed `.gitleaks.toml` extends the default rules with: JSON arrays of
64 integers, base58 strings of 87-88 characters, `hc-ping.com/` URLs, Telegram bot tokens
and `sk-ant-` keys (known public signatures in research notes go in `.gitleaksignore` by
fingerprint after review). The pre-commit hook (`gitleaks git --pre-commit --redact --staged
--verbose`) is installed with `git config core.hooksPath` to a committed hooks folder (after
checking the root project uses no other git hooks) and fails closed if the binary is missing.
gitleaks v8.30.1's SHA256 is verified against its release checksums before install.

CI (GitHub Actions; actions pinned by commit SHA; `permissions: contents: read`; no
`pull_request_target`; GitHub-hosted runners only; no secrets in CI):
1. Supply chain: `.npmrc` has `registry=https://registry.npmjs.org/`; every lockfile entry's
   name@version+integrity must be in the committed approved list `fomo-bot/ops/approved-packages.txt`
   (new transitive packages fail the build), integrity sha512 only, every `resolved` URL on
   registry.npmjs.org; `npm ci --ignore-scripts`; `npm audit signatures`;
   `npm audit --audit-level=moderate`. The image build's first stage runs the same checks.
2. Checks: typecheck, the node:test suite with the per-file coverage gate (and its canary
   tests), and a check that `.npmrc` holds no `_auth`, `_authToken` or `//host:` lines, on ubuntu-latest and
   windows-latest (paths, LF endings, ASCII output, run lock); the Docker build with its
   no-network test stage on ubuntu-latest.
3. Secrets: `gitleaks git --redact --verbose` with `.gitleaks.toml` over the full history
   (fetch depth 0).
4. Root project: `uv sync --locked`, `uv run pytest`, `uv run ruff check src tests`,
   `uv run mypy`.
5. Once the owner approves ARCHITECTURE.md s.14 decisions 13-14: a root hook test
   (`tests.test_guard_hook`) for every new block and deny rule, each blocked and each
   harmless look-alike allowed.
6. Compose file: a test parses it: no `docker.sock` mount anywhere, `/srv/fomo-signer`
   mounted only into the signer, no published ports, the signer has `network_mode: none` and
   logging `none`, and a `test` service with no secrets and no network (`ops/update.sh` and
   the compose file come from the deployed tag).

## 12. What tests cannot show

Whether any strategy has an edge, real landing rates and latency, whether the public
WebSocket survives weeks, and how often baits and sandwiches hit us. Those come only from
the paper soak (Phase 7) and the owner-approved minimum live test (Phase 8).
