"""Baseline strategies a result must beat: buy-and-hold and random entries (M3 skeleton; WP4).

``DriftingBuyAndHold`` holds the weights a buy-and-hold portfolio would drift to from
``weights0`` set at the anchor closes: with ``R_i = last close_i / anchor_i``,
``w_i = w0_i R_i / ((1 - sum w0) + sum_j w0_j R_j)``, for the symbols in the context only,
so it does not churn. ``ScheduledWeights`` replays a fixed random-entry schedule: weight
``w`` while ``first <= d < end`` (``d`` = the decision time's Berlin date), 0.0 for every
other context symbol: a pure function of ``asof``. Both are inside the strategy import
whitelist (rule A4): build time zones inside functions, not at module level.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import date

from samsulek.strategies.base import StrategyContext
from samsulek.types import TargetWeights


class DriftingBuyAndHold:
    name = "buy_and_hold"

    def __init__(self, weights0: Mapping[str, float], anchor_closes: Mapping[str, float]) -> None:
        raise NotImplementedError("WP4")

    def target_weights(self, ctx: StrategyContext) -> TargetWeights:
        raise NotImplementedError("WP4")


class ScheduledWeights:
    name = "random_entries"

    def __init__(self, schedule: Mapping[str, Sequence[tuple[date, date, float]]]) -> None:
        raise NotImplementedError("WP4")

    def target_weights(self, ctx: StrategyContext) -> TargetWeights:
        raise NotImplementedError("WP4")
