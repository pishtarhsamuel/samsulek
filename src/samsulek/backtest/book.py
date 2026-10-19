"""Episodes, the exact profit-and-loss invariant, and halt bookkeeping (M3 skeleton; WP5 fills it in).

An episode opens at the first BUY of a symbol not in an episode, and closes at a SELL
after which the remainder is worth less than ``min_order_eur`` (the sizing dust rule).
``pnl = sells (q p - fee) - buys (q p + fee)``; an episode open at the end adds its last
mark. The dust left after closed episodes is ``residual_eur``. The invariant
``sum(pnl) + residual == final equity - start equity`` holds EXACTLY in Decimal and is
checked on every run: a mismatch is a bookkeeping bug (``BacktestIntegrityError``).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from datetime import date, datetime
from decimal import Decimal

from samsulek.backtest.types import Episode, EquityPoint, FillRecord, HaltSummary, RunResult, SessionRecord


def build_episodes(
    fills: Sequence[FillRecord],
    sessions: Sequence[SessionRecord],
    *,
    min_order_eur: Decimal,
    last_marks: Mapping[str, Decimal],
) -> tuple[tuple[Episode, ...], Decimal]:
    """(episodes, residual)."""
    raise NotImplementedError("WP5")


def check_invariant(result: RunResult) -> None:
    raise NotImplementedError("WP5")


def frozen_equity_series(
    *,
    positions: Mapping[str, Decimal],
    cash: Decimal,
    sessions: Sequence[date],
    close: Callable[[str, date], Decimal | None],
    ts: Callable[[date], datetime],
) -> tuple[EquityPoint, ...]:
    """The equity of positions frozen at a halt, marked at each close; stops at the first missing close."""
    raise NotImplementedError("WP5")


def summarize_halts(result: RunResult) -> HaltSummary:
    raise NotImplementedError("WP5")
