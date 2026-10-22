"""The calendar-aware freshness rule (owner decision Q11, spec P6): one rule for the bot and the backtest.

At the scheduled run (E = the open-print label plus the execution delay) the newest bar
that must exist is exactly the previous Xetra session's, on every session 2004-2026. The
old "4 calendar days" rule halted on 42 of those sessions (Easter and Christmas); the new
rule passes them and still fails when one session is missing. Calendar errors fail closed.
``check_fresh`` (M2 research checks) gives the same answers as its M2 version.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from samsulek.backtest.clock import session_times
from samsulek.backtest.types import ExecutionTiming
from samsulek.cycle import DATA_PUBLISH_DELAY
from samsulek.data.bars import DailyBar, TradingCalendar
from samsulek.data.calendars import CalendarRangeError, XetraCalendar
from samsulek.data.freshness import LOOKBACK_DAYS, expected_session, stale_bars_problem
from samsulek.data.quality import Issue, check_fresh
from samsulek.types import Bar, require_aware

CAL = XetraCalendar()
SESSIONS = CAL.sessions(date(2004, 1, 5), date(2026, 12, 30))
EXEC_DELAYS = (timedelta(0), timedelta(minutes=3), timedelta(minutes=10))
OLD_MAX_BAR_AGE = timedelta(days=4)  # the rule this replaces (cycle.MAX_BAR_AGE until M3)

# Every session the old rule halted on at E, bars complete through the previous session:
# 23 Easter Tuesdays and 19 sessions after Christmas or New Year.
OLD_RULE_HALTS = tuple(
    date.fromisoformat(d)
    for d in (
        *("2004-04-13", "2005-03-29", "2006-04-18", "2006-12-27", "2007-04-10", "2007-12-27", "2008-01-02"),
        *("2008-03-25", "2008-12-29", "2009-04-14", "2009-12-28", "2010-01-04", "2010-04-06", "2011-04-26"),
        *("2012-04-10", "2012-12-27", "2013-01-02", "2013-04-02", "2014-04-22", "2014-12-29", "2015-04-07"),
        *("2015-12-28", "2016-01-04", "2016-03-29", "2017-04-18", "2017-12-27", "2018-04-03", "2018-12-27"),
        *("2019-01-02", "2019-04-23", "2020-04-14", "2020-12-28", "2021-01-04", "2021-04-06", "2022-04-19"),
        *("2023-04-11", "2023-12-27", "2024-04-02", "2025-04-22", "2025-12-29", "2026-04-07", "2026-12-28"),
    )
)


def bar_at(symbol: str, close_ts: datetime) -> Bar:
    return Bar(symbol, close_ts, 10.0, 10.0, 10.0, 10.0, 100.0)


def bars_through(cal: TradingCalendar, last: date, *, symbol: str = "AAA") -> list[Bar]:
    """Two bars for ``symbol``, the newest closing on session ``last`` (the other a day earlier)."""
    close = cal.close_utc(last)
    return [bar_at(symbol, close - timedelta(days=1)), bar_at(symbol, close)]


class ClockCalendar:
    """Weekdays only, closing at ``close`` local time in ``tz`` (local and UTC dates can differ)."""

    name = "TEST"

    def __init__(self, tz: str, close: time) -> None:
        self.tz = tz
        self._close = close

    def is_session(self, day: date) -> bool:
        return day.weekday() < 5

    def sessions(self, start: date, end: date) -> list[date]:
        return [
            start + timedelta(days=i)
            for i in range((end - start).days + 1)
            if self.is_session(start + timedelta(days=i))
        ]

    def close_utc(self, day: date) -> datetime:
        return datetime.combine(day, self._close, tzinfo=ZoneInfo(self.tz)).astimezone(UTC)


class NoSessionCalendar(ClockCalendar):
    name = "NEVER"

    def is_session(self, day: date) -> bool:
        return False


# ------------------------------------------------------------------- the sweep (P6)
def test_the_publish_delay_is_six_hours() -> None:
    assert timedelta(hours=6) == DATA_PUBLISH_DELAY
    assert LOOKBACK_DAYS == 14


@pytest.mark.parametrize("exec_delay", EXEC_DELAYS, ids=["0min", "3min", "10min"])
def test_at_every_execution_time_the_previous_session_is_due(exec_delay: timedelta) -> None:
    """Every Xetra session 2004-01-05 .. 2026-12-30, at E: the previous session's bar must exist,
    and today's must not yet. Bars through the previous session pass; one session missing fails."""
    timing = ExecutionTiming(exec_delay=exec_delay)
    every = [date(2004, 1, 2), *SESSIONS]
    wrong: list[str] = []
    for i, s in enumerate(every[1:], start=1):
        e = session_times(CAL, s, timing).execute
        prev = every[i - 1]
        assert CAL.previous_session(s) == prev
        found = expected_session(CAL, e, DATA_PUBLISH_DELAY)
        if found != prev:
            wrong.append(f"{s}: expected {found}, not {prev}")
            continue
        complete = {"AAA": bars_through(CAL, prev), "BBB": bars_through(CAL, prev, symbol="BBB")}
        if stale_bars_problem(complete, ["AAA", "BBB"], e, CAL, DATA_PUBLISH_DELAY) is not None:
            wrong.append(f"{s}: complete bars refused")
        # The previous session's bar is missing: the newest is the session before's (for the
        # first one, 2004-01-01: the calendar has no 2003, and any older bar must fail too).
        older = every[i - 2] if i >= 2 else date(2004, 1, 1)
        older_bar = bar_at("BBB", datetime.combine(older, time(16, 40), tzinfo=UTC))
        one_missing = {**complete, "BBB": [older_bar]}
        problem = stale_bars_problem(one_missing, ["AAA", "BBB"], e, CAL, DATA_PUBLISH_DELAY)
        if problem != f"latest BBB bar is from {older}; the {prev} close is due by now":
            wrong.append(f"{s}: a missing session gave {problem!r}")
    assert wrong == [], wrong[:5]
    assert len(every) > 5_800


