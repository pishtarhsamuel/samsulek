# samsulek

A research pipeline and a fail-closed trading engine for a tiny account (EUR 50).
The goal is to find out cheaply and honestly whether a strategy has a real
edge before real money touches it, and to make it very hard for a bug to lose
the account.

- The plan, the honest expectations, and the milestones: [docs/PLAN.md](docs/PLAN.md)
- The non-negotiable rules: [CLAUDE.md](CLAUDE.md)
- Hard risk limits: [config/risk.yaml](config/risk.yaml)

**Status: milestone M2 (data).** The safety skeleton from M1 is done: risk
engine, kill switch, halts, ledger, reconciliation, live-mode gate, and tests.
It trades **fake instruments with fake prices** in a local simulator. M2 adds
real research data: euro exchange rates and a recorder for new Solana tokens
(simulation research only). ETF prices are still missing (no verified free
source yet). There is no strategy research yet (M3/M4), no broker connection
yet (M5), and no live trading (M6).

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
uv sync --locked
```

This creates a private `.venv` folder with exactly the pinned versions listed
in `uv.lock`, checked by hash. `--locked` refuses to continue if anything
doesn't match the lock file. It doesn't touch the rest of your computer.

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

Orders only live for one run. Anything still unfilled at the end of a run is
cancelled, and any leftover order is cancelled at the start of the next run,
so orders can never pile up between your twice-a-day checks. The one exception
is the kill switch's closing orders: no run ever cancels those. While a run is
going, orders waiting at the broker count against your cash and position
limits.

Only one run can trade at a time. A run holds an operating-system lock on
`state\run.lock`; a second run started meanwhile is skipped with a warning.
If a run crashes or the computer turns off, Windows releases the lock by
itself, and the next run warns you that the previous one didn't finish.

You can run every command from the `samsulek` folder or any folder inside it:
the bot finds its project folder by itself, and its `state` folder is always
`samsulek\state` (no setting can move it).

```powershell
uv run samsulek status
```

This shows whether trading is halted, whether the kill switch is on, and
today's trade count and equity.

### Emergency stop (kill switch)

```powershell
uv run samsulek kill --flatten
```

This sets the kill flag **first** (even if other files are damaged), cancels
every open order, and sells every position. Without `--flatten` it cancels the
orders that add risk and stops trading, but keeps any closing (sell) orders
from an earlier `--flatten` working, and lists them. In more detail:

- If a run is in progress, the kill waits up to 20 seconds for it to stop at
  its next check (the flag is already on, so it sends nothing more). If the run
  doesn't stop in time, the kill carries on anyway.
- It still cancels and sells if any of the bot's own files in `state\` are
  damaged (for example after being opened and saved in Notepad). If the
  damaged file is `ledger.json` it then reports an error, because the records
  need a look.
- A position only counts as closed once the broker shows it's gone. For every
  position still held, it says whether a sell order is really still working
  for it, or that **no** sell order is working and you must close it by hand
  in the broker app.
- It ends with exit code 1 when anything is left or anything failed.
- Run it from inside the `samsulek` folder. Outside any samsulek folder it
  refuses and changes nothing. It prints the exact folder where it set the
  flag. If the folder is a copy inside another samsulek folder (for example
  a Claude Code worktree), it sets the flag in both, warns you, and ends with
  exit code 1: run it again from the folder your bot really runs from, so
  that bot's orders are cancelled too.

### Resuming after a halt or kill (only you, at the keyboard)

```powershell
uv run samsulek reset-halt --clear-kill
```

It shows a line like `RESET 482913`. Type it exactly and press Enter. It
only works from a real terminal window with a person typing. The Claude Code
safety hook also blocks Claude from running this command. **Before resuming, run
`uv run samsulek status` and make sure you understand why it stopped.**

If the halt was a **drawdown** halt (down 15% from your best equity), clearing it
isn't enough: the next run sees the same drawdown and halts again. That's
deliberate. If you've decided to accept the loss and continue from the
current level, add `--rebase-peak`:

```powershell
uv run samsulek reset-halt --rebase-peak
```

Do the same after you withdraw money, since a withdrawal looks like a loss.

### Starting the simulation over

The simulator keeps its account in the `state` folder. To start from a fresh
EUR 50 simulated account (simulation only):

```powershell
Remove-Item -Recurse -Force state
```

---

## Research data (M2): nothing here can trade

### Exchange rates

```powershell
uv run samsulek data update
uv run samsulek data status
```

`data update` downloads the European Central Bank's daily euro rates (USD, GBP,
CHF) since 1999. The first run takes about a minute; later runs only fetch the
last 30 days, so a correction by the ECB is kept as a new version. If a
download fails, nothing from that attempt is stored, and it says so.

### The Solana recorder

Memecoin research needs data that includes every token, the ones that
collapsed within minutes too. Nobody gives that away for free, so the recorder
writes it down as it happens, from now on:

- every new pool that GeckoTerminal's free feed shows,
- for a random quarter of them, a DexScreener snapshot 5 min, 15 min, 1 h, 4 h,
  24 h and 72 h after launch,
- facts about each token from the Solana network itself (who can still mint
  more tokens or freeze wallets), pump.fun bonding-curve states, and holder
  lists for a smaller sample,
- every gap: when the recorder was off, when a source was down, and when the
  feed moved faster than it could read it.

Start it in its own PowerShell window and leave that window open:

```powershell
uv run samsulek record solana
```

It prints a short progress line every 30 minutes. **Stop it with Ctrl+C**
(wait for `Recorder stopped`). To try it for a few minutes first:
`uv run samsulek record solana --minutes 5`.

To see what it did in the last 24 hours, open a second PowerShell window (the
first one is busy recording), go to the project folder, and ask:

```powershell
cd $HOME\samsulek
uv run samsulek record status
```

(Without the `cd`, a new window starts in your home folder and `uv` answers
"Failed to spawn: samsulek": it only finds the bot inside its folder.)

What to expect:

- It only records while it runs. If your PC sleeps or is switched off, that
  time is lost for good (there is no free way to fetch it later), and the gap
  is written down. In Windows Settings > System > Power, set "When plugged in,
  put my device to sleep after" to **Never** while you record.
- Don't click inside the recorder's window. Selecting text there pauses the
  program until you press Esc or Enter (a Windows console feature), and the
  pause is recorded as a gap.
- Disk space: roughly 100-300 MB per day of recording (estimated from a short
  test run; it depends on how many tokens are launched). The newest 7 days stay
  as plain text, so expect up to about 2 GB. Older days are packed into Parquet
  files several times smaller, automatically once a day (or run
  `uv run samsulek record compact` while the recorder is stopped).
- `GAP discovery_overrun` is normal: Solana creates new pools faster than the
  free feed lets us read them, so discovery is incomplete. `record status`
  shows how many pump.fun launches it caught.
- `SOURCE DOWN` means a provider is failing; the recorder pauses it and tries
  again by itself (30 s, then longer, up to 10 minutes; up to an hour if the
  provider itself asks us to wait). The other providers keep working meanwhile.
- `TASK SWITCHED OFF` means a provider answered with something the code doesn't
  recognise, or blocked us. That part stays off until you restart the
  recorder: it never guesses. Send me the `record status` output.
- If the Solana part keeps failing with "Tunnel" or "403" errors, the network
  is blocking the official RPC address. You can switch to the older address
  by adding this to `config\default.yaml` under `data:` and restarting:
  `recorder: {solana_rpc_url: "https://api.mainnet-beta.solana.com"}`
- DexScreener's terms forbid passing its data on: keep the recordings to
  yourself (the `data` folder is never uploaded).

---

## Where things are

| What | Where |
|---|---|
| Every decision and its reason, one JSON line each | `logs\decisions-YYYY-MM-DD.jsonl` |
| App log | `logs\samsulek.log` |
| Halt / kill flags, daily counters, ledger, simulated broker | `state\` (never edit by hand while the bot runs) |
| Research data: exchange rates, Solana recordings | `data\` (never uploaded; don't share the recordings) |
| What each dataset contains and misses | `research\data_notes.md` |
| Hard risk limits | `config\risk.yaml` |
| Go-live checklist (live mode refuses to start until it's complete) | `ops\go_live_checklist.md` |

Those last two files, and the `state` folder, are always at exactly these
locations: no setting can point the bot somewhere else. The checklist's items
are fingerprinted, so deleting or rewording an item also blocks live mode
until the change has been reviewed. Paper and live mode only run when the
code, the config and the checklist all come from one and the same folder (the
one installed with `uv sync --locked`). That stops a stray config or checklist
from somewhere else, but it can't stop a **second full installation** of the
bot elsewhere with its own looser settings. So keep exactly one copy of the
bot on your computer. A stronger check, anchored outside the project folder,
is planned before live trading (M6).

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
- `STATE UNREADABLE`, or `HALTED: cannot start`: a state file is damaged, or
  the `logs` folder can't be written. Trading stays blocked (fail closed). The
  kill switch still works. Don't delete files blindly; ask first.
- `A trading run is in progress` from `reconcile`: it waited 20 seconds for the
  run to finish and then gave up without changing anything. Try again later.
- `Run skipped: another run is in progress`: an earlier run is still going
  (or stuck). Wait a minute and check `status`. If it keeps happening, close
  the other window or scheduled task.
- `Refused: paper mode only runs from the project folder`: run the command
  inside the `samsulek` folder you cloned and installed with `uv sync --locked`.
- If you use Claude Code on this Windows machine and every command gets
  blocked, the safety hook can't start: make sure Git for Windows is installed
  (it provides `bash`) and that `py -3.12 --version` works, then run `/hooks`
  in Claude Code.
