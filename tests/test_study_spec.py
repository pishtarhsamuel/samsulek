"""The study file (spec section 7.6): strict schema, E/S coupling, grid limits, the file hash, variants."""

from __future__ import annotations

import copy
import hashlib
import itertools
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
import yaml
from pydantic import ValidationError

from samsulek.backtest.fence import HoldoutFenceError
from samsulek.backtest.study import (
    AcceptedIssue,
    StoreDataSpec,
    StudySpec,
    SyntheticDataSpec,
    load_study,
    variants,
)
from samsulek.backtest.types import BacktestRefused, params_sha256

# The example of spec section 7.6, with a real hypothesis.
EXAMPLE = """\
version: 1
study: E001                 # ^[ES]\\d{3}$; E <=> data.source store; S <=> synthetic
family: etf_trend
title: Time-series momentum on 3 broad ETFs
hypothesis: >-
  Broad ETFs whose close is above their own moving average keep rising slightly
  more often than not, enough to beat random entries after costs.
written: 2026-11-01
market: stocks
strategy: demo_above_average
grid: {lookback: [10, 20, 40], gross: [0.9]}
lag_sessions: 0
universe: [EUNL, SXR8, XGLE]
data: {source: store, first: 2010-07-01, accepted_issues: []}
last_session: 2024-09-30
starting_cash_eur: 50
costs: {half_spread_bps: {default: 10}, slippage_bps: 5, adverse_bps: 0, fx_fee_bps: 15, commission_eur: 0}
timing: {exec_delay_minutes: 0, reset_lead_minutes: 30}
walk_forward: {min_train_years: 4, test_months: 12}
baselines: {random_seeds: 200}
holdout_acceptance: {min_sharpe: 0.0, must_beat_buy_and_hold: true, must_survive_2x: true}
"""

BASE: dict[str, Any] = yaml.safe_load(EXAMPLE)
SYNTHETIC: dict[str, Any] = {
    **copy.deepcopy(BASE),
    "study": "S001",
    "data": {"source": "synthetic", "seed": 7, "first": date(2016, 1, 4)},
    "universe": ["SYN_A", "SYN_B", "SYN_C"],
    "baselines": {"random_seeds": 20},
}


def changed(base: dict[str, Any], *edits: tuple[str, Any]) -> dict[str, Any]:
    """A deep copy of ``base`` with dotted keys set (value ``DROP`` deletes the key)."""
    out = copy.deepcopy(base)
    for dotted, value in edits:
        *parents, last = dotted.split(".")
        node = out
        for part in parents:
            node = node[part]
        if value is DROP:
            del node[last]
        else:
            node[last] = value
    return out


DROP = object()


def write(tmp_path: Path, data: dict[str, Any] | str | bytes, name: str = "study.yaml") -> Path:
    path = tmp_path / name
    if isinstance(data, bytes):
        path.write_bytes(data)
    elif isinstance(data, str):
        path.write_bytes(data.encode("utf-8"))
    else:
        path.write_bytes(yaml.safe_dump(data, sort_keys=False).encode("ascii"))
    return path


def problems(tmp_path: Path, data: dict[str, Any] | str | bytes) -> tuple[str, ...]:
    with pytest.raises(BacktestRefused) as info:
        load_study(write(tmp_path, data))
    assert all(p.isascii() for p in info.value.problems)
    return info.value.problems


def loads(tmp_path: Path, data: dict[str, Any] | str | bytes) -> StudySpec:
    return load_study(write(tmp_path, data))[0]


