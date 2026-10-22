"""Anchored walk-forward (spec section 7.2): fold geometry, prefix scoring, selection, the stitched plan."""

from __future__ import annotations

import calendar
import math
from bisect import bisect_left
from collections.abc import Sequence
from datetime import date
from decimal import Decimal
from itertools import pairwise
from typing import Any

import pytest
from hypothesis import given
from hypothesis import strategies as st

from samsulek.backtest.stats import sharpe_annual
from samsulek.backtest.types import (
    BacktestIntegrityError,
    BacktestRefused,
    Detail,
    HaltSummary,
    Metrics,
    RegistryPlan,
    RiskMode,
    RunJob,
    RunSummary,
    Variant,
    params_sha256,
)
from samsulek.backtest.walkforward import (
    Fold,
    choose,
    final_choice,
    plan_folds,
    prefix_scores,
    selected_plan,
)
from samsulek.data.calendars import XetraCalendar
from samsulek.strategies.params import as_params

CAL = XetraCalendar()
SESSIONS: tuple[date, ...] = tuple(CAL.sessions(date(2004, 1, 2), date(2026, 12, 30)))


def idx(day: date) -> int:
    i = bisect_left(SESSIONS, day)
    assert SESSIONS[i] == day
    return i


def first_session_on_or_after(day: date) -> date:
    return SESSIONS[bisect_left(SESSIONS, day)]


def add_months(day: date, months: int) -> date:  # the spec's rule, written out independently
    y, m = divmod(day.month - 1 + months, 12)
    year, month = day.year + y, m + 1
    return date(year, month, min(day.day, calendar.monthrange(year, month)[1]))


# ------------------------------------------------------------------------------ fake runs
def metrics(first: date, last: date) -> Metrics:
    return Metrics(
        first_session=first, last_session=last, n_returns=1, years=1.0, total_return=0.0, cagr=None,
        ann_vol=None, sharpe=None, sortino=None, sr_per_period=None, skew=None, kurtosis=None,
        max_drawdown=0.0, mdd_peak=None, mdd_trough=None, mdd_recovery=None, mdd_duration_sessions=0,
        mdd_duration_days=0, longest_underwater_sessions=0, recovered=True, n_episodes_closed=0,
        n_episodes_open=0, win_rate=None, avg_win_eur=None, avg_loss_eur=None, avg_win_pct=None,
        avg_loss_pct=None, profit_factor=None, turnover=0.0, exposure=0.0, time_in_market=0.0,
        weight_gap=0.0, n_fills=0, fees_eur=0.0, spread_eur=0.0, slippage_eur=0.0,
        cost_drag_bps_per_year=0.0, n_rejections=0,
    )  # fmt: skip


HALTS = HaltSummary(
    n_halts=0, sessions_halted=0, immediate_rehalts=0, first_halt_session=None, first_halt_equity=None,
    equity_sanity_halts=0, cap_drift_halts=0, hard_stop_active_at_end=False, frozen_end_equity=None,
)  # fmt: skip


def summary(
    index: int,
    days: Sequence[date],
    returns: Sequence[float] | None,
    *,
    first_session: date | None = None,
    sessions: Sequence[date] | str | None = "same",
    risk_mode: RiskMode = RiskMode.R,
    cost_multiplier: int = 1,
) -> RunSummary:
    first = days[0] if first_session is None else first_session
    job = RunJob(
        index=index,
        label=f"variant_{index:03d}",
        plan=RegistryPlan("demo_above_average", ((first, (("lookback", 10 + index),)),)),
        universe=("AAA",),
        min_history=1,
        first_session=first,
        last_session=days[-1],
        risk_mode=risk_mode,
        cost_multiplier=cost_multiplier,
        starting_cash_eur=Decimal(50),
        detail=Detail.RETURNS,
    )
    kept: tuple[date, ...] | None = (
        tuple(days) if isinstance(sessions, str) else None if sessions is None else tuple(sessions)
    )
    return RunSummary(
        job=job,
        sessions=kept,
        returns=None if returns is None else tuple(returns),
        metrics=metrics(days[0], days[-1]),
        halts=HALTS,
    )


def wiggle(n: int, *, mean: float, amp: float = 0.01, phase: int = 0) -> list[float]:
    """A deterministic, non-constant return series with a known drift."""
    return [mean + amp * math.sin(0.7 * (i + phase)) for i in range(n)]


def variant(i: int, lookback: int) -> Variant:
    params = as_params({"lookback": lookback, "gross": 0.9})
    return Variant(index=i, params=params, params_sha256=params_sha256(params))


