"""Turning a picklable plan into the strategy for one session (M3 skeleton; WP4 fills it in).

``strategy_for_session`` returns a NEW strategy instance on every call (one per cycle, as
in the bot), so no state can carry over between sessions inside a strategy object. A
registry plan uses the segment whose start is the latest on or before the session, wrapped
in ``Lagged`` when ``lag_sessions > 0``. ``plan_window`` is the bars per symbol the plan
needs: the max over segments of ``window(params) + lag``; 1 for the baselines.
"""

from __future__ import annotations

from datetime import date

from samsulek.backtest.types import StrategyPlan
from samsulek.strategies.base import Strategy


def strategy_for_session(plan: StrategyPlan, session: date) -> Strategy:
    raise NotImplementedError("WP4")


def plan_window(plan: StrategyPlan) -> int:
    raise NotImplementedError("WP4")