def test_the_first_session_of_2004_fails_closed() -> None:
    """2004-01-02 at E: the scan reaches 2003, which the calendar was not checked for."""
    e = session_times(CAL, date(2004, 1, 2), ExecutionTiming()).execute
    with pytest.raises(CalendarRangeError):
        expected_session(CAL, e, DATA_PUBLISH_DELAY)
    with pytest.raises(CalendarRangeError):
        stale_bars_problem(
            {"AAA": [bar_at("AAA", e - timedelta(days=1))]}, ["AAA"], e, CAL, DATA_PUBLISH_DELAY
        )
    # The first full scan inside the checked years: 2004-01-05 expects 2004-01-02.
    e5 = session_times(CAL, date(2004, 1, 5), ExecutionTiming()).execute
    assert expected_session(CAL, e5, DATA_PUBLISH_DELAY) == date(2004, 1, 2)


def test_2027_fails_closed_until_the_calendar_is_checked() -> None:
    now = datetime(2027, 1, 5, 8, 0, tzinfo=UTC)
    with pytest.raises(CalendarRangeError):
        expected_session(CAL, now, DATA_PUBLISH_DELAY)
    assert expected_session(XetraCalendar(checked_through_year=2027), now, DATA_PUBLISH_DELAY) == date(
        2027, 1, 4
    )


def test_the_42_sessions_the_old_rule_halted_on_now_pass() -> None:
    for exec_delay in EXEC_DELAYS:
        timing = ExecutionTiming(exec_delay=exec_delay)
        old_halts = []
        for s in SESSIONS:
            e = session_times(CAL, s, timing).execute
            if e - CAL.close_utc(CAL.previous_session(s)) > OLD_MAX_BAR_AGE:
                old_halts.append(s)
        assert tuple(old_halts) == OLD_RULE_HALTS, exec_delay
    assert len(OLD_RULE_HALTS) == 42
    for s in OLD_RULE_HALTS:
        e = session_times(CAL, s, ExecutionTiming()).execute
        prev = CAL.previous_session(s)
        assert (
            stale_bars_problem({"AAA": bars_through(CAL, prev)}, ["AAA"], e, CAL, DATA_PUBLISH_DELAY) is None
        )


