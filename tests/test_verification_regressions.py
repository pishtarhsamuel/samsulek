"""Regression tests for the second review pass (the one that verified the first round's fixes)."""

from __future__ import annotations

import json
import shutil
from datetime import timedelta
from decimal import Decimal
from pathlib import Path

import pytest
import yaml

from helpers import T0, order, pf, q
from samsulek import cli
from samsulek.alerts import ConsoleAlerter
from samsulek.app import App, build_app
from samsulek.clock import FixedClock
from samsulek.config import ConfigError, find_project_root, load_app_config
from samsulek.credentials import is_live_only, load_env_file, redact
from samsulek.cycle import run_cycle
from samsulek.execution.broker import BrokerError
from samsulek.kill import execute_kill
from samsulek.logging_setup import DecisionLog
from samsulek.portfolio.ledger import Ledger, LedgerError
from samsulek.risk.engine import RiskEngine
from samsulek.risk.state import RiskStateStore, StateCorruptError
from samsulek.strategies.base import StrategyContext
from samsulek.types import (
    AccountSnapshot,
    BrokerOrder,
    Fill,
    Market,
    OrderRequest,
    OrderStatus,
    OrderType,
    PortfolioSnapshot,
    Quote,
    Side,
    TargetWeights,
)
from test_execution import SpyBroker, make_router

ROOT = Path(__file__).resolve().parents[1]
CONFIG = Path("config/default.yaml")
QUOTES = {"AAA": q("AAA", "100"), "BBB": q("BBB", "10"), "CCC": q("CCC", "50")}
ALL_IN = {"DEMO_EQUITY": 0.3, "DEMO_BONDS": 0.3, "DEMO_GOLD": 0.3}
DEMO_SYMBOLS = ["DEMO_BONDS", "DEMO_EQUITY", "DEMO_GOLD"]


@pytest.fixture
def root(tmp_path: Path) -> Path:
    shutil.copytree(ROOT / "config", tmp_path / "config")
    shutil.copytree(ROOT / "ops", tmp_path / "ops")
    return tmp_path


@pytest.fixture
def project(tmp_path: Path) -> Path:
    """A full copy of the project folder (with pyproject.toml), like the owner's."""
    proj = tmp_path / "samsulek"
    shutil.copytree(ROOT / "config", proj / "config")
    shutil.copytree(ROOT / "ops", proj / "ops")
    shutil.copy(ROOT / "pyproject.toml", proj / "pyproject.toml")
    return proj


class FixedWeights:
    name = "fixed_weights_test"

    def __init__(self, weights: dict[str, float]) -> None:
        self._w = weights

    def target_weights(self, ctx: StrategyContext) -> TargetWeights:
        return TargetWeights(dict(self._w), "test weights")


def app_at(root: Path, clock: FixedClock, weights: dict[str, float] | None = None) -> App:
    app = build_app(root, CONFIG, clock=clock)
    if weights is not None:
        app.strategy = FixedWeights(weights)  # type: ignore[assignment]
    return app


def broker_price_factor(app: App, factor: Decimal) -> None:
    """Make the BROKER's execution prices differ from the prices the bot sees."""
    original = app.feed.quote

    def scaled(symbol: str) -> Quote | None:
        quote = original(symbol)
        return None if quote is None else Quote(quote.symbol, quote.market, quote.price * factor, quote.ts)

    app.broker._prices = scaled


def run_cli(root: Path, *args: str) -> int:
    return cli.main(["--root", str(root), *args])