# ------------------------------------------------------------------------------ the example
def test_the_spec_example_loads_with_exact_types(tmp_path: Path) -> None:
    spec, sha = load_study(write(tmp_path, EXAMPLE))
    assert sha == hashlib.sha256(EXAMPLE.encode("ascii")).hexdigest()
    assert spec.study == "E001" and spec.family == "etf_trend" and spec.market == "stocks"
    assert spec.written == date(2026, 11, 1) and spec.last_session == date(2024, 9, 30)
    assert spec.universe == ("EUNL", "SXR8", "XGLE")
    assert spec.grid == {"lookback": (10, 20, 40), "gross": (0.9,)}
    assert [type(v) for v in spec.grid["lookback"]] == [int, int, int]
    assert isinstance(spec.data, StoreDataSpec) and spec.data.first == date(2010, 7, 1)
    assert spec.data.accepted_issues == ()
    assert spec.starting_cash_eur == Decimal(50) and isinstance(spec.starting_cash_eur, Decimal)
    assert spec.costs.half_spread_bps == {"default": Decimal(10)}
    assert spec.costs.slippage_bps == Decimal(5) and spec.costs.fx_fee_bps == Decimal(15)
    assert spec.costs.commission_eur == Decimal(0) and spec.costs.adverse_bps == Decimal(0)
    assert spec.timing.exec_delay_minutes == 0 and spec.timing.reset_lead_minutes == 30
    assert spec.walk_forward.min_train_years == 4 and spec.walk_forward.test_months == 12
    assert spec.baselines.random_seeds == 200
    assert spec.holdout_acceptance.min_sharpe == 0.0
    assert spec.holdout_acceptance.must_beat_buy_and_hold is True
    assert spec.holdout_acceptance.must_survive_2x is True
    assert spec.hypothesis.startswith("Broad ETFs") and "\n" not in spec.hypothesis


def test_a_synthetic_study_loads(tmp_path: Path) -> None:
    spec = loads(tmp_path, SYNTHETIC)
    assert isinstance(spec.data, SyntheticDataSpec) and spec.data.seed == 7
    assert spec.study.startswith("S")


def test_the_spec_is_frozen_and_holds_no_lists(tmp_path: Path) -> None:
    spec = loads(tmp_path, EXAMPLE)
    with pytest.raises(ValidationError):
        spec.study = "E002"  # type: ignore[misc]
    with pytest.raises(ValidationError):
        spec.costs.slippage_bps = Decimal(0)  # type: ignore[misc]

    def no_lists(value: object) -> None:
        assert not isinstance(value, list)
        if isinstance(value, dict):
            for v in value.values():
                no_lists(v)
        if isinstance(value, tuple):
            for v in value:
                no_lists(v)

    no_lists(spec.model_dump())


# ------------------------------------------------------------------------------ the file hash
def test_the_hash_ignores_cr_so_crlf_and_lf_copies_are_one_study(tmp_path: Path) -> None:
    lf_spec, lf_sha = load_study(write(tmp_path, EXAMPLE, "lf.yaml"))
    crlf = EXAMPLE.replace("\n", "\r\n").encode("ascii")
    crlf_spec, crlf_sha = load_study(write(tmp_path, crlf, "crlf.yaml"))
    assert crlf_sha == lf_sha == hashlib.sha256(crlf.replace(b"\r", b"")).hexdigest()
    assert crlf_spec == lf_spec


def test_the_hash_is_of_the_bytes_so_a_comment_edit_is_another_file(tmp_path: Path) -> None:
    spec_a, sha_a = load_study(write(tmp_path, EXAMPLE, "a.yaml"))
    spec_b, sha_b = load_study(write(tmp_path, EXAMPLE + "# a note added later\n", "b.yaml"))
    assert spec_a == spec_b and sha_a != sha_b


def test_a_lone_carriage_return_is_refused(tmp_path: Path) -> None:
    # YAML reads a lone CR as a line break, but the hash drops it: the same hash could then
    # stand for two different files, so it is refused.
    text = EXAMPLE.replace("lag_sessions: 0\n", "lag_sessions: 0\r")
    found = problems(tmp_path, text.encode("ascii"))
    assert any("carriage return" in p for p in found)


# ------------------------------------------------------------------------------ variants
def test_variants_are_the_product_over_sorted_names_with_values_in_file_order(tmp_path: Path) -> None:
    data = changed(BASE, ("grid", {"lookback": [40, 10], "gross": [0.9, 0.5]}))
    out = variants(loads(tmp_path, data))
    # sorted names: gross, lookback; the last name varies fastest; values keep file order
    assert [dict(v.params) for v in out] == [
        {"gross": 0.9, "lookback": 40},
        {"gross": 0.9, "lookback": 10},
        {"gross": 0.5, "lookback": 40},
        {"gross": 0.5, "lookback": 10},
    ]
    assert [v.index for v in out] == [0, 1, 2, 3]
    for v in out:
        assert v.params == tuple(sorted(v.params))
        assert v.params_sha256 == params_sha256(v.params)
    assert len({v.params_sha256 for v in out}) == 4


