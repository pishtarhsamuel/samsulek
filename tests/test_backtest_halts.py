"""Which halts a backtest models, and what it does with them (spec C11, C12, Q2; WP4).

- ``classify_halt`` is pinned to halt reasons produced by the REAL risk engine and the REAL
  cycle (nothing here copies a message string), so a wording change in either fails a
  test instead of silently changing what a backtest models.
- Every non-limit halt (missing prices, stale data, sizing errors, broker or ledger
  trouble, zero equity, a clock that moved backwards, unreadable state, anything
  unexpected) voids the run.
- A position-cap halt is modeled only when it comes from price drift: one right after a
  buy of the same symbol in the same cycle is a sizing bug and voids the run.
- Equity-sanity halts re-halt every session (no reset helps; the owner must change the
  config). Mode R never resets: a hard stop freezes the account and later cycles are
  blocked. The modeled owner never clears the KILL flag and rebases the peak only after a
  drawdown halt.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from samsulek.backtest.baselines import buy_and_hold_plan
from samsulek.backtest.book import summarize_halts
from samsulek.backtest.clock import session_times
from samsulek.backtest.dataset import Listing, PitDataset
from samsulek.backtest.feed import BacktestFeed
from samsulek.backtest.fence import RESEARCH_DATA_CUTOFF
from samsulek.backtest.halts import (
    ResetPolicy,
    apply_reset_policy,
    cap_drift_symbols,
    classify_halt,
    reset_policy_for,
)
from samsulek.backtest.inmemory import MemoryRiskStateStore
from samsulek.backtest.limits import derive_research_config
from samsulek.backtest.plans import plan_window, strategy_for_session
from samsulek.backtest.runner import build_parts, run_backtest
from samsulek.backtest.sources import SourceData
from samsulek.backtest.synthetic_data import synthetic_daily_bars
from samsulek.backtest.types import (
    BacktestIntegrityError,
    BuyAndHoldPlan,
    Detail,
    EngineContext,
    ExecutionTiming,
    HaltKind,
    ModeConfigs,
    RegistryPlan,
    RiskMode,
    RunJob,
    RunResult,
    StrategyPlan,
)
from samsulek.clock import FixedClock
from samsulek.config import RiskConfig, load_risk_config
from samsulek.costs.stocks import StockCostParams
from samsulek.cycle import CycleSpec, run_unlocked_cycle
from samsulek.data.calendars import XetraCalendar
from samsulek.execution.broker import BrokerError
from samsulek.risk.engine import RiskEngine
from samsulek.risk.state import DayState, RiskStateStore
from samsulek.strategies.base import StrategyContext
from samsulek.strategies.params import as_params
from samsulek.types import Market, Quote, Side, TargetWeights

ROOT = Path(__file__).resolve().parents[1]
CAL = XetraCalendar()
LIVE_LIMITS = load_risk_config(ROOT / "config" / "risk.yaml")
DATA_FIRST = date(2020, 1, 2)
SESSIONS = CAL.sessions(DATA_FIRST, date(2020, 12, 30))
FIRST = SESSIONS[25]
LAST = SESSIONS[70]
DEMO = RegistryPlan("demo_above_average", ((FIRST, as_params({"lookback": 10, "gross": 0.9})),))


# ----------------------------------------------------------------------------- builders
def dataset(
    symbols: Sequence[str], *, gaps: Mapping[date, float] | None = None, seed: int = 11
) -> PitDataset:
    """Synthetic bars; from each ``gaps`` session's open on, every price times its factor."""
    raw = synthetic_daily_bars(symbols, CAL, DATA_FIRST, LAST, seed=seed, vol=0.006, gap_vol=0.003)
    rows = []
    for symbol in symbols:
        factor = 1.0
        for bar in raw[symbol]:
            factor *= (gaps or {}).get(bar.session, 1.0)
            assert bar.open is not None and bar.high is not None and bar.low is not None
            rows.append(
                replace(
                    bar,
                    open=bar.open * factor,
                    high=bar.high * factor,
                    low=bar.low * factor,
                    close=bar.close * factor,
                )
            )
    listings = tuple(Listing(s, "EUR", DATA_FIRST, None, None, "synthetic (test)") for s in symbols)
    data = SourceData("synthetic", True, tuple(rows), listings, (), None)
    return PitDataset.build(data, calendar=CAL, cutoff=RESEARCH_DATA_CUTOFF)


