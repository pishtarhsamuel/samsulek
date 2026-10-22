"""Turning a picklable plan into the strategy for one session.

Facts the runner relies on:
- ``strategy_for_session`` returns a NEW strategy instance on every call (one per cycle,
  as the bot builds one per run), so no state can carry over between sessions inside a
  strategy object.
- A registry plan uses the segment whose start is the latest on or before the session
  (walk-forward: fold k's parameters from its first test session on), with its
  parameters checked by ``validate_params``, wrapped in ``Lagged`` when
  ``lag_sessions > 0``. A session before the first segment has no parameters:
  ``ValueError``.
- ``plan_window`` is the bars per symbol the plan needs: the max over segments of
  ``window(params) + lag``; 1 for the baselines (they read only the last bar).
- ``plan_problems`` lists, without running anything, every reason a plan cannot run from
  ``first_session`` on a universe (unknown strategy, bad parameters, no segment for the
  first session, baseline symbols outside the universe, weights or episodes the baseline
  strategies refuse). The runner refuses a job with any.
"""

from __future__ import annotations

from collections.abc import Collection
from datetime import date

from samsulek.backtest.types import BuyAndHoldPlan, RandomEntriesPlan, RegistryPlan, StrategyPlan
from samsulek.strategies.base import Strategy
from samsulek.strategies.baselines import DriftingBuyAndHold, ScheduledWeights
from samsulek.strategies.params import Params
from samsulek.strategies.registry import get_strategy, validate_params
from samsulek.strategies.wrappers import Lagged

BASELINE_WINDOW = 1  # the baselines read only each symbol's last bar


def _segment(plan: RegistryPlan, session: date) -> Params:
    chosen: Params | None = None
    for start, params in plan.segments:  # sorted by start (RegistryPlan checks it)
        if start <= session:
            chosen = params
    if chosen is None:
        raise ValueError(
            f"plan for {plan.strategy} starts {plan.segments[0][0]}: it has no parameters for {session}"
        )
    return chosen


def strategy_for_session(plan: StrategyPlan, session: date) -> Strategy:
    """A fresh strategy instance for ``session`` (a new object on every call)."""
    if isinstance(plan, RegistryPlan):
        entry = get_strategy(plan.strategy)
        strategy = entry.build(validate_params(entry, dict(_segment(plan, session))))
        return Lagged(strategy, plan.lag_sessions) if plan.lag_sessions > 0 else strategy
    if isinstance(plan, BuyAndHoldPlan):
        return DriftingBuyAndHold(dict(plan.weights0), dict(plan.anchor_closes))
    if isinstance(plan, RandomEntriesPlan):
        return ScheduledWeights(dict(plan.schedule))
    raise TypeError(f"not a strategy plan: {type(plan).__name__}")


def plan_window(plan: StrategyPlan) -> int:
    """Bars per symbol the plan needs (>= 1)."""
    if isinstance(plan, RegistryPlan):
        entry = get_strategy(plan.strategy)
        return max(
            entry.window(validate_params(entry, dict(params))) + plan.lag_sessions
            for _, params in plan.segments
        )
    if isinstance(plan, BuyAndHoldPlan | RandomEntriesPlan):
        return BASELINE_WINDOW
    raise TypeError(f"not a strategy plan: {type(plan).__name__}")


def plan_problems(plan: StrategyPlan, *, universe: Collection[str], first_session: date) -> list[str]:
    """Every reason ``plan`` cannot run from ``first_session`` on ``universe``; [] if none."""
    problems: list[str] = []
    allowed = set(universe)
    if isinstance(plan, RegistryPlan):
        try:
            entry = get_strategy(plan.strategy)
        except ValueError as exc:
            return [str(exc)]
        for start, params in plan.segments:
            try:
                values = validate_params(entry, dict(params))
                window = entry.window(values)
                entry.build(values)  # a strategy that refuses its parameters is refused here, not mid-run
            except (ValueError, TypeError) as exc:
                problems.append(f"segment from {start}: {exc}")
                continue
            if window < 1:
                problems.append(f"segment from {start}: the strategy needs {window} bars (at least 1)")
        if plan.segments[0][0] > first_session:
            problems.append(
                f"the plan's first segment starts {plan.segments[0][0]}, after the first session "
                f"{first_session}"
            )
        return problems
    if isinstance(plan, BuyAndHoldPlan):
        parts = [[s for s, _ in plan.weights0], [s for s, _ in plan.anchor_closes]]
    elif isinstance(plan, RandomEntriesPlan):
        parts = [[s for s, _ in plan.schedule]]
    else:
        raise TypeError(f"not a strategy plan: {type(plan).__name__}")
    for names in parts:
        problems.extend(
            f"the plan names {s} more than once" for s in sorted({s for s in names if names.count(s) > 1})
        )
    symbols = {s for names in parts for s in names}
    problems.extend(
        f"the plan names {s}, which is not in the job's universe" for s in sorted(symbols - allowed)
    )
    try:
        strategy_for_session(plan, first_session)
    except (ValueError, TypeError) as exc:
        problems.append(str(exc))
    return problems
