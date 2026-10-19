"""The trial registry and the holdout log: append-only, hash-chained JSONL (M3 skeleton; WP5).

Every grid variant is registered as a trial BEFORE any run (trial key: study id, params
sha, data fingerprint), so N for the deflated Sharpe counts every idea tried, failures
and aborted studies included. Each line is canonical JSON with a consecutive ``seq`` and
the sha256 of the previous line (``prev``); on load the chain is verified and any edit,
deletion or reordering is refused (``RegistryError``). CRLF line endings are tolerated.
Lines are written only by the parent process holding the backtest lock, each followed by
flush and fsync. The holdout log allows one claim per family AND per strategy, appended
before the holdout simulation runs. This module and report.py are the only backtest
modules that write files (rule A12).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from samsulek.backtest.stats import SharpeStats
from samsulek.backtest.types import BacktestRefused, Variant
from samsulek.clock import Clock
from samsulek.strategies.params import Params


class RegistryError(BacktestRefused):
    """The registry or the holdout log refuses (edited file, rebound study id, second holdout...)."""


@dataclass(frozen=True, slots=True)
class TrialSummary:
    n_trials: int
    completed_srs: tuple[float, ...]
    per_family: Mapping[str, int]


class TrialRegistry:
    def __init__(self, path: Path, *, clock: Clock) -> None:
        """Loads and verifies the chain; a missing file is an empty registry."""
        raise NotImplementedError("WP5")

    def n_trials(self) -> int:
        raise NotImplementedError("WP5")

    def summary(self) -> TrialSummary:
        raise NotImplementedError("WP5")

    def bound_spec_sha256(self, study_id: str) -> str | None:
        raise NotImplementedError("WP5")

    def register_study(self, *, study_id: str, spec_sha256: str, fields: Mapping[str, object]) -> int:
        """Returns the attempt number."""
        raise NotImplementedError("WP5")

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
        raise NotImplementedError("WP5")

    def record_trial_result(
        self, trial_id: str, *, attempt: int, run_id: str, stats: SharpeStats, fields: Mapping[str, object]
    ) -> None:
        raise NotImplementedError("WP5")

    def record_study_finished(
        self,
        *,
        study_id: str,
        attempt: int,
        run_id: str,
        status: Literal["complete", "aborted"],
        fields: Mapping[str, object],
    ) -> None:
        raise NotImplementedError("WP5")

    def latest_complete(self, study_id: str) -> Mapping[str, object] | None:
        raise NotImplementedError("WP5")


class HoldoutLog:
    def __init__(self, path: Path, *, clock: Clock) -> None:
        raise NotImplementedError("WP5")

    def claim_for(self, *, family: str, strategy: str) -> Mapping[str, object] | None:
        raise NotImplementedError("WP5")

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
        raise NotImplementedError("WP5")

    def record_result(self, *, study_id: str, run_id: str, fields: Mapping[str, object]) -> None:
        raise NotImplementedError("WP5")


def trial_id_for(study_id: str, variant: Variant, data_fingerprint: str) -> str:
    """``f"{study_id}-v{index:03d}-{sha256(f'{params_sha256}:{data_fingerprint}')[:8]}"``."""
    raise NotImplementedError("WP5")


def code_fingerprint(package_dir: Path) -> str:
    """sha256 of the sorted relative paths and LF-normalised bytes of every ``*.py``."""
    raise NotImplementedError("WP5")


def experiments_trial_count(path: Path) -> int:
    """The N of exactly one ``Total trials so far: **N**`` line, else ``RegistryError``."""
    raise NotImplementedError("WP5")
