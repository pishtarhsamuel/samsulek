"""Collecting reference quotes for a set of symbols.

``collect_quotes`` is the one implementation behind ``App.quotes_for`` and the backtest
parts' ``quotes_for``, so the bot and the backtest ask for prices the same way: it asks
``quote`` once per symbol, in ``sorted(symbols)`` order (deterministic, whatever the set
order), and leaves out symbols without a quote. It never invents a price: callers compare
the result with what they asked for and fail closed on anything missing.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable

from samsulek.types import Quote


def collect_quotes(quote: Callable[[str], Quote | None], symbols: Iterable[str]) -> dict[str, Quote]:
    quotes: dict[str, Quote] = {}
    for s in sorted(symbols):
        q = quote(s)
        if q is not None:
            quotes[s] = q
    return quotes
