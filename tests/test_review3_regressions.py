"""Regression tests for the third review pass (the one that checked the second round's fixes)."""

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
from samsulek.app import App, build_app
from samsulek.clock import FixedClock
from samsulek.config import is_project_root
from samsulek.credentials import load_env_file, redact
from samsulek.cycle import run_cycle
from samsulek.execution.broker import BrokerError
from samsulek.kill import execute_kill
from samsulek.risk.engine import RiskEngine
from samsulek.risk.state import RiskStateStore
from samsulek.runlock import RunLock
from samsulek.types import PortfolioSnapshot, Quote, Side

ROOT = Path(__file__).resolve().parents[1]
CONFIG = Path("config/default.yaml")


@pytest.fixture
def root(tmp_path: Path) -> Path:
    shutil.copytree(ROOT / "config", tmp_path / "config")
    shutil.copytree(ROOT / "ops", tmp_path / "ops")
    return tmp_path


def copy_project(dest: Path) -> Path:
    shutil.copytree(ROOT / "config", dest / "config")
    shutil.copytree(ROOT / "ops", dest / "ops")
    shutil.copy(ROOT / "pyproject.toml", dest / "pyproject.toml")
    return dest


def run_cli(root: Path, *args: str) -> int:
    return cli.main(["--root", str(root), *args])


def broker_state(root: Path) -> dict[str, object]:
    data: dict[str, object] = json.loads((root / "state" / "sim_broker.json").read_text(encoding="utf-8"))
    return data


def app_at(root: Path, clock: FixedClock) -> App:
    return build_app(root, CONFIG, clock=clock)


def broker_price_factor(app: App, factor: Decimal) -> None:
    """Make the BROKER's execution prices differ from the prices the bot sees."""
    original = app.feed.quote

    def scaled(symbol: str) -> Quote | None:
        quote = original(symbol)
        return None if quote is None else Quote(quote.symbol, quote.market, quote.price * factor, quote.ts)

    app.broker._prices = scaled


# ---------------------------------------------- any damage to a state file fails closed
DEFAULT_CONTENT = {
    "halt.json": '{"active": false, "reasons": [], "since": null}',
    "kill.json": '{"active": false, "reasons": [], "since": null}',
}


