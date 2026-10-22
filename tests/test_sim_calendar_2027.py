"""The feed declares its calendar (spec C2, P7): the sim bot keeps working in 2027 and later.

Synthetic bars exist for every calendar day, so ``SyntheticFeed`` declares
``EveryDayCalendar`` and the freshness rule never trips on it, in any year. A feed that
declares the Xetra calendar halts from 2027-01-01 (``CalendarRangeError``) until the owner
checks next year's holidays and raises ``CHECKED_THROUGH_YEAR``. Every other stock feed in
src declares ``XetraCalendar`` (the hook for paper and live trading in M5).
"""

from __future__ import annotations

import ast
import shutil
from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from samsulek import cli
from samsulek.app import App, build_app
from samsulek.clock import FixedClock, SystemClock
from samsulek.cycle import DATA_PUBLISH_DELAY, live_cycle_spec, run_cycle
from samsulek.data.bars import TradingCalendar
from samsulek.data.calendars import XetraCalendar
from samsulek.data.freshness import expected_session, stale_bars_problem
from samsulek.data.synthetic import EveryDayCalendar, SyntheticFeed
from samsulek.types import Bar, Market, Quote

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src" / "samsulek"
IN_2027 = datetime(2027, 1, 5, 8, 0, tzinfo=UTC)
SYMBOLS = ["DEMO_EQUITY", "DEMO_BONDS"]


@pytest.fixture
def root(tmp_path: Path) -> Path:
    shutil.copytree(ROOT / "config", tmp_path / "config")
    shutil.copytree(ROOT / "ops", tmp_path / "ops")
    return tmp_path


class XetraDeclaredFeed:
    """The synthetic bars and quotes, declaring the Xetra calendar like a real stock feed."""

    def __init__(self, inner: SyntheticFeed) -> None:
        self._inner = inner
        self._calendar = XetraCalendar()

    @property
    def calendar(self) -> TradingCalendar:
        return self._calendar

    def bars_until(self, asof: datetime) -> Mapping[str, Sequence[Bar]]:
        return self._inner.bars_until(asof)

    def quote(self, symbol: str) -> Quote | None:
        return self._inner.quote(symbol)


