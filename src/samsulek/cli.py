"""Command line: `samsulek <command>`. Output is plain ASCII so any Windows console can show it.

Exit codes: 0 ok | 1 error | 2 halted or blocked | 3 refused (not available / gate failed)
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from collections.abc import Sequence
from decimal import Decimal
from pathlib import Path

from samsulek.app import NotAvailableError, build_app, load_configs
from samsulek.clock import SystemClock, trading_day
from samsulek.config import CHECKLIST_FILE, ConfigError, RiskConfig
from samsulek.credentials import load_env_file, redact
from samsulek.cycle import SYNC_ERRORS, halt_and_alert, reconcile_or_halt, run_cycle, sync_ledger
from samsulek.kill import execute_kill
from samsulek.live_gate import LiveGateError, authorize_live
from samsulek.logging_setup import RedactingFilter, setup_logging
from samsulek.risk.state import RiskStateStore, StateCorruptError
from samsulek.terminal import TerminalUnavailableError, confirm_phrase, new_code, require_interactive
from samsulek.types import Mode

EXIT_OK, EXIT_ERROR, EXIT_HALTED, EXIT_REFUSED = 0, 1, 2, 3


def _out(text: str = "") -> None:
    sys.stdout.write(redact(text).encode("ascii", "replace").decode("ascii") + "\n")


def _eur(x: Decimal) -> str:
    return f"EUR {x:,.2f}"


def _print_limits(risk: RiskConfig, equity: Decimal) -> None:
    acc = risk.account
    _out(f"Account limits (at equity {_eur(equity)}):")
    daily = _eur(acc.max_daily_loss_pct * equity)
    _out(f"  max daily loss      {acc.max_daily_loss_pct:.1%}  = {daily} -> HALT")
    _out(f"  max drawdown        {acc.max_drawdown_pct:.1%}  = {_eur(acc.max_drawdown_pct * equity)} -> HALT")
    _out(f"  max trades per day  {acc.max_trades_per_day}")
    _out(f"  equity sanity max   {_eur(acc.equity_sanity_max_eur)} -> HALT above this")
    for market, lim in risk.markets.items():
        _out(f"{market.value}:")
        _out(
            f"  max position        {lim.max_position_pct:.0%} = {_eur(lim.max_position_pct * equity)}"
            f" (cap {_eur(lim.max_position_eur)})"
        )
        _out(
            f"  max exposure        {lim.max_gross_exposure_pct:.0%} = "
            f"{_eur(lim.max_gross_exposure_pct * equity)} (cap {_eur(lim.max_gross_exposure_eur)})"
        )
        _out(f"  order size          {_eur(lim.min_order_eur)} .. {_eur(lim.max_order_eur)}")
        _out(
            f"  max slippage        {lim.max_slippage_bps} bps (flatten: {lim.flatten_max_slippage_bps} bps)"
        )
        _out(f"  max trades per day  {lim.max_trades_per_day}")
        _out(f"  price must be newer than {lim.max_quote_age_seconds}s")
        _out(f"  market orders allowed: {lim.allow_market_orders}")
        if lim.max_pool_liquidity_pct is not None:
            _out(f"  max share of pool liquidity {lim.max_pool_liquidity_pct:.2%}")
        if lim.require_safety_pass:
            _out("  safety filter must pass before every buy")


def _halt_on_startup_failure(state_dir: Path, exc: Exception) -> int:
    """The broker or ledger can't even be loaded: we can't know the account, so halt (fail closed)."""
    reason = f"cannot start: {type(exc).__name__}: {exc}"
    try:
        RiskStateStore(state_dir).set_halt(reason, SystemClock().now())
        _out(f"HALTED: {reason}")
    except Exception as exc2:
        _out(f"{reason}. ALSO could not record a halt ({type(exc2).__name__}): check the bot by hand.")
    return EXIT_HALTED


def cmd_check_config(args: argparse.Namespace) -> int:
    config, risk = load_configs(args.root, args.config)
    _out(f"Config OK. Mode: {config.mode.value}")
    _out(f"Universe: {', '.join(f'{m.value}={s}' for m, s in config.universe.items())}")
    _print_limits(risk, config.sim.starting_cash_eur)
    return EXIT_OK


def cmd_status(args: argparse.Namespace) -> int:
    config, _risk = load_configs(args.root, args.config)
    store = RiskStateStore(config.state_dir)
    try:
        halt, kill, day, peak = store.read_halt(), store.read_kill(), store.read_day(), store.read_peak()
    except StateCorruptError as exc:
        _out(f"STATE UNREADABLE (trading is blocked): {exc}")
        return EXIT_HALTED
    _out(
        f"KILL switch: {'ON' if kill.active else 'off'}"
        + (f"  ({'; '.join(kill.reasons)})" if kill.active else "")
    )
    _out(
        f"HALT:        {'ON' if halt.active else 'off'}"
        + (f"  ({'; '.join(halt.reasons)})" if halt.active else "")
    )
    if day:
        _out(f"Day {day.day}: start equity {_eur(day.day_start_equity)}, last {_eur(day.last_equity)}")
        _out(f"  trades so far: {day.trades}")
    if peak:
        _out(f"Peak equity: {_eur(peak)}")
    return EXIT_HALTED if (halt.active or kill.active) else EXIT_OK


def cmd_run(args: argparse.Namespace) -> int:
    config, risk = load_configs(args.root, args.config)
    mode = Mode(args.mode) if args.mode else config.mode
    if mode is Mode.LIVE:
        try:
            authorize_live(
                mode=mode,
                environ=os.environ,
                checklist_path=args.root / CHECKLIST_FILE,
                today=trading_day(SystemClock().now(), risk.account.risk_day_timezone),
            )
        except LiveGateError as exc:
            _out(str(exc))
            return EXIT_REFUSED
    load_env_file(config.env_file, allow_live_secrets=mode is Mode.LIVE)
    try:
        app = build_app(args.root, args.config, mode)
    except NotAvailableError as exc:
        _out(f"Refused: {exc}")
        return EXIT_REFUSED
    except (ConfigError, StateCorruptError):
        raise
    except Exception as exc:
        return _halt_on_startup_failure(config.state_dir, exc)
    setup_logging(app.config.log_dir)
    report = run_cycle(app)
    _out(f"Cycle {report.status}: {report.orders_sent} orders sent, {report.orders_rejected} rejected")
    for m in report.messages:
        _out(f"  {m}")
    return EXIT_OK if report.ok else EXIT_HALTED


def cmd_kill(args: argparse.Namespace) -> int:
    # 1. Set the KILL flag before anything that could fail (config, ledger, broker).
    state_dir = args.root / "state"
    try:
        config, _ = load_configs(args.root, args.config)
        state_dir = config.state_dir
    except Exception as exc:
        _out(f"WARNING: config could not be loaded ({type(exc).__name__}: {exc}); using {state_dir}")
    try:
        RiskStateStore(state_dir).set_kill(args.reason, SystemClock().now())
        _out("KILL flag is ON: no new orders will be sent by any run.")
    except Exception as exc:
        _out(f"COULD NOT SET THE KILL FLAG ({type(exc).__name__}: {exc}).")
        _out("Stop the bot by hand (close its window / scheduled task) and check the broker app.")
    # 2. Cancel orders / close positions. If the app can't even be built, say what to do by hand.
    try:
        app = build_app(args.root, args.config, Mode.SIM)
        setup_logging(app.config.log_dir)
        report = execute_kill(app, flatten=args.flatten, reason=args.reason)
    except Exception as exc:
        _out(f"Could not cancel orders or close positions automatically ({type(exc).__name__}: {exc}).")
        _out("Cancel open orders and close positions BY HAND in the broker app.")
        return EXIT_ERROR
    _out("It stays on until you run `samsulek reset-halt --clear-kill` yourself.")
    _out(f"Cancelled open orders: {len(report.cancelled)}")
    if args.flatten:
        _out(f"Closed positions: {', '.join(report.flattened) or 'none'}")
    for item in report.not_flattened:
        _out(f"NOT CLOSED, do this by hand in the broker app: {item}")
    for err in report.errors:
        _out(f"ERROR: {err}")
    for note in report.notes:
        _out(f"NOTE: {note}")
    return EXIT_OK if report.complete else EXIT_ERROR


def cmd_reset_halt(args: argparse.Namespace) -> int:
    config, _ = load_configs(args.root, args.config)
    store = RiskStateStore(config.state_dir)
    try:
        require_interactive()
        what = "halt and KILL switch" if args.clear_kill else "halt"
        ok = confirm_phrase(
            f"You are about to clear the {what}. Only do this after you understand why it happened.",
            f"RESET {new_code()}",
        )
    except TerminalUnavailableError as exc:
        _out(f"Refused: {exc}")
        return EXIT_REFUSED
    if not ok:
        _out("Refused: confirmation did not match. Nothing changed.")
        return EXIT_REFUSED
    now = SystemClock().now()
    who = os.environ.get("USERNAME") or os.environ.get("USER") or "owner"
    store.clear_halt(now, by=who)
    _out("Halt cleared.")
    if args.clear_kill:
        store.clear_kill(now, by=who)
        _out("KILL switch cleared.")
    if args.rebase_peak:
        day = store.read_day()
        if day and day.last_equity > 0:
            store.write_peak(day.last_equity)
            _out(f"Peak equity reset to the last seen equity {_eur(day.last_equity)}.")
    return EXIT_OK


def cmd_reconcile(args: argparse.Namespace) -> int:
    config, _ = load_configs(args.root, args.config)
    try:
        app = build_app(args.root, args.config, Mode.SIM)
    except (ConfigError, StateCorruptError):
        raise
    except Exception as exc:
        return _halt_on_startup_failure(config.state_dir, exc)
    setup_logging(app.config.log_dir)
    try:
        account = sync_ledger(app)
    except SYNC_ERRORS as exc:
        halt_and_alert(app, "Cannot sync with broker", f"{type(exc).__name__}: {exc}")
        _out("MISMATCH: could not sync with the broker; trading halted, see alerts.")
        return EXIT_HALTED
    ok = reconcile_or_halt(app, account, "manual")
    _out("Reconciliation OK: ledger matches broker." if ok else "MISMATCH: trading halted, see alerts.")
    return EXIT_OK if ok else EXIT_HALTED


def build_parser() -> argparse.ArgumentParser:
    # allow_abbrev=False everywhere: an abbreviated option must never silently mean `--mode`.
    p = argparse.ArgumentParser(
        prog="samsulek", description="Fail-closed trading research system.", allow_abbrev=False
    )
    p.add_argument("--root", type=Path, default=Path.cwd(), help="project folder (default: current folder)")
    p.add_argument("--config", type=Path, default=Path("config/default.yaml"))
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser(
        "check-config", help="validate config files and print the risk limits in euros", allow_abbrev=False
    )
    sub.add_parser("status", help="show halt / kill switch / daily counters", allow_abbrev=False)
    run = sub.add_parser("run", help="run one trading cycle (default mode: sim)", allow_abbrev=False)
    run.add_argument("--mode", choices=[m.value for m in Mode], default=None)
    kill = sub.add_parser(
        "kill", help="EMERGENCY STOP: cancel orders, optionally close positions", allow_abbrev=False
    )
    kill.add_argument("--flatten", action="store_true", help="also close every position")
    kill.add_argument("--reason", default="manual kill switch")
    reset = sub.add_parser(
        "reset-halt", help="owner only, at a real terminal: clear a halt", allow_abbrev=False
    )
    reset.add_argument("--clear-kill", action="store_true", help="also clear the KILL switch")
    reset.add_argument("--rebase-peak", action="store_true", help="reset peak equity (after a withdrawal)")
    sub.add_parser(
        "reconcile", help="compare our records with the broker; halt on mismatch", allow_abbrev=False
    )
    return p


COMMANDS = {
    "check-config": cmd_check_config,
    "status": cmd_status,
    "run": cmd_run,
    "kill": cmd_kill,
    "reset-halt": cmd_reset_halt,
    "reconcile": cmd_reconcile,
}


def _early_logging() -> None:
    """Until setup_logging runs, errors still reach stderr only through the redaction filter."""
    root = logging.getLogger()
    if not root.handlers:
        handler = logging.StreamHandler()
        handler.addFilter(RedactingFilter())
        root.addHandler(handler)


def main(argv: Sequence[str] | None = None) -> int:
    _early_logging()
    args = build_parser().parse_args(argv)
    args.root = args.root.resolve()
    try:
        return COMMANDS[args.command](args)
    except ConfigError as exc:
        _out(f"Configuration error (nothing was traded):\n{exc}")
        return EXIT_ERROR
    except StateCorruptError as exc:
        _out(f"State unreadable (nothing was traded): {exc}")
        return EXIT_HALTED
    except Exception as exc:
        logging.getLogger(__name__).exception("unexpected error")
        _out(f"Unexpected error (nothing further was traded): {type(exc).__name__}: {exc}")
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
