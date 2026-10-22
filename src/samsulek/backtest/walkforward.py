"""Anchored walk-forward: folds, selection on training prefixes, the stitched plan (spec section 7.2).

Facts relied on:
- Folds are ANCHORED: every fold trains on ``[first_trading, train_last]``. The first
  test session is the first session on or after ``first_trading + min_train_years``
  (calendar years; Feb 29 maps to Feb 28). Test windows of ``test_months`` calendar
  months follow back to back from that session (window k starts at the first session on
  or after ``test_first_0 + k * test_months`` months, a month end clamped to the shorter
  month, always computed from ``test_first_0`` so it never drifts) until
  ``last_trading``. A last window shorter than 63 sessions merges into the previous one,
  again until the last window has at least 63 (only the last window has a minimum); a
  lone window that short is refused (there is nothing to merge it into). Each fold trains
  up to the session just before its test window.
- Prefix scoring: one full run per variant over ``[first_trading, last_trading]`` scored
  on each training window equals a run on data truncated at that window's end, because
  every fold starts at ``first_trading`` and the simulation is causal (proven by the WF-1
  test, not assumed). So a scored run MUST be an R-mode run at 1x costs (the 2x reruns
  reuse the parameters chosen at 1x), start at the training start, carry daily
  returns (``Detail.RETURNS`` or ``FULL``) from its job's first to its last session,
  cover the whole window, and every variant's window must hold the same sessions:
  anything else is a ``BacktestIntegrityError``, never a silently shorter score. Returns
  after the window's last session are never read.
- The score is the annualised Sharpe ratio (``stats.sharpe_annual``) of the returns whose
  session is inside the window. ``choose`` takes the best score: None (no Sharpe ratio)
  counts as minus infinity, ties go to the lowest variant index, and if every score is
  None the study is refused. A non-finite score is a bug (``ValueError``).
- ``selected_plan`` switches parameters at each fold's first test session; positions carry
  over across folds, as in a real account.
"""

from __future__ import annotations

import calendar
import math
from bisect import bisect_left, bisect_right
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from itertools import pairwise
from typing import Final

from samsulek.backtest.stats import sharpe_annual
from samsulek.backtest.types import (
    BacktestIntegrityError,
    BacktestRefused,
    RegistryPlan,
    RiskMode,
    RunSummary,
    Variant,
)

_MIN_LAST_TEST_SESSIONS: Final = 63  # a shorter last test window merges into the previous one


@dataclass(frozen=True, slots=True)
class Fold:
    index: int
    train_first: date
    train_last: date
    test_first: date
    test_last: date


def _add_years(day: date, years: int) -> date:
    try:
        return day.replace(year=day.year + years)
    except ValueError:  # Feb 29 in a year without one
        return day.replace(year=day.year + years, day=28)


def _add_months(day: date, months: int) -> date:
    total = day.month - 1 + months
    year, month = day.year + total // 12, total % 12 + 1
    return date(year, month, min(day.day, calendar.monthrange(year, month)[1]))


def _positive_int(value: int, name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"{name} must be an integer >= 1, got {value!r}")


def plan_folds(
    sessions: Sequence[date],
    *,
    first_trading: date,
    last_trading: date,
    min_train_years: int,
    test_months: int,
) -> tuple[Fold, ...]:
    """The anchored folds over ``sessions`` (sorted, including ``first_trading``).

    ``BacktestRefused`` if no fold fits; ``ValueError`` for malformed arguments.
    """
    days = tuple(sessions)
    if any(a >= b for a, b in pairwise(days)):
        raise ValueError("sessions must be sorted, without repeats")
    _positive_int(min_train_years, "min_train_years")
    _positive_int(test_months, "test_months")
    if first_trading > last_trading:
        raise ValueError(f"first_trading {first_trading} is after last_trading {last_trading}")
    start = bisect_left(days, first_trading)
    if start == len(days) or days[start] != first_trading:
        raise ValueError(f"first_trading {first_trading} is not one of the sessions")
    anchor = _add_years(first_trading, min_train_years)
    lo = bisect_left(days, anchor)
    end = bisect_right(days, last_trading)
    if lo >= end:
        raise BacktestRefused(
            [
                f"no walk-forward fold fits: {min_train_years} training years from {first_trading} "
                f"reach {anchor}, which leaves no out-of-sample session up to {last_trading}"
            ]
        )
    base = days[lo]
    windows: list[tuple[int, int]] = []  # [lo, hi) indexes into days
    k = 1
    while lo < end:
        hi = min(bisect_left(days, _add_months(base, k * test_months)), end)
        if hi > lo:
            windows.append((lo, hi))
            lo = hi
        k += 1
    # The rule applies to whatever window is last, so it repeats: with short test windows
    # one merge can still leave a last window under 63 sessions.
    while len(windows) > 1 and windows[-1][1] - windows[-1][0] < _MIN_LAST_TEST_SESSIONS:
        windows[-2:] = [(windows[-2][0], windows[-1][1])]
    last_lo, last_hi = windows[-1]
    if last_hi - last_lo < _MIN_LAST_TEST_SESSIONS:
        raise BacktestRefused(
            [
                f"no walk-forward fold fits: the only test window ({days[last_lo]} to "
                f"{days[last_hi - 1]}) has {last_hi - last_lo} sessions, fewer than "
                f"{_MIN_LAST_TEST_SESSIONS}"
            ]
        )
    return tuple(
        Fold(
            index=i,
            train_first=first_trading,
            train_last=days[w_lo - 1],
            test_first=days[w_lo],
            test_last=days[w_hi - 1],
        )
        for i, (w_lo, w_hi) in enumerate(windows)
    )