# ------------------------------------------------------------------------------ fold geometry
def test_yearly_folds_back_to_back() -> None:
    folds = plan_folds(
        SESSIONS,
        first_trading=date(2012, 3, 1),
        last_trading=date(2024, 9, 30),
        min_train_years=4,
        test_months=12,
    )
    starts = [first_session_on_or_after(date(y, 3, 1)) for y in range(2016, 2025)]
    assert [f.test_first for f in folds] == starts
    assert starts[4] == date(2020, 3, 2)  # 2020-03-01 is a Sunday
    assert [f.index for f in folds] == list(range(9))
    assert folds[-1].test_last == date(2024, 9, 30)
    for f, nxt in pairwise(folds):
        assert SESSIONS[idx(f.test_last) + 1] == nxt.test_first
    for f in folds:
        assert f.train_first == date(2012, 3, 1)
        assert f.train_last == SESSIONS[idx(f.test_first) - 1]


def test_the_folds_partition_the_out_of_sample_sessions() -> None:
    folds = plan_folds(
        SESSIONS,
        first_trading=date(2010, 7, 1),
        last_trading=date(2024, 9, 30),
        min_train_years=4,
        test_months=7,
    )
    covered = [d for f in folds for d in SESSIONS[idx(f.test_first) : idx(f.test_last) + 1]]
    assert covered == [d for d in SESSIONS if folds[0].test_first <= d <= date(2024, 9, 30)]


@pytest.mark.parametrize(
    ("first_trading", "years", "expected"),
    [
        (date(2016, 2, 29), 3, date(2019, 2, 28)),  # Feb 29 -> Feb 28 (a Thursday session)
        (date(2016, 2, 29), 4, date(2020, 3, 2)),  # Feb 29 2020 exists but is a Saturday
        (date(2015, 3, 2), 2, date(2017, 3, 2)),
    ],
)
def test_training_years_are_calendar_years(first_trading: date, years: int, expected: date) -> None:
    folds = plan_folds(
        SESSIONS,
        first_trading=first_trading,
        last_trading=date(2024, 9, 30),
        min_train_years=years,
        test_months=12,
    )
    assert folds[0].test_first == expected
    assert folds[0].train_last == SESSIONS[idx(expected) - 1]


def test_month_ends_are_clamped_from_the_first_test_session_without_drift() -> None:
    folds = plan_folds(
        SESSIONS,
        first_trading=date(2014, 1, 31),
        last_trading=date(2021, 1, 29),
        min_train_years=5,
        test_months=3,
    )
    assert folds[0].test_first == date(2019, 1, 31)
    # Jan 31 + 3 months = Apr 30; + 6 months = Jul 31 (not Jul 30: no drift from Apr 30)
    assert [f.test_first for f in folds[:4]] == [
        date(2019, 1, 31),
        date(2019, 4, 30),
        date(2019, 7, 31),
        date(2019, 10, 31),
    ]


def _last_window_with(n_sessions: int) -> tuple[date, date]:
    """(first_trading, last_trading) whose LAST test window holds exactly n_sessions."""
    first_trading = date(2012, 3, 1)
    long = plan_folds(
        SESSIONS,
        first_trading=first_trading,
        last_trading=date(2024, 9, 30),
        min_train_years=4,
        test_months=12,
    )
    start = long[3].test_first
    return first_trading, SESSIONS[idx(start) + n_sessions - 1]


def test_a_last_window_shorter_than_63_sessions_merges_into_the_previous_one() -> None:
    first_trading, last_trading = _last_window_with(62)
    folds = plan_folds(
        SESSIONS, first_trading=first_trading, last_trading=last_trading, min_train_years=4, test_months=12
    )
    assert len(folds) == 3
    assert folds[-1].test_last == last_trading
    assert folds[-1].test_first == first_session_on_or_after(date(2018, 3, 1))


def test_a_last_window_of_63_sessions_stays() -> None:
    first_trading, last_trading = _last_window_with(63)
    folds = plan_folds(
        SESSIONS, first_trading=first_trading, last_trading=last_trading, min_train_years=4, test_months=12
    )
    assert len(folds) == 4
    assert idx(folds[-1].test_last) - idx(folds[-1].test_first) + 1 == 63


