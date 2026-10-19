"""The backtest's bar feed and the broker's price source, in one phase-checked object (M3 skeleton; WP3).

As in the bot, one ``quote`` serves both the cycle's quotes and the simulated broker.
``bars_until(asof)`` refuses ``asof`` after the clock (``LookaheadError``) and returns fresh
tuples of point-in-time adjusted bars. ``quote`` is stateless and phase-checked: only at
``open_print_utc(d) + exec_delay`` of a session ``d`` (else ``PhaseError``), it returns the
UNADJUSTED latest print in EUR stamped with the print's own time, never "now". ``mark``
gives the raw close only once the clock is at or after that session's close. The phase
checks read only the clock and the calendar: there is no mutable phase state.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, datetime, timedelta
from decimal import Decimal

from samsulek.backtest.dataset import PitDataset
from samsulek.clock import Clock
from samsulek.data.calendars import XetraCalendar
from samsulek.types import Bar, Quote


class PhaseError(RuntimeError):
    """A price was asked for at an instant it could not be known. This is a bug."""


class BacktestFeed:
    def __init__(
        self,
        dataset: PitDataset,
        *,
        clock: Clock,
        universe: Sequence[str],
        window: int,
        exec_delay: timedelta,
    ) -> None:
        """``window`` bars per symbol, 1..1000."""
        raise NotImplementedError("WP3")

    @property
    def calendar(self) -> XetraCalendar:
        raise NotImplementedError("WP3")

    def bars_until(self, asof: datetime) -> dict[str, tuple[Bar, ...]]:
        raise NotImplementedError("WP3")

    def quote(self, symbol: str) -> Quote | None:
        raise NotImplementedError("WP3")

    def mark(self, symbol: str, session: date) -> Decimal:
        raise NotImplementedError("WP3")
