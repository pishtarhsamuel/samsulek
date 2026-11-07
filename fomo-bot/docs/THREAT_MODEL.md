# Threat model (Phase 1 design)

For the security-auditor and the owner. Scope: the paper bot (Phases 2-7) and, at interface
level, the live path (Phase 8). Companion docs: ARCHITECTURE.md, RISK_POLICY.md. Items that
change Claude Code guardrails or GitHub settings are proposals only (section 7).

## 1. In plain English

- Until Phase 8 there is no wallet key at all, so nobody can steal money from the bot. The
  worst a paper-phase attack can do is waste time, leak your settings, or abuse your API
  keys (Telegram, Anthropic).
- In Phase 8 the key sits only on the VPS, inside a small container that has no internet
  and checks every transaction against its own rules and daily limits. The bankroll stays
  small, so the worst case is losing that bankroll, not more.
- The likeliest real attacks are poisoned software packages, someone taking over your
  Telegram or your PC, and traders who build fake tokens to trap bots. Each has a control
  below, and each leaves some risk that is written down honestly.

## 2. Assets

| Asset | Where it lives | If lost or misused | Exists from |
|---|---|---|---|
| Live wallet key | VPS `/srv/fomo-signer/live-wallet.key` (outside the checkout), mounted read-only into the signer container only | bankroll stolen (at most the bot's share of EUR 50) | Phase 8 |
| Owner's Telegram account | owner's phone and desktop | bounded control of the bot (see A3) | Phase 2 |
| Telegram bot token | VPS `/etc/fomo-bot/secrets/telegram_bot_token`; on the PC a folder outside the checkout | impersonate the bot, read updates, phish the owner, break polling | Phase 2 |
| Anthropic API key (optional) | same folder | spend on the owner's prepaid credits | Phase 5 |
| Healthchecks.io ping URLs | same folder | fake "alive" pings hide an outage; fake failures | Phase 7 |
| VPS access | owner's SSH key (owner PC), hosting-provider account | everything on the server, including the key | Phase 7 |
| Repository | GitHub (public until the owner makes it private, D2) | readers learn the rules; tampered code if write access leaks | now |
| Config and limits | `HARD_CAPS` in code; server file `/etc/fomo-bot/fomo-bot.json` (read-only mount); tunables and modes in the DB; signer policy file | looser limits, wrong withdraw address | Phase 2 |
| Database and backups | `/data/fomo.sqlite` (WAL), `data/backups/`, optional Telegram copy | trade history, tuned thresholds, wallet address, owner's Telegram id leak; tampering | Phase 2 |
| Public IP reputation | VPS IP at the public RPC and free APIs | blocked from data (403) | Phase 7 |

## 3. Adversaries, controls and residual risk

| # | Adversary or failure | How it hurts | Controls | Residual |
|---|---|---|---|---|
| A1 | Malicious npm package (account takeover, worm, typosquat, poisoned lockfile) | steals secrets, alters orders | exact pins (zod too), committed lockfile, `npm ci --ignore-scripts`; `.npmrc` `registry=https://registry.npmjs.org/`, `min-release-age=7`, `allow-git=none`, `allow-remote=none`; CI and the image build fail on any lockfile entry not in the approved name@version+sha512 list (TEST_PLAN s.11); `npm audit signatures`; security-auditor approves every dependency; few dependencies (no web3.js v1, @pump-fun SDKs, dotenv, logger, Anthropic SDK or grammy: built-ins and fetch); npm and node never run on the VPS host, only inside a multi-stage build whose tests run with no network; Phase 8 signer is a separate image with no npm packages and no network | a bad package inside `bot` can read the mounted secrets (Telegram token, Anthropic key, ping URLs) and send false orders to the signer; the signer's policy and caps bound the money damage (A17) |
| A2 | Fake "sniper bot" repos, gists, Telegram code | key-stealing code copied into the project | rule: never copy such code; pump.fun and PumpSwap layouts are written by us from the official IDLs; reviews of every money change | low |
| A3 | Telegram account hijack (SIM swap, stolen session) | attacker issues commands | auth by numeric id in a private chat only (`chat.id == from.id`); pairing only at the server (10+ base32 characters, constant-time, 5 tries in total); commands bounded: nothing above HARD_CAPS, no mode change via config, no withdraw-address change, live needs `FOMO_LIVE` plus TTY arming of bot and signer; in live every loosening and /resume waits 24 h with an email notice; dangerous commands need a tap; rate limits; hash-chained audit log; owner can `fomo kill` at the server; owner enables Telegram 2-step verification (guide) | attacker can /panic (sell at a loss within the cap), /pause, tighten, /golive an already-armed strategy that passed its gate. Bait attack: loosen the crowdflow floors to their minimum (3 distinct buyers) and then fake a crowd with 3 FOMO accounts; in live the loosening waits 24 h and emails the owner, who can /cancel it or `fomo kill`; in paper it only costs paper money |
| A4 | Bot token leak | phishing messages as the bot, reading updates, setting a webhook to break polling | token only in a secret file; redactor; messages never carry third-party text, `parse_mode` off, no link previews, so our real alerts never look like phishing; 409 Conflict or webhook detection opens TELEGRAM_DOWN and heartbeat `/fail`; owner rotates with BotFather `/token` (guide) | phishing until rotated; no command power (the attacker is not the owner id) |
| A5 | Internet scanners, SSH brute force | server takeover | no published container ports (Docker bypasses ufw); ufw SSH only, `IPV6=yes`; SSH keys only (`PasswordAuthentication no`, `KbdInteractiveAuthentication no`, cloud-init drop-ins checked), no root login, fail2ban, unattended security upgrades; containers non-root with separate numeric uids, `cap_drop: [ALL]`, `no-new-privileges`, pids limit, read-only root fs, no Docker socket mounted; Phase 8: `authorized_keys` holds only the owner's key, or a fresh VPS | provider-level compromise |
| A6 | Bait-token creators (pass static checks, then rug) | our buy becomes their exit liquidity | safety rejects by default; raw TLV parse; holder and creator concentration; identical-amount clusters; creator blocklist; age, liquidity and non-FOMO activity floors; 0.5% pool share; hard stop; thresholds out of git (D2) | small losses per bait trade; pump.fun coins pass static checks by construction |
| A7 | Sybil FOMO flow (a few accounts faking crowd buying) | lures crowdflow entries | distinct-buyer floor; top-buyer, same-slot and identical-size share caps; median buy size; requires non-FOMO volume and holder growth; confidence capped; the AI may only tighten these; no per-user lookups (D1) so funding links are not checked | a careful sybil with many funded accounts can still bait us; each FOMO trade costs them at least the $0.10 fee, so baiting a $5 trade is barely profitable for them |
| A8 | MEV and sandwich bots | worse fills | tight minOut (2% buy cap); pool share cap; Helius `mev-protect` on SWQOS-only sends or Jito with `jitodontfront` (Phase 8); no 0.001 SOL services | loss up to the slippage cap per trade; nothing guarantees zero |
| A9 | Poisoned or wrong API data (prices, trending, a malicious RPC later) | bad entries, wrong marks | execution math uses on-chain reserves only; Jupiter cross-check (3%) gates entries; zod on every response; trending only nominates candidates; context-slot staleness check; later providers can be cross-checked on P0 reads | a lying single RPC could still mislead marks; live requires a second provider (decision 3) |
| A10 | Prompt injection through token names, symbols or URIs | AI proposes harmful changes, or injects text into alerts | names, symbols, URIs and all free text are excluded from the prompt; mints are internal ids; output is schema-checked and bounded; AI text in Telegram is ASCII only, length-capped, URLs removed; proposals need the owner's tap; AI cannot touch caps, modes, the paper model, withdraw, providers or code, and only tightens safety and anti-sybil parameters | a misleading summary; changes still bounded |
| A11 | Mistakes by Claude or its subagents | loosened limits, bypassed risk engine, secrets committed, live started | hard caps in code, reviews (risk-guardian, security-auditor veto), import-graph test, property tests, gitleaks with custom rules, root guard hook blocks setting `*_LIVE` variables and `reset-halt`, Claude never holds keys or SSH to a key-holding server; tests never load secrets; proposed guardrail extensions in section 7 | a subtle logic bug that passes review; mitigated by small size and invariants checked at runtime |
| A12 | Compromised owner PC | steals SSH key, Telegram desktop session, git credentials | SSH key with a passphrase (FIDO2 key optional), separate VPS user, no key or secret copy on the PC in Phase 8, Telegram 2-step verification, GitHub 2FA, paper on the PC inside Docker Desktop (decision 11) | full VPS compromise is possible: key theft bounded by the bankroll |
| A13 | Hosting-provider account takeover or malicious host | console access, disk snapshots | strong unique password and 2FA on the provider account (guide); small bankroll | the host can always read the disk |
| A14 | Base image, OS or deploy tampering | backdoored runtime or code | Node image pinned by digest; `ops/update.sh` deploys only an owner-created tag on protected `main` after the owner confirms the commit hash and green CI (decision 15); Ubuntu from the provider's LTS image; unattended security updates | trust in Docker Hub, GitHub and the provider |
| A15 | Public repository readers (D2) | learn entry rules to bait the bot | no tuned thresholds or wallet address in git; placeholders only; if still public before Phase 8, emergency-trigger values become placeholders too (RISK_POLICY s.12); the owner makes the repository private | logic is still readable until then |
| A16 | Terms enforcement (FOMO s.16, provider terms) | account bans, IP blocks | never touch FOMO's services; aggregate counts only; user tags in memory for 15 min; raw decode samples in memory only; no address or signature of a FOMO user in any log, DB row or fixture (D1); no Helius until it confirms in writing (D3); budget governor keeps us under public limits; DexScreener and Jupiter data never redistributed | FOMO could still object to any use of its on-chain footprint; not legal advice |
| A17 | Compromised `bot` process (via A1) talking to the signer (Phase 8) | signs harmful transactions | signer policy (section 5): own parsing of the exact bytes, allowlists, value only to the bot wallet, its ATAs, allowlisted tips or the pinned withdraw address; pinned values never come over IPC; own TTY arming and KILL latch; own counters and daily caps; socket for the bot uid only | it can buy a token the attacker controls at a bad price, up to 0.35 SOL of buys per day, and burn up to 0.02 SOL/day in fees; in practice the bankroll is the limit |
| A18 | Spam tokens, address-poisoning dust | trick the bot or the owner into sending to a look-alike, or halt the bot | unknown mints never enter equity and are never touched; withdraw goes only to the pinned address, never to a "recent" one; SOL dust stays out of equity (min of ledger and chain) | dust over 0.0005 SOL or into a held mint halts entries (griefing); exits continue |

## 4. Secrets design

| Secret | Where | How it is loaded | Never |
|---|---|---|---|
| Telegram bot token, Anthropic key, Healthchecks ping URLs, later Helius key | VPS `/etc/fomo-bot/secrets/` (files 0400, owned by the bot's numeric uid); on the PC a folder outside the checkout; `fomo-bot/env.example` in git with placeholders for non-secret settings | Docker Compose `secrets` file mounts into `bot` only; `src/config/secrets.ts` reads them once at start into a frozen object, only when the process is started with the owner's `--load-secrets` flag (set in the compose file) | environment variables; git, logs, Telegram, the DB, backups, `stats:export`, AI prompts, error messages, URLs in logs (query strings stripped) |
| Live wallet key (Phase 8) | VPS `/srv/fomo-signer/live-wallet.key` (0400, signer uid), outside the checkout | file mounted read-only into the `signer` container only | in the `bot` container, logs, Telegram, backups, Claude's context, any machine but the VPS |
| Creating the key | owner runs `docker compose run --rm signer wallet-create` | prints only the public address; refuses if the file exists | printed, logged or sent |
| Backing it up | owner runs `ops/wallet-backup.sh` | the script refuses unless `docker inspect` shows logging driver `none` for the signer; inside, the command refuses unless stdin and stdout are TTYs, shows the key once with offline-storage steps, then clears the screen and scrollback; logs "backup shown" without content to the signer's own audit file | run by Claude; piped; screenshotted into chat |
| Withdraw address, bot wallet address | server file, signer policy file, DB | not secret, but kept out of git (D2) | committed |
| Approval-token HMAC key | memory of the `bot` process, new each boot | `crypto.randomBytes` | stored |

Process hygiene: core dumps off (`ulimits core 0`); start-up refuses `--heapsnapshot-signal`,
`--report-*` and `--inspect` in `process.execArgv` or `NODE_OPTIONS`. Tests and any command
Claude runs never load the secrets: a vitest setup file makes the loader throw, like the root
`no_side_effects` fixture. Deleting values from `process.env` is not a control and is not used.
Anthropic, Telegram and hc-ping base URLs are code constants, so no config can redirect a secret.

Redaction: one redactor in `core/` used by the logger, the Telegram outbox, error formatting,
every DB free-text column, `stats:export` and the AI prompt builder. It removes values by key
name (token, key, secret, password, url, authorization) and by pattern: Telegram bot tokens
(digits, colon, 30+ token characters), `sk-ant-` keys, hc-ping URLs, base58 strings of 87-88
characters (64-byte keys, and also signatures), JSON arrays of 64 small integers, `api-key=`
and `api_key=` query parameters. Transaction signatures therefore live only in typed fields,
and Solscan links are built from them after redaction. The weekly DB copy is scanned for the
same patterns and not sent on a hit. Tests plant canary secrets and assert they never appear.

Rules for Claude: never read, print, grep or copy env, key or `.pem` files or secret folders;
never SSH into the VPS once it holds the key; the owner runs server commands from
OWNER_GUIDE.md and never pastes their output if it could contain a secret. If the owner
pastes a secret anywhere, tell them to rotate it immediately (bots can delete private
messages under 48 h old, but rotation is still required).

## 5. Signer policy (Phase 8, complete rule list)

The signer refuses every request unless all rules hold. Invariant 12 tests each rule.
1. Transport: Unix socket mode 0600 for the bot's uid only; requests over 2,048 bytes refused;
   the request carries the order id, kind and unsigned wire message. The signer parses the
   message itself and signs exactly those bytes. Tip accounts, the withdraw address and the
   caps come only from `/srv/fomo-signer/policy.json`, never from the request.
2. Message: the bot wallet is the fee payer and the only signer; no address lookup tables; no
   AdvanceNonceAccount (durable nonce) anywhere.
3. Programs: System, ATA, Token, Token-2022, compute budget, pump, PumpSwap, Raydium CPMM;
   only known instruction discriminators. CU price <= 400,000 uL/CU, CU limit <= 300,000.
4. System: Transfer only, and only (a) to the bot's own derived wSOL ATA, with SyncNative and a
   CloseAccount of that ATA to the bot wallet in the same transaction; (b) one tip of at most
   5,000 lamports to an account in the static allowlist; (c) the withdraw to the pinned address.
5. Token and Token-2022: only SyncNative and CloseAccount (the bot's own account, destination
   the bot wallet); never Transfer, TransferChecked, Approve, SetAuthority or anything else.
   ATA: create-idempotent only with the bot wallet as owner.
6. pump, PumpSwap, CPMM: every value-receiving account (user, user token and quote accounts)
   is the bot wallet or its ATA derived inside the signer (`node:crypto`, tested on fixtures);
   buy max-in <= 0.06 SOL (or the live cap).
7. Counters on its own volume, persisted in `/srv/fomo-signer/counters.json` per Athens day
   (unreadable = no buys): buys' max-in plus fees <= 0.35 SOL/day; fees and tips of all other
   transactions <= 0.02 SOL/day; <= 150 signatures per hour.
8. Arming: buys only after `signer arm` at the TTY (ends at restart) and while no KILL has been
   seen on the read-only `data/run` mount (missing or unreadable = KILL; KILL disarms until
   re-armed). Sells, closes and the withdraw are signed while disarmed, within the caps.

## 6. For the security-auditor's review

1. Sell probe (`holder-sim`, decision 2): a random holder who bought on the curve, never the
   creator, top-10 or launch-slot buyers; never stored or logged; probe bytes with zeroed
   signatures; the paper ProviderClient type has no send capability; `probePayer` rejects
   anything that is not a 32-byte public key. Blind spots (a pass is not proof): honeypots
   that whitelist insiders, a pool-admin pause, later fee changes, rent differences between
   the holder and us, state changes before our fill.
2. Signer policy completeness (section 5) for pump, PumpSwap and Raydium CPMM, closes and tips.
3. Pairing code: printed by `fomo pair` at the server TTY, so it does not land in Docker logs.
4. Optional weekly database copy to the owner's Telegram: scanned, no secrets by design.
5. Dependencies (exact versions after the 7-day cooldown): `@solana/kit`,
   `@solana-program/system`, `token`, `token-2022`, `compute-budget`, `zod` (pinned exactly;
   4.6.7 is current); dev: `typescript` 6.0.3, `eslint`, `typescript-eslint`, `vitest`,
   `fast-check`, a vitest coverage provider (not yet researched: UNVERIFIED). Excluded:
   web3.js v1, `@pump-fun/*`, `dotenv`, `pino`, `@anthropic-ai/sdk`, `ws`, `undici`.
   **grammy: recommend replacing** it with our own small Bot API client over fetch (only
   getUpdates, sendMessage, answerCallbackQuery), because grammy pulls node-fetch 2,
   whatwg-url, tr46, webidl-conversions, abort-controller, event-target-shim, debug and ms
   (list from the security review; not yet in VERIFIED_FACTS), eight more packages to approve
   and watch for a few hundred lines of HTTPS JSON.
6. Node 26.13.0 image tag and digest; gitleaks v8.30.1: verify the release SHA256 against its
   published checksums before installing (UNVERIFIED until done).

## 7. Guardrail and repository gaps (need the owner's OK; not done)

The root hook `.claude/hooks/guard.py` blocks `.env*` and keypair files, setting any
`*_LIVE` variable to a truthy value (so `FOMO_LIVE=true` is blocked for Claude), and
`reset-halt` (the fomo-bot CLI reuses that name on purpose). It does not yet cover
`secrets/` folders, `*.key` or `*.pem`, the owner-only fomo-bot commands, Docker commands
aimed at the signer, or readers like `python`, `node`, `cp`, `base64`, `git show`, `ssh` and
`scp` (REVIEWS.md, 2026-11-04). The concrete proposals are ARCHITECTURE.md s.14:
- decision 13: `caps.ts` and the go-live checklist on the "ask" list; `fomo-bot/data/`
  (KILL flag, database) write-protected like the root `state/`;
- decision 14: Read/Edit deny for `**/*.pem`, `**/*.key`, `**/secrets/**`; hook blocks for
  `wallet-create`, `wallet-backup`, `arm-live`, `signer arm`, `apply-pending`,
  `docker inspect`, `docker compose config`, and `docker exec`/`run`/`cp` aimed at the
  signer, secrets or the live wallet, each with a hook test; the Claude Code sandbox with
  filesystem deny-read for `secrets/`, `*.key`, `*.pem` and env files;
- decision 15: GitHub 2FA, branch protection on `main` (required CI and review), owner-only
  release tags.
Until the owner approves: no key exists before Phase 8, keys never exist where Claude runs,
and .gitignore already covers `secrets/` and `*.key`.

## 8. Residual risks the owner accepts by going ahead

- Root access to the VPS or the owner's PC can steal the live key: the bankroll is the
  limit of the loss.
- A malicious package in the bot can read the Telegram token, Anthropic key and ping URLs,
  and, in Phase 8, steer up to the signer's daily caps into bad trades.
- The free public RPC can block the bot without notice; in paper that only pauses tests.
- FOMO can change its on-chain footprint any day; the bot then stops crowdflow and waits.
- Baiting and sandwiches cost small amounts per trade and cannot be prevented completely.
- A Telegram takeover can sell positions at a loss (within the caps) but cannot send money
  anywhere except the owner's own withdraw address, and live loosening waits 24 h.
- A logic bug that passes every review and test remains possible; runtime invariants,
  absolute caps and small sizes bound it.