def test_short_windows_merge_until_the_last_one_has_63_sessions() -> None:
    # One-month windows hold about 21 sessions: one merge is not enough, so it repeats.
    start = idx(date(2016, 3, 1))
    folds = plan_folds(
        SESSIONS,
        first_trading=date(2012, 3, 1),
        last_trading=SESSIONS[start + 99],
        min_train_years=4,
        test_months=1,
    )
    sizes = [idx(f.test_last) - idx(f.test_first) + 1 for f in folds]
    assert sum(sizes) == 100 and sizes[-1] >= 63
    assert all(19 <= n <= 23 for n in sizes[:-1])  # the earlier windows stay one month long
    assert folds[-1].test_last == SESSIONS[start + 99]


def test_no_out_of_sample_session_is_refused() -> None:
    with pytest.raises(BacktestRefused, match="no walk-forward fold fits"):
        plan_folds(
            SESSIONS,
            first_trading=date(2012, 3, 1),
            last_trading=date(2016, 2, 29),
            min_train_years=4,
            test_months=12,
        )


def test_a_lone_short_window_is_refused_and_63_sessions_is_one_fold() -> None:
    start = idx(date(2016, 3, 1))
    with pytest.raises(BacktestRefused, match="fewer than 63"):
        plan_folds(
            SESSIONS,
            first_trading=date(2012, 3, 1),
            last_trading=SESSIONS[start + 61],
            min_train_years=4,
            test_months=12,
        )
    folds = plan_folds(
        SESSIONS,
        first_trading=date(2012, 3, 1),
        last_trading=SESSIONS[start + 62],
        min_train_years=4,
        test_months=12,
    )
    assert len(folds) == 1 and folds[0].test_first == date(2016, 3, 1)


@pytest.mark.parametrize(
    ("sessions", "kwargs"),
    [
        (SESSIONS[::-1], {}),
        ((*SESSIONS[:10], SESSIONS[9], *SESSIONS[10:]), {}),
        (SESSIONS, {"first_trading": date(2012, 3, 3)}),  # a Saturday
        (SESSIONS, {"min_train_years": 0}),
        (SESSIONS, {"min_train_years": True}),
        (SESSIONS, {"test_months": 0}),
        (SESSIONS, {"last_trading": date(2011, 1, 3)}),
    ],
)
def test_malformed_arguments(sessions: Sequence[date], kwargs: dict[str, Any]) -> None:
    args: dict[str, Any] = {
        "first_trading": date(2012, 3, 1),
        "last_trading": date(2024, 9, 30),
        "min_train_years": 4,
        "test_months": 12,
    }
    with pytest.raises(ValueError, match=r".") as info:
        plan_folds(sessions, **{**args, **kwargs})
    assert not isinstance(info.value, BacktestRefused)


@given(
    start=st.integers(min_value=0, max_value=4000),
    years=st.integers(min_value=1, max_value=8),
    months=st.integers(min_value=1, max_value=24),
    tail=st.integers(min_value=0, max_value=3000),
)
def test_fold_geometry_property(start: int, years: int, months: int, tail: int) -> None:
    first_trading = SESSIONS[start]
    last_trading = SESSIONS[min(len(SESSIONS) - 1, start + 250 * years + tail)]
    oos = [d for d in SESSIONS if _add_years(first_trading, years) <= d <= last_trading]
    try:
        folds = plan_folds(
            SESSIONS,
            first_trading=first_trading,
            last_trading=last_trading,
            min_train_years=years,
            test_months=months,
        )
    except BacktestRefused:
        # refused only when nothing is out of sample, or the single window is too short
        assert not oos or len(oos) < 63
        return
    assert oos and [d for f in folds for d in SESSIONS[idx(f.test_first) : idx(f.test_last) + 1]] == oos
    base = folds[0].test_first
    assert base == oos[0]
    for k, f in enumerate(folds):
        assert f.index == k and f.train_first == first_trading
        assert f.train_last == SESSIONS[idx(f.test_first) - 1] and f.train_last < f.test_first <= f.test_last
        assert f.test_first == first_session_on_or_after(add_months(base, k * months))
    assert idx(folds[-1].test_last) - idx(folds[-1].test_first) + 1 >= 63
    assert folds[-1].test_last == oos[-1]


def _add_years(day: date, years: int) -> date:
    try:
        return day.replace(year=day.year + years)
    except ValueError:
        return day.replace(year=day.year + years, day=28)


# ------------------------------------------------------------------------------ prefix scores
DAYS = SESSIONS[idx(date(2012, 3, 1)) : idx(date(2012, 3, 1)) + 400]
FOLD = Fold(index=0, train_first=DAYS[0], train_last=DAYS[249], test_first=DAYS[250], test_last=DAYS[-1])


def test_the_prefix_score_is_the_sharpe_of_the_training_returns_only() -> None:
    returns = wiggle(400, mean=0.0005)
    scores = prefix_scores({0: summary(0, DAYS, returns)}, FOLD)
    assert scores == {0: sharpe_annual(returns[:250])}


