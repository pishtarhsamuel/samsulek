"""Strategy wrappers.

``Lagged(inner, k)`` models an extra fill delay of ``k`` sessions (1..5): it hands the
inner strategy ``StrategyContext(asof, market, {s: tuple(bars[:-k])})``, so at session s
the inner strategy sees bars only up to session ``s-1-k`` (the cycle already ends the
bars at ``s-1``). The decision time is unchanged, so the shared freshness rule is too.
Its name is ``f"{inner.name}+lag{k}"``. A symbol with ``k`` bars or fewer reaches the
inner strategy with an empty tuple (it decides what that means, as with any short
history). The plan's bar window adds ``k`` (``backtest/plans.py``), so the inner strategy
still gets its full window.
"""

from __future__ import annotations

from samsulek.strategies.base import Strategy, StrategyContext
from samsulek.types import TargetWeights

MIN_LAG = 1
MAX_LAG = 5


class Lagged:
    name: str

    def __init__(self, inner: Strategy, lag_sessions: int) -> None:
        if isinstance(lag_sessions, bool) or not isinstance(lag_sessions, int):
            raise ValueError(f"lag_sessions must be a whole number, got {lag_sessions!r}")
        if not MIN_LAG <= lag_sessions <= MAX_LAG:
            raise ValueError(f"lag_sessions must be {MIN_LAG}..{MAX_LAG}, got {lag_sessions}")
        self._inner = inner
        self._lag = lag_sessions
        self.name = f"{inner.name}+lag{lag_sessions}"

    def target_weights(self, ctx: StrategyContext) -> TargetWeights:
        k = self._lag
        hidden = {symbol: tuple(bars[:-k]) for symbol, bars in ctx.bars.items()}
        return self._inner.target_weights(StrategyContext(asof=ctx.asof, market=ctx.market, bars=hidden))
