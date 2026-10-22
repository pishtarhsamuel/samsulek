"""``run_backtest``: refusals, the per-session sequence, audits and records (spec 4, 9.1 P4,
traps 12 and 14 production halves; WP4).

- Refusals (``BacktestRefused``) list every problem and come before any part exists: bad
  timing, the fence, warm-up, sessions outside the data, the cost guard, the universe,
  currencies, plans and research limits.
- P4: ``run_backtest`` equals a hand loop of reset, clock, cycle and mark built from the
  same parts: the runner adds no decision of its own.
- Trap 12: every fill is stamped E, strictly between the previous close and the session's
  close; a loop that leaves the clock at the previous mark cannot get a price.
- Trap 14: a run after another run (earlier start, same process) equals that run alone;
  the parts of two runs share no mutable object.
- The production audits catch planted defects: fills off the cost model's oracle price,
  quotes stamped at "now", approved orders that did not fill, a failing mark. Pre-checks
  abort on a corporate action or a missing open print of a held symbol, and a timely
  delisting is sold through the normal router.
- Records, details and determinism: the result pickles (as do the jobs' context), the
  gzipped decision log is FULL only, two runs are identical (in one process and under
  another hash seed), and nothing is written to disk.
- Section 4 by the clock: every instant of every session (reset, execution, the quotes'
  print labels, the bars visible, the Athens risk day, the mark) across both DST
  switches, Easter (the worked example), Christmas, the 14:00 early close and New Year.
- A fresh strategy instance every session, also when the same job runs again in the same
  process (trap 5, production half); ``Lagged`` delays the decisions by exactly k sessions
  in a real run, and the freshness rule still passes.
- Halt records: a re-halt counts as immediate only when no order was sent after the reset.
- Hypothesis over random runs: the books add up exactly (fills replayed independently
  against every equity point; episodes plus residual equal the equity change).
- Statistics plumbing: random entries laid out from a real strategy run's episode shapes
  give back the same (symbol, sessions held, weight) multiset through the engine at 1x and
  2x, and the metrics read the runner's output consistently.
"""

from __future__ import annotations

import builtins
import decimal
import gzip
import hashlib
import io
import json
import math
import os
import pickle
import random
import subprocess
import sys
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import fields, replace
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from itertools import pairwise
from pathlib import Path
from typing import Any

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from samsulek.backtest import plans, runner
from samsulek.backtest.baselines import buy_and_hold_plan, episode_shapes, random_entry_schedule
from samsulek.backtest.book import check_invariant
from samsulek.backtest.clock import MonotoneClock, session_times
from samsulek.backtest.dataset import Listing, PitDataset
from samsulek.backtest.feed import BacktestFeed
from samsulek.backtest.fence import HOLDOUT_DATA_CUTOFF, RESEARCH_DATA_CUTOFF
from samsulek.backtest.halts import apply_reset_policy, classify_halt
from samsulek.backtest.limits import derive_research_config
from samsulek.backtest.metrics import compute_metrics, daily_returns, summarize
from samsulek.backtest.plans import plan_window, strategy_for_session
from samsulek.backtest.runner import BacktestParts, build_parts, check_timing, run_backtest
from samsulek.backtest.sources import SourceData, SyntheticBarSource, SyntheticPlants
from samsulek.backtest.synthetic_data import synthetic_daily_bars
from samsulek.backtest.types import (
    BacktestIntegrityError,
    BacktestRefused,
    BuyAndHoldPlan,
    Detail,
    EngineContext,
    ExecutionTiming,
    HaltKind,
    ModeConfigs,
    RandomEntriesPlan,
    RegistryPlan,
    RiskMode,
    RunJob,
    RunResult,
    StrategyPlan,
)
from samsulek.config import RiskConfig, load_risk_config
from samsulek.costs.stocks import StockCostParams
from samsulek.cycle import CycleReport, CycleSpec, run_unlocked_cycle
from samsulek.data.calendars import XetraCalendar
from samsulek.execution.sim_broker import SimBroker
from samsulek.strategies.base import Strategy, StrategyContext
from samsulek.strategies.params import ParamValue, as_params
from samsulek.strategies.registry import StrategyEntry
from samsulek.types import Bar, Market, OrderRequest, Quote, Side, TargetWeights

ROOT = Path(__file__).resolve().parents[1]
CAL = XetraCalendar()
LIVE_LIMITS = load_risk_config(ROOT / "config" / "risk.yaml")
SYMS = ("A", "B", "C")
DATA_FIRST = date(2021, 1, 4)
DATA_LAST = date(2021, 12, 30)
SESSIONS = CAL.sessions(DATA_FIRST, DATA_LAST)
FIRST, LAST = SESSIONS[30], SESSIONS[150]
DEMO = RegistryPlan("demo_above_average", ((FIRST, as_params({"lookback": 10, "gross": 0.9})),))
TIMING = ExecutionTiming(exec_delay=timedelta(minutes=3))


# ----------------------------------------------------------------------------- builders
def dataset(
    symbols: Sequence[str] = SYMS,
    *,
    gaps: Mapping[date, float] | None = None,
    plants: SyntheticPlants | None = None,
    first: date = DATA_FIRST,
    last: date = DATA_LAST,
    cutoff: datetime = RESEARCH_DATA_CUTOFF,
    seed: int = 5,
) -> PitDataset:
    data = SyntheticBarSource(seed=seed, calendar=CAL, plants=plants or SyntheticPlants()).load(
        symbols, first=first, last=last
    )
    if gaps:
        rows, factor = [], dict.fromkeys(symbols, 1.0)
        for bar in data.rows:
            factor[bar.symbol] *= gaps.get(bar.session, 1.0)
            f = factor[bar.symbol]
            assert bar.open is not None and bar.high is not None and bar.low is not None
            rows.append(
                replace(bar, open=bar.open * f, high=bar.high * f, low=bar.low * f, close=bar.close * f)
            )
        data = SourceData(data.name, data.synthetic, tuple(rows), data.listings, data.actions, data.fx)
    return PitDataset.build(data, calendar=CAL, cutoff=cutoff)


def limits(**changes: Any) -> RiskConfig:
    data = LIVE_LIMITS.model_dump(mode="python")
    for key, value in changes.items():
        part, leaf = key.split("__")
        target = data["account"] if part == "account" else data["markets"][Market(part)]
        target[leaf] = value
    return RiskConfig.model_validate(data)


def costs_for(symbols: Sequence[str], **changes: Any) -> StockCostParams:
    values: dict[str, Any] = {
        "half_spread_bps": {s: Decimal(10) for s in symbols},
        "slippage_bps": Decimal(5),
        "adverse_bps": Decimal(0),
        "fx_fee_bps": Decimal(15),
        "commission_eur": Decimal(0),
        "currency": {s: "EUR" for s in symbols},
    }
    values.update(changes)
    return StockCostParams(**values)


def context(
    ds: PitDataset,
    *,
    replay: RiskConfig = LIVE_LIMITS,
    research: RiskConfig | None = None,
    timing: ExecutionTiming = TIMING,
    costs: StockCostParams | None = None,
) -> EngineContext:
    modes = ModeConfigs(
        replay=replay,
        research=research or derive_research_config(replay),
        replay_sha256="sha-L",
        research_sha256="sha-R",
    )
    return EngineContext(
        dataset=ds,
        modes=modes,
        costs=costs or costs_for(ds.symbols()),
        timing=timing,
        quantity_step=Decimal("0.000001"),
        price_tick=Decimal("0.0001"),
    )