def test_variants_of_the_example(tmp_path: Path) -> None:
    out = variants(loads(tmp_path, EXAMPLE))
    assert [v.params for v in out] == [(("gross", 0.9), ("lookback", n)) for n in (10, 20, 40)]


def test_the_variant_order_does_not_depend_on_the_key_order_in_the_file(tmp_path: Path) -> None:
    a = changed(BASE, ("grid", {"lookback": [10, 20], "gross": [0.9, 0.5]}))
    b = changed(BASE, ("grid", {"gross": [0.9, 0.5], "lookback": [10, 20]}))
    assert variants(loads(tmp_path, a)) == variants(loads(tmp_path, b))


# ------------------------------------------------------------------------------ E/S coupling
@pytest.mark.parametrize(
    ("study", "data", "ok"),
    [
        ("E001", {"source": "store", "first": date(2010, 7, 1)}, True),
        ("E001", {"source": "synthetic", "seed": 7, "first": date(2010, 7, 1)}, False),
        ("S001", {"source": "synthetic", "seed": 7, "first": date(2010, 7, 1)}, True),
        ("S001", {"source": "store", "first": date(2010, 7, 1)}, False),
    ],
)
def test_e_studies_use_the_store_and_s_studies_synthetic_data(
    tmp_path: Path, study: str, data: dict[str, Any], ok: bool
) -> None:
    spec_data = changed(BASE, ("study", study), ("data", data), ("baselines.random_seeds", 200))
    if ok:
        assert loads(tmp_path, spec_data).study == study
    else:
        assert any("E-study must use data.source 'store'" in p for p in problems(tmp_path, spec_data))


@pytest.mark.parametrize(
    ("base", "seeds", "ok"),
    [
        (BASE, 199, False),
        (BASE, 200, True),
        (BASE, 5000, True),
        (BASE, 5001, False),
        (SYNTHETIC, 19, False),
        (SYNTHETIC, 20, True),
        (SYNTHETIC, 5000, True),
        (SYNTHETIC, 5001, False),
    ],
)
def test_random_seed_limits(tmp_path: Path, base: dict[str, Any], seeds: int, ok: bool) -> None:
    data = changed(base, ("baselines.random_seeds", seeds))
    if ok:
        assert loads(tmp_path, data).baselines.random_seeds == seeds
    else:
        assert any("random_seeds" in p for p in problems(tmp_path, data))


@pytest.mark.parametrize("study", ["E01", "E0001", "X001", "e001", "S 01", ""])
def test_study_ids(tmp_path: Path, study: str) -> None:
    assert any(
        p.startswith(f"study file {tmp_path}") and "study:" in p
        for p in problems(tmp_path, changed(BASE, ("study", study)))
    )


# ------------------------------------------------------------------------------ the grid
def _grid(n_params: int, n_values: int) -> dict[str, list[int]]:
    return {f"p{i:02d}": list(range(1, n_values + 1)) for i in range(n_params)}


@pytest.mark.parametrize(
    ("grid", "ok"),
    [
        (_grid(12, 1), True),
        (_grid(13, 1), False),
        ({"lookback": list(range(1, 21))}, True),
        ({"lookback": list(range(1, 22))}, False),
        ({"a": list(range(10)), "b": list(range(20))}, True),  # exactly 200 combinations
        ({"a": list(range(7)), "b": list(range(6)), "c": list(range(5))}, False),  # 210
        ({"a": list(range(1, 21)), "b": list(range(1, 12))}, False),  # 220
        ({}, False),
        ({"lookback": []}, False),
    ],
)
def test_grid_limits(tmp_path: Path, grid: dict[str, list[int]], ok: bool) -> None:
    data = changed(BASE, ("grid", grid))
    if ok:
        assert len(variants(loads(tmp_path, data))) == max(1, len(list(itertools.product(*grid.values()))))
    else:
        assert any(p.split(": ", 1)[1].startswith("grid") for p in problems(tmp_path, data))


@pytest.mark.parametrize(
    "values",
    [[10, 10], [1, 1.0], [1, True], [0, False], ["a", "b", "a"], [0.5, 0.25, 0.5]],
)
def test_equal_grid_values_are_refused_as_one_trial_counted_twice(tmp_path: Path, values: list[Any]) -> None:
    found = problems(tmp_path, changed(BASE, ("grid", {"lookback": values})))
    assert any("one trial, twice" in p for p in found)


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_grid_values_are_refused(tmp_path: Path, value: float) -> None:
    found = problems(tmp_path, changed(BASE, ("grid", {"gross": [0.5, value]})))
    assert any("not a finite number" in p for p in found)