# ------------------------------------------------------- finding the bot's folder
def test_kill_from_a_subfolder_uses_the_project_state_folder(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(project / "config")
    assert find_project_root(Path.cwd()) == project.resolve()
    assert cli.main(["kill"]) == cli.EXIT_OK
    assert RiskStateStore(project / "state").read_kill().active
    assert not (project / "config" / "state").exists(), "a flag in the wrong folder protects nothing"


def test_kill_outside_the_project_changes_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.chdir(tmp_path)
    assert cli.main(["kill", "--flatten"]) == cli.EXIT_ERROR
    assert "COULD NOT FIND THE BOT" in capsys.readouterr().out
    assert not (tmp_path / "state").exists()


@pytest.mark.parametrize("value", ["state2", "elsewhere/state", "../state"])
def test_state_folder_cannot_be_moved_by_config(tmp_path: Path, value: str) -> None:
    data = yaml.safe_load((ROOT / "config" / "default.yaml").read_text(encoding="utf-8"))
    data["state_dir"] = value
    path = tmp_path / "app.yaml"
    path.write_text(yaml.safe_dump(data), encoding="utf-8")
    with pytest.raises(ConfigError, match="state_dir is fixed"):
        load_app_config(path, tmp_path)


# ------------------------------------------------------------------ kill switch
def test_cli_kill_closes_positions_even_with_a_damaged_ledger(root: Path) -> None:
    assert run_cli(root, "run") == cli.EXIT_OK
    broker_file = root / "state" / "sim_broker.json"
    assert json.loads(broker_file.read_text(encoding="utf-8"))["positions"], "the run bought something"
    (root / "state" / "ledger.json").write_text("{corrupt", encoding="utf-8")
    # Not "complete": our own records are damaged and the owner must look. But the
    # account itself is safe: no positions, no open orders.
    assert run_cli(root, "kill", "--flatten") == cli.EXIT_ERROR
    state = json.loads(broker_file.read_text(encoding="utf-8"))
    assert state["positions"] == {}
    assert state["open"] == {}
    assert (root / "state" / "ledger.json").read_text(encoding="utf-8") == "{corrupt", "never overwritten"
    assert RiskStateStore(root / "state").read_kill().active


def test_kill_retries_order_by_order_when_cancel_all_fails(root: Path, clock: FixedClock) -> None:
    """A resting strategy sell left in place would claim shares and block part of the flatten."""
    app = app_at(root, clock, ALL_IN)
    assert run_cycle(app).ok
    held = app.broker.account().positions["DEMO_GOLD"].quantity
    strategy_sell = order("DEMO_GOLD", Side.SELL, held, "1000000")  # absurd limit: rests
    app.ledger.remember_order(strategy_sell)
    resting = app.broker.place_order(strategy_sell)
    app.broker.fail_next = BrokerError("timeout on cancel-all")
    report = execute_kill(app, flatten=True, reason="test", already_locked=True)
    assert any("cancelling open orders failed" in e for e in report.errors)
    assert resting.broker_id in report.cancelled
    assert sorted(report.flattened) == DEMO_SYMBOLS
    assert report.not_flattened == []
    account = app.broker.account()
    assert account.positions == {}
    assert account.open_orders == ()


def test_kill_landing_mid_cycle_keeps_its_exit_orders(root: Path, clock: FixedClock) -> None:
    """The cycle's end-of-run cleanup must not cancel the kill switch's closing orders."""
    app = app_at(root, clock, {"DEMO_EQUITY": 0.3})
    assert run_cycle(app).ok
    clock.advance(timedelta(minutes=10))
    app = app_at(root, clock, ALL_IN)
    real_submit = app.router.submit
    kills = []

    def submit_with_kill(o: OrderRequest, portfolio: PortfolioSnapshot, quotes: dict[str, Quote]) -> object:
        if not kills:  # the owner hits the kill switch while this cycle is sending orders
            broker_price_factor(app, Decimal("0.95"))  # the exits will rest, not fill
            kills.append(execute_kill(app, flatten=True, reason="race", already_locked=True))
        return real_submit(o, portfolio, quotes)

    app.router.submit = submit_with_kill  # type: ignore[assignment,method-assign]
    report = run_cycle(app)
    assert kills and kills[0].not_flattened
    assert report.status == "halted"
    assert report.orders_sent == 0
    exits = [o for o in app.broker.account().open_orders if o.request.reduce_only]
    assert [o.request.symbol for o in exits] == ["DEMO_EQUITY"], "exit still working at the broker"
    assert all(o.request.reduce_only for o in app.broker.account().open_orders)


def test_flatten_sells_only_what_resting_sells_have_not_claimed(
    engine: RiskEngine, decision_log: DecisionLog
) -> None:
    broker = SpyBroker()
    router, _, _ = make_router(engine, decision_log, broker)
    resting_sell = order("AAA", Side.SELL, "0.3", "100")
    base = pf("10", {"AAA": "1"})
    portfolio = PortfolioSnapshot(base.cash, base.positions, T0, open_orders=(resting_sell,))
    results, problems = router.flatten(portfolio, QUOTES, "test", Decimal("0.0001"))
    assert [r.decision.order.quantity for r in results] == [Decimal("0.7")]
    assert results[0].sent
    assert any("0.3 already in an open sell order" in p for p in problems)


def _open(broker_id: str, o: OrderRequest) -> BrokerOrder:
    return BrokerOrder(broker_id, o, OrderStatus.OPEN, Decimal(0), T0)


def test_cancel_risk_adding_keeps_going_past_a_failed_cancel(
    engine: RiskEngine, decision_log: DecisionLog
) -> None:
    class StuckOrderBroker(SpyBroker):
        def cancel_order(self, broker_id: str) -> None:
            if broker_id == "B-1":
                raise BrokerError("timeout")
            super().cancel_order(broker_id)

    broker = StuckOrderBroker()
    exit_order = order("AAA", Side.SELL, "0.1", "99", reduce_only=True)
    broker.open = [
        _open("B-1", order("AAA", Side.BUY, "0.01", "100")),
        _open("B-2", order("BBB", Side.BUY, "0.1", "10")),
        _open("B-3", exit_order),
    ]
    router, alerter, _ = make_router(engine, decision_log, broker)
    router.cancel_risk_adding()  # never raises
    assert broker.cancelled == ["B-2"], "B-2 cancelled although B-1 failed; the exit B-3 untouched"
    assert any("cancel them by hand" in title for _, title, _ in alerter.sent)
    with pytest.raises(BrokerError, match="B-1"):
        router.cancel_non_exits()  # the strict version tells the cycle, which halts


def test_cancel_failing_because_the_order_just_filled_is_not_an_error(
    engine: RiskEngine, decision_log: DecisionLog
) -> None:
    class FilledMeanwhileBroker(SpyBroker):
        def cancel_order(self, broker_id: str) -> None:
            if broker_id == "B-1":
                self.open = [o for o in self.open if o.broker_id != "B-1"]  # it filled
                raise BrokerError("order is not open")
            super().cancel_order(broker_id)

    broker = FilledMeanwhileBroker()
    broker.open = [
        _open("B-1", order("AAA", Side.BUY, "0.01", "100")),
        _open("B-2", order("BBB", Side.BUY, "0.1", "10")),
    ]
    router, alerter, _ = make_router(engine, decision_log, broker)
    assert router.cancel_non_exits() == ["B-2"]
    assert alerter.sent == []


# ------------------------------------------------------------------- the cycle
def test_a_cycle_that_halts_mid_way_cancels_its_resting_orders(root: Path, clock: FixedClock) -> None:
    app = app_at(root, clock, ALL_IN)
    broker_price_factor(app, Decimal("1.015"))  # our buys rest at the broker
    real_submit = app.router.submit

    def broken_apply(fills: object) -> int:
        raise LedgerError("disk full")

    def submit_then_break_sync(
        o: OrderRequest, portfolio: PortfolioSnapshot, quotes: dict[str, Quote]
    ) -> object:
        result = real_submit(o, portfolio, quotes)
        app.ledger.apply_fills = broken_apply  # type: ignore[assignment,method-assign]
        return result

    app.router.submit = submit_then_break_sync  # type: ignore[assignment,method-assign]
    report = run_cycle(app)
    assert report.status == "halted"
    assert "Cannot sync with broker" in report.messages[0]
    assert app.store.read_halt().active
    assert app.broker.account().open_orders == (), "the resting buy was cancelled on the way out"


def test_a_limit_tripped_by_the_last_order_reports_halted_and_alerts(root: Path, clock: FixedClock) -> None:
    app = app_at(root, clock, {"DEMO_EQUITY": 0.3})  # plans exactly one order
    real_submit = app.router.submit
    sent: list[object] = []

    def submit_then_trip(o: OrderRequest, portfolio: PortfolioSnapshot, quotes: dict[str, Quote]) -> object:
        result = real_submit(o, portfolio, quotes)
        sent.append(result)
        app.store.set_halt("daily loss limit reached inside evaluate", clock.now())
        return result

    app.router.submit = submit_then_trip  # type: ignore[assignment,method-assign]
    report = run_cycle(app)
    assert len(sent) == 1
    assert report.status == "halted"
    assert any("mid-cycle" in title for _, title, _ in app.alerter.sent)


@pytest.mark.parametrize("command", ["run", "reconcile"])
def test_startup_with_a_damaged_ledger_halts_and_alerts(
    root: Path, command: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert run_cli(root, "run") == cli.EXIT_OK
    (root / "state" / "ledger.json").write_text("{corrupt", encoding="utf-8")
    titles: list[str] = []

    class Recording(ConsoleAlerter):
        def alert(self, level: str, title: str, body: str = "") -> None:
            titles.append(title)
            super().alert(level, title, body)

    monkeypatch.setattr(cli, "ConsoleAlerter", Recording)
    assert run_cli(root, command) == cli.EXIT_HALTED
    assert RiskStateStore(root / "state").read_halt().active
    assert any("Cannot start" in t for t in titles)


# ------------------------------------------------------------------ risk engine
def test_an_exit_counted_before_the_first_price_check_keeps_the_day_baseline(
    engine: RiskEngine, store: RiskStateStore, clock: FixedClock
) -> None:
    """Day roll via the trade counter, then an overnight gap up, then an intraday drop."""
    assert engine.observe_equity(Decimal("50")) == []
    clock.advance(timedelta(days=1))
    engine.record_submission(order("AAA", Side.SELL, "0.1", "100", reduce_only=True))
    day = store.read_day()
    assert day is not None and day.day_start_equity == 0 and day.last_equity == Decimal("50")
    assert engine.observe_equity(Decimal("60")) == []  # gap up overnight
    day = store.read_day()
    assert day is not None and day.day_start_equity == Decimal("60")
    tripped = engine.observe_equity(Decimal("58.1"))  # -3.2% from today's start
    assert any("daily loss" in r for r in tripped)
    assert store.read_halt().active


# ------------------------------------------------------------------------ ledger
def test_ledger_written_by_an_older_version_still_accepts_its_own_orders(tmp_path: Path) -> None:
    led = Ledger(tmp_path)
    led.initialize_from(AccountSnapshot(Decimal(50), {}, (), T0), None)
    led.remember_order(
        OrderRequest("c-old", Market.STOCKS, "AAA", Side.BUY, Decimal("0.1"), OrderType.LIMIT, Decimal("100"))
    )
    path = tmp_path / "ledger.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    del data["ordered"], data["filled"]  # the old format
    path.write_text(json.dumps(data), encoding="utf-8")

    old = Ledger(tmp_path)
    ok = Fill("F1", "c-old", Market.STOCKS, "AAA", Side.BUY, Decimal("0.1"), Decimal("100"), Decimal(0), T0)
    assert old.apply_fills([ok]) == 1
    assert old.positions["AAA"].quantity == Decimal("0.1")
    stranger = Fill(
        "F2", "c-never", Market.STOCKS, "AAA", Side.BUY, Decimal("1"), Decimal("1"), Decimal(0), T0
    )
    with pytest.raises(LedgerError, match="never sent"):
        old.apply_fills([stranger])


def test_unreadable_ledger_placeholder_refuses_every_use(tmp_path: Path) -> None:
    led = Ledger.unreadable(tmp_path, "corrupt file")
    o = OrderRequest("c-1", Market.STOCKS, "AAA", Side.BUY, Decimal("0.1"), OrderType.LIMIT, Decimal("100"))
    calls = [
        lambda: led.snapshot(T0),
        led.save,
        lambda: led.apply_fills([]),
        lambda: led.remember_order(o),
        lambda: led.initialize_from(AccountSnapshot(Decimal(50), {}, (), T0), None),
    ]
    for call in calls:
        with pytest.raises(LedgerError, match="unreadable"):
            call()
    assert not (tmp_path / "ledger.json").exists(), "a placeholder never overwrites the damaged file"


def test_a_damaged_ledger_stops_normal_runs(root: Path, clock: FixedClock) -> None:
    assert run_cycle(app_at(root, clock)).ok
    (root / "state" / "ledger.json").write_text("{corrupt", encoding="utf-8")
    with pytest.raises(StateCorruptError):
        build_app(root, CONFIG, clock=clock)


# ------------------------------------------------------------------- credentials
@pytest.mark.parametrize(
    "name",
    ["T212_LIVE_API_KEY", "T212LIVE_API_KEY", "LIVEKEY_T212", "T212_API_KEY_LIVE2", "t212_live_secret"],
)
def test_any_name_mentioning_live_is_live_only(name: str) -> None:
    assert is_live_only(name)


@pytest.mark.parametrize("name", ["T212_DEMO_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"])
def test_demo_and_alert_names_are_not_live_only(name: str) -> None:
    assert not is_live_only(name)


def test_live_named_values_are_skipped_but_still_redacted(tmp_path: Path) -> None:
    path = tmp_path / "vars.txt"
    path.write_text(
        "T212LIVE_API_KEY=Lv9-q7rT-skipped-value\nT212_DEMO_API_KEY=Dm3-p8sW-demo-value\n", encoding="utf-8"
    )
    env: dict[str, str] = {}
    assert load_env_file(path, env) == ["T212_DEMO_API_KEY"]
    assert "T212LIVE_API_KEY" not in env
    assert "Lv9-q7rT-skipped-value" not in redact("oops Lv9-q7rT-skipped-value leaked")


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ('password="Qx7 unterminated', "password=****"),
        ("token: 'Qx7-unterminated", "token: ****"),
        ("api_key=Qx7a,Qx7b;Qx7c rest", "api_key=**** rest"),
        ("GET /x?api_key=Qx7zz&page=2", "GET /x?api_key=****&page=2"),
    ],
)
def test_key_value_redaction_never_leaks_part_of_a_value(text: str, expected: str) -> None:
    assert redact(text) == expected
