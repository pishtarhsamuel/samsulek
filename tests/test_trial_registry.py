"""The trial registry and the holdout log (spec section 8, trap 17 registry part, trap 16 log part).

Covers the exact line format (canonical JSON, LF, seq, prev chain, Z time stamps), flush +
fsync after every append, the write rules (study id bound to its file, attempts, trials
registered once per study/params/data, results and finishes only for open attempts), N
and the R/1x Sharpe ratios behind the deflated Sharpe, and the load-time verification:
edits, deletions and reorderings are refused with the spec's message, CRLF is tolerated.
"""

from __future__ import annotations

import hashlib
import json
import math
import tempfile
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from samsulek.backtest import registry
from samsulek.backtest.registry import (
    HoldoutLog,
    RegistryError,
    TrialRegistry,
    code_fingerprint,
    trial_id_for,
)
from samsulek.backtest.stats import SharpeStats, expected_max_sharpe
from samsulek.backtest.types import BacktestRefused, RiskMode, Variant, params_sha256
from samsulek.clock import FixedClock
from samsulek.strategies.params import as_params

T0 = datetime(2026, 11, 2, 8, 15, 2, tzinfo=UTC)
SPEC = "a" * 64
OTHER_SPEC = "b" * 64
FP = "f" * 64
STATS = SharpeStats(sr=0.0281, t=3400, skew=-0.61, kurt=7.9)
MESSAGE = "research/trials.jsonl was edited at line {n}; restore it with `git checkout research/trials.jsonl`"


def variants(*lookbacks: int) -> tuple[Variant, ...]:
    out = []
    for i, lb in enumerate(lookbacks):
        p = as_params({"gross": 0.9, "lookback": lb})
        out.append(Variant(index=i, params=p, params_sha256=params_sha256(p)))
    return tuple(out)


@pytest.fixture
def path(tmp_path: Path) -> Path:
    folder = tmp_path / "research"
    folder.mkdir()
    return folder / "trials.jsonl"


@pytest.fixture
def clock() -> FixedClock:
    return FixedClock(T0)


def result_fields(mode: str = "R", mult: int = 1) -> dict[str, object]:
    return {"risk_mode": mode, "cost_multiplier": mult, "sharpe_annual": 0.446, "first_session": "2011-04-12"}


def populated(path: Path, clock: FixedClock) -> tuple[TrialRegistry, tuple[str, ...]]:
    reg = TrialRegistry(path, clock=clock)
    attempt = reg.register_study(
        study_id="E001", spec_sha256=SPEC, fields={"family": "etf_trend", "n_variants": 3}
    )
    ids = reg.register_trials(
        study_id="E001",
        family="etf_trend",
        strategy="demo_above_average",
        variants=variants(10, 20, 40),
        data_fingerprint=FP,
    )
    for tid in ids:
        clock.advance(timedelta(seconds=1))
        reg.record_trial_result(tid, attempt=attempt, run_id="run1", stats=STATS, fields=result_fields())
    reg.record_study_finished(
        study_id="E001", attempt=attempt, run_id="run1", status="complete", fields={"verdict": "NO EDGE"}
    )
    return reg, ids


def lines(path: Path) -> list[str]:
    return path.read_bytes().decode("ascii").split("\n")[:-1]