def job(
    plan: StrategyPlan = DEMO,
    *,
    universe: Sequence[str] = SYMS,
    mode: RiskMode = RiskMode.L,
    first: date = FIRST,
    last: date = LAST,
    min_history: int = 20,
    detail: Detail = Detail.FULL,
    label: str = "runner_test",
    multiplier: int = 1,
) -> RunJob:
    return RunJob(
        index=0,
        label=label,
        plan=plan,
        universe=tuple(sorted(universe)),
        min_history=min_history,
        first_session=first,
        last_session=last,
        risk_mode=mode,
        cost_multiplier=multiplier,
        starting_cash_eur=Decimal(50),
        detail=detail,
    )


def buy_and_hold(ds: PitDataset, ctx: EngineContext, universe: Sequence[str] = SYMS) -> BuyAndHoldPlan:
    return buy_and_hold_plan(
        ds,
        sorted(universe),
        limits=ctx.modes.replay.limits_for(Market.STOCKS),
        first_session=FIRST,
        execute_at=session_times(CAL, FIRST, ctx.timing).execute,
        min_bars=20,
    )


def decisions(result: RunResult) -> list[dict[str, Any]]:
    assert result.decisions_gz is not None
    return [json.loads(line) for line in gzip.decompress(result.decisions_gz).decode("ascii").splitlines()]


DS = dataset()
CTX = context(DS)


# ----------------------------------------------------------------------------- refusals
class SpyFeed(BacktestFeed):
    built = 0

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        type(self).built += 1
        super().__init__(*args, **kwargs)


def refused(the_job: RunJob, ctx: EngineContext = CTX) -> tuple[str, ...]:
    SpyFeed.built = 0
    with pytest.raises(BacktestRefused) as caught:
        run_backtest(the_job, ctx, feed_factory=SpyFeed)
    assert SpyFeed.built == 0, "refused before any part was built"
    return caught.value.problems


def has(problems: Sequence[str], text: str) -> bool:
    return any(text in p for p in problems)


def test_check_timing() -> None:
    stocks = LIVE_LIMITS.limits_for(Market.STOCKS)
    assert check_timing(ExecutionTiming(), stocks) == []
    assert check_timing(ExecutionTiming(exec_delay=timedelta(minutes=10)), stocks) == []
    assert check_timing(ExecutionTiming(reset_lead=timedelta(minutes=1)), stocks) == []
    assert check_timing(ExecutionTiming(reset_lead=timedelta(minutes=120)), stocks) == []
    bad = [
        ExecutionTiming(exec_delay=timedelta(minutes=10, seconds=1)),
        ExecutionTiming(exec_delay=timedelta(seconds=-1)),
        ExecutionTiming(reset_lead=timedelta(seconds=59)),
        ExecutionTiming(reset_lead=timedelta(minutes=121)),
    ]
    assert all(len(check_timing(t, stocks)) == 1 for t in bad)
    short = limits(stocks__max_quote_age_seconds=300).limits_for(Market.STOCKS)
    assert check_timing(ExecutionTiming(exec_delay=timedelta(minutes=4)), short) == []
    (problem,) = check_timing(ExecutionTiming(exec_delay=timedelta(minutes=4, seconds=1)), short)
    assert "stale at execution" in problem


def test_bad_timing_and_research_limits_are_refused() -> None:
    late = context(DS, timing=ExecutionTiming(exec_delay=timedelta(minutes=11), reset_lead=timedelta(0)))
    problems = refused(job(), late)
    assert has(problems, "execution delay must be 0 to 10 minutes")
    assert has(problems, "modeled reset must come 1 to 120 minutes")
    loose = context(DS, research=limits(account__max_daily_loss_pct=Decimal("0.5")))
    assert has(refused(job(mode=RiskMode.R), loose), "research limits: account.max_drawdown_pct")
    run_backtest(job(mode=RiskMode.L, last=SESSIONS[40]), loose)  # L does not read the R limits


def test_the_fence_is_enforced_from_the_datasets_cutoff() -> None:
    research = dataset(first=date(2024, 5, 2), last=date(2024, 9, 30))
    days = CAL.sessions(date(2024, 5, 2), date(2024, 9, 30))
    plan = RegistryPlan(DEMO.strategy, ((days[30], DEMO.segments[0][1]),))
    problems = refused(job(plan, first=days[30], last=date(2024, 10, 1)), context(research))
    assert has(problems, "a research job must end by 2024-09-30")
    assert has(problems, "not all inside the data")
    holdout = dataset(first=date(2024, 5, 2), last=date(2024, 12, 30), cutoff=HOLDOUT_DATA_CUTOFF)
    hold_days = CAL.sessions(date(2024, 10, 1), date(2024, 12, 30))
    assert has(refused(job(plan, first=days[30], last=days[60]), context(holdout)), "from 2024-10-01 on")
    hold_plan = RegistryPlan(DEMO.strategy, ((hold_days[0], DEMO.segments[0][1]),))
    ok = run_backtest(job(hold_plan, first=hold_days[0], last=hold_days[20]), context(holdout))
    assert ok.equity[0].session == hold_days[0], "a holdout job may warm up on earlier data"
    beyond = dataset(
        first=date(2026, 6, 1), last=date(2026, 12, 30), cutoff=datetime(2026, 12, 31, tzinfo=UTC)
    )
    late_days = CAL.sessions(date(2026, 6, 1), date(2026, 12, 30))
    late_plan = RegistryPlan(DEMO.strategy, ((late_days[30], DEMO.segments[0][1]),))
    assert has(
        refused(job(late_plan, first=late_days[30], last=late_days[40]), context(beyond)), "after the holdout"
    )


def test_every_problem_is_listed_at_once() -> None:
    cheap = costs_for(
        ("A", "B"),
        half_spread_bps={"A": Decimal(40), "B": Decimal(10)},
        currency={"A": "USD", "B": "EUR"},
    )
    saturday = FIRST + timedelta(days=(5 - FIRST.weekday()) % 7)
    problems = refused(job(universe=("A", "B", "Z"), min_history=5, last=saturday), context(DS, costs=cheap))
    for text in (
        "universe symbols not in the dataset: Z",
        "min_history 5 is below the plan's bar window 10",
        f"{saturday} is not a XETR session",
        "A trades in EUR, but the cost table says USD",
    ):
        assert has(problems, text), (text, problems)
    wide = costs_for(SYMS, half_spread_bps={"A": Decimal(40), "B": Decimal(10), "C": Decimal(10)})
    problems = refused(job(universe=("A", "B", "C", "Z")), context(DS, costs=wide))
    assert has(problems, "at 2x costs a fill can be 90 bps from the reference")
    assert has(problems, "slippage collar") and has(problems, "no cost data for Z")


def test_warm_up_plans_and_sessions_are_checked() -> None:
    assert has(refused(job(min_history=31)), "A has 30 bars before")
    unknown = RegistryPlan("no_such_strategy", DEMO.segments)
    assert has(refused(job(unknown)), "plan: unknown strategy 'no_such_strategy'")
    late_plan = RegistryPlan(DEMO.strategy, ((SESSIONS[31], DEMO.segments[0][1]),))
    assert has(refused(job(late_plan)), "after the first session")
    bad_params = RegistryPlan(DEMO.strategy, ((FIRST, as_params({"lookback": 500, "gross": 0.9})),))
    assert has(refused(job(bad_params)), "lookback must be at most 400")
    assert has(
        refused(job(first=SESSIONS[0] - timedelta(days=60), last=SESSIONS[10])), "not all inside the data"
    )
    stray = BuyAndHoldPlan(weights0=(("Q", 0.3),), anchor_closes=(("Q", 10.0),))
    assert has(refused(job(stray)), "Q, which is not in the job's universe")


