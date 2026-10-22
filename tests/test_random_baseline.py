"""Baselines (spec section 7.3, trap 18 schedule part): seeds, random entries, buy-and-hold.

The random-entry schedule must keep the strategy's (holding length, weight) multiset per
symbol EXACTLY, never overlap or touch, stay inside the window, depend only on the seed
(derived from the study id with sha256), and be the same in every process. The
buy-and-hold helpers are tested against a fake dataset that has ONLY the ``PitDataset``
methods ``baselines.py`` may call (``calendar``, ``listed``, ``adjusted_close``,
``sessions``, ``adjusted_window``): calling anything else fails the test with an
AttributeError. The fake adjusts like the real one: a split counts from ``effective_at =
max(known_at, open print of its ex-session)``. The anchor cases also run on a real
``PitDataset`` (same numbers), and one test runs both helpers on the real dataset.
"""

from __future__ import annotations

import hashlib
import math
import os
import random
import subprocess
import sys
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from itertools import pairwise
from typing import Any, cast

import pytest
from hypothesis import given
from hypothesis import strategies as st

from helpers import make_risk_config
from samsulek.backtest.baselines import (
    buy_and_hold_plan,
    episode_shapes,
    random_entry_schedule,
    seeds_for,
    unconstrained_buy_and_hold,
)
from samsulek.backtest.dataset import CorporateAction, Listing, PitDataset
from samsulek.backtest.fence import RESEARCH_DATA_CUTOFF
from samsulek.backtest.sources import SourceData, SyntheticBarSource, SyntheticPlants
from samsulek.backtest.types import (
    BacktestIntegrityError,
    BacktestRefused,
    Detail,
    Episode,
    RandomEntriesPlan,
    RegistryPlan,
    RiskMode,
    RunJob,
    RunResult,
)
from samsulek.config import MarketLimits
from samsulek.data.bars import DailyBar
from samsulek.data.calendars import XetraCalendar
from samsulek.strategies.base import LookaheadError
from samsulek.types import Bar, Market

CAL = XetraCalendar()
SESSIONS: tuple[date, ...] = tuple(CAL.sessions(date(2004, 1, 2), date(2026, 12, 30)))
INDEX = {d: i for i, d in enumerate(SESSIONS)}
ONE_DAY = timedelta(days=1)


# ------------------------------------------------------------------------------ seeds
def test_seeds_follow_the_spec_formula() -> None:
    seeds = seeds_for("E001", 3)
    assert seeds == tuple(
        int(hashlib.sha256(f"E001:random-entries:{i}".encode("ascii")).hexdigest()[:12], 16) for i in range(3)
    )
    assert all(0 <= s < 2**48 for s in seeds)


def test_seeds_derive_from_the_study_id_only() -> None:
    assert seeds_for("E001", 50) == seeds_for("E001", 50)
    assert seeds_for("E001", 50)[:20] == seeds_for("E001", 20)  # the count never shifts a seed
    assert len(set(seeds_for("E001", 500))) == 500
    assert set(seeds_for("E001", 50)).isdisjoint(seeds_for("E002", 50))
    assert seeds_for("E001", 0) == ()


@pytest.mark.parametrize(("study_id", "count"), [("", 3), ("E001", -1), ("E001", True), ("E001", 2.0)])
def test_seed_arguments_are_checked(study_id: str, count: Any) -> None:
    with pytest.raises(ValueError, match=r"."):
        seeds_for(study_id, count)


# ------------------------------------------------------------------------------ the schedule
def layout(plan: RandomEntriesPlan, days: Sequence[date]) -> dict[str, list[tuple[int, int, float]]]:
    """Each symbol's episodes as (start index, end index, weight); end == len(days) is the
    day after the last session. Fails on any date outside the window."""
    where = {d: i for i, d in enumerate(days)}
    after_last = days[-1] + ONE_DAY if days else None
    out: dict[str, list[tuple[int, int, float]]] = {}
    for symbol, episodes in plan.schedule:
        rows = []
        for first, end, weight in episodes:
            assert first in where, (symbol, first)
            assert end in where or end == after_last, (symbol, end)
            rows.append((where[first], len(days) if end == after_last else where[end], weight))
        out[symbol] = rows
    return out


def reference(
    shapes: Sequence[tuple[int, float]], n: int, *, seed: int, symbol: str
) -> list[tuple[int, int, float]]:
    """Spec 7.3 steps 2-5, written out on their own: one generator per (seed, symbol), the
    K cuts first, then the order of the shapes."""
    k = len(shapes)
    free = n - sum(h for h, _ in shapes) - (k - 1)
    rng = random.Random(int.from_bytes(hashlib.sha256(f"{seed}:{symbol}".encode()).digest()[:8], "big"))
    cuts = sorted(rng.sample(range(free + k), k))
    gaps = [cuts[0]] + [cuts[i] - cuts[i - 1] - 1 for i in range(1, k)] + [free + k - 1 - cuts[-1]]
    order = rng.sample(list(shapes), k)
    out, pos = [], gaps[0]
    for j, (h, w) in enumerate(order):
        out.append((pos, pos + h, w))
        pos = pos + h + gaps[j + 1] + 1
    return out