def limits(**changes: Any) -> RiskConfig:
    """The live limits with some leaves changed: {"account.x": v, "stocks.y": v}."""
    data = LIVE_LIMITS.model_dump(mode="python")
    for key, value in changes.items():
        part, leaf = key.split("__")
        target = data["account"] if part == "account" else data["markets"][Market(part)]
        target[leaf] = value
    return RiskConfig.model_validate(data)


def context(ds: PitDataset, replay: RiskConfig = LIVE_LIMITS) -> EngineContext:
    symbols = ds.symbols()
    modes = ModeConfigs(
        replay=replay,
        research=derive_research_config(replay),
        replay_sha256="test-replay",
        research_sha256="test-research",
    )
    costs = StockCostParams(
        half_spread_bps={s: Decimal(10) for s in symbols},
        slippage_bps=Decimal(5),
        adverse_bps=Decimal(0),
        fx_fee_bps=Decimal(15),
        commission_eur=Decimal(0),
        currency={s: "EUR" for s in symbols},
    )
    return EngineContext(
        dataset=ds,
        modes=modes,
        costs=costs,
        timing=ExecutionTiming(),
        quantity_step=Decimal("0.000001"),
        price_tick=Decimal("0.0001"),
    )


def job(
    plan: StrategyPlan, universe: Sequence[str], *, mode: RiskMode = RiskMode.L, label: str = "t"
) -> RunJob:
    return RunJob(
        index=0,
        label=label,
        plan=plan,
        universe=tuple(sorted(universe)),
        min_history=20,
        first_session=FIRST,
        last_session=LAST,
        risk_mode=mode,
        cost_multiplier=1,
        starting_cash_eur=Decimal(50),
        detail=Detail.FULL,
    )


def buy_and_hold(ds: PitDataset, ctx: EngineContext, universe: Sequence[str]) -> BuyAndHoldPlan:
    return buy_and_hold_plan(
        ds,
        sorted(universe),
        limits=ctx.modes.replay.limits_for(Market.STOCKS),
        first_session=FIRST,
        execute_at=session_times(CAL, FIRST, ctx.timing).execute,
        min_bars=20,
    )


def halt_reasons_of(store: MemoryRiskStateStore) -> tuple[str, ...]:
    halt = store.read_halt()
    assert halt.active
    return halt.reasons


# ------------------------------------------------------ classify_halt vs the real engine
def engine_on(store: MemoryRiskStateStore, clock: FixedClock, config: RiskConfig = LIVE_LIMITS) -> RiskEngine:
    return RiskEngine(config, store, clock, {Market.STOCKS: ["A"]}, None)


T = datetime(2020, 3, 2, 8, 5, tzinfo=UTC)


def test_the_engine_limit_halts_are_classified() -> None:
    """Daily loss, drawdown and equity sanity, each produced by observe_equity itself."""
    store, clock = MemoryRiskStateStore(), FixedClock(T)
    engine = engine_on(store, clock)
    assert engine.observe_equity(Decimal(50)) == []
    loss = engine.observe_equity(Decimal(48))
    assert [classify_halt(r) for r in loss] == [HaltKind.DAILY_LOSS]

    store = MemoryRiskStateStore()
    store.write_peak(Decimal(100))
    drawdown = engine_on(store, clock).observe_equity(Decimal(84))
    assert [classify_halt(r) for r in drawdown] == [HaltKind.DRAWDOWN]

    both = engine_on(MemoryRiskStateStore(), clock)
    both.observe_equity(Decimal(100))
    clock.set(T + timedelta(days=1))
    assert sorted(classify_halt(r) or "" for r in both.observe_equity(Decimal(80))) == [
        HaltKind.DAILY_LOSS,
        HaltKind.DRAWDOWN,
    ]

    sanity = engine_on(MemoryRiskStateStore(), FixedClock(T)).observe_equity(Decimal(250))
    assert [classify_halt(r) for r in sanity] == [HaltKind.EQUITY_SANITY]
    r_sanity = engine_on(
        MemoryRiskStateStore(), FixedClock(T), limits(account__equity_sanity_max_eur=Decimal(40))
    )
    assert [classify_halt(r) for r in r_sanity.observe_equity(Decimal("50.123456"))] == [
        HaltKind.EQUITY_SANITY
    ]