def _window(summary: RunSummary, first: date, last: date) -> tuple[tuple[date, ...], list[float]]:
    """The sessions and returns of ``summary`` inside ``[first, last]``, after the checks
    that make a window score equal to a run on truncated data."""
    label = summary.job.label
    sessions, returns = summary.sessions, summary.returns
    if sessions is None or returns is None:
        raise BacktestIntegrityError(
            "a scored run has no daily returns (it must run with Detail.RETURNS or FULL)",
            session=None,
            label=label,
        )
    if summary.job.risk_mode is not RiskMode.R or summary.job.cost_multiplier != 1:
        raise BacktestIntegrityError(
            f"selection scores R-mode runs at 1x costs only; this one is {summary.job.risk_mode} at "
            f"{summary.job.cost_multiplier}x",
            session=None,
            label=label,
        )
    if len(sessions) != len(returns):
        raise BacktestIntegrityError(
            f"{len(sessions)} sessions but {len(returns)} returns", session=None, label=label
        )
    if any(a >= b for a, b in pairwise(sessions)):
        raise BacktestIntegrityError("the run's sessions are not in order", session=None, label=label)
    if not sessions or sessions[0] != summary.job.first_session or sessions[-1] != summary.job.last_session:
        raise BacktestIntegrityError(
            f"the run's returns do not span its job ({summary.job.first_session} to "
            f"{summary.job.last_session}): an incomplete run cannot be scored",
            session=None,
            label=label,
        )
    if summary.job.first_session != first:
        raise BacktestIntegrityError(
            f"a scored run must start at the window start {first}; this one starts "
            f"{summary.job.first_session}",
            session=None,
            label=label,
        )
    lo, hi = bisect_left(sessions, first), bisect_right(sessions, last)
    return tuple(sessions[lo:hi]), list(returns[lo:hi])


def _scores(
    runs: Mapping[int, RunSummary], first: date, last: date, *, last_is_session: bool
) -> dict[int, float | None]:
    out: dict[int, float | None] = {}
    reference: tuple[date, ...] | None = None
    for index in sorted(runs):
        summary = runs[index]
        label = summary.job.label
        days, returns = _window(summary, first, last)
        if not days or (last_is_session and days[-1] != last):
            raise BacktestIntegrityError(
                f"the run does not cover the window {first} to {last}", session=None, label=label
            )
        if reference is None:
            reference = days
        elif days != reference:
            raise BacktestIntegrityError(
                f"the run's sessions in {first} to {last} differ from the other variants'",
                session=None,
                label=label,
            )
        try:
            out[index] = sharpe_annual(returns)
        except ValueError as exc:  # a non-finite return: a bug upstream
            raise BacktestIntegrityError(str(exc), session=None, label=label) from exc
    return out


def prefix_scores(runs: Mapping[int, RunSummary], fold: Fold) -> dict[int, float | None]:
    """Variant index -> annualised Sharpe of its returns in ``[train_first, train_last]``."""
    return _scores(runs, fold.train_first, fold.train_last, last_is_session=True)


def choose(scores: Mapping[int, float | None]) -> int:
    """The best variant index: None = minus infinity, ties -> lowest index; all None -> refused."""
    best_index: int | None = None
    best = -math.inf
    for index in sorted(scores):
        score = scores[index]
        if score is None:
            continue
        if not math.isfinite(score):
            raise ValueError(f"variant {index} has a non-finite score {score!r} (a bug)")
        if best_index is None or score > best:
            best_index, best = index, score
    if best_index is None:
        raise BacktestRefused(
            [
                "no variant has a Sharpe ratio in the selection window (fewer than 2 returns or flat "
                "equity), so no parameters can be chosen"
                if scores
                else "there is no variant to choose from"
            ]
        )
    return best_index


def selected_plan(
    strategy: str,
    *,
    folds: Sequence[Fold],
    choices: Sequence[int],
    variants: Sequence[Variant],
    lag_sessions: int,
) -> RegistryPlan:
    """The stitched out-of-sample plan: fold k's chosen parameters from its first test session."""
    if not folds:
        raise ValueError("a walk-forward plan needs at least one fold")
    if len(choices) != len(folds):
        raise ValueError(f"{len(folds)} folds but {len(choices)} choices")
    by_index = {v.index: v for v in variants}
    if len(by_index) != len(variants):
        raise ValueError("variant indexes must be unique")
    unknown = sorted({c for c in choices if c not in by_index})
    if unknown:
        raise ValueError(f"chosen variant indexes {unknown} are not among the variants")
    return RegistryPlan(
        strategy=strategy,
        segments=tuple((f.test_first, by_index[c].params) for f, c in zip(folds, choices, strict=True)),
        lag_sessions=lag_sessions,
    )


def final_choice(runs: Mapping[int, RunSummary], *, first: date, last: date) -> int:
    """The variant the holdout will run: the best over the whole research window."""
    return choose(_scores(runs, first, last, last_is_session=False))
