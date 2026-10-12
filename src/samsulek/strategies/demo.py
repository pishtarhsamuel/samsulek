"""A PLUMBING DEMO, not a strategy. It has no edge and is never to be traded.

It exists so M1 can exercise the full path data -> strategy -> sizing -> risk ->
router -> broker -> ledger end to end. Rule: hold an equal weight in every symbol
whose last close is above its N-bar average, else hold nothing in it.
"""

from __future__ import annotations

from samsulek.strategies.base import StrategyContext
from samsulek.types import TargetWeights


class EqualWeightAboveAverageDemo:
    name = "demo_equal_weight_above_average"

    def __init__(self, lookback: int = 20, gross: float = 0.9) -> None:
        if lookback < 2:
            raise ValueError("lookback must be >= 2")
        self._lookback = lookback
        self._gross = gross

    def target_weights(self, ctx: StrategyContext) -> TargetWeights:
        selected: list[str] = []
        for symbol, bars in sorted(ctx.bars.items()):
            if len(bars) < self._lookback:
                continue
            window = [b.close for b in bars[-self._lookback :]]
            if window[-1] > sum(window) / len(window):
                selected.append(symbol)
        weights = {s: (self._gross / len(selected) if selected else 0.0) for s in ctx.bars}
        for s in ctx.bars:
            if s not in selected:
                weights[s] = 0.0
        return TargetWeights(
            weights=weights,
            reason=f"demo: above {self._lookback}-bar average: {', '.join(selected) or 'none'}",
        )