def test_the_engine_non_limit_halts_are_not_modeled() -> None:
    """Zero, negative and invalid equity, a clock that moved backwards, unreadable state."""
    reasons: list[str] = []
    for bad in (Decimal(0), Decimal(-1), Decimal("NaN")):
        reasons += engine_on(MemoryRiskStateStore(), FixedClock(T)).observe_equity(bad)
    store = MemoryRiskStateStore()
    store.write_day(DayState(day=date(2020, 3, 5), day_start_equity=Decimal(50), last_equity=Decimal(50)))
    reasons += engine_on(store, FixedClock(T)).observe_equity(Decimal(50))
    broken = MemoryRiskStateStore()
    broken.files["risk_day.json"] = "{"
    reasons += engine_on(broken, FixedClock(T)).observe_equity(Decimal(50))
    assert len(reasons) == 5
    assert [classify_halt(r) for r in reasons] == [None] * 5


def test_classification_is_exact_not_a_prefix() -> None:
    store, clock = MemoryRiskStateStore(), FixedClock(T)
    engine = engine_on(store, clock)
    engine.observe_equity(Decimal(50))
    (loss,) = engine.observe_equity(Decimal(48))
    assert classify_halt(loss) is HaltKind.DAILY_LOSS
    for planted in (f"{loss} (and more)", f"x{loss}", "daily loss counter could not be read", "drawdown "):
        assert classify_halt(planted) is None, planted
    assert cap_drift_symbols(loss) == ()


# ------------------------------------------------------- non-limit halts of a real cycle
class _Raising:
    name = "raising"

    def __init__(self, exc: Exception) -> None:
        self._exc = exc

    def target_weights(self, ctx: StrategyContext) -> TargetWeights:
        raise self._exc


class _NaN:
    name = "nan"

    def target_weights(self, ctx: StrategyContext) -> TargetWeights:
        return TargetWeights(weights=dict.fromkeys(ctx.bars, float("nan")), reason="planted")


class MissingQuoteFeed(BacktestFeed):
    """Planted: no price for B (the dataset has its open print)."""

    def quote(self, symbol: str) -> Quote | None:
        return None if symbol == "B" else super().quote(symbol)


class StaleBarsFeed(BacktestFeed):
    """Planted: hides each symbol's newest bar, so the data is one session behind."""

    def bars_until(self, asof: datetime) -> dict[str, tuple[Any, ...]]:
        return {s: bars[:-1] for s, bars in super().bars_until(asof).items()}


class BrokenQuoteFeed(BacktestFeed):
    """Planted: the price source itself fails."""

    def quote(self, symbol: str) -> Quote | None:
        raise RuntimeError("price source down")


def _cycle_halt(
    ds: PitDataset, strategy: Any = None, *, feed: type[BacktestFeed] = BacktestFeed, before: Any = None
) -> tuple[str, tuple[str, ...]]:
    """One real in-memory cycle at FIRST (after one clean cycle if ``before``); its halt."""
    ctx = context(ds)
    the_job = job(DEMO, ds.symbols())
    parts = build_parts(the_job, ctx, feed_factory=feed)
    universe = ds.symbols()

    def spec(strategy_: Any) -> CycleSpec:
        return CycleSpec(
            market=Market.STOCKS,
            universe=universe,
            strategy=strategy_,
            quantity_step=ctx.quantity_step,
            price_tick=ctx.price_tick,
            calendar=parts.feed.calendar,
            bar_window=plan_window(DEMO),
        )

    times = session_times(CAL, FIRST, ctx.timing)
    parts.clock.set(times.execute)
    if before is not None:
        assert run_unlocked_cycle(parts, spec(strategy_for_session(DEMO, FIRST))).status == "done"
        before(parts)
        parts.clock.set(session_times(CAL, CAL.next_session(FIRST), ctx.timing).execute)
    report = run_unlocked_cycle(parts, spec(strategy or strategy_for_session(DEMO, FIRST)))
    assert report.status in {"halted", "error"}, report
    return report.status, halt_reasons_of(parts.store)


