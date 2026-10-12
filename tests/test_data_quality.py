"""Data-quality checks: each planted problem is caught, and a clean series raises nothing."""

from __future__ import annotations

import math
from dataclasses import replace
from datetime import UTC, date, datetime, time, timedelta

import pytest

from samsulek.data.bars import DailyBar
from samsulek.data.quality import QualityLimits, check_bars, check_calendar, check_fresh, errors


class WeekdayCalendar:
    """Mon-Fri, minus listed holidays; closes 15:30 UTC. A stand-in for a real exchange calendar."""

    name = "TEST"
    tz = "UTC"

    def __init__(self, holidays: set[date] | None = None) -> None:
        self.holidays = holidays or set()

    def is_session(self, day: date) -> bool:
        return day.weekday() < 5 and day not in self.holidays

    def sessions(self, start: date, end: date) -> list[date]:
        out, d = [], start
        while d <= end:
            if self.is_session(d):
                out.append(d)
            d += timedelta(days=1)
        return out

    def close_utc(self, day: date) -> datetime:
        return datetime.combine(day, time(15, 30), tzinfo=UTC)


CAL = WeekdayCalendar({date(2026, 10, 5)})  # a Monday holiday
START = date(2026, 9, 1)


def series(closes: list[float], start: date = START, cal: WeekdayCalendar = CAL) -> list[DailyBar]:
    days = cal.sessions(start, start + timedelta(days=len(closes) * 2 + 10))[: len(closes)]
    return [
        DailyBar("ETF", d, cal.close_utc(d), c * 0.995, c * 1.01, c * 0.99, c, 1000.0, "EUR", "test")
        for d, c in zip(days, closes, strict=True)
    ]


def codes(issues: list[object]) -> list[str]:
    return [i.code for i in issues]  # type: ignore[attr-defined]


def walk(n: int, start: float = 100.0) -> list[float]:
    out, px = [], start
    for i in range(n):
        px *= 1.004 if i % 3 else 0.995
        out.append(round(px, 4))
    return out


def test_a_clean_series_has_no_issues() -> None:
    bars = series(walk(40))
    assert check_bars(bars) == []
    assert check_calendar(bars, CAL) == []


def test_bad_prices_volume_and_ohlc() -> None:
    bars = series(walk(10))
    bars[2] = replace(bars[2], close=0.0)
    bars[3] = replace(bars[3], high=math.nan)
    bars[4] = replace(bars[4], volume=-5.0)
    bars[5] = replace(bars[5], high=bars[5].close * 0.9)  # high below close
    bars[6] = replace(bars[6], low=bars[6].close * 1.1)  # low above close
    found = codes(check_bars(bars))
    assert found.count("bad_price") == 2
    assert "bad_volume" in found
    assert found.count("ohlc_inconsistent") == 2
    assert all(i.severity == "error" for i in check_bars(bars))


def test_duplicates_order_and_mixing() -> None:
    bars = series(walk(6))
    dup = [*bars, bars[-1]]
    assert "duplicate_session" in codes(check_bars(dup))
    swapped = [bars[1], bars[0], *bars[2:]]
    assert "out_of_order" in codes(check_bars(swapped))
    mixed = [*bars[:3], replace(bars[3], currency="USD"), *bars[4:]]
    assert "mixed_currency" in codes(check_bars(mixed))
    other = [*bars[:3], replace(bars[3], symbol="OTHER"), *bars[4:]]
    assert "mixed_symbols" in codes(check_bars(other))


def test_spike_that_snaps_back_is_an_error_but_a_real_crash_is_a_warning() -> None:
    closes = walk(20)
    spiked = closes.copy()
    spiked[10] = closes[10] * 1.5  # +50% then back: bad print
    issues = check_bars(series(spiked))
    assert codes(issues) == ["spike_reversal"]
    assert issues[0].severity == "error"
    crash = closes[:10] + [c * 0.8 for c in closes[10:]]  # -20% and stays down: real
    issues = check_bars(series(crash))
    assert codes(issues) == ["large_move"]
    assert issues[0].severity == "warning"
    # A tighter limit for calmer assets (e.g. a bond ETF) flags smaller moves.
    small = closes[:10] + [c * 0.93 for c in closes[10:]]
    assert check_bars(series(small)) == []
    assert codes(check_bars(series(small), QualityLimits(max_abs_daily_return=0.05))) == ["large_move"]


def test_stale_runs_need_unchanged_close_and_no_volume() -> None:
    closes = walk(10) + [101.0] * 6 + walk(5, 101.0)
    bars = series(closes)
    for i in range(10, 16):
        bars[i] = replace(bars[i], volume=0.0)
    found = check_bars(bars)
    assert codes(found) == ["stale_run"]
    assert found[0].session == bars[10].session
    traded = series(closes)  # same closes but with volume: a quiet market, not stale data
    assert check_bars(traded) == []


def test_missing_sessions_and_bars_on_holidays() -> None:
    bars = series(walk(30))
    gap1 = [b for i, b in enumerate(bars) if i != 7]
    found = check_calendar(gap1, CAL)
    assert codes(found) == ["missing_sessions"]
    assert found[0].severity == "warning"
    gap3 = [b for i, b in enumerate(bars) if i not in (7, 8, 9)]
    assert errors(check_calendar(gap3, CAL))[0].code == "missing_sessions"
    holiday_bar = replace(bars[3], session=date(2026, 10, 5), close_ts=CAL.close_utc(date(2026, 10, 5)))
    weird = sorted([*bars[:3], holiday_bar], key=lambda b: b.session)
    assert "unexpected_session" in codes(check_calendar(weird, CAL))


def test_freshness_and_future_bars() -> None:
    bars = series(walk(30))
    last = bars[-1]
    delay = timedelta(hours=2)
    just_before_due = CAL.close_utc(last.session) + delay - timedelta(minutes=1)
    assert check_fresh(bars[:-1], CAL, just_before_due, delay, "ETF") == []
    due = CAL.close_utc(last.session) + delay
    stale = check_fresh(bars[:-1], CAL, due, delay, "ETF")
    assert codes(stale) == ["stale_series"]
    assert check_fresh(bars, CAL, due, delay, "ETF") == []
    future = check_fresh(bars, CAL, last.close_ts - timedelta(hours=1), delay, "ETF")
    assert "future_bar" in codes(future)
    assert codes(check_fresh([], CAL, due, delay, "ETF")) == ["no_data"]
    with pytest.raises(ValueError, match="timezone"):
        check_fresh(bars, CAL, datetime(2026, 10, 1, 12, 0), delay, "ETF")  # noqa: DTZ001
