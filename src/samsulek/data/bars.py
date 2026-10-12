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
