# Status

Updated: 2026-11-08

**Phase 2 (foundations, tests first): starting.** Phase 1's design is approved with every
recommended answer (`docs/DECISIONS.md` D4).

- Done: the guardrail changes you approved. Claude is now blocked from key files, secret
  folders, owner-only server commands, secret-printing Docker commands and the bot's data
  folder; edits to the bot's hard caps and go-live checklist need your OK. 11 new tests.
- Not done: the Claude Code sandbox. It can't run in this cloud container or on Windows,
  and where it runs it would remove prompts and block the network by default. Your call.
- Next: the security reviewer checks the guardrail change and the first dependencies; then
  the toolchain (Node 26.13.0, TypeScript) and the core money math, tests first.
- For you to do: make the GitHub repository private; send the Helius email when you like;
  before Phase 7, turn on GitHub 2FA.
- Unproven: whether any strategy makes money. Nothing has run on paper yet.