def test_after_the_close_the_same_day_bar_is_due_only_after_the_publish_delay() -> None:
    for s in SESSIONS[1:]:
        close = CAL.close_utc(s)
        prev = CAL.previous_session(s)
        assert expected_session(CAL, close, DATA_PUBLISH_DELAY) == prev, s
        assert (
            expected_session(CAL, close + DATA_PUBLISH_DELAY - timedelta(microseconds=1), DATA_PUBLISH_DELAY)
            == prev
        )
        assert expected_session(CAL, close + DATA_PUBLISH_DELAY, DATA_PUBLISH_DELAY) == s, s


@pytest.mark.parametrize(
    ("now", "expected"),
    [
        (datetime(2026, 10, 17, 12, 0, tzinfo=UTC), date(2026, 10, 16)),  # Saturday: Friday's bar
        (datetime(2026, 10, 19, 7, 5, tzinfo=UTC), date(2026, 10, 16)),  # Monday 09:05 Berlin
        (datetime(2026, 4, 7, 7, 5, tzinfo=UTC), date(2026, 4, 2)),  # Tuesday after Easter
        (datetime(2025, 12, 29, 8, 5, tzinfo=UTC), date(2025, 12, 23)),  # after Christmas
        (datetime(2026, 1, 2, 8, 5, tzinfo=UTC), date(2025, 12, 30)),  # after New Year (14:00 close)
    ],
)
def test_weekends_and_holidays(now: datetime, expected: date) -> None:
    assert expected_session(CAL, now, DATA_PUBLISH_DELAY) == expected


# ------------------------------------------------------------------- messages and edges
def test_problem_messages() -> None:
    e = session_times(CAL, date(2026, 10, 13), ExecutionTiming()).execute
    fresh = bars_through(CAL, date(2026, 10, 12))
    assert stale_bars_problem({"AAA": fresh}, ["AAA", "BBB"], e, CAL, DATA_PUBLISH_DELAY) == (
        "no price history for BBB"
    )
    assert stale_bars_problem({"AAA": fresh, "BBB": []}, ["AAA", "BBB"], e, CAL, DATA_PUBLISH_DELAY) == (
        "no price history for BBB"
    )
    assert stale_bars_problem({"AAA": fresh}, [], e, CAL, DATA_PUBLISH_DELAY) is None
    # Symbols are checked in the order given; the first problem is reported.
    old = bars_through(CAL, date(2026, 10, 9))
    assert stale_bars_problem({"AAA": old, "BBB": old}, ["BBB", "AAA"], e, CAL, DATA_PUBLISH_DELAY) == (
        "latest BBB bar is from 2026-10-09; the 2026-10-12 close is due by now"
    )
    # A bar newer than expected is fine (only "too old" is this rule's business).
    assert (
        stale_bars_problem(
            {"AAA": bars_through(CAL, date(2026, 10, 13))}, ["AAA"], e, CAL, DATA_PUBLISH_DELAY
        )
        is None
    )


def test_no_session_in_the_lookback() -> None:
    cal = NoSessionCalendar("UTC", time(15, 30))
    now = datetime(2026, 10, 13, 12, 0, tzinfo=UTC)
    assert expected_session(cal, now, DATA_PUBLISH_DELAY) is None
    assert stale_bars_problem({"AAA": [bar_at("AAA", now)]}, ["AAA"], now, cal, DATA_PUBLISH_DELAY) == (
        f"no NEVER session in the 14 days before {now.isoformat()}"
    )


