"""Regression tests for the M1 adversarial review. Each test names the finding (#n) it locks down."""

from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import pytest

from helpers import T0, UNIVERSE, make_risk_config, order, pf, q
from samsulek import cli
from samsulek.app import App, build_app
from samsulek.clock import FixedClock
from samsulek.config import ConfigError, load_app_config
from samsulek.credentials import Secret, load_env_file, redact
from samsulek.cycle import cap_breaches, run_cycle
from samsulek.execution.broker import BrokerError
from samsulek.kill import execute_kill
from samsulek.live_gate import EXPECTED_CHECKLIST_SHA256, checklist_fingerprint, checklist_problems
from samsulek.logging_setup import DecisionLog
from samsulek.risk.engine import RiskEngine
from samsulek.risk.state import RiskStateStore, StateCorruptError
from samsulek.runlock import AlreadyRunningError, RunLock
from samsulek.strategies.base import StrategyContext
from samsulek.terminal import confirm_phrase
from samsulek.types import AccountSnapshot, Market, Position, Quote, Side, TargetWeights

ROOT = Path(__file__).resolve().parents[1]
QUOTES = {"AAA": q("AAA", "100"), "BBB": q("BBB", "10"), "CCC": q("CCC", "50")}


def reasons(d: object) -> str:
    return " | ".join(d.reasons)  # type: ignore[attr-defined]


# --------------------------------------------------- #0 #1: open orders count
def test_open_buy_reserves_cash(engine: RiskEngine) -> None:
    portfolio = pf("50")
    portfolio = type(portfolio)(
        cash=portfolio.cash, positions={}, ts=T0, open_orders=(order("AAA", Side.BUY, "0.3", "100"),)
    )
    d = engine.evaluate(order("BBB", Side.BUY, "2.1", "10"), portfolio, QUOTES)  # 21 > 50 - 30
    assert not d.approved
    assert "exceeds available cash" in reasons(d)


def test_open_buy_counts_toward_position_cap(engine: RiskEngine) -> None:
    base = pf("50")
    resting = order("AAA", Side.BUY, "0.14", "100.5")  # EUR 14.07 pending
    portfolio = type(base)(cash=base.cash, positions={}, ts=T0, open_orders=(resting,))
    d = engine.evaluate(order("AAA", Side.BUY, "0.02", "100.5"), portfolio, QUOTES)
    assert not d.approved
    assert "30% of equity" in reasons(d)


def test_three_identical_buys_cannot_stack_past_the_cap(engine: RiskEngine) -> None:
    """The review's repro: identical buys approved one after another against resting orders."""
    base = pf("50")
    resting: tuple = ()  # type: ignore[type-arg]
    approved = 0
    for _ in range(3):
        o = order("AAA", Side.BUY, "0.145", "100.5")
        portfolio = type(base)(cash=base.cash, positions={}, ts=T0, open_orders=resting)
        if engine.evaluate(o, portfolio, QUOTES).approved:
            approved += 1
            engine.record_submission(o)
            resting = (*resting, o)
    assert approved == 1


def test_open_sell_reduces_what_can_be_sold(engine: RiskEngine) -> None:
    base = pf("40", {"AAA": "0.1"})
    portfolio = type(base)(
        cash=base.cash,
        positions=base.positions,
        ts=T0,
        open_orders=(order("AAA", Side.SELL, "0.06", "99.6"),),
    )
    d = engine.evaluate(order("AAA", Side.SELL, "0.05", "99.6"), portfolio, QUOTES)
    assert not d.approved
    assert "sellable" in reasons(d)
    r = engine.evaluate(order("AAA", Side.SELL, "0.05", "99", reduce_only=True), portfolio, QUOTES)
    assert not r.approved


def test_open_order_without_fresh_price_blocks_new_risk(engine: RiskEngine) -> None:
    base = pf("50")
    portfolio = type(base)(
        cash=base.cash, positions={}, ts=T0, open_orders=(order("CCC", Side.BUY, "0.1", "50"),)
    )
    quotes = {"AAA": QUOTES["AAA"]}
    d = engine.evaluate(order("AAA", Side.BUY, "0.05", "100"), portfolio, quotes)
    assert not d.approved
    assert "cannot value portfolio" in reasons(d)