@pytest.mark.parametrize("value", [[1, 2], {"a": 1}, None])
def test_grid_values_are_plain_scalars(tmp_path: Path, value: object) -> None:
    assert problems(tmp_path, changed(BASE, ("grid", {"lookback": [10, value]})))


@pytest.mark.parametrize("name", ["Lookback", "1x", "a-b", "x" * 41, "look back"])
def test_grid_parameter_names(tmp_path: Path, name: str) -> None:
    found = problems(tmp_path, changed(BASE, ("grid", {name: [1]})))
    assert any("parameter name" in p for p in found)


def test_grid_values_keep_their_yaml_types(tmp_path: Path) -> None:
    data = changed(BASE, ("grid", {"a": [1, 2.5], "b": ["x"], "c": [True, False]}))
    spec = loads(tmp_path, data)
    assert [type(v) for v in spec.grid["a"]] == [int, float]
    assert spec.grid["b"] == ("x",) and spec.grid["c"] == (True, False)


# ------------------------------------------------------------------------------ text fields
@pytest.mark.parametrize(("length", "ok"), [(39, False), (40, True), (2000, True), (2001, False)])
def test_hypothesis_length(tmp_path: Path, length: int, ok: bool) -> None:
    data = changed(BASE, ("hypothesis", "h" * length))
    if ok:
        assert len(loads(tmp_path, data).hypothesis) == length
    else:
        assert any("hypothesis" in p for p in problems(tmp_path, data))


def test_a_padded_short_hypothesis_is_refused(tmp_path: Path) -> None:
    assert any(
        "hypothesis" in p
        for p in problems(tmp_path, changed(BASE, ("hypothesis", " " * 30 + "too short" + " " * 10)))
    )


def test_a_multi_line_hypothesis_is_fine_but_a_title_is_one_line(tmp_path: Path) -> None:
    assert (
        "\n"
        in loads(
            tmp_path,
            changed(BASE, ("hypothesis", "line one of the hypothesis\nand line two of it, long enough")),
        ).hypothesis
    )
    assert any("title" in p for p in problems(tmp_path, changed(BASE, ("title", "two\nlines"))))


def test_non_ascii_bytes_are_refused_with_their_line(tmp_path: Path) -> None:
    text = EXAMPLE.replace("lag_sessions: 0", "lag_sessions: 0   # café")
    found = problems(tmp_path, text.encode("utf-8"))
    assert any("line 12 is not plain ASCII" in p for p in found)


def test_a_utf8_bom_is_refused(tmp_path: Path) -> None:
    assert any("not plain ASCII" in p for p in problems(tmp_path, b"\xef\xbb\xbf" + EXAMPLE.encode("ascii")))


@pytest.mark.parametrize(
    ("field", "escaped"),
    [
        ("title", '"Caf\\u00e9 momentum"'),
        ("family", '"etf_\\u00e9"'),
        ("hypothesis", '"' + "x" * 40 + '\\u20ac"'),
    ],
)
def test_non_ascii_text_from_yaml_escapes_is_refused(tmp_path: Path, field: str, escaped: str) -> None:
    lines = [f"{field}: {escaped}" if line.startswith(f"{field}:") else line for line in EXAMPLE.splitlines()]
    text = "\n".join(lines) + "\n"
    if field == "hypothesis":
        text = text.replace(
            "  Broad ETFs whose close is above their own moving average keep rising slightly\n"
            "  more often than not, enough to beat random entries after costs.\n",
            "",
        )
    found = problems(tmp_path, text)
    assert any("plain ASCII" in p for p in found)


def test_control_characters_are_refused(tmp_path: Path) -> None:
    text = EXAMPLE.replace(
        "title: Time-series momentum on 3 broad ETFs", 'title: "Time-series \\e[31m momentum"'
    )
    assert any("control characters" in p for p in problems(tmp_path, text))


def test_a_non_ascii_key_is_refused(tmp_path: Path) -> None:
    text = EXAMPLE + '"caf\\u00e9": 1\n'
    assert any("plain ASCII" in p for p in problems(tmp_path, text))