WEIGHTS = (0.05, 0.1, 0.3, 1 / 3, 1.0, 1.5)


@st.composite
def schedules(draw: st.DrawFn) -> tuple[dict[str, list[tuple[int, float]]], tuple[date, ...], int]:
    symbols = draw(st.lists(st.sampled_from(["AAA", "BBB", "C.DE"]), unique=True, max_size=3))
    shapes: dict[str, list[tuple[int, float]]] = {}
    need = 0
    for symbol in symbols:
        items = draw(st.lists(st.tuples(st.integers(1, 40), st.sampled_from(WEIGHTS)), max_size=8))
        shapes[symbol] = items
        if items:
            need = max(need, sum(h for h, _ in items) + len(items) - 1)
    n = need + draw(st.integers(0, 60))
    start = draw(st.integers(0, len(SESSIONS) - 400))
    seed = draw(st.integers(0, 2**48 - 1))
    return shapes, SESSIONS[start : start + n], seed


@given(schedules())
def test_trap18_the_schedule_keeps_every_shape_and_never_overlaps(
    case: tuple[dict[str, list[tuple[int, float]]], tuple[date, ...], int],
) -> None:
    shapes, days, seed = case
    plan = random_entry_schedule(shapes, days, seed=seed)
    assert plan.seed == seed
    assert [s for s, _ in plan.schedule] == sorted(s for s, items in shapes.items() if items)
    rows = layout(plan, days)
    for symbol, episodes in rows.items():
        # the exact (holding length, weight) multiset
        assert Counter((end - start, w) for start, end, w in episodes) == Counter(shapes[symbol])
        assert all(type(w) is float for _, _, w in episodes)
        # inside the window, in order, never overlapping and never touching: the session
        # after an episode is its exit, so the next one starts at least one session later
        assert all(0 <= start < end <= len(days) for start, end, _ in episodes)
        assert all(a_end < b_start for (_, a_end, _), (b_start, _, _) in pairwise(episodes))
        assert episodes == reference(shapes[symbol], len(days), seed=seed, symbol=symbol)
    # the same seed gives the same schedule
    assert random_entry_schedule(shapes, days, seed=seed) == plan


def test_the_schedule_holds_at_most_one_episode_per_session() -> None:
    days = SESSIONS[100:160]
    plan = random_entry_schedule({"AAA": [(5, 0.3)] * 6 + [(10, 0.2)]}, days, seed=11)
    held = Counter(i for start, end, _ in layout(plan, days)["AAA"] for i in range(start, end))
    assert sum(held.values()) == 40 and set(held.values()) == {1}


def test_different_seeds_give_different_schedules() -> None:
    days = SESSIONS[1000:1250]
    shapes = {"AAA": [(10, 0.3), (25, 0.3), (3, 0.25), (40, 0.3)], "BBB": [(60, 0.2)]}
    plans = {random_entry_schedule(shapes, days, seed=s).schedule for s in seeds_for("E001", 40)}
    assert len(plans) == 40


def test_each_symbol_has_its_own_generator() -> None:
    # Adding, removing or reordering other symbols never shifts a symbol's draws.
    days = SESSIONS[2000:2300]
    alone = random_entry_schedule({"AAA": [(10, 0.3), (7, 0.1)]}, days, seed=5)
    crowd = random_entry_schedule(
        {"ZZZ": [(50, 0.2)], "AAA": [(10, 0.3), (7, 0.1)], "BBB": [(3, 0.3)] * 9}, days, seed=5
    )
    assert dict(crowd.schedule)["AAA"] == dict(alone.schedule)["AAA"]
    assert [s for s, _ in crowd.schedule] == ["AAA", "BBB", "ZZZ"]


def test_a_symbol_without_episodes_is_left_out() -> None:
    plan = random_entry_schedule({"AAA": [], "BBB": [(2, 0.5)]}, SESSIONS[:10], seed=1)
    assert [s for s, _ in plan.schedule] == ["BBB"]
    assert random_entry_schedule({}, (), seed=1) == RandomEntriesPlan(seed=1, schedule=())


def test_an_exact_fit_leaves_one_exit_session_between_episodes() -> None:
    # free = 0: S = sum(h) + (K - 1), so every gap is 0 whatever the seed.
    days = SESSIONS[500:511]  # 11 sessions = 3 + 4 + 2 holdings + 2 exits
    for seed in seeds_for("S001", 30):
        rows = layout(random_entry_schedule({"AAA": [(3, 0.1), (4, 0.2), (2, 0.3)]}, days, seed=seed), days)[
            "AAA"
        ]
        assert rows[0][0] == 0 and rows[-1][1] == 11  # runs to the end: the day after the last session
        assert all(b[0] == a[1] + 1 for a, b in pairwise(rows))


def test_an_episode_ending_at_the_window_end_maps_to_the_day_after_the_last_session() -> None:
    days = SESSIONS[INDEX[date(2024, 9, 2)] : INDEX[date(2024, 9, 30)] + 1]
    plan = random_entry_schedule({"AAA": [(len(days), 0.3)]}, days, seed=3)
    assert plan.schedule == (("AAA", ((days[0], date(2024, 10, 1), 0.3),)),)