def test_returns_after_the_training_window_never_change_a_score() -> None:
    # The leak test: anything after train_last (out of sample) must be invisible to selection.
    base = wiggle(400, mean=0.0004)
    perturbed = base[:250] + [r * 50 - 0.2 for r in base[250:]]
    a = prefix_scores({0: summary(0, DAYS, base)}, FOLD)
    b = prefix_scores({0: summary(0, DAYS, perturbed)}, FOLD)
    assert a == b


def test_an_out_of_sample_best_variant_is_not_chosen() -> None:
    good_in_training = wiggle(250, mean=0.001) + wiggle(150, mean=-0.002)
    good_out_of_sample = wiggle(250, mean=0.0002, phase=3) + wiggle(150, mean=0.01, phase=3)
    runs = {0: summary(0, DAYS, good_out_of_sample), 1: summary(1, DAYS, good_in_training)}
    assert choose(prefix_scores(runs, FOLD)) == 1
    assert final_choice(runs, first=DAYS[0], last=DAYS[-1]) == 0


def test_flat_returns_score_none() -> None:
    assert prefix_scores({0: summary(0, DAYS, [0.0] * 400)}, FOLD) == {0: None}


@pytest.mark.parametrize(
    ("make", "message"),
    [
        (lambda: summary(0, DAYS, None), "no daily returns"),
        (lambda: summary(0, DAYS, wiggle(400, mean=0.0), sessions=None), "no daily returns"),
        (lambda: summary(0, DAYS, wiggle(399, mean=0.0)), "400 sessions but 399 returns"),
        (lambda: summary(0, DAYS[5:], wiggle(395, mean=0.0)), "must start at the window start"),
        (lambda: summary(0, DAYS, wiggle(400, mean=0.0), first_session=DAYS[1]), "do not span its job"),
        (lambda: summary(0, DAYS, wiggle(399, mean=0.0), sessions=DAYS[:-1]), "do not span its job"),
        (lambda: summary(0, DAYS, wiggle(399, mean=0.0), sessions=DAYS[1:]), "do not span its job"),
        (lambda: summary(0, DAYS, (), sessions=()), "do not span its job"),
        (lambda: summary(0, DAYS, wiggle(400, mean=0.0), risk_mode=RiskMode.L), "R-mode runs at 1x"),
        (lambda: summary(0, DAYS, wiggle(400, mean=0.0), cost_multiplier=2), "R-mode runs at 1x"),
        (lambda: summary(0, DAYS[:200], wiggle(200, mean=0.0)), "does not cover the window"),
        (lambda: summary(0, DAYS, wiggle(400, mean=0.0), sessions=DAYS[::-1]), "not in order"),
        (lambda: summary(0, DAYS, [*wiggle(100, mean=0.0), math.nan, *wiggle(299, mean=0.0)]), "finite"),
    ],
)
def test_a_run_that_cannot_be_scored_is_an_integrity_error(make: Any, message: str) -> None:
    with pytest.raises(BacktestIntegrityError, match=message) as info:
        prefix_scores({0: make()}, FOLD)
    assert info.value.label == "variant_000"


def test_variants_must_have_the_same_sessions_in_the_window() -> None:
    gappy = (*DAYS[:100], *DAYS[101:])
    runs = {0: summary(0, DAYS, wiggle(400, mean=0.0)), 1: summary(1, gappy, wiggle(399, mean=0.0))}
    with pytest.raises(BacktestIntegrityError, match="differ from the other variants") as info:
        prefix_scores(runs, FOLD)
    assert info.value.label == "variant_001"


def test_no_runs_no_scores() -> None:
    assert prefix_scores({}, FOLD) == {}


# ------------------------------------------------------------------------------ choose
@pytest.mark.parametrize(
    ("scores", "best"),
    [
        ({0: 1.0, 1: 2.0, 2: 0.5}, 1),
        ({0: 1.0, 1: 2.0, 2: 2.0}, 1),
        ({2: 2.0, 1: 2.0, 0: -1.0}, 1),  # ties go to the lowest index, whatever the insertion order
        ({0: None, 1: -5.0}, 1),
        ({0: -1.0, 1: None, 2: -0.5}, 2),
        ({7: 0.0}, 7),
        ({0: -0.0, 1: 0.0}, 0),
    ],
)
def test_choose(scores: dict[int, float | None], best: int) -> None:
    assert choose(scores) == best


