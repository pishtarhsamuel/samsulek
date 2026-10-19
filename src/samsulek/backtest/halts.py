"""Which halts a backtest models, and the modeled owner reset (M3 skeleton; WP4 fills it in).

Only the four limit halts are modeled (``classify_halt``, pinned to the engine's real
messages); every other halt (zero equity, stale data, broker, bookkeeping, clock, anything
unexpected) is a bug or bad data and voids the run. Mode L: the halt freezes the rest of
the session, and at the next session's ``reset_at`` the modeled owner runs the CLI's own
``apply_owner_reset`` (rebasing the peak only for drawdown halts; never clearing the KILL
flag; day state untouched, so the re-halt trap is reproduced). Mode R: never reset.
"""

from __future__ import annotations

from collections.abc import Collection
from datetime import datetime
from enum import StrEnum

from samsulek.backtest.inmemory import MemoryRiskStateStore
from samsulek.backtest.types import HaltKind, RiskMode
from samsulek.risk.reset import ResetOutcome


class ResetPolicy(StrEnum):
    NEXT_SESSION = "next_session"
    NEVER = "never"


def reset_policy_for(mode: RiskMode) -> ResetPolicy:
    raise NotImplementedError("WP4")


def classify_halt(reason: str) -> HaltKind | None:
    raise NotImplementedError("WP4")


def apply_reset_policy(
    store: MemoryRiskStateStore, *, kinds: Collection[HaltKind], at: datetime
) -> ResetOutcome:
    raise NotImplementedError("WP4")