def test_placement_is_uniform_over_every_layout() -> None:
    # 6 sessions, shapes (1, a) and (2, b): free = 2, so C(4, 2) = 6 gap splits x 2 orders = 12
    # layouts, each about 1/12 of the seeds (a defect that never draws some layouts, or
    # always puts a shape first, fails this).
    days = SESSIONS[:6]
    counts = Counter(
        tuple(layout(random_entry_schedule({"AAA": [(1, 0.5), (2, 0.25)]}, days, seed=s), days)["AAA"])
        for s in seeds_for("S001", 2400)
    )
    assert len(counts) == 12
    assert all(120 <= c <= 280 for c in counts.values()), counts


def test_episodes_that_do_not_fit_are_an_integrity_error() -> None:
    with pytest.raises(BacktestIntegrityError, match="do not fit") as info:
        random_entry_schedule({"AAA": [(5, 0.3), (5, 0.3)]}, SESSIONS[:10], seed=1)  # 5 + 1 + 5 > 10
    assert info.value.label == "random_entries"
    with pytest.raises(BacktestIntegrityError, match="do not fit"):
        random_entry_schedule({"AAA": [(1, 0.3)]}, (), seed=1)
    assert random_entry_schedule(
        {"AAA": [(5, 0.3), (4, 0.3)]}, SESSIONS[:10], seed=1
    ).schedule  # 5 + 1 + 4 fits


@pytest.mark.parametrize(
    "shape",
    [
        (0, 0.3),
        (-1, 0.3),
        (True, 0.3),
        (2.0, 0.3),
        (3, 0.0),
        (3, -0.1),
        (3, math.nan),
        (3, math.inf),
        (3, True),
    ],
)
def test_a_malformed_shape_is_refused(shape: tuple[Any, Any]) -> None:
    with pytest.raises(ValueError, match="episode"):
        random_entry_schedule({"AAA": [shape]}, SESSIONS[:50], seed=1)


@pytest.mark.parametrize(
    ("days", "seed"),
    [
        (SESSIONS[:10][::-1], 1),
        ((SESSIONS[0], SESSIONS[0], SESSIONS[1]), 1),
        (SESSIONS[:10], -1),
        (SESSIONS[:10], True),
    ],
)
def test_malformed_sessions_or_seed_are_refused(days: Sequence[date], seed: Any) -> None:
    with pytest.raises(ValueError, match=r"."):
        random_entry_schedule({"AAA": [(1, 0.5)]}, days, seed=seed)


def test_the_schedule_is_the_same_under_any_hash_seed() -> None:
    # Spawned workers each get their own PYTHONHASHSEED: nothing may depend on hash().
    code = (
        "from datetime import date\n"
        "from samsulek.backtest.baselines import random_entry_schedule, seeds_for\n"
        "from samsulek.data.calendars import XetraCalendar\n"
        "days = XetraCalendar().sessions(date(2020, 1, 2), date(2021, 6, 30))\n"
        "shapes = {'C.DE': [(9, 0.3), (40, 0.25)], 'AAA': [(3, 0.1)] * 7, 'BBB': [(100, 1.0)]}\n"
        "print(repr([random_entry_schedule(shapes, days, seed=s) for s in seeds_for('E007', 5)]))\n"
    )
    days = CAL.sessions(date(2020, 1, 2), date(2021, 6, 30))
    shapes = {"C.DE": [(9, 0.3), (40, 0.25)], "AAA": [(3, 0.1)] * 7, "BBB": [(100, 1.0)]}
    here = repr([random_entry_schedule(shapes, days, seed=s) for s in seeds_for("E007", 5)])
    for hash_seed in ("0", "4242"):
        out = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True,
            text=True,
            check=True,
            env={**os.environ, "PYTHONHASHSEED": hash_seed},
            timeout=60,
        )
        assert out.stdout.strip() == here


# ------------------------------------------------------------------------------ episode shapes
def job(
    label: str = "strategy_R_1x", *, risk_mode: RiskMode = RiskMode.R, cost_multiplier: int = 1
) -> RunJob:
    return RunJob(
        index=0,
        label=label,
        plan=RegistryPlan("demo_above_average", ((SESSIONS[0], (("lookback", 10),)),)),
        universe=("AAA", "BBB"),
        min_history=10,
        first_session=SESSIONS[0],
        last_session=SESSIONS[-1],
        risk_mode=risk_mode,
        cost_multiplier=cost_multiplier,
        starting_cash_eur=Decimal(50),
        detail=Detail.FULL,
    )


def episode(symbol: str, entry: date, held: int, weight: float, *, open_at_end: bool = False) -> Episode:
    return Episode(
        symbol=symbol,
        entry_session=entry,
        exit_session=None if open_at_end else SESSIONS[INDEX[entry] + held],
        sessions_held=held,
        weight=weight,
        buy_eur=Decimal(15),
        sell_eur=Decimal(0) if open_at_end else Decimal(16),
        fees_eur=Decimal(0),
        pnl_eur=Decimal(1),
        open_at_end=open_at_end,
    )


