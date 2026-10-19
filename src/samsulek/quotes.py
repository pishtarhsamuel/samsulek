"""Collecting reference quotes for a set of symbols (M3 skeleton; WP1 fills it in).

``collect_quotes`` is the one implementation behind ``App.quotes_for`` and the
backtest parts' ``quotes_for``: it iterates ``sorted(symbols)``, asks ``quote`` for each and
skips symbols without a quote (callers fail closed on what is missing). WP1 moves today's
``App.quotes_for`` body here unchanged.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable

from samsulek.types import Quote


def collect_quotes(quote: Callable[[str], Quote | None], symbols: Iterable[str]) -> dict[str, Quote]:
    raise NotImplementedError("WP1")
