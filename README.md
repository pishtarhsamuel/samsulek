# samsulek

A research pipeline and a fail-closed trading engine for a tiny account (EUR 50).
The goal is to find out cheaply and honestly whether a strategy has a real
edge before real money touches it, and to make it very hard for a bug to lose
the account.

- The plan, the honest expectations, and the milestones: [docs/PLAN.md](docs/PLAN.md)
- The non-negotiable rules: [CLAUDE.md](CLAUDE.md)
- Hard risk limits: [config/risk.yaml](config/risk.yaml)

**Status: milestone M1.** The safety skeleton is done: risk engine, kill switch,
halts, ledger, reconciliation, live-mode gate, and tests. It trades **fake
instruments with fake prices** in a local simulator. There is no real data
yet (M2), no strategy research yet (M3/M4), no broker connection yet (M5), and
no live trading (M6).

---

## One-time setup on Windows (about 15 minutes)

Open **PowerShell**: press the Windows key, type `PowerShell`, press Enter.
Copy each block, paste it with a right-click, and press Enter.

### 1. Install Git, Python 3.12 and uv

```powershell
winget install --id Git.Git -e --source winget
winget install --id Python.Python.3.12 -e --source winget
winget install --id astral-sh.uv -e --source winget
```

**Close PowerShell and open a new one** so it finds the new programs. Then
check that each one answers with a version number:

```powershell
git --version
py -3.12 --version
uv --version
```

If `winget` isn't recognised, install Python from https://www.python.org/downloads/
(tick **"Add python.exe to PATH"**), Git from https://git-scm.com/download/win,
and uv by following https://docs.astral.sh/uv/getting-started/installation/.

### 2. Download the code

```powershell
cd $HOME
git clone https://github.com/pishtarhsamuel/samsulek.git
cd samsulek
git checkout claude/trading-system-risk-controls-1d7teg
```

### 3. Install the project's dependencies

```powershell
uv sync
```

This creates a private `.venv` folder with exactly the pinned versions
listed in `uv.lock`, checked by hash. It doesn't touch the rest of your computer.

### 4. Run the tests

```powershell
uv run pytest
```

You should see a line ending in `passed` and no `failed`. If anything fails,
stop and send me the output. Never include passwords or keys in what you send.

---

## Try it (simulation only, fake prices, no account needed)

```powershell
uv run samsulek check-config
```

This checks the config files and prints every risk limit in euros.

```powershell
uv run samsulek run
```

This runs one trading cycle on the simulator:
1. reconcile our records with the (simulated) broker,
2. check prices aren't stale,
3. ask the demo strategy for target weights,
4. size orders,
5. run every order through the risk engine,
6. send the approved ones,
7. reconcile again.

The demo strategy (`DEMO_EQUITY`, `DEMO_BONDS`, `DEMO_GOLD`) exists only to
exercise the machinery. **It is not a strategy and has no edge.**

```powershell
uv run samsulek status
```

This shows whether trading is halted, whether the kill switch is on, and
today's trade count and equity.

### Emergency stop (kill switch)

```powershell
uv run samsulek kill --flatten
```

This sets the kill flag, cancels every open order, and sells every position.
Without `--flatten` it only cancels orders and stops trading. Anything it
can't close is listed so you can close it by hand in the broker app.

### Resuming after a halt or kill (only you, at the keyboard)

```powershell
uv run samsulek reset-halt --clear-kill
```

It shows a line like `RESET 482913`. Type it exactly and press Enter. This
can't be scripted or done by an AI agent. **Before resuming, run
`uv run samsulek status` and make sure you understand why it stopped.**

### Starting the simulation over

The simulator keeps its account in the `state` folder. To start from a fresh
EUR 50 simulated account (simulation only):

```powershell
Remove-Item -Recurse -Force state
```

---

## Where things are

| What | Where |
|---|---|
| Every decision and its reason, one JSON line each | `logs\decisions-YYYY-MM-DD.jsonl` |
| App log | `logs\samsulek.log` |
| Halt / kill flags, daily counters, ledger, simulated broker | `state\` (never edit by hand while the bot runs) |
| Hard risk limits | `config\risk.yaml` |
| Go-live checklist (live mode refuses to start until it's complete) | `ops\go_live_checklist.md` |

Command results (exit codes): `0` OK, `1` error, `2` halted or blocked, `3`
refused (e.g. paper/live not available yet).

## Safety rules for you

- **Never paste an API key, password, private key or seed phrase into any chat**,
  including chats with Claude. If it happens, revoke or rotate that key right away.
- Secrets will live in a `.env` file that only you edit (from milestone M5):
  `Copy-Item env.example .env`, then fill it in with Notepad. It's in
  `.gitignore`, so it never gets uploaded.
- `LIVE=true` is never read from `.env`. Live trading (M6) also needs
  `--mode live`, a typed confirmation, and a signed `ops\go_live_checklist.md`.
  Don't do any of that until M6.

## If something goes wrong

- `HALT: ON` in `status`: something hit a limit or failed a safety check. The
  reason is shown. Understand it before running `reset-halt`.
- `STATE UNREADABLE`: a state file is damaged. Trading stays blocked (fail
  closed). Don't delete files blindly; ask first.
- If you use Claude Code on this Windows machine and every command gets
  blocked, the safety hook can't start: make sure Git for Windows is installed
  (it provides `bash`) and that `py -3.12 --version` works, then run `/hooks`
  in Claude Code.
