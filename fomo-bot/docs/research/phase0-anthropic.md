# Phase 0 research: Anthropic API for the daily AI review

Researcher: main session, checked 2026-11-04 (00:45 UTC). Sources read directly from
platform.claude.com (reachable from the build environment). Nothing was blocked.

## Facts

| # | Fact | Value | Source URL | Checked | Confidence | How confirmed |
|---|---|---|---|---|---|---|
| 1 | Haiku model ID | `claude-haiku-5-5` (API ID and alias are the same string) | https://platform.claude.com/docs/en/about-claude/models/overview | 2026-11-04 | HIGH | docs (models table) |
| 2 | Sonnet model ID | `claude-sonnet-5-5` (API ID and alias are the same string) | https://platform.claude.com/docs/en/about-claude/models/overview | 2026-11-04 | HIGH | docs |
| 3 | Context window / max output | Both: 1M tokens context, 128K output (synchronous API) | same | 2026-11-04 | HIGH | docs |
| 4 | Earliest retirement | Haiku 5.5: not sooner than 2027-10-07. Sonnet 5.5: not sooner than 2027-09-28 | same | 2026-11-04 | HIGH | docs |
| 5 | Haiku 5.5 price (prompts up to 100k tokens) | Input $0.10/MTok, output $0.50/MTok, 5-min cache write $0.125, 1-h cache write $0.20, cache hit $0.01 | https://platform.claude.com/docs/en/about-claude/pricing | 2026-11-04 | HIGH | docs |
| 6 | Haiku 5.5 price (prompts over 100k tokens) | Input $0.50, output $2.50, cache hit $0.05 per MTok | same | 2026-11-04 | HIGH | docs |
| 7 | Sonnet 5.5 price | Input $2/MTok, output $10/MTok, 5-min cache write $2.50, 1-h cache write $4, cache hit $0.10 (0.05x input) | same | 2026-11-04 | HIGH | docs. Note: the Claude Code skill's cached table (2026-10-06) said $0.20 for Sonnet 5.5 cache reads; the live page says $0.10. The live page wins. |
| 8 | Batch API | 50% off input and output; Haiku 5.5 $0.05/$0.25, Sonnet 5.5 $1/$5 per MTok; results are asynchronous | same | 2026-11-04 | HIGH | docs |
| 9 | US-only inference (`inference_geo`) | 1.1x on all token prices; global routing (default) is standard price | same | 2026-11-04 | HIGH | docs |
| 10 | Strict JSON-schema output | Structured outputs (`output_config.format` with `type: "json_schema"`, and `strict: true` tools) are **stable** and list both `claude-haiku-5-5` and `claude-sonnet-5-5` as supported models | https://platform.claude.com/docs/en/build-with-claude/structured-outputs | 2026-11-04 | HIGH | docs (page front matter) |
| 11 | Thinking on Haiku 5.5 | Adaptive thinking is ON by default (effort default `medium`); `thinking: {type: "disabled"}` is accepted only at effort `high` or below. Thinking tokens bill as output tokens | Claude Code `claude-api` skill (bundled 2026-10), consistent with the docs above | 2026-11-04 | MEDIUM | SDK reference shipped with Claude Code; re-check against the live adaptive-thinking page before coding |
| 12 | Thinking on Sonnet 5.5 | `{type: "disabled"}` returns HTTP 400; thinking off = `{type: "between_tools"}` (effort `high` or below) | same | 2026-11-04 | MEDIUM | same as #11 |
| 13 | Refusals | A response can stop with `stop_reason: "refusal"`; Haiku 5.5 has no server-side fallback. Code must check `stop_reason` before reading content | same | 2026-11-04 | MEDIUM | same as #11 |
| 14 | Hard spend cap on the Anthropic side | **UNVERIFIED.** Prepaid credits with auto-reload off act as a natural cap; Console spend-limit features exist but are described as previews for Console organisations. Minimum credit purchase amount not checked | https://platform.claude.com/docs/en/about-claude/pricing | 2026-11-04 | UNVERIFIED | Confirm in the Console at sign-up (owner) |

## Cost of the daily review (section 13 of the brief)

Assumption: one call per day, about 5,000 input tokens (stats JSON plus instructions) and
about 1,000 output tokens, plus thinking tokens billed as output.

| Model, settings | Per call | Per month (30 calls) | Fits $1/month? |
|---|---|---|---|
| Haiku 5.5, effort `low`, ~500 thinking tokens | 5,000 x $0.10/M + 1,500 x $0.50/M = $0.00125 | about $0.04 | Yes, with about 25x headroom |
| Haiku 5.5, default effort, ~4,000 thinking tokens | $0.0005 + $0.0025 = $0.003 | about $0.09 | Yes |
| Sonnet 5.5, thinking off (`between_tools`) | 5,000 x $2/M + 1,000 x $10/M = $0.02 | about $0.60 | Yes, but only 1.7x headroom |
| Sonnet 5.5, default (adaptive, ~3,000 thinking tokens) | $0.01 + $0.04 = $0.05 | about $1.50 | **No** |

## What this means for the bot

- Default to `claude-haiku-5-5`: the whole month costs a few cents, far under the $1 cap.
- Switching the default to `claude-sonnet-5-5` only fits the $1 cap with thinking off and
  short prompts. The bot must enforce the cap itself: before each call, estimate the
  worst-case cost from `max_tokens` and the token count, add it to the month's logged
  spend, and skip the call (with a Telegram note) if the cap would be exceeded. Log
  input/output tokens, model id, cost and latency for every call.
- Prompt caching and the Batch API do not help a once-a-day call (caches last 5 minutes
  or 1 hour; batches are asynchronous). Not worth the complexity.
- Use structured outputs (`output_config.format`, JSON schema) for the review, then still
  validate every proposal against the bounds in RISK_POLICY.md and drop invalid ones:
  schema-valid is not the same as safe.
- Handle `stop_reason: "refusal"` and API errors by skipping that day's review (fail closed,
  no config change).

## UNVERIFIED and how to confirm

- #14: the minimum prepaid credit amount and whether a hard monthly spend limit can be set
  for a personal account. The owner sees both when creating the API account; record them
  in VERIFIED_FACTS.md then.
- #11-#13 come from the SDK reference bundled with Claude Code, not from the live page.
  Re-read https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking before
  writing the ai-review module (Phase 5).