def test_every_non_limit_halt_of_a_real_cycle_is_not_modeled() -> None:
    ds = dataset(("A", "B", "C"))

    def broker_down(parts: Any) -> None:
        parts.broker.fail_next = BrokerError("broker unreachable")

    def ledger_off(parts: Any) -> None:
        parts.ledger.cash += Decimal(1)

    produced = [
        _cycle_halt(ds, _Raising(ValueError("bad window"))),
        _cycle_halt(ds, _Raising(RuntimeError("strategy bug"))),
        _cycle_halt(ds, _NaN()),
        _cycle_halt(ds, feed=MissingQuoteFeed),
        _cycle_halt(ds, feed=StaleBarsFeed),
        _cycle_halt(ds, feed=BrokenQuoteFeed),
        _cycle_halt(ds, before=broker_down),
        _cycle_halt(ds, before=ledger_off),
    ]
    reasons = [r for _, rs in produced for r in rs]
    assert len(reasons) >= len(produced)
    assert [classify_halt(r) for r in reasons] == [None] * len(reasons), reasons
    titles = {r.split(":", 1)[0] for r in reasons}
    assert {"Strategy/sizing error", "Missing prices", "Stale or missing data"} <= titles, titles
    assert "Unexpected error in the trading cycle" in titles
    assert {"Cannot sync with broker", "Ledger and broker disagree"} <= titles, titles


@pytest.mark.parametrize(
    ("feed", "expect"),
    [
        (MissingQuoteFeed, "not a modeled limit halt (a bug or bad data): Missing prices"),
        (StaleBarsFeed, "not a modeled limit halt (a bug or bad data): Stale or missing data"),
        (BrokenQuoteFeed, "the cycle ended in an error"),
    ],
)
def test_a_non_limit_halt_voids_the_run(feed: type[BacktestFeed], expect: str) -> None:
    ds = dataset(("A", "B", "C"))
    with pytest.raises(BacktestIntegrityError) as caught:
        run_backtest(job(DEMO, ds.symbols(), label="void_me"), context(ds), feed_factory=feed)
    assert expect in caught.value.reason
    assert caught.value.session == FIRST
    assert caught.value.label == "void_me"


# ---------------------------------------------------------------------------- cap drift
GAP_DAY = SESSIONS[35]


def test_cap_drift_from_price_moves_is_a_modeled_halt() -> None:
    """One trade a day: the +50% gap lets only A's sell through, so B ends above its cap
    without having been bought that session: a real, resettable live halt."""
    ds = dataset(("A", "B"), gaps={GAP_DAY: 1.5})
    ctx = context(ds, limits(stocks__max_trades_per_day=1))
    result = run_backtest(job(buy_and_hold(ds, ctx, ("A", "B")), ("A", "B")), ctx)
    (event,) = result.halts
    assert event.session == GAP_DAY and event.kinds == (HaltKind.CAP_DRIFT,)
    assert len(event.reasons) == 1 and classify_halt(event.reasons[0]) is HaltKind.CAP_DRIFT
    assert cap_drift_symbols(event.reasons[0]) == ("B",)
    gap_fills = [r.fill for r in result.fills if r.session == GAP_DAY]
    assert [(f.symbol, f.side) for f in gap_fills] == [("A", Side.SELL)]
    assert event.reset_at == session_times(CAL, CAL.next_session(GAP_DAY), ctx.timing).reset_at
    assert event.peak_rebased_to is None
    after = [r for r in result.fills if r.session == CAL.next_session(GAP_DAY)]
    assert [(r.fill.symbol, r.fill.side) for r in after] == [("B", Side.SELL)], (
        "the reset lets B's sell through"
    )
    summary = summarize_halts(result)
    assert (summary.n_halts, summary.cap_drift_halts, summary.sessions_halted) == (1, 1, 1)


