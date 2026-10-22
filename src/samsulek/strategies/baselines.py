"""Baseline strategies a result must beat: buy-and-hold and random entries.

``DriftingBuyAndHold`` holds the weights a buy-and-hold portfolio drifts to from
``weights0``, set at the anchor closes. With ``R_i = last close_i / anchor_i`` (the last
bar the cycle hands it, on the same adjustment basis as the anchor), each symbol gets
``w_i = w0_i R_i / ((1 - sum w0) + sum_j w0_j R_j)``: the share of the portfolio that
symbol would be worth had it been bought at the anchor and never traded, so the targets
follow the holdings and the strategy does not churn. ``1 - sum w0`` is the cash share at
the anchor (over every symbol of ``weights0``); the sum over ``j`` runs over the symbols
of ``weights0`` that are in the context (a symbol the context no longer offers has no
price to drift with; the cycle sells it). Symbols in the context but not in ``weights0``
get 0.0. Weights must be finite and >= 0 with a total of at most 1; anchors finite > 0.

``ScheduledWeights`` replays a fixed random-entry schedule: weight ``w`` while
``first <= d < end`` (``d`` = the decision time's date in Europe/Berlin, the Xetra
session being decided), 0.0 for every other context symbol. It is a pure function of
``asof``. Episodes must have ``first < end``, a finite weight > 0, and must not overlap
per symbol.

Both are inside the strategy import whitelist (rule A4): they keep their inputs as
tuples (nothing shared or mutable), and the time zone is built inside the method from a
module-level name.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from datetime import date, datetime
from itertools import pairwise
from zoneinfo import ZoneInfo

from samsulek.strategies.base import StrategyContext
from samsulek.types import TargetWeights

_BERLIN = "Europe/Berlin"  # the Xetra session date of a decision time
_SUM_TOLERANCE = 1e-9  # float sums like 3 x (1/3)


def _finite(x: object) -> bool:
    return isinstance(x, int | float) and not isinstance(x, bool) and math.isfinite(x)


def _day(x: object) -> bool:
    """A calendar date (a datetime is not one: it would compare by instant, not by day)."""
    return isinstance(x, date) and not isinstance(x, datetime)


class DriftingBuyAndHold:
    name = "buy_and_hold"

    def __init__(self, weights0: Mapping[str, float], anchor_closes: Mapping[str, float]) -> None:
        problems = [
            f"starting weight of {s} must be a finite number >= 0, got {w!r}"
            for s, w in sorted(weights0.items())
            if not (_finite(w) and w >= 0)
        ]
        problems.extend(
            f"anchor close of {s} must be a finite number > 0, got {c!r}"
            for s, c in sorted(anchor_closes.items())
            if not (_finite(c) and c > 0)
        )
        if set(weights0) != set(anchor_closes):
            problems.append(
                "weights and anchors must name the same symbols: "
                f"{sorted(weights0)} vs {sorted(anchor_closes)}"
            )
        if not problems and math.fsum(weights0.values()) > 1 + _SUM_TOLERANCE:
            problems.append(f"starting weights add up to {math.fsum(weights0.values())}, above 1")
        if problems:
            raise ValueError("invalid buy-and-hold plan: " + "; ".join(problems))
        self._holdings = tuple((s, float(weights0[s]), float(anchor_closes[s])) for s in sorted(weights0))
        self._cash = 1.0 - math.fsum(w for _, w, _ in self._holdings)

    def target_weights(self, ctx: StrategyContext) -> TargetWeights:
        values: dict[str, float] = {}
        for symbol, w0, anchor in self._holdings:
            bars = ctx.bars.get(symbol)
            if bars:
                values[symbol] = w0 * (bars[-1].close / anchor)
        total = self._cash + math.fsum(values.values())
        if not (math.isfinite(total) and total > 0):
            raise ValueError(f"buy-and-hold portfolio value is {total!r}: cannot form weights")
        weights = {symbol: values.get(symbol, 0.0) / total for symbol in ctx.bars}
        return TargetWeights(
            weights=weights, reason="buy and hold: the starting weights, drifted with prices"
        )


class ScheduledWeights:
    name = "random_entries"

    def __init__(self, schedule: Mapping[str, Sequence[tuple[date, date, float]]]) -> None:
        problems: list[str] = []
        kept: list[tuple[str, tuple[tuple[date, date, float], ...]]] = []
        for symbol in sorted(schedule):
            bad = [
                f"{symbol}: an episode needs a first day before its end day and a finite weight > 0, "
                f"got {first!r} .. {end!r} at {weight!r}"
                for first, end, weight in schedule[symbol]
                if not (_day(first) and _day(end) and first < end and _finite(weight) and weight > 0)
            ]
            if bad:
                problems.extend(bad)
                continue
            episodes = tuple(sorted((first, end, float(weight)) for first, end, weight in schedule[symbol]))
            problems.extend(
                f"{symbol}: episodes {a[0]} .. {a[1]} and {b[0]} .. {b[1]} overlap"
                for a, b in pairwise(episodes)
                if b[0] < a[1]
            )
            kept.append((symbol, episodes))
        if problems:
            raise ValueError("invalid random-entry schedule: " + "; ".join(problems))
        self._schedule = tuple(kept)

    def target_weights(self, ctx: StrategyContext) -> TargetWeights:
        day = ctx.asof.astimezone(ZoneInfo(_BERLIN)).date()
        held: dict[str, float] = {}
        for symbol, episodes in self._schedule:
            for first, end, weight in episodes:
                if first <= day < end:
                    held[symbol] = weight
        weights = {symbol: held.get(symbol, 0.0) for symbol in ctx.bars}
        return TargetWeights(weights=weights, reason=f"random entries: scheduled for {day.isoformat()}")
