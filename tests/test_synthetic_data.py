"""The synthetic Xetra-session generator and its plant_* helpers (trap 13).

The generator must make the bugs M1's synthetic feed hid visible: every bar has
``open != close`` and an overnight gap, on the real Xetra calendar.
"""

from __future__ import annotations

import hashlib
import math
import os
import random
import subprocess
import sys
from datetime import UTC, date, datetime, timedelta
from itertools import pairwise
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from samsulek.backtest import synthetic_data
from samsulek.backtest.synthetic_data import (
    plant_coin_gaps,
    plant_spike,
    plant_split,
    synthetic_daily_bars,
)
from samsulek.data.bars import DailyBar
from samsulek.data.calendars import XetraCalendar
from samsulek.data.quality import check_bars, check_calendar, errors

CAL = XetraCalendar()
BERLIN = ZoneInfo("Europe/Berlin")


def fixture_problems(bars: list[DailyBar], min_gap: float = 1e-4) -> list[str]:
    """The fixture check of trap 13: a series where a same-bar fill or a close-as-open bug
    would go unnoticed is flagged."""
    out: list[str] = []
    previous: list[DailyBar | None] = [None, *bars[:-1]] if bars else []
    for prev, bar in zip(previous, bars, strict=True):
        if bar.open is None or bar.open == bar.close:
            out.append(f"{bar.session}: open == close")
        if prev is not None and bar.open is not None and abs(bar.open / prev.close - 1) < min_gap:
            out.append(f"{bar.session}: no overnight gap")
    return out


def m1_shaped(bars: list[DailyBar]) -> list[DailyBar]:
    """M1's synthetic feed: open = close (and the next open = this close)."""
    out = []
    for b in bars:
        out.append(
            DailyBar(
                b.symbol, b.session, b.close_ts, b.close, b.close, b.close, b.close, b.volume, "EUR", "m1"
            )
        )
    return out


# -------------------------------------------------------------------- shape
@settings(max_examples=60, deadline=None)
@given(
    seed=st.integers(min_value=0, max_value=2**40),
    start=st.dates(min_value=date(2004, 1, 1), max_value=date(2026, 6, 1)),
    length=st.integers(min_value=1, max_value=400),
    vol=st.sampled_from([0.0, 0.001, 0.01, 0.05, 0.4]),
)
def test_every_bar_has_a_gap_and_a_move_and_consistent_positive_ohlc(
    seed: int, start: date, length: int, vol: float
) -> None:
    last = min(start + timedelta(days=length), date(2026, 12, 31))
    series = synthetic_daily_bars(["X", "Y"], CAL, start, last, seed=seed, vol=vol, gap_vol=vol / 2)
    for bars in series.values():
        assert fixture_problems(bars) == []
        for b in bars:
            assert b.open is not None and b.high is not None and b.low is not None
            assert all(math.isfinite(x) and x > 0 for x in (b.open, b.high, b.low, b.close))
            assert b.low <= min(b.open, b.close) <= max(b.open, b.close) <= b.high
            assert b.open != b.close
            assert b.close_ts == CAL.close_utc(b.session)
            assert b.currency == "EUR" and b.source == "synthetic"
        for prev, cur in pairwise(bars):
            assert cur.open != prev.close
            assert abs(cur.open / prev.close - 1) >= 1e-4  # type: ignore[operator]


def test_one_bar_per_real_xetra_session() -> None:
    first, last = date(2023, 12, 1), date(2025, 1, 10)
    bars = synthetic_daily_bars(["X"], CAL, first, last, seed=1)["X"]
    sessions = [b.session for b in bars]
    assert sessions == CAL.sessions(first, last)
    have = set(sessions)
    # Closed days: Good Friday, Easter Monday, 1 May, 24-26 Dec, 31 Dec, 1 Jan, weekends.
    for closed in (
        date(2024, 3, 29),
        date(2024, 4, 1),
        date(2024, 5, 1),
        date(2024, 12, 24),
        date(2024, 12, 25),
        date(2024, 12, 26),
        date(2024, 12, 31),
        date(2025, 1, 1),
        date(2024, 6, 8),
    ):
        assert closed not in have, closed
    by_day = {b.session: b for b in bars}
    # DST: 17:40 Berlin is 16:40 UTC in winter and 15:40 UTC in summer; 14:10 on the early close.
    assert by_day[date(2024, 3, 28)].close_ts == datetime(2024, 3, 28, 16, 40, tzinfo=UTC)
    assert by_day[date(2024, 4, 2)].close_ts == datetime(2024, 4, 2, 15, 40, tzinfo=UTC)
    assert by_day[date(2024, 10, 25)].close_ts == datetime(2024, 10, 25, 15, 40, tzinfo=UTC)
    assert by_day[date(2024, 10, 28)].close_ts == datetime(2024, 10, 28, 16, 40, tzinfo=UTC)
    assert by_day[date(2024, 12, 30)].close_ts == datetime(2024, 12, 30, 13, 10, tzinfo=UTC)
    assert by_day[date(2024, 12, 30)].close_ts.astimezone(BERLIN).time().hour == 14


