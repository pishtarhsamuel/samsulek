---
name: review-trades
description: Reviews recent bot performance from the stats export and proposes bounded parameter changes, like the daily AI review.
disable-model-invocation: true
---
Fetch the latest stats export (it contains no secrets) from the server with the project's stats-export command. Summarize performance per strategy and exit policy after all costs, in plain English. Propose at most 3 parameter changes within the bounds in fomo-bot/docs/RISK_POLICY.md, each with reason, expected effect and risk. Never change live settings yourself; the owner approves changes in Telegram.

Getting the export: a cloud Claude session never connects to the server (it holds the live key). If no export file is present locally, ask the owner to run the stats-export command on the server and share the JSON file. From the owner's own computer, use SSH only with the owner's permission, and never read secrets on the server.
