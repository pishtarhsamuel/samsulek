"""Running a whole study or its one holdout run, end to end (M3 skeleton; WP6b fills it in).

Order: holdout document check; load and bind the study file; build the cut dataset;
register every variant as a trial BEFORE any run; walk-forward (Phase A, selection,
the stitched out-of-sample run); baselines; facts and verdict; the run folder. Any abort
still records ``study_finished aborted``. ``run_holdout`` claims the holdout for the
family and strategy BEFORE simulating, so a crash still spends it; it may be referenced
only here and in cli.py, which asks for the typed code at a real terminal first.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Final, Literal

from samsulek.backtest.facts import Fact
from samsulek.backtest.sources import BarSource
from samsulek.clock import Clock

DEMO_STUDY: Final = Path("research") / "studies" / "S001_demo.yaml"


@dataclass(frozen=True)
class StudyResult:
    run_id: str
    study_id: str
    kind: Literal["research", "holdout"]
    folder: Path
    report_path: Path | None
    facts: tuple[Fact, ...]
    flags: tuple[str, ...]
    verdict: str
    summary_lines: tuple[str, ...]
    experiment_entry: str | None


def run_study(
    spec_path: Path,
    *,
    root: Path,
    data_dir: Path,
    clock: Clock,
    workers: int,
    quantity_step: Decimal,
    price_tick: Decimal,
    say: Callable[[str], None],
    source: BarSource | None = None,
) -> StudyResult:
    raise NotImplementedError("WP6b")


def run_holdout(
    spec_path: Path,
    *,
    root: Path,
    data_dir: Path,
    clock: Clock,
    workers: int,
    quantity_step: Decimal,
    price_tick: Decimal,
    say: Callable[[str], None],
    confirmed: bool,
    source: BarSource | None = None,
) -> StudyResult:
    """``confirmed`` False -> ``BacktestRefused``."""
    raise NotImplementedError("WP6b")


def trials_summary(root: Path, *, clock: Clock) -> list[str]:
    raise NotImplementedError("WP6b")