# ------------------------------------------------- #22: daily-loss baseline
def test_overnight_gap_up_is_not_credited_as_loss_allowance(engine: RiskEngine, clock: FixedClock) -> None:
    engine.observe_equity(Decimal("50"))
    clock.advance(timedelta(days=1))
    assert engine.observe_equity(Decimal("55")) == []  # gapped up overnight
    tripped = engine.observe_equity(Decimal("53.30"))  # -3.09% from today's 55
    assert tripped
    assert "daily loss" in tripped[0]


# ------------------------------------------------- #35: halts are persisted
@pytest.mark.parametrize("trigger", ["sanity", "zero", "backwards"])
def test_every_halt_trigger_persists_and_blocks(
    engine: RiskEngine, store: RiskStateStore, clock: FixedClock, trigger: str
) -> None:
    engine.observe_equity(Decimal("50"))
    if trigger == "sanity":
        engine.observe_equity(Decimal("201"))
    elif trigger == "zero":
        engine.observe_equity(Decimal("0"))
    else:
        clock.set(T0 - timedelta(days=2))
        engine.observe_equity(Decimal("50"))
        clock.set(T0)
    assert store.read_halt().active
    d = engine.evaluate(order("BBB", Side.BUY, "0.2", "10"), pf("50"), QUOTES)
    assert not d.approved
    assert "HALTED" in reasons(d)


# ------------------------------------------------- #23: invalid numbers fail closed
def test_broker_snapshot_rejects_bad_cash() -> None:
    for bad in (Decimal("NaN"), Decimal("Infinity"), Decimal("-1")):
        with pytest.raises(ValueError, match="broker cash"):
            AccountSnapshot(bad, {}, (), T0)


def test_day_state_with_non_finite_equity_is_corrupt(store: RiskStateStore, state_dir: Path) -> None:
    (state_dir / "risk_day.json").write_text(
        json.dumps({"day": "2026-10-12", "day_start_equity": "NaN", "last_equity": "50", "trades": {}}),
        encoding="utf-8",
    )
    with pytest.raises(StateCorruptError):
        store.read_day()


# ------------------------------------------- #28 #31 #32 #39: secrets and parsing
def test_env_parsing_inline_comments_quotes_bom_and_live_suffix(tmp_path: Path) -> None:
    f = tmp_path / "secrets.env"
    f.write_text(
        "﻿T212_DEMO_API_KEY=abc123def456ghi # my demo key\n"
        'TELEGRAM_BOT_TOKEN="quoted token value" # comment after quotes\n'
        "T212_KEY_LIVE=live-suffix-secret-9\n"
        "SOME_FLAG=true\n",
        encoding="utf-8",
    )
    env: dict[str, str] = {}
    loaded = load_env_file(f, env)
    assert loaded == ["T212_DEMO_API_KEY", "TELEGRAM_BOT_TOKEN", "SOME_FLAG"]
    assert env["T212_DEMO_API_KEY"] == "abc123def456ghi", "BOM and inline comment handled"
    assert env["TELEGRAM_BOT_TOKEN"] == "quoted token value"
    assert "T212_KEY_LIVE" not in env, "names ending in _LIVE are live-only too"
    assert redact("flag is true") == "flag is true", "short non-secret values are not scrubbed everywhere"
    assert "live-suffix-secret-9" not in redact("x live-suffix-secret-9 x")


def test_decision_log_stays_valid_json_and_escaped_secrets_are_redacted(tmp_path: Path) -> None:
    secret = Secret("QUOTE_TOKEN", 'pa"ss\\word-99x')
    log = DecisionLog(tmp_path, FixedClock(T0))
    log.write("t", note=f"value {secret.reveal()} here", text="api_key=abcdef12345, other=1", flag=True)
    raw = log.path_for(T0.date()).read_text(encoding="utf-8")
    assert 'pa"ss' not in raw
    assert 'pa\\"ss' not in raw
    record = json.loads(raw.splitlines()[0])  # still valid JSON
    assert record["flag"] is True
    # The separator goes too: over-redacting a comma is safe, leaking ",rest-of-secret" is not.
    assert record["text"] == "api_key=**** other=1"


