"""Calendar-aware freshness of daily bars (M3 skeleton; WP1 fills it in).

The rule (owner decision Q11): at ``now``, the latest bar of every symbol must be from
``expected_session(calendar, now, publish_delay)``: the newest session ``d`` in the
``LOOKBACK_DAYS`` before today (exchange-local) with ``close_utc(d) + publish_delay <=
now``. At the scheduled run this is exactly the previous Xetra session. Calendar range
errors propagate, so a calendar that was not checked for the year fails closed. Imports
only ``data.bars``, ``samsulek.types`` and the standard library.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import date, datetime, timedelta
from typing import Final

from samsulek.data.bars import TradingCalendar
from samsulek.types import Bar

LOOKBACK_DAYS: Final = 14


def expected_session(calendar: TradingCalendar, now: datetime, publish_delay: timedelta) -> date | None:
    raise NotImplementedError("WP1")


def stale_bars_problem(
    bars: Mapping[str, Sequence[Bar]],
    symbols: Sequence[str],
    now: datetime,
    calendar: TradingCalendar,
    publish_delay: timedelta,
) -> str | None:
    raise NotImplementedError("WP1")
