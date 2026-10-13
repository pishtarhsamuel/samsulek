"""The stdlib Xetra calendar against a fixture generated from exchange_calendars 4.13.2."""

from __future__ import annotations

import itertools
import json
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

from samsulek.data.calendars import CalendarRangeError, XetraCalendar, easter_sunday

FIXTURE = Path(__file__).parent / "fixtures" / "calendar" / "xetr_exchange_calendars_4_13_2.json"
GOLDEN = json.loads(FIXTURE.read_text(encoding="utf-8"))
CAL = XetraCalendar(checked_through_year=2027)  # the fixture covers 2027


def test_closed_weekdays_match_the_reference_every_year() -> None:
    for year in range(2004, 2028):
        expected = sorted(GOLDEN["closed_weekdays"].get(str(year), []))
        ours = sorted(d.isoformat() for d in CAL.holidays(year))
        assert ours == expected, year


def test_session_count_and_early_closes_match() -> None:
    assert len(CAL.sessions(date(2004, 1, 1), date(2027, 12, 31))) == GOLDEN["session_count"]
    for year in range(2004, 2028):
        expected = GOLDEN["early_closes"].get(str(year), [])
        ours = CAL.early_close_day(year)
        assert ([ours.isoformat()] if ours else []) == expected, year


def test_scheduled_close_times_match_including_daylight_saving() -> None:
    for day, close in GOLDEN["close_times_utc_sample"].items():
        assert CAL.scheduled_close_utc(date.fromisoformat(day)) == datetime.fromisoformat(close), day


def test_bars_are_labeled_after_the_closing_auction() -> None:
    summer, winter = date(2026, 7, 15), date(2026, 1, 15)
    assert CAL.close_utc(summer) == datetime(2026, 7, 15, 15, 40, tzinfo=UTC)  # 17:40 Berlin (CEST)
    assert CAL.close_utc(winter) == datetime(2026, 1, 15, 16, 40, tzinfo=UTC)  # 17:40 Berlin (CET)
    early = CAL.early_close_day(2026)
    assert early == date(2026, 12, 30)
    assert CAL.close_utc(early) == datetime(2026, 12, 30, 13, 10, tzinfo=UTC)  # 14:10 Berlin


def test_known_2026_holidays_and_trading_days() -> None:
    closed = {date(2026, 1, 1), date(2026, 4, 3), date(2026, 4, 6), date(2026, 5, 1), date(2026, 12, 24)}
    for d in closed:
        assert not CAL.is_session(d), d
    for d in (date(2026, 5, 25), date(2026, 10, 5), date(2026, 10, 12)):  # Whit Monday trades since 2022
        assert CAL.is_session(d), d
    with pytest.raises(ValueError, match="not a XETR trading day"):
        CAL.close_utc(date(2026, 4, 3))
    assert CAL.previous_session(date(2026, 4, 7)) == date(2026, 4, 2)  # over Easter


def test_unchecked_years_are_refused() -> None:
    default = XetraCalendar()
    assert default.is_session(date(2026, 10, 12))
    with pytest.raises(CalendarRangeError, match="raise CHECKED_THROUGH_YEAR"):
        default.is_session(date(2027, 1, 4))
    with pytest.raises(CalendarRangeError):
        default.sessions(date(2003, 12, 20), date(2004, 1, 10))


def test_easter_against_known_dates() -> None:
    known = {
        2000: (4, 23),
        2008: (3, 23),
        2011: (4, 24),
        2019: (4, 21),
        2024: (3, 31),
        2026: (4, 5),
        2038: (4, 25),
    }
    for year, (m, d) in known.items():
        assert easter_sunday(year) == date(year, m, d)


def test_sessions_are_weekdays_in_order() -> None:
    days = CAL.sessions(date(2025, 12, 20), date(2026, 1, 10))
    assert days == sorted(days)
    assert all(d.weekday() < 5 for d in days)
    assert date(2025, 12, 24) not in days and date(2026, 1, 2) in days
    # Longest gap: Christmas 2025 (closed Wed-Fri, then the weekend) is 6 days, 23 -> 29 Dec.
    assert max(b - a for a, b in itertools.pairwise(days)) == timedelta(days=6)
