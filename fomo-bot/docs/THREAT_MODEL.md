# Threat model (Phase 1 design)

For the security-auditor and the owner. Scope: the paper bot (Phases 2-7) and, at interface
level, the live path (Phase 8). Companion docs: ARCHITECTURE.md, RISK_POLICY.md.

## 1. In plain English

- Until Phase 8 there is no wallet key at all, so nobody can steal money from the bot. The
  worst a paper-phase attack can do is waste time, leak your settings, or abuse your API
  keys (Telegram, Anthropic).
- In Phase 8 the key sits only on the VPS, inside a small container that has no internet
  and checks every transaction itself. The bankroll stays small, so the worst case is
  losing that bankroll, not more.
- The likeliest real attacks are poisoned software packages, someone taking over your
  Telegram or your PC, and traders who build fake tokens to trap bots. Each has a control
  below, and each leaves some risk that is written down honestly.

## 2. Assets

| Asset | Where it lives | If lost or misused | Exists from |
|---|---|---|---|
| Live wallet key | VPS `/opt/fomo-bot/secrets/live-wallet.key`, mounted read-only into the signer container only | bankroll stolen (at most the bot's share of EUR 50) | Phase 8 |
| Owner's Telegram account | owner's phone and desktop | bounded control of the bot (see A3) | Phase 2 |
| Telegram bot token | VPS `/opt/fomo-bot/.env`; locally `fomo-bot\.env` | impersonate the bot, read updates, phish the owner, break polling | Phase 2 |
| Anthropic API key (optional) | same `.env` | spend on the owner's prepaid credits | Phase 5 |
| Healthchecks.io ping URL | same `.env` | fake "alive" pings hide an outage; fake failures | Phase 7 |
| VPS access | owner's SSH key (owner PC), hosting-provider account | everything on the server, including the key | Phase 7 |
| Repository | GitHub (public until the owner makes it private, D2) | readers learn the rules; tampered code if write access leaks | now |
| Config and limits | `HARD_CAPS` in code; server file `/config/fomo-bot.json` (read-only mount); tunables in the DB | looser limits, wrong withdraw address | Phase 2 |
| Database and backups | `/data/fomo.sqlite` (WAL), `data/backups/`, optional Telegram copy | trade history, tuned thresholds, wallet address, owner's Telegram id leak; tampering | Phase 2 |
| Public IP reputation | VPS IP at the public RPC and free APIs | blocked from data (403) | Phase 7 |

## 3. Adversaries, controls and residual risk

| # | Adversary or failure | How it hurts | Controls | Residual |
|---|---|---|---|---|
| A1 | Malicious npm package (account takeover, worm, typosquat, poisoned lockfile) | steals the key or `.env`, alters orders | exact pins, committed lockfile, `npm ci --ignore-scripts`, `.npmrc` `min-release-age=7`, `allow-git=none`, `allow-remote=none`; CI checks every lock `resolved` URL is registry.npmjs.org with `integrity`; `npm audit signatures`; security-auditor approves every dependency; few dependencies (no web3.js v1, no @pump-fun SDKs, no dotenv, no logger or Anthropic SDK: built-ins and fetch); secrets deleted from `process.env` after loading; Phase 8 signer has zero npm dependencies and no network, so a bad package in `bot` cannot read or exfiltrate the key | a bad package in `bot` can still send false orders to the signer; the signer's own policy and caps bound the damage to small trades or transfers to tip accounts (tiny) |
| A2 | Fake "sniper bot" repos, gists, Telegram code | key-stealing code copied into the project | rule: never copy such code; pump.fun and PumpSwap layouts are written by us from the official IDLs; reviews of every money change | low |
| A3 | Telegram account hijack (SIM swap, stolen session) | attacker issues commands | auth by numeric user id; commands bounded: nothing above HARD_CAPS, no change of withdraw address, withdraw only to the fixed address, live needs `FOMO_LIVE` plus `fomo arm-live` at the server TTY; dangerous commands need a tap; rate limits; hash-chained audit log; every command echoes to the chat; owner can `fomo kill` at the server; owner enables Telegram 2-step verification (guide) | attacker can /panic (sell at a loss within the cap), /pause, /set within bounds, /golive an already-armed strategy that passed its gate |
| A4 | Bot token leak | phishing messages as the bot, reading updates, setting a webhook to break polling | token only in `.env`; redactor; 409 Conflict or webhook detection opens TELEGRAM_DOWN and heartbeat `/fail`; owner rotates with BotFather `/token` (guide) | phishing until rotated; no command power (the attacker is not the owner id) |
| A5 | Internet scanners, SSH brute force | server takeover | no published container ports (Docker bypasses ufw); ufw SSH only; SSH keys only, no root login, fail2ban, unattended security upgrades; non-root containers, read-only root fs | provider-level compromise |
| A6 | Bait-token creators (pass static checks, then rug) | our buy becomes their exit liquidity | safety rejects by default; raw TLV parse; holder and creator concentration; identical-amount clusters; creator blocklist; age, liquidity and non-FOMO activity floors; 0.5% pool share; hard stop; thresholds out of git (D2) | small losses per bait trade; pump.fun coins pass static checks by construction |
| A7 | Sybil FOMO flow (a few accounts faking crowd buying) | lures crowdflow entries | distinct-buyer floor; top-buyer, same-slot and identical-size share caps; median buy size; requires non-FOMO volume and holder growth; confidence capped; no per-user lookups (D1) so funding links are not checked | a careful sybil with many funded accounts can still bait us; each FOMO trade costs them at least the $0.10 fee, so baiting a $5 trade is barely profitable for them |
| A8 | MEV and sandwich bots | worse fills | tight minOut (2% buy cap); pool share cap; Helius `mev-protect` on SWQOS-only sends or Jito with `jitodontfront` (Phase 8); no 0.001 SOL services | loss up to the slippage cap per trade; nothing guarantees zero |
| A9 | Poisoned or wrong API data (prices, trending, a malicious RPC later) | bad entries, wrong marks | execution math uses on-chain reserves only; Jupiter cross-check (3%) gates entries; zod on every response; trending only nominates candidates; context-slot staleness check; later providers can be cross-checked on P0 reads | a lying single RPC could still mislead marks; live requires a second provider (decision 3) |
| A10 | Prompt injection through token names, symbols or URIs | AI proposes harmful changes | names, symbols, URIs and all free text are excluded from the prompt; mints are internal ids; output is schema-checked and bounded; proposals need the owner's tap; AI cannot touch caps, modes, withdraw, providers or code | a misleading summary; changes still bounded |
| A11 | Mistakes by Claude or its subagents | loosened limits, bypassed risk engine, secrets committed, live started | hard caps in code, reviews (risk-guardian, security-auditor veto), import-graph test, property tests, gitleaks, root guard hook blocks setting `*_LIVE` variables and `reset-halt`, Claude never holds keys or SSH to a key-holding server | a subtle logic bug that passes review; mitigated by small size and invariants checked at runtime |
| A12 | Compromised owner PC | steals SSH key, Telegram desktop session, git credentials | SSH key with a passphrase (FIDO2 key optional), separate VPS user, no key or `.env` copy on the PC in Phase 8, Telegram 2-step verification | full VPS compromise is possible: key theft bounded by the bankroll |
| A13 | Hosting-provider account takeover or malicious host | console access, disk snapshots | strong unique password and 2FA on the provider account (guide); small bankroll | the host can always read the disk |
| A14 | Base image or OS tampering | backdoored runtime | Node image pinned by digest, rebuilt only through `ops/update.sh`; Ubuntu from the provider's LTS image; unattended security updates | trust in Docker Hub and the provider |
| A15 | Public repository readers (D2) | learn entry rules to bait the bot | no tuned thresholds or wallet address in git; placeholders only; the owner makes the repository private | logic is still readable until then |
| A16 | Terms enforcement (FOMO s.16, provider terms) | account bans, IP blocks | never touch FOMO's services; aggregate counts only, user tags in memory for 15 min and never stored (D1); no Helius until it confirms in writing (D3); budget governor keeps us under public limits; DexScreener and Jupiter data never redistributed (not in git, prompts or exports) | FOMO could still object to any use of its on-chain footprint; not legal advice |

## 4. Secrets design

| Secret | Where | How it is loaded | Never |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `HEALTHCHECKS_PING_URL`, later `HELIUS_API_KEY` | VPS `/opt/fomo-bot/.env` (0600, owner's user); locally `fomo-bot\.env` (gitignored); `fomo-bot/env.example` in git with placeholders | Docker Compose `env_file` into the `bot` container only; `src/config/secrets.ts` reads them once at start into a frozen object, then deletes them from `process.env` | in git, logs, Telegram, the DB, backups, `stats:export`, AI prompts, error messages, URLs in logs (query strings stripped) |
| Live wallet key (Phase 8) | VPS `/opt/fomo-bot/secrets/live-wallet.key` (0400, signer user); the folder is ignored by .gitignore and the name ends in `.key` | file mounted read-only into the `signer` container only; never an environment variable (visible in `docker inspect`) | in the `bot` container, logs, Telegram, backups, Claude's context, any machine but the VPS |
| Creating the key | owner runs `docker compose run --rm signer wallet-create` | prints only the public address; refuses if the file exists | printed, logged or sent |
| Backing it up | owner runs `docker compose run --rm -it signer wallet-backup` | needs a real TTY on stdin and stdout, shows the key once with offline-storage steps, logs "backup shown" without content | run by Claude; piped; screenshotted into chat |
| Withdraw address, bot wallet address | server file `/config/fomo-bot.json`, DB | not secret, but kept out of git (D2) | committed |
| Approval-token HMAC key | memory of the `bot` process, new each boot | `crypto.randomBytes` | stored |

Redaction: one redactor in `core/` used by the logger, the Telegram outbox, error
formatting, `stats:export` and the AI prompt builder. It removes values by key name (token,
key, secret, password, url, authorization) and by pattern: Telegram bot tokens (digits,
colon, 30+ token characters), `sk-ant-` keys, hc-ping URLs, base58 strings of 80+
characters (64-byte keys), JSON arrays of 64 small integers, `api-key=` and `api_key=`
query parameters. Tests plant canary secrets and assert they never appear in any output.

Rules for Claude: never read, print, grep or copy `.env*`, key or `.pem` files; never SSH
into the VPS once it holds the key; the owner runs server commands from OWNER_GUIDE.md and
never pastes their output if it could contain a secret. If the owner pastes a secret
anywhere, tell them to rotate it immediately (bots can delete private messages under 48 h
old, but rotation is still required).

## 5. Known guard-hook gap (needs the owner's OK)

The root hook `.claude/hooks/guard.py` blocks `.env*` and keypair files, setting any
`*_LIVE` variable to a truthy value (so `FOMO_LIVE=true` is blocked for Claude), and
`reset-halt` (the fomo-bot CLI reuses that name on purpose). It does **not** yet recognise
a `secrets/` folder, `*.key` or `*.pem` in shell commands, and the settings deny rules cover
`cat`, `head`, `tail` and `sed`, not `python`, `node`, `cp`, `base64`, `git show`, `ssh` or
`scp` (REVIEWS.md, 2026-11-04). Proposed fix, with tests: extend the hook's path patterns
to `secrets/`, `*.key` and `*.pem` for every tool and shell command, and add deny rules for
those readers. Until the owner approves it: no key exists before Phase 8, keys never exist
where Claude runs, and .gitignore already covers `secrets/` and `*.key`.

## 6. For the security-auditor's review

1. Sell probe in keyless paper: `holder-sim` puts a third party's public address (a current
   holder) into an unsigned simulated transaction with `sigVerify: false`. Nothing is
   signed or sent, and paper code has no signer, but confirm the builder can never produce
   a signed or sendable transaction, and that the optional `probePayer` field rejects
   anything that is not a 32-byte public key.
2. Signer isolation (no network, zero dependencies, Unix socket, own policy and counters):
   is the policy complete for pump, PumpSwap and Raydium CPMM instructions, closes and tips?
3. Pairing code printed to the console ends up in Docker logs: single use, 10 min expiry.
4. Optional weekly database copy to the owner's Telegram (no secrets inside by design).
5. Dependencies to approve (exact versions after the 7-day cooldown): `@solana/kit`,
   `@solana-program/system`, `token`, `token-2022`, `compute-budget`, `zod` (>= 4.6.6),
   `grammy`; dev: `typescript` 6.0.3, `eslint`, `typescript-eslint`, `vitest`,
   `fast-check`, a vitest coverage provider (not yet researched: UNVERIFIED). Excluded:
   web3.js v1, `@pump-fun/*`, `dotenv`, `pino`, `@anthropic-ai/sdk`, `ws`, `undici`.
6. Node 26.13.0 image tag and digest, and gitleaks v8.30.1 binary checksums (UNVERIFIED).

## 7. Residual risks the owner accepts by going ahead

- Root access to the VPS or the owner's PC can steal the live key: the bankroll is the
  limit of the loss.
- The free public RPC can block the bot without notice; in paper that only pauses tests.
- FOMO can change its on-chain footprint any day; the bot then stops crowdflow and waits.
- Baiting and sandwiches cost small amounts per trade and cannot be prevented completely.
- A Telegram takeover can sell positions at a loss (within the caps) but cannot send money
  anywhere except the owner's own withdraw address.
- A logic bug that passes every review and test remains possible; runtime invariants,
  absolute caps and small sizes bound it.