class InflateAfterBuyFeed(BacktestFeed):
    """Planted sizing bug: at FIRST, A's third quote of the cycle (the end-of-cycle valuation,
    after the start quotes and the fill) is 50% higher."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.calls = 0

    def quote(self, symbol: str) -> Quote | None:
        found = super().quote(symbol)
        if symbol != "A" or found is None or found.ts != CAL.open_print_utc(FIRST):
            return found
        self.calls += 1
        return replace(found, price=found.price * Decimal("1.5")) if self.calls == 3 else found


def test_cap_drift_right_after_a_buy_voids_the_run() -> None:
    ds = dataset(("A", "B", "C"))
    ctx = context(ds)
    with pytest.raises(BacktestIntegrityError) as caught:
        run_backtest(
            job(buy_and_hold(ds, ctx, ds.symbols()), ds.symbols()), ctx, feed_factory=InflateAfterBuyFeed
        )
    assert "position cap exceeded right after buying A" in caught.value.reason
    assert caught.value.session == FIRST


# ------------------------------------------------------------------ re-halts, hard stops
def test_equity_sanity_halts_again_every_session() -> None:
    """EUR 50 above a EUR 45 sanity maximum: every reset is followed by an immediate re-halt."""
    ds = dataset(("A", "B", "C"))
    ctx = context(ds, limits(account__equity_sanity_max_eur=Decimal(45)))
    result = run_backtest(job(DEMO, ds.symbols()), ctx)
    n = len(result.sessions)
    assert [h.kinds for h in result.halts] == [(HaltKind.EQUITY_SANITY,)] * n
    assert [h.immediate_rehalt for h in result.halts] == [False] + [True] * (n - 1)
    assert all(h.reset_at is not None for h in result.halts[:-1]) and result.halts[-1].reset_at is None
    assert result.fills == ()
    summary = summarize_halts(result)
    assert (summary.n_halts, summary.sessions_halted, summary.immediate_rehalts) == (n, n, n - 1)
    assert summary.equity_sanity_halts == n and summary.first_halt_session == FIRST
    assert summary.first_halt_equity == Decimal(50) and not summary.hard_stop_active_at_end
    assert [p.equity for p in result.frozen_equity] == [Decimal(50)] * n
    assert summary.frozen_end_equity == Decimal(50)
    # Mode R: the research sanity maximum is far away, so nothing halts there.
    r_result = run_backtest(job(DEMO, ds.symbols(), mode=RiskMode.R), ctx)
    assert r_result.halts == () and r_result.frozen_equity == ()


CRASH = SESSIONS[40]


def _crash_runs() -> tuple[RunResult, RunResult]:
    ds = dataset(("A", "B", "C"), gaps={CRASH: 0.4})
    ctx = context(ds)
    plan = buy_and_hold(ds, ctx, ds.symbols())
    return (
        run_backtest(job(plan, ds.symbols(), mode=RiskMode.R, label="bh_R"), ctx),
        run_backtest(job(plan, ds.symbols(), mode=RiskMode.L, label="bh_L"), ctx),
    )


def test_an_r_mode_hard_stop_freezes_the_account() -> None:
    """A 60% crash at 90% invested trips the 50% research daily-loss stop: never reset."""
    r_run, l_run = _crash_runs()
    (stop,) = r_run.halts
    assert stop.session == CRASH and stop.kinds == (HaltKind.DAILY_LOSS,)
    assert stop.reset_at is None and stop.peak_rebased_to is None
    statuses = {s.session: s.status for s in r_run.sessions}
    assert statuses[CRASH] == "halted"
    assert {st for d, st in statuses.items() if d > CRASH} == {"blocked"}
    assert not any(s.reset_before for s in r_run.sessions)
    assert all(r.session < CRASH for r in r_run.fills), "nothing trades after the stop"
    frozen = [s.actual for s in r_run.sessions if s.session >= CRASH]
    assert all(dict(a).keys() == {"A", "B", "C"} for a in frozen)
    summary = summarize_halts(r_run)
    assert summary.hard_stop_active_at_end and summary.sessions_halted == sum(
        1 for d in statuses if d >= CRASH
    )
    assert r_run.frozen_equity == ()
    # Mode L on the same data: daily loss and drawdown, reset with a rebased peak, trading on.
    first = l_run.halts[0]
    assert first.session == CRASH and set(first.kinds) == {HaltKind.DAILY_LOSS, HaltKind.DRAWDOWN}
    assert first.reset_at is not None and first.peak_rebased_to is not None
    assert not summarize_halts(l_run).hard_stop_active_at_end
    assert l_run.frozen_equity and l_run.frozen_equity[0].session == CRASH


# ------------------------------------------------------------------- the modeled owner
def test_reset_policies() -> None:
    assert reset_policy_for(RiskMode.L) is ResetPolicy.NEXT_SESSION
    assert reset_policy_for(RiskMode.R) is ResetPolicy.NEVER


def test_the_modeled_owner_never_clears_the_kill_flag_and_rebases_only_after_drawdowns() -> None:
    at = T + timedelta(days=1)
    for kinds, rebased in (
        ([HaltKind.DAILY_LOSS], None),
        ([HaltKind.EQUITY_SANITY], None),
        ([HaltKind.CAP_DRIFT], None),
        ([HaltKind.DAILY_LOSS, HaltKind.DRAWDOWN], Decimal("41.5")),
        ([HaltKind.DRAWDOWN], Decimal("41.5")),
    ):
        store = MemoryRiskStateStore()
        store.set_halt("planted", T)
        store.set_kill("planted kill", T)
        store.write_peak(Decimal(60))
        store.write_day(DayState(day=T.date(), day_start_equity=Decimal(50), last_equity=Decimal("41.5")))
        day_before = store.read_day()
        outcome = apply_reset_policy(store, kinds=kinds, at=at)
        assert not store.read_halt().active
        assert store.read_kill().active and not outcome.kill_cleared
        assert outcome.peak_rebased_to == rebased
        assert store.read_peak() == (rebased if rebased is not None else Decimal(60))
        assert store.read_day() == day_before, "day state is never touched (the re-halt trap)"
        assert store.history[-1]["by"] == "backtest model of the owner"


def test_the_modeled_owner_refuses_the_bots_store_and_an_unknown_halt(tmp_path: Path) -> None:
    disk = RiskStateStore(tmp_path / "bot")
    disk.set_halt("a real halt", T)
    with pytest.raises(TypeError, match="in-memory"):
        apply_reset_policy(disk, kinds=[HaltKind.DAILY_LOSS], at=T)  # type: ignore[arg-type]
    assert disk.read_halt().active
    with pytest.raises(ValueError, match="kinds"):
        apply_reset_policy(MemoryRiskStateStore(), kinds=[], at=T)


def test_a_reset_that_does_not_clear_the_halt_voids_the_run(monkeypatch: pytest.MonkeyPatch) -> None:
    """Planted: a broken modeled reset. Mode L then meets a blocked cycle, which only an R
    hard stop may cause: the run is void instead of silently sitting out the halt."""
    from samsulek.backtest import runner
    from samsulek.risk.reset import ResetOutcome

    def no_op(store: MemoryRiskStateStore, *, kinds: object, at: datetime) -> ResetOutcome:
        return ResetOutcome(kill_cleared=False, peak_rebased_to=None)

    monkeypatch.setattr(runner, "apply_reset_policy", no_op)
    ds = dataset(("A", "B", "C"))
    ctx = context(ds, limits(account__equity_sanity_max_eur=Decimal(45)))
    with pytest.raises(BacktestIntegrityError) as caught:
        run_backtest(job(DEMO, ds.symbols()), ctx)
    assert "blocked without a mode-R hard stop" in caught.value.reason
    assert caught.value.session == CAL.next_session(FIRST)
