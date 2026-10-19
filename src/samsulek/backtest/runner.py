"""One backtest run: fresh in-memory parts, one forward-only clock, the bot's own cycle (M3 skeleton; WP4).

``run_backtest`` refuses (``BacktestRefused``) before the first cycle on bad timing, a job
outside its fence, missing warm-up or a cost model that could leave approved orders
unfilled. Then, per session: a modeled owner reset (mode L only) at ``reset_at``; the
clock to E; pre-checks; ``run_unlocked_cycle`` (the SAME core as ``samsulek run``); halt
classification; audits (no open orders, reconcile, every fill at E at the oracle price);
records; and the mark at the close. Any surprise is a ``BacktestIntegrityError``: the run
is void. ``build_parts`` builds new parts for every run (it may be referenced only here),
so nothing carries over between runs. Never writes files.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import ClassVar

from samsulek.backtest.clock import MonotoneClock
from samsulek.backtest.feed import BacktestFeed
from samsulek.backtest.inmemory import MemoryDecisionLog, MemoryLedger, MemoryRiskStateStore, RecordingAlerter
from samsulek.backtest.types import EngineContext, ExecutionTiming, RunJob, RunResult
from samsulek.config import MarketLimits, RiskConfig
from samsulek.costs.stocks import StockCostModel
from samsulek.execution.router import OrderRouter
from samsulek.execution.sim_broker import SimBroker
from samsulek.risk.engine import RiskEngine
from samsulek.types import Mode, Quote

FeedFactory = Callable[..., BacktestFeed]  # same keyword signature as BacktestFeed; planted feeds subclass it


@dataclass(frozen=True, slots=True)
class BacktestParts:
    """Everything one cycle needs (satisfies ``cycle.CycleParts``). Built fresh for every run."""

    in_memory: ClassVar[bool] = True
    mode: Mode  # always Mode.SIM
    clock: MonotoneClock
    broker: SimBroker
    ledger: MemoryLedger
    engine: RiskEngine
    router: OrderRouter
    log: MemoryDecisionLog
    alerter: RecordingAlerter
    risk_config: RiskConfig
    feed: BacktestFeed
    store: MemoryRiskStateStore
    pricer: StockCostModel

    def quotes_for(self, symbols: set[str]) -> dict[str, Quote]:
        raise NotImplementedError("WP4")


def check_timing(timing: ExecutionTiming, limits: MarketLimits) -> list[str]:
    raise NotImplementedError("WP4")


def build_parts(
    job: RunJob, ctx: EngineContext, *, feed_factory: FeedFactory = BacktestFeed
) -> BacktestParts:
    raise NotImplementedError("WP4")


def run_backtest(job: RunJob, ctx: EngineContext, *, feed_factory: FeedFactory = BacktestFeed) -> RunResult:
    raise NotImplementedError("WP4")