def result_with(episodes: Sequence[Episode], label: str = "strategy_R_1x") -> RunResult:
    return RunResult(
        job=job(label),
        start_ts=datetime(2004, 1, 1, 16, 30, tzinfo=UTC),
        start_equity=Decimal(50),
        equity=(),
        sessions=(),
        fills=(),
        halts=(),
        episodes=tuple(episodes),
        residual_eur=Decimal(0),
        frozen_equity=(),
        decisions_gz=None,
        data_fingerprint="f" * 64,
        risk_config_sha256="r" * 64,
    )


def test_episode_shapes_per_symbol_in_entry_order_open_ones_included() -> None:
    eps = [
        episode("BBB", SESSIONS[50], 7, 0.25),
        episode("AAA", SESSIONS[30], 4, 0.3),
        episode("AAA", SESSIONS[10], 12, 0.3),
        episode("BBB", SESSIONS[80], 20, 0.2, open_at_end=True),
    ]
    assert episode_shapes(result_with(eps)) == {"AAA": ((12, 0.3), (4, 0.3)), "BBB": ((7, 0.25), (20, 0.2))}
    assert episode_shapes(result_with([])) == {}


def test_a_raw_target_weight_above_one_is_kept() -> None:
    # The logged targets are the strategy's raw weights, before sizing clips them; the
    # random copy gets the same raw weight and the same clipping.
    shapes = episode_shapes(
        result_with([episode("AAA", SESSIONS[5], 4, 1.5), episode("AAA", SESSIONS[20], 2, 1)])
    )
    assert shapes == {"AAA": ((4, 1.5), (2, 1.0))}
    assert all(type(w) is float for _, w in shapes["AAA"])


def test_shapes_from_a_run_round_trip_through_the_schedule() -> None:
    eps = [episode("AAA", SESSIONS[i], 5, 0.3) for i in (0, 10, 20)] + [episode("BBB", SESSIONS[3], 30, 0.2)]
    days = SESSIONS[:60]
    shapes = episode_shapes(result_with(eps))
    rows = layout(random_entry_schedule(shapes, days, seed=99), days)
    assert {s: Counter((e - b, w) for b, e, w in r) for s, r in rows.items()} == {
        s: Counter(v) for s, v in shapes.items()
    }


@pytest.mark.parametrize(("held", "weight"), [(0, 0.3), (5, 0.0), (5, math.nan), (5, -0.2)])
def test_an_episode_that_cannot_be_copied_is_an_integrity_error(held: int, weight: float) -> None:
    eps = [episode("AAA", SESSIONS[10], 3, 0.3), episode("AAA", SESSIONS[40], 5, 0.3)]
    bad = Episode(**{**_fields(eps[1]), "sessions_held": held, "weight": weight})
    with pytest.raises(BacktestIntegrityError, match="episode") as info:
        episode_shapes(result_with([eps[0], bad], label="strategy_R_1x"))
    assert info.value.label == "strategy_R_1x" and info.value.session == SESSIONS[40]


def _fields(e: Episode) -> dict[str, Any]:
    return {name: getattr(e, name) for name in Episode.__slots__}


@pytest.mark.parametrize(
    ("label", "mode", "multiplier"),
    [("strategy_L_1x", RiskMode.L, 1), ("strategy_R_2x", RiskMode.R, 2), ("strategy_L_2x", RiskMode.L, 2)],
)
def test_shapes_come_only_from_the_r_mode_run_at_1x(label: str, mode: RiskMode, multiplier: int) -> None:
    # Spec 7.3 step 1: the random entries copy strategy_R_1x. An L run's episodes are cut
    # by halts and a 2x run's by costs: copying them would test another null.
    run = replace(
        result_with([episode("AAA", SESSIONS[10], 3, 0.3)]),
        job=job(label, risk_mode=mode, cost_multiplier=multiplier),
    )
    with pytest.raises(BacktestIntegrityError, match="R-mode run at 1x") as info:
        episode_shapes(run)
    assert info.value.label == label


# ------------------------------------------------------------------------------ a fake dataset
@dataclass
class FakeSymbol:
    first_session: date
    bars: dict[date, tuple[float, float]]  # session -> (open, close), raw EUR
    delisting_known_at: datetime | None = None
    splits: tuple[tuple[date, float, datetime], ...] = ()  # (ex_session, price_factor, known_at)


