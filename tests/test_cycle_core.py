"""The shared cycle core and its two shells (owner decision Q4, spec P5).

``run_cycle`` (the bot: blocked check, run lock, core) and ``run_unlocked_cycle`` (the
backtest's in-memory parts: blocked check, core) call the very same ``run_cycle_core``
once per cycle and give identical results, also on the blocked, error and stale-data
paths. The lock-free shell refuses the bot's ``App`` and anything not marked in-memory.
The strategy gets tuples, so it can't change what the feed holds (trap 4, live side).
"""

from __future__ import annotations

import ast
import shutil
from collections.abc import Callable, Mapping, Sequence
from dataclasses import replace
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from helpers import T0
from samsulek import cycle
from samsulek.app import App, build_app
from samsulek.clock import FixedClock
from samsulek.cycle import (
    DATA_PUBLISH_DELAY,
    CycleReport,
    CycleSpec,
    live_cycle_spec,
    run_cycle,
    run_unlocked_cycle,
)
from samsulek.data.bars import TradingCalendar
from samsulek.data.calendars import XetraCalendar
from samsulek.data.synthetic import SyntheticFeed
from samsulek.quotes import collect_quotes
from samsulek.risk.sizing import plan_orders
from samsulek.risk.state import StateCorruptError
from samsulek.runlock import AlreadyRunningError, RunLock
from samsulek.strategies.base import StrategyContext
from samsulek.types import Bar, Market, Mode, OrderRequest, Quote, TargetWeights

ROOT = Path(__file__).resolve().parents[1]
CONFIG = Path("config/default.yaml")
CYCLE_SOURCE = Path(cycle.__file__)


def project(base: Path) -> Path:
    shutil.copytree(ROOT / "config", base / "config")
    shutil.copytree(ROOT / "ops", base / "ops")
    return base


@pytest.fixture
def roots(tmp_path: Path) -> tuple[Path, Path]:
    return project(tmp_path / "locked"), project(tmp_path / "unlocked")


def app_at(root: Path, clock: FixedClock) -> App:
    return build_app(root, CONFIG, clock=clock)


class UnlockedParts:
    """Test stand-in for the backtest's in-memory parts: an App's own parts, marked ``in_memory``.

    Reads go to the App at call time, so a patch on the App applies to both shells alike.
    """

    in_memory = True
    _PARTS = frozenset(
        {"mode", "clock", "broker", "ledger", "engine", "router", "log", "alerter", "risk_config", "feed"}
    )

    def __init__(self, app: App) -> None:
        self.app = app

    def __getattr__(self, name: str) -> Any:
        if name in self._PARTS:
            return getattr(self.app, name)
        raise AttributeError(name)

    def quotes_for(self, symbols: set[str]) -> dict[str, Quote]:
        return self.app.quotes_for(symbols)


class DeclaredFeed:
    """The synthetic feed's bars and quotes, declaring another calendar."""

    def __init__(self, inner: SyntheticFeed, calendar: TradingCalendar) -> None:
        self._inner = inner
        self._calendar = calendar

    @property
    def calendar(self) -> TradingCalendar:
        return self._calendar

    def bars_until(self, asof: datetime) -> Mapping[str, Sequence[Bar]]:
        return self._inner.bars_until(asof)

    def quote(self, symbol: str) -> Quote | None:
        return self._inner.quote(symbol)


class BrokenCalendar:
    """A calendar that fails: with a ValueError (judged as data) or another error (a bug)."""

    name = "BROKEN"
    tz = "UTC"

    def __init__(self, exc: Exception) -> None:
        self._exc = exc

    def is_session(self, day: date) -> bool:
        raise self._exc

    def sessions(self, start: date, end: date) -> list[date]:
        raise self._exc

    def close_utc(self, day: date) -> datetime:
        raise self._exc


class Recording:
    name = "recording_test"

    def __init__(self) -> None:
        self.seen: list[dict[str, Sequence[Bar]]] = []

    def target_weights(self, ctx: StrategyContext) -> TargetWeights:
        self.seen.append(dict(ctx.bars))
        return TargetWeights({}, "records what it sees, holds nothing")


class Broken:
    name = "broken_test"

    def target_weights(self, ctx: StrategyContext) -> TargetWeights:
        raise RuntimeError("strategy bug")


