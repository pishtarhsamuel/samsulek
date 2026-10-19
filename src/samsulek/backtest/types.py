"""The backtester's contract (M3): modes, errors, plans, jobs, per-run records and summaries.

Facts every other backtest module relies on:
- Every dataclass here is frozen, and every one pickles: ``RunJob`` and ``EngineContext``
  are sent to spawned worker processes and ``RunResult``/``RunSummary`` come back the same
  way. So every field value must pickle too (``PitDataset`` and ``StockCostParams``
  included: no ``MappingProxyType``, no lambdas, no open files).
- The two errors pickle as well, rebuilt from their own fields (an exception normally
  unpickles as ``cls(*args)``, which would lose them).
- Money, prices and quantities are ``Decimal`` EUR; bars, weights, returns and metrics
  are ``float``. Datetimes are tz-aware UTC. A ``date`` called ``session`` is a Xetra
  session date.
- Two risk modes: ``L`` replays ``config/risk.yaml`` verbatim; ``R`` uses the research
  limits derived from it (see ``backtest/limits.py``). The edge verdict uses R; the
  realism block uses L.
- ``Params`` are sorted ``(name, value)`` tuples (``strategies/params.py``), and
  ``params_sha256`` is the sha256 of their canonical JSON: the key of a trial.
- ``PitDataset`` and ``StockCostParams`` are imported for type checking only, so this
  module imports nothing else from the backtester (no import cycle).
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from enum import StrEnum
from itertools import pairwise
from typing import TYPE_CHECKING, Any, Final

from samsulek.config import RiskConfig
from samsulek.strategies.params import Params, as_params
from samsulek.types import Fill

if TYPE_CHECKING:
    from samsulek.backtest.dataset import PitDataset
    from samsulek.costs.stocks import StockCostParams

# Labels become file names (equity_<label>.csv): letters, digits and "_" only. Upper case is
# allowed for the mode letters ("strategy_R_1x"); Windows ignores case, so a batch must not
# hold two labels that differ only in case (checked where files are written).
_LABEL: Final = re.compile(r"[A-Za-z0-9_]+")
_NO_DELAY: Final = timedelta(0)
_DEFAULT_RESET_LEAD: Final = timedelta(minutes=30)


class RiskMode(StrEnum):
    L = "L"  # config/risk.yaml verbatim (the realism block)
    R = "R"  # the research limits from backtest/limits.py (the edge verdict)


class Period(StrEnum):
    RESEARCH = "research"
    HOLDOUT = "holdout"


class Detail(StrEnum):
    FULL = "full"  # everything, including the gzipped decision log
    RETURNS = "returns"  # metrics plus the session dates and daily returns
    METRICS = "metrics"  # metrics only


class HaltKind(StrEnum):
    DAILY_LOSS = "daily_loss"
    DRAWDOWN = "drawdown"
    EQUITY_SANITY = "equity_sanity"
    CAP_DRIFT = "cap_drift"


class BacktestRefused(ValueError):
    """Refused before any cycle ran: CLI exit 3, nothing written to the trial registry.

    ``problems`` lists EVERY problem found, so the owner can fix them in one go. A single
    string counts as one problem. A subclass with a different ``__init__`` must also
    override ``__reduce__``.
    """

    problems: tuple[str, ...]

    def __init__(self, problems: Sequence[str]) -> None:
        items = (problems,) if isinstance(problems, str) else tuple(problems)
        self.problems = tuple(str(p) for p in items) or ("refused without a stated reason (a bug)",)
        super().__init__("; ".join(self.problems))

    def __reduce__(self) -> tuple[Any, ...]:
        return (type(self), (self.problems,))


class BacktestIntegrityError(RuntimeError):
    """A bug or bad data found during a run: the run is void (CLI exit 1), never a result."""

    reason: str
    session: date | None
    label: str

    def __init__(self, reason: str, *, session: date | None, label: str) -> None:
        self.reason = reason
        self.session = session
        self.label = label
        where = f" at session {session.isoformat()}" if session is not None else ""
        super().__init__(f"{label}{where}: {reason}")

    def __reduce__(self) -> tuple[Any, ...]:
        return (_rebuild_integrity_error, (type(self), self.reason, self.session, self.label))


def _rebuild_integrity_error(
    cls: type[BacktestIntegrityError], reason: str, session: date | None, label: str
) -> BacktestIntegrityError:
    return cls(reason, session=session, label=label)


@dataclass(frozen=True, slots=True)
class ExecutionTiming:
    """When a session's decision runs. Ranges are checked by ``runner.check_timing`` (a refusal)."""

    exec_delay: timedelta = _NO_DELAY  # 0..10 min after the open-print label
    reset_lead: timedelta = _DEFAULT_RESET_LEAD  # 1..120 min before E (modeled owner reset)