@dataclass
class FakeDataset:
    """Only the PitDataset members baselines.py may use; it records every call."""

    symbols_data: dict[str, FakeSymbol]
    calendar: XetraCalendar = CAL
    calls: list[tuple[Any, ...]] = field(default_factory=list)

    def _factor(self, symbol: str, session: date, asof: datetime) -> float:
        """The real rule: a split adjusts the bars before its ex-session once it is in effect,
        at ``max(known_at, open print of the ex-session)`` (known AND traded on the new basis)."""
        out = 1.0
        for ex_session, factor, known_at in self.symbols_data[symbol].splits:
            effective_at = max(known_at, CAL.open_print_utc(ex_session))
            if effective_at <= asof and ex_session > session:
                out *= factor
        return out

    def listed(self, session: date, *, at: datetime, min_bars: int, among: Sequence[str]) -> tuple[str, ...]:
        self.calls.append(("listed", session, at, min_bars, tuple(among)))
        out = []
        for symbol in sorted(set(among)):
            fs = self.symbols_data.get(symbol)
            if fs is None or fs.first_session > session:
                continue
            if sum(1 for d in fs.bars if d < session) < min_bars:
                continue
            if fs.delisting_known_at is not None and fs.delisting_known_at <= at:
                continue
            out.append(symbol)
        return tuple(out)

    def adjusted_close(self, symbol: str, session: date, *, as_of: datetime) -> float:
        self.calls.append(("adjusted_close", symbol, session, as_of))
        fs = self.symbols_data[symbol]
        if session not in fs.bars:
            raise KeyError(f"no {symbol} close for {session}")
        if CAL.close_utc(session) > as_of:
            raise LookaheadError(f"{symbol} {session}")
        return fs.bars[session][1] * self._factor(symbol, session, as_of)

    def sessions(self, first: date, last: date) -> tuple[date, ...]:
        self.calls.append(("sessions", first, last))
        days = [d for fs in self.symbols_data.values() for d in fs.bars]
        start, end = max(first, min(days)), min(last, max(days))
        return tuple(CAL.sessions(start, end)) if start <= end else ()

    def adjusted_window(self, symbol: str, asof: datetime, window: int) -> tuple[Bar, ...]:
        self.calls.append(("adjusted_window", symbol, asof, window))
        fs = self.symbols_data[symbol]
        bars = []
        for d in sorted(fs.bars):
            if CAL.close_utc(d) > asof:
                continue
            f = self._factor(symbol, d, asof)
            o, c = fs.bars[d]
            bars.append(Bar(symbol, CAL.close_utc(d), o * f, max(o, c) * f, min(o, c) * f, c * f, 1000.0))
        return tuple(bars[-window:])


def flat(days: Sequence[date], open_: float, close: float) -> dict[date, tuple[float, float]]:
    return dict.fromkeys(days, (open_, close))


def as_dataset(fake: FakeDataset) -> PitDataset:
    return cast("PitDataset", fake)


def limits(max_position_pct: str) -> MarketLimits:
    return make_risk_config(markets={"stocks": {"max_position_pct": max_position_pct}}).limits_for(
        Market.STOCKS
    )


S = date(2021, 3, 1)  # a Monday
PREV = CAL.previous_session(S)  # Friday 2021-02-26
E = CAL.open_print_utc(S)
BEFORE = CAL.sessions(date(2021, 1, 4), PREV)
WINDOW = CAL.sessions(S, date(2021, 6, 30))
MIN_BARS = 20  # the jobs' min_history (W_max); the symbols of three() have len(BEFORE) bars


def three(**overrides: FakeSymbol) -> FakeDataset:
    base = {
        "AAA": FakeSymbol(date(2021, 1, 4), {**flat(BEFORE, 10.0, 10.0), PREV: (9.5, 10.5)}),
        "BBB": FakeSymbol(date(2021, 1, 4), {**flat(BEFORE, 20.0, 20.0), PREV: (19.0, 21.0)}),
        "CCC": FakeSymbol(date(2021, 1, 4), {**flat(BEFORE, 30.0, 30.0), PREV: (29.0, 31.0)}),
    }
    return FakeDataset({**base, **overrides})


# ------------------------------------------------------------------------------ buy-and-hold plan
@pytest.mark.parametrize(
    ("max_pct", "universe", "w0"),
    [
        ("0.30", ("AAA", "BBB", "CCC"), 0.3),  # min(0.30, 1/3)
        ("0.50", ("AAA", "BBB", "CCC"), 1 / 3),
        ("1.00", ("AAA", "BBB"), 0.5),
        ("0.20", ("AAA",), 0.2),
    ],
)
def test_buy_and_hold_weights_are_min_of_the_cap_and_one_over_n(
    max_pct: str, universe: tuple[str, ...], w0: float
) -> None:
    ds = three()
    plan = buy_and_hold_plan(
        as_dataset(ds), universe, limits=limits(max_pct), first_session=S, execute_at=E, min_bars=MIN_BARS
    )
    assert plan.weights0 == tuple((s, w0) for s in universe)
    closes = {"AAA": 10.5, "BBB": 21.0, "CCC": 31.0}
    assert plan.anchor_closes == tuple((s, closes[s]) for s in universe)
    # anchored at the previous session's close as visible at E, never later
    assert {c for c in ds.calls if c[0] == "adjusted_close"} == {
        ("adjusted_close", s, PREV, E) for s in universe
    }
    assert ("listed", S, E, MIN_BARS, universe) in ds.calls  # the runner's own universe rule