def damage(path: Path, how: str) -> None:
    text = path.read_text(encoding="utf-8") if path.is_file() else DEFAULT_CONTENT[path.name]
    if how == "utf16":  # what Notepad "Unicode" or PowerShell 5.1 `>` produce
        path.write_bytes(text.encode("utf-16"))
    elif how == "bitflip":  # ordinary disk damage: one byte with its high bit set
        raw = bytearray(text.encode("utf-8"))
        raw[len(raw) // 2] |= 0x80
        path.write_bytes(bytes(raw))
    elif how == "wrong_types":
        data = json.loads(text)
        for key in ("positions", "trades", "active", "peak_equity"):
            if key in data:
                data[key] = []
        path.write_text(json.dumps(data), encoding="utf-8")
    elif how == "directory":
        path.unlink(missing_ok=True)
        path.mkdir()
    else:
        raise AssertionError(how)


STATE_FILES = ["ledger.json", "halt.json", "kill.json", "risk_day.json", "equity_peak.json"]


@pytest.mark.parametrize("how", ["utf16", "bitflip", "wrong_types"])
@pytest.mark.parametrize("name", STATE_FILES)
def test_kill_closes_everything_whatever_state_file_is_damaged(root: Path, name: str, how: str) -> None:
    assert run_cli(root, "run") == cli.EXIT_OK
    assert broker_state(root)["positions"], "the run bought something"
    damage(root / "state" / name, how)
    assert run_cli(root, "kill", "--flatten") in (cli.EXIT_OK, cli.EXIT_ERROR)
    state = broker_state(root)
    assert state["positions"] == {}, "every position closed"
    assert state["open"] == {}, "no order left behind"
    assert run_cli(root, "status") == cli.EXIT_HALTED  # blocked, never "Unexpected error"


@pytest.mark.parametrize("how", ["utf16", "bitflip", "wrong_types"])
@pytest.mark.parametrize("name", STATE_FILES)
def test_a_run_with_a_damaged_state_file_trades_nothing(root: Path, name: str, how: str) -> None:
    assert run_cli(root, "run") == cli.EXIT_OK
    fills_before = len(broker_state(root)["fills"])  # type: ignore[arg-type]
    damage(root / "state" / name, how)
    assert run_cli(root, "run") == cli.EXIT_HALTED
    assert len(broker_state(root)["fills"]) == fills_before  # type: ignore[arg-type]


def test_kill_works_when_the_ledger_path_is_a_folder(root: Path) -> None:
    assert run_cli(root, "run") == cli.EXIT_OK
    damage(root / "state" / "ledger.json", "directory")
    assert run_cli(root, "kill", "--flatten") == cli.EXIT_ERROR  # our records need a look
    assert broker_state(root)["positions"] == {}


def test_a_damaged_kill_file_is_replaced_by_a_valid_active_flag(root: Path) -> None:
    (root / "state").mkdir()
    damage(root / "state" / "kill.json", "utf16")
    RiskStateStore(root / "state").set_kill("test", T0)
    assert RiskStateStore(root / "state").read_kill().active


# ------------------------------------------------- kill from a checkout inside another
def test_kill_from_a_nested_checkout_also_flags_the_enclosing_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    outer = copy_project(tmp_path / "samsulek")
    nested = copy_project(outer / ".claude" / "worktrees" / "fix-something")
    assert run_cli(outer, "run") == cli.EXIT_OK
    monkeypatch.chdir(nested)
    assert cli.main(["kill", "--flatten"]) == cli.EXIT_ERROR, "never a quiet success"
    out = capsys.readouterr().out
    assert "inside another samsulek folder" in out
    assert str(outer / "state") in out
    assert RiskStateStore(outer / "state").read_kill().active
    assert RiskStateStore(nested / "state").read_kill().active
    assert run_cli(outer, "run") == cli.EXIT_HALTED, "the real bot is stopped"


def test_a_folder_is_only_a_project_if_pyproject_names_samsulek(tmp_path: Path) -> None:
    other = copy_project(tmp_path / "other")
    assert is_project_root(other)
    (other / "pyproject.toml").write_text('[project]\nname = "something-else"\n', encoding="utf-8")
    assert not is_project_root(other)
    (other / "pyproject.toml").write_text("not [valid toml", encoding="utf-8")
    assert not is_project_root(other)


# --------------------------------------------------------- reconcile respects the lock
def test_reconcile_waits_for_a_running_cycle_and_changes_nothing(
    root: Path, clock: FixedClock, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    assert run_cli(root, "run") == cli.EXIT_OK
    monkeypatch.setattr(cli, "LOCK_WAIT_SECONDS", 0.2)
    holder = RunLock(root / "state", clock)
    holder.__enter__()
    try:
        assert run_cli(root, "reconcile") == cli.EXIT_HALTED
        assert "in progress" in capsys.readouterr().out
        assert not RiskStateStore(root / "state").read_halt().active, "no halt for a busy lock"
    finally:
        holder.__exit__(None, None, None)
    assert run_cli(root, "reconcile") == cli.EXIT_OK


# ------------------------------------------------------------------ kill switch details
def test_a_plain_kill_keeps_exit_orders_from_an_earlier_flatten(root: Path, clock: FixedClock) -> None:
    app = app_at(root, clock)
    assert run_cycle(app).ok
    broker_price_factor(app, Decimal("0.95"))  # exits rest instead of filling
    first = execute_kill(app, flatten=True, reason="evening", already_locked=True)
    exits = {o.broker_id for o in app.broker.account().open_orders if o.request.reduce_only}
    assert exits and first.not_flattened
    resting_buy = order("DEMO_GOLD", Side.BUY, "0.01", "1")  # risk-adding: must still go
    app.ledger.remember_order(resting_buy)
    buy_id = app.broker.place_order(resting_buy).broker_id

    second = execute_kill(app, flatten=False, reason="again", already_locked=True)
    still_open = {o.broker_id for o in app.broker.account().open_orders}
    assert exits <= still_open, "exits keep working"
    assert buy_id in second.cancelled and buy_id not in still_open
    assert not exits & set(second.cancelled)
    assert sum("exit order kept working" in n for n in second.notes) == len(exits)


def _stuck_cancels(app: App, fail_ids: set[str] | None, fail_first_only: bool) -> None:
    def cancel_all() -> list[str]:
        raise BrokerError("timeout on cancel-all")

    real_cancel = app.broker.cancel_order
    failed: set[str] = set()

    def cancel_order(broker_id: str) -> None:
        targeted = fail_ids is None or broker_id in fail_ids
        if targeted and not (fail_first_only and broker_id in failed):
            failed.add(broker_id)
            raise BrokerError("timeout")
        real_cancel(broker_id)

    app.broker.cancel_all_orders = cancel_all  # type: ignore[method-assign]
    app.broker.cancel_order = cancel_order  # type: ignore[method-assign]


def _rest_strategy_sell(app: App, symbol: str) -> str:
    held = app.broker.account().positions[symbol].quantity
    sell = order(symbol, Side.SELL, held, "1000000")  # not reduce-only, absurd limit: rests
    app.ledger.remember_order(sell)
    return app.broker.place_order(sell).broker_id


def test_kill_sells_shares_freed_by_its_own_cleanup_pass(root: Path, clock: FixedClock) -> None:
    """A stuck strategy sell blocks part of the flatten; once the cleanup pass cancels it,
    those shares are sold too, and the report doesn't claim a sell is still working."""
    app = app_at(root, clock)
    assert run_cycle(app).ok
    held = sorted(app.broker.account().positions)
    assert len(held) >= 2
    stuck = _rest_strategy_sell(app, held[0])
    _stuck_cancels(app, {stuck}, fail_first_only=True)
    report = execute_kill(app, flatten=True, reason="test", already_locked=True)
    assert stuck in report.cancelled
    assert app.broker.account().positions == {}
    assert sorted(report.flattened) == held
    assert report.not_flattened == []


def test_kill_report_says_a_stuck_sell_is_still_working(root: Path, clock: FixedClock) -> None:
    app = app_at(root, clock)
    assert run_cycle(app).ok
    symbol = sorted(app.broker.account().positions)[0]
    stuck = _rest_strategy_sell(app, symbol)
    _stuck_cancels(app, {stuck}, fail_first_only=False)  # can never be cancelled
    report = execute_kill(app, flatten=True, reason="test", already_locked=True)
    assert [s.split(":")[0] for s in report.not_flattened] == [symbol]
    assert "a sell order for it is still working" in report.not_flattened[0]


def test_kill_report_says_when_no_sell_is_working(root: Path, clock: FixedClock) -> None:
    app = app_at(root, clock)
    assert run_cycle(app).ok
    symbol = sorted(app.broker.account().positions)[0]
    real_quote = app.feed.quote
    app.feed.quote = lambda s: None if s == symbol else real_quote(s)  # type: ignore[method-assign]
    report = execute_kill(app, flatten=True, reason="no price", already_locked=True)
    assert [s.split(":")[0] for s in report.not_flattened] == [symbol]
    assert "NO sell order is working" in report.not_flattened[0]
    assert "no price" in report.not_flattened[0]


# ------------------------------------------------------------------ engine clock safety
def test_clock_moving_back_during_an_exit_keeps_the_days_counts_and_halts(
    engine: RiskEngine, store: RiskStateStore, clock: FixedClock
) -> None:
    assert engine.observe_equity(Decimal("50")) == []
    for _ in range(2):
        engine.record_submission(order("AAA", Side.BUY, "0.1", "100"))
    clock.advance(timedelta(days=-1))  # PC clock jumps back a day
    engine.record_submission(order("AAA", Side.SELL, "0.1", "100", reduce_only=True))
    day = store.read_day()
    assert day is not None and day.day == T0.date(), "the real day's state is kept"
    assert day.trades["total"] == 3
    assert day.day_start_equity == Decimal("50")
    halt = store.read_halt()
    assert halt.active and "clock moved backwards" in halt.reasons[0]


# ------------------------------------------------- a broken log folder halts and alerts
def test_unusable_log_folder_halts_the_run_but_not_the_kill(root: Path) -> None:
    assert run_cli(root, "run") == cli.EXIT_OK
    config_file = root / "config" / "default.yaml"
    data = yaml.safe_load(config_file.read_text(encoding="utf-8"))
    data["log_dir"] = "blocker/logs"
    config_file.write_text(yaml.safe_dump(data), encoding="utf-8")
    (root / "blocker").write_text("a file where a folder should be", encoding="utf-8")
    assert run_cli(root, "run") == cli.EXIT_HALTED
    assert RiskStateStore(root / "state").read_halt().active
    run_cli(root, "kill", "--flatten")
    assert broker_state(root)["positions"] == {}, "kill still closes everything"


# -------------------------------------------------------------------- redaction
def test_an_unclosed_quote_never_swallows_the_rest_of_a_multiline_alert() -> None:
    body = "reason: broker key: 'rotated\ncancelled orders: 2\nNOT closed, close these by hand: DEMO_GOLD"
    out = redact(body)
    assert out.splitlines()[0] == "reason: broker key: ****"
    assert out.splitlines()[1:] == body.splitlines()[1:]


@pytest.mark.parametrize(
    "text",
    [
        "Unexpected error in the trading cycle: KeyError: 'DEMO_GOLD'",
        "cannot start: MissingSecretError: environment variable T212_DEMO_API_KEY is not set",
    ],
)
def test_exception_names_are_not_mistaken_for_secret_names(text: str) -> None:
    assert redact(text) == text


def test_placeholders_are_not_secrets_but_live_only_values_are(tmp_path: Path) -> None:
    path = tmp_path / "vars.txt"
    path.write_text("TELEGRAM_BOT_TOKEN=none\nT212_LIVE_ACCOUNT=48213907\n", encoding="utf-8")
    env: dict[str, str] = {}
    assert load_env_file(path, env) == ["TELEGRAM_BOT_TOKEN"]
    assert redact("Closed positions: none") == "Closed positions: none"
    # Not secret-looking, short, skipped: registered ONLY because the name mentions LIVE.
    assert "T212_LIVE_ACCOUNT" not in env
    assert redact("account 48213907") == "account ****"


# -------------------------------------------------------- open buys valued pessimistically
def test_a_resting_buy_far_below_the_market_counts_at_the_market_price(engine: RiskEngine) -> None:
    resting = order("AAA", Side.BUY, "0.15", "50")  # EUR 7.50 at its limit, EUR 15 at market
    base = pf("60")
    portfolio = PortfolioSnapshot(base.cash, {}, T0, open_orders=(resting,))
    quotes = {"AAA": q("AAA", "100")}
    d = engine.evaluate(order("AAA", Side.BUY, "0.06", "100"), portfolio, quotes)  # +EUR 6
    # 15 + 6 = 21 > 30% of 60 = 18. Valued at its limit it would wrongly pass (7.5 + 6 = 13.5).
    assert not d.approved
    assert any("30% of equity" in r for r in d.reasons)