def params_sha256(params: Params) -> str:
    """sha256 of the canonical JSON object of ``params`` (sorted keys, no spaces, ASCII)."""
    names = [name for name, _ in params]
    if len(set(names)) != len(names) or as_params(dict(params)) != tuple(params):
        raise ValueError("params must be sorted by name, with unique names (build them with as_params)")
    text = json.dumps(dict(params), sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)
    return hashlib.sha256(text.encode("ascii")).hexdigest()


@dataclass(frozen=True, slots=True)
class Variant:
    """One point of a study's grid. Every variant is a registered trial."""

    index: int
    params: Params
    params_sha256: str

    def __post_init__(self) -> None:
        if self.index < 0:
            raise ValueError(f"variant index must be >= 0, got {self.index}")
        if self.params_sha256 != params_sha256(self.params):
            raise ValueError(f"variant {self.index}: params_sha256 does not match its params")


@dataclass(frozen=True, slots=True)
class RegistryPlan:
    """A catalog strategy whose parameters change at fold starts (walk-forward)."""

    strategy: str
    segments: tuple[tuple[date, Params], ...]  # segment i applies from its date on
    lag_sessions: int = 0  # 0..5 extra sessions of delay (strategies.wrappers.Lagged)

    def __post_init__(self) -> None:
        if not self.strategy:
            raise ValueError("a registry plan needs a strategy name")
        if not self.segments:
            raise ValueError("a registry plan needs at least one segment")
        if any(a[0] >= b[0] for a, b in pairwise(self.segments)):
            raise ValueError("plan segments must be sorted by start date, without repeats")
        if not 0 <= self.lag_sessions <= 5:
            raise ValueError(f"lag_sessions must be 0..5, got {self.lag_sessions}")


@dataclass(frozen=True, slots=True)
class BuyAndHoldPlan:
    weights0: tuple[tuple[str, float], ...]  # starting weight per symbol
    anchor_closes: tuple[tuple[str, float], ...]  # adjusted closes the weights are anchored at


@dataclass(frozen=True, slots=True)
class RandomEntriesPlan:
    seed: int
    # per symbol: (first session, end session (exclusive), weight) episodes, never overlapping
    schedule: tuple[tuple[str, tuple[tuple[date, date, float], ...]], ...]


StrategyPlan = RegistryPlan | BuyAndHoldPlan | RandomEntriesPlan


@dataclass(frozen=True, slots=True)
class RunJob:
    """One backtest run. Pure data: the same job on the same context gives the same result."""

    index: int  # position in the batch; results come back in this order
    label: str  # [A-Za-z0-9_]+ e.g. "strategy_R_1x", "random_R_2x_s0412", "variant_007"
    plan: StrategyPlan
    universe: tuple[str, ...]  # sorted candidate symbols (engine allow-list); per session: listed()
    min_history: int  # bars needed before a symbol joins the universe (= study max window)
    first_session: date  # first trading cycle
    last_session: date  # last cycle, inclusive; marked at its close
    risk_mode: RiskMode
    cost_multiplier: int  # 1 or 2
    starting_cash_eur: Decimal
    detail: Detail

    def __post_init__(self) -> None:
        if self.index < 0:
            raise ValueError(f"job index must be >= 0, got {self.index}")
        if not _LABEL.fullmatch(self.label):
            raise ValueError(f"job label must match [A-Za-z0-9_]+, got {self.label!r}")
        if not self.universe or list(self.universe) != sorted(set(self.universe)):
            raise ValueError("job universe must be non-empty, sorted and without repeats")
        if self.min_history < 0:
            raise ValueError(f"min_history must be >= 0, got {self.min_history}")
        if self.first_session > self.last_session:
            raise ValueError(f"first session {self.first_session} is after last session {self.last_session}")
        if not isinstance(self.risk_mode, RiskMode) or not isinstance(self.detail, Detail):
            raise ValueError("risk_mode and detail must be RiskMode and Detail members")
        if isinstance(self.cost_multiplier, bool) or self.cost_multiplier not in (1, 2):
            raise ValueError(f"cost_multiplier must be 1 or 2, got {self.cost_multiplier!r}")
        cash = self.starting_cash_eur
        if not isinstance(cash, Decimal) or not cash.is_finite() or cash <= 0:
            raise ValueError(f"starting cash must be a finite Decimal > 0, got {cash!r}")


@dataclass(frozen=True, slots=True)
class ModeConfigs:
    """The two risk configurations and the sha256 of each file's bytes."""

    replay: RiskConfig  # mode L
    research: RiskConfig  # mode R
    replay_sha256: str
    research_sha256: str

    def for_mode(self, mode: RiskMode) -> RiskConfig:
        return {RiskMode.L: self.replay, RiskMode.R: self.research}[RiskMode(mode)]


