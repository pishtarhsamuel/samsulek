"""Time sources. Everything asks a Clock for "now" so tests and backtests control time."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from typing import Protocol
from zoneinfo import ZoneInfo

from samsulek.types import require_aware


class Clock(Protocol):
    def now(self) -> datetime: ...


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(UTC)


class FixedClock:
    """A manually advanced clock for tests and simulations."""

    def __init__(self, start: datetime) -> None:
        require_aware(start, "FixedClock start")
        self._now = start

    def now(self) -> datetime:
        return self._now

    def set(self, ts: datetime) -> None:
        require_aware(ts, "FixedClock time")
        self._now = ts

    def advance(self, delta: timedelta) -> None:
        self._now = self._now + delta


def trading_day(ts: datetime, tz_name: str) -> date:
    """The calendar day of ``ts`` in timezone ``tz_name`` (defines "today" for daily limits)."""
    require_aware(ts, "timestamp")
    return ts.astimezone(ZoneInfo(tz_name)).date()