# --------------------------------------------------------------------------- P4: no extras
def hand_loop(the_job: RunJob, ctx: EngineContext) -> tuple[BacktestParts, list[tuple[Decimal, Decimal]]]:
    """Reset, clock, cycle, mark by hand on the same parts the runner builds."""
    parts = build_parts(the_job, ctx)
    marks: list[tuple[Decimal, Decimal]] = []
    for session in ctx.dataset.sessions(the_job.first_session, the_job.last_session):
        times = session_times(CAL, session, ctx.timing)
        halt = parts.store.read_halt()
        if halt.active and the_job.risk_mode is RiskMode.L:
            parts.clock.set(times.reset_at)
            kinds = [k for k in map(classify_halt, halt.reasons) if k is not None]
            apply_reset_policy(parts.store, kinds=kinds, at=times.reset_at)
        parts.clock.set(times.execute)
        universe = ctx.dataset.listed(
            session, at=times.execute, min_bars=the_job.min_history, among=the_job.universe
        )
        spec = CycleSpec(
            market=Market.STOCKS,
            universe=universe,
            strategy=strategy_for_session(the_job.plan, session),
            quantity_step=ctx.quantity_step,
            price_tick=ctx.price_tick,
            calendar=parts.feed.calendar,
            bar_window=plan_window(the_job.plan),
        )
        run_unlocked_cycle(parts, spec)
        parts.log.drain_cycle()
        parts.clock.set(times.close_print)
        snap = parts.ledger.snapshot(times.close_print)
        gross = sum((p.quantity * parts.feed.mark(s, session) for s, p in snap.positions.items()), Decimal(0))
        marks.append((snap.cash, snap.cash + gross))
    return parts, marks


@pytest.mark.parametrize("mode", [RiskMode.L, RiskMode.R])
def test_p4_the_runner_adds_no_decisions(mode: RiskMode) -> None:
    ds = dataset(gaps={SESSIONS[60]: 0.93, SESSIONS[61]: 0.96, SESSIONS[100]: 0.3})
    ctx = context(ds)
    the_job = job(buy_and_hold(ds, ctx), mode=mode)
    result = run_backtest(the_job, ctx)
    parts, marks = hand_loop(the_job, ctx)
    assert decisions(result) == parts.log.all_records
    assert tuple(r.fill for r in result.fills) == tuple(parts.broker.fills_since(None))
    assert [(p.cash, p.equity) for p in result.equity] == marks
    assert result.halts, "the planted gaps halt"
    if mode is RiskMode.L:
        assert any(h.immediate_rehalt for h in result.halts) and len(result.halts) >= 3
    else:
        assert {s.status for s in result.sessions if s.session > result.halts[0].session} == {"blocked"}


# ------------------------------------------------------------------- traps 12 and 14
def test_trap12_fills_are_stamped_at_execution() -> None:
    result = run_backtest(job(), CTX)
    assert len(result.fills) > 20
    for record in result.fills:
        e = session_times(CAL, record.session, TIMING).execute
        assert record.fill.ts == e
        assert CAL.close_utc(CAL.previous_session(record.session)) < e < CAL.close_utc(record.session)
        assert e - CAL.open_print_utc(record.session) == TIMING.exec_delay
    for point in result.equity:
        assert point.ts == CAL.close_utc(point.session)
        assert point.equity == point.cash + point.gross


def test_trap12_a_loop_left_at_the_previous_mark_gets_no_price() -> None:
    parts = build_parts(job(), CTX)
    parts.clock.set(CAL.close_utc(FIRST))  # forgot to move the clock to E
    spec = CycleSpec(
        market=Market.STOCKS,
        universe=SYMS,
        strategy=strategy_for_session(DEMO, FIRST),
        quantity_step=CTX.quantity_step,
        price_tick=CTX.price_tick,
        calendar=CAL,
        bar_window=plan_window(DEMO),
    )
    report = run_unlocked_cycle(parts, spec)
    assert report.status == "error" and "PhaseError" in report.messages[0]
    assert parts.broker.fills_since(None) == []


def test_trap14_runs_share_nothing() -> None:
    later = job(first=SESSIONS[80], last=SESSIONS[120], label="later")
    earlier = job(first=SESSIONS[40], last=SESSIONS[100], label="earlier")
    alone = run_backtest(earlier, CTX)
    run_backtest(later, CTX)
    assert run_backtest(earlier, CTX) == alone
    a, b = build_parts(earlier, CTX), build_parts(earlier, CTX)
    shared = [
        f.name
        for f in fields(a)
        if f.name not in {"mode", "risk_config"} and getattr(a, f.name) is getattr(b, f.name)
    ]
    assert shared == []
    assert a.clock.now() == b.clock.now() == CAL.close_utc(CAL.previous_session(SESSIONS[40]))


# --------------------------------------------------------------------- planted defects
class OffPriceFeed(BacktestFeed):
    """Planted: every price one basis point above the open print (e.g. an adjusted quote)."""

    def quote(self, symbol: str) -> Quote | None:
        q = super().quote(symbol)
        return None if q is None else replace(q, price=q.price * Decimal("1.0001"))


class StampNowFeed(BacktestFeed):
    """Planted: the right price, stamped with the clock instead of its print time."""

    def quote(self, symbol: str) -> Quote | None:
        q = super().quote(symbol)
        return None if q is None else replace(q, ts=CAL.open_print_utc(q.ts.date()) + TIMING.exec_delay)