# ------------------------------------------------------------------------------ YAML traps
def test_a_duplicate_top_level_key_is_refused(tmp_path: Path) -> None:
    # Plain YAML would keep the second value silently.
    text = EXAMPLE + "lag_sessions: 3\n"
    assert any("found the key 'lag_sessions' twice" in p for p in problems(tmp_path, text))


def test_a_duplicate_nested_key_is_refused(tmp_path: Path) -> None:
    text = EXAMPLE.replace(
        "grid: {lookback: [10, 20, 40], gross: [0.9]}", "grid: {lookback: [10], gross: [0.9], lookback: [20]}"
    )
    assert any("twice" in p for p in problems(tmp_path, text))


def test_aliases_are_refused(tmp_path: Path) -> None:
    text = EXAMPLE.replace("universe: [EUNL, SXR8, XGLE]", "universe: &u [EUNL, SXR8, XGLE]") + "extra: *u\n"
    assert any("aliases" in p for p in problems(tmp_path, text))


def test_an_alias_bomb_is_refused_before_it_expands(tmp_path: Path) -> None:
    bomb = (
        'a: &a ["x","x","x","x","x","x","x","x","x"]\n'
        "b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\n"
        "c: [*b,*b,*b,*b,*b,*b,*b,*b,*b]\n"
    )
    assert any("aliases" in p for p in problems(tmp_path, bomb))


@pytest.mark.parametrize(
    ("written", "read_as"),
    [
        ("010", 8),  # YAML 1.1 octal
        ("0x14", 20),
        ("0b101", 5),
        ("1:20", 80),  # base 60
        ("1_0", 10),
        ("+010", 8),
    ],
)
def test_a_number_yaml_would_read_differently_is_refused(tmp_path: Path, written: str, read_as: int) -> None:
    assert yaml.safe_load(f"x: {written}")["x"] == read_as  # what plain YAML would have used
    text = EXAMPLE.replace("lookback: [10, 20, 40]", f"lookback: [10, {written}, 40]")
    found = problems(tmp_path, text)
    assert any(f"write the number '{written}' in plain decimal digits" in p for p in found), found


@pytest.mark.parametrize("written", ["1_0.5", "1:30.0", "190:20:30.15"])
def test_a_float_yaml_would_read_differently_is_refused(tmp_path: Path, written: str) -> None:
    assert isinstance(yaml.safe_load(f"x: {written}")["x"], float)
    text = EXAMPLE.replace("gross: [0.9]", f"gross: [0.9, {written}]")
    assert any("plain decimal digits" in p for p in problems(tmp_path, text))


@pytest.mark.parametrize("written", ["0", "-0", "+7", "12", "-3"])
def test_plain_decimal_numbers_load(tmp_path: Path, written: str) -> None:
    text = EXAMPLE.replace(
        "grid: {lookback: [10, 20, 40], gross: [0.9]}", f"grid: {{x: [{written}, 0.5, -1.25e+3]}}"
    )
    assert loads(tmp_path, text).grid == {"x": (int(written), 0.5, -1250.0)}


def test_a_grid_text_value_is_one_line(tmp_path: Path) -> None:
    found = problems(tmp_path, changed(BASE, ("grid", {"mode": ["fast", "two\nlines"]})))
    assert any("one line" in p for p in found)
    assert loads(tmp_path, changed(BASE, ("grid", {"mode": ["fast", "slow"]}))).grid == {
        "mode": ("fast", "slow")
    }


@pytest.mark.parametrize(
    "text", ["", "just a string\n", "- a\n- b\n", EXAMPLE + "---\n" + EXAMPLE, "a: [1, 2\n"]
)
def test_not_one_mapping_is_refused(tmp_path: Path, text: str) -> None:
    assert problems(tmp_path, text)


def test_a_missing_file_is_refused(tmp_path: Path) -> None:
    with pytest.raises(BacktestRefused) as info:
        load_study(tmp_path / "nope.yaml")
    assert "cannot be read" in info.value.problems[0]


def test_a_non_ascii_path_still_gives_an_ascii_message(tmp_path: Path) -> None:
    with pytest.raises(BacktestRefused) as info:
        load_study(tmp_path / "μελέτη.yaml")
    assert all(p.isascii() for p in info.value.problems)


def test_a_huge_file_is_refused(tmp_path: Path) -> None:
    text = EXAMPLE + "#" * (64 * 1024) + "\n"
    assert any("at most" in p for p in problems(tmp_path, text))


