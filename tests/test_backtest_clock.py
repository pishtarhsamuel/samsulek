"""The backtest clock only moves forward, and every session's instants come in a fixed order."""

from __future__ import annotations

import dataclasses
import pickle
from datetime import UTC, date, datetime, timedelta, timezone
from itertools import pairwise

import pytest
from hypothesis import given
from hypothesis import strategies as st

from samsulek.backtest.clock import ClockError, MonotoneClock, SessionTimes, session_times
from samsulek.backtest.types import ExecutionTiming
from samsulek.clock import Clock
from samsulek.data.calendars import CalendarRangeError, XetraCalendar

CAL = XetraCalendar()
T0 = datetime(2024, 3, 28, 16, 40, tzinfo=UTC)
ATHENS = timezone(timedelta(hours=3))


def _uses_clock(clock: Clock) -> datetime:
    return clock.now()


def roundtrip(obj: SessionTimes) -> SessionTimes:
    """Pickle and unpickle our own object (never untrusted bytes)."""
    back: SessionTimes = pickle.loads(pickle.dumps(obj))  # noqa: S301
    return back


def test_starts_where_told_and_satisfies_the_clock_interface() -> None:
    clock = MonotoneClock(T0)
    assert _uses_clock(clock) == T0
    assert clock.now().tzinfo is UTC


def test_naive_times_are_refused() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        MonotoneClock(datetime(2024, 1, 2, 9, 0))  # noqa: DTZ001 (the point of the test)
    clock = MonotoneClock(T0)
    with pytest.raises(ValueError, match="timezone-aware"):
        clock.set(datetime(2024, 4, 2, 7, 5))  # noqa: DTZ001
    assert clock.now() == T0


def test_moving_backwards_is_refused_and_leaves_the_time_unchanged() -> None:
    clock = MonotoneClock(T0)
    clock.set(T0 + timedelta(hours=1))
    with pytest.raises(ClockError, match="moved backwards"):
        clock.set(T0)
    with pytest.raises(ClockError):
        clock.set(T0 + timedelta(hours=1) - timedelta(microseconds=1))
    assert clock.now() == T0 + timedelta(hours=1)
    assert issubclass(ClockError, RuntimeError)


def test_setting_the_same_instant_again_is_allowed() -> None:
    clock = MonotoneClock(T0)
    clock.set(T0)
    clock.set(T0.astimezone(ATHENS))  # the same instant in another zone
    assert clock.now() == T0
    assert clock.now().tzinfo is UTC


def test_other_zones_are_compared_as_instants_and_stored_as_utc() -> None:
    clock = MonotoneClock(T0.astimezone(ATHENS))
    assert clock.now() == T0 and clock.now().tzinfo is UTC
    with pytest.raises(ClockError):
        clock.set((T0 - timedelta(seconds=1)).astimezone(ATHENS))


@given(st.lists(st.integers(min_value=-(10**6), max_value=10**6), min_size=1, max_size=50))
def test_the_clock_never_goes_back_whatever_it_is_asked(steps: list[int]) -> None:
    clock = MonotoneClock(T0)
    seen = [clock.now()]
    for step in steps:
        target = clock.now() + timedelta(seconds=step)
        if step < 0:
            with pytest.raises(ClockError):
                clock.set(target)
        else:
            clock.set(target)
        seen.append(clock.now())
    assert all(a <= b for a, b in pairwise(seen))


def test_the_worked_example_session() -> None:
    # Tuesday 2024-04-02 (CEST), default timing: E = 07:05 UTC, reset 06:35, mark 15:40.
    t = session_times(CAL, date(2024, 4, 2), ExecutionTiming())
    assert t == SessionTimes(
        session=date(2024, 4, 2),
        reset_at=datetime(2024, 4, 2, 6, 35, tzinfo=UTC),
        open_print=datetime(2024, 4, 2, 7, 5, tzinfo=UTC),
        execute=datetime(2024, 4, 2, 7, 5, tzinfo=UTC),
        close_print=datetime(2024, 4, 2, 15, 40, tzinfo=UTC),
    )
    assert t.execute - CAL.close_utc(CAL.previous_session(t.session)) == timedelta(
        days=4, hours=14, minutes=25
    )


def test_an_execution_delay_moves_e_and_the_reset_but_not_the_prints() -> None:
    t = session_times(CAL, date(2024, 4, 2), ExecutionTiming(exec_delay=timedelta(minutes=3)))
    assert t.open_print == datetime(2024, 4, 2, 7, 5, tzinfo=UTC)
    assert t.execute == datetime(2024, 4, 2, 7, 8, tzinfo=UTC)
    assert t.reset_at == datetime(2024, 4, 2, 6, 38, tzinfo=UTC)
    assert t.close_print == datetime(2024, 4, 2, 15, 40, tzinfo=UTC)


def test_the_early_close_day_marks_at_14_10_berlin() -> None:
    t = session_times(CAL, date(2024, 12, 30), ExecutionTiming())
    assert t.execute == datetime(2024, 12, 30, 8, 5, tzinfo=UTC)
    assert t.close_print == datetime(2024, 12, 30, 13, 10, tzinfo=UTC)


def test_the_instants_are_in_order_on_every_session_2004_2026() -> None:
    timings = [
        ExecutionTiming(exec_delay=timedelta(minutes=d), reset_lead=timedelta(minutes=r))
        for d, r in ((0, 30), (3, 1), (10, 120), (0, 1), (10, 30))
    ]
    sessions = CAL.sessions(date(2004, 1, 1), date(2026, 12, 31))
    for prev, day in pairwise(sessions):
        prev_close = CAL.close_utc(prev)
        for timing in timings:
            t = session_times(CAL, day, timing)
            assert prev_close < t.reset_at < t.execute < t.close_print, (day, timing)
            assert t.open_print <= t.execute, (day, timing)
            assert t.execute - t.open_print == timing.exec_delay
            assert t.execute - t.reset_at == timing.reset_lead


def test_non_sessions_and_unchecked_years_are_refused() -> None:
    with pytest.raises(ValueError, match="not a XETR trading day"):
        session_times(CAL, date(2024, 4, 1), ExecutionTiming())  # Easter Monday
    with pytest.raises(CalendarRangeError):
        session_times(CAL, date(2027, 1, 4), ExecutionTiming())


def test_timings_that_break_the_order_are_refused() -> None:
    day = date(2024, 4, 2)
    with pytest.raises(ValueError, match="out of order"):
        session_times(CAL, day, ExecutionTiming(exec_delay=timedelta(minutes=-1)))
    with pytest.raises(ValueError, match="out of order"):
        session_times(CAL, day, ExecutionTiming(reset_lead=timedelta(0)))
    with pytest.raises(ValueError, match="out of order"):
        session_times(CAL, day, ExecutionTiming(exec_delay=timedelta(hours=9)))  # E after the close


def test_session_times_is_frozen_and_pickles() -> None:
    t = session_times(CAL, date(2024, 4, 2), ExecutionTiming())
    assert type(t).__dataclass_params__.frozen  # type: ignore[attr-defined]
    assert "__slots__" in SessionTimes.__dict__
    with pytest.raises(dataclasses.FrozenInstanceError):
        t.execute = T0  # type: ignore[misc]
    assert roundtrip(t) == t
    assert [f.name for f in dataclasses.fields(SessionTimes)] == [
        "session",
        "reset_at",
        "open_print",
        "execute",
        "close_print",
    ]