class Mutating:
    name = "mutating_test"

    def target_weights(self, ctx: StrategyContext) -> TargetWeights:
        for series in ctx.bars.values():
            series.append(series[-1])  # type: ignore[attr-defined]
        return TargetWeights({}, "tried to change the feed's bars")


@pytest.fixture
def core_calls(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """A spy on ``cycle.run_cycle_core``: the type of the parts of every call."""
    calls: list[str] = []
    real = cycle.run_cycle_core

    def spy(parts: cycle.CycleParts, spec: CycleSpec, report: CycleReport) -> CycleReport:
        calls.append(type(parts).__name__)
        return real(parts, spec, report)

    monkeypatch.setattr(cycle, "run_cycle_core", spy)
    return calls


# ------------------------------------------------------------------- one core, two shells
def test_each_shell_calls_the_core_once(roots: tuple[Path, Path], core_calls: list[str]) -> None:
    clock = FixedClock(T0)
    assert run_cycle(app_at(roots[0], clock)).ok
    assert core_calls == ["App"]
    parts = UnlockedParts(app_at(roots[1], clock))
    assert run_unlocked_cycle(parts, live_cycle_spec(parts.app)).ok
    assert core_calls == ["App", "UnlockedParts"]


def _plant_halt(app: App) -> None:
    app.store.set_halt("planted halt", T0)


def _plant_broken_strategy(app: App) -> None:
    app.strategy = Broken()  # type: ignore[assignment]


def _plant_calendar(calendar: TradingCalendar) -> Callable[[App], None]:
    def plant(app: App) -> None:
        app.feed = DeclaredFeed(app.feed, calendar)  # type: ignore[assignment]

    return plant


CASES: dict[str, tuple[Callable[[App], None], str, str, bool]] = {
    # name: (plant, status, first message starts with, core called)
    "done": (lambda app: None, "done", "", True),
    "blocked": (_plant_halt, "blocked", "trading is HALTED: planted halt", False),
    "strategy_error": (_plant_broken_strategy, "error", "RuntimeError: strategy bug", True),
    "calendar_range": (
        _plant_calendar(XetraCalendar(checked_through_year=2025)),
        "halted",
        "Stale or missing data: CalendarRangeError: XETR calendar is only checked for 2004-2025, not 2026.",
        True,
    ),
    "calendar_value_error": (
        _plant_calendar(BrokenCalendar(ValueError("no such day"))),
        "halted",
        "Stale or missing data: ValueError: no such day",
        True,
    ),
    "calendar_bug": (
        _plant_calendar(BrokenCalendar(RuntimeError("calendar bug"))),
        "error",
        "RuntimeError: calendar bug",
        True,
    ),
}


@pytest.mark.parametrize("case", sorted(CASES))
def test_both_shells_give_the_same_result(roots: tuple[Path, Path], core_calls: list[str], case: str) -> None:
    plant, status, message, core_called = CASES[case]
    clock = FixedClock(T0)
    outcomes = []
    for root, unlocked in zip(roots, (False, True), strict=True):
        app = app_at(root, clock)
        plant(app)
        report = run_unlocked_cycle(UnlockedParts(app), live_cycle_spec(app)) if unlocked else run_cycle(app)
        outcomes.append(
            (
                report,
                app.log.read_day(T0.date()),
                list(app.alerter.sent),
                app.store.read_halt(),
                app.broker.account(),
            )
        )
    assert outcomes[0] == outcomes[1]
    report = outcomes[0][0]
    assert report.status == status, report.messages
    if message:
        assert report.messages[0].startswith(message), report.messages
    assert outcomes[0][3].active is (status != "done")
    assert core_calls == (["App", "UnlockedParts"] if core_called else [])
    kinds = [r["kind"] for r in outcomes[0][1]]
    assert kinds[0] == "cycle_start"
    assert kinds[-1] == "cycle_end" or status == "error"


@pytest.mark.parametrize("unlocked", [False, True], ids=["run_cycle", "run_unlocked_cycle"])
def test_unreadable_risk_state_blocks_and_alerts_in_both_shells(
    roots: tuple[Path, Path], core_calls: list[str], unlocked: bool
) -> None:
    app = app_at(roots[int(unlocked)], FixedClock(T0))

    def damaged() -> object:
        raise StateCorruptError("halt file is damaged")

    app.store.read_halt = damaged  # type: ignore[method-assign,assignment]
    report = run_unlocked_cycle(UnlockedParts(app), live_cycle_spec(app)) if unlocked else run_cycle(app)
    assert report.status == "blocked" and report.orders_sent == 0
    assert report.messages == [
        "risk state unreadable (StateCorruptError: halt file is damaged); failing closed"
    ]
    assert ("critical", "Risk state unreadable: trading blocked", report.messages[0]) in app.alerter.sent
    assert core_calls == []


def test_a_planted_calendar_error_halts_with_the_staleness_title(roots: tuple[Path, Path]) -> None:
    clock = FixedClock(T0)
    app = app_at(roots[0], clock)
    _plant_calendar(XetraCalendar(checked_through_year=2025))(app)
    report = run_cycle(app)
    assert report.status == "halted" and report.orders_sent == 0
    halt = app.store.read_halt()
    assert halt.active and halt.reasons[0].startswith("Stale or missing data: CalendarRangeError: ")
    assert any(title == "Stale or missing data: trading HALTED" for _, title, _ in app.alerter.sent)


# ------------------------------------------------------------------- the lock-free shell refuses the bot
class NotMarked(UnlockedParts):
    in_memory = False


class Truthy(UnlockedParts):
    in_memory = 1  # type: ignore[assignment]


class MarkedApp(App):
    in_memory = True


@pytest.mark.parametrize("kind", ["app", "app_subclass", "not_marked", "truthy_mark", "no_mark"])
def test_the_lock_free_shell_refuses_the_bot(
    roots: tuple[Path, Path], core_calls: list[str], kind: str
) -> None:
    clock = FixedClock(T0)
    app = app_at(roots[0], clock)
    parts: object
    if kind == "app":
        parts = app
    elif kind == "app_subclass":
        parts = MarkedApp(**{f: getattr(app, f) for f in App.__dataclass_fields__})
    elif kind == "not_marked":
        parts = NotMarked(app)
    elif kind == "truthy_mark":
        parts = Truthy(app)
    else:
        parts = object()
    with pytest.raises(TypeError, match="in-memory backtest parts only"):
        run_unlocked_cycle(parts, live_cycle_spec(app))  # type: ignore[arg-type]
    assert core_calls == []
    assert app.log.read_day(T0.date()) == [], "refused before anything was written"
    assert not app.store.read_halt().active


# ------------------------------------------------------------------- order of the bot's shell
def _function(name: str) -> ast.FunctionDef:
    """The top-level function ``name`` of cycle.py, without its docstring."""
    tree = ast.parse(CYCLE_SOURCE.read_text(encoding="utf-8"))
    found = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name]
    assert len(found) == 1, name
    fn = found[0]
    fn.body = [n for n in fn.body if not (isinstance(n, ast.Expr) and isinstance(n.value, ast.Constant))]
    return fn