# ------------------------------------------------------------------------------ strictness
@pytest.mark.parametrize(
    "dotted",
    [
        "extra_setting",
        "costs.spread",
        "timing.delay",
        "data.seed",
        "walk_forward.kind",
        "holdout_acceptance.note",
    ],
)
def test_unknown_settings_are_refused(tmp_path: Path, dotted: str) -> None:
    found = problems(tmp_path, changed(BASE, (dotted, 1)))
    assert any(dotted.rsplit(".", maxsplit=1)[-1] in p and "unknown setting" in p for p in found)


@pytest.mark.parametrize(
    "dotted",
    [
        "version",
        "study",
        "family",
        "title",
        "hypothesis",
        "written",
        "market",
        "strategy",
        "grid",
        "lag_sessions",
        "universe",
        "data",
        "last_session",
        "starting_cash_eur",
        "costs",
        "timing",
        "walk_forward",
        "baselines",
        "holdout_acceptance",
        "costs.half_spread_bps",
        "costs.commission_eur",
        "data.first",
        "timing.reset_lead_minutes",
    ],
)
def test_every_setting_is_required(tmp_path: Path, dotted: str) -> None:
    found = problems(tmp_path, changed(BASE, (dotted, DROP)))
    assert any(dotted in p and "Field required" in p for p in found)


@pytest.mark.parametrize(
    ("dotted", "value"),
    [
        ("version", True),
        ("version", 2),
        ("version", 1.0),
        ("version", "1"),
        ("lag_sessions", True),
        ("lag_sessions", "0"),
        ("lag_sessions", 6),
        ("lag_sessions", -1),
        ("starting_cash_eur", 49),
        ("starting_cash_eur", 50.01),
        ("starting_cash_eur", "50"),
        ("starting_cash_eur", True),
        ("timing.exec_delay_minutes", 11),
        ("timing.exec_delay_minutes", -1),
        ("timing.reset_lead_minutes", 0),
        ("timing.reset_lead_minutes", 121),
        ("walk_forward.min_train_years", 1),
        ("walk_forward.min_train_years", 16),
        ("walk_forward.test_months", 2),
        ("walk_forward.test_months", 25),
        ("costs.slippage_bps", -1),
        ("costs.slippage_bps", "5"),
        ("costs.fx_fee_bps", float("nan")),
        ("costs.adverse_bps", float("inf")),
        ("costs.commission_eur", -0.5),
        ("costs.half_spread_bps", {"default": -1}),
        ("costs.half_spread_bps", {"default": "10"}),
        ("holdout_acceptance.min_sharpe", -0.1),
        ("holdout_acceptance.min_sharpe", float("nan")),
        ("holdout_acceptance.min_sharpe", 5.5),
        ("holdout_acceptance.must_survive_2x", 1),
        ("holdout_acceptance.must_beat_buy_and_hold", "yes"),
        ("market", "crypto"),
        ("family", "ab"),
        ("family", "Etf_trend"),
        ("strategy", "Demo"),
        ("written", "2026-11-01"),
        ("written", datetime(2026, 11, 1, 10, 0)),  # noqa: DTZ001 (a naive time is what YAML produces)
        ("data.first", 20100701),
        ("data.source", "csv"),
    ],
)
def test_wrong_values_are_refused(tmp_path: Path, dotted: str, value: object) -> None:
    found = problems(tmp_path, changed(BASE, (dotted, value)))
    assert any(dotted.split(".", maxsplit=1)[0] in p for p in found), found


def test_numbers_that_are_fine(tmp_path: Path) -> None:
    data = changed(
        BASE,
        ("starting_cash_eur", 50.0),
        ("costs.slippage_bps", 7.5),
        ("holdout_acceptance.min_sharpe", 1),
        ("costs.half_spread_bps", {"default": 12.5}),
    )
    spec = loads(tmp_path, data)
    assert spec.starting_cash_eur == Decimal(50)
    assert spec.costs.slippage_bps == Decimal("7.5")
    assert spec.costs.half_spread_bps == {"default": Decimal("12.5")}
    assert spec.holdout_acceptance.min_sharpe == 1.0 and isinstance(spec.holdout_acceptance.min_sharpe, float)


