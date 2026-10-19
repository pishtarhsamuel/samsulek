"""Stored daily bars and the trading-calendar interface the data layer relies on."""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, datetime
from typing import Protocol

from samsulek.types import Bar, require_aware


class TradingCalendar(Protocol):
    """Which days an exchange trades, and when each session's closing price is set."""

    name: str  # e.g. "XETR"
    tz: str  # IANA timezone of the exchange, e.g. "Europe/Berlin"

    def is_session(self, day: date) -> bool: ...

    def sessions(self, start: date, end: date) -> list[date]:
        """Trading days from ``start`` to ``end``, both inclusive, in order."""
        ...

    def close_utc(self, day: date) -> datetime:
        """When ``day``'s closing price is final (a bar is labeled by this instant)."""
        ...


class SessionCalendar(TradingCalendar, Protocol):
    """A trading calendar that also knows when each session opens (the backtester's clock).

    ``open_print_utc(day)`` labels the opening price the way ``close_utc`` labels the
    close: an instant by which it is surely known (never before it can exist);
    ``open_utc(day)`` is the scheduled open, not a label. For every session
    ``open_utc(d) <= open_print_utc(d) < close_utc(d)``. ``open_utc``/``open_print_utc``
    raise ``ValueError`` for a day that is not a session; ``previous_session``/
    ``next_session`` accept any day and raise ``ValueError`` if their scan finds no
    session. All of them raise the calendar's range error (a ``ValueError``) outside the
    years it was checked for, so callers fail closed.
    """

    def open_utc(self, day: date) -> datetime: ...

    def open_print_utc(self, day: date) -> datetime: ...

    def previous_session(self, day: date) -> date: ...

    def next_session(self, day: date) -> date: ...


@dataclass(frozen=True, slots=True)
class DailyBar:
    """One trading session of one instrument, as a source reported it.

    ``close_ts`` is when the close was set (the point-in-time label). ``open/high/low``
    may be missing for sources that only publish a close. Prices are as published by
    ``source`` (see the source's notes for its adjustment basis).
    """

    symbol: str
    session: date
    close_ts: datetime
    open: float | None
    high: float | None
    low: float | None
    close: float
    volume: float | None
    currency: str
    source: str

    def __post_init__(self) -> None:
        require_aware(self.close_ts, f"bar close time for {self.symbol}")
        if not self.symbol or not self.currency or not self.source:
            raise ValueError("symbol, currency and source are required")

    def to_bar(self) -> Bar:
        """The strategy-facing bar. Missing open/high/low fall back to the close."""
        c = self.close
        return Bar(
            symbol=self.symbol,
            close_ts=self.close_ts,
            open=self.open if self.open is not None else c,
            high=self.high if self.high is not None else c,
            low=self.low if self.low is not None else c,
            close=c,
            volume=self.volume if self.volume is not None else math.nan,
        )