@dataclass(frozen=True, slots=True)
class EngineContext:
    """Everything a run needs besides its job. Picklable: sent once to each worker."""

    dataset: PitDataset
    modes: ModeConfigs
    costs: StockCostParams
    timing: ExecutionTiming
    quantity_step: Decimal
    price_tick: Decimal


@dataclass(frozen=True, slots=True)
class EquityPoint:
    session: date
    ts: datetime  # the mark instant: close_utc(session), or ts_0 for the start
    cash: Decimal
    gross: Decimal
    equity: Decimal


@dataclass(frozen=True, slots=True)
class FillRecord:
    session: date
    fill: Fill
    reference: Decimal  # the raw open print in EUR the fill was priced from
    spread_eur: Decimal
    slippage_eur: Decimal


@dataclass(frozen=True, slots=True)
class SessionRecord:
    session: date
    status: str  # the cycle report status: "done" | "halted" | "blocked" | "error"
    universe: tuple[str, ...]
    reset_before: bool  # a modeled owner reset ran before this cycle
    orders_planned: int
    orders_sent: int
    orders_rejected: int
    rejections: tuple[str, ...]
    targets: tuple[tuple[str, float], ...]
    actual: tuple[tuple[str, float], ...]  # qty x raw open / open equity, after the cycle
    open_equity: Decimal | None


@dataclass(frozen=True, slots=True)
class HaltEvent:
    session: date
    ts: datetime
    kinds: tuple[HaltKind, ...]
    reasons: tuple[str, ...]
    reset_at: datetime | None  # when the modeled owner reset cleared it (L only)
    peak_rebased_to: Decimal | None
    immediate_rehalt: bool  # halted again right after a reset, before any order was sent


@dataclass(frozen=True, slots=True)
class Episode:
    """One holding of one symbol, from the buy that opened it to the sell that closed it."""

    symbol: str
    entry_session: date
    exit_session: date | None
    sessions_held: int
    weight: float  # mean target weight over [entry, exit)
    buy_eur: Decimal
    sell_eur: Decimal
    fees_eur: Decimal
    pnl_eur: Decimal
    open_at_end: bool


@dataclass(frozen=True, slots=True)
class HaltSummary:
    n_halts: int
    sessions_halted: int
    immediate_rehalts: int
    first_halt_session: date | None  # without resets the account would have stopped here
    first_halt_equity: Decimal | None
    equity_sanity_halts: int
    cap_drift_halts: int
    hard_stop_active_at_end: bool
    frozen_end_equity: Decimal | None


@dataclass(frozen=True)
class RunResult:
    job: RunJob
    start_ts: datetime  # ts_0 = close_utc(previous_session(first_session))
    start_equity: Decimal
    equity: tuple[EquityPoint, ...]
    sessions: tuple[SessionRecord, ...]
    fills: tuple[FillRecord, ...]
    halts: tuple[HaltEvent, ...]
    episodes: tuple[Episode, ...]
    residual_eur: Decimal  # sum(pnl) + residual == equity[-1].equity - start_equity, exactly
    frozen_equity: tuple[EquityPoint, ...]
    decisions_gz: bytes | None  # Detail.FULL only
    data_fingerprint: str
    risk_config_sha256: str


@dataclass(frozen=True, slots=True)
class Metrics:
    first_session: date
    last_session: date
    n_returns: int
    years: float
    total_return: float
    cagr: float | None
    ann_vol: float | None
    sharpe: float | None
    sortino: float | None
    sr_per_period: float | None
    skew: float | None
    kurtosis: float | None
    max_drawdown: float
    mdd_peak: date | None
    mdd_trough: date | None
    mdd_recovery: date | None
    mdd_duration_sessions: int
    mdd_duration_days: int
    longest_underwater_sessions: int
    recovered: bool
    n_episodes_closed: int
    n_episodes_open: int
    win_rate: float | None
    avg_win_eur: float | None
    avg_loss_eur: float | None
    avg_win_pct: float | None
    avg_loss_pct: float | None
    profit_factor: float | None
    turnover: float
    exposure: float
    time_in_market: float
    weight_gap: float
    n_fills: int
    fees_eur: float
    spread_eur: float
    slippage_eur: float
    cost_drag_bps_per_year: float
    n_rejections: int


@dataclass(frozen=True, slots=True)
class RunSummary:
    job: RunJob
    sessions: tuple[date, ...] | None  # Detail.RETURNS keeps them; METRICS drops them
    returns: tuple[float, ...] | None
    metrics: Metrics
    halts: HaltSummary