def test_data_must_start_before_the_last_session(tmp_path: Path) -> None:
    assert any(
        "data.first" in p for p in problems(tmp_path, changed(BASE, ("data.first", date(2024, 9, 30))))
    )
    assert loads(tmp_path, changed(BASE, ("data.first", date(2024, 9, 27)))).data.first == date(2024, 9, 27)


def test_every_problem_is_listed_not_just_the_first(tmp_path: Path) -> None:
    data = changed(
        BASE, ("lag_sessions", 9), ("family", "X"), ("timing.exec_delay_minutes", 99), ("bogus", 1)
    )
    found = problems(tmp_path, data)
    for name in ("lag_sessions", "family", "timing.exec_delay_minutes", "bogus"):
        assert any(f": {name}" in p for p in found), (name, found)


def test_memecoin_studies_are_refused_by_the_fence(tmp_path: Path) -> None:
    with pytest.raises(HoldoutFenceError):
        load_study(write(tmp_path, changed(BASE, ("market", "memecoin"))))


# ------------------------------------------------------------------------------ universe and costs
@pytest.mark.parametrize(
    ("universe", "ok"),
    [
        (["EUNL"], True),
        ([f"S{i:02d}" for i in range(10)], True),
        ([f"S{i:02d}" for i in range(11)], False),
        ([], False),
        (["EUNL", "EUNL"], False),
        (["eunl"], False),
        (["default"], False),
        (["EU NL"], False),
        (["EUNLd_EQ", "SYN_A", "X.DE"], True),
    ],
)
def test_universe(tmp_path: Path, universe: list[str], ok: bool) -> None:
    data = changed(BASE, ("universe", universe))
    if ok:
        assert loads(tmp_path, data).universe == tuple(universe)
    else:
        assert any("universe" in p for p in problems(tmp_path, data))


def test_a_half_spread_for_a_symbol_outside_the_universe_is_refused(tmp_path: Path) -> None:
    # A typo in a symbol override would otherwise be ignored and the default used instead.
    data = changed(BASE, ("costs.half_spread_bps", {"default": 10, "EUNI": 5}))
    assert any("['EUNI'] are not in the universe" in p for p in problems(tmp_path, data))


def test_half_spreads_without_a_default_must_cover_every_symbol(tmp_path: Path) -> None:
    missing = changed(BASE, ("costs.half_spread_bps", {"EUNL": 5, "SXR8": 6}))
    assert any("no 'default' and no entry for ['XGLE']" in p for p in problems(tmp_path, missing))
    full = changed(BASE, ("costs.half_spread_bps", {"EUNL": 5, "SXR8": 6, "XGLE": 7}))
    assert loads(tmp_path, full).costs.half_spread_bps == {"EUNL": 5, "SXR8": 6, "XGLE": 7}


def test_accepted_issues(tmp_path: Path) -> None:
    issue = {"symbol": "EUNL", "session": date(2015, 3, 2), "code": "large_move"}
    spec = loads(tmp_path, changed(BASE, ("data.accepted_issues", [issue])))
    assert spec.data.accepted_issues == (
        AcceptedIssue(symbol="EUNL", session=date(2015, 3, 2), code="large_move"),
    )
    stranger = changed(BASE, ("data.accepted_issues", [{**issue, "symbol": "ABCD"}]))
    assert any("not in the universe" in p for p in problems(tmp_path, stranger))
    again = {**issue, "session": date(2015, 3, 2)}  # a distinct object: safe_dump would alias the same one
    twice = changed(BASE, ("data.accepted_issues", [issue, again]))
    assert any("listed twice" in p for p in problems(tmp_path, twice))
    bad_code = changed(BASE, ("data.accepted_issues", [{**issue, "code": "Large Move"}]))
    assert any("code" in p for p in problems(tmp_path, bad_code))
    as_list = changed(BASE, ("data.accepted_issues", [["EUNL", date(2015, 3, 2), "large_move"]]))
    assert problems(tmp_path, as_list)


def test_building_a_spec_in_code_applies_the_same_rules() -> None:
    good = changed(BASE)
    assert StudySpec.model_validate(good).universe == ("EUNL", "SXR8", "XGLE")
    with pytest.raises(ValidationError):
        StudySpec.model_validate(changed(BASE, ("title", "café au lait")))
    with pytest.raises(ValidationError):
        StudySpec.model_validate(changed(BASE, ("study", "S001")))
