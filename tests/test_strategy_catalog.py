"""The strategy catalog, the baselines, the Lagged wrapper and the plans (spec 2.6; WP4).

- ``get_strategy``/``validate_params``: unknown names and every bad parameter are refused,
  all problems in one message; values come back normalised (floats as float).
- Every build, and every ``strategy_for_session`` call, gives a NEW instance.
- ``Lagged`` hides exactly the last k bars and keeps the decision time.
- ``DriftingBuyAndHold`` follows its formula by hand; ``ScheduledWeights`` is a pure function
  of the decision time's Berlin date, with ``first <= d < end``.
- ``plan_window`` and segment selection; ``plan_problems`` lists what cannot run.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta

import pytest

from samsulek.backtest.plans import BASELINE_WINDOW, plan_problems, plan_window, strategy_for_session
from samsulek.backtest.types import BuyAndHoldPlan, RandomEntriesPlan, RegistryPlan
from samsulek.data.calendars import XetraCalendar
from samsulek.strategies.base import Strategy, StrategyContext
from samsulek.strategies.baselines import DriftingBuyAndHold, ScheduledWeights
from samsulek.strategies.demo import EqualWeightAboveAverageDemo
from samsulek.strategies.params import ParamValue, as_params
from samsulek.strategies.registry import STRATEGIES, get_strategy, validate_params
from samsulek.strategies.wrappers import Lagged
from samsulek.types import Bar, Market, TargetWeights

CAL = XetraCalendar()
DAYS = CAL.sessions(date(2024, 1, 2), date(2024, 3, 28))
DEMO = get_strategy("demo_above_average")


def bars(symbol: str, closes: list[float]) -> tuple[Bar, ...]:
    return tuple(
        Bar(symbol, CAL.close_utc(d), c, c * 1.01, c * 0.99, c, 1000.0)
        for d, c in zip(DAYS, closes, strict=False)
    )


def ctx_at(day: date, data: dict[str, tuple[Bar, ...]]) -> StrategyContext:
    return StrategyContext(asof=CAL.open_print_utc(day), market=Market.STOCKS, bars=data)


# ------------------------------------------------------------------------------ catalog
def test_the_catalog_has_the_demo_only() -> None:
    assert sorted(STRATEGIES) == ["demo_above_average"]
    assert DEMO.name == "demo_above_average"
    with pytest.raises(ValueError, match="unknown strategy 'momentum'; the catalog has: demo_above_average"):
        get_strategy("momentum")
    with pytest.raises(TypeError):
        STRATEGIES["x"] = DEMO  # type: ignore[index]


def test_validate_params_normalises_and_lists_every_problem() -> None:
    assert validate_params(DEMO, {"lookback": 20, "gross": 1}) == {"gross": 1.0, "lookback": 20}
    assert isinstance(validate_params(DEMO, {"lookback": 2, "gross": 0.05})["gross"], float)
    assert validate_params(DEMO, {"lookback": 400, "gross": 1.0})["lookback"] == 400
    with pytest.raises(ValueError, match="invalid parameters for demo_above_average") as caught:
        validate_params(DEMO, {"lookback": 1, "extra": 3})
    text = str(caught.value)
    assert "extra is not a parameter" in text and "gross is missing" in text
    assert "lookback must be at least 2" in text
    bad = [
        ({"lookback": True, "gross": 0.5}, "lookback must be a whole number"),
        ({"lookback": 20.0, "gross": 0.5}, "lookback must be a whole number"),
        ({"lookback": 401, "gross": 0.5}, "lookback must be at most 400"),
        ({"lookback": 20, "gross": float("nan")}, "gross must be a finite number"),
        ({"lookback": 20, "gross": False}, "gross must be a finite number"),
        ({"lookback": 20, "gross": "0.5"}, "gross must be a finite number"),
        ({"lookback": 20, "gross": 0.04}, "gross must be at least 0.05"),
        ({"lookback": 20, "gross": 1.01}, "gross must be at most 1.0"),
    ]
    for params, expect in bad:
        with pytest.raises(ValueError, match=expect):
            validate_params(DEMO, params)  # type: ignore[arg-type]


def test_build_gives_a_fresh_demo_with_the_parameters_and_window() -> None:
    params = validate_params(DEMO, {"lookback": 5, "gross": 0.6})
    a, b = DEMO.build(params), DEMO.build(params)
    assert a is not b and isinstance(a, EqualWeightAboveAverageDemo)
    assert DEMO.window(params) == 5
    data = {"X": bars("X", [10, 11, 12, 13, 14]), "Y": bars("Y", [14, 13, 12, 11, 10])}
    out = a.target_weights(ctx_at(DAYS[5], data))
    assert out.weights == {"X": 0.6, "Y": 0.0}


# ------------------------------------------------------------------------------- Lagged
class Recorder:
    name = "recorder"

    def __init__(self) -> None:
        self.seen: list[StrategyContext] = []

    def target_weights(self, ctx: StrategyContext) -> TargetWeights:
        self.seen.append(ctx)
        return TargetWeights(weights={s: 0.1 for s in ctx.bars}, reason="recorded")


def test_lagged_hides_exactly_the_last_k_bars() -> None:
    data = {"X": bars("X", [float(i) for i in range(1, 11)]), "Y": bars("Y", [5.0, 6.0])}
    ctx = ctx_at(DAYS[10], data)
    for k in range(1, 6):
        inner = Recorder()
        lagged = Lagged(inner, k)
        assert lagged.name == f"recorder+lag{k}"
        assert lagged.target_weights(ctx).weights == {"X": 0.1, "Y": 0.1}
        (seen,) = inner.seen
        assert seen.asof == ctx.asof and seen.market is ctx.market
        assert seen.bars["X"] == data["X"][:-k] and isinstance(seen.bars["X"], tuple)
        assert seen.bars["Y"] == data["Y"][:-k]
    for bad in (0, 6, -1, True, 1.0):
        with pytest.raises(ValueError, match="lag_sessions"):
            Lagged(Recorder(), bad)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------- baselines
def test_drifting_buy_and_hold_follows_its_formula() -> None:
    w0 = {"A": 0.3, "B": 0.3, "C": 0.2}
    anchors = {"A": 10.0, "B": 20.0, "C": 50.0}
    strategy = DriftingBuyAndHold(w0, anchors)
    data = {
        "A": bars("A", [11.0, 12.0]),  # R = 1.2
        "B": bars("B", [19.0, 18.0]),  # R = 0.9
        "C": bars("C", [50.0, 60.0]),  # R = 1.2
        "D": bars("D", [1.0, 2.0]),  # not in the plan
    }
    out = strategy.target_weights(ctx_at(DAYS[2], data)).weights
    total = 0.2 + 0.3 * 1.2 + 0.3 * 0.9 + 0.2 * 1.2
    expected = {"A": 0.3 * 1.2 / total, "B": 0.3 * 0.9 / total, "C": 0.2 * 1.2 / total, "D": 0.0}
    assert out.keys() == expected.keys()
    assert all(math.isclose(out[s], expected[s], rel_tol=1e-12) for s in expected)
    # At the anchors the weights are exactly the starting ones.
    flat = {s: bars(s, [anchors[s]]) for s in anchors}
    start = strategy.target_weights(ctx_at(DAYS[1], flat)).weights
    assert all(math.isclose(start[s], w0[s], rel_tol=1e-12) for s in w0)
    # A symbol the context no longer offers drops out of the sum (the cycle sells it).
    partial = strategy.target_weights(ctx_at(DAYS[2], {"A": data["A"]})).weights
    assert math.isclose(partial["A"], 0.36 / (0.2 + 0.36), rel_tol=1e-12) and partial.keys() == {"A"}


def test_drifting_buy_and_hold_refuses_bad_plans() -> None:
    cases = [
        ({"A": -0.1}, {"A": 1.0}, "finite number >= 0"),
        ({"A": float("inf")}, {"A": 1.0}, "finite number >= 0"),
        ({"A": 0.5}, {"A": 0.0}, "finite number > 0"),
        ({"A": 0.5}, {"B": 1.0}, "same symbols"),
        ({"A": 0.6, "B": 0.6}, {"A": 1.0, "B": 1.0}, "above 1"),
    ]
    for weights, anchors, expect in cases:
        with pytest.raises(ValueError, match=expect):
            DriftingBuyAndHold(weights, anchors)
    third = 1 / 3
    DriftingBuyAndHold({"A": third, "B": third, "C": third}, {"A": 1.0, "B": 1.0, "C": 1.0})


def test_scheduled_weights_is_a_pure_function_of_the_berlin_date() -> None:
    first, end = DAYS[3], DAYS[6]
    strategy = ScheduledWeights({"A": [(first, end, 0.25)], "B": [(DAYS[0], DAYS[1], 0.5)]})
    old = CAL.close_utc(date(2023, 12, 29))  # a bar from before every decision below
    data = {s: (Bar(s, old, 1.0, 1.0, 1.0, 1.0, 1.0),) for s in ("A", "B", "C")}
    for day in DAYS[:10]:
        out = strategy.target_weights(ctx_at(day, data)).weights
        assert out == {
            "A": 0.25 if first <= day < end else 0.0,
            "B": 0.5 if day == DAYS[0] else 0.0,
            "C": 0.0,
        }
        again = ScheduledWeights({"A": [(first, end, 0.25)], "B": [(DAYS[0], DAYS[1], 0.5)]})
        assert again.target_weights(ctx_at(day, data)).weights == out, "no state between calls"
    # The Berlin date decides: 23:30 UTC on the day before `first` is already `first` in Berlin.
    late = datetime.combine(first - timedelta(days=1), datetime.min.time(), tzinfo=UTC) + timedelta(
        hours=23, minutes=30
    )
    early = StrategyContext(asof=late, market=Market.STOCKS, bars={})
    assert strategy.target_weights(early).weights == {}
    bare = {"A": data["A"]}
    assert strategy.target_weights(StrategyContext(asof=late, market=Market.STOCKS, bars=bare)).weights == {
        "A": 0.25
    }


def test_scheduled_weights_refuses_bad_schedules() -> None:
    a, b, c = DAYS[1], DAYS[3], DAYS[5]
    for schedule, expect in (
        ({"A": [(b, a, 0.1)]}, "first day before its end day"),
        ({"A": [(a, a, 0.1)]}, "first day before its end day"),
        ({"A": [(a, b, 0.0)]}, "finite weight > 0"),
        ({"A": [(a, b, float("nan"))]}, "finite weight > 0"),
        ({"A": [(a, c, 0.1), (b, c + timedelta(days=7), 0.1)]}, "overlap"),
        ({"A": [(datetime(2024, 1, 3, tzinfo=UTC), b, 0.1)]}, "first day before its end day"),
    ):
        with pytest.raises(ValueError, match=expect):
            ScheduledWeights(schedule)  # type: ignore[arg-type]
    ScheduledWeights({"A": [(a, b, 0.1), (b, c, 2.0)]})  # back to back is fine; sizing clips 2.0


# -------------------------------------------------------------------------------- plans
SEG = RegistryPlan(
    "demo_above_average",
    (
        (DAYS[0], as_params({"lookback": 10, "gross": 0.5})),
        (DAYS[20], as_params({"lookback": 30, "gross": 0.9})),
    ),
)


def test_strategy_for_session_picks_the_segment_and_is_always_fresh() -> None:
    seen = []
    for day in (DAYS[0], DAYS[19], DAYS[20], DAYS[40]):
        a, b = strategy_for_session(SEG, day), strategy_for_session(SEG, day)
        assert a is not b
        seen.append(a)
        assert isinstance(a, EqualWeightAboveAverageDemo)
        data = {"X": bars("X", [float(i) for i in range(1, 41)])}
        reason = a.target_weights(ctx_at(DAYS[45], data)).reason
        assert ("above 30-bar" in reason) is (day >= DAYS[20]), reason
    assert len({id(s) for s in seen}) == len(seen)
    with pytest.raises(ValueError, match="no parameters"):
        strategy_for_session(SEG, DAYS[0] - timedelta(days=1))
    lagged = RegistryPlan(SEG.strategy, SEG.segments, lag_sessions=2)
    s = strategy_for_session(lagged, DAYS[30])
    assert isinstance(s, Lagged) and s.name == "demo_equal_weight_above_average+lag2"


def test_plan_window() -> None:
    assert plan_window(SEG) == 30
    assert plan_window(RegistryPlan(SEG.strategy, SEG.segments, lag_sessions=5)) == 35
    bh = BuyAndHoldPlan(weights0=(("A", 0.3),), anchor_closes=(("A", 10.0),))
    rnd = RandomEntriesPlan(seed=1, schedule=(("A", ((DAYS[0], DAYS[2], 0.2),)),))
    assert plan_window(bh) == plan_window(rnd) == BASELINE_WINDOW == 1
    assert isinstance(strategy_for_session(bh, DAYS[0]), DriftingBuyAndHold)
    assert isinstance(strategy_for_session(rnd, DAYS[0]), ScheduledWeights)


def test_plan_problems_lists_what_cannot_run() -> None:
    assert plan_problems(SEG, universe=("X",), first_session=DAYS[0]) == []
    late = plan_problems(SEG, universe=("X",), first_session=DAYS[0] - timedelta(days=1))
    assert any("after the first session" in p for p in late)
    unknown = RegistryPlan("nope", SEG.segments)
    assert "unknown strategy 'nope'" in plan_problems(unknown, universe=("X",), first_session=DAYS[0])[0]
    bad = RegistryPlan(SEG.strategy, ((DAYS[0], as_params({"lookback": 1, "gross": 0.5})),))
    assert any(
        "lookback must be at least 2" in p for p in plan_problems(bad, universe=(), first_session=DAYS[0])
    )
    bh = BuyAndHoldPlan(weights0=(("A", 0.7), ("B", 0.7)), anchor_closes=(("A", 1.0), ("B", 1.0)))
    found = plan_problems(bh, universe=("A",), first_session=DAYS[0])
    assert any("B, which is not in the job's universe" in p for p in found)
    assert any("above 1" in p for p in found)
    twice = RandomEntriesPlan(seed=1, schedule=(("A", ()), ("A", ())))
    assert any("more than once" in p for p in plan_problems(twice, universe=("A",), first_session=DAYS[0]))


def test_plan_problems_builds_every_segment(monkeypatch: pytest.MonkeyPatch) -> None:
    """A catalog strategy that refuses parameters its ranges allow is refused before the run."""
    from samsulek.backtest import plans

    def picky(params: Mapping[str, ParamValue]) -> Strategy:
        if params["lookback"] == 30:
            raise ValueError("planted: this strategy refuses a 30-bar lookback")
        return DEMO.build(params)

    monkeypatch.setattr(plans, "get_strategy", lambda name: replace(DEMO, build=picky))
    problems = plan_problems(SEG, universe=("X",), first_session=DAYS[0])
    assert problems == [f"segment from {DAYS[20]}: planted: this strategy refuses a 30-bar lookback"]
