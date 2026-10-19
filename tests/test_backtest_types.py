"""The backtester's contract types: frozen, picklable, field lists pinned to the M3 spec."""

from __future__ import annotations

import dataclasses
import hashlib
import inspect
import math
import pickle
import subprocess
import sys
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from hypothesis import given
from hypothesis import strategies as st

from helpers import make_risk_config
from samsulek.backtest import types as bt
from samsulek.backtest.types import (
    BacktestIntegrityError,
    BacktestRefused,
    BuyAndHoldPlan,
    Detail,
    EngineContext,
    Episode,
    EquityPoint,
    ExecutionTiming,
    FillRecord,
    HaltEvent,
    HaltKind,
    HaltSummary,
    Metrics,
    ModeConfigs,
    Period,
    RandomEntriesPlan,
    RegistryPlan,
    RiskMode,
    RunJob,
    RunResult,
    RunSummary,
    SessionRecord,
    Variant,
    params_sha256,
)
from samsulek.costs.stocks import StockCostParams
from samsulek.strategies.params import ParamValue, as_params
from samsulek.types import Fill, Market, Side

D1, D2 = date(2024, 4, 2), date(2024, 4, 3)
TS = datetime(2024, 4, 2, 7, 5, tzinfo=UTC)

# Field names and order of every contract dataclass, exactly as spec section 2.1 lists them.
EXPECTED_FIELDS: dict[type, tuple[str, ...]] = {
    ExecutionTiming: ("exec_delay", "reset_lead"),
    Variant: ("index", "params", "params_sha256"),
    RegistryPlan: ("strategy", "segments", "lag_sessions"),
    BuyAndHoldPlan: ("weights0", "anchor_closes"),
    RandomEntriesPlan: ("seed", "schedule"),
    RunJob: (
        "index",
        "label",
        "plan",
        "universe",
        "min_history",
        "first_session",
        "last_session",
        "risk_mode",
        "cost_multiplier",
        "starting_cash_eur",
        "detail",
    ),
    ModeConfigs: ("replay", "research", "replay_sha256", "research_sha256"),
    EngineContext: ("dataset", "modes", "costs", "timing", "quantity_step", "price_tick"),
    EquityPoint: ("session", "ts", "cash", "gross", "equity"),
    FillRecord: ("session", "fill", "reference", "spread_eur", "slippage_eur"),
    SessionRecord: (
        "session",
        "status",
        "universe",
        "reset_before",
        "orders_planned",
        "orders_sent",
        "orders_rejected",
        "rejections",
        "targets",
        "actual",
        "open_equity",
    ),
    HaltEvent: ("session", "ts", "kinds", "reasons", "reset_at", "peak_rebased_to", "immediate_rehalt"),
    Episode: (
        "symbol",
        "entry_session",
        "exit_session",
        "sessions_held",
        "weight",
        "buy_eur",
        "sell_eur",
        "fees_eur",
        "pnl_eur",
        "open_at_end",
    ),
    HaltSummary: (
        "n_halts",
        "sessions_halted",
        "immediate_rehalts",
        "first_halt_session",
        "first_halt_equity",
        "equity_sanity_halts",
        "cap_drift_halts",
        "hard_stop_active_at_end",
        "frozen_end_equity",
    ),
    RunResult: (
        "job",
        "start_ts",
        "start_equity",
        "equity",
        "sessions",
        "fills",
        "halts",
        "episodes",
        "residual_eur",
        "frozen_equity",
        "decisions_gz",
        "data_fingerprint",
        "risk_config_sha256",
    ),
    Metrics: (
        "first_session",
        "last_session",
        "n_returns",
        "years",
        "total_return",
        "cagr",
        "ann_vol",
        "sharpe",
        "sortino",
        "sr_per_period",
        "skew",
        "kurtosis",
        "max_drawdown",
        "mdd_peak",
        "mdd_trough",
        "mdd_recovery",
        "mdd_duration_sessions",
        "mdd_duration_days",
        "longest_underwater_sessions",
        "recovered",
        "n_episodes_closed",
        "n_episodes_open",
        "win_rate",
        "avg_win_eur",
        "avg_loss_eur",
        "avg_win_pct",
        "avg_loss_pct",
        "profit_factor",
        "turnover",
        "exposure",
        "time_in_market",
        "weight_gap",
        "n_fills",
        "fees_eur",
        "spread_eur",
        "slippage_eur",
        "cost_drag_bps_per_year",
        "n_rejections",
    ),
    RunSummary: ("job", "sessions", "returns", "metrics", "halts"),
}
NOT_SLOTTED = {RunResult}  # spec: @dataclass(frozen=True) only