def test_all_none_or_nothing_is_refused() -> None:
    with pytest.raises(BacktestRefused, match="no variant has a Sharpe ratio"):
        choose({0: None, 1: None})
    with pytest.raises(BacktestRefused, match="no variant to choose"):
        choose({})


@pytest.mark.parametrize("bad", [math.nan, math.inf, -math.inf])
def test_a_non_finite_score_is_a_bug(bad: float) -> None:
    with pytest.raises(ValueError, match="non-finite") as info:
        choose({0: 1.0, 1: bad})
    assert not isinstance(info.value, BacktestRefused)


@given(st.dictionaries(st.integers(0, 50), st.one_of(st.none(), st.floats(-10, 10)), min_size=1))
def test_choose_property(scores: dict[int, float | None]) -> None:
    present = {k: v for k, v in scores.items() if v is not None}
    if not present:
        with pytest.raises(BacktestRefused):
            choose(scores)
        return
    top = max(present.values())
    assert choose(scores) == min(k for k, v in present.items() if v == top)


# ------------------------------------------------------------------------------ the stitched plan
FOLDS = (
    Fold(0, date(2012, 3, 1), date(2016, 2, 29), date(2016, 3, 1), date(2017, 2, 28)),
    Fold(1, date(2012, 3, 1), date(2017, 2, 28), date(2017, 3, 1), date(2018, 2, 28)),
    Fold(2, date(2012, 3, 1), date(2018, 2, 28), date(2018, 3, 1), date(2019, 2, 28)),
)
VARIANTS = (variant(0, 10), variant(1, 20), variant(2, 40))


def test_selected_plan_switches_parameters_at_each_test_start() -> None:
    plan = selected_plan(
        "demo_above_average", folds=FOLDS, choices=[2, 0, 2], variants=VARIANTS, lag_sessions=1
    )
    assert plan == RegistryPlan(
        strategy="demo_above_average",
        segments=(
            (date(2016, 3, 1), VARIANTS[2].params),
            (date(2017, 3, 1), VARIANTS[0].params),
            (date(2018, 3, 1), VARIANTS[2].params),
        ),
        lag_sessions=1,
    )


def test_selected_plan_looks_variants_up_by_their_index_not_their_position() -> None:
    shuffled = (VARIANTS[2], VARIANTS[0], VARIANTS[1])
    plan = selected_plan(
        "demo_above_average", folds=FOLDS[:1], choices=[1], variants=shuffled, lag_sessions=0
    )
    assert plan.segments == ((date(2016, 3, 1), VARIANTS[1].params),)


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"folds": ()}, "at least one fold"),
        ({"choices": [0, 1]}, "3 folds but 2 choices"),
        ({"choices": [0, 1, 9]}, r"\[9\]"),
        ({"variants": (VARIANTS[0], VARIANTS[0], VARIANTS[1])}, "unique"),
        ({"lag_sessions": 6}, "lag_sessions"),
        ({"folds": (FOLDS[1], FOLDS[0], FOLDS[2])}, "sorted"),
    ],
)
def test_selected_plan_refuses_malformed_input(kwargs: dict[str, Any], message: str) -> None:
    args: dict[str, Any] = {"folds": FOLDS, "choices": [0, 1, 2], "variants": VARIANTS, "lag_sessions": 0}
    with pytest.raises(ValueError, match=message):
        selected_plan("demo_above_average", **{**args, **kwargs})


# ------------------------------------------------------------------------------ final choice
def test_final_choice_scores_the_whole_window() -> None:
    a = wiggle(400, mean=0.0002)
    b = wiggle(400, mean=0.0006, phase=2)
    runs = {0: summary(0, DAYS, a), 1: summary(1, DAYS, b)}
    assert final_choice(runs, first=DAYS[0], last=DAYS[-1]) == 1
    # a last day after the runs' end (a holiday or weekend) is fine for the final window
    assert final_choice(runs, first=DAYS[0], last=date(2030, 1, 1)) == 1


def test_final_choice_needs_runs_that_start_at_the_window_start() -> None:
    runs = {0: summary(0, DAYS, wiggle(400, mean=0.0))}
    with pytest.raises(BacktestIntegrityError, match="must start"):
        final_choice(runs, first=DAYS[1], last=DAYS[-1])


def test_final_choice_refuses_when_no_variant_has_a_sharpe_ratio() -> None:
    runs = {0: summary(0, DAYS, [0.0] * 400), 1: summary(1, DAYS, [0.001] * 400)}
    with pytest.raises(BacktestRefused):
        final_choice(runs, first=DAYS[0], last=DAYS[-1])