def write_chain(path: Path, records: Sequence[Mapping[str, Any]]) -> None:
    """A correctly chained file of ``records`` (to plant SEMANTIC problems the chain cannot see)."""
    prev = "0" * 64
    out = []
    for n, r in enumerate(records, start=1):
        rec = {"at": "2026-11-02T08:15:02Z", **r, "seq": n, "prev": prev}
        text = json.dumps(rec, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        prev = hashlib.sha256(text.encode("ascii")).hexdigest()
        out.append(text)
    path.write_bytes(("\n".join(out) + "\n").encode("ascii"))


def refused_at(path: Path, n: int, *, opener: Callable[[Path], object] | None = None) -> RegistryError:
    with pytest.raises(RegistryError) as info:
        (opener or (lambda p: TrialRegistry(p, clock=FixedClock(T0))))(path)
    assert info.value.problems[0] == MESSAGE.format(n=n)
    return info.value


# =============================================================================== format
def test_line_format_is_canonical_and_chained(path: Path, clock: FixedClock) -> None:
    populated(path, clock)
    raw = path.read_bytes()
    assert b"\r" not in raw
    assert raw.endswith(b"\n")
    prev = "0" * 64
    for n, text in enumerate(lines(path), start=1):
        rec = json.loads(text)
        assert json.dumps(rec, sort_keys=True, separators=(",", ":"), ensure_ascii=True) == text
        assert rec["seq"] == n
        assert rec["prev"] == prev
        assert rec["at"].endswith("Z")
        prev = hashlib.sha256(text.encode("ascii")).hexdigest()
    first = json.loads(lines(path)[0])
    assert first == {
        "at": "2026-11-02T08:15:02Z",
        "kind": "study_registered",
        "seq": 1,
        "prev": "0" * 64,
        "study_id": "E001",
        "attempt": 1,
        "spec_sha256": SPEC,
        "family": "etf_trend",
        "n_variants": 3,
    }
    trial = json.loads(lines(path)[1])
    assert trial["kind"] == "trial_registered"
    assert trial["params"] == {"gross": 0.9, "lookback": 10}
    assert trial["params_sha256"] == params_sha256(as_params({"gross": 0.9, "lookback": 10}))
    result = json.loads(lines(path)[4])
    assert result["kind"] == "trial_result"
    assert (result["sr_per_period"], result["n_returns"], result["skew"], result["kurtosis"]) == (
        0.0281,
        3400,
        -0.61,
        7.9,
    )
    assert result["at"] == "2026-11-02T08:15:03Z"  # from the injected clock


def test_trial_id_format() -> None:
    (v,) = variants(10)
    digest = hashlib.sha256(f"{v.params_sha256}:{FP}".encode()).hexdigest()[:8]
    assert trial_id_for("E001", v, FP) == f"E001-v000-{digest}"
    assert trial_id_for("E001", v, "other") != trial_id_for("E001", v, FP)


def test_every_append_is_flushed_and_fsynced(
    path: Path, clock: FixedClock, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list[bytes] = []
    real_fsync = registry.os.fsync

    def spy(fd: int) -> None:
        seen.append(path.read_bytes())  # the line must already be in the file (flushed)
        real_fsync(fd)

    dirs: list[Path] = []
    monkeypatch.setattr(registry.os, "fsync", spy)
    monkeypatch.setattr(registry, "fsync_dir", dirs.append)
    populated(path, clock)
    assert len(seen) == len(lines(path)) == 8
    for n, snapshot in enumerate(seen, start=1):
        assert snapshot.count(b"\n") == n
    assert dirs == [path.parent]  # the folder entry is synced once, when the file is created


def test_a_missing_file_is_an_empty_registry(path: Path, clock: FixedClock) -> None:
    reg = TrialRegistry(path, clock=clock)
    assert reg.n_trials() == 0
    assert reg.summary().n_trials == 0
    assert reg.summary().completed_srs == ()
    assert reg.bound_spec_sha256("E001") is None
    assert reg.latest_complete("E001") is None
    assert not path.exists()  # reading creates nothing
    path.write_bytes(b"")
    assert TrialRegistry(path, clock=clock).n_trials() == 0


# =============================================================================== write rules
def test_study_ids_are_bound_to_their_first_file(path: Path, clock: FixedClock) -> None:
    reg = TrialRegistry(path, clock=clock)
    assert reg.register_study(study_id="E001", spec_sha256=SPEC, fields={}) == 1
    assert reg.register_study(study_id="E001", spec_sha256=SPEC, fields={}) == 2
    assert reg.bound_spec_sha256("E001") == SPEC
    size = path.stat().st_size
    with pytest.raises(RegistryError, match="A changed study is a new study: give it a new id"):
        reg.register_study(study_id="E001", spec_sha256=OTHER_SPEC, fields={})
    assert path.stat().st_size == size  # nothing written
    assert isinstance(RegistryError(["x"]), BacktestRefused)  # CLI exit 3


def test_the_append_check_refuses_a_line_that_a_load_would_refuse(path: Path, clock: FixedClock) -> None:
    # Second layer: every line is checked by the same rules the loader applies, before it is
    # written, so even a writer bug cannot put a refusable line in the file.
    reg = TrialRegistry(path, clock=clock)
    reg.register_study(study_id="E001", spec_sha256=SPEC, fields={})
    size = path.stat().st_size
    bad = {"study_id": "E001", "attempt": 2, "spec_sha256": OTHER_SPEC}
    with pytest.raises(
        RegistryError, match=r"refused to write a study_registered line.*bound to another study file"
    ):
        reg._log.append("study_registered", bad)
    with pytest.raises(RegistryError, match=r"refused to write a trial_result line.*unknown trial"):
        reg._log.append(
            "trial_result",
            {
                "trial_id": "x",
                "study_id": "E001",
                "attempt": 1,
                "run_id": "r",
                "risk_mode": "R",
                "cost_multiplier": 1,
                "n_returns": 2,
                "sr_per_period": 0.1,
                "skew": 0.0,
                "kurtosis": 3.0,
            },
        )
    assert path.stat().st_size == size


def test_trials_need_a_registered_study(path: Path, clock: FixedClock) -> None:
    reg = TrialRegistry(path, clock=clock)
    with pytest.raises(RegistryError, match="must be registered before its trials"):
        reg.register_trials(
            study_id="E009", family="f", strategy="s", variants=variants(10), data_fingerprint=FP
        )
    assert not path.exists()


def test_rerun_on_the_same_data_adds_no_trials_changed_data_does(path: Path, clock: FixedClock) -> None:
    reg, ids = populated(path, clock)
    assert reg.n_trials() == 3
    attempt = reg.register_study(study_id="E001", spec_sha256=SPEC, fields={})
    again = reg.register_trials(
        study_id="E001",
        family="etf_trend",
        strategy="demo_above_average",
        variants=variants(10, 20, 40),
        data_fingerprint=FP,
    )
    assert again == ids
    assert reg.n_trials() == 3
    new = reg.register_trials(
        study_id="E001",
        family="etf_trend",
        strategy="demo_above_average",
        variants=variants(10, 20, 40),
        data_fingerprint="g" * 64,
    )
    assert set(new).isdisjoint(ids)
    assert reg.n_trials() == 6
    assert attempt == 2
    reloaded = TrialRegistry(path, clock=clock)
    assert reloaded.n_trials() == 6
    assert reloaded.summary().per_family == {"etf_trend": 6}


def test_a_trial_id_registered_with_other_details_is_refused(path: Path, clock: FixedClock) -> None:
    reg, _ = populated(path, clock)
    reg.register_study(study_id="E001", spec_sha256=SPEC, fields={})
    with pytest.raises(RegistryError, match="other details"):
        reg.register_trials(
            study_id="E001",
            family="other_family",
            strategy="demo_above_average",
            variants=variants(10),
            data_fingerprint=FP,
        )


def test_register_trials_refuses_bad_variant_lists(path: Path, clock: FixedClock) -> None:
    reg = TrialRegistry(path, clock=clock)
    reg.register_study(study_id="E001", spec_sha256=SPEC, fields={})
    with pytest.raises(ValueError, match="at least one variant"):
        reg.register_trials(study_id="E001", family="f", strategy="s", variants=(), data_fingerprint=FP)
    v = variants(10)[0]
    with pytest.raises(ValueError, match="unique"):
        reg.register_trials(study_id="E001", family="f", strategy="s", variants=(v, v), data_fingerprint=FP)


def test_results_need_a_registered_trial_and_an_open_attempt(path: Path, clock: FixedClock) -> None:
    reg, ids = populated(path, clock)
    with pytest.raises(RegistryError, match="no registered trial"):
        reg.record_trial_result(
            "E001-v999-00000000", attempt=1, run_id="r", stats=STATS, fields=result_fields()
        )
    with pytest.raises(RegistryError, match="already finished"):
        reg.record_trial_result(ids[0], attempt=1, run_id="r", stats=STATS, fields=result_fields())
    with pytest.raises(RegistryError, match="no attempt 2"):
        reg.record_trial_result(ids[0], attempt=2, run_id="r", stats=STATS, fields=result_fields())
    with pytest.raises(ValueError, match="risk_mode"):
        reg.record_trial_result(ids[0], attempt=1, run_id="r", stats=STATS, fields={"cost_multiplier": 1})


@pytest.mark.parametrize(
    ("fields", "message"),
    [
        ({"risk_mode": "R"}, "state its cost_multiplier"),
        ({"risk_mode": "X", "cost_multiplier": 1}, "risk_mode must be one of"),
        ({"risk_mode": "R", "cost_multiplier": 3}, "cost_multiplier must be one of"),
        ({"risk_mode": "R", "cost_multiplier": True}, "cost_multiplier must be one of"),
        ({"risk_mode": "R", "cost_multiplier": "1"}, "cost_multiplier must be one of"),
    ],
)
def test_a_result_states_a_valid_mode_and_multiplier(
    path: Path, clock: FixedClock, fields: dict[str, object], message: str
) -> None:
    # V for the deflated Sharpe filters on these two fields: a misspelt one must not
    # silently drop the result from V.
    reg, ids = populated(path, clock)
    reg.register_study(study_id="E001", spec_sha256=SPEC, fields={})
    size = path.stat().st_size
    with pytest.raises(ValueError, match=message):
        reg.record_trial_result(ids[0], attempt=2, run_id="r", stats=STATS, fields=fields)
    assert path.stat().st_size == size
    reg.record_trial_result(
        ids[0], attempt=2, run_id="r", stats=STATS, fields={"risk_mode": RiskMode.L, "cost_multiplier": 2}
    )
    assert json.loads(lines(path)[-1])["risk_mode"] == "L"


def test_trials_are_registered_only_while_an_attempt_is_open(path: Path, clock: FixedClock) -> None:
    reg, _ = populated(path, clock)  # attempt 1 has finished
    size = path.stat().st_size
    with pytest.raises(RegistryError, match="no open attempt"):
        reg.register_trials(
            study_id="E001",
            family="etf_trend",
            strategy="demo_above_average",
            variants=variants(10, 20, 40),
            data_fingerprint="g" * 64,
        )
    assert path.stat().st_size == size
    assert reg.n_trials() == 3


def test_only_the_latest_attempt_takes_results_and_a_finish(path: Path, clock: FixedClock) -> None:
    # Attempt 1 crashed (no finish line); attempt 2 is registered. Attempt 1 is closed now:
    # a late result or finish for it would make "the latest R/1x result" an older attempt's.
    reg = TrialRegistry(path, clock=clock)
    reg.register_study(study_id="E001", spec_sha256=SPEC, fields={})
    (tid,) = reg.register_trials(
        study_id="E001", family="f", strategy="s", variants=variants(10), data_fingerprint=FP
    )
    assert reg.register_study(study_id="E001", spec_sha256=SPEC, fields={}) == 2
    size = path.stat().st_size
    with pytest.raises(RegistryError, match="attempt 1 of study E001 is closed: attempt 2 is the open one"):
        reg.record_trial_result(tid, attempt=1, run_id="r", stats=STATS, fields=result_fields())
    with pytest.raises(RegistryError, match="is closed"):
        reg.record_study_finished(study_id="E001", attempt=1, run_id="r", status="complete", fields={})
    assert path.stat().st_size == size
    reg.record_trial_result(tid, attempt=2, run_id="r", stats=STATS, fields=result_fields())
    reg.record_study_finished(study_id="E001", attempt=2, run_id="r", status="complete", fields={})
    assert TrialRegistry(path, clock=clock).summary().completed_srs == (STATS.sr,)


def test_a_line_for_a_closed_attempt_is_refused_on_load(path: Path) -> None:
    v = variants(10)[0]
    late = {
        "kind": "trial_result",
        "trial_id": trial_id_for("E001", v, FP),
        "study_id": "E001",
        "attempt": 1,
        "run_id": "r",
        "risk_mode": "R",
        "cost_multiplier": 1,
        "n_returns": 3,
        "sr_per_period": 0.1,
        "skew": 0.0,
        "kurtosis": 3.0,
    }
    write_chain(path, [STUDY, trial_record(v), {**STUDY, "attempt": 2}, late])
    err = refused_at(path, 4)
    assert "is closed" in err.problems[1]
    finish = {"kind": "study_finished", "study_id": "E001", "attempt": 1, "run_id": "r", "status": "complete"}
    write_chain(path, [STUDY, {**STUDY, "attempt": 2}, finish])
    assert "is closed" in refused_at(path, 3).problems[1]


def test_a_refused_registration_writes_none_of_its_trials(path: Path, clock: FixedClock) -> None:
    reg = TrialRegistry(path, clock=clock)
    reg.register_study(study_id="E001", spec_sha256=SPEC, fields={})
    reg.register_trials(
        study_id="E001", family="etf_trend", strategy="s", variants=variants(10, 20), data_fingerprint=FP
    )
    size, n = path.stat().st_size, reg.n_trials()
    p30, p20 = as_params({"gross": 0.9, "lookback": 30}), as_params({"gross": 0.9, "lookback": 20})
    fresh = Variant(index=0, params=p30, params_sha256=params_sha256(p30))  # a new trial id...
    clash = Variant(index=1, params=p20, params_sha256=params_sha256(p20))  # ...then a known one
    with pytest.raises(RegistryError, match="already registered with other details"):
        reg.register_trials(
            study_id="E001", family="other_family", strategy="s", variants=(fresh, clash), data_fingerprint=FP
        )
    assert path.stat().st_size == size  # the fresh variant was not written either
    assert reg.n_trials() == n == TrialRegistry(path, clock=clock).n_trials()


def test_a_study_needs_an_id_and_a_real_sha256(path: Path, clock: FixedClock) -> None:
    reg = TrialRegistry(path, clock=clock)
    with pytest.raises(ValueError, match="needs an id"):
        reg.register_study(study_id="", spec_sha256=SPEC, fields={})
    with pytest.raises(RegistryError, match="spec_sha256 is not a sha256"):
        reg.register_study(study_id="E001", spec_sha256="A" * 64, fields={})  # upper case: not hexdigest()
    assert not path.exists()


def test_latest_complete_hands_out_a_copy(path: Path, clock: FixedClock) -> None:
    reg = TrialRegistry(path, clock=clock)
    reg.register_study(study_id="E001", spec_sha256=SPEC, fields={})
    reg.record_study_finished(
        study_id="E001", attempt=1, run_id="r", status="complete", fields={"facts": {"1": "FAIL"}}
    )
    got = reg.latest_complete("E001")
    assert got is not None
    facts = got["facts"]
    assert isinstance(facts, dict)
    facts["1"] = "PASS"
    again = reg.latest_complete("E001")
    assert again is not None
    assert again["facts"] == {"1": "FAIL"}


def test_a_study_attempt_finishes_once(path: Path, clock: FixedClock) -> None:
    reg, _ = populated(path, clock)
    with pytest.raises(RegistryError, match="already finished"):
        reg.record_study_finished(study_id="E001", attempt=1, run_id="run1", status="aborted", fields={})
    reg.register_study(study_id="E001", spec_sha256=SPEC, fields={})
    with pytest.raises(ValueError, match="complete or aborted"):
        reg.record_study_finished(study_id="E001", attempt=2, run_id="r", status="done", fields={})  # type: ignore[arg-type]
    with pytest.raises(RegistryError, match="unknown study"):
        reg.record_study_finished(study_id="E404", attempt=1, run_id="r", status="aborted", fields={})


@pytest.mark.parametrize(
    "key", ["seq", "prev", "at", "kind", "trial_id", "study_id", "attempt", "sr_per_period"]
)
def test_callers_cannot_override_the_registry_keys(path: Path, clock: FixedClock, key: str) -> None:
    reg, ids = populated(path, clock)
    reg.register_study(study_id="E001", spec_sha256=SPEC, fields={})
    size = path.stat().st_size
    with pytest.raises(ValueError, match="set by the registry itself"):
        reg.record_trial_result(
            ids[0], attempt=2, run_id="r", stats=STATS, fields={**result_fields(), key: 1}
        )
    assert path.stat().st_size == size


@pytest.mark.parametrize(
    ("value", "error"),
    [(math.nan, ValueError), (math.inf, ValueError), (object(), TypeError), ({1: 2}, TypeError)],
)
def test_values_that_would_not_round_trip_are_refused(
    path: Path, clock: FixedClock, value: object, error: type[Exception]
) -> None:
    reg = TrialRegistry(path, clock=clock)
    with pytest.raises(error):
        reg.register_study(study_id="E001", spec_sha256=SPEC, fields={"x": value})
    assert not path.exists()


def test_typed_values_are_stored_as_plain_json(path: Path, clock: FixedClock) -> None:
    from datetime import date
    from decimal import Decimal

    reg = TrialRegistry(path, clock=clock)
    reg.register_study(
        study_id="E001",
        spec_sha256=SPEC,
        fields={
            "mode": RiskMode.R,
            "day": date(2024, 9, 30),
            "cash": Decimal("50.00"),
            "seeds": (1, 2),
            "nested": {"a": [1.5]},
        },
    )
    rec = json.loads(lines(path)[0])
    assert (rec["mode"], rec["day"], rec["cash"], rec["seeds"], rec["nested"]) == (
        "R",
        "2024-09-30",
        "50.00",
        [1, 2],
        {"a": [1.5]},
    )


# =============================================================================== reading
def test_summary_uses_the_latest_r_1x_result_per_trial(path: Path, clock: FixedClock) -> None:
    reg = TrialRegistry(path, clock=clock)
    reg.register_study(study_id="E001", spec_sha256=SPEC, fields={})
    a, b, c = reg.register_trials(
        study_id="E001", family="fam_a", strategy="s", variants=variants(10, 20, 40), data_fingerprint=FP
    )
    reg.register_study(study_id="E002", spec_sha256=OTHER_SPEC, fields={})
    (d,) = reg.register_trials(
        study_id="E002", family="fam_b", strategy="s", variants=variants(5), data_fingerprint=FP
    )

    def put(tid: str, sr: float, mode: str = "R", mult: int = 1, attempt: int = 1) -> None:
        reg.record_trial_result(
            tid,
            attempt=attempt,
            run_id="r",
            stats=SharpeStats(sr=sr, t=10, skew=0.0, kurt=3.0),
            fields=result_fields(mode, mult),
        )

    put(a, 0.1)
    put(a, 0.9, mode="L")  # not R: ignored
    put(b, 0.2, mult=2)  # 2x: ignored
    put(d, 0.4)
    reg.register_study(study_id="E001", spec_sha256=SPEC, fields={})
    put(a, 0.15, attempt=2)  # the latest R/1x result of trial a
    s = reg.summary()
    assert s.n_trials == 4
    assert s.completed_srs == (0.15, 0.4)  # registration order; b and c have no R/1x result
    assert s.per_family == {"fam_a": 3, "fam_b": 1}
    assert TrialRegistry(path, clock=clock).summary() == s
    assert c not in {a, b, d}


def test_latest_complete_rests_on_the_latest_attempt(path: Path, clock: FixedClock) -> None:
    reg, _ = populated(path, clock)
    done = reg.latest_complete("E001")
    assert done is not None
    assert (done["status"], done["attempt"], done["verdict"]) == ("complete", 1, "NO EDGE")
    assert reg.latest_complete("E404") is None
    reg.register_study(study_id="E001", spec_sha256=SPEC, fields={})
    assert reg.latest_complete("E001") is None  # attempt 2 has not finished
    reg.record_study_finished(
        study_id="E001", attempt=2, run_id="run2", status="aborted", fields={"reason": "boom"}
    )
    assert reg.latest_complete("E001") is None  # the latest attempt aborted
    assert TrialRegistry(path, clock=clock).latest_complete("E001") is None


def test_an_aborted_study_still_counts_its_trials(path: Path, clock: FixedClock) -> None:
    reg = TrialRegistry(path, clock=clock)
    attempt = reg.register_study(study_id="E002", spec_sha256=SPEC, fields={})
    ids = reg.register_trials(
        study_id="E002", family="f", strategy="s", variants=variants(1, 2, 3, 4), data_fingerprint=FP
    )
    # ... Phase A crashes before any result ...
    reg.record_study_finished(
        study_id="E002",
        attempt=attempt,
        run_id="r",
        status="aborted",
        fields={"reason": "BacktestIntegrityError: x"},
    )
    reloaded = TrialRegistry(path, clock=clock)
    assert reloaded.n_trials() == len(ids) == 4
    assert reloaded.summary().completed_srs == ()


def test_sr0_rises_as_trials_are_registered(path: Path, clock: FixedClock) -> None:
    reg = TrialRegistry(path, clock=clock)
    reg.register_study(study_id="E001", spec_sha256=SPEC, fields={})
    sr0 = []
    for k in range(1, 6):
        reg.register_trials(
            study_id="E001",
            family="f",
            strategy="s",
            variants=variants(*range(10, 10 + 4 * k)),
            data_fingerprint=FP,
        )
        sr0.append(expected_max_sharpe(0.001, reg.n_trials()))
    assert sr0 == sorted(sr0)
    assert len(set(sr0)) == 5


# =============================================================================== verification on load
def test_a_correct_file_reloads_to_the_same_state(path: Path, clock: FixedClock) -> None:
    reg, _ = populated(path, clock)
    again = TrialRegistry(path, clock=clock)
    assert again.summary() == reg.summary()
    assert again.latest_complete("E001") == reg.latest_complete("E001")
    assert again.bound_spec_sha256("E001") == SPEC


def test_editing_a_value_is_refused(path: Path, clock: FixedClock) -> None:
    populated(path, clock)
    text = lines(path)
    text[4] = text[4].replace('"sr_per_period":0.0281', '"sr_per_period":0.0381')  # canonical, but edited
    path.write_bytes(("\n".join(text) + "\n").encode("ascii"))
    err = refused_at(path, 5)  # line 6's prev no longer matches line 5
    assert "no longer chains" in err.problems[1]
    assert "was edited at line 5" in str(err)


def test_deleting_a_line_is_refused(path: Path, clock: FixedClock) -> None:
    populated(path, clock)
    text = lines(path)
    del text[2]
    path.write_bytes(("\n".join(text) + "\n").encode("ascii"))
    err = refused_at(path, 3)
    assert "seq is 4, expected 3" in err.problems[1]


def test_reordering_lines_is_refused(path: Path, clock: FixedClock) -> None:
    populated(path, clock)
    text = lines(path)
    text[3], text[4] = text[4], text[3]
    path.write_bytes(("\n".join(text) + "\n").encode("ascii"))
    refused_at(path, 4)


def test_a_non_canonical_edit_of_the_last_line_is_refused(path: Path, clock: FixedClock) -> None:
    populated(path, clock)
    text = lines(path)
    text[-1] = text[-1].replace(":", ": ", 1)
    path.write_bytes(("\n".join(text) + "\n").encode("ascii"))
    err = refused_at(path, len(text))
    assert "not written the way the registry writes" in err.problems[1]


def test_a_cut_off_last_line_is_refused(path: Path, clock: FixedClock) -> None:
    populated(path, clock)
    raw = path.read_bytes()
    path.write_bytes(raw[:-10])
    refused_at(path, 8)


@pytest.mark.parametrize(
    "garbage",
    [b"\xef\xbb\xbf", b"not json", b"[1, 2]", b"\xc3\xa9"],
    ids=["bom", "text", "array", "non-ascii"],
)
def test_lines_that_are_not_registry_json_are_refused(path: Path, clock: FixedClock, garbage: bytes) -> None:
    populated(path, clock)
    raw = path.read_bytes().split(b"\n")
    raw[1] = garbage + raw[1] if garbage == b"\xef\xbb\xbf" else garbage
    path.write_bytes(b"\n".join(raw))
    refused_at(path, 2)


def test_crlf_line_endings_are_tolerated(path: Path, clock: FixedClock) -> None:
    reg, _ = populated(path, clock)
    path.write_bytes(path.read_bytes().replace(b"\n", b"\r\n"))  # e.g. git autocrlf on Windows
    crlf = TrialRegistry(path, clock=clock)
    assert crlf.summary() == reg.summary()
    crlf.register_study(study_id="E002", spec_sha256=SPEC, fields={})  # appends with LF
    assert TrialRegistry(path, clock=clock).bound_spec_sha256("E002") == SPEC


@pytest.mark.parametrize(
    ("records", "line", "detail"),
    [
        ([{"kind": "made_up"}], 1, "unknown kind"),
        ([{"kind": "study_registered", "study_id": "E001", "attempt": 1}], 1, "spec_sha256"),
        (
            [
                {"kind": "study_registered", "study_id": "E001", "attempt": 1, "spec_sha256": SPEC},
                {"kind": "study_registered", "study_id": "E001", "attempt": 2, "spec_sha256": OTHER_SPEC},
            ],
            2,
            "bound to another study file",
        ),
        (
            [{"kind": "study_registered", "study_id": "E001", "attempt": 2, "spec_sha256": SPEC}],
            1,
            "expected 1",
        ),
        (
            [{"kind": "study_registered", "study_id": "E001", "attempt": 1, "spec_sha256": SPEC, "at": 5}],
            1,
            "no time stamp",
        ),
        (
            [
                {
                    "kind": "trial_result",
                    "trial_id": "E001-v000-12345678",
                    "study_id": "E001",
                    "attempt": 1,
                    "run_id": "r",
                    "risk_mode": "R",
                    "cost_multiplier": 1,
                    "n_returns": 3,
                    "sr_per_period": 0.1,
                    "skew": 0.0,
                    "kurtosis": 3.0,
                }
            ],
            1,
            "unknown trial",
        ),
        (
            [
                {
                    "kind": "study_finished",
                    "study_id": "E001",
                    "attempt": 1,
                    "run_id": "r",
                    "status": "complete",
                }
            ],
            1,
            "unknown study",
        ),
    ],
)
def test_semantic_problems_in_a_well_chained_file_are_refused(
    path: Path, records: list[dict[str, Any]], line: int, detail: str
) -> None:
    write_chain(path, records)
    err = refused_at(path, line)
    assert detail in err.problems[1]


def trial_record(v: Variant, **over: object) -> dict[str, Any]:
    rec: dict[str, Any] = {
        "kind": "trial_registered",
        "trial_id": trial_id_for("E001", v, FP),
        "study_id": "E001",
        "family": "f",
        "strategy": "s",
        "index": v.index,
        "params": dict(v.params),
        "params_sha256": v.params_sha256,
        "data_fingerprint": FP,
    }
    rec.update(over)
    return rec


STUDY = {"kind": "study_registered", "study_id": "E001", "attempt": 1, "spec_sha256": SPEC}


@pytest.mark.parametrize(
    ("second", "detail"),
    [
        (trial_record(variants(10)[0]), "registered twice"),
        (
            trial_record(variants(10, 20)[1], params={"gross": 0.9, "lookback": 30}),
            "does not match its params",
        ),
        (trial_record(variants(10, 20)[1], data_fingerprint="e" * 64), "does not match its study"),
        (trial_record(variants(10, 20)[1], index=True), "not a int"),
    ],
)
def test_bad_trial_lines_are_refused(path: Path, second: dict[str, Any], detail: str) -> None:
    write_chain(path, [STUDY, trial_record(variants(10)[0]), second])
    err = refused_at(path, 3)
    assert detail in err.problems[1]


def test_a_chained_file_with_good_semantics_loads(path: Path) -> None:
    write_chain(path, [STUDY, trial_record(variants(10)[0])])
    assert TrialRegistry(path, clock=FixedClock(T0)).n_trials() == 1


def test_a_result_line_with_an_unknown_mode_is_refused(path: Path) -> None:
    v = variants(10)[0]
    result = {
        "kind": "trial_result",
        "trial_id": trial_id_for("E001", v, FP),
        "study_id": "E001",
        "attempt": 1,
        "run_id": "r",
        "risk_mode": "R1x",
        "cost_multiplier": 1,
        "n_returns": 3,
        "sr_per_period": 0.1,
        "skew": 0.0,
        "kurtosis": 3.0,
    }
    write_chain(path, [STUDY, trial_record(v), result])
    err = refused_at(path, 3)
    assert "must be L or R and 1 or 2" in err.problems[1]
    write_chain(path, [STUDY, trial_record(v), {**result, "risk_mode": "R"}])
    assert TrialRegistry(path, clock=FixedClock(T0)).summary().completed_srs == (0.1,)


def test_a_trial_line_after_its_attempt_finished_is_refused(path: Path) -> None:
    finished = {
        "kind": "study_finished",
        "study_id": "E001",
        "attempt": 1,
        "run_id": "r",
        "status": "aborted",
    }
    write_chain(path, [STUDY, finished, trial_record(variants(10)[0])])
    err = refused_at(path, 3)
    assert "no attempt is open" in err.problems[1]


@settings(max_examples=60, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(st.data())
def test_any_edit_before_the_last_line_is_refused(tmp_path: Path, data: st.DataObject) -> None:
    folder = Path(tempfile.mkdtemp(dir=tmp_path)) / "research"  # fresh per example
    folder.mkdir()
    p = folder / "trials.jsonl"
    populated(p, FixedClock(T0))
    text = lines(p)
    i = data.draw(st.integers(0, len(text) - 2))  # the last line has no successor to commit to it
    how = data.draw(st.sampled_from(["delete", "swap", "duplicate", "digit", "space"]))
    if how == "delete":
        del text[i]
    elif how == "swap":
        text[i], text[i + 1] = text[i + 1], text[i]
    elif how == "duplicate":
        text.insert(i, text[i])
    elif how == "digit":
        positions = [k for k, ch in enumerate(text[i]) if ch.isdigit()]
        k = data.draw(st.sampled_from(positions))
        text[i] = text[i][:k] + str((int(text[i][k]) + 1) % 10) + text[i][k + 1 :]
    else:
        text[i] = text[i] + " "
    p.write_bytes(("\n".join(text) + "\n").encode("ascii"))
    with pytest.raises(RegistryError, match="was edited at line"):
        TrialRegistry(p, clock=FixedClock(T0))


def test_another_writer_is_detected_before_appending(path: Path, clock: FixedClock) -> None:
    reg, _ = populated(path, clock)
    other = TrialRegistry(path, clock=clock)
    other.register_study(study_id="E002", spec_sha256=SPEC, fields={})
    size = path.stat().st_size
    with pytest.raises(RegistryError, match="another process wrote to it"):
        reg.register_study(study_id="E003", spec_sha256=SPEC, fields={})
    assert path.stat().st_size == size
    assert TrialRegistry(path, clock=clock).bound_spec_sha256("E002") == SPEC


def test_files_outside_research_get_a_generic_restore_hint(tmp_path: Path, clock: FixedClock) -> None:
    p = tmp_path / "synthetic_trials.jsonl"
    populated(p, clock)
    text = lines(p)
    del text[1]
    p.write_bytes(("\n".join(text) + "\n").encode("ascii"))
    with pytest.raises(RegistryError) as info:
        TrialRegistry(p, clock=clock)
    assert info.value.problems[0] == f"{p.as_posix()} was edited at line 2; restore it from git or a backup"


# =============================================================================== holdout log
@pytest.fixture
def hpath(tmp_path: Path) -> Path:
    folder = tmp_path / "research"
    folder.mkdir()
    return folder / "holdout_runs.jsonl"


def claim(
    log: HoldoutLog, family: str = "etf_trend", strategy: str = "demo_above_average", study: str = "E001"
) -> None:
    log.claim(
        family=family,
        strategy=strategy,
        study_id=study,
        spec_sha256=SPEC,
        final_params=as_params({"lookback": 20}),
        run_id=f"run-{study}",
    )


def test_a_holdout_claim_is_written_with_its_details(hpath: Path, clock: FixedClock) -> None:
    log = HoldoutLog(hpath, clock=clock)
    assert log.claim_for(family="etf_trend", strategy="demo_above_average") is None
    claim(log)
    rec = json.loads(hpath.read_text(encoding="ascii").splitlines()[0])
    assert rec == {
        "at": "2026-11-02T08:15:02Z",
        "kind": "holdout_claimed",
        "seq": 1,
        "prev": "0" * 64,
        "family": "etf_trend",
        "strategy": "demo_above_average",
        "study_id": "E001",
        "spec_sha256": SPEC,
        "final_params": {"lookback": 20},
        "run_id": "run-E001",
        "confirmed": "tty",
    }
    log.record_result(study_id="E001", run_id="run-E001", fields={"accepted": False, "sharpe_R_1x": -0.2})
    again = HoldoutLog(hpath, clock=clock)
    found = again.claim_for(family="other", strategy="demo_above_average")
    assert found is not None
    assert found["study_id"] == "E001"


@pytest.mark.parametrize(
    ("family", "strategy"), [("etf_trend", "new_strategy"), ("new_family", "demo_above_average")]
)
def test_one_holdout_per_family_and_per_strategy(
    hpath: Path, clock: FixedClock, family: str, strategy: str
) -> None:
    log = HoldoutLog(hpath, clock=clock)
    claim(log)
    size = hpath.stat().st_size
    with pytest.raises(RegistryError, match="can be used once per family and once per strategy"):
        claim(log, family, strategy, "E002")
    assert hpath.stat().st_size == size
    claim(log, "new_family", "new_strategy", "E003")  # neither used: allowed


def test_claim_for_hands_out_a_copy(hpath: Path, clock: FixedClock) -> None:
    log = HoldoutLog(hpath, clock=clock)
    claim(log)
    found = log.claim_for(family="etf_trend", strategy="x")
    assert found is not None
    params = found["final_params"]
    assert isinstance(params, dict)
    params["lookback"] = 999
    again = log.claim_for(family="etf_trend", strategy="x")
    assert again is not None
    assert again["final_params"] == {"lookback": 20}


def test_holdout_results_need_their_claim(hpath: Path, clock: FixedClock) -> None:
    log = HoldoutLog(hpath, clock=clock)
    with pytest.raises(RegistryError, match="no holdout claim"):
        log.record_result(study_id="E001", run_id="run-E001", fields={})
    claim(log)
    log.record_result(study_id="E001", run_id="run-E001", fields={})
    with pytest.raises(RegistryError, match="already recorded"):
        log.record_result(study_id="E001", run_id="run-E001", fields={})


CLAIM = {
    "kind": "holdout_claimed",
    "family": "etf_trend",
    "strategy": "demo_above_average",
    "study_id": "E001",
    "spec_sha256": SPEC,
    "final_params": {"lookback": 20},
    "run_id": "run-E001",
    "confirmed": "tty",
}


@pytest.mark.parametrize(
    ("records", "line", "detail"),
    [
        (
            [CLAIM, {**CLAIM, "family": "other", "study_id": "E002", "run_id": "r2"}],
            2,
            "a second holdout claim",
        ),
        ([{**CLAIM, "confirmed": "stdin"}], 1, "confirmed at a terminal"),
        ([{"kind": "holdout_result", "study_id": "E001", "run_id": "run-E001"}], 1, "without a claim"),
        ([CLAIM, {"kind": "trial_result"}], 2, "unknown kind"),
    ],
)
def test_holdout_log_verification(hpath: Path, records: list[dict[str, Any]], line: int, detail: str) -> None:
    write_chain(hpath, records)
    with pytest.raises(RegistryError) as info:
        HoldoutLog(hpath, clock=FixedClock(T0))
    assert info.value.problems[0] == (
        f"research/holdout_runs.jsonl was edited at line {line}; "
        "restore it with `git checkout research/holdout_runs.jsonl`"
    )
    assert detail in info.value.problems[1]


# =============================================================================== code fingerprint
def test_code_fingerprint(tmp_path: Path) -> None:
    pkg = tmp_path / "pkg"
    (pkg / "sub").mkdir(parents=True)
    (pkg / "a.py").write_bytes(b"x = 1\n")
    (pkg / "sub" / "b.py").write_bytes(b"y = 2\n")
    (pkg / "notes.txt").write_bytes(b"ignored")
    fp = code_fingerprint(pkg)
    assert len(fp) == 64
    (pkg / "a.py").write_bytes(b"x = 1\r\n")  # CRLF checkout on Windows: same code
    assert code_fingerprint(pkg) == fp
    (pkg / "notes.txt").write_bytes(b"changed")
    assert code_fingerprint(pkg) == fp
    (pkg / "a.py").write_bytes(b"x = 2\n")
    assert code_fingerprint(pkg) != fp
    (pkg / "a.py").write_bytes(b"x = 1\n")
    (pkg / "sub" / "b.py").rename(pkg / "sub" / "c.py")
    assert code_fingerprint(pkg) != fp  # paths count, not just contents


def test_code_fingerprint_refuses_an_empty_or_missing_folder(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="no Python files"):
        code_fingerprint(tmp_path)
    with pytest.raises(ValueError, match="not a folder"):
        code_fingerprint(tmp_path / "missing")


def test_code_fingerprint_of_the_package_is_stable() -> None:
    pkg = Path(registry.__file__).resolve().parents[1]
    assert code_fingerprint(pkg) == code_fingerprint(pkg)