class MovingPriceFeed(BacktestFeed):
    """Planted: the price moves between the engine's quote and the broker's fill."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.seen: set[tuple[datetime, str]] = set()

    def quote(self, symbol: str) -> Quote | None:
        q = super().quote(symbol)
        if q is None:
            return None
        key = (q.ts, symbol)
        first = key not in self.seen
        self.seen.add(key)
        return q if first else replace(q, price=q.price * Decimal("1.01"))


class FailingMarkFeed(BacktestFeed):
    def mark(self, symbol: str, session: date) -> Decimal:
        if session >= SESSIONS[45]:
            raise LookupError(f"no close for {symbol}")
        return super().mark(symbol, session)


@pytest.mark.parametrize(
    ("feed", "expect"),
    [
        (OffPriceFeed, "with the cost model gives"),
        (StampNowFeed, "quote audit: A is quoted"),
        (MovingPriceFeed, "no-fill guard"),
        (FailingMarkFeed, "LookupError: no close for"),
    ],
)
def test_the_audits_catch_planted_defects(feed: type[BacktestFeed], expect: str) -> None:
    ctx = context(DS)
    with pytest.raises(BacktestIntegrityError) as caught:
        run_backtest(job(buy_and_hold(DS, ctx), label="audited"), ctx, feed_factory=feed)
    assert expect in caught.value.reason, caught.value.reason
    assert caught.value.label == "audited" and caught.value.session is not None
    assert "audited at session" in str(caught.value)


def test_a_corporate_action_on_a_held_symbol_aborts() -> None:
    split_day = SESSIONS[50]
    known = CAL.close_utc(SESSIONS[45])
    held = dataset(plants=SyntheticPlants(splits=(("A", split_day, 2.0, known),)))
    ctx = context(held)
    with pytest.raises(BacktestIntegrityError) as caught:
        run_backtest(job(buy_and_hold(held, ctx)), ctx)
    assert caught.value.session == split_day
    assert "corporate action on a held symbol: not modelled in M3 (A)" in caught.value.reason
    # The same split on a symbol the plan never holds is fine.
    plan = buy_and_hold(held, ctx, ("B", "C"))
    result = run_backtest(job(plan, universe=("B", "C")), ctx)
    assert result.equity[-1].session == LAST


def test_a_held_symbol_without_an_open_print_aborts() -> None:
    gone = SESSIONS[60]
    untimely = dataset(plants=SyntheticPlants(delistings=(("A", gone, None),)))
    ctx = context(untimely)
    with pytest.raises(BacktestIntegrityError) as caught:
        run_backtest(job(buy_and_hold(untimely, ctx)), ctx)
    assert caught.value.session == CAL.next_session(gone)
    assert "held A has no open print" in caught.value.reason


def test_a_timely_delisting_is_sold_through_the_router() -> None:
    last_day = SESSIONS[60]
    known = CAL.close_utc(SESSIONS[58])
    timely = dataset(plants=SyntheticPlants(delistings=(("A", last_day, known),)))
    ctx = context(timely)
    result = run_backtest(job(buy_and_hold(timely, ctx)), ctx)
    exit_day = SESSIONS[59]  # the first session whose E is after the announcement
    sells = [r for r in result.fills if r.fill.symbol == "A" and r.fill.side is Side.SELL]
    assert [r.session for r in sells] == [exit_day]
    after = [s for s in result.sessions if s.session >= exit_day]
    assert all("A" not in s.universe and "A" not in dict(s.actual) for s in after)


# --------------------------------------------------------------------- records, details
def test_session_records_follow_the_decision_log() -> None:
    ctx = context(DS, replay=limits(stocks__max_trades_per_day=1))
    result = run_backtest(job(buy_and_hold(DS, ctx)), ctx)
    first = result.sessions[0]
    assert first.session == FIRST and first.universe == SYMS and not first.reset_before
    assert (first.orders_planned, first.orders_sent, first.orders_rejected) == (3, 1, 2)
    assert len(first.rejections) == 2 and all("trades today 1 >= limit 1" in r for r in first.rejections)
    assert dict(first.targets).keys() == set(SYMS)
    held = dict(first.actual)
    assert len(held) == 1 and 0.28 < next(iter(held.values())) < 0.3
    fill = result.fills[0]
    (symbol,) = held
    cash = Decimal(50) - fill.fill.quantity * fill.fill.price - fill.fill.fee
    open_equity = cash + fill.fill.quantity * DS.raw_open_eur(symbol, FIRST)
    assert first.open_equity == open_equity
    assert held[symbol] == float(fill.fill.quantity * DS.raw_open_eur(symbol, FIRST) / open_equity)
    targets = [r for r in decisions(result) if r["kind"] == "targets"]
    assert result.halts == ()
    assert [tuple(sorted(r["weights"].items())) for r in targets] == [s.targets for s in result.sessions]
    assert fill.reference == DS.raw_open_eur(fill.fill.symbol, FIRST)
    assert fill.spread_eur == fill.fill.quantity * fill.reference * Decimal(10) / Decimal(10_000)
    assert fill.slippage_eur == fill.fill.quantity * fill.reference * Decimal(5) / Decimal(10_000)
    assert sum(s.orders_rejected for s in result.sessions) == sum(len(s.rejections) for s in result.sessions)


def test_a_late_listing_joins_once_it_has_min_history_bars() -> None:
    join = SESSIONS[50]
    data = SyntheticBarSource(seed=5, calendar=CAL).load(SYMS, first=DATA_FIRST, last=DATA_LAST)
    rows = tuple(b for b in data.rows if b.symbol != "C" or b.session >= join)
    listings = tuple(replace(lst, first_session=join) if lst.symbol == "C" else lst for lst in data.listings)
    late = PitDataset.build(
        replace(data, rows=rows, listings=listings), calendar=CAL, cutoff=RESEARCH_DATA_CUTOFF
    )
    result = run_backtest(job(min_history=20), context(late))
    joined = next(s.session for s in result.sessions if "C" in s.universe)
    assert joined == SESSIONS[70], "C needs 20 bars before it may trade"
    assert all("C" not in dict(s.targets) for s in result.sessions if s.session < joined)
    assert all(r.fill.symbol != "C" for r in result.fills if r.session < joined)


def test_the_other_plans_run() -> None:
    lagged = RegistryPlan(DEMO.strategy, DEMO.segments, lag_sessions=3)
    assert run_backtest(job(lagged, min_history=13), CTX).fills
    schedule = (("A", ((SESSIONS[35], SESSIONS[45], 0.3), (SESSIONS[50], SESSIONS[52], 0.2))),)
    result = run_backtest(job(RandomEntriesPlan(seed=1, schedule=schedule)), CTX)
    assert {r.fill.symbol for r in result.fills} == {"A"}
    assert result.fills[0].session == SESSIONS[35] and result.fills[0].fill.side is Side.BUY
    in_episode = {s for lo, hi in ((35, 45), (50, 52)) for s in SESSIONS[lo:hi]}
    for record in result.sessions:
        assert ("A" in dict(record.actual)) is (record.session in in_episode), record.session


def test_details_determinism_and_pickling() -> None:
    full = run_backtest(job(detail=Detail.FULL), CTX)
    again = run_backtest(job(detail=Detail.FULL), CTX)
    assert full == again and full.decisions_gz == again.decisions_gz
    for detail in (Detail.RETURNS, Detail.METRICS):
        lean = run_backtest(job(detail=detail), CTX)
        assert lean.decisions_gz is None
        assert replace(lean, job=full.job, decisions_gz=full.decisions_gz) == full
    assert pickle.loads(pickle.dumps(full)) == full  # noqa: S301 (our own object)
    shipped = pickle.loads(pickle.dumps(CTX))  # noqa: S301 (our own object)
    assert run_backtest(job(), shipped) == full
    assert full.data_fingerprint == DS.fingerprint and full.risk_config_sha256 == "sha-L"
    assert run_backtest(job(mode=RiskMode.R), CTX).risk_config_sha256 == "sha-R"
    assert full.start_ts == CAL.close_utc(CAL.previous_session(FIRST)) and full.start_equity == Decimal(50)


def test_a_run_writes_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    real_open, real_os_open = builtins.open, os.open
    writing = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_TRUNC

    def read_only_open(file: Any, mode: str = "r", *args: Any, **kwargs: Any) -> Any:
        if any(c in mode for c in "wax+"):
            raise AssertionError(f"a backtest opened {file!r} for writing")
        return real_open(file, mode, *args, **kwargs)

    def read_only_os_open(path: Any, flags: int, *args: Any, **kwargs: Any) -> int:
        if flags & writing:
            raise AssertionError(f"a backtest opened {path!r} for writing")
        return real_os_open(path, flags, *args, **kwargs)

    def refuse(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("a backtest touched the file system")

    # builtins.open AND io.open: Path.open (the disk log, the risk history and the atomic
    # writes all use it) calls io.open, which a builtins.open patch alone does not reach.
    monkeypatch.setattr(builtins, "open", read_only_open)
    monkeypatch.setattr(io, "open", read_only_open)
    monkeypatch.setattr(os, "open", read_only_os_open)
    for name in ("write_text", "write_bytes", "mkdir", "touch", "unlink", "rename"):
        monkeypatch.setattr(Path, name, refuse)
    for name in ("replace", "fsync", "mkdir", "makedirs", "remove", "rename"):
        monkeypatch.setattr(os, name, refuse)
    with pytest.raises(AssertionError, match="for writing"):  # the guard itself bites
        (tmp_path / "planted.jsonl").open("a", encoding="utf-8")
    result = run_backtest(job(), CTX)
    assert result.fills and list(tmp_path.iterdir()) == []


def test_halts_are_recorded_with_the_rebased_peak() -> None:
    ds = dataset(gaps={SESSIONS[70]: 0.5})
    ctx = context(ds)
    result = run_backtest(job(buy_and_hold(ds, ctx)), ctx)
    crash = result.halts[0]
    assert crash.session == SESSIONS[70] and HaltKind.DRAWDOWN in crash.kinds
    assert crash.reset_at == session_times(CAL, SESSIONS[71], TIMING).reset_at
    assert crash.peak_rebased_to is not None and crash.peak_rebased_to > 0
    reset_session = next(s for s in result.sessions if s.session == SESSIONS[71])
    assert reset_session.reset_before
    assert result.frozen_equity[0].session == SESSIONS[70]


def test_a_rehalt_after_orders_were_sent_is_not_immediate(monkeypatch: pytest.MonkeyPatch) -> None:
    """``immediate_rehalt`` is a halt right after a reset BEFORE any order (the re-halt trap at
    the open), not any halt of a reset session. Planted, as a mid-cycle halt would do it: after
    the reset session has sold, the engine sees a 4% lower equity (its own daily-loss wording)."""
    ds = dataset(gaps={SESSIONS[60]: 0.94})
    held_to = {"A": SESSIONS[61], "B": SESSIONS[100], "C": SESSIONS[100]}  # A is sold at the reset
    plan = RandomEntriesPlan(
        seed=1, schedule=tuple((s, ((SESSIONS[35], end, 0.3),)) for s, end in held_to.items())
    )
    reset_e = session_times(CAL, SESSIONS[61], TIMING).execute
    real = runner.run_unlocked_cycle

    def late_halt(parts: BacktestParts, spec: CycleSpec) -> CycleReport:
        report = real(parts, spec)
        if parts.clock.now() == reset_e:
            assert report.status == "done" and report.orders_sent > 0
            day = parts.store.read_day()
            assert day is not None
            assert parts.engine.observe_equity(day.last_equity * Decimal("0.96"))
            report.status = "halted"
        return report

    monkeypatch.setattr(runner, "run_unlocked_cycle", late_halt)
    result = run_backtest(job(plan, last=SESSIONS[70]), context(ds))
    first, second = result.halts[:2]
    assert (first.session, first.kinds, first.immediate_rehalt) == (
        SESSIONS[60],
        (HaltKind.DAILY_LOSS,),
        False,
    )
    record = next(s for s in result.sessions if s.session == SESSIONS[61])
    assert record.reset_before and record.orders_sent == 1 and record.status == "halted"
    assert (second.session, second.kinds) == (SESSIONS[61], (HaltKind.DAILY_LOSS,))
    assert not second.immediate_rehalt, "orders were sent after the reset: not an immediate re-halt"
    assert second.reset_at == session_times(CAL, SESSIONS[62], TIMING).reset_at


def test_a_done_cycle_that_leaves_trading_blocked_voids_the_run(monkeypatch: pytest.MonkeyPatch) -> None:
    """Planted core bug: the cycle reports "done" although it left a halt behind."""
    from samsulek.backtest import runner

    real = runner.run_unlocked_cycle

    def leaves_a_halt(parts: BacktestParts, spec: CycleSpec) -> Any:
        report = real(parts, spec)
        if parts.clock.now() == session_times(CAL, SESSIONS[40], TIMING).execute:
            parts.engine.halt("planted: left behind by a buggy cycle")
        return report

    monkeypatch.setattr(runner, "run_unlocked_cycle", leaves_a_halt)
    with pytest.raises(BacktestIntegrityError) as caught:
        run_backtest(job(), CTX)
    assert "ended done while trading is blocked" in caught.value.reason
    assert caught.value.session == SESSIONS[40]


# ------------------------------------------- planted damage the audits and pre-checks catch
PLANT_AT = SESSIONS[40]


def _resting_order(parts: BacktestParts, report: CycleReport) -> None:
    """An order no price fills, sent past the router: it is still open after the cycle."""
    parts.broker.place_order(
        OrderRequest(
            client_id="planted-resting",
            market=Market.STOCKS,
            symbol="A",
            side=Side.BUY,
            quantity=Decimal("0.01"),
            limit_price=Decimal("0.01"),
            reason="planted",
        )
    )


def _ledger_drift(parts: BacktestParts, report: CycleReport) -> None:
    parts.ledger.cash += Decimal(1)


def _halted_without_a_halt(parts: BacktestParts, report: CycleReport) -> None:
    report.status = "halted"


def _unknown_status(parts: BacktestParts, report: CycleReport) -> None:
    report.status = "paused"


def _miscounted_rejection(parts: BacktestParts, report: CycleReport) -> None:
    report.orders_rejected += 1


@pytest.mark.parametrize(
    ("plant", "expect"),
    [
        (_resting_order, "1 order(s) still open after the cycle"),
        (_ledger_drift, "ledger and simulated broker disagree after the cycle: cash: ledger EUR"),
        (_halted_without_a_halt, "the cycle halted without a new halt reason"),
        (_unknown_status, "unknown cycle status 'paused'"),
        (_miscounted_rejection, "0 risk rejection(s) logged, but the cycle reports 1"),
    ],
)
def test_planted_damage_after_a_cycle_voids_the_run(
    monkeypatch: pytest.MonkeyPatch, plant: Any, expect: str
) -> None:
    """Planted bugs right after a real cycle: each production audit voids the run there."""
    real = runner.run_unlocked_cycle

    def damaged(parts: BacktestParts, spec: CycleSpec) -> CycleReport:
        report = real(parts, spec)
        if parts.clock.now() == session_times(CAL, PLANT_AT, TIMING).execute:
            plant(parts, report)
        return report

    monkeypatch.setattr(runner, "run_unlocked_cycle", damaged)
    with pytest.raises(BacktestIntegrityError) as caught:
        run_backtest(job(), CTX)
    assert expect in caught.value.reason, caught.value.reason
    assert caught.value.session == PLANT_AT


class _ShiftedClock:
    def __init__(self, inner: Any, shift: timedelta) -> None:
        self._inner = inner
        self._shift = shift

    def now(self) -> datetime:
        return self._inner.now() + self._shift


def _stamp_broker(shift: timedelta) -> type[SimBroker]:
    class ShiftedStampBroker(SimBroker):
        """Planted: the broker stamps its fills ``shift`` away from the execution time."""

        def __init__(self, **kwargs: Any) -> None:
            kwargs["clock"] = _ShiftedClock(kwargs["clock"], shift)
            super().__init__(**kwargs)

    return ShiftedStampBroker


@pytest.mark.parametrize("shift", [timedelta(seconds=1), timedelta(seconds=-1)], ids=["after", "before"])
def test_a_fill_stamped_off_the_execution_time_voids_the_run(
    monkeypatch: pytest.MonkeyPatch, shift: timedelta
) -> None:
    monkeypatch.setattr(runner, "SimBroker", _stamp_broker(shift))
    with pytest.raises(BacktestIntegrityError) as caught:
        run_backtest(job(), CTX)
    assert "is stamped" in caught.value.reason and "not the execution time" in caught.value.reason
    assert caught.value.session == FIRST


def test_a_kill_flag_voids_the_run_before_any_cycle(monkeypatch: pytest.MonkeyPatch) -> None:
    """Planted: parts that come with the KILL flag set. A backtest never models the kill switch."""
    real = runner.build_parts

    def killed(the_job: RunJob, ctx: EngineContext, **kwargs: Any) -> BacktestParts:
        parts = real(the_job, ctx, **kwargs)
        parts.store.set_kill("planted", parts.clock.now())
        return parts

    monkeypatch.setattr(runner, "build_parts", killed)
    with pytest.raises(BacktestIntegrityError) as caught:
        run_backtest(job(), CTX)
    assert "the KILL flag is set" in caught.value.reason
    assert caught.value.session == FIRST


def test_a_listed_symbol_without_an_open_print_voids_the_run() -> None:
    """An untimely delisting of a symbol the plan does not hold: still listed, but no price."""
    gone = SESSIONS[60]
    untimely = dataset(plants=SyntheticPlants(delistings=(("A", gone, None),)))
    schedule = (("B", ((SESSIONS[35], SESSIONS[100], 0.3),)),)
    with pytest.raises(BacktestIntegrityError) as caught:
        run_backtest(job(RandomEntriesPlan(seed=1, schedule=schedule)), context(untimely))
    assert caught.value.session == CAL.next_session(gone)
    assert "listed A has no open print" in caught.value.reason


# ------------------------------------------------------- section 4, instant by instant
def utc(year: int, month: int, day: int, hour: int, minute: int) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=UTC)


def quiet_dataset(first: date, last: date, *, cutoff: datetime, gap: date) -> PitDataset:
    """Two calm symbols (no spontaneous halt); every price times 0.94 from ``gap``'s open on."""
    raw = synthetic_daily_bars(("A", "B"), CAL, first, last, seed=3, vol=0.002, gap_vol=0.001)
    rows = []
    for symbol in ("A", "B"):
        factor = 1.0
        for bar in raw[symbol]:
            factor *= 0.94 if bar.session == gap else 1.0
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
    listings = tuple(Listing(s, "EUR", first, None, None, "synthetic (test)") for s in ("A", "B"))
    data = SourceData("synthetic", True, tuple(rows), listings, (), None)
    return PitDataset.build(data, calendar=CAL, cutoff=cutoff)


