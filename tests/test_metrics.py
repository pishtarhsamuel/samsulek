"""Run metrics on hand-computed equity curves (spec section 6).

Each curve is written out with its expected numbers worked by hand in the comments:
flat, monotonic, recovered and unrecovered drawdowns, ties at the peak, no losers, T = 1,
final equity <= 0 and less than half a year. A Hypothesis test compares the drawdown with
a brute-force reading of the definition.
"""

from __future__ import annotations

import dataclasses
import math
from collections.abc import Sequence
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from samsulek.backtest import metrics
from samsulek.backtest.metrics import PERIODS_PER_YEAR, compute_metrics, daily_returns, summarize
from samsulek.backtest.types import (
    BacktestIntegrityError,
    BuyAndHoldPlan,
    Detail,
    Episode,
    EquityPoint,
    FillRecord,
    HaltEvent,
    HaltKind,
    RiskMode,
    RunJob,
    RunResult,
    SessionRecord,
)
from samsulek.types import Fill, Market, Side

D0 = date(2024, 1, 1)  # the session before the first; its close is ts_0
ANN = math.sqrt(252)


def day(i: int) -> date:
    return D0 + timedelta(days=i)


def close_ts(d: date) -> datetime:
    return datetime.combine(d, time(16, 30), tzinfo=UTC)


def job(n: int, *, mode: RiskMode = RiskMode.R) -> RunJob:
    return RunJob(
        index=0,
        label="t_R_1x",
        plan=BuyAndHoldPlan(weights0=(("A", 0.3),), anchor_closes=(("A", 1.0),)),
        universe=("A", "B"),
        min_history=1,
        first_session=day(1),
        last_session=day(max(n, 1)),
        risk_mode=mode,
        cost_multiplier=1,
        starting_cash_eur=Decimal(50),
        detail=Detail.METRICS,
    )


def record(i: int, **kw: object) -> SessionRecord:
    base: dict[str, object] = {
        "session": day(i),
        "status": "done",
        "universe": ("A",),
        "reset_before": False,
        "orders_planned": 0,
        "orders_sent": 0,
        "orders_rejected": 0,
        "rejections": (),
        "targets": (),
        "actual": (),
        "open_equity": None,
    }
    base.update(kw)
    return SessionRecord(**base)  # type: ignore[arg-type]


def result(
    marks: Sequence[float | str | Decimal],
    *,
    start: Decimal = Decimal(50),
    gross: Sequence[float | str] | None = None,
    episodes: Sequence[Episode] = (),
    fills: Sequence[FillRecord] = (),
    sessions: Sequence[SessionRecord] | None = None,
    spacing: timedelta = timedelta(days=1),
    leading_start_point: bool = False,
    halts: Sequence[HaltEvent] = (),
) -> RunResult:
    """Marks m_1..m_T at day(1)..day(T) (every ``spacing`` apart), ts_0 = the close of day(0)."""
    start_ts = close_ts(D0)
    points = []
    for i, m in enumerate(marks, start=1):
        g = Decimal(str(gross[i - 1])) if gross is not None else Decimal(0)
        eq = Decimal(str(m))
        points.append(EquityPoint(session=day(i), ts=start_ts + spacing * i, cash=eq - g, gross=g, equity=eq))
    if leading_start_point:
        points.insert(0, EquityPoint(session=D0, ts=start_ts, cash=start, gross=Decimal(0), equity=start))
    return RunResult(
        job=job(len(marks)),
        start_ts=start_ts,
        start_equity=start,
        equity=tuple(points),
        sessions=tuple(sessions if sessions is not None else [record(i) for i in range(1, len(marks) + 1)]),
        fills=tuple(fills),
        halts=tuple(halts),
        episodes=tuple(episodes),
        residual_eur=Decimal(0),
        frozen_equity=(),
        decisions_gz=None,
        data_fingerprint="fp",
        risk_config_sha256="sha",
    )


def episode(pnl: str, *, buy: str = "10", open_at_end: bool = False) -> Episode:
    return Episode(
        symbol="A",
        entry_session=day(1),
        exit_session=None if open_at_end else day(2),
        sessions_held=1,
        weight=0.3,
        buy_eur=Decimal(buy),
        sell_eur=Decimal(buy) + Decimal(pnl),
        fees_eur=Decimal(0),
        pnl_eur=Decimal(pnl),
        open_at_end=open_at_end,
    )


