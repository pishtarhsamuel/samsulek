"""The trial registry and the holdout log: append-only, hash-chained JSONL (M3 spec section 8).

Every grid variant is registered as a trial BEFORE any run (trial key: study id, params
sha, data fingerprint), so N for the deflated Sharpe counts every idea tried, failures
and aborted studies included. This module and report.py are the only backtest modules
that write files (rule A12).

File format (research/trials.jsonl, research/holdout_runs.jsonl, and the gitignored
synthetic registry): one JSON object per line, written as
``json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=True)`` and an LF.
``"seq"`` counts from 1 without gaps; ``"prev"`` is the sha256 of the previous line's
bytes (line ending stripped), 64 zeros on the first line; ``"at"`` comes from the
injected clock, UTC, ISO with ``Z``. Each append is followed by flush and fsync (and a
folder fsync when the file is created). Only the parent process holding the backtest
lock writes, and each append first checks that the file still has the size this object
left it at (someone else wrote to it: refuse).

On load the whole chain is verified; any of these refuses with ``RegistryError`` and
"<file> was edited at line N; restore it with `git checkout <file>`": a line that is not
canonical ASCII JSON (so whitespace, key order and duplicate keys count as edits), a seq
gap, a chain break (blamed on the line before: the one whose bytes changed), an unknown
kind, a missing or ill-typed field, a duplicate trial id, a trial id that does not match
its own fields, a result or finish for an unknown trial or attempt, a study id rebound to
a different study file, a second holdout claim for a family or a strategy, and a cut-off
last line. CRLF line endings are tolerated (the hash ignores them).

Limit, stated plainly: a hash chain proves the ORDER and CONTENT of every line except the
last one, which no later line commits to. A canonical edit or a deletion of only the final
line(s) is not detectable from the file alone; git history and the experiments.md count
check are the backstop.

Rules enforced on write (each a ``RegistryError``, nothing written) and again on load: a
study id is bound to its first spec sha256 forever; attempts count 1, 2, ...; only a
study's latest attempt, until it finishes, is open; trials are registered only while an
attempt of their study is open, and re-registering the same (study, params, data) is a
no-op, so a rerun on unchanged data adds no trials while changed data adds new ones; a
refused registration writes none of its trials; results and the finish line need a
registered trial and the open attempt; a result states its risk mode (L/R) and cost
multiplier (1/2).
N is the number of distinct registered trial ids; the deflated Sharpe's V uses each
trial's latest R/1x result. The holdout log allows one claim per family AND per strategy,
appended before the holdout simulation runs. Mappings handed out are deep copies.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from decimal import Decimal
from enum import Enum
from pathlib import Path
from typing import Any, Final, Literal

from samsulek.backtest.stats import SharpeStats
from samsulek.backtest.types import BacktestRefused, Variant, params_sha256
from samsulek.clock import Clock
from samsulek.fsutil import fsync_dir
from samsulek.strategies.params import Params, as_params
from samsulek.types import require_aware

_GENESIS: Final = "0" * 64
_SHA256: Final = re.compile(r"[0-9a-f]{64}")
_STRUCTURAL: Final = frozenset({"at", "kind", "seq", "prev"})
_TRIAL_KINDS: Final = ("study_registered", "trial_registered", "trial_result", "study_finished")
_HOLDOUT_KINDS: Final = ("holdout_claimed", "holdout_result")
_STATUSES: Final = ("complete", "aborted")
# ASCII: Python's \d also matches other scripts' digits ("**3**" written in Arabic-Indic digits).
_COUNT_LINE: Final = re.compile(r"^Total trials so far: \*\*(\d+)\*\*$", re.MULTILINE | re.ASCII)


class RegistryError(BacktestRefused):
    """The registry or the holdout log refuses (edited file, rebound study id, second holdout...)."""


# =============================================================================== the chained file
def _shown(path: Path) -> str:
    """How the owner names the file: research/<name> for the committed logs."""
    return f"research/{path.name}" if path.parent.name == "research" else path.as_posix()


def _edited(path: Path, line: int, detail: str) -> RegistryError:
    shown = _shown(path)
    if path.parent.name == "research":
        head = f"{shown} was edited at line {line}; restore it with `git checkout {shown}`"
    else:
        head = f"{shown} was edited at line {line}; restore it from git or a backup"
    return RegistryError([head, f"line {line}: {detail}"])


def _canonical(record: Mapping[str, Any]) -> str:
    return json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("ascii")).hexdigest()


def _stamp(now: datetime) -> str:
    require_aware(now, "registry clock time")
    return now.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _plain(value: object, where: str) -> Any:
    """``value`` as plain JSON data; refuses anything that would not round-trip exactly."""
    if isinstance(value, Enum):
        return _plain(value.value, where)
    if value is None or isinstance(value, bool | str):
        return value
    if isinstance(value, int):
        return int(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError(f"{where}: {value!r} cannot be stored in the registry (not finite)")
        return float(value)
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ValueError(f"{where}: {value!r} cannot be stored in the registry (not finite)")
        return str(value)
    if isinstance(value, datetime):
        return _stamp(value)
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Mapping):
        out: dict[str, Any] = {}
        for k, v in value.items():
            if not isinstance(k, str):
                raise TypeError(f"{where}: registry keys must be strings, got {k!r}")
            out[k] = _plain(v, f"{where}.{k}")
        return out
    if isinstance(value, list | tuple):
        return [_plain(v, f"{where}[]") for v in value]
    raise TypeError(f"{where}: a {type(value).__name__} cannot be stored in the registry")


def _body(fields: Mapping[str, object], fixed: Mapping[str, object]) -> dict[str, Any]:
    """The caller's extra fields plus the method's own; the fixed keys cannot be overridden."""
    taken = sorted(set(fields) & (set(fixed) | _STRUCTURAL))
    if taken:
        raise ValueError(f"these registry keys are set by the registry itself: {', '.join(taken)}")
    body: dict[str, Any] = _plain({**fields, **fixed}, "record")
    return body


def _read_chain(path: Path, kinds: Sequence[str]) -> tuple[list[dict[str, Any]], str, int]:
    """(records, sha256 of the last line, file size). A missing file is an empty log."""
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return [], _GENESIS, 0
    if not raw:
        return [], _GENESIS, 0
    if not raw.endswith(b"\n"):
        raise _edited(path, raw.count(b"\n") + 1, "the last line has no line ending (cut off or edited)")
    records: list[dict[str, Any]] = []
    prev = _GENESIS
    for n, line in enumerate(raw[:-1].split(b"\n"), start=1):
        body = line.removesuffix(b"\r")
        try:
            text = body.decode("ascii")
            record = json.loads(text)
        except (UnicodeDecodeError, ValueError):
            raise _edited(path, n, "not a line of ASCII JSON") from None
        if not isinstance(record, dict):
            raise _edited(path, n, "not a JSON object")
        try:
            canonical = _canonical(record)
        except ValueError:
            raise _edited(path, n, "holds a value JSON cannot write back (NaN or infinity)") from None
        if canonical != text:
            raise _edited(path, n, "not written the way the registry writes (spacing, key order or repeats)")
        seq = record.get("seq")
        if type(seq) is not int or seq != n:
            raise _edited(path, n, f"seq is {seq!r}, expected {n} (a line was removed, added or moved)")
        if record.get("prev") != prev:
            blame = max(1, n - 1)
            raise _edited(path, blame, f"line {n} no longer chains to line {n - 1} (its bytes changed)")
        if record.get("kind") not in kinds:
            raise _edited(path, n, f"unknown kind {record.get('kind')!r}")
        if not isinstance(record.get("at"), str):
            raise _edited(path, n, "no time stamp")
        prev = _sha(text)
        records.append(record)
    return records, prev, len(raw)


def _write_line(path: Path, record: Mapping[str, Any], *, expected_size: int) -> tuple[str, int]:
    """Append one canonical line (flush + fsync). Returns (its sha256, the new file size)."""
    text = _canonical(record)
    data = text.encode("ascii") + b"\n"
    created = not path.exists()
    size = 0 if created else path.stat().st_size
    if size != expected_size:
        raise RegistryError(
            [
                f"{_shown(path)} changed on disk while it was open ({size} bytes, expected {expected_size}): "
                "another process wrote to it; nothing was written"
            ]
        )
    with path.open("ab") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())
    if created:
        fsync_dir(path.parent)
    return _sha(text), expected_size + len(data)


class _ChainedLog:
    """Load, verify and append for one chained file. The owner supplies the semantic check."""

    def __init__(
        self,
        path: Path,
        *,
        clock: Clock,
        kinds: Sequence[str],
        problem: Callable[[Mapping[str, Any]], str | None],
        apply: Callable[[Mapping[str, Any]], None],
    ) -> None:
        self.path = path
        self.clock = clock
        self.problem = problem
        self.apply = apply
        records, self.last_sha, self.size = _read_chain(path, kinds)
        for n, record in enumerate(records, start=1):
            detail = problem(record)
            if detail is not None:
                raise _edited(path, n, detail)
            apply(record)
        self.count = len(records)

    def append(self, kind: str, body: Mapping[str, Any]) -> dict[str, Any]:
        record = {
            **body,
            "kind": kind,
            "seq": self.count + 1,
            "prev": self.last_sha,
            "at": _stamp(self.clock.now()),
        }
        detail = self.problem(record)
        if detail is not None:  # a writer bug: never put a line in the file that a load would refuse
            raise RegistryError([f"refused to write a {kind} line to {_shown(self.path)}: {detail}"])
        self.last_sha, self.size = _write_line(self.path, record, expected_size=self.size)
        self.count += 1
        self.apply(record)
        return record


def _missing(record: Mapping[str, Any], types: Mapping[str, type | tuple[type, ...]]) -> str | None:
    for key, kind in types.items():
        value = record.get(key)
        if not isinstance(value, kind) or (isinstance(value, bool) and kind is int):
            return f"field {key!r} is missing or not a {getattr(kind, '__name__', 'value')}"
    return None


# =============================================================================== trials
@dataclass(frozen=True, slots=True)
class TrialSummary:
    n_trials: int
    completed_srs: tuple[float, ...]
    per_family: Mapping[str, int]


@dataclass(slots=True)
class _Study:
    spec_sha256: str
    attempts: int = 0
    finished: dict[int, dict[str, Any]] = field(default_factory=dict)


_STUDY_FIELDS: Final = {"study_id": str, "attempt": int, "spec_sha256": str}
_TRIAL_FIELDS: Final = {
    "trial_id": str,
    "study_id": str,
    "family": str,
    "strategy": str,
    "index": int,
    "params": dict,
    "params_sha256": str,
    "data_fingerprint": str,
}
_RESULT_FIELDS: Final = {
    "trial_id": str,
    "study_id": str,
    "attempt": int,
    "run_id": str,
    "risk_mode": str,
    "cost_multiplier": int,
    "n_returns": int,
    "sr_per_period": float,
    "skew": float,
    "kurtosis": float,
}
_RISK_MODES: Final = ("L", "R")  # RiskMode values, as stored
_MULTIPLIERS: Final = (1, 2)
_FINISH_FIELDS: Final = {"study_id": str, "attempt": int, "run_id": str, "status": str}


def trial_id_for(study_id: str, variant: Variant, data_fingerprint: str) -> str:
    """``f"{study_id}-v{index:03d}-{sha256(f'{params_sha256}:{data_fingerprint}')[:8]}"``."""
    digest = hashlib.sha256(f"{variant.params_sha256}:{data_fingerprint}".encode()).hexdigest()
    return f"{study_id}-v{variant.index:03d}-{digest[:8]}"


class TrialRegistry:
    def __init__(self, path: Path, *, clock: Clock) -> None:
        """Loads and verifies the chain; a missing file is an empty registry."""
        self._studies: dict[str, _Study] = {}
        self._trials: dict[str, dict[str, Any]] = {}  # registration order
        self._latest_r1x: dict[str, float] = {}  # trial id -> sr_per_period of its latest R/1x result
        self._log = _ChainedLog(
            path, clock=clock, kinds=_TRIAL_KINDS, problem=self._problem, apply=self._apply
        )

    # ------------------------------------------------------------------ verification
    def _problem(self, r: Mapping[str, Any]) -> str | None:
        kind = r.get("kind")
        if kind == "study_registered":
            return _missing(r, _STUDY_FIELDS) or self._study_problem(r)
        if kind == "trial_registered":
            return _missing(r, _TRIAL_FIELDS) or self._trial_problem(r)
        if kind == "trial_result":
            missing = _missing(r, _RESULT_FIELDS)
            if missing:
                return missing
            trial = self._trials.get(r["trial_id"])
            if trial is None:
                return f"a result for the unknown trial {r['trial_id']!r}"
            if trial["study_id"] != r["study_id"]:
                return (
                    f"trial {r['trial_id']!r} belongs to study {trial['study_id']!r}, not {r['study_id']!r}"
                )
            if r["risk_mode"] not in _RISK_MODES or r["cost_multiplier"] not in _MULTIPLIERS:
                return (
                    f"risk_mode {r['risk_mode']!r} and cost_multiplier {r['cost_multiplier']!r} must be "
                    "L or R and 1 or 2"
                )
            return self._attempt_problem(r["study_id"], r["attempt"])
        if kind == "study_finished":
            missing = _missing(r, _FINISH_FIELDS)
            if missing:
                return missing
            if r["status"] not in _STATUSES:
                return f"unknown status {r['status']!r}"
            return self._attempt_problem(r["study_id"], r["attempt"])
        return f"unknown kind {kind!r}"

    def _study_problem(self, r: Mapping[str, Any]) -> str | None:
        if not _SHA256.fullmatch(r["spec_sha256"]):
            return "spec_sha256 is not a sha256"
        study = self._studies.get(r["study_id"])
        if study is not None and study.spec_sha256 != r["spec_sha256"]:
            return f"study {r['study_id']} is bound to another study file ({study.spec_sha256[:12]}...)"
        expected = 1 if study is None else study.attempts + 1
        if r["attempt"] != expected:
            return f"attempt {r['attempt']} of study {r['study_id']}, expected {expected}"
        return None

    def _trial_problem(self, r: Mapping[str, Any]) -> str | None:
        study = self._studies.get(r["study_id"])
        if study is None:
            return f"trial for the unregistered study {r['study_id']!r}"
        if study.attempts in study.finished:
            return (
                f"trial for study {r['study_id']} while no attempt is open "
                f"(attempt {study.attempts} has finished; register the study again first)"
            )
        if r["trial_id"] in self._trials:
            return f"trial {r['trial_id']!r} is registered twice"
        try:
            params = as_params(r["params"])
            variant = Variant(index=r["index"], params=params, params_sha256=params_sha256(params))
        except (TypeError, ValueError) as exc:
            return f"bad trial parameters ({exc})"
        if variant.params_sha256 != r["params_sha256"]:
            return f"params_sha256 of trial {r['trial_id']!r} does not match its params"
        if trial_id_for(r["study_id"], variant, r["data_fingerprint"]) != r["trial_id"]:
            return f"trial id {r['trial_id']!r} does not match its study, index, params and data"
        return None

    def _attempt_problem(self, study_id: str, attempt: int) -> str | None:
        """Why a result or a finish cannot go to ``attempt``: only the study's LATEST attempt,
        while it has not finished, is open (the same rule as for registering trials). An
        older attempt that never finished (a crash) stays closed: nothing can be added to it
        once a newer attempt exists, so "the latest result" is always the newest attempt's."""
        study = self._studies.get(study_id)
        if study is None:
            return f"unknown study {study_id!r}"
        if not 1 <= attempt <= study.attempts:
            return f"study {study_id} has no attempt {attempt}"
        if attempt in study.finished:
            return f"attempt {attempt} of study {study_id} has already finished"
        if attempt != study.attempts:
            return (
                f"attempt {attempt} of study {study_id} is closed: attempt {study.attempts} is the open one"
            )
        return None

    def _apply(self, r: Mapping[str, Any]) -> None:
        kind = r["kind"]
        if kind == "study_registered":
            study = self._studies.setdefault(r["study_id"], _Study(spec_sha256=r["spec_sha256"]))
            study.attempts = r["attempt"]
        elif kind == "trial_registered":
            self._trials[r["trial_id"]] = dict(r)
        elif kind == "trial_result":
            if r.get("risk_mode") == "R" and r.get("cost_multiplier") == 1:
                self._latest_r1x[r["trial_id"]] = float(r["sr_per_period"])
        elif kind == "study_finished":
            self._studies[r["study_id"]].finished[r["attempt"]] = dict(r)

    # ------------------------------------------------------------------ reading
    def n_trials(self) -> int:
        return len(self._trials)

    def summary(self) -> TrialSummary:
        per_family: dict[str, int] = {}
        for trial in self._trials.values():
            per_family[trial["family"]] = per_family.get(trial["family"], 0) + 1
        return TrialSummary(
            n_trials=len(self._trials),
            completed_srs=tuple(self._latest_r1x[t] for t in self._trials if t in self._latest_r1x),
            per_family=dict(sorted(per_family.items())),
        )

    def bound_spec_sha256(self, study_id: str) -> str | None:
        study = self._studies.get(study_id)
        return None if study is None else study.spec_sha256

    def latest_complete(self, study_id: str) -> Mapping[str, object] | None:
        """The finish line of the study's LATEST attempt, if that attempt finished complete.

        An attempt that aborted, or never finished, after a complete one hides it: a holdout
        must rest on the latest attempt (possibly on newer data), not on an older success.
        """
        study = self._studies.get(study_id)
        if study is None or study.attempts == 0:
            return None
        finish = study.finished.get(study.attempts)
        if finish is None or finish["status"] != "complete":
            return None
        return copy.deepcopy(finish)  # never the registry's own (nested) containers

    # ------------------------------------------------------------------ writing
    def register_study(self, *, study_id: str, spec_sha256: str, fields: Mapping[str, object]) -> int:
        """Returns the attempt number."""
        if not study_id:
            raise ValueError("a study needs an id")
        study = self._studies.get(study_id)
        if study is not None and study.spec_sha256 != spec_sha256:
            raise RegistryError(
                [
                    f"study {study_id} is bound to another study file (sha256 {study.spec_sha256}); "
                    f"this file has {spec_sha256}. A changed study is a new study: give it a new id"
                ]
            )
        attempt = 1 if study is None else study.attempts + 1
        body = _body(fields, {"study_id": study_id, "attempt": attempt, "spec_sha256": spec_sha256})
        self._log.append("study_registered", body)
        return attempt

    def register_trials(
        self,
        *,
        study_id: str,
        family: str,
        strategy: str,
        variants: Sequence[Variant],
        data_fingerprint: str,
    ) -> tuple[str, ...]:
        """The trial ids; idempotent for the same study, params and data."""
        study = self._studies.get(study_id)
        if study is None:
            raise RegistryError([f"study {study_id} must be registered before its trials"])
        if study.attempts in study.finished:
            raise RegistryError(
                [
                    f"study {study_id} has no open attempt (attempt {study.attempts} has finished): "
                    "register it again"
                ]
            )
        if not variants:
            raise ValueError("a study needs at least one variant")
        if len({v.index for v in variants}) != len(variants):
            raise ValueError("variant indices must be unique")
        if not data_fingerprint:
            raise ValueError("trials need the data fingerprint")
        ids = [trial_id_for(study_id, v, data_fingerprint) for v in variants]
        # Check every variant before writing any line: a refusal leaves the file untouched.
        conflicts = [
            tid
            for tid, v in zip(ids, variants, strict=True)
            if (known := self._trials.get(tid)) is not None
            and (known["family"], known["strategy"], known["params_sha256"])
            != (family, strategy, v.params_sha256)
        ]
        if conflicts:
            raise RegistryError(
                [f"trial {tid} is already registered with other details" for tid in conflicts]
            )
        for tid, v in zip(ids, variants, strict=True):
            if tid in self._trials:
                continue
            body = _body(
                {},
                {
                    "trial_id": tid,
                    "study_id": study_id,
                    "family": family,
                    "strategy": strategy,
                    "index": v.index,
                    "params": dict(v.params),
                    "params_sha256": v.params_sha256,
                    "data_fingerprint": data_fingerprint,
                },
            )
            self._log.append("trial_registered", body)
        return tuple(ids)

    def record_trial_result(
        self, trial_id: str, *, attempt: int, run_id: str, stats: SharpeStats, fields: Mapping[str, object]
    ) -> None:
        """``fields`` must name the run's ``risk_mode`` (L or R) and ``cost_multiplier`` (1 or 2):
        the variance V behind the deflated Sharpe uses the R/1x results only."""
        trial = self._trials.get(trial_id)
        if trial is None:
            raise RegistryError([f"no registered trial {trial_id}: register trials before running them"])
        for key, allowed in (("risk_mode", _RISK_MODES), ("cost_multiplier", _MULTIPLIERS)):
            if key not in fields:
                raise ValueError(f"a trial result must state its {key}")
            value = _plain(fields[key], key)
            if isinstance(value, bool) or value not in allowed:
                raise ValueError(f"a trial result's {key} must be one of {allowed}, got {fields[key]!r}")
        problem = self._attempt_problem(trial["study_id"], attempt)
        if problem is not None:
            raise RegistryError([problem])
        body = _body(
            fields,
            {
                "trial_id": trial_id,
                "study_id": trial["study_id"],
                "attempt": attempt,
                "run_id": run_id,
                "n_returns": stats.t,
                "sr_per_period": float(stats.sr),
                "skew": float(stats.skew),
                "kurtosis": float(stats.kurt),
            },
        )
        self._log.append("trial_result", body)

    def record_study_finished(
        self,
        *,
        study_id: str,
        attempt: int,
        run_id: str,
        status: Literal["complete", "aborted"],
        fields: Mapping[str, object],
    ) -> None:
        if status not in _STATUSES:
            raise ValueError(f"status must be complete or aborted, got {status!r}")
        problem = self._attempt_problem(study_id, attempt)
        if problem is not None:
            raise RegistryError([problem])
        body = _body(fields, {"study_id": study_id, "attempt": attempt, "run_id": run_id, "status": status})
        self._log.append("study_finished", body)