def test_cli_output_and_persisted_reasons_are_redacted(
    store: RiskStateStore, state_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    secret = Secret("BROKER_API_SECRET", "zz-secret-value-77")
    cli._out(f"error talking to broker with {secret.reveal()}")
    assert "zz-secret-value-77" not in capsys.readouterr().out
    store.set_halt(f"auth failed: {secret.reveal()}", T0)
    assert "zz-secret-value-77" not in (state_dir / "halt.json").read_text(encoding="utf-8")


# ------------------------------------------------- #5: config can't steer the gate
def test_config_cannot_enable_live_or_redirect_protected_files(tmp_path: Path) -> None:
    import yaml

    data = yaml.safe_load((ROOT / "config" / "default.yaml").read_text(encoding="utf-8"))
    data["mode"] = "live"
    p = tmp_path / "app.yaml"
    p.write_text(yaml.safe_dump(data), encoding="utf-8")
    with pytest.raises(ConfigError, match="live mode can't be set in a config file"):
        load_app_config(p, tmp_path)
    data["mode"] = "sim"
    data["risk_file"] = "/tmp/loose-limits.yaml"
    p.write_text(yaml.safe_dump(data), encoding="utf-8")
    with pytest.raises(ConfigError, match="Extra inputs are not permitted"):
        load_app_config(p, tmp_path)


# ------------------------------------------------- #15: no option abbreviations
def test_cli_rejects_abbreviated_options() -> None:
    with pytest.raises(SystemExit):
        cli.build_parser().parse_args(["run", "--m", "sim"])
    with pytest.raises(SystemExit):
        cli.build_parser().parse_args(["kill", "--flat"])


# ------------------------------------------------- #29: checklist parser
def test_repo_checklist_matches_the_reviewed_fingerprint() -> None:
    text = (ROOT / "ops" / "go_live_checklist.md").read_text(encoding="utf-8")
    assert checklist_fingerprint(text) == EXPECTED_CHECKLIST_SHA256


def _signed(tmp_path: Path, transform: object) -> list[str]:
    text = (ROOT / "ops" / "go_live_checklist.md").read_text(encoding="utf-8")
    text = text.replace("- [ ]", "- [x]").replace("Signed-off-by:", "Signed-off-by: Owner")
    text = text.replace("Date:", "Date: 2026-10-12")
    text = transform(text)  # type: ignore[operator]
    p = tmp_path / "c.md"
    p.write_text(text, encoding="utf-8")
    return checklist_problems(p, datetime(2026, 10, 12, tzinfo=UTC).date())


def test_checklist_parser_fails_closed(tmp_path: Path) -> None:
    assert _signed(tmp_path, lambda t: t) == []
    lines = lambda t: t.splitlines(keepends=True)  # noqa: E731
    first_item = lambda t: next(i for i, line in enumerate(lines(t)) if line.startswith("- [x]"))  # noqa: E731

    def edit_first(t: str, new: str) -> str:
        ls = lines(t)
        ls[first_item(t)] = new
        return "".join(ls)

    cases = {
        "unknown mark": lambda t: re.sub(r"(?m)^- \[x\]", "- [v]", t, count=1),
        "numbered unticked": lambda t: t + "\n1. [ ] surprise item\n",
        "deleted item": lambda t: edit_first(t, ""),
        "reworded item": lambda t: edit_first(t, "- [x] something easier\n"),
        "quoted unticked": lambda t: t + "\n> - [ ] hidden in a quote\n",
    }
    for name, fn in cases.items():
        assert _signed(tmp_path, fn), f"{name} must be refused"


# ------------------------------------------------- #30 #34: real POSIX terminal
@pytest.mark.skipif(os.name == "nt" or not hasattr(os, "fork"), reason="POSIX pseudo-terminal test")
def test_real_tty_opener_reads_what_a_person_types() -> None:
    import pty
    import select

    pid, fd = pty.fork()
    if pid == 0:  # child: talks to the pseudo-terminal as its controlling terminal
        try:
            ok = confirm_phrase("Type it", "RESET 123456")
            os._exit(0 if ok else 3)
        except BaseException:
            os._exit(4)
    out = b""
    deadline = time.monotonic() + 10
    while b"> " not in out and time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.5)
        if ready:
            out += os.read(fd, 1024)
    os.write(fd, b"RESET 123456\n")
    _, status = os.waitpid(pid, 0)
    os.close(fd)
    assert b"RESET 123456" in out
    assert os.WEXITSTATUS(status) == 0


