"""P11: modes L and R agree exactly while no relaxed limit binds (owner decision Q1).

R differs from L only in five leaves (daily loss 50%, drawdown 90%, equity sanity EUR 1e9,
EUR position and exposure caps EUR 1e6). On calm synthetic data (no 3% day, a drawdown far
from 15%, equity below EUR 66 so the EUR 60 exposure cap cannot bind at 90% gross and the
EUR 20 position cap cannot bind at 30%) the demo strategy must produce the very same run in
both modes: every session record, fill, equity point, episode and decision record. The
preconditions are asserted, not assumed. And the comparison bites: one planted 5% gap-down
halts L and not R, and the runs differ. On a rising market the EUR caps bind in L once the
account passes about EUR 66.67 (30% of it reaches EUR 20), and only from then on do the
modes part.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from samsulek.backtest.dataset import Listing, PitDataset
from samsulek.backtest.fence import RESEARCH_DATA_CUTOFF
from samsulek.backtest.limits import load_mode_configs
from samsulek.backtest.metrics import daily_returns
from samsulek.backtest.runner import run_backtest
from samsulek.backtest.sources import SourceData
from samsulek.backtest.synthetic_data import synthetic_daily_bars
from samsulek.backtest.types import (
    Detail,
    EngineContext,
    ExecutionTiming,
    RegistryPlan,
    RiskMode,
    RunJob,
    RunResult,
)
from samsulek.costs.stocks import StockCostParams
from samsulek.data.calendars import XetraCalendar
from samsulek.strategies.params import as_params
from samsulek.types import Market

ROOT = Path(__file__).resolve().parents[1]
CAL = XetraCalendar()
SYMS = ("ETF_A", "ETF_B", "ETF_C")
DATA_FIRST, LAST = date(2019, 1, 2), date(2020, 9, 30)
FIRST = CAL.sessions(DATA_FIRST, LAST)[30]
MODES = load_mode_configs(ROOT)


def calm_dataset(seed: int, *, gap_day: date | None = None) -> PitDataset:
    raw = synthetic_daily_bars(SYMS, CAL, DATA_FIRST, LAST, seed=seed, drift=0.0002, vol=0.003, gap_vol=0.002)
    rows = []
    for symbol in SYMS:
        factor = 1.0
        for bar in raw[symbol]:
            if bar.session == gap_day:
                factor *= 0.95
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
    listings = tuple(Listing(s, "EUR", DATA_FIRST, None, None, "synthetic (test)") for s in SYMS)
    data = SourceData("synthetic", True, tuple(rows), listings, (), None)
    return PitDataset.build(data, calendar=CAL, cutoff=RESEARCH_DATA_CUTOFF)


def run(ds: PitDataset, mode: RiskMode, multiplier: int, *, last: date = LAST) -> RunResult:
    ctx = EngineContext(
        dataset=ds,
        modes=MODES,
        costs=StockCostParams(
            half_spread_bps={s: Decimal(10) for s in SYMS},
            slippage_bps=Decimal(5),
            adverse_bps=Decimal(0),
            fx_fee_bps=Decimal(15),
            commission_eur=Decimal(0),
            currency={s: "EUR" for s in SYMS},
        ),
        timing=ExecutionTiming(),
        quantity_step=Decimal("0.000001"),
        price_tick=Decimal("0.0001"),
    )
    plan = RegistryPlan("demo_above_average", ((FIRST, as_params({"lookback": 20, "gross": 0.9})),))
    job = RunJob(
        index=0,
        label=f"strategy_{mode}_{multiplier}x",
        plan=plan,
        universe=SYMS,
        min_history=20,
        first_session=FIRST,
        last_session=last,
        risk_mode=mode,
        cost_multiplier=multiplier,
        starting_cash_eur=Decimal(50),
        detail=Detail.FULL,
    )
    return run_backtest(job, ctx)


@pytest.mark.parametrize("multiplier", [1, 2])
@pytest.mark.parametrize("seed", [1, 2, 3])
def test_l_and_r_agree_while_no_relaxed_limit_binds(seed: int, multiplier: int) -> None:
    ds = calm_dataset(seed)
    replay, research = run(ds, RiskMode.L, multiplier), run(ds, RiskMode.R, multiplier)
    # The preconditions, checked on the run itself.
    equities = [p.equity for p in replay.equity]
    assert max(equities) < 66, "above EUR 66 the EUR exposure cap could bind in L"
    returns = daily_returns(replay.equity, replay.start_equity)
    assert max(abs(r) for r in returns) < 0.03, "no 3% day: the daily-loss limit never binds"
    peak, worst = replay.start_equity, Decimal(0)
    for e in equities:
        peak = max(peak, e)
        worst = max(worst, (peak - e) / peak)
    assert worst < Decimal("0.10")
    assert replay.halts == () and len(replay.fills) > 50
    assert not any("cap EUR" in r for s in replay.sessions for r in s.rejections)
    # Identical apart from the mode itself.
    assert replace(replay, job=research.job, risk_config_sha256=research.risk_config_sha256) == research
    assert replay.decisions_gz == research.decisions_gz
    assert replay.risk_config_sha256 == MODES.replay_sha256 != research.risk_config_sha256


def test_the_comparison_bites_when_a_relaxed_limit_binds() -> None:
    calm = run(calm_dataset(1), RiskMode.L, 1)
    # A session where the demo is (almost) fully invested at the close before it.
    invested = [
        b.session for a, b in zip(calm.equity, calm.equity[1:], strict=False) if a.gross > a.equity * 8 / 10
    ]
    gap_day = invested[len(invested) // 2]
    ds = calm_dataset(1, gap_day=gap_day)
    replay, research = run(ds, RiskMode.L, 1), run(ds, RiskMode.R, 1)
    assert [h.session for h in replay.halts] == [gap_day], "the 5% gap halts L (3% daily loss)"
    assert research.halts == ()
    assert replace(replay, job=research.job, risk_config_sha256=research.risk_config_sha256) != research
    assert replay.decisions_gz != research.decisions_gz


def _held_eur(result: RunResult) -> list[list[Decimal]]:
    """Per session, each position's value at the raw opens after the cycle."""
    return [
        [Decimal(repr(w)) * s.open_equity for _, w in s.actual] if s.open_equity is not None else []
        for s in result.sessions
    ]