def test_the_lookback_is_today_and_the_14_days_before() -> None:
    class OneDay(ClockCalendar):
        def __init__(self, day: date) -> None:
            super().__init__("UTC", time(15, 30))
            self.day = day

        def is_session(self, day: date) -> bool:
            return day == self.day

    now = datetime(2026, 10, 20, 12, 0, tzinfo=UTC)
    assert expected_session(OneDay(date(2026, 10, 6)), now, timedelta(0)) == date(2026, 10, 6)
    assert expected_session(OneDay(date(2026, 10, 5)), now, timedelta(0)) is None


def test_today_and_the_bar_session_are_exchange_local_dates() -> None:
    # Tokyo, closing 06:00 local (21:00 UTC the day before): at 23:00 UTC on Monday 12 Oct it is
    # already Tuesday 13 Oct in Tokyo, and Tuesday's close has passed.
    tokyo = ClockCalendar("Asia/Tokyo", time(6, 0))
    now = datetime(2026, 10, 12, 23, 0, tzinfo=UTC)
    assert expected_session(tokyo, now, timedelta(0)) == date(2026, 10, 13)
    # New York, closing 21:00 local (01:00 UTC the next day): Monday's bar is dated Monday,
    # though its UTC date is Tuesday, so it is stale once Tuesday's close is due.
    new_york = ClockCalendar("America/New_York", time(21, 0))
    monday_bar = bar_at("AAA", new_york.close_utc(date(2026, 10, 12)))
    assert monday_bar.close_ts.date() == date(2026, 10, 13)
    now = new_york.close_utc(date(2026, 10, 13))
    assert stale_bars_problem({"AAA": [monday_bar]}, ["AAA"], now, new_york, timedelta(0)) == (
        "latest AAA bar is from 2026-10-12; the 2026-10-13 close is due by now"
    )


def test_naive_now_is_refused() -> None:
    naive = datetime(2026, 10, 13, 12, 0)  # noqa: DTZ001
    with pytest.raises(ValueError, match="timezone"):
        expected_session(CAL, naive, DATA_PUBLISH_DELAY)
    with pytest.raises(ValueError, match="timezone"):
        stale_bars_problem({}, ["AAA"], naive, CAL, DATA_PUBLISH_DELAY)


# ------------------------------------------------------------------- check_fresh vs its M2 version
def check_fresh_m2(
    bars: Sequence[DailyBar], calendar: TradingCalendar, now: datetime, publish_delay: timedelta, symbol: str
) -> list[Issue]:
    """``data.quality.check_fresh`` as of M2 (HEAD 4f441b8), verbatim: the oracle."""
    require_aware(now, "now")
    issues = [
        Issue("error", "future_bar", symbol, b.session, f"closes at {b.close_ts.isoformat()}, after now")
        for b in bars
        if b.close_ts > now
    ]
    today = now.astimezone(ZoneInfo(calendar.tz)).date()
    recent = calendar.sessions(today - timedelta(days=14), today)
    due = [d for d in recent if calendar.close_utc(d) + publish_delay <= now]
    if not due:
        issues.append(Issue("error", "calendar_gap", symbol, None, "no trading day in the last 14 days?"))
        return issues
    expected = due[-1]
    latest = max((b.session for b in bars if b.close_ts <= now), default=None)
    if latest is None:
        issues.append(Issue("error", "no_data", symbol, None, "no bars at all"))
    elif latest < expected:
        issues.append(
            Issue(
                "error", "stale_series", symbol, latest, f"newest bar is {latest}, expected {expected} by now"
            )
        )
    return issues


CALENDARS: dict[str, TradingCalendar] = {
    "xetra": CAL,
    "tokyo": ClockCalendar("Asia/Tokyo", time(6, 0)),
    "new_york": ClockCalendar("America/New_York", time(21, 0)),
    "never": NoSessionCalendar("UTC", time(15, 30)),
}