# ------------------------------------------------- #25 #26: run lock
def test_lock_is_exclusive_however_long_a_run_takes(state_dir: Path, clock: FixedClock) -> None:
    a = RunLock(state_dir, clock)
    a.__enter__()
    clock.advance(timedelta(days=2))  # a slow run is never "taken over" by the clock
    with pytest.raises(AlreadyRunningError):
        RunLock(state_dir, clock).__enter__()
    a.__exit__(None, None, None)
    a.__exit__(None, None, None)  # releasing twice is harmless
    assert (state_dir / "run.lock").exists(), "never deleted: deleting lets two runs lock different files"
    b = RunLock(state_dir, clock)
    b.__enter__()
    assert not b.took_over_stale, "the previous run finished cleanly"
    b.__exit__(None, None, None)


@pytest.mark.parametrize("left_behind", ['{"status": "running"}', "", "\x00\x00 garbage"])
def test_a_run_that_died_is_reported(state_dir: Path, clock: FixedClock, left_behind: str) -> None:
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "run.lock").write_text(left_behind, encoding="utf-8")
    lock = RunLock(state_dir, clock)
    lock.__enter__()
    assert lock.took_over_stale == (left_behind != "")
    lock.__exit__(None, None, None)


def test_os_releases_the_lock_of_a_killed_process(state_dir: Path, clock: FixedClock) -> None:
    import subprocess
    import sys

    code = (
        "import sys, os\n"
        "from pathlib import Path\n"
        "from samsulek.clock import FixedClock\n"
        "from samsulek.runlock import RunLock\n"
        "from datetime import datetime, UTC\n"
        "held = RunLock(Path(sys.argv[1]), FixedClock(datetime(2026, 1, 1, tzinfo=UTC)))\n"
        "held.__enter__()\n"
        "print('locked', flush=True)\n"
        "sys.stdin.readline()\n"
        "os._exit(9)  # die without releasing anything\n"
    )
    child = subprocess.Popen(
        [sys.executable, "-c", code, str(state_dir)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert child.stdout is not None and child.stdin is not None
        assert child.stdout.readline().strip() == "locked"
        with pytest.raises(AlreadyRunningError):
            RunLock(state_dir, clock).__enter__()
        child.stdin.write("\n")
        child.stdin.flush()
        child.wait(timeout=10)
    finally:
        if child.poll() is None:
            child.kill()
    after = RunLock(state_dir, clock)
    after.__enter__()
    assert after.took_over_stale, "the dead run left status 'running' behind"
    after.__exit__(None, None, None)


def test_lock_waits_for_a_finishing_run(state_dir: Path, clock: FixedClock) -> None:
    holder = RunLock(state_dir, clock)
    holder.__enter__()
    threading.Timer(0.3, lambda: holder.__exit__(None, None, None)).start()
    waiter = RunLock(state_dir, clock, wait_seconds=5)
    waiter.__enter__()
    waiter.__exit__(None, None, None)


# ------------------------------------------------- cycle / kill integration
@pytest.fixture
def root(tmp_path: Path) -> Path:
    shutil.copytree(ROOT / "config", tmp_path / "config")
    shutil.copytree(ROOT / "ops", tmp_path / "ops")
    return tmp_path


class FixedWeights:
    name = "fixed_weights_test"

    def __init__(self, weights: dict[str, float]) -> None:
        self._w = weights

    def target_weights(self, ctx: StrategyContext) -> TargetWeights:
        return TargetWeights(dict(self._w), "test weights")


ALL_IN = {"DEMO_EQUITY": 0.3, "DEMO_BONDS": 0.3, "DEMO_GOLD": 0.3}


def app_at(root: Path, clock: FixedClock, weights: dict[str, float] | None = None) -> App:
    app = build_app(root, Path("config/default.yaml"), clock=clock)
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


def test_resting_buys_never_stack_across_cycles(root: Path, clock: FixedClock) -> None:
    """#0/#1/#4: the market runs away from our limits for three runs, then comes back."""
    for _ in range(3):
        app = app_at(root, clock, ALL_IN)
        broker_price_factor(app, Decimal("1.015"))  # 1.5% above our reference: limits rest
        report = run_cycle(app)
        assert report.ok, report.messages
        assert app.broker.account().open_orders == (), "unfilled orders are cancelled at the end"
        clock.advance(timedelta(minutes=10))
    app = app_at(root, clock, ALL_IN)
    assert run_cycle(app).ok
    account = app.broker.account()
    quotes = app.quotes_for(set(account.positions))
    equity = account.to_portfolio().equity(quotes)
    assert cap_breaches(app, account.to_portfolio(), quotes, equity) == []
    for symbol in account.positions:
        assert account.to_portfolio().position_value(symbol, quotes) <= Decimal("15.01")


def test_leftover_open_orders_are_cancelled_before_planning(root: Path, clock: FixedClock) -> None:
    app = app_at(root, clock, {})
    assert run_cycle(app).ok  # initialises the ledger, buys nothing
    leftover = order("DEMO_GOLD", Side.BUY, "0.01", "1")  # far below market: rests
    app.ledger.remember_order(leftover)
    app.broker.place_order(leftover)  # test-only shortcut to plant a resting order
    clock.advance(timedelta(minutes=5))
    app = app_at(root, clock, {})
    assert run_cycle(app).ok
    kinds = [r["kind"] for r in app.log.read_day(T0.date())]
    assert "stale_orders_cancelled" in kinds
    assert app.broker.account().open_orders == ()


def test_unexpected_error_halts_and_alerts(root: Path, clock: FixedClock) -> None:
    """#13: a bug anywhere in the cycle must halt and alert, not just crash."""

    class Broken:
        name = "broken"

        def target_weights(self, ctx: StrategyContext) -> TargetWeights:
            raise RuntimeError("strategy bug")

    app = app_at(root, clock)
    app.strategy = Broken()  # type: ignore[assignment]
    report = run_cycle(app)
    assert report.status == "error"
    assert app.store.read_halt().active
    assert any("Unexpected error" in title for _, title, _ in app.alerter.sent)


def test_halt_landing_mid_cycle_stops_orders_and_alerts(root: Path, clock: FixedClock) -> None:
    """#20: a halt tripped while orders are going out must stop the rest and alert."""
    app = app_at(root, clock, ALL_IN)
    real_submit = app.router.submit
    calls = {"n": 0}

    def submit_then_halt(*args: object, **kwargs: object) -> object:
        calls["n"] += 1
        result = real_submit(*args, **kwargs)  # type: ignore[arg-type]
        app.store.set_halt("tripped mid-cycle", clock.now())
        return result

    app.router.submit = submit_then_halt  # type: ignore[method-assign]
    report = run_cycle(app)
    assert calls["n"] == 1
    assert report.status == "halted"
    assert any("mid-cycle" in title for _, title, _ in app.alerter.sent)


def test_post_cycle_cap_check_catches_oversized_positions(root: Path, clock: FixedClock) -> None:
    app = app_at(root, clock)
    portfolio = pf("0", {"DEMO_GOLD": "1"})
    quotes = {"DEMO_GOLD": q("DEMO_GOLD", "30")}
    assert cap_breaches(app, portfolio, quotes, Decimal("50"))  # EUR 30 vs cap min(15, 20) = 15
    small = pf("0", {"DEMO_GOLD": "0.5"})
    assert cap_breaches(app, small, quotes, Decimal("100")) == []  # EUR 15 vs cap min(30, 20) = 20


def test_kill_does_not_report_resting_exits_as_closed(root: Path, clock: FixedClock) -> None:
    """#2/#12: a flatten sell that only rests at the broker is NOT a closed position."""
    app = app_at(root, clock, ALL_IN)
    assert run_cycle(app).orders_sent >= 1
    broker_price_factor(app, Decimal("0.95"))  # broker trades 5% below our reference: exits rest
    report = execute_kill(app, flatten=True, reason="test", lock_wait_seconds=0)
    assert report.flag_set
    assert not report.complete
    assert report.flattened == []
    assert report.not_flattened
    assert any(o.request.reduce_only for o in app.broker.account().open_orders), "exits keep working"


def test_kill_continues_when_the_flag_cannot_be_written(root: Path, clock: FixedClock) -> None:
    """#10: a failing flag write must not skip the cancel/flatten or hide the failure."""
    app = app_at(root, clock, ALL_IN)
    run_cycle(app)

    def broken_set_kill(reason: str, ts: datetime) -> None:
        raise OSError("read-only disk")

    app.store.set_kill = broken_set_kill  # type: ignore[method-assign,assignment]
    report = execute_kill(app, flatten=True, reason="test", lock_wait_seconds=0)
    assert not report.flag_set
    assert any("KILL FLAG NOT PERSISTED" in e for e in report.errors)
    assert report.flattened, "positions were still closed"
    assert any("NOT PERSISTED" in title for _, title, _ in app.alerter.sent)


def run_cli(root: Path, *args: str) -> int:
    return cli.main(["--root", str(root), *args])


@pytest.mark.parametrize("damage", ["ledger", "sim_broker", "risk_config"])
def test_cli_kill_sets_the_flag_even_when_everything_else_is_broken(root: Path, damage: str) -> None:
    """#3/#9/#17."""
    assert run_cli(root, "run") == cli.EXIT_OK
    if damage == "ledger":
        (root / "state" / "ledger.json").write_text("{corrupt", encoding="utf-8")
    elif damage == "sim_broker":
        (root / "state" / "sim_broker.json").write_text("{corrupt", encoding="utf-8")
    else:
        risk = root / "config" / "risk.yaml"
        risk.write_text(risk.read_text(encoding="utf-8") + "\ntypo_key: 1\n", encoding="utf-8")
    assert run_cli(root, "kill", "--flatten") == cli.EXIT_ERROR
    assert RiskStateStore(root / "state").read_kill().active


def test_cli_reconcile_halts_when_sync_fails(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """#27."""
    assert run_cli(root, "run") == cli.EXIT_OK

    def failing_sync(app: object) -> object:
        raise BrokerError("broker unreachable")

    monkeypatch.setattr(cli, "sync_ledger", failing_sync)
    assert run_cli(root, "reconcile") == cli.EXIT_HALTED
    assert RiskStateStore(root / "state").read_halt().active


def test_cli_owner_reset_paths(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """#34: the owner-only reset, with the terminal faked: wrong phrase, right phrase, peak rebase."""
    store = RiskStateStore(root / "state")
    store.set_halt("test", T0)
    store.set_kill("test", T0)
    store.write_peak(Decimal("80"))
    monkeypatch.setattr(cli, "require_interactive", lambda: None)
    monkeypatch.setattr(cli, "confirm_phrase", lambda prompt, expected: False)
    assert run_cli(root, "reset-halt", "--clear-kill") == cli.EXIT_REFUSED
    assert store.read_halt().active
    assert store.read_kill().active
    monkeypatch.setattr(cli, "confirm_phrase", lambda prompt, expected: expected.startswith("RESET "))
    assert run_cli(root, "reset-halt") == cli.EXIT_OK
    assert not store.read_halt().active
    assert store.read_kill().active, "kill stays on without --clear-kill"
    assert run_cli(root, "reset-halt", "--clear-kill") == cli.EXIT_OK
    assert not store.read_kill().active


def test_reset_refused_when_terminal_check_fails(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = RiskStateStore(root / "state")
    store.set_halt("test", T0)

    def no_tty() -> None:
        from samsulek.terminal import TerminalUnavailableError

        raise TerminalUnavailableError("not a terminal")

    monkeypatch.setattr(cli, "require_interactive", no_tty)
    monkeypatch.setattr(cli, "confirm_phrase", lambda prompt, expected: True)
    assert run_cli(root, "reset-halt") == cli.EXIT_REFUSED
    assert store.read_halt().active


# ------------------------------------------------- engine-level sanity for the fixture
def test_engine_fixture_universe() -> None:
    eng_cfg = make_risk_config()
    assert eng_cfg.limits_for(Market.STOCKS).max_position_pct == Decimal("0.30")
    assert "AAA" in UNIVERSE[Market.STOCKS]
    assert Position("X", Market.STOCKS, Decimal(1), Decimal(1)).quantity == 1


def test_cli_run_halts_when_the_broker_state_cannot_be_loaded(root: Path) -> None:
    assert run_cli(root, "run") == cli.EXIT_OK
    (root / "state" / "sim_broker.json").write_text("{corrupt", encoding="utf-8")
    assert run_cli(root, "run") == cli.EXIT_HALTED
    assert RiskStateStore(root / "state").read_halt().active
