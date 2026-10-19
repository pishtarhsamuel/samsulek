"""Xetra opening times and the next-session scan (M3 additions to data/calendars.py)."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from itertools import pairwise

import pytest

from samsulek.data.calendars import CalendarRangeError, XetraCalendar

CAL = XetraCalendar()  # checked through 2026, the production setting
ALL_SESSIONS = CAL.sessions(date(2004, 1, 1), date(2026, 12, 31))


def test_open_is_nine_berlin_in_winter_and_summer_time() -> None:
    # 2024: CEST from Sunday 31 March to Sunday 27 October.
    cases = {
        date(2024, 3, 28): datetime(2024, 3, 28, 8, 0, tzinfo=UTC),  # last CET session before Easter
        date(2024, 4, 2): datetime(2024, 4, 2, 7, 0, tzinfo=UTC),  # first CEST session (after Easter)
        date(2024, 10, 25): datetime(2024, 10, 25, 7, 0, tzinfo=UTC),  # last CEST session
        date(2024, 10, 28): datetime(2024, 10, 28, 8, 0, tzinfo=UTC),  # first CET session
        date(2026, 3, 27): datetime(2026, 3, 27, 8, 0, tzinfo=UTC),
        date(2026, 3, 30): datetime(2026, 3, 30, 7, 0, tzinfo=UTC),
    }
    for day, expected in cases.items():
        assert CAL.open_utc(day) == expected, day
        assert CAL.open_print_utc(day) == expected + timedelta(minutes=5), day
        assert CAL.open_utc(day).tzinfo is UTC


def test_the_worked_example_of_the_spec() -> None:
    # Tuesday 2024-04-02, the first session after Easter Monday: E = 07:05 UTC = 09:05 Berlin.
    assert CAL.open_print_utc(date(2024, 4, 2)) == datetime(2024, 4, 2, 7, 5, tzinfo=UTC)
    assert CAL.close_utc(date(2024, 4, 2)) == datetime(2024, 4, 2, 15, 40, tzinfo=UTC)
    assert CAL.previous_session(date(2024, 4, 2)) == date(2024, 3, 28)
    assert CAL.next_session(date(2024, 3, 28)) == date(2024, 4, 2)


def test_the_early_close_day_opens_as_usual() -> None:
    early = CAL.early_close_day(2024)
    assert early == date(2024, 12, 30)
    assert CAL.open_utc(early) == datetime(2024, 12, 30, 8, 0, tzinfo=UTC)
    assert CAL.open_print_utc(early) == datetime(2024, 12, 30, 8, 5, tzinfo=UTC)
    assert CAL.close_utc(early) == datetime(2024, 12, 30, 13, 10, tzinfo=UTC)  # 14:10 Berlin


def test_constants_are_the_documented_unverified_values() -> None:
    assert XetraCalendar.OPEN.hour == 9 and XetraCalendar.OPEN.minute == 0
    assert timedelta(minutes=5) == XetraCalendar.OPEN_PRINT_ALLOWANCE
    assert timedelta(0) < XetraCalendar.OPEN_PRINT_ALLOWANCE < XetraCalendar.AUCTION_ALLOWANCE


def test_open_print_is_before_the_close_on_every_session_2004_2026() -> None:
    assert len(ALL_SESSIONS) > 5_800
    early_days = 0
    for day in ALL_SESSIONS:
        open_, open_print, close = CAL.open_utc(day), CAL.open_print_utc(day), CAL.close_utc(day)
        assert open_ < open_print < close, day
        assert open_print == open_ + XetraCalendar.OPEN_PRINT_ALLOWANCE, day
        assert open_print.date() == day, day  # same UTC day: no session straddles midnight
        early_days += day == CAL.early_close_day(day.year)
    assert early_days == len(range(2010, 2027))  # one 14:00 close a year from 2010
    for prev, day in pairwise(ALL_SESSIONS):
        assert CAL.close_utc(prev) < CAL.open_utc(day), day


def test_next_session_is_the_exact_inverse_of_previous_session() -> None:
    for a, b in pairwise(ALL_SESSIONS):
        assert CAL.next_session(a) == b, a
        assert CAL.previous_session(b) == a, b
        assert CAL.previous_session(CAL.next_session(a)) == a, a
        assert CAL.next_session(CAL.previous_session(b)) == b, b


def test_next_session_from_any_day_is_the_first_session_after_it() -> None:
    day = date(2004, 1, 1)
    i = 0
    while day < date(2026, 12, 30):
        while ALL_SESSIONS[i] <= day:
            i += 1
        assert CAL.next_session(day) == ALL_SESSIONS[i], day
        day += timedelta(days=1)
    # weekend, Easter and Christmas
    assert CAL.next_session(date(2026, 10, 17)) == date(2026, 10, 19)
    assert CAL.next_session(date(2026, 4, 2)) == date(2026, 4, 7)
    assert CAL.next_session(date(2026, 12, 23)) == date(2026, 12, 28)


def test_non_sessions_are_value_errors_not_range_errors() -> None:
    for day in (date(2026, 4, 3), date(2026, 12, 24), date(2026, 10, 17)):  # Good Friday, Xmas Eve, Saturday
        for method in (CAL.open_utc, CAL.open_print_utc):
            with pytest.raises(ValueError, match="not a XETR trading day") as info:
                method(day)
            assert not isinstance(info.value, CalendarRangeError)


def test_outside_the_checked_years_everything_fails_closed() -> None:
    for day in (date(2027, 1, 4), date(2003, 12, 30)):
        for method in (CAL.open_utc, CAL.open_print_utc, CAL.next_session):
            with pytest.raises(CalendarRangeError):
                method(day)
    with pytest.raises(CalendarRangeError):
        CAL.next_session(ALL_SESSIONS[-1])  # the next session would be in 2027: unchecked
    with pytest.raises(CalendarRangeError):
        CAL.previous_session(ALL_SESSIONS[0])  # the one before would be in 2003
    assert ALL_SESSIONS[0] == date(2004, 1, 2)
    assert ALL_SESSIONS[-1] == date(2026, 12, 30)


def test_a_raised_checked_year_extends_the_scan() -> None:
    later = XetraCalendar(checked_through_year=2027)
    assert later.next_session(date(2026, 12, 30)) == date(2027, 1, 4)
    assert later.open_utc(date(2027, 1, 4)) == datetime(2027, 1, 4, 8, 0, tzinfo=UTC)


class _NeverTrades(XetraCalendar):
    def is_session(self, day: date) -> bool:
        return False


def test_next_session_gives_up_after_15_days_like_previous_session() -> None:
    cal = _NeverTrades()
    with pytest.raises(ValueError, match="no XETR session in the 15 days after 2026-06-01"):
        cal.next_session(date(2026, 6, 1))
    with pytest.raises(ValueError, match="no XETR session in the 15 days before 2026-06-01"):
        cal.previous_session(date(2026, 6, 1))
