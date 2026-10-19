"""The owner's halt reset, as one function shared by the CLI and the backtest (M3 skeleton; WP1).

``apply_owner_reset`` performs exactly the store steps of ``cmd_reset_halt`` in cli.py,
in the same order, and calls ``on_step`` right after each one, so no message is lost if a
later step fails: 1. clear the halt; 2. if asked, clear the KILL flag; 3. if asked, set
the peak to the last seen equity (only if it is > 0). Day state and trade counts are never
touched. There is NO confirmation inside: the TTY and typed-code gate stays in the CLI,
and the backtest's modeled owner never clears the KILL flag.
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
    peak_rebased_to: Decimal | None


def apply_owner_reset(
    store: RiskStateStore,
    now: datetime,
    *,
    by: str,
    clear_kill: bool,
    rebase_peak: bool,
    on_step: Callable[[ResetStep, Decimal | None], None] | None = None,
) -> ResetOutcome:
    raise NotImplementedError("WP1")