def fill_record(
    i: int, side: Side, qty: str, price: str, *, fee: str = "0", spread: str, slip: str
) -> FillRecord:
    f = Fill(
        fill_id=f"F{i}-{side}",
        client_id=f"c{i}-{side}",
        market=Market.STOCKS,
        symbol="A",
        side=side,
        quantity=Decimal(qty),
        price=Decimal(price),
        fee=Decimal(fee),
        ts=close_ts(day(i)) - timedelta(hours=8),
    )
    return FillRecord(
        session=day(i),
        fill=f,
        reference=Decimal(price),
        spread_eur=Decimal(spread),
        slippage_eur=Decimal(slip),
    )


# =============================================================================== returns
def test_daily_returns_hand_vector() -> None:
    r = result([55, 44, 44])
    assert daily_returns(r.equity, Decimal(50)) == [pytest.approx(0.1), pytest.approx(-0.2), 0.0]


def test_daily_returns_refuse_a_zero_base() -> None:
    r = result([0, 10])
    with pytest.raises(ValueError, match="returns after zero equity"):
        daily_returns(r.equity, Decimal(50))
    with pytest.raises(ValueError, match="starting equity"):
        daily_returns(r.equity, Decimal(0))


# =============================================================================== flat and monotonic
def test_flat_curve() -> None:
    m = compute_metrics(result([50] * 300))
    assert m.n_returns == 300
    assert m.total_return == 0.0
    assert m.sharpe is None  # no variance
    assert m.sr_per_period is None
    assert m.skew is None
    assert m.kurtosis is None
    assert m.sortino is None  # no downside
    assert m.ann_vol == 0.0
    assert m.max_drawdown == 0.0
    assert (m.mdd_peak, m.mdd_trough, m.mdd_recovery) == (None, None, None)
    assert (m.mdd_duration_sessions, m.mdd_duration_days, m.longest_underwater_sessions) == (0, 0, 0)
    assert m.recovered is True
    assert m.years == pytest.approx(300 / 365.25)
    assert m.cagr == 0.0


def test_monotonic_rise() -> None:
    marks = [50 + i for i in range(1, 11)]
    m = compute_metrics(result(marks))
    r = [1 / (49 + i) for i in range(1, 11)]  # (50+i)/(49+i) - 1
    mu = sum(r) / 10
    s = math.sqrt(sum((x - mu) ** 2 for x in r) / 9)
    assert m.sharpe == pytest.approx(mu / s * ANN, rel=1e-12)
    assert m.ann_vol == pytest.approx(s * ANN, rel=1e-12)
    assert m.sortino is None
    assert m.max_drawdown == 0.0
    assert m.longest_underwater_sessions == 0
    assert m.total_return == pytest.approx(0.2)
    assert m.cagr is None  # 10 days < half a year
    assert (m.first_session, m.last_session) == (day(1), day(10))


def test_sharpe_and_sortino_hand_vector() -> None:
    # 50 -> 55 -> 49.5 -> 54.45: returns +10%, -10%, +10%
    m = compute_metrics(result(["55", "49.5", "54.45"]))
    mu = 0.1 / 3
    s = math.sqrt(((0.1 - mu) ** 2 * 2 + (-0.1 - mu) ** 2) / 2)
    downside = math.sqrt(0.01 / 3)
    assert m.sr_per_period == pytest.approx(mu / s, rel=1e-12)
    assert m.sharpe == pytest.approx(mu / s * ANN, rel=1e-12)
    assert m.sortino == pytest.approx(mu / downside * ANN, rel=1e-12)
    assert m.skew == pytest.approx(-1 / math.sqrt(2), rel=1e-9)  # two up, one down: m3/m2^1.5
    assert m.max_drawdown == pytest.approx(0.1)


# =============================================================================== drawdowns
def test_recovered_drawdown() -> None:
    # m0..m4 = 50, 60, 45, 50, 61: peak 60 (day 1), trough 45 (day 2): 1 - 45/60 = 25%;
    # back to >= 60 on day 4: 3 sessions, 3 days
    m = compute_metrics(result([60, 45, 50, 61]))
    assert m.max_drawdown == pytest.approx(0.25)
    assert (m.mdd_peak, m.mdd_trough, m.mdd_recovery) == (day(1), day(2), day(4))
    assert (m.mdd_duration_sessions, m.mdd_duration_days) == (3, 3)
    assert m.recovered is True
    assert m.longest_underwater_sessions == 3