# Pinned UTC instants (spec 4, worked example and its siblings): None = not asked that session.
#   session: (reset_at, execute, newest close visible at execute, close mark)
EASTER = {  # exec_delay 0; the March DST switch is on Sunday 2024-03-31
    date(2024, 3, 27): (None, utc(2024, 3, 27, 8, 5), utc(2024, 3, 26, 16, 40), utc(2024, 3, 27, 16, 40)),
    date(2024, 3, 28): (None, utc(2024, 3, 28, 8, 5), None, utc(2024, 3, 28, 16, 40)),  # halted at the open
    date(2024, 4, 2): (
        utc(2024, 4, 2, 6, 35),
        utc(2024, 4, 2, 7, 5),
        utc(2024, 3, 28, 16, 40),
        utc(2024, 4, 2, 15, 40),
    ),
    date(2024, 4, 3): (None, utc(2024, 4, 3, 7, 5), utc(2024, 4, 2, 15, 40), utc(2024, 4, 3, 15, 40)),
}
WINTER = {  # exec_delay 3 min; the October DST switch is on Sunday 2024-10-27
    date(2024, 10, 25): (None, utc(2024, 10, 25, 7, 8), utc(2024, 10, 24, 15, 40), utc(2024, 10, 25, 15, 40)),
    date(2024, 10, 28): (None, utc(2024, 10, 28, 8, 8), utc(2024, 10, 25, 15, 40), utc(2024, 10, 28, 16, 40)),
    date(2024, 12, 23): (None, utc(2024, 12, 23, 8, 8), utc(2024, 12, 20, 16, 40), utc(2024, 12, 23, 16, 40)),
    date(2024, 12, 27): (None, utc(2024, 12, 27, 8, 8), utc(2024, 12, 23, 16, 40), utc(2024, 12, 27, 16, 40)),
    date(2024, 12, 30): (None, utc(2024, 12, 30, 8, 8), None, utc(2024, 12, 30, 13, 10)),  # 14:00 close
    date(2025, 1, 2): (
        utc(2025, 1, 2, 7, 38),
        utc(2025, 1, 2, 8, 8),
        utc(2024, 12, 30, 13, 10),
        utc(2025, 1, 2, 16, 40),
    ),
}


