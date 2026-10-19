"""Anchored walk-forward: folds, selection on training prefixes, the stitched plan (M3 skeleton; WP6a).

Every fold trains on ``[first_trading, train_last]`` and tests on the following
``test_months``; a last test window shorter than 63 sessions merges into the previous one.
Because every fold starts at ``first_trading`` and the simulation is causal, one full run
per variant scored on each training prefix equals a run on data truncated at that prefix
(prefix scoring; proven by the WF-1 test, not assumed). ``choose`` takes the best score
(None counts as minus infinity; ties go to the lowest index; all None refuses).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date

from samsulek.backtest.types import RegistryPlan, RunSummary, Variant


@dataclass(frozen=True, slots=True)
class Fold:
    index: int
    train_first: date
    train_last: date
    test_first: date
    test_last: date


def plan_folds(
    sessions: Sequence[date],
    *,
    first_trading: date,
    last_trading: date,
    min_train_years: int,
    test_months: int,
) -> tuple[Fold, ...]:
    """``BacktestRefused`` if no fold fits."""
    raise NotImplementedError("WP6a")


def prefix_scores(runs: Mapping[int, RunSummary], fold: Fold) -> dict[int, float | None]:
    raise NotImplementedError("WP6a")


def choose(scores: Mapping[int, float | None]) -> int:
    raise NotImplementedError("WP6a")


def selected_plan(
    strategy: str,
    *,
    folds: Sequence[Fold],
    choices: Sequence[int],
    variants: Sequence[Variant],
    lag_sessions: int,
) -> RegistryPlan:
    raise NotImplementedError("WP6a")


def final_choice(runs: Mapping[int, RunSummary], *, first: date, last: date) -> int:
    raise NotImplementedError("WP6a")