def roundtrip(obj: Any, protocol: int = pickle.DEFAULT_PROTOCOL) -> Any:
    """Pickle and unpickle our own object, as a worker process would (never untrusted bytes)."""
    return pickle.loads(pickle.dumps(obj, protocol=protocol))  # noqa: S301


@dataclass(frozen=True)
class DatasetStandIn:
    """Stands in for PitDataset (WP3 tests its own pickling): EngineContext's own pickling."""

    name: str


def _params() -> tuple[tuple[str, ParamValue], ...]:
    return as_params({"lookback": 20, "gross": 0.9})


def _job(**over: Any) -> RunJob:
    fields: dict[str, Any] = {
        "index": 0,
        "label": "strategy_R_1x",
        "plan": RegistryPlan(strategy="demo_above_average", segments=((D1, _params()),)),
        "universe": ("AAA", "BBB"),
        "min_history": 20,
        "first_session": D1,
        "last_session": D2,
        "risk_mode": RiskMode.R,
        "cost_multiplier": 1,
        "starting_cash_eur": Decimal(50),
        "detail": Detail.FULL,
    }
    fields.update(over)
    return RunJob(**fields)


def _metrics() -> Metrics:
    values: dict[str, Any] = {}
    for f in dataclasses.fields(Metrics):
        if f.name in {"first_session", "last_session"}:
            values[f.name] = D1
        elif f.name in {"mdd_peak", "mdd_trough", "mdd_recovery"}:
            values[f.name] = None
        elif f.name == "recovered":
            values[f.name] = True
        elif f.type in ("int",):
            values[f.name] = 3
        else:
            values[f.name] = 0.25
    return Metrics(**values)


def _halt_summary() -> HaltSummary:
    return HaltSummary(
        n_halts=1,
        sessions_halted=1,
        immediate_rehalts=0,
        first_halt_session=D1,
        first_halt_equity=Decimal("48.40"),
        equity_sanity_halts=0,
        cap_drift_halts=0,
        hard_stop_active_at_end=False,
        frozen_end_equity=None,
    )


def _samples() -> dict[type, object]:
    fill = Fill("f1", "c1", Market.STOCKS, "AAA", Side.BUY, Decimal("0.2"), Decimal("50.075"), Decimal(0), TS)
    point = EquityPoint(D1, TS, Decimal("40"), Decimal("10.0"), Decimal("50.0"))
    fill_record = FillRecord(D1, fill, Decimal("50"), Decimal("0.01"), Decimal("0.005"))
    session = SessionRecord(
        session=D1,
        status="done",
        universe=("AAA",),
        reset_before=False,
        orders_planned=1,
        orders_sent=1,
        orders_rejected=0,
        rejections=(),
        targets=(("AAA", 0.3),),
        actual=(("AAA", 0.2),),
        open_equity=Decimal("50"),
    )
    halt = HaltEvent(D1, TS, (HaltKind.DAILY_LOSS,), ("daily loss 3.20%",), None, None, False)
    episode = Episode("AAA", D1, None, 1, 0.3, Decimal(10), Decimal(0), Decimal(0), Decimal("0.1"), True)
    job = _job()
    result = RunResult(
        job=job,
        start_ts=TS - timedelta(days=4),
        start_equity=Decimal(50),
        equity=(point,),
        sessions=(session,),
        fills=(fill_record,),
        halts=(halt,),
        episodes=(episode,),
        residual_eur=Decimal(0),
        frozen_equity=(point,),
        decisions_gz=b"\x1f\x8b",
        data_fingerprint="ab" * 32,
        risk_config_sha256="cd" * 32,
    )
    risk = make_risk_config()
    modes = ModeConfigs(replay=risk, research=risk, replay_sha256="0" * 64, research_sha256="1" * 64)
    costs = StockCostParams(
        half_spread_bps={"AAA": Decimal(10), "BBB": Decimal(12)},
        slippage_bps=Decimal(5),
        adverse_bps=Decimal(0),
        fx_fee_bps=Decimal(15),
        commission_eur=Decimal(0),
        currency={"AAA": "EUR", "BBB": "USD"},
    )
    return {
        ExecutionTiming: ExecutionTiming(exec_delay=timedelta(minutes=3)),
        Variant: Variant(0, _params(), params_sha256(_params())),
        RegistryPlan: job.plan,
        BuyAndHoldPlan: BuyAndHoldPlan((("AAA", 0.3), ("BBB", 0.3)), (("AAA", 50.0), ("BBB", 20.0))),
        RandomEntriesPlan: RandomEntriesPlan(412, (("AAA", ((D1, D2, 0.3),)),)),
        RunJob: job,
        ModeConfigs: modes,
        EngineContext: EngineContext(
            dataset=DatasetStandIn("synthetic"),  # type: ignore[arg-type]
            modes=modes,
            costs=costs,
            timing=ExecutionTiming(),
            quantity_step=Decimal("0.000001"),
            price_tick=Decimal("0.01"),
        ),
        EquityPoint: point,
        FillRecord: fill_record,
        SessionRecord: session,
        HaltEvent: halt,
        Episode: episode,
        HaltSummary: _halt_summary(),
        RunResult: result,
        Metrics: _metrics(),
        RunSummary: RunSummary(job, (D1,), (0.01,), _metrics(), _halt_summary()),
    }


