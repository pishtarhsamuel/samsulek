"""The backtest's bar feed and the broker's price source, in one phase-checked object.

As in the bot (app.py wires ``feed.quote`` into both the cycle's quotes and the simulated
broker), one ``quote`` serves both, so the price the engine checks is the price the
broker fills at. Facts the runner relies on:
- ``bars_until(asof)`` refuses ``asof`` after the clock (``LookaheadError``) and returns a
  fresh dict of immutable tuples: the last ``window`` point-in-time ADJUSTED bars (closed by
  ``asof``) of each universe symbol that has any. Nothing a caller does to the result can
  reach the dataset.
- ``quote(symbol)`` is stateless and phase-checked from the clock and the calendar alone:
  it answers only at ``open_print_utc(d) + exec_delay`` of a session ``d`` (the execution
  instant E; else ``PhaseError``). It returns the UNADJUSTED latest print in EUR stamped
  with the print's own label (``open_print_utc(d)``), never "now", so the engine's quote
  age and future checks see the real observation time. A symbol whose listing ended
  quotes its last close, stamped at that close, which the engine rejects as stale.
- ``mark(symbol, session)`` gives the raw close only once the clock is at or after that
  session's close (else ``PhaseError``); a missing close raises ``KeyError``.
- There is no mutable phase state, so a feed cannot be left "open" by a crashed cycle.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from samsulek.backtest.dataset import PitDataset
from samsulek.clock import Clock
from samsulek.data.calendars import XetraCalendar
from samsulek.strategies.base import LookaheadError
from samsulek.types import Bar, Market, Quote, require_aware

MAX_WINDOW = 1000


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
        """``window`` bars per symbol, 1..1000; ``universe`` symbols must be in the dataset."""
        if isinstance(window, bool) or not isinstance(window, int) or not 1 <= window <= MAX_WINDOW:
            raise ValueError(f"window must be an int in 1..{MAX_WINDOW}, got {window!r}")
        if exec_delay < timedelta(0):
            raise ValueError(f"exec_delay must not be negative, got {exec_delay}")
        names = tuple(universe)
        if len(set(names)) != len(names):
            raise ValueError("feed universe has repeated symbols")
        unknown = sorted(set(names) - set(dataset.symbols()))
        if unknown:
            raise ValueError(f"feed universe symbols not in the dataset: {unknown}")
        self._dataset = dataset
        self._clock = clock
        self._universe = names
        self._window = window
        self._exec_delay = exec_delay
        self._zone = ZoneInfo(dataset.calendar.tz)

    @property
    def calendar(self) -> XetraCalendar:
        return self._dataset.calendar

    def bars_until(self, asof: datetime) -> dict[str, tuple[Bar, ...]]:
        require_aware(asof, "asof")
        now = self._clock.now()
        if asof > now:
            raise LookaheadError(f"bars asked for {asof.isoformat()}, after the clock {now.isoformat()}")
        out: dict[str, tuple[Bar, ...]] = {}
        for symbol in self._universe:
            window = self._dataset.adjusted_window(symbol, asof, self._window)
            if window:
                out[symbol] = window
        return out

    def quote(self, symbol: str) -> Quote | None:
        now = self._clock.now()
        day = now.astimezone(self._zone).date()
        cal = self._dataset.calendar
        if not cal.is_session(day) or now != cal.open_print_utc(day) + self._exec_delay:
            raise PhaseError(
                f"quote for {symbol} asked at {now.isoformat()}: prices are only given at a "
                f"session's execution time (open print + {self._exec_delay})"
            )
        if symbol not in self._universe:
            return None
        found = self._dataset.latest_print(symbol, now)
        if found is None:
            return None
        ts, price = found
        return Quote(symbol=symbol, market=Market.STOCKS, price=price, ts=ts)

    def mark(self, symbol: str, session: date) -> Decimal:
        now = self._clock.now()
        close = self._dataset.calendar.close_utc(session)
        if now < close:
            raise PhaseError(
                f"mark for {symbol} {session} asked at {now.isoformat()}, before its close "
                f"{close.isoformat()}"
            )
        return self._dataset.raw_close_eur(symbol, session)
