"""Baseline plans: random entries (stars and bars) and buy-and-hold (M3 skeleton; WP6a fills it in).

Random entries keep the strategy's own episode shapes per symbol (count, holding lengths,
weights: the exact multiset) and place them at random without overlaps, seeded from the
study id only, so the seeds are fixed before any result exists. Buy-and-hold starts at
``min(max_position_pct, 1/n)`` per symbol listed at the first out-of-sample session,
anchored at the adjusted closes visible at that session's execution time. The
unconstrained buy-and-hold (no costs, no caps) is shown for context only, never used in a
fact.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import date, datetime
from decimal import Decimal

from samsulek.backtest.dataset import PitDataset
from samsulek.backtest.types import BuyAndHoldPlan, EquityPoint, RandomEntriesPlan, RunResult
from samsulek.config import MarketLimits


def seeds_for(study_id: str, count: int) -> tuple[int, ...]:
    """``int(sha256(f"{study_id}:random-entries:{i}").hexdigest()[:12], 16)`` for i in range(count)."""
    raise NotImplementedError("WP6a")


def episode_shapes(result: RunResult) -> dict[str, tuple[tuple[int, float], ...]]:
    """Per symbol: (sessions_held, weight) of every episode."""
    raise NotImplementedError("WP6a")


def random_entry_schedule(
    shapes: Mapping[str, Sequence[tuple[int, float]]], sessions: Sequence[date], *, seed: int
) -> RandomEntriesPlan:
    raise NotImplementedError("WP6a")


def buy_and_hold_plan(
    dataset: PitDataset,
    universe: Sequence[str],
    *,
    limits: MarketLimits,
    first_session: date,
    execute_at: datetime,
) -> BuyAndHoldPlan:
    raise NotImplementedError("WP6a")


def unconstrained_buy_and_hold(
    dataset: PitDataset, universe: Sequence[str], *, first: date, last: date, starting_cash: Decimal
) -> tuple[EquityPoint, ...]:
    raise NotImplementedError("WP6a")