def test_unrecovered_drawdown_runs_to_the_end() -> None:
    m = compute_metrics(result([60, 45, 50], spacing=timedelta(days=2)))
    assert m.max_drawdown == pytest.approx(0.25)
    assert (m.mdd_peak, m.mdd_trough, m.mdd_recovery) == (day(1), day(2), None)
    assert m.mdd_duration_sessions == 2  # peak index 1 to the end index 3
    assert m.mdd_duration_days == 2  # session dates are day(1)..day(3), whatever the stamps
    assert m.recovered is False
    assert m.longest_underwater_sessions == 2


def test_recovery_exactly_at_the_peak_counts() -> None:
    m = compute_metrics(result([60, 54, 60]))
    assert m.mdd_recovery == day(3)
    assert m.recovered is True
    assert m.mdd_duration_sessions == 2


def test_the_peak_is_the_last_mark_at_the_high() -> None:
    m = compute_metrics(result([60, 60, 54, 60]))
    assert m.mdd_peak == day(2)
    assert m.mdd_duration_sessions == 2


def test_a_drawdown_from_the_starting_cash() -> None:
    m = compute_metrics(result([40, 45]))
    assert m.max_drawdown == pytest.approx(0.2)
    assert m.mdd_peak == D0  # m_0, dated by ts_0 (UTC)
    assert m.mdd_trough == day(1)
    assert m.recovered is False
    assert m.mdd_duration_sessions == 2


def test_longest_underwater_need_not_be_the_deepest() -> None:
    # dd 1: 60 -> 40 -> 60 (1/3 deep, 2 sessions); dd 2: 60 -> 59..56 -> 60 (shallow, 5 sessions)
    m = compute_metrics(result([60, 40, 60, 59, 58, 57, 56, 60]))
    assert m.max_drawdown == pytest.approx(1 / 3)
    assert m.mdd_peak == day(1)
    assert m.mdd_duration_sessions == 2
    assert m.longest_underwater_sessions == 5


def test_equal_troughs_keep_the_first() -> None:
    m = compute_metrics(result([60, 45, 60, 45]))
    assert m.mdd_trough == day(2)
    assert m.mdd_recovery == day(3)


@given(st.lists(st.integers(min_value=1, max_value=200), min_size=1, max_size=40), st.integers(1, 200))
def test_drawdown_matches_the_definition(values: list[int], start: int) -> None:
    m = compute_metrics(result(values, start=Decimal(start)))
    v = [start, *values]
    brute = max(1 - Decimal(v[i]) / max(v[: i + 1]) for i in range(len(v)))
    assert m.max_drawdown == pytest.approx(float(brute), abs=1e-15)
    assert 0.0 <= m.max_drawdown < 1.0
    assert m.longest_underwater_sessions >= m.mdd_duration_sessions
    if m.max_drawdown == 0:
        assert all(v[i] >= max(v[: i + 1]) for i in range(len(v)))  # never below an earlier high
    else:
        assert m.mdd_peak is not None
        assert m.mdd_trough is not None
        peak = v[(m.mdd_peak - D0).days]
        trough = v[(m.mdd_trough - D0).days]
        assert float(1 - Decimal(trough) / peak) == pytest.approx(m.max_drawdown)
        later = v[(m.mdd_trough - D0).days + 1 :]
        assert m.recovered == any(x >= peak for x in later)


# =============================================================================== small samples and ruin
def test_one_return() -> None:
    m = compute_metrics(result([51]))
    assert m.n_returns == 1
    assert m.total_return == pytest.approx(0.02)
    assert (m.sharpe, m.sr_per_period, m.ann_vol, m.sortino, m.skew, m.kurtosis) == (None,) * 6
    assert m.cagr is None
    down = compute_metrics(result([49]))
    assert down.sortino == pytest.approx(-0.02 / 0.02 * ANN)  # mu / sqrt(r^2 / 1)
    assert down.sharpe is None