def test_the_series_passes_the_quality_checks() -> None:
    bars = synthetic_daily_bars(["X", "Y", "Z"], CAL, date(2016, 1, 4), date(2024, 9, 30), seed=7)
    for series in bars.values():
        assert errors(check_bars(series)) == []
        assert errors(check_calendar(series, CAL)) == []


def test_a_planted_m1_shaped_series_is_flagged_by_the_fixture_check() -> None:
    bars = synthetic_daily_bars(["X"], CAL, date(2024, 1, 2), date(2024, 3, 1), seed=1)["X"]
    flagged = fixture_problems(m1_shaped(bars))
    assert flagged == [f"{b.session}: open == close" for b in bars]  # every bar
    # A series that opens at the previous close (no overnight gap) is flagged too.
    gapless = [bars[0]] + [
        DailyBar(b.symbol, b.session, b.close_ts, p.close, b.high, b.low, b.close, b.volume, "EUR", "x")
        for p, b in pairwise(bars)
    ]
    assert fixture_problems(gapless) == [f"{b.session}: no overnight gap" for b in bars[1:]]


def test_bad_settings_are_refused() -> None:
    first, last = date(2024, 1, 2), date(2024, 2, 1)
    with pytest.raises(ValueError, match="start_price"):
        synthetic_daily_bars(["X"], CAL, first, last, seed=1, start_price=0.0)
    with pytest.raises(ValueError, match="min_gap"):
        synthetic_daily_bars(["X"], CAL, first, last, seed=1, min_gap=0.0)
    with pytest.raises(ValueError, match="unique"):
        synthetic_daily_bars(["X", "X"], CAL, first, last, seed=1)
    with pytest.raises(ValueError, match="2027"):  # the calendar refuses unchecked years
        synthetic_daily_bars(["X"], CAL, date(2027, 1, 4), date(2027, 2, 1), seed=1)


# -------------------------------------------------------------- determinism
def digest(series: dict[str, list[DailyBar]]) -> str:
    return hashlib.sha256(
        repr(sorted((k, [repr(b) for b in v]) for k, v in series.items())).encode()
    ).hexdigest()


def test_same_seed_same_series_other_seed_other_series() -> None:
    a = synthetic_daily_bars(["X", "Y"], CAL, date(2020, 1, 2), date(2020, 12, 30), seed=5)
    b = synthetic_daily_bars(["X", "Y"], CAL, date(2020, 1, 2), date(2020, 12, 30), seed=5)
    c = synthetic_daily_bars(["X", "Y"], CAL, date(2020, 1, 2), date(2020, 12, 30), seed=6)
    assert a == b
    assert a["X"] != c["X"] and a["Y"] != c["Y"]
    assert a["X"][0].close != a["Y"][0].close  # symbols are independent walks


def test_each_walk_is_seeded_by_the_documented_sha256_formula(monkeypatch: pytest.MonkeyPatch) -> None:
    seeds: list[int] = []

    class Recording(random.Random):
        def __init__(self, x: int) -> None:
            seeds.append(x)
            super().__init__(x)

    monkeypatch.setattr(synthetic_data, "random", SimpleNamespace(Random=Recording))
    bars = synthetic_daily_bars(["X", "Y"], CAL, date(2024, 1, 2), date(2024, 1, 10), seed=5)
    assert seeds == [
        int.from_bytes(hashlib.sha256(f"5:{s}".encode()).digest()[:8], "big") for s in ("X", "Y")
    ]
    monkeypatch.undo()
    assert synthetic_daily_bars(["X", "Y"], CAL, date(2024, 1, 2), date(2024, 1, 10), seed=5) == bars


def test_a_symbol_does_not_depend_on_the_others_and_longer_extends_shorter() -> None:
    alone = synthetic_daily_bars(["X"], CAL, date(2020, 1, 2), date(2020, 6, 30), seed=5)["X"]
    with_others = synthetic_daily_bars(["A", "X", "B"], CAL, date(2020, 1, 2), date(2020, 12, 30), seed=5)[
        "X"
    ]
    assert with_others[: len(alone)] == alone


