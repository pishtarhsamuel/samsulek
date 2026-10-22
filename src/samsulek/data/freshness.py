"""Calendar-aware freshness of daily bars: one rule for the bot and the backtest (owner decision Q11).

The rule: at ``now``, the latest bar of every symbol must be from
``expected_session(calendar, now, publish_delay)`` or later. That is the newest session
``d`` among today and the ``LOOKBACK_DAYS`` days before it (today in the exchange's
timezone) whose bar is due: ``close_utc(d) + publish_delay <= now``, where the delay is how
long the source takes to publish a close. At the scheduled run after the open this is
exactly the previous session, so the rule never trips over a weekend, Easter or Christmas,
and always trips when one session is missing.

Facts relied on:
- A bar's session is the exchange-local date of its ``close_ts`` (its point-in-time label),
  and a symbol's bars are in time order, so its latest bar is the last one.
- ``close_utc`` grows with the day, so the first due session found scanning back from
  today is the newest one. The scan stops there: days older than that are never asked.
- Calendar errors propagate. ``XetraCalendar`` raises ``CalendarRangeError`` (a
  ``ValueError``) for a year it was not checked for, so callers fail closed.

Imports only ``data.bars``, ``samsulek.types`` and the standard library.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import date, datetime, timedelta
from typing import Final
from zoneinfo import ZoneInfo

from samsulek.data.bars import TradingCalendar
from samsulek.types import Bar, require_aware

LOOKBACK_DAYS: Final = 14


def expected_session(calendar: TradingCalendar, now: datetime, publish_delay: timedelta) -> date | None:
    """The newest session whose bar must exist by ``now``; None if there is none in the lookback."""
    require_aware(now, "now")
    today = now.astimezone(ZoneInfo(calendar.tz)).date()
    for back in range(LOOKBACK_DAYS + 1):
        day = today - timedelta(days=back)
        if calendar.is_session(day) and calendar.close_utc(day) + publish_delay <= now:
            return day
    return None


def stale_bars_problem(
    bars: Mapping[str, Sequence[Bar]],
    symbols: Sequence[str],
    now: datetime,
    calendar: TradingCalendar,
    publish_delay: timedelta,
) -> str | None:
    """Why these bars can't be traded on at ``now`` (missing or stale), or None if all are current."""
    expected = expected_session(calendar, now, publish_delay)
    if expected is None:
        return f"no {calendar.name} session in the {LOOKBACK_DAYS} days before {now.isoformat()}"
    zone = ZoneInfo(calendar.tz)
    for symbol in symbols:
        series = bars.get(symbol) or ()
        if not series:
            return f"no price history for {symbol}"
        latest = series[-1].close_ts.astimezone(zone).date()
        if latest < expected:
            return f"latest {symbol} bar is from {latest}; the {expected} close is due by now"
    return None