def test_only_symbols_listed_at_the_first_session_count() -> None:
    ds = three(
        BBB=FakeSymbol(date(2021, 3, 2), {}),  # listed after the first session
        CCC=FakeSymbol(date(2021, 1, 4), flat(BEFORE, 30.0, 31.0), delisting_known_at=E),  # known by E
        DDD=FakeSymbol(S, {}),  # first listed that day: no bar to anchor at
        EEE=FakeSymbol(
            date(2021, 1, 4), flat(BEFORE, 5.0, 5.5), delisting_known_at=E + timedelta(microseconds=1)
        ),
    )
    plan = buy_and_hold_plan(
        as_dataset(ds),
        ("AAA", "BBB", "CCC", "DDD", "EEE"),
        limits=limits("1.00"),
        first_session=S,
        execute_at=E,
        min_bars=MIN_BARS,
    )
    assert plan.weights0 == (("AAA", 0.5), ("EEE", 0.5))
    assert plan.anchor_closes == (("AAA", 10.5), ("EEE", 5.5))


AAA_BARS = {**flat(BEFORE, 10.0, 10.0), PREV: (9.5, 10.5)}


def real_aaa(split: tuple[date, float, datetime]) -> PitDataset:
    """AAA of ``three()`` with one split, as a real point-in-time dataset."""
    rows = tuple(
        DailyBar("AAA", d, CAL.close_utc(d), o, max(o, c), min(o, c), c, 1000.0, "EUR", "test")
        for d, (o, c) in sorted(AAA_BARS.items())
    )
    ex_session, factor, known_at = split
    data = SourceData(
        "anchor-check",
        True,
        rows,
        (Listing("AAA", "EUR", date(2021, 1, 4), None, None, "test fixture"),),
        (CorporateAction("AAA", ex_session, "split", factor, known_at),),
        None,
    )
    return PitDataset.build(data, calendar=CAL, cutoff=RESEARCH_DATA_CUTOFF)


@pytest.mark.parametrize(
    ("ex_session", "known_at", "anchor"),
    [
        (date(2021, 3, 8), E, 10.5),  # announced at E, ex-date a week later: old basis at E
        (date(2021, 3, 8), E - timedelta(days=30), 10.5),  # announced long before: still the old basis
        (S, E, 5.25),  # ex-date S, known at E: in effect from S's open print, which is E
        (S, E - timedelta(days=7), 5.25),
        (S, E + timedelta(seconds=1), 10.5),  # known just after E: not yet
    ],
)
def test_the_anchor_uses_only_corporate_actions_in_effect_at_execution(
    ex_session: date, known_at: datetime, anchor: float
) -> None:
    """A 2:1 split adjusts the anchor (PREV's close) only once it is in effect at E, at
    ``max(known_at, open print of the ex-session)``: known AND traded on the new basis. The
    real ``PitDataset`` gives the very same anchor as the fake."""
    split = (ex_session, 0.5, known_at)
    ds = three(AAA=FakeSymbol(date(2021, 1, 4), dict(AAA_BARS), splits=(split,)))
    plan = buy_and_hold_plan(
        as_dataset(ds), ("AAA",), limits=limits("0.30"), first_session=S, execute_at=E, min_bars=MIN_BARS
    )
    assert plan.anchor_closes == (("AAA", anchor),)
    real = buy_and_hold_plan(
        real_aaa(split), ("AAA",), limits=limits("0.30"), first_session=S, execute_at=E, min_bars=MIN_BARS
    )
    assert real.anchor_closes == plan.anchor_closes


def test_nothing_listed_is_refused() -> None:
    ds = three(AAA=FakeSymbol(date(2022, 1, 3), {}))
    with pytest.raises(BacktestRefused, match="no symbol"):
        buy_and_hold_plan(
            as_dataset(ds), ("AAA", "ZZZ"), limits=limits("0.30"), first_session=S, execute_at=E, min_bars=1
        )


def test_every_missing_anchor_is_listed() -> None:
    gap = {d: v for d, v in flat(BEFORE, 7.0, 7.0).items() if d != PREV}
    ds = three(AAA=FakeSymbol(date(2021, 1, 4), dict(gap)), CCC=FakeSymbol(date(2021, 1, 4), dict(gap)))
    with pytest.raises(BacktestRefused) as info:
        buy_and_hold_plan(
            as_dataset(ds),
            ("AAA", "BBB", "CCC"),
            limits=limits("0.30"),
            first_session=S,
            execute_at=E,
            min_bars=1,
        )
    assert len(info.value.problems) == 2
    assert all(f"no close on {PREV}" in p for p in info.value.problems)


