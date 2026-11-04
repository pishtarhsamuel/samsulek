# Reviews and sign-offs

Every change that touches money, keys, dependencies or deployment needs APPROVED from
both risk-guardian and security-auditor before it is committed or merged
(BUILD_PROMPT.md section 4.4). A BLOCKED verdict stops the merge until it is fixed and
re-reviewed. Newest entries first. Verdicts are recorded by the main session exactly as
the reviewer gave them.

| Date | Change | Reviewer | Verdict | Findings and fixes |
|---|---|---|---|---|
| 2026-11-04 | Phase 0 team setup: `.claude/settings.json` deny rules, 8 agents, 3 skills, `fomo-bot/` files, root CLAUDE.md pointer | security-auditor | APPROVED | (1) MEDIUM: `*.db`, `*.db-*`, `*.log`, `npm-debug.log*` were not ignored. Fixed in fomo-bot/.gitignore. (2) MEDIUM: the review-trades skill could be read as "SSH into the server" from a cloud session. Fixed with a note in the skill. (3) LOW: unanchored ignore rules would hide source folders named secrets, backups, build or dist. Naming rule added to fomo-bot/CLAUDE.md. (4) LOW: STATUS.md, VERIFIED_FACTS.md and FEASIBILITY.md were not written yet. STATUS.md added; the other two close Phase 0. (5) LOW: a key file named e.g. wallet.json is neither ignored nor blocked. Phase 1 must store the server key under `secrets/` with a `.key` name. (6) INFO: start sessions at the repository root. Added to fomo-bot/CLAUDE.md. Remaining gap, owner decision: the guard hook does not recognise `secrets/`, `*.key` or `*.pem`. The settings deny rules cover cat/head/tail/sed, not python, node, cp, base64, git show or ssh. A hook change with tests is recommended; it needs the owner's OK. Guard-hook tests: 36 run, OK. No secrets in the new files (only public on-chain addresses). |
| 2026-11-04 | Phase 0 team setup | risk-guardian | not required | No sizing, order, balance, wallet or execution code exists or changed. |
