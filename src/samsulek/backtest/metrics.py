"""Performance metrics of one run, exactly as the M3 spec section 6 defines them (skeleton; WP5).

Returns are mark to mark from the starting cash at ``ts_0`` (halted sessions included);
years are ``(ts_T - ts_0) / 365.25 days``; ``PERIODS_PER_YEAR`` = 252; the risk-free rate
and interest on cash are 0 (pessimistic for cash-heavy strategies). Every ratio whose
denominator is empty or zero is None, never a made-up number. ``summarize`` keeps the
session dates and returns for ``Detail.RETURNS`` and drops them for ``Detail.METRICS``.
"""

from __future__ import annotations

from collections.abc import Sequence
from decimal import Decimal
from typing import Final

from samsulek.backtest.types import Detail, EquityPoint, Metrics, RunResult, RunSummary

PERIODS_PER_YEAR: Final = 252


def daily_returns(points: Sequence[EquityPoint], start_equity: Decimal) -> list[float]:
    raise NotImplementedError("WP5")


def compute_metrics(result: RunResult) -> Metrics:
    raise NotImplementedError("WP5")


def summarize(result: RunResult, detail: Detail) -> RunSummary:
    raise NotImplementedError("WP5")