def test_the_eur_caps_bind_in_l_once_equity_grows() -> None:
    """Section 7.4: R relaxes the EUR position and exposure caps, L keeps EUR 20 and EUR 60.

    On a steadily rising market (no halt in either mode) the two runs are identical while 30%
    of equity is below EUR 20; once the account grows past about EUR 66.67 the EUR caps bind
    in L only: L's positions stay at the EUR 20 cap (within the cycle's 10% drift tolerance)
    while R's keep growing with equity, and the runs part.
    """
    raw = synthetic_daily_bars(SYMS, CAL, DATA_FIRST, LAST, seed=4, drift=0.003, vol=0.004, gap_vol=0.002)
    listings = tuple(Listing(s, "EUR", DATA_FIRST, None, None, "synthetic (test)") for s in SYMS)
    data = SourceData("synthetic", True, tuple(b for s in SYMS for b in raw[s]), listings, (), None)
    rising = PitDataset.build(data, calendar=CAL, cutoff=RESEARCH_DATA_CUTOFF)
    stop = date(2020, 6, 30)
    replay, research = run(rising, RiskMode.L, 1, last=stop), run(rising, RiskMode.R, 1, last=stop)
    assert replay.halts == () and research.halts == ()
    limits = MODES.replay.limits_for(Market.STOCKS)
    assert (limits.max_position_eur, limits.max_gross_exposure_eur) == (Decimal(20), Decimal(60))
    tolerance = Decimal("1.10")  # cycle.POST_CYCLE_CAP_TOLERANCE: drift above it would halt
    l_held, r_held = _held_eur(replay), _held_eur(research)
    assert max(max(p, default=Decimal(0)) for p in l_held) <= limits.max_position_eur * tolerance
    assert max(sum(p, Decimal(0)) for p in l_held) <= limits.max_gross_exposure_eur * tolerance
    assert max(max(p, default=Decimal(0)) for p in r_held) > Decimal(30), "R keeps 30% of a growing account"
    assert max(sum(p, Decimal(0)) for p in r_held) > Decimal(90)
    assert research.equity[-1].equity > replay.equity[-1].equity > Decimal(90)
    split = next(i for i, (a, b) in enumerate(zip(replay.sessions, research.sessions, strict=True)) if a != b)
    assert split > 100, "identical for a long time first"
    parted = replay.sessions[split].session
    before = [[f for f in r.fills if f.session < parted] for r in (replay, research)]
    assert before[0] == before[1] and len(before[0]) >= 5
    assert replay.equity[:split] == research.equity[:split]
    open_equity = replay.sessions[split].open_equity
    assert open_equity is not None and open_equity * limits.max_position_pct > Decimal("19.5"), (
        "they part only once 30% of equity reaches the EUR 20 cap"
    )