@pytest.mark.parametrize(
    ("data", "cutoff", "gap", "window", "delay", "pinned", "runs"),
    [
        pytest.param(
            (date(2024, 2, 1), date(2024, 4, 12)),
            RESEARCH_DATA_CUTOFF,
            date(2024, 3, 28),
            (date(2024, 3, 26), date(2024, 4, 3)),
            0,
            EASTER,
            [date(2024, 3, 26), date(2024, 3, 27), date(2024, 3, 28), date(2024, 4, 2), date(2024, 4, 3)],
            id="easter-march-dst",
        ),
        pytest.param(
            (date(2024, 8, 1), date(2025, 1, 15)),
            HOLDOUT_DATA_CUTOFF,
            date(2024, 12, 30),
            (date(2024, 10, 24), date(2025, 1, 3)),
            3,
            WINTER,
            [
                date(2024, 12, 20),
                date(2024, 12, 23),
                date(2024, 12, 27),
                date(2024, 12, 30),
                date(2025, 1, 2),
            ],
            id="october-dst-christmas-early-close-new-year",
        ),
    ],
)
def test_section4_instants_session_by_session(
    monkeypatch: pytest.MonkeyPatch,
    data: tuple[date, date],
    cutoff: datetime,
    gap: date,
    window: tuple[date, date],
    delay: int,
    pinned: Mapping[date, tuple[datetime | None, datetime, datetime | None, datetime]],
    runs: Sequence[date],
) -> None:
    """Every instant the runner sets and every price the cycle and the marks ask for, checked
    against section 4: reset at E - 30 min (only after a halt), E = open print + delay, quotes
    labeled with the print time, bars visible through the previous session's close only (so
    the freshness rule passes), the Athens risk day is the session, the mark at the close."""
    tape: list[tuple[str, datetime, Any]] = []

    class TapeClock(MonotoneClock):
        def set(self, ts: datetime) -> None:
            super().set(ts)
            tape.append(("set", ts, None))

    class TapeFeed(BacktestFeed):
        def bars_until(self, asof: datetime) -> dict[str, tuple[Bar, ...]]:
            out = super().bars_until(asof)
            tape.append(("bars", asof, {s: b[-1].close_ts for s, b in out.items()}))
            return out

        def quote(self, symbol: str) -> Quote | None:
            q = super().quote(symbol)
            tape.append(("quote", self._clock.now(), None if q is None else q.ts))
            return q

        def mark(self, symbol: str, session: date) -> Decimal:
            value = super().mark(symbol, session)
            tape.append(("mark", self._clock.now(), session))
            return value

    real_cycle = runner.run_unlocked_cycle

    def cycle(parts: BacktestParts, spec: CycleSpec) -> CycleReport:
        report = real_cycle(parts, spec)
        day = parts.store.read_day()
        tape.append(("risk_day", parts.clock.now(), None if day is None else day.day))
        return report

    monkeypatch.setattr(runner, "MonotoneClock", TapeClock)
    monkeypatch.setattr(runner, "run_unlocked_cycle", cycle)
    ds = quiet_dataset(*data, cutoff=cutoff, gap=gap)
    timing = ExecutionTiming(exec_delay=timedelta(minutes=delay))
    ctx = context(ds, timing=timing)
    first, last = window
    plan = buy_and_hold_plan(
        ds,
        ("A", "B"),
        limits=ctx.modes.replay.limits_for(Market.STOCKS),
        first_session=first,
        execute_at=session_times(CAL, first, timing).execute,
        min_bars=5,
    )
    the_job = job(plan, universe=("A", "B"), first=first, last=last, min_history=5)
    result = run_backtest(the_job, ctx, feed_factory=TapeFeed)

    days = [s.session for s in result.sessions]
    assert [d for d in days if runs[0] <= d <= runs[-1]] == list(runs)  # holidays skipped
    times = {d: session_times(CAL, d, timing) for d in days}
    by_execute = {t.execute: d for d, t in times.items()}
    expected_sets = []
    for record in result.sessions:
        t = times[record.session]
        expected_sets += ([t.reset_at] if record.reset_before else []) + [t.execute, t.close_print]
    assert [ts for kind, ts, _ in tape if kind == "set"] == expected_sets
    for kind, ts, what in tape:
        if kind == "quote":  # asked at E only, stamped with the open print's own label
            assert what == CAL.open_print_utc(by_execute[ts])
        elif kind == "bars":  # through the previous session's close, nothing later
            previous_close = CAL.close_utc(CAL.previous_session(by_execute[ts]))
            assert what and set(what.values()) == {previous_close}, (ts, what)
        elif kind == "risk_day":  # the Athens trading day at E is the session
            assert what == by_execute[ts]
        elif kind == "mark":
            assert ts == CAL.close_utc(what)
    count = {k: sum(1 for kind, _, _ in tape if kind == k) for k in ("risk_day", "quote", "bars", "mark")}
    assert count["risk_day"] == count["mark"] / 2 == len(days), count  # one cycle, two marks per session
    assert count["quote"] >= 2 * len(days) and count["bars"] == len(days) - 1, (
        count
    )  # the gap halts at the open
    assert all(r.fill.ts == times[r.session].execute for r in result.fills) and result.fills
    assert [p.ts for p in result.equity] == [times[d].close_print for d in days]
    for session, (reset_at, execute, newest, close) in pinned.items():
        t = times[session]
        record = result.sessions[days.index(session)]
        assert (t.execute, t.close_print) == (execute, close), session
        assert record.reset_before is (reset_at is not None), session
        if reset_at is not None:
            assert t.reset_at == reset_at
            halt = next(h for h in result.halts if h.reset_at == reset_at)
            assert halt.session == CAL.previous_session(session)
        seen = [what for kind, ts, what in tape if kind == "bars" and ts == execute]
        assert seen == ([] if newest is None else [{"A": newest, "B": newest}]), session
    assert [h.session for h in result.halts] == [gap], "the planted gap halts, nothing else"


