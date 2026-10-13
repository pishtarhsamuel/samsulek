"""Exchange calendars, standard library only.

XETR (Xetra, Frankfurt). Holiday rules as encoded by exchange_calendars 4.13.2
(checked in tests against a fixture generated from that package: 0 differences
2004-2027). They have NOT been checked against Deutsche Boerse's own published
calendar from here (that site was unreachable). So the calendar refuses years after
``CHECKED_THROUGH_YEAR`` (fail closed): before each new year, the owner compares the
next year's holidays with the official list and raises the constant.

Times:
- Continuous trading ends 17:30 Berlin (14:00 on the early-close day before New Year's
  Eve). The official closing price comes from the closing auction that follows, so a
  bar is labeled at ``close_utc`` = scheduled close + ``AUCTION_ALLOWANCE`` (10 min).
  Labeling it 17:30 would date the price before it existed (a small lookahead).
- Before November 2003 the trading hours were different (not verified here), so the
  calendar refuses years before 2004.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from functools import lru_cache
from zoneinfo import ZoneInfo


class CalendarRangeError(ValueError):
    """The calendar has not been checked for this year: refuse rather than guess."""


def easter_sunday(year: int) -> date:
    """Gregorian Easter Sunday (Meeus/Jones/Butcher algorithm)."""
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l_ = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l_) // 451
    month, day = divmod(h + l_ - 7 * m + 114, 31)
    return date(year, month, day + 1)


class XetraCalendar:
    name = "XETR"
    tz = "Europe/Berlin"
    FIRST_YEAR = 2004
    CHECKED_THROUGH_YEAR = 2026
    REGULAR_CLOSE = time(17, 30)
    EARLY_CLOSE = time(14, 0)
    AUCTION_ALLOWANCE = timedelta(minutes=10)

    def __init__(self, checked_through_year: int | None = None) -> None:
        self._zone = ZoneInfo(self.tz)
        self._last_year = checked_through_year or self.CHECKED_THROUGH_YEAR

    # ------------------------------------------------------------------ rules
    def _check_year(self, year: int) -> None:
        if not self.FIRST_YEAR <= year <= self._last_year:
            raise CalendarRangeError(
                f"{self.name} calendar is only checked for {self.FIRST_YEAR}-{self._last_year}, not {year}. "
                "Compare the official Xetra trading calendar for that year, then raise CHECKED_THROUGH_YEAR."
            )

    def holidays(self, year: int) -> frozenset[date]:
        self._check_year(year)
        return _xetra_holidays(year)

    def early_close_day(self, year: int) -> date | None:
        """The last weekday before 31 Dec (closes 14:00), from 2010."""
        self._check_year(year)
        if year < 2010:
            return None
        d = date(year, 12, 30)
        while d.weekday() >= 5:
            d -= timedelta(days=1)
        return d

    # ----------------------------------------------------- TradingCalendar API
    def is_session(self, day: date) -> bool:
        return day.weekday() < 5 and day not in self.holidays(day.year)

    def sessions(self, start: date, end: date) -> list[date]:
        out: list[date] = []
        d = start
        while d <= end:
            if self.is_session(d):
                out.append(d)
            d += timedelta(days=1)
        return out

    def scheduled_close_utc(self, day: date) -> datetime:
        if not self.is_session(day):
            raise ValueError(f"{day} is not a {self.name} trading day")
        t = self.EARLY_CLOSE if day == self.early_close_day(day.year) else self.REGULAR_CLOSE
        return datetime.combine(day, t, tzinfo=self._zone).astimezone(UTC)

    def close_utc(self, day: date) -> datetime:
        """When ``day``'s closing price is final: the bar's point-in-time label."""
        return self.scheduled_close_utc(day) + self.AUCTION_ALLOWANCE

    def previous_session(self, day: date) -> date:
        d = day - timedelta(days=1)
        for _ in range(15):
            if self.is_session(d):
                return d
            d -= timedelta(days=1)
        raise ValueError(f"no {self.name} session in the 15 days before {day}")


@lru_cache(maxsize=64)
def _xetra_holidays(year: int) -> frozenset[date]:
    e = easter_sunday(year)
    days = {
        date(year, 1, 1),
        e - timedelta(days=2),  # Good Friday
        e + timedelta(days=1),  # Easter Monday
        date(year, 5, 1),
        date(year, 12, 24),
        date(year, 12, 25),
        date(year, 12, 26),
        date(year, 12, 31),
    }
    if year == 2007 or 2015 <= year <= 2021:
        days.add(e + timedelta(days=50))  # Whit Monday
    if 2014 <= year <= 2021:
        days.add(date(year, 10, 3))  # Day of German Unity
    if year == 2017:
        days.add(date(2017, 10, 31))  # Reformation Day, 500th anniversary
    return frozenset(d for d in days if d.weekday() < 5)