def test_the_series_is_the_same_in_another_process_with_another_hash_seed() -> None:
    code = (
        "import hashlib\n"
        "from datetime import date\n"
        "from samsulek.backtest.synthetic_data import synthetic_daily_bars\n"
        "from samsulek.data.calendars import XetraCalendar\n"
        "cal = XetraCalendar()\n"
        "s = synthetic_daily_bars(['X', 'Y'], cal, date(2021, 1, 4), date(2021, 3, 1), seed=9)\n"
        "text = repr(sorted((k, [repr(b) for b in v]) for k, v in s.items()))\n"
        "print(hashlib.sha256(text.encode()).hexdigest())\n"
    )
    here = digest(synthetic_daily_bars(["X", "Y"], CAL, date(2021, 1, 4), date(2021, 3, 1), seed=9))
    for hash_seed in ("0", "12345"):
        out = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True,
            text=True,
            check=True,
            env={**os.environ, "PYTHONHASHSEED": hash_seed},
            timeout=60,
        )
        assert out.stdout.strip() == here


# ------------------------------------------------------------------- plants
BARS = synthetic_daily_bars(["S"], CAL, date(2023, 1, 2), date(2023, 6, 30), seed=3)["S"]
KNOWN = datetime(2023, 3, 1, 12, 0, tzinfo=UTC)


def test_plant_split_divides_raw_prices_from_the_ex_session_on() -> None:
    ex = date(2023, 3, 15)
    original = list(BARS)
    split, action = plant_split(BARS, ex, 4.0, KNOWN)
    assert original == BARS  # the input is not changed
    assert action.symbol == "S" and action.ex_session == ex and action.kind == "split"
    assert action.price_factor == 0.25
    assert action.known_at == KNOWN
    for before, after in zip(BARS, split, strict=True):
        if before.session < ex:
            assert after == before
        else:
            assert after.close == before.close / 4 and after.open == before.open / 4  # type: ignore[operator]
            assert after.volume == before.volume * 4  # type: ignore[operator]
            assert after.close_ts == before.close_ts
    with pytest.raises(ValueError, match="ratio"):
        plant_split(BARS, ex, 1.0, KNOWN)
    with pytest.raises(ValueError, match="no bar"):
        plant_split(BARS, date(2023, 3, 18), 2.0, KNOWN)  # a Saturday
    with pytest.raises(ValueError, match="timezone"):
        plant_split(BARS, ex, 2.0, datetime(2023, 3, 1))  # noqa: DTZ001


def test_plant_spike_is_one_bad_close_that_the_quality_check_flags() -> None:
    day = date(2023, 4, 12)
    spiked = plant_spike(BARS, day, 0.4)
    changed = [(a, b) for a, b in zip(BARS, spiked, strict=True) if a != b]
    assert len(changed) == 1
    before, after = changed[0]
    assert after.session == day and after.close == before.close * 1.4
    assert after.high == after.close and after.open == before.open
    issues = errors(check_bars(spiked))
    assert [(i.code, i.session) for i in issues] == [("spike_reversal", day)]
    down = plant_spike(BARS, day, -0.4)
    assert [(i.code, i.session) for i in errors(check_bars(down))] == [("spike_reversal", day)]
    with pytest.raises(ValueError, match="jump"):
        plant_spike(BARS, day, -1.0)


def test_plant_coin_gaps_makes_the_pattern_only_a_same_bar_fill_can_use() -> None:
    coined = plant_coin_gaps(BARS, seed=4)
    assert [b.session for b in coined] == [b.session for b in BARS]
    assert [b.close_ts for b in coined] == [b.close_ts for b in BARS]
    assert coined[0].open == BARS[0].open
    signs = []
    for prev, cur in pairwise(coined):
        assert prev.open is not None and cur.open is not None
        coin = 1 if prev.close > prev.open else -1
        assert prev.close == pytest.approx(prev.open * (1 + 0.01 * coin), rel=1e-12)
        assert cur.open == pytest.approx(
            prev.close * (1 + 0.02 * coin), rel=1e-12
        )  # the gap follows the move
        signs.append(coin)
    assert 0.35 < signs.count(1) / len(signs) < 0.65  # a fair coin
    assert plant_coin_gaps(BARS, seed=4) == coined
    assert plant_coin_gaps(BARS, seed=5) != coined
    assert fixture_problems(coined) == []
    assert all(b.low <= min(b.open, b.close) and b.high >= max(b.open, b.close) for b in coined)  # type: ignore[operator,type-var]
    assert plant_coin_gaps([], seed=1) == []
