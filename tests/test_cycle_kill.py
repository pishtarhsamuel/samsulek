"""End-to-end in sim mode: cycle, kill switch, and every fail-closed path."""

from __future__ import annotations

import json
import shutil
from datetime import timedelta
from decimal import Decimal
from pathlib import Path

import pytest

from helpers import T0
from samsulek.app import App, build_app
from samsulek.clock import FixedClock
from samsulek.cycle import run_cycle
from samsulek.kill import execute_kill
from samsulek.strategies.base import LookaheadError, StrategyContext
from samsulek.types import Bar, Market, Quote

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def root(tmp_path: Path) -> Path:
    shutil.copytree(ROOT / "config", tmp_path / "config")
    shutil.copytree(ROOT / "ops", tmp_path / "ops")
    return tmp_path


def app_at(root: Path, clock: FixedClock) -> App:
    return build_app(root, Path("config/default.yaml"), clock=clock)


def set_prices(app: App, factor: Decimal) -> None:
    """Scale every simulated price by ``factor`` (for both the bot and the simulated broker)."""
    original = app.feed.quote

    def scaled(symbol: str) -> Quote | None:
        q = original(symbol)
        return None if q is None else Quote(q.symbol, q.market, q.price * factor, q.ts)

    app.feed.quote = scaled  # type: ignore[method-assign]
    app.broker._prices = scaled


def test_full_cycle_trades_logs_and_is_idempotent(root: Path, clock: FixedClock) -> None:
    app = app_at(root, clock)
    report = run_cycle(app)
    assert report.ok and report.orders_sent >= 1 and report.orders_rejected == 0
    kinds = [r["kind"] for r in app.log.read_day(T0.date())]
    for kind in (
        "cycle_start",
        "ledger_initialized",
        "reconcile",
        "targets",
        "risk_decision",
        "order_sent",
        "cycle_end",
    ):
        assert kind in kinds
    clock.advance(timedelta(minutes=5))
    again = run_cycle(app_at(root, clock))
    assert again.ok and again.orders_sent == 0, "already at target: no churn"


def test_kill_flattens_and_blocks_future_cycles(root: Path, clock: FixedClock) -> None:
    app = app_at(root, clock)
    assert run_cycle(app).orders_sent >= 1
    report = execute_kill(app, flatten=True, reason="test emergency")
    assert report.complete, report
    assert app.broker.account().positions == {}
    assert app.store.read_kill().active
    assert app.alerter.sent[-1][0] == "critical"
    blocked = run_cycle(app_at(root, clock))
    assert blocked.status == "blocked" and "KILL" in blocked.messages[0]


def test_kill_still_engages_when_broker_is_down(root: Path, clock: FixedClock) -> None:
    app = app_at(root, clock)
    run_cycle(app)
    app.broker.fail_next = ConnectionError("broker unreachable")
    report = execute_kill(app, flatten=False, reason="broker down")
    assert app.store.read_kill().active, "the flag is set before anything that can fail"
    assert report.errors and "unreachable" in report.errors[0]


def test_reconciliation_mismatch_halts_without_trading(root: Path, clock: FixedClock) -> None:
    run_cycle(app_at(root, clock))
    sim_file = root / "state" / "sim_broker.json"
    data = json.loads(sim_file.read_text(encoding="utf-8"))
    data["cash"] = str(Decimal(data["cash"]) - Decimal("5"))  # money moved without us knowing
    sim_file.write_text(json.dumps(data), encoding="utf-8")
    clock.advance(timedelta(minutes=5))
    app = app_at(root, clock)
    report = run_cycle(app)
    assert report.status == "halted" and report.orders_sent == 0
    assert app.store.read_halt().active
    assert any("disagree" in a[1] for a in app.alerter.sent)


def test_daily_loss_halts_and_stays_halted(root: Path, clock: FixedClock) -> None:
    app = app_at(root, clock)
    run_cycle(app)
    clock.advance(timedelta(hours=1))
    app = app_at(root, clock)
    set_prices(app, Decimal("0.85"))  # a 15% crash in everything we hold
    report = run_cycle(app)
    assert report.status == "halted"
    assert any("daily loss" in r for r in app.store.read_halt().reasons)
    clock.advance(timedelta(days=1))
    assert run_cycle(app_at(root, clock)).status == "blocked", "only the owner can clear a halt"


def test_missing_price_halts(root: Path, clock: FixedClock) -> None:
    app = app_at(root, clock)
    app.feed.quote = lambda symbol: None  # type: ignore[method-assign]
    report = run_cycle(app)
    assert report.status == "halted" and "Missing prices" in report.messages[0]


def test_stale_bars_halt(root: Path, clock: FixedClock) -> None:
    app = app_at(root, clock)
    real = app.feed.bars_until
    app.feed.bars_until = lambda asof: real(asof - timedelta(days=10))  # type: ignore[method-assign]
    report = run_cycle(app)
    assert report.status == "halted" and "Stale or missing data" in report.messages[0]


def test_concurrent_run_is_blocked_and_stale_lock_taken_over(root: Path, clock: FixedClock) -> None:
    lock = root / "state" / "run.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text(json.dumps({"pid": 1, "started": T0.isoformat()}), encoding="utf-8")
    assert run_cycle(app_at(root, clock)).status == "blocked"
    clock.advance(timedelta(hours=3))
    app = app_at(root, clock)
    assert run_cycle(app).ok
    assert any("stale run lock" in a[1] for a in app.alerter.sent)
    assert not lock.exists()


def test_strategy_context_rejects_future_bars() -> None:
    bar = Bar("AAA", T0 + timedelta(seconds=1), 1, 1, 1, 1, 1)
    with pytest.raises(LookaheadError):
        StrategyContext(asof=T0, market=Market.STOCKS, bars={"AAA": [bar]})


def test_strategy_context_rejects_unordered_bars() -> None:
    b1 = Bar("AAA", T0 - timedelta(days=1), 1, 1, 1, 1, 1)
    with pytest.raises(ValueError, match="strictly increasing"):
        StrategyContext(asof=T0, market=Market.STOCKS, bars={"AAA": [b1, b1]})


def test_synthetic_feed_never_returns_future_bars(root: Path, clock: FixedClock) -> None:
    app = app_at(root, clock)
    for asof in (T0, T0 + timedelta(hours=7, minutes=29), T0 + timedelta(hours=7, minutes=31)):
        for series in app.feed.bars_until(asof).values():
            assert series and series[-1].close_ts <= asof
