"""Strategy wrappers (M3 skeleton; WP4 fills it in).

``Lagged(inner, k)`` models an extra fill delay of ``k`` sessions (1..5): it hands the
inner strategy ``StrategyContext(asof, market, {s: tuple(bars[:-k])})``, so the inner
strategy sees bars only up to session ``s-1-k``. Its name is ``f"{inner.name}+lag{k}"``.
The shared freshness rule is unchanged.
"""

from __future__ import annotations

from samsulek.strategies.base import Strategy, StrategyContext
from samsulek.types import TargetWeights


class Lagged:
    name: str

    def __init__(self, inner: Strategy, lag_sessions: int) -> None:
        raise NotImplementedError("WP4")

    def target_weights(self, ctx: StrategyContext) -> TargetWeights:
        raise NotImplementedError("WP4")