def _module_dataclasses() -> set[type]:
    return {
        obj
        for _, obj in inspect.getmembers(bt, inspect.isclass)
        if dataclasses.is_dataclass(obj) and obj.__module__ == bt.__name__
    }


def test_every_contract_dataclass_is_pinned_and_sampled() -> None:
    assert _module_dataclasses() == set(EXPECTED_FIELDS)
    assert set(_samples()) == set(EXPECTED_FIELDS)


def test_field_names_and_order_match_the_spec() -> None:
    for cls, expected in EXPECTED_FIELDS.items():
        assert tuple(f.name for f in dataclasses.fields(cls)) == expected, cls.__name__


def test_every_contract_dataclass_is_frozen_and_slotted_as_specified() -> None:
    for cls in EXPECTED_FIELDS:
        assert cls.__dataclass_params__.frozen, cls.__name__  # type: ignore[attr-defined]
        assert ("__slots__" in cls.__dict__) is (cls not in NOT_SLOTTED), cls.__name__


def test_every_contract_dataclass_refuses_mutation() -> None:
    for cls, obj in _samples().items():
        name = dataclasses.fields(cls)[0].name
        with pytest.raises(dataclasses.FrozenInstanceError):
            setattr(obj, name, getattr(obj, name))


def test_every_contract_dataclass_pickles_to_an_equal_object() -> None:
    for cls, obj in _samples().items():
        for protocol in (pickle.DEFAULT_PROTOCOL, pickle.HIGHEST_PROTOCOL):
            back = roundtrip(obj, protocol=protocol)
            assert type(back) is cls
            assert back == obj, cls.__name__


def test_jobs_are_hashable_so_batches_can_be_keyed() -> None:
    job = _job()
    assert hash(job) == hash(roundtrip(job))
    assert {job: 1}[_job()] == 1


def test_the_type_checking_imports_create_no_import_cycle() -> None:
    code = (
        "import sys\n"
        "import samsulek.backtest.types\n"
        "bad = [m for m in ('samsulek.backtest.dataset', 'samsulek.costs.stocks') if m in sys.modules]\n"
        "print(','.join(bad) or 'clean')\n"
    )
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True, timeout=60)
    assert out.stdout.strip() == "clean"


def test_enum_values() -> None:
    assert [m.value for m in RiskMode] == ["L", "R"]
    assert [m.value for m in Period] == ["research", "holdout"]
    assert [m.value for m in Detail] == ["full", "returns", "metrics"]
    assert [m.value for m in HaltKind] == ["daily_loss", "drawdown", "equity_sanity", "cap_drift"]