# --------------------------------------------------- trap 5 and Lagged, in a real run
class Counting:
    """Planted state: its weights depend on how often THIS instance has been asked."""

    name = "counting"

    def __init__(self, made: list[Counting]) -> None:
        self.calls = 0
        made.append(self)

    def target_weights(self, ctx: StrategyContext) -> TargetWeights:
        self.calls += 1
        weight = 0.25 if self.calls == 1 else 0.0
        return TargetWeights(weights=dict.fromkeys(ctx.bars, weight), reason=f"call {self.calls}")


def test_trap05_every_session_gets_a_fresh_strategy(monkeypatch: pytest.MonkeyPatch) -> None:
    made: list[Counting] = []

    def build(params: Mapping[str, ParamValue]) -> Strategy:
        return Counting(made)

    entry = StrategyEntry(name="counting", params=(), build=build, window=lambda params: 1)
    monkeypatch.setattr(plans, "get_strategy", lambda name: entry)
    plan = RegistryPlan("counting", ((FIRST, as_params({})),))
    the_job = job(plan, mode=RiskMode.R, min_history=1, last=SESSIONS[70])
    result = run_backtest(the_job, CTX)
    reasons = [r["reason"] for r in decisions(result) if r["kind"] == "targets"]
    assert len(reasons) == len(result.sessions) == 41
    assert set(reasons) == {"call 1"}, "a strategy instance was asked twice"
    assert all(c.calls <= 1 for c in made) and len({id(c) for c in made}) == len(made)
    assert sum(c.calls for c in made) == len(result.sessions)
    assert all(dict(s.targets) == dict.fromkeys(SYMS, 0.25) for s in result.sessions)
    # The same job again in this process: new instances again, nothing carried over (trap 14).
    assert run_backtest(the_job, CTX) == result
    asked = [c for c in made if c.calls]  # (the refusal check builds one per segment, never asked)
    assert len(asked) == 2 * len(result.sessions) and all(c.calls == 1 for c in asked)
    assert len({id(c) for c in made}) == len(made)


def test_lagged_delays_every_decision_by_exactly_k_sessions() -> None:
    """In a real run ``Lagged(k)`` decides at s what the plain strategy decided at s - k (the
    demo's targets depend on its bars only), and the cycle's freshness rule still passes."""
    k = 2
    plain = run_backtest(job(DEMO, mode=RiskMode.R, min_history=10 + k), CTX)
    lagged = run_backtest(job(replace(DEMO, lag_sessions=k), mode=RiskMode.R, min_history=10 + k), CTX)
    assert {s.status for s in plain.sessions} == {s.status for s in lagged.sessions} == {"done"}
    a = [s.targets for s in plain.sessions]
    b = [s.targets for s in lagged.sessions]
    assert b[k:] == a[:-k]
    assert len(set(a)) > 3 and b != a, "the shift is visible: the targets change over time"
    reasons = [
        [(r["strategy"], r["reason"]) for r in decisions(x) if r["kind"] == "targets"]
        for x in (plain, lagged)
    ]
    assert [why for _, why in reasons[1][k:]] == [why for _, why in reasons[0][:-k]]
    assert {name for name, _ in reasons[1]} == {f"{name}+lag{k}" for name, _ in reasons[0]}


# ------------------------------------------------------- the books, on random runs
_EXACT = decimal.Context(prec=200, traps=[decimal.Inexact, decimal.InvalidOperation])
_TINY = Decimal("1e-20")  # 28-digit roundings of a EUR 50 account stay far below this


def _random_plan(
    kind: str, rng: random.Random, ds: PitDataset, ctx: EngineContext, days: Sequence[date]
) -> StrategyPlan:
    if kind == "demo":
        params = as_params({"lookback": rng.randint(2, 20), "gross": rng.choice([0.3, 0.6, 0.9, 1.0])})
        return RegistryPlan(DEMO.strategy, ((days[0], params),))
    if kind == "buy_and_hold":
        return buy_and_hold_plan(
            ds,
            SYMS,
            limits=ctx.modes.replay.limits_for(Market.STOCKS),
            first_session=days[0],
            execute_at=session_times(CAL, days[0], ctx.timing).execute,
            min_bars=20,
        )
    schedule = []
    for symbol in SYMS:
        cuts = sorted(rng.sample(range(len(days)), 6))
        episodes = tuple(
            (days[x], days[y], rng.choice([0.1, 0.2, 0.3]))
            for x, y in zip(cuts[::2], cuts[1::2], strict=True)
        )
        schedule.append((symbol, episodes))
    return RandomEntriesPlan(seed=rng.randint(0, 10**6), schedule=tuple(schedule))