def test_buy_and_hold_lists_exactly_the_runners_universe_at_its_first_session() -> None:
    # A10: a symbol listed after first_trading but before test_first_0 that has fewer than
    # min_history bars by then is not in the runner's universe at that session, so
    # buy-and-hold must leave it out too (else weights0 names a symbol the run cannot trade).
    young = CAL.sessions(date(2021, 2, 8), PREV)  # listed three weeks before S
    ds = three(
        DDD=FakeSymbol(date(2021, 2, 8), {**flat(young[:-1], 8.0, 8.0), PREV: (7.5, 8.5)}),
        EEE=FakeSymbol(date(2021, 1, 4), {**flat(BEFORE, 9.0, 9.0), PREV: (8.5, 9.5)}),
    )
    universe = ("AAA", "BBB", "CCC", "DDD", "EEE")
    assert len(BEFORE) > MIN_BARS > len(young)
    plan = buy_and_hold_plan(
        as_dataset(ds), universe, limits=limits("1.00"), first_session=S, execute_at=E, min_bars=MIN_BARS
    )
    assert [s for s, _ in plan.weights0] == ["AAA", "BBB", "CCC", "EEE"]
    assert plan.weights0 == tuple((s, 0.25) for s in ("AAA", "BBB", "CCC", "EEE"))
    assert [s for s, _ in plan.anchor_closes] == ["AAA", "BBB", "CCC", "EEE"]
    # exactly as many bars as needed is enough (the runner's rule is >= min_history)
    exact = buy_and_hold_plan(
        as_dataset(ds), universe, limits=limits("1.00"), first_session=S, execute_at=E, min_bars=len(young)
    )
    assert [s for s, _ in exact.weights0] == list(universe)
    assert exact.weights0[0][1] == 0.2


@pytest.mark.parametrize(
    ("first_session", "execute_at", "min_bars"),
    [
        (date(2021, 2, 27), E, MIN_BARS),  # a Saturday
        (S, CAL.close_utc(PREV), MIN_BARS),  # before the open print
        (S, E - timedelta(microseconds=1), MIN_BARS),  # just before the open print
        (S, CAL.close_utc(S), MIN_BARS),  # not before the session's own close
        (S, E.replace(tzinfo=None), MIN_BARS),
        (S, E, 0),  # an anchor needs at least one bar before the first session
        (S, E, -1),
        (S, E, True),
        (S, E, 20.0),
    ],
)
def test_buy_and_hold_arguments_are_checked(first_session: date, execute_at: datetime, min_bars: Any) -> None:
    with pytest.raises(ValueError, match=r".") as info:
        buy_and_hold_plan(
            as_dataset(three()),
            ("AAA",),
            limits=limits("0.30"),
            first_session=first_session,
            execute_at=execute_at,
            min_bars=min_bars,
        )
    assert not isinstance(info.value, BacktestRefused)


def test_buy_and_hold_may_execute_up_to_the_close() -> None:
    late = CAL.close_utc(S) - timedelta(microseconds=1)
    plan = buy_and_hold_plan(
        as_dataset(three()), ("AAA",), limits=limits("0.30"), first_session=S, execute_at=late, min_bars=1
    )
    assert plan.weights0 == (("AAA", 0.3),)


# ------------------------------------------------------------------------------ unconstrained buy-and-hold
def test_unconstrained_buy_and_hold_is_equal_weight_fully_invested_without_costs() -> None:
    last = WINDOW[-1]
    a = {d: (10.0 + i * 0.1, 10.05 + i * 0.1) for i, d in enumerate(WINDOW)}
    b = {d: (40.0 - i * 0.2, 39.9 - i * 0.2) for i, d in enumerate(WINDOW)}
    ds = FakeDataset({"AAA": FakeSymbol(date(2021, 1, 4), a), "BBB": FakeSymbol(date(2021, 1, 4), b)})
    points = unconstrained_buy_and_hold(
        as_dataset(ds), ("AAA", "BBB"), first=S, last=last, starting_cash=Decimal(50)
    )
    assert [p.session for p in points] == list(WINDOW)
    assert [p.ts for p in points] == [CAL.close_utc(d) for d in WINDOW]
    qa = Decimal(25) / Decimal(repr(a[S][0]))
    qb = Decimal(25) / Decimal(repr(b[S][0]))
    for p in points:
        expect = qa * Decimal(repr(a[p.session][1])) + qb * Decimal(repr(b[p.session][1]))
        assert p.cash == 0 and p.gross == p.equity
        assert abs(p.equity - expect) < Decimal("1e-20")
    # bought at the first OPEN: the first mark already moved with the first session
    assert points[0].equity != Decimal(50)


def test_unconstrained_buy_and_hold_values_everything_on_the_final_adjustment_basis() -> None:
    # A 2:1 split inside the window, announced mid-window: the raw price halves on the
    # ex-session, but with one consistent basis the equity never jumps.
    ex = WINDOW[30]
    raw = {d: ((10.0, 10.0) if d < ex else (5.0, 5.0)) for d in WINDOW}
    ds = FakeDataset(
        {"AAA": FakeSymbol(date(2021, 1, 4), raw, splits=((ex, 0.5, CAL.close_utc(WINDOW[20])),))}
    )
    points = unconstrained_buy_and_hold(
        as_dataset(ds), ("AAA",), first=S, last=WINDOW[-1], starting_cash=Decimal(50)
    )
    assert {p.equity for p in points} == {Decimal(50)}
    assert [c for c in ds.calls if c[0] == "adjusted_window"] == [
        ("adjusted_window", "AAA", CAL.close_utc(WINDOW[-1]), len(WINDOW))
    ]