def test_execution_timing_defaults() -> None:
    timing = ExecutionTiming()
    assert timing.exec_delay == timedelta(0)
    assert timing.reset_lead == timedelta(minutes=30)


def test_mode_configs_pick_the_config_for_the_mode() -> None:
    replay = make_risk_config()
    research = make_risk_config(account={"max_daily_loss_pct": "0.5"})
    modes = ModeConfigs(replay=replay, research=research, replay_sha256="a", research_sha256="b")
    assert modes.for_mode(RiskMode.L) is replay
    assert modes.for_mode(RiskMode.R) is research
    with pytest.raises(ValueError, match="is not a valid RiskMode"):
        modes.for_mode("X")  # type: ignore[arg-type]


# ----------------------------------------------------------------------------- errors


def test_a_refusal_lists_every_problem() -> None:
    exc = BacktestRefused(["first problem", "second problem"])
    assert exc.problems == ("first problem", "second problem")
    assert str(exc) == "first problem; second problem"
    assert isinstance(exc, ValueError)


def test_a_single_string_is_one_problem_and_an_empty_list_still_refuses() -> None:
    assert BacktestRefused("no verified ETF price source yet (task #15)").problems == (
        "no verified ETF price source yet (task #15)",
    )
    assert BacktestRefused([]).problems == ("refused without a stated reason (a bug)",)


class PlantedRefusal(BacktestRefused):
    pass


def test_refusals_pickle_with_their_problems_and_type() -> None:
    for exc in (BacktestRefused(["a", "b"]), PlantedRefusal("only one")):
        back = roundtrip(exc)
        assert type(back) is type(exc)
        assert back.problems == exc.problems
        assert str(back) == str(exc)


def test_integrity_errors_carry_and_pickle_their_fields() -> None:
    exc = BacktestIntegrityError("fill price differs from the oracle", session=D1, label="strategy_R_1x")
    assert isinstance(exc, RuntimeError)
    assert str(exc) == "strategy_R_1x at session 2024-04-02: fill price differs from the oracle"
    back = roundtrip(exc)
    assert type(back) is BacktestIntegrityError
    assert (back.reason, back.session, back.label) == (exc.reason, exc.session, exc.label)
    assert str(back) == str(exc)
    no_session = BacktestIntegrityError("unreadable", session=None, label="bh_L_2x")
    assert str(no_session) == "bh_L_2x: unreadable"
    assert roundtrip(no_session).session is None


# ----------------------------------------------------------------------------- params


def test_params_sha256_is_the_sha256_of_canonical_json() -> None:
    params = as_params({"lookback": 10, "gross": 0.9, "name": "x", "fast": True})
    canonical = b'{"fast":true,"gross":0.9,"lookback":10,"name":"x"}'
    assert params_sha256(params) == hashlib.sha256(canonical).hexdigest()
    assert params_sha256(()) == hashlib.sha256(b"{}").hexdigest()


def test_params_sha256_ignores_input_order_but_not_types() -> None:
    a = as_params({"lookback": 10, "gross": 0.9})
    b = as_params({"gross": 0.9, "lookback": 10})
    assert a == b and params_sha256(a) == params_sha256(b)
    assert params_sha256(as_params({"x": 10})) != params_sha256(as_params({"x": 10.0}))
    assert params_sha256(as_params({"x": 1})) != params_sha256(as_params({"x": True}))
    assert params_sha256(as_params({"x": "10"})) != params_sha256(as_params({"x": 10}))


def test_params_sha256_escapes_non_ascii_deterministically() -> None:
    params = as_params({"name": "caf" + chr(0xE9)})
    assert params_sha256(params) == hashlib.sha256(b'{"name":"caf\\u00e9"}').hexdigest()


def test_params_sha256_refuses_params_not_built_by_as_params() -> None:
    for bad in (
        (("lookback", 10), ("gross", 0.9)),  # unsorted
        (("gross", 0.9), ("gross", 0.5)),  # duplicate name
        (("gross", math.nan),),
    ):
        with pytest.raises(ValueError, match=r"sorted by name|finite"):
            params_sha256(bad)
    with pytest.raises(TypeError):
        params_sha256((("gross", Decimal("0.9")),))  # type: ignore[arg-type]


_values = st.one_of(
    st.integers(), st.floats(allow_nan=False, allow_infinity=False), st.text(max_size=5), st.booleans()
)


