# fomo-bot

A safety-first Solana memecoin bot that tries to use the public on-chain activity of
FOMO app users as a signal. It is built paper-first: it trades no real money until a
strategy has proven an edge after all costs and the owner switches it on.

Not affiliated with, endorsed by, or connected to FOMO (fomo.family). The bot never
uses FOMO's app, website, API or accounts; it only reads public Solana blockchain data.

Status: **Phase 0 (reality check). There is no trading code yet.**
Read `docs/STATUS.md` for the current status in plain English.

| File | What it is |
|---|---|
| `BUILD_PROMPT.md` | The owner's full brief (requirements and hard rules) |
| `CLAUDE.md` | Condensed rules for Claude Code sessions working in this folder |
| `docs/STATUS.md` | Plain-English progress, updated every phase |
| `docs/VERIFIED_FACTS.md` | Every external fact we rely on, with source, date and confidence |
| `docs/FEASIBILITY.md` | What each strategy can realistically do on $5-10/month |
| `docs/REVIEWS.md` | Risk and security sign-offs |
| `docs/research/` | Raw Phase 0 research notes behind VERIFIED_FACTS.md |

This folder sits inside the `samsulek` repository, next to a separate Python research
project. Where the two projects' rules differ, see `CLAUDE.md`.
