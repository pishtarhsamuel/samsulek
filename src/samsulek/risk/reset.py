"""The owner's halt reset, as one function shared by the CLI and the backtest.

``apply_owner_reset`` performs exactly the store steps ``samsulek reset-halt`` always
performed, in the same order, and calls ``on_step`` right after each one, so a message
for a step that happened is never lost when a later step fails:
1. clear the halt -> ``on_step("halt_cleared", None)``;
2. if asked, clear the KILL flag -> ``on_step("kill_cleared", None)``;
3. if asked, set the drawdown peak to the last equity the bot saw, only if that is
   above 0 -> ``on_step("peak_rebased", value)``.

The day's baseline and trade counts are never touched, so a reset on a losing day leaves
the daily-loss limit where it was (the next cycle can halt again). There is NO
confirmation in here: the terminal check and the typed code stay in ``cmd_reset_halt``,
and the backtest calls this only on its in-memory store (its modeled owner never clears
the KILL flag). An architecture test limits who may reference this function.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Literal

from samsulek.risk.state import RiskStateStore

ResetStep = Literal["halt_cleared", "kill_cleared", "peak_rebased"]


@dataclass(frozen=True, slots=True)
class ResetOutcome:
    kill_cleared: bool
    peak_rebased_to: Decimal | None  # None: the peak was not changed


def apply_owner_reset(
    store: RiskStateStore,
    now: datetime,
    *,
    by: str,
    clear_kill: bool,
    rebase_peak: bool,
    on_step: Callable[[ResetStep, Decimal | None], None] | None = None,
) -> ResetOutcome:
    """Clear the halt (and, if asked, the KILL flag); with ``rebase_peak``, peak = last seen equity.

    Store errors propagate unchanged after the steps before them were done and reported.
    """
    store.clear_halt(now, by=by)
    if on_step is not None:
        on_step("halt_cleared", None)
    if clear_kill:
        store.clear_kill(now, by=by)
        if on_step is not None:
            on_step("kill_cleared", None)
    rebased: Decimal | None = None
    if rebase_peak:
        day = store.read_day()
        if day and day.last_equity > 0:
            store.write_peak(day.last_equity)
            rebased = day.last_equity
            if on_step is not None:
                on_step("peak_rebased", rebased)
    return ResetOutcome(kill_cleared=clear_kill, peak_rebased_to=rebased)