@given(st.dictionaries(st.text(min_size=1, max_size=8), _values, max_size=8))
def test_as_params_is_sorted_hashable_and_picklable(values: dict[str, ParamValue]) -> None:
    params = as_params(values)
    assert [name for name, _ in params] == sorted(values)
    assert dict(params) == values
    assert hash(params) == hash(roundtrip(params))
    assert as_params(dict(reversed(list(values.items())))) == params
    assert len(params_sha256(params)) == 64


def test_as_params_refuses_odd_names_and_values() -> None:
    with pytest.raises(ValueError, match="finite"):
        as_params({"gross": math.inf})
    with pytest.raises(ValueError, match="finite"):
        as_params({"gross": math.nan})
    with pytest.raises(ValueError, match="non-empty"):
        as_params({"": 1})
    for bad in (Decimal(1), None, [1], (1,)):
        with pytest.raises(TypeError):
            as_params({"x": bad})  # type: ignore[dict-item]


# ----------------------------------------------------------------------------- validation


def test_a_variant_must_carry_its_own_params_sha() -> None:
    params = _params()
    Variant(3, params, params_sha256(params))
    with pytest.raises(ValueError, match="does not match"):
        Variant(3, params, "0" * 64)
    with pytest.raises(ValueError, match=">= 0"):
        Variant(-1, params, params_sha256(params))


def test_a_registry_plan_needs_sorted_segments_and_a_small_lag() -> None:
    p = _params()
    RegistryPlan("demo_above_average", ((D1, p), (D2, p)), lag_sessions=5)
    with pytest.raises(ValueError, match="at least one segment"):
        RegistryPlan("demo_above_average", ())
    with pytest.raises(ValueError, match="sorted"):
        RegistryPlan("demo_above_average", ((D2, p), (D1, p)))
    with pytest.raises(ValueError, match="sorted"):
        RegistryPlan("demo_above_average", ((D1, p), (D1, p)))
    with pytest.raises(ValueError, match="lag_sessions"):
        RegistryPlan("demo_above_average", ((D1, p),), lag_sessions=6)
    with pytest.raises(ValueError, match="strategy name"):
        RegistryPlan("", ((D1, p),))


def test_run_job_labels_are_safe_file_name_parts() -> None:
    for good in ("strategy_R_1x", "random_R_2x_s0412", "variant_007", "bh_L_1x"):
        assert _job(label=good).label == good
    non_ascii = ("caf" + chr(0xE9), chr(0xFF41))  # e-acute; fullwidth "a"
    for bad in ("", "../x", "a b", "a-b", "a/b", "a\\b", "a.csv", "C:x", "x\n", *non_ascii):
        with pytest.raises(ValueError, match="label"):
            _job(label=bad)


def test_run_job_refuses_inconsistent_fields() -> None:
    cases: list[tuple[dict[str, Any], str]] = [
        ({"index": -1}, "index"),
        ({"universe": ()}, "universe"),
        ({"universe": ("BBB", "AAA")}, "universe"),
        ({"universe": ("AAA", "AAA")}, "universe"),
        ({"min_history": -1}, "min_history"),
        ({"first_session": D2, "last_session": D1}, "is after"),
        ({"cost_multiplier": 3}, "cost_multiplier"),
        ({"cost_multiplier": 0}, "cost_multiplier"),
        ({"cost_multiplier": True}, "cost_multiplier"),
        ({"starting_cash_eur": Decimal(0)}, "starting cash"),
        ({"starting_cash_eur": Decimal("NaN")}, "starting cash"),
        ({"starting_cash_eur": 50}, "starting cash"),
        ({"risk_mode": "R"}, "RiskMode"),
        ({"detail": "full"}, "Detail"),
    ]
    for over, match in cases:
        with pytest.raises(ValueError, match=match):
            _job(**over)
    assert _job(cost_multiplier=2, risk_mode=RiskMode.L, detail=Detail.METRICS).cost_multiplier == 2


def test_strategy_plan_is_the_union_of_the_three_plans() -> None:
    assert set(bt.StrategyPlan.__args__) == {RegistryPlan, BuyAndHoldPlan, RandomEntriesPlan}