def test_unconstrained_buy_and_hold_stops_at_the_first_missing_close() -> None:
    end = WINDOW[40]
    ds = FakeDataset(
        {
            "AAA": FakeSymbol(date(2021, 1, 4), flat(WINDOW, 10.0, 10.0)),
            "BBB": FakeSymbol(date(2021, 1, 4), flat([d for d in WINDOW if d <= end], 20.0, 20.0)),
        }
    )
    points = unconstrained_buy_and_hold(
        as_dataset(ds), ("AAA", "BBB"), first=S, last=WINDOW[-1], starting_cash=Decimal(50)
    )
    assert [p.session for p in points] == [d for d in WINDOW if d <= end]


def test_unconstrained_buy_and_hold_takes_the_symbols_listed_at_its_first_open() -> None:
    ds = FakeDataset(
        {
            "AAA": FakeSymbol(S, flat(WINDOW, 10.0, 11.0)),  # listed that very day: in
            "BBB": FakeSymbol(WINDOW[1], flat(WINDOW[1:], 20.0, 20.0)),  # listed later: out
            "CCC": FakeSymbol(date(2021, 1, 4), flat(WINDOW, 5.0, 5.0), delisting_known_at=E),  # known: out
        }
    )
    points = unconstrained_buy_and_hold(
        as_dataset(ds), ("AAA", "BBB", "CCC"), first=S, last=WINDOW[-1], starting_cash=Decimal(50)
    )
    assert points[0].equity == Decimal(55)
    assert ("listed", S, CAL.open_print_utc(S), 0, ("AAA", "BBB", "CCC")) in ds.calls


@pytest.mark.parametrize(
    ("kwargs", "error"),
    [
        ({"first": date(2021, 2, 27)}, ValueError),  # a Saturday
        ({"starting_cash": Decimal(0)}, ValueError),
        ({"starting_cash": Decimal("NaN")}, ValueError),
        ({"starting_cash": 50}, ValueError),
        ({"first": date(2021, 7, 1), "last": date(2021, 7, 30)}, ValueError),  # no data then
        ({"universe": ("ZZZ",)}, BacktestRefused),
    ],
)
def test_unconstrained_arguments_are_checked(kwargs: dict[str, Any], error: type[Exception]) -> None:
    ds = FakeDataset({"AAA": FakeSymbol(date(2021, 1, 4), flat(WINDOW, 10.0, 10.0))})
    args: dict[str, Any] = {
        "universe": ("AAA",),
        "first": S,
        "last": WINDOW[-1],
        "starting_cash": Decimal(50),
    }
    args.update(kwargs)
    universe = args.pop("universe")
    with pytest.raises(error):
        unconstrained_buy_and_hold(as_dataset(ds), universe, **args)


# ------------------------------------------------------------------------------ the real dataset
def test_both_buy_and_hold_helpers_on_the_real_point_in_time_dataset() -> None:
    universe = ("SYN_A", "SYN_B", "SYN_C")
    first, last = date(2016, 1, 4), date(2017, 12, 29)
    delisted = CAL.sessions(date(2017, 6, 1), date(2017, 6, 30))[-1]
    plants = SyntheticPlants(delistings=(("SYN_C", delisted, CAL.close_utc(delisted) + timedelta(days=3)),))
    data = SyntheticBarSource(seed=7, calendar=CAL, plants=plants).load(universe, first=first, last=last)
    ds = PitDataset.build(data, calendar=CAL, cutoff=RESEARCH_DATA_CUTOFF)
    s = CAL.next_session(date(2016, 12, 31))
    at = CAL.open_print_utc(s) + timedelta(minutes=3)
    window = 40
    plan = buy_and_hold_plan(
        ds, universe, limits=limits("0.30"), first_session=s, execute_at=at, min_bars=window
    )
    assert plan.weights0 == tuple((u, 0.3) for u in universe)
    assert tuple(u for u, _ in plan.weights0) == ds.listed(s, at=at, min_bars=window, among=universe)
    with pytest.raises(BacktestRefused, match="no symbol"):  # a year of data is not 300 bars
        buy_and_hold_plan(ds, universe, limits=limits("0.30"), first_session=s, execute_at=at, min_bars=300)
    for symbol, anchor in plan.anchor_closes:
        assert anchor == ds.adjusted_window(symbol, at, 1)[-1].close  # what the strategy sees last

    points = unconstrained_buy_and_hold(ds, universe, first=s, last=last, starting_cash=Decimal(50))
    sessions = ds.sessions(s, last)
    assert [p.session for p in points] == [d for d in sessions if d <= delisted]  # SYN_C has no close after
    bars = {u: {b.close_ts: b for b in ds.adjusted_window(u, CAL.close_utc(last), 1000)} for u in universe}
    qty = {u: Decimal(50) / 3 / Decimal(repr(bars[u][CAL.close_utc(s)].open)) for u in universe}
    for p in points:
        expect = sum((qty[u] * Decimal(repr(bars[u][p.ts].close)) for u in universe), Decimal(0))
        assert abs(p.equity - expect) < Decimal("1e-20")