def _calls(node: ast.AST) -> list[tuple[int, int, str]]:
    out = []
    for n in ast.walk(node):
        if isinstance(n, ast.Call):
            func = n.func
            name = (
                func.id
                if isinstance(func, ast.Name)
                else func.attr
                if isinstance(func, ast.Attribute)
                else ""
            )
            out.append((n.lineno, n.col_offset, name))
    return sorted(out)


def test_run_cycle_checks_blocked_then_locks_then_builds_the_spec_inside_the_lock() -> None:
    fn = _function("run_cycle")
    names = [name for _, _, name in _calls(fn)]
    assert names.index("_blocked") < names.index("RunLock") < names.index("run_cycle_core")
    assert names.count("run_cycle_core") == 1
    # Everything after the report is inside one try whose catch-all halts.
    assert isinstance(fn.body[0], ast.Assign) and isinstance(fn.body[1], ast.Try) and len(fn.body) == 2
    outer = fn.body[1]
    assert [ast.unparse(h.type) for h in outer.handlers if h.type is not None] == ["Exception"]
    assert "_unexpected" in [name for _, _, name in _calls(outer.handlers[0])]
    withs = [n for n in ast.walk(outer) if isinstance(n, ast.With)]
    assert len(withs) == 1 and ast.unparse(withs[0].items[0].context_expr).startswith("RunLock(")
    inside = [name for _, _, name in _calls(ast.Module(body=withs[0].body, type_ignores=[]))]
    assert "run_cycle_core" in inside and "live_cycle_spec" in inside