@pytest.mark.parametrize(("marks", "mdd"), [([40, 0], 1.0), (["40", "-5"], 1.1)])
def test_final_equity_at_or_below_zero(marks: list[float | str], mdd: float) -> None:
    m = compute_metrics(result(marks))
    assert m.cagr == -1.0  # even though Y < 0.5: everything is gone
    assert m.max_drawdown == pytest.approx(mdd)
    assert m.total_return == pytest.approx(float(Decimal(str(marks[-1])) / 50 - 1))


def test_zero_equity_before_the_end_is_refused() -> None:
    with pytest.raises(ValueError, match="before the end"):
        compute_metrics(result([40, 0, 10]))


def test_cagr_needs_half_a_year() -> None:
    # exactly 0.5 years later: CAGR is defined; 1 second less: None
    half = timedelta(days=365.25 / 2)
    assert compute_metrics(result([55], spacing=half)).cagr == pytest.approx(1.1**2 - 1)
    assert compute_metrics(result([55], spacing=half - timedelta(seconds=1))).cagr is None


def test_cagr_hand_vector() -> None:
    # 50 -> 72 over exactly 2 years: (1.44)^(1/2) - 1 = 20% a year
    m = compute_metrics(result([60, 72], spacing=timedelta(days=365.25)))
    assert m.years == pytest.approx(2.0)
    assert m.cagr == pytest.approx(0.2)


# =============================================================================== episodes
def test_episode_statistics() -> None:
    eps = [episode("2"), episode("-1"), episode("3", buy="20"), episode("0"), episode("9", open_at_end=True)]
    m = compute_metrics(result([50, 51], episodes=eps))
    assert (m.n_episodes_closed, m.n_episodes_open) == (4, 1)
    assert m.win_rate == 0.5  # 2 of 4 closed; the 0 episode is neither a win nor a loss
    assert m.avg_win_eur == pytest.approx(2.5)
    assert m.avg_loss_eur == pytest.approx(-1.0)
    assert m.avg_win_pct == pytest.approx((2 / 10 + 3 / 20) / 2)
    assert m.avg_loss_pct == pytest.approx(-0.1)
    assert m.profit_factor == pytest.approx(5.0)


def test_no_losers() -> None:
    m = compute_metrics(result([51, 52], episodes=[episode("1"), episode("2")]))
    assert m.win_rate == 1.0
    assert m.avg_loss_eur is None
    assert m.avg_loss_pct is None
    assert m.profit_factor is None  # no losses: the denominator is empty


def test_no_winners_and_no_closed_episodes() -> None:
    m = compute_metrics(result([49, 48], episodes=[episode("-1")]))
    assert (m.win_rate, m.avg_win_eur, m.profit_factor) == (0.0, None, 0.0)
    m = compute_metrics(result([49, 48], episodes=[episode("4", open_at_end=True)]))
    assert (m.n_episodes_closed, m.n_episodes_open) == (0, 1)
    assert (m.win_rate, m.avg_win_eur, m.avg_loss_eur, m.profit_factor) == (None, None, None, None)


# =============================================================================== activity and costs
def test_activity_and_cost_metrics() -> None:
    fills = [
        fill_record(1, Side.BUY, "1", "10", spread="0.01", slip="0.005"),
        fill_record(3, Side.SELL, "1", "11", fee="0.02", spread="0.011", slip="0.0055"),
    ]
    sessions = [
        record(1, targets=(("A", 0.3), ("B", 0.2)), actual=(("A", 0.25),), orders_rejected=1),
        record(2, status="halted", actual=(("A", 0.23),)),  # no targets: not in the weight gap
        record(3, targets=(("A", 0.0),), actual=(), orders_rejected=2),
        record(4, targets=(("A", 0.1),), actual=(("A", 0.1),)),
    ]
    r = result([50, 52, 51, 51], gross=[10, 12, 0, 0], fills=fills, sessions=sessions)
    m = compute_metrics(r)
    years = 4 / 365.25
    mean_equity = (50 + 52 + 51 + 51) / 4
    assert m.exposure == pytest.approx((10 / 50 + 12 / 52) / 4)
    assert m.time_in_market == 0.5
    assert m.turnover == pytest.approx((10 + 11) / 2 / mean_equity / years)
    assert m.weight_gap == pytest.approx((0.05 + 0.2 + 0.0 + 0.0) / 4)
    assert m.n_fills == 2
    assert m.fees_eur == pytest.approx(0.02)
    assert m.spread_eur == pytest.approx(0.021)
    assert m.slippage_eur == pytest.approx(0.0105)
    assert m.cost_drag_bps_per_year == pytest.approx((0.02 + 0.021 + 0.0105) / mean_equity / years * 10_000)
    assert m.n_rejections == 3