def test_samsulek_run_returns_ok_in_2027(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(SystemClock, "now", lambda self: IN_2027)
    monkeypatch.setattr(cli, "load_env_file", lambda *a, **kw: None)
    assert cli.main(["--root", str(root), "run"]) == cli.EXIT_OK
    assert cli.main(["--root", str(root), "run"]) == cli.EXIT_OK, "a second run the same morning too"


@settings(max_examples=60)
@given(
    now=st.datetimes(
        min_value=datetime(2020, 1, 2),  # noqa: DTZ001 (hypothesis wants naive bounds)
        max_value=datetime(2035, 12, 31, 23, 59),  # noqa: DTZ001
        timezones=st.just(UTC),
    )
)
def test_the_synthetic_feed_never_trips_the_freshness_rule(now: datetime) -> None:
    feed = SyntheticFeed(SYMBOLS, Market.STOCKS, FixedClock(now))
    bars = feed.bars_until(now)
    assert stale_bars_problem(bars, SYMBOLS, now, feed.calendar, DATA_PUBLISH_DELAY) is None


def test_a_xetra_declared_feed_halts_in_2027(root: Path) -> None:
    app = build_app(root, Path("config/default.yaml"), clock=FixedClock(IN_2027))
    app.feed = XetraDeclaredFeed(app.feed)  # type: ignore[assignment]
    report = run_cycle(app)
    assert report.status == "halted" and report.orders_sent == 0
    assert report.messages[0].startswith("Stale or missing data: CalendarRangeError: ")
    assert "raise CHECKED_THROUGH_YEAR" in report.messages[0], "the message says what to do"
    assert app.store.read_halt().active


def test_the_same_xetra_declared_feed_trades_in_2026(root: Path) -> None:
    """The halt above comes from the calendar's range, not from the feed's bars."""
    app = build_app(
        root, Path("config/default.yaml"), clock=FixedClock(datetime(2026, 10, 13, 7, 5, tzinfo=UTC))
    )
    app.feed = XetraDeclaredFeed(app.feed)  # type: ignore[assignment]
    assert run_cycle(app).ok


def test_the_bots_spec_uses_the_feeds_calendar(root: Path) -> None:
    app: App = build_app(root, Path("config/default.yaml"), clock=FixedClock(IN_2027))
    assert live_cycle_spec(app).calendar is app.feed.calendar
    assert isinstance(app.feed.calendar, EveryDayCalendar)
    app.feed = XetraDeclaredFeed(app.feed)  # type: ignore[assignment]
    assert live_cycle_spec(app).calendar is app.feed.calendar


# ------------------------------------------------------------------- EveryDayCalendar
@given(day=st.dates())
def test_every_day_is_a_session_closing_at_15_30_utc(day: date) -> None:
    cal = EveryDayCalendar()
    assert cal.is_session(day)
    assert cal.close_utc(day) == datetime.combine(day, time(15, 30), tzinfo=UTC)
    assert cal.sessions(day, day) == [day]


def test_every_day_calendar_sessions_and_names() -> None:
    cal = EveryDayCalendar()
    assert (cal.name, cal.tz) == ("SYNTHETIC-DAILY", "UTC")
    start = date(2026, 12, 28)
    assert cal.sessions(start, date(2027, 1, 3)) == [start + timedelta(days=i) for i in range(7)]
    assert cal.sessions(date(2027, 1, 3), start) == []
    assert expected_session(cal, IN_2027, DATA_PUBLISH_DELAY) == date(2027, 1, 4)


def test_the_synthetic_feed_shares_one_calendar_and_its_bars_follow_it() -> None:
    a = SyntheticFeed(SYMBOLS, Market.STOCKS, FixedClock(IN_2027))
    b = SyntheticFeed(["X"], Market.STOCKS, FixedClock(IN_2027), seed=3)
    assert a.calendar is b.calendar
    for series in a.bars_until(IN_2027).values():
        for bar in series[-40:]:
            assert bar.close_ts == a.calendar.close_utc(bar.close_ts.date())


def test_a_wrong_calendar_fails_closed() -> None:
    """Weekday-only bars judged by EveryDayCalendar: on a Monday the Sunday bar is due and missing."""
    monday = datetime(2026, 10, 19, 7, 5, tzinfo=UTC)
    xetra = XetraCalendar()
    friday = xetra.close_utc(date(2026, 10, 16))
    bars = {"AAA": [Bar("AAA", friday, 1.0, 1.0, 1.0, 1.0, 1.0)]}
    assert stale_bars_problem(bars, ["AAA"], monday, xetra, DATA_PUBLISH_DELAY) is None
    assert stale_bars_problem(bars, ["AAA"], monday, EveryDayCalendar(), DATA_PUBLISH_DELAY) == (
        "latest AAA bar is from 2026-10-16; the 2026-10-18 close is due by now"
    )


# ------------------------------------------------------------------- every other stock feed is Xetra
def _feed_classes() -> dict[str, str | None]:
    """Every concrete class in src with a ``bars_until`` method -> its ``calendar`` return annotation."""
    found: dict[str, str | None] = {}
    for path in sorted(SRC.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.ClassDef):
                continue
            if any(ast.unparse(b).endswith("Protocol") for b in node.bases):
                continue  # an interface, not a feed
            methods = {n.name: n for n in node.body if isinstance(n, ast.FunctionDef)}
            if "bars_until" not in methods:
                continue
            calendar = methods.get("calendar")
            is_property = calendar is not None and any(
                ast.unparse(d) == "property" for d in calendar.decorator_list
            )
            annotation = (
                ast.unparse(calendar.returns) if calendar and calendar.returns and is_property else None
            )
            found[f"{path.relative_to(SRC).as_posix()}:{node.name}"] = annotation
    return found


def test_every_stock_feed_but_the_synthetic_one_declares_xetra() -> None:
    feeds = _feed_classes()
    assert feeds.pop("data/synthetic.py:SyntheticFeed") == "EveryDayCalendar"
    assert feeds, "the backtest feed at least"
    assert "backtest/feed.py:BacktestFeed" in feeds
    assert {name: ann for name, ann in feeds.items() if ann != "XetraCalendar"} == {}
