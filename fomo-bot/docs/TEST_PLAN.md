# Test plan (Phase 1 design)

How the bot is tested before anything is trusted. Invariant numbers refer to
RISK_POLICY.md section 15. Failure modes refer to ARCHITECTURE.md section 12.

## 1. In plain English

- The parts that touch money (amount math, accounting, risk limits, sizing) get their tests
  written first, and random-input tests try thousands of odd cases against every rule.
- Data decoding is tested against real recorded mainnet data, with private details removed.
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
- Deterministic: an injected clock (wall and monotonic), seeded random numbers (seed logged
  on failure), fixed fixtures. No `Date.now()` or `Math.random()` outside `core/clock` and
  `core/rng` (lint rule).
- Same code paths as production: tests construct the app through `app/` with fakes, never
  a test-only shortcut around the risk engine.
- Every bug fixed gets a regression test first. A limit is never changed to make a test pass.

## 3. Phase 2 order (tests first)

1. `core/units` and checked math: bigint brands, mulDiv, ceilDiv, bps conversion, u64
   bounds, TEXT round trip.
2. `venues/` math: constant product (out, exact-inverse in, impact), pump curve on virtual
   reserves with the real-token cap and `complete`, venue-favoured rounding (port the root
   `costs/memecoin.py` cases), fee tiers by market cap from a decoded fee config.
3. `portfolio/` ledger: cost lines, cost basis, realized PnL, rent paid and refunded,
   equity with unknown and stale marks.
4. `risk/` engine and sizing: every limit in RISK_POLICY.md section 3 at, just below and
   just above its value; flags; breakers; approval tokens; reduce-only exits.
5. `config/`: HARD_CAPS enforcement, bounds, versions, rollback.
6. `storage/`: migrations, WAL, TEXT amounts, crash during write, quick_check failure.

## 4. Property-based tests (fast-check)

| Invariant | Generators | Property |
|---|---|---|
| 1 approval tokens | random intents, plans, token reuse, expiry, tampered plan hash | executor accepts exactly the matching, unexpired, unused token |
| 2 caps | portfolios (0-4 positions), equity 0..2^63, prices, pool reserves, config versions within bounds | every approved buy satisfies limits 1-8 and 11; never more than 4 positions, never two on one mint |
| 3 reserve | balances near the reserve, fee estimates, rent | SOL after a buy >= reserve; no underflow |
| 4 blocks and exits | random flag and breaker combinations | buys rejected when any block applies; valid reduce-only sells always approved |
| 5 no shorting | random sell sizes | sell <= holding; balances never negative |
| 6 conservation | random sequences of fills, failed attempts, fees, rent refunds | starting SOL + fills - cost lines = current SOL, exactly |
| 7 amount hygiene | bigint 0..2^64-1, boundary values, malformed strings | no NaN, Infinity or negative sizes; TEXT round trip exact; out-of-range input throws |
| 8 venue math | reserves 1..2^64-1, fee bps 0..9,999, inputs | output < reserve; monotone; inverse exact; rounding never in our favour; minOut <= expectedOut |
| 9 2x costs | random trades | 2x estimate >= 1x; 2x shadow PnL <= 1x PnL |
| 10 rent | random exit sequences | refund only after 100% sell plus close |
| 11 config | random /set and AI changes, rollbacks | effective config always within bounds; rollback exact |
| 12 transfers | random OrderPlans (Phase 8 signer policy) | only the withdraw sends SOL to a non-tip address, and only to the configured one |
| 13 idempotency | event streams with duplicates and shuffles | same intents and orders as the clean stream |
| 14 day roll | instants across Athens DST changes, clock jumps | day boundary at local 00:00; backwards day halts |
| 15 Telegram, AI | random updates from other ids; random AI outputs | no state change; accepted proposals within bounds and direction |
| 16 sizing | equity, liquidity, caps | result never above any single cap; more equity or liquidity never lowers a cap |

Each property runs 1,000 cases in CI (10,000 in a nightly local run); shrunk
counterexamples become fixed regression tests.

## 5. Unit tests by module

| Module | Must cover |
|---|---|
| chain/ | budget buckets, P0 reserve, shed levels 1-3, header learning, Retry-After, 403 handling, every getTransaction/getBlock carries `maxSupportedTransactionVersion: 1`, getTokenLargestAccounts refused, timeouts, zod rejection, context-slot staleness, block-height expiry |
| fomo/ | invoke-stack parser (nested CPIs, truncated logs, failed tx), pump TradeEvent and PumpSwap Buy/Sell decoding by discriminator, unknown discriminator, completeness flags, pool-to-mint cache, user tags never leave memory, windows 1/5/15, sybil metrics, watermark and late events, anchors and ratios, coverage audit |
| safety/ | raw TLV parser for all 29 extension types, the REJECT/ALLOW/ALLOW-IF table, unknown type 29+, bad lengths, jsonParsed-without-extensions trap, authorities, metadata mutability, holder exclusions (curve, pool vaults, PDAs off-curve, mayhem vault), sell-probe result parsing, cost rule items, TTL |
| strategies/ | pure: same input, same output; no imports outside the allowed list; each entry rule and its reasons |
| exits/ | universal exits first; each policy; stale-price protective path; two-sample confirmation for take-profit and trailing |
| execution/ | planner minOut and fees; paper latency, landing rolls, failed attempts, rent, own-impact overlay, 2x shadow, twins; order state machine |
| telegram/ | pairing (expiry, single use, wrong code), owner-only, rate limits, nonce expiry and reuse, callback answered, 409 handling, outbox throttling, redaction |
| ai-review/ | cost guard at the cap, refusal and error paths, schema failure, bounds and step rules, no names, symbols or third-party data in the prompt |
| ops/ | run lock on Windows and Linux, heartbeat semantics, disk thresholds, backup rotation (7) |
| redactor | canary secrets (bot token, `sk-ant-`, hc-ping URL, 64-byte key as base58 and JSON array) never appear in logs, Telegram text, errors, exports or prompts |
| import graph | parses every import; fails on a forbidden edge (strategies or ai-review into chain, execution, signer, storage, telegram; anything but storage importing `node:sqlite`) |