@settings(max_examples=400)
@given(
    calendar=st.sampled_from(sorted(CALENDARS)),
    now=st.datetimes(
        min_value=datetime(2004, 2, 1),  # noqa: DTZ001 (hypothesis wants naive bounds)
        max_value=datetime(2026, 12, 15),  # noqa: DTZ001
        timezones=st.just(UTC),
    ),
    delay_minutes=st.integers(min_value=0, max_value=30 * 60),
    sessions_back=st.integers(min_value=-2, max_value=8),
    with_bars=st.booleans(),
)
def test_check_fresh_answers_as_before(
    calendar: str, now: datetime, delay_minutes: int, sessions_back: int, with_bars: bool
) -> None:
    compare_with_m2(CALENDARS[calendar], now, timedelta(minutes=delay_minutes), sessions_back, with_bars)


@settings(max_examples=400)
@given(
    calendar=st.sampled_from(["xetra", "tokyo", "new_york"]),
    day=st.dates(min_value=date(2004, 2, 1), max_value=date(2026, 12, 1)),
    delay_minutes=st.integers(min_value=0, max_value=30 * 60),
    offset_minutes=st.integers(min_value=-90, max_value=90),
    sessions_back=st.integers(min_value=-1, max_value=3),
)
def test_check_fresh_answers_as_before_around_the_due_time(
    calendar: str, day: date, delay_minutes: int, offset_minutes: int, sessions_back: int
) -> None:
    """``now`` within 90 minutes of a session's close plus the publish delay: where the answer flips."""
    cal = CALENDARS[calendar]
    session = cal.sessions(day, day + timedelta(days=10))[0]
    delay = timedelta(minutes=delay_minutes)
    compare_with_m2(
        cal, cal.close_utc(session) + delay + timedelta(minutes=offset_minutes), delay, sessions_back, True
    )


def test_check_fresh_at_the_start_of_2004_needs_no_2003() -> None:
    """The one place ``check_fresh`` answers differently from M2, on purpose (the P6 sweep needs it).

    M2 listed all 14 days before today, so in the first two weeks of 2004 it raised for the
    2003 days even when a 2004 session was due. The shared rule stops at the first due
    session, so it needs 2003 only while no 2004 session is due yet, and then fails closed.
    """
    now = datetime(2004, 1, 9, 12, 0, tzinfo=UTC)
    bars = [
        DailyBar("ETF", d, CAL.close_utc(d), 10.0, 10.0, 10.0, 10.0, 1.0, "EUR", "test")
        for d in CAL.sessions(date(2004, 1, 2), date(2004, 1, 8))
    ]
    with pytest.raises(CalendarRangeError):
        check_fresh_m2(bars, CAL, now, DATA_PUBLISH_DELAY, "ETF")
    assert check_fresh(bars, CAL, now, DATA_PUBLISH_DELAY, "ETF") == []
    assert check_fresh(bars[:-1], CAL, now, DATA_PUBLISH_DELAY, "ETF") == [
        Issue(
            "error",
            "stale_series",
            "ETF",
            date(2004, 1, 7),
            "newest bar is 2004-01-07, expected 2004-01-08 by now",
        )
    ]
    with pytest.raises(CalendarRangeError):  # 2 Jan 2004 before its close is due: only 2003 is left
        check_fresh([], CAL, datetime(2004, 1, 2, 12, 0, tzinfo=UTC), DATA_PUBLISH_DELAY, "ETF")


def compare_with_m2(
    cal: TradingCalendar, now: datetime, delay: timedelta, sessions_back: int, with_bars: bool
) -> None:
    today = now.astimezone(ZoneInfo(cal.tz)).date()
    days = cal.sessions(today - timedelta(days=30), today + timedelta(days=4))
    # Bars through the session ``sessions_back`` sessions before today's (negative: future bars too).
    cut = len([d for d in days if d <= today]) - sessions_back
    bars = [
        DailyBar("ETF", d, cal.close_utc(d), 10.0, 10.0, 10.0, 10.0, 1.0, "EUR", "test")
        for d in (days[:cut] if with_bars else [])
    ]
    assert check_fresh(bars, cal, now, delay, "ETF") == check_fresh_m2(bars, cal, now, delay, "ETF")
