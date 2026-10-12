"""The strategy interface and the point-in-time context it receives."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from samsulek.types import Bar, Market, TargetWeights, require_aware


class LookaheadError(ValueError):
    """A strategy was offered data from after its decision time. This is a bug."""


@dataclass(frozen=True, slots=True)
class StrategyContext:
    """Everything a strategy may look at. Construction fails if any bar is from the future."""

    asof: datetime
    market: Market
    bars: Mapping[str, Sequence[Bar]]

    def __post_init__(self) -> None:
        require_aware(self.asof, "decision time")
        for symbol, series in self.bars.items():
            prev: datetime | None = None
            for bar in series:
                if bar.symbol != symbol:
                    raise ValueError(f"bar for {bar.symbol} filed under {symbol}")
                if bar.close_ts > self.asof:
                    raise LookaheadError(
                        f"{symbol} bar closing {bar.close_ts.isoformat()} is after decision time "
                        f"{self.asof.isoformat()}"
                    )
                if prev is not None and bar.close_ts <= prev:
                    raise ValueError(f"{symbol} bars are not strictly increasing in time")
                prev = bar.close_ts


class Strategy(Protocol):
    name: str

    def target_weights(self, ctx: StrategyContext) -> TargetWeights: ...