# =============================================================================== holdouts
_CLAIM_FIELDS: Final = {
    "family": str,
    "strategy": str,
    "study_id": str,
    "spec_sha256": str,
    "final_params": dict,
    "run_id": str,
    "confirmed": str,
}
_HOLDOUT_RESULT_FIELDS: Final = {"study_id": str, "run_id": str}


class HoldoutLog:
    def __init__(self, path: Path, *, clock: Clock) -> None:
        self._claims: list[dict[str, Any]] = []
        self._results: set[str] = set()  # run ids with a recorded result
        self._log = _ChainedLog(
            path, clock=clock, kinds=_HOLDOUT_KINDS, problem=self._problem, apply=self._apply
        )

    def _problem(self, r: Mapping[str, Any]) -> str | None:
        kind = r.get("kind")
        if kind == "holdout_claimed":
            missing = _missing(r, _CLAIM_FIELDS)
            if missing:
                return missing
            if r["confirmed"] != "tty":
                return "a holdout claim must be confirmed at a terminal"
            earlier = self._find(family=r["family"], strategy=r["strategy"])
            if earlier is not None:
                return f"a second holdout claim (the first was by study {earlier['study_id']})"
            return None
        if kind == "holdout_result":
            missing = _missing(r, _HOLDOUT_RESULT_FIELDS)
            if missing:
                return missing
            if not any(c["study_id"] == r["study_id"] and c["run_id"] == r["run_id"] for c in self._claims):
                return f"a holdout result without a claim (study {r['study_id']}, run {r['run_id']})"
            if r["run_id"] in self._results:
                return f"a second holdout result for run {r['run_id']}"
            return None
        return f"unknown kind {kind!r}"

    def _apply(self, r: Mapping[str, Any]) -> None:
        if r["kind"] == "holdout_claimed":
            self._claims.append(dict(r))
        else:
            self._results.add(r["run_id"])

    def _find(self, *, family: str, strategy: str) -> dict[str, Any] | None:
        return next((c for c in self._claims if c["family"] == family or c["strategy"] == strategy), None)

    def claim_for(self, *, family: str, strategy: str) -> Mapping[str, object] | None:
        found = self._find(family=family, strategy=strategy)
        return None if found is None else copy.deepcopy(found)

    def claim(
        self,
        *,
        family: str,
        strategy: str,
        study_id: str,
        spec_sha256: str,
        final_params: Params,
        run_id: str,
    ) -> None:
        """``RegistryError`` if a claim exists for the family OR the strategy."""
        earlier = self._find(family=family, strategy=strategy)
        if earlier is not None:
            raise RegistryError(
                [
                    f"the holdout was already used by study {earlier['study_id']} "
                    f"(family {earlier['family']}, strategy {earlier['strategy']}, run {earlier['run_id']}): "
                    "it can be used once per family and once per strategy"
                ]
            )
        body = _body(
            {},
            {
                "family": family,
                "strategy": strategy,
                "study_id": study_id,
                "spec_sha256": spec_sha256,
                "final_params": dict(final_params),
                "run_id": run_id,
                "confirmed": "tty",
            },
        )
        self._log.append("holdout_claimed", body)

    def record_result(self, *, study_id: str, run_id: str, fields: Mapping[str, object]) -> None:
        if not any(c["study_id"] == study_id and c["run_id"] == run_id for c in self._claims):
            raise RegistryError([f"no holdout claim for study {study_id} and run {run_id}"])
        if run_id in self._results:
            raise RegistryError([f"the holdout result of run {run_id} is already recorded"])
        self._log.append("holdout_result", _body(fields, {"study_id": study_id, "run_id": run_id}))


