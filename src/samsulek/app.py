"""Wires configuration into running components. One place, so every mode is built the same way."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from samsulek.alerts import ConsoleAlerter
from samsulek.clock import Clock, SystemClock
from samsulek.config import RISK_FILE, AppConfig, RiskConfig, load_app_config, load_risk_config
from samsulek.data.synthetic import SyntheticFeed
from samsulek.execution.router import OrderRouter
from samsulek.execution.sim_broker import SimBroker
from samsulek.logging_setup import DecisionLog
from samsulek.portfolio.ledger import Ledger
from samsulek.risk.engine import RiskEngine
from samsulek.risk.state import RiskStateStore
from samsulek.strategies.demo import EqualWeightAboveAverageDemo
from samsulek.types import Market, Mode, Quote

SIM_BROKER_FILE = "sim_broker.json"


class NotAvailableError(RuntimeError):
    """The requested mode is not built yet (paper: M5, live: M6)."""


@dataclass
class App:
    root: Path
    config: AppConfig
    risk_config: RiskConfig
    mode: Mode
    clock: Clock
    store: RiskStateStore
    log: DecisionLog
    alerter: ConsoleAlerter
    ledger: Ledger
    broker: SimBroker
    engine: RiskEngine
    router: OrderRouter
    feed: SyntheticFeed
    strategy: EqualWeightAboveAverageDemo

    def quotes_for(self, symbols: set[str]) -> dict[str, Quote]:
        quotes: dict[str, Quote] = {}
        for s in sorted(symbols):
            q = self.feed.quote(s)
            if q is not None:
                quotes[s] = q
        return quotes


def load_configs(root: Path, config_path: Path) -> tuple[AppConfig, RiskConfig]:
    config = load_app_config(config_path if config_path.is_absolute() else root / config_path, root)
    return config, load_risk_config(root / RISK_FILE)


def build_app(
    root: Path,
    config_path: Path,
    mode: Mode | None = None,
    clock: Clock | None = None,
    *,
    allow_unreadable_ledger: bool = False,
) -> App:
    """``allow_unreadable_ledger``: for the kill switch only. The broker can still be
    reached to cancel and close positions even if our own records are damaged."""
    config, risk_config = load_configs(root, config_path)
    mode = mode or config.mode
    if mode is Mode.PAPER:
        raise NotAvailableError("paper trading on the Trading 212 demo account arrives in milestone M5")
    if mode is Mode.LIVE:
        raise NotAvailableError("live trading does not exist yet (milestone M6, after paper trading)")
    clock = clock or SystemClock()
    store = RiskStateStore(config.state_dir)
    log = DecisionLog(config.log_dir, clock)
    alerter = ConsoleAlerter(log)
    stock_symbols = config.universe.get(Market.STOCKS, [])
    feed = SyntheticFeed(stock_symbols, Market.STOCKS, clock, seed=config.sim.seed)
    broker = SimBroker(
        starting_cash=config.sim.starting_cash_eur,
        fee_eur=config.sim.fee_eur,
        fee_bps=config.sim.fee_bps,
        slippage_bps=config.sim.slippage_bps,
        price_source=feed.quote,
        clock=clock,
        state_path=config.state_dir / SIM_BROKER_FILE,
    )
    try:
        ledger = Ledger(config.state_dir)
    except Exception as exc:
        if not allow_unreadable_ledger:
            raise
        ledger = Ledger.unreadable(config.state_dir, f"{type(exc).__name__}: {exc}")
    engine = RiskEngine(risk_config, store, clock, config.universe, log)
    router = OrderRouter(broker, engine, log, alerter, register_order=ledger.remember_order)
    return App(
        root=root,
        config=config,
        risk_config=risk_config,
        mode=mode,
        clock=clock,
        store=store,
        log=log,
        alerter=alerter,
        ledger=ledger,
        broker=broker,
        engine=engine,
        router=router,
        feed=feed,
        strategy=EqualWeightAboveAverageDemo(),
    )