def test_weight_gap_covers_the_universe_and_all_cash_sessions() -> None:
    sessions = [
        # universe A, B; the strategy targets A only, so B's target is 0 while 0.1 is held
        record(1, universe=("A", "B"), targets=(("A", 0.3),), actual=(("A", 0.3), ("B", 0.1))),
        # "done" without targets: the strategy wanted all cash, A is still held
        record(2, universe=("A", "B"), targets=(), actual=(("A", 0.2),)),
        # halted before the strategy ran: nothing to compare
        record(3, status="halted", universe=("A", "B"), targets=(), actual=(("A", 0.5),)),
    ]
    m = compute_metrics(result([50, 51, 52], sessions=sessions))
    # pairs (1, A) 0, (1, B) 0.1, (2, A) 0.2, (2, B) 0
    assert m.weight_gap == pytest.approx(0.3 / 4)


def test_tiny_returns_do_not_underflow() -> None:
    # Sortino and the sample std are scale-free / linear in scale: 1e-170 returns give the
    # same Sortino as unit returns, and the std scales exactly.
    unit = [0.0, -1.0, 2.0, 0.5]
    tiny = [r * 1e-170 for r in unit]
    assert metrics._sortino(tiny) == pytest.approx(metrics._sortino(unit), rel=1e-12)
    std_unit, std_tiny = metrics._sample_std(unit), metrics._sample_std(tiny)
    assert std_unit is not None
    assert std_tiny is not None
    assert std_tiny == pytest.approx(std_unit * 1e-170, rel=1e-12)
    assert metrics._sortino([0.0, 0.0]) is None
    assert metrics._sortino([0.01, 0.02]) is None  # no downside


def test_positions_with_no_equity_are_refused() -> None:
    with pytest.raises(ValueError, match="positions worth"):
        compute_metrics(result([40, 0], gross=[10, 5]))


# =============================================================================== structure
def test_a_leading_start_point_is_m0_not_a_return() -> None:
    plain = compute_metrics(result([60, 45, 61]))
    with_start = compute_metrics(result([60, 45, 61], leading_start_point=True))
    assert with_start == plain
    bad = dataclasses.replace(result([60, 45], leading_start_point=True), start_equity=Decimal(49))
    with pytest.raises(BacktestIntegrityError, match="start mark"):
        compute_metrics(bad)


def test_marks_must_exist_and_be_in_time_order() -> None:
    empty = result([])
    with pytest.raises(BacktestIntegrityError, match="no equity marks"):
        compute_metrics(empty)
    r = result([51, 52])
    swapped = dataclasses.replace(r, equity=r.equity[::-1])
    with pytest.raises(BacktestIntegrityError, match="out of time order"):
        compute_metrics(swapped)


@pytest.mark.parametrize("detail", [Detail.FULL, Detail.RETURNS])
def test_summarize_keeps_returns(detail: Detail) -> None:
    r = result([55, 44], leading_start_point=True)
    s = summarize(r, detail)
    assert s.job == r.job
    assert s.sessions == (day(1), day(2))
    assert s.returns == (pytest.approx(0.1), pytest.approx(-0.2))
    assert s.metrics == compute_metrics(r)
    assert s.halts.n_halts == 0


def test_summarize_metrics_only_drops_returns() -> None:
    halt = HaltEvent(
        session=day(2),
        ts=close_ts(day(2)),
        kinds=(HaltKind.DAILY_LOSS,),
        reasons=("daily loss 3.1%",),
        reset_at=None,
        peak_rebased_to=None,
        immediate_rehalt=False,
    )
    s = summarize(result([55, 44], halts=[halt]), Detail.METRICS)
    assert (s.sessions, s.returns) == (None, None)
    assert s.halts.n_halts == 1
    assert s.halts.first_halt_session == day(2)
    assert s.metrics.n_returns == 2


def test_periods_per_year() -> None:
    assert PERIODS_PER_YEAR == 252
