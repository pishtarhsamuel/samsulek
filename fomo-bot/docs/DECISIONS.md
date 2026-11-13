# Owner decisions

Decisions the owner made in the conversation, newest first. Where one differs from
`BUILD_PROMPT.md`, this file wins. Only the owner adds or changes a decision; Claude
records it with the date and the exact question it answered.

| # | Date | Decision | Question it answered | Effect on the build |
|---|---|---|---|---|
| D5 | 2026-11-13 | The four recommendations of the step 6 storage design (STORAGE_DESIGN.md s.8) accepted: (1) every strategy starts switched off and paper trading begins only when the owner sends /paper; (2) a broken database also stops new sell orders, accepted for paper; an emergency sell path that does not depend on the database is decided before Phase 8; (3) the bot's data folder stays out of OneDrive and network drives, and the bot refuses to start from such a folder; (4) one halt covers paper and live (a paper -50% halt also stops live entries; stricter, it matters only in Phase 8). | "Do you accept these four recommendations?" (owner: "Yes") | Step 6: the first migration writes every strategy mode as off; storage failures latch entries and exits off in paper; the start-up check refuses a synced or network data folder (heuristic); halt reasons are shared by both modes. Open before Phase 8: the database-independent emergency sell path. |
| D4 | 2026-11-07 | Phase 1 design approved with every recommended answer in ARCHITECTURE.md s.14: (1) signer in its own offline container; (2) paper sell check by simulating a random current holder's sale; (3) live money needs a second data provider; (4) the -50% halt is lifted from Telegram in paper, only at the server in live; (5) two daily stops in a row need /resume; (6) weekly database copy (no secrets) to the owner's Telegram; (7) Telegram down 30 min stops new entries; (8) after a pump.fun upgrade, paper resumes after a self-test, live waits for the owner; (9) live uses the root project's stricter limits until the owner decides before Phase 8; (10) weaker anti-bait checks accepted (no FOMO-user lookups); (11) paper on the owner's PC runs in Docker Desktop; (12) live loosening waits 24 h with an email; (13) and (14) the guardrail changes are authorized; (15) the owner sets up GitHub 2FA and a protected main before Phase 7. | "Shall I take all the recommended answers?" (owner: "Yes approved") | Phase 2 may start. Guardrails 13-14 are applied to `.claude/` with tests, each edit through an approval prompt. |
| D3 | 2026-11-07 | Paper trading runs on free public Solana endpoints, with no sign-ups. Helius is not used until Helius confirms in writing that a personal trading bot is allowed under its terms (clause xi). Claude drafted the email (`docs/drafts/helius-terms-question.md`); the owner sends it. | FEASIBILITY.md question 3 | Design for the public RPC and public websocket first, behind a provider interface so another provider can be added later without code changes elsewhere. No API keys in Phases 1-4. |
| D2 | 2026-11-07 | The owner will make the GitHub repository private. | FEASIBILITY.md question 2 | Until the owner confirms it is private, no strategy thresholds or tuned parameters are committed, and the bot's wallet address never goes into git. |
| D1 | 2026-11-07 | Test FOMO crowd flow and momentum first. Skip copy-trading. | FEASIBILITY.md question 1 (FOMO terms s.16 ban tracking other users) | No copy-trading strategy, no wallet leaderboard, no `/follow`, `/unfollow` or `/watchlist`, no looking up wallets in FOMO profiles. Strategy order for Phase 4: crowd flow, then momentum, then launch sniping (last, smallest allocation). The crowd-flow signal uses aggregate FOMO activity only. |

## Defaults in force until the owner decides otherwise

From `FEASIBILITY.md` section 5 (the stricter rule applies). The owner has not yet
confirmed or changed these:
- Paper only; no live sending code before Phase 8 and the owner's explicit OK.
- The bot's bankroll counts toward the owner's EUR 50 total capital at risk.
- The brief's limits are ceilings, plus the root project's cap of 0.5% of pool liquidity
  per position.
- The VPS runs keyless paper trading; the live key exists only from Phase 8.
- The owner runs every server command; Claude never gets SSH access to a machine that
  holds the live key.
- Results are also rerun at 2x costs and compared with random entries.
