---
name: go-live-check
description: Runs the go-live gate checklist for one strategy.
disable-model-invocation: true
---
For strategy $ARGUMENTS: check the go-live gate in fomo-bot/BUILD_PROMPT.md section 11 against the recorded paper results, confirm the sign-offs in fomo-bot/docs/REVIEWS.md and fomo-bot/docs/PREMORTEM.md are current, and report PASS or FAIL in plain English with the numbers. Never switch a strategy to live; only the owner can, from Telegram.