## 6. Fixtures and replay tests

Recorded read-only from mainnet with `npm run fixtures:record` (paced under the budget
table). Raw recordings stay out of git; committed copies are scrubbed.

| Fixture | Source (VERIFIED_FACTS, research) | Tests |
|---|---|---|
| FOMO v1 trades: pump-curve leg, PumpSwap leg, DFlow-only, Jupiter-only, failed trade, signer-only non-trade | fresh recordings, Phase 3 | decoder, completeness, `maxSupportedTransactionVersion: 1`; user wallets replaced by fixed fake keys inside the event bytes (D1) |
| pump.fun create_v2 launch, tx `3F3PNNDtX1PF2AT6qNN27ggz453X4NFubzgLPVQjfFEdpJMbWk7P2QnrHPNKyYXGiHREdQJVCY5Ln6iYHyYwKBqx` (slot 465,106,841), mayhem mint `897tnAdpiAETR2E3nHropcXWdwpikQFMCSd6raXwpump` | phase0-token-safety rows 15-16 | launch event, Token-2022 mint with metadata extensions, mayhem rejection |
| Launch-slot pattern, mint `5w3sGrqfkJZhaTis1nZa4YbVY6VAP21qrmbjEkmApump` | phase0-token-safety row 34 | same-slot identical buys; buyer addresses scrubbed |
| Curve FeeConfig `8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt`, PumpSwap FeeConfig `5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx`, Global `4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf`, a canonical PumpSwap pool | VERIFIED_FACTS s.3 | fee tiers, layouts, PDA derivation |
| PYUSD `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo` | row 23 | reject: permanent delegate, confidential transfers, hook authority |
| BERN `CKfatsPMUf8SkiURsDXs7eK6GWb4Jsd6UDbs7twMCWxo` | row 37 | reject: transfer fee with live authority |
| LIBRA `Bo9jh3wsmcC2AjakLWzNmKJ3SgtZmXEcSaW7L2FAvUsU` | row 38 | passes static checks, mutable metadata logged: "static pass is not safe" |
| TUCAT `6oEkKhW6yvs64oNPjaj4oQZZjBrKUt9X5BnBfNQHTfzp` | row 39 | reject: freeze authority |
| Fartcoin `9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump` | row 21 | legacy pump token, curve complete: graduated path |
| USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | row 22 | reject: mint and freeze authority |
| Synthetic mints | built in tests | unknown extension type, bad TLV length, Token-2022 mint over 82 bytes without extensions |
| Failed and partial fills | recorded pump and PumpSwap failures; synthetic curve near completion | minOut failure pays fees; buy capped by real tokens; BondingCurveComplete |

Rules: third-party API recordings with redistribution limits (DexScreener, Jupiter) and
unchecked terms (GeckoTerminal) are withheld from git the way the root project's
`tests/withheld.py` does it: a `tests/withheld.ts` list, tests skip with a clear reason when
the file is absent. The official pump IDL files are not committed (licence UNVERIFIED);
tests compare our hand-written layouts with the IDL's hash and fields when the file is
present locally. Replay tests feed recorded streams through the real pipeline at 1x and
10x speed with a fake clock and must produce identical decisions.

## 7. Integration tests

- Full pipeline with fakes: FOMO notifications to intent, safety, risk, plan, paper fill,
  exits, ledger, Telegram alert, in one process.
- Restart: kill the process at each order state (intent saved, token consumed, order
  submitted, fill written) and restart; expect no duplicate order and the rules of
  ARCHITECTURE.md diagram (e).
- Telegram against a local fake Bot API: pairing, every command, confirmations, 409.
- AI review against a fake Messages API: valid, refusal, error, invalid schema, over cap.
- Config: /set, AI approve, rollback, restart with each version.

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
| Duplicates and reorder | every event twice, shuffled within 20 slots | identical decisions to the clean run |
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
- Every failed attempt charges base and priority fees; tips only on landed attempts.
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

Locally (PowerShell or bash, from `fomo-bot/`):
- `npm ci --ignore-scripts`
- `npm run typecheck` (runs `tsc --noEmit`)
- `npm run lint` (runs `eslint .`)
- `npm test` (runs `vitest run`); `npm run test:coverage` with the thresholds above
- pre-commit hook: `gitleaks git --pre-commit --redact --staged --verbose`
- root checks before every commit (repository root): `uv run pytest`,
  `uv run ruff check src tests`, `uv run mypy`

CI (GitHub Actions, actions pinned by commit SHA, no secrets in CI):
1. Supply chain: every lockfile `resolved` URL starts with `https://registry.npmjs.org/`
   and has `integrity`; `npm ci --ignore-scripts`; `npm audit signatures`;
   `npm audit --audit-level=moderate`.
2. Checks: typecheck, lint, vitest with coverage thresholds, on ubuntu-latest and
   windows-latest (paths, LF endings, ASCII output, run lock).
3. Secrets: `gitleaks git --redact --verbose` over the full history (fetch depth 0).
4. Root project: `uv sync --locked`, `uv run pytest`, `uv run ruff check src tests`,
   `uv run mypy`.

## 12. What tests cannot show

Whether any strategy has an edge, real landing rates and latency, whether the public
WebSocket survives weeks, and how often baits and sandwiches hit us. Those come only from
the paper soak (Phase 7) and the owner-approved minimum live test (Phase 8).