def test_run_unlocked_cycle_refuses_before_its_try() -> None:
    fn = _function("run_unlocked_cycle")
    body = fn.body
    assert isinstance(body[0], ast.If) and "TypeError" in ast.unparse(body[0].body[0])
    assert "isinstance(parts, App)" in ast.unparse(body[0].test)
    assert "in_memory" in ast.unparse(body[0].test)
    assert any(isinstance(n, ast.Try) for n in body[1:])
    assert "RunLock" not in [name for _, _, name in _calls(fn)]


def test_the_spec_is_built_under_the_lock_and_its_failure_halts(
    roots: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = FixedClock(T0)
    app = app_at(roots[0], clock)
    held: list[bool] = []

    def failing_spec(app: App) -> CycleSpec:
        try:
            with RunLock(app.config.state_dir, clock):
                held.append(False)
        except AlreadyRunningError:
            held.append(True)
        raise RuntimeError("spec bug")

    monkeypatch.setattr(cycle, "live_cycle_spec", failing_spec)
    report = run_cycle(app)
    assert held == [True], "the spec is built while the run lock is held"
    assert report.status == "error" and report.messages == ["RuntimeError: spec bug"]
    assert app.store.read_halt().active


# ------------------------------------------------------------------- the spec
def test_live_cycle_spec_is_the_bots_own_settings(roots: tuple[Path, Path]) -> None:
    app = app_at(roots[0], FixedClock(T0))
    spec = live_cycle_spec(app)
    assert spec.market is Market.STOCKS
    assert spec.universe == tuple(app.config.universe[Market.STOCKS])
    assert spec.strategy is app.strategy
    assert spec.quantity_step == app.config.sim.quantity_step
    assert spec.price_tick == app.config.sim.price_tick
    assert spec.calendar is app.feed.calendar
    assert spec.publish_delay == DATA_PUBLISH_DELAY
    assert spec.bar_window is None


@pytest.mark.parametrize("window", [0, -1, -5])
def test_a_bar_window_below_one_is_refused(roots: tuple[Path, Path], window: int) -> None:
    spec = live_cycle_spec(app_at(roots[0], FixedClock(T0)))
    with pytest.raises(ValueError, match="bar_window"):
        replace(spec, bar_window=window)


@pytest.mark.parametrize("delay", [-timedelta(seconds=1), timedelta(hours=24, seconds=1), timedelta(days=30)])
def test_a_publish_delay_outside_0_to_24_hours_is_refused(roots: tuple[Path, Path], delay: timedelta) -> None:
    # A long delay would let a missing session's bar pass as "not due yet".
    spec = live_cycle_spec(app_at(roots[0], FixedClock(T0)))
    with pytest.raises(ValueError, match="publish_delay"):
        replace(spec, publish_delay=delay)


@pytest.mark.parametrize("delay", [timedelta(0), timedelta(hours=6), timedelta(hours=24)])
def test_a_publish_delay_from_0_to_24_hours_is_accepted(roots: tuple[Path, Path], delay: timedelta) -> None:
    spec = live_cycle_spec(app_at(roots[0], FixedClock(T0)))
    assert replace(spec, publish_delay=delay).publish_delay == delay


# ------------------------------------------------------------------- what the strategy sees
def test_a_list_returning_feed_still_gives_the_strategy_tuples(roots: tuple[Path, Path]) -> None:
    clock = FixedClock(T0)
    app = app_at(roots[0], clock)
    feed_bars = app.feed.bars_until(T0)
    assert all(isinstance(series, list) for series in feed_bars.values()), "the premise: lists"
    strategy = Recording()
    app.strategy = strategy  # type: ignore[assignment]
    assert run_cycle(app).ok
    (seen,) = strategy.seen
    assert set(seen) == set(app.config.universe[Market.STOCKS])
    for symbol, series in seen.items():
        assert type(series) is tuple
        assert series == tuple(feed_bars[symbol])


def test_a_strategy_cannot_change_the_bars_it_was_given(roots: tuple[Path, Path]) -> None:
    app = app_at(roots[0], FixedClock(T0))
    app.strategy = Mutating()  # type: ignore[assignment]
    report = run_cycle(app)
    assert report.status == "error" and report.messages[0].startswith("AttributeError")
    assert app.store.read_halt().active


@pytest.mark.parametrize("window", [None, 1, 5, 10_000])
def test_the_bar_window_gives_the_last_bars(roots: tuple[Path, Path], window: int | None) -> None:
    clock = FixedClock(T0)
    app = app_at(roots[1], clock)
    strategy = Recording()
    spec = replace(live_cycle_spec(app), strategy=strategy, bar_window=window)
    assert run_unlocked_cycle(UnlockedParts(app), spec).ok
    feed_bars = app.feed.bars_until(T0)
    (seen,) = strategy.seen
    for symbol, series in seen.items():
        full = tuple(feed_bars[symbol])
        assert series == (full[-window:] if window else full)
        assert len(series) == (min(window, len(full)) if window else len(full))
    targets = [r for r in app.log.read_day(T0.date()) if r["kind"] == "targets"]
    assert [r["strategy"] for r in targets] == ["recording_test"], (
        "the targets line names the spec's strategy"
    )


def test_the_spec_sizes_the_orders(roots: tuple[Path, Path]) -> None:
    """Edit 6: quantity step and price tick come from the spec, not from the App's config."""
    clock = FixedClock(T0)
    app = app_at(roots[1], clock)
    sent: list[OrderRequest] = []
    real_submit = app.router.submit

    def spy(order: OrderRequest, *args: Any, **kwargs: Any) -> Any:
        sent.append(order)
        return real_submit(order, *args, **kwargs)

    app.router.submit = spy  # type: ignore[method-assign]
    step, tick = Decimal("0.003"), Decimal("0.01")
    assert (step, tick) != (app.config.sim.quantity_step, app.config.sim.price_tick)
    report = run_unlocked_cycle(
        UnlockedParts(app), replace(live_cycle_spec(app), quantity_step=step, price_tick=tick)
    )
    assert report.ok and sent
    for order in sent:
        assert order.quantity % step == 0, order
        assert order.limit_price is not None and order.limit_price % tick == 0, order


def test_the_core_trades_the_specs_market(roots: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch) -> None:
    """Edit 1: the strategy context, the limits and the planner all get the spec's market."""
    clock = FixedClock(T0)
    app = app_at(roots[1], clock)
    planned: list[tuple[Market, object]] = []
    real_plan = plan_orders

    def spy(**kwargs: Any) -> Any:
        planned.append((kwargs["market"], kwargs["limits"]))
        return real_plan(**kwargs)

    monkeypatch.setattr(cycle, "plan_orders", spy)
    markets: list[Market] = []

    class RecordsMarket(Recording):
        def target_weights(self, ctx: StrategyContext) -> TargetWeights:
            markets.append(ctx.market)
            return super().target_weights(ctx)

    spec = replace(live_cycle_spec(app), market=Market.MEMECOIN, strategy=RecordsMarket())
    assert run_unlocked_cycle(UnlockedParts(app), spec).ok
    assert markets == [Market.MEMECOIN]
    assert planned == [(Market.MEMECOIN, app.risk_config.limits_for(Market.MEMECOIN))]
    assert app.risk_config.limits_for(Market.MEMECOIN) != app.risk_config.limits_for(Market.STOCKS)


@pytest.mark.parametrize("stale_symbol", ["DEMO_EQUITY", "DEMO_BONDS", "DEMO_GOLD"])
def test_one_stale_symbol_anywhere_in_the_universe_halts(roots: tuple[Path, Path], stale_symbol: str) -> None:
    """Edit 3: the core checks every universe symbol, not just the first one."""
    clock = FixedClock(T0)
    app = app_at(roots[0], clock)
    assert stale_symbol in app.config.universe[Market.STOCKS]
    real = app.feed.bars_until

    def one_symbol_behind(asof: datetime) -> dict[str, list[Bar]]:
        bars = dict(real(asof))
        bars[stale_symbol] = bars[stale_symbol][:-1]
        return bars

    app.feed.bars_until = one_symbol_behind  # type: ignore[method-assign]
    report = run_cycle(app)
    assert report.status == "halted" and report.orders_sent == 0
    assert report.messages == [
        f"Stale or missing data: latest {stale_symbol} bar is from {T0.date() - timedelta(days=2)}; "
        f"the {T0.date() - timedelta(days=1)} close is due by now"
    ]


def test_unlocked_cycle_start_line_names_the_spec_strategy(roots: tuple[Path, Path]) -> None:
    clock = FixedClock(T0)
    app = app_at(roots[1], clock)
    spec = replace(live_cycle_spec(app), strategy=Recording())
    run_unlocked_cycle(UnlockedParts(app), spec)
    first = app.log.read_day(T0.date())[0]
    assert first["kind"] == "cycle_start" and first["strategy"] == "recording_test"
    assert first["mode"] == "sim"


def test_unlocked_cycle_start_line_names_the_parts_mode(roots: tuple[Path, Path]) -> None:
    class PaperMarked(UnlockedParts):
        mode = Mode.PAPER

    app = app_at(roots[1], FixedClock(T0))
    report = run_unlocked_cycle(PaperMarked(app), live_cycle_spec(app))
    first = app.log.read_day(T0.date())[0]
    assert first["kind"] == "cycle_start" and first["mode"] == "paper"
    # Not a sim: an uninitialised ledger is refused, as the bot's own cycle refuses it.
    assert report.status == "halted" and "ledger is not initialised" in report.messages[0]


def test_the_core_judges_freshness_by_the_specs_calendar_and_delay(tmp_path: Path) -> None:
    """Edit 3: the staleness rule takes its calendar and publish delay from the spec, not the feed."""
    clock = FixedClock(T0)
    two_days_old = T0.date() - timedelta(days=2)

    def run_with(name: str, **changes: Any) -> CycleReport:
        app = app_at(project(tmp_path / name), clock)
        real = app.feed.bars_until
        app.feed.bars_until = lambda asof: real(asof - timedelta(days=1))  # type: ignore[method-assign]
        return run_unlocked_cycle(UnlockedParts(app), replace(live_cycle_spec(app), **changes))

    # Yesterday's 15:30 UTC close plus 6 h has passed at T0 (08:00 UTC), so it is due and missing.
    assert run_with("default").messages == [
        f"Stale or missing data: latest DEMO_EQUITY bar is from {two_days_old}; "
        f"the {T0.date() - timedelta(days=1)} close is due by now"
    ]
    # With a 17 h publish delay yesterday's bar is not due until 08:30 UTC: the same bars pass.
    assert run_with("slow_source", publish_delay=timedelta(hours=17)).ok
    # The feed declares the every-day calendar; the spec's calendar is the one that is used.
    report = run_with("spec_calendar", calendar=XetraCalendar(checked_through_year=2025))
    assert report.status == "halted"
    assert report.messages[0].startswith("Stale or missing data: CalendarRangeError: ")


def test_stale_bars_still_halt_through_the_core(roots: tuple[Path, Path]) -> None:
    clock = FixedClock(T0)
    app = app_at(roots[0], clock)
    real = app.feed.bars_until
    app.feed.bars_until = lambda asof: real(asof - timedelta(days=2))  # type: ignore[method-assign]
    report = run_cycle(app)
    assert report.status == "halted"
    expected = T0.date() - timedelta(days=1)  # every day is a synthetic session; 15:30 + 6 h has passed
    stale = T0.date() - timedelta(days=3)
    assert report.messages == [
        f"Stale or missing data: latest DEMO_EQUITY bar is from {stale}; the {expected} close is due by now"
    ]


# ------------------------------------------------------------------- one way to collect quotes
def test_collect_quotes_asks_once_per_symbol_in_sorted_order_and_skips_missing() -> None:
    asked: list[str] = []

    def quote(symbol: str) -> Quote | None:
        asked.append(symbol)
        return None if symbol == "B" else Quote(symbol, Market.STOCKS, Decimal("1.5"), T0)

    quotes = collect_quotes(quote, {"C", "A", "B"})
    assert asked == ["A", "B", "C"]
    assert list(quotes) == ["A", "C"] and quotes["C"] == Quote("C", Market.STOCKS, Decimal("1.5"), T0)
    assert collect_quotes(quote, []) == {}


def test_the_app_collects_quotes_the_same_way(roots: tuple[Path, Path]) -> None:
    app = app_at(roots[0], FixedClock(T0))
    symbols = {*app.config.universe[Market.STOCKS], "NOT_IN_THE_FEED"}
    quotes = app.quotes_for(symbols)
    assert quotes == collect_quotes(app.feed.quote, symbols)
    assert list(quotes) == sorted(app.config.universe[Market.STOCKS])