@settings(max_examples=15, deadline=None)
@given(
    seed=st.integers(0, 2**32 - 1),
    kind=st.sampled_from(("demo", "buy_and_hold", "random")),
    mode=st.sampled_from((RiskMode.L, RiskMode.R)),
    multiplier=st.sampled_from((1, 2)),
    delay=st.sampled_from((0, 3, 10)),
    crash=st.sampled_from((1.0, 0.95, 0.5)),
)
def test_the_books_add_up_exactly_on_random_runs(
    seed: int, kind: str, mode: RiskMode, multiplier: int, delay: int, crash: float
) -> None:
    last = SESSIONS[110]
    ds = dataset(seed=seed, last=last, gaps={SESSIONS[70]: crash})
    timing = ExecutionTiming(exec_delay=timedelta(minutes=delay))
    ctx = context(ds, timing=timing)
    days = ds.sessions(FIRST, last)
    plan = _random_plan(kind, random.Random(seed), ds, ctx, days)
    result = run_backtest(job(plan, mode=mode, multiplier=multiplier, last=last, detail=Detail.METRICS), ctx)
    assert [p.session for p in result.equity] == [s.session for s in result.sessions] == list(days)
    assert [p.ts for p in result.equity] == [CAL.close_utc(d) for d in days]
    assert all(s.open_equity is not None and s.open_equity > 0 for s in result.sessions)
    check_invariant(result)
    # Replay the fills independently, in exact arithmetic, against every equity point.
    fills: dict[date, list[Any]] = {}
    for record in result.fills:
        fills.setdefault(record.session, []).append(record.fill)
    qty: dict[str, Decimal] = {}
    with decimal.localcontext(_EXACT):
        cash, bought = result.start_equity, Decimal(0)
        for point in result.equity:
            for fill in fills.get(point.session, ()):
                assert fill.ts == session_times(CAL, point.session, timing).execute
                value = fill.quantity * fill.price
                held = qty.get(fill.symbol, Decimal(0))
                if fill.side is Side.BUY:
                    cash, bought, qty[fill.symbol] = (
                        cash - value - fill.fee,
                        bought + value,
                        held + fill.quantity,
                    )
                else:
                    assert fill.quantity <= held
                    cash, qty[fill.symbol] = cash + value - fill.fee, held - fill.quantity
            gross = sum((q * ds.raw_close_eur(s, point.session) for s, q in qty.items() if q), Decimal(0))
            assert abs(point.cash - cash) <= _TINY and abs(point.gross - gross) <= _TINY, point
            assert abs(point.equity - (point.cash + point.gross)) <= _TINY
        booked = sum((e.pnl_eur for e in result.episodes), Decimal(0)) + result.residual_eur
        assert abs(booked - (result.equity[-1].equity - result.start_equity)) <= _TINY
        assert abs(booked - (cash + gross - result.start_equity)) <= _TINY
        assert sum((e.buy_eur for e in result.episodes), Decimal(0)) == bought, "every buy is in an episode"
    for symbol in SYMS:
        mine = sorted((e for e in result.episodes if e.symbol == symbol), key=lambda e: e.entry_session)
        for before, after in pairwise(mine):
            assert before.exit_session is not None and before.exit_session <= after.entry_session
        assert not any(e.open_at_end for e in mine[:-1])
        if mine and mine[-1].open_at_end:
            assert qty.get(symbol, Decimal(0)) > 0
    returns = daily_returns(result.equity, result.start_equity)
    assert len(returns) == len(days) and all(math.isfinite(r) for r in returns)
    if mode is RiskMode.L and result.halts:
        assert result.frozen_equity[0].session == result.halts[0].session
    if mode is RiskMode.R and result.halts:  # a hard stop: blocked for good, no reset, no fill
        after = [s for s in result.sessions if s.session > result.halts[0].session]
        assert {s.status for s in after} <= {"blocked"} and all(h.reset_at is None for h in result.halts)
        assert not [r for r in result.fills if r.session > result.halts[0].session]


# --------------------------------------------- statistics plumbing, runner to metrics
def test_random_entries_replay_the_strategys_episode_shapes_through_the_engine() -> None:
    """Spec 7.3 end to end: the shapes of a real ``strategy_R_1x`` run, laid out by stars and
    bars and run through the same engine at 1x and 2x, give back exactly the strategy's
    (symbol, sessions held, weight) multiset (an episode may end open at the last session),
    and the metrics read the runner's output consistently."""
    ds = dataset(seed=6)
    ctx = context(ds)
    plan = RegistryPlan(DEMO.strategy, ((FIRST, as_params({"lookback": 5, "gross": 0.9})),))
    strategy = run_backtest(job(plan, mode=RiskMode.R, label="strategy_R_1x"), ctx)
    shapes = episode_shapes(strategy)
    want = Counter((s, h, w) for s, held in shapes.items() for h, w in held)
    assert sum(want.values()) > 30
    days = [p.session for p in strategy.equity]
    metrics = compute_metrics(strategy)
    assert metrics.n_returns == len(days) and metrics.n_fills == len(strategy.fills)
    assert metrics.n_rejections == sum(s.orders_rejected for s in strategy.sessions)
    assert metrics.n_episodes_closed + metrics.n_episodes_open == len(strategy.episodes)
    summary = summarize(strategy, Detail.RETURNS)
    assert summary.returns == tuple(daily_returns(strategy.equity, strategy.start_equity))
    assert summary.sessions == tuple(days) and summarize(strategy, Detail.METRICS).returns is None
    open_at_end = 0
    for seed in (4, 1):
        schedule = random_entry_schedule(shapes, days, seed=seed)
        for multiplier in (1, 2):
            label = f"random_R_{multiplier}x_s{seed:04d}"
            run = run_backtest(job(schedule, mode=RiskMode.R, multiplier=multiplier, label=label), ctx)
            assert Counter((e.symbol, e.sessions_held, e.weight) for e in run.episodes) == want, label
            assert run.halts == () and all(s.orders_rejected == 0 for s in run.sessions)
            random_exposure = compute_metrics(run).exposure
            assert abs(random_exposure / metrics.exposure - 1) < 0.05, (label, random_exposure)
            open_at_end += sum(e.open_at_end for e in run.episodes)
    assert open_at_end > 0, "an episode laid out to the end runs to the last session"


# ------------------------------------------------------------------- determinism
def test_a_run_does_not_depend_on_the_hash_seed() -> None:
    """The same job under two other hash seeds gives the very same pickled bytes: no set or
    dict order reaches an order, a client id, a record or a number."""
    code = (
        "import hashlib, pickle, sys\n"
        f"sys.path.insert(0, {str(Path(__file__).resolve().parent)!r})\n"
        "import test_backtest_runner as t\n"
        "result = t.run_backtest(t.job(), t.CTX)\n"
        "sys.stdout.write(hashlib.sha256(pickle.dumps(result)).hexdigest())\n"
    )
    here = hashlib.sha256(pickle.dumps(run_backtest(job(), CTX))).hexdigest()
    digests = set()
    for hash_seed in ("1", "2"):
        env = {**os.environ, "PYTHONHASHSEED": hash_seed}
        out = subprocess.run(
            [sys.executable, "-c", code], capture_output=True, text=True, env=env, timeout=300, check=True
        )
        digests.add(out.stdout.strip())
    assert digests == {here}
