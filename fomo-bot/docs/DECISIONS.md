# Owner decisions

Decisions the owner made in the conversation, newest first. Where one differs from
`BUILD_PROMPT.md`, this file wins. Only the owner adds or changes a decision; Claude
records it with the date and the exact question it answered.

| # | Date | Decision | Question it answered | Effect on the build |
|---|---|---|---|---|
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