# =============================================================================== fingerprints and counts
def code_fingerprint(package_dir: Path) -> str:
    """sha256 of the sorted relative paths and LF-normalised bytes of every ``*.py``."""
    if not package_dir.is_dir():
        raise ValueError(f"not a folder: {package_dir}")
    files = sorted(
        (p.relative_to(package_dir).as_posix(), p) for p in package_dir.rglob("*.py") if p.is_file()
    )
    if not files:
        raise ValueError(f"no Python files under {package_dir}")
    h = hashlib.sha256()
    for rel, path in files:
        data = path.read_bytes().replace(b"\r\n", b"\n").replace(b"\r", b"\n")
        name = rel.encode("utf-8")
        h.update(len(name).to_bytes(8, "big") + name + len(data).to_bytes(8, "big") + data)
    return h.hexdigest()


def experiments_trial_count(path: Path) -> int:
    """The N of exactly one ``Total trials so far: **N**`` line, else ``RegistryError``."""
    try:
        text = path.read_text(encoding="utf-8-sig").replace("\r", "")  # -sig: Notepad's BOM
    except (OSError, UnicodeDecodeError) as exc:
        raise RegistryError([f"cannot read {_shown(path)}: {exc}"]) from exc
    found = _COUNT_LINE.findall(text)
    if len(found) != 1:
        raise RegistryError(
            [f"{_shown(path)} must hold exactly one line 'Total trials so far: **N**' (found {len(found)})"]
        )
    return int(found[0])
