"""The live-trading gate. ALL of these must hold before anything trades real money:

1. ``--mode live`` was requested
2. the environment variable ``LIVE`` is exactly ``true`` (set in the terminal for
   this session; it is never loaded from the env file)
3. ``ops/go_live_checklist.md``: every box ticked, signed, dated within 30 days
4. stdin and stdout are a real interactive terminal
5. the owner types a phrase containing a fresh random code on that terminal

Non-interactive problems are all reported at once, before any prompt.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from datetime import date, timedelta
from pathlib import Path

from samsulek.terminal import TerminalUnavailableError, confirm_phrase, new_code, require_interactive
from samsulek.types import Mode

LIVE_PHRASE = "I ACCEPT REAL MONEY RISK {code}"
CHECKLIST_MAX_AGE = timedelta(days=30)
_BOX_RE = re.compile(r"^\s*[-*]\s*\[( |x|X)\]\s*(.+)$")


class LiveGateError(RuntimeError):
    def __init__(self, problems: list[str]) -> None:
        self.problems = problems
        super().__init__("live trading refused:\n  - " + "\n  - ".join(problems))


def checklist_problems(path: Path, today: date) -> list[str]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return [f"go-live checklist not found at {path}"]
    problems: list[str] = []
    boxes = [m for line in text.splitlines() if (m := _BOX_RE.match(line))]
    if not boxes:
        problems.append("go-live checklist has no checkboxes")
    for m in boxes:
        if m.group(1) == " ":
            problems.append(f"checklist item not ticked: {m.group(2).strip()}")
    signer = re.search(r"^Signed-off-by:[ \t]*(\S.*)$", text, re.MULTILINE)
    if not signer:
        problems.append("checklist is not signed (Signed-off-by: is empty)")
    when = re.search(r"^Date:[ \t]*(\S+)", text, re.MULTILINE)
    if not when:
        problems.append("checklist sign-off date is missing (Date: YYYY-MM-DD)")
    else:
        try:
            signed = date.fromisoformat(when.group(1))
        except ValueError:
            problems.append(f"checklist date {when.group(1)!r} is not YYYY-MM-DD")
        else:
            if signed > today:
                problems.append(f"checklist date {signed} is in the future")
            elif today - signed > CHECKLIST_MAX_AGE:
                problems.append(f"checklist was signed {signed}, more than 30 days ago: review it again")
    return problems


def authorize_live(
    *,
    mode: Mode,
    environ: Mapping[str, str],
    checklist_path: Path,
    today: date,
    interactive_check: Callable[[], None] = require_interactive,
    confirm: Callable[[str, str], bool] = confirm_phrase,
    code: Callable[[], str] = new_code,
) -> None:
    problems: list[str] = []
    if mode is not Mode.LIVE:
        problems.append(f"mode is {mode.value!r}, not 'live'")
    if environ.get("LIVE") != "true":
        problems.append("environment variable LIVE is not exactly 'true' in this terminal session")
    problems.extend(checklist_problems(checklist_path, today))
    try:
        interactive_check()
    except TerminalUnavailableError as exc:
        problems.append(str(exc))
    if problems:
        raise LiveGateError(problems)
    expected = LIVE_PHRASE.format(code=code())
    try:
        ok = confirm("You are about to trade with REAL MONEY. You can lose all of it.", expected)
    except TerminalUnavailableError as exc:
        raise LiveGateError([str(exc)]) from exc
    if not ok:
        raise LiveGateError(["confirmation phrase did not match"])
