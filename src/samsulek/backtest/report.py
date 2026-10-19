"""Run folders and reports: ASCII Markdown and CSV only (M3 skeleton; WP6b fills it in).

Every output path goes through ``safe_output_path``: it must resolve under the backtests
folder or ``research/reports``, and no part of it may be named "state" or "logs". CSV is
written with ``newline=""`` and text with ``newline="\\n"``; ``result.json`` is written
last. Two runs of the same study give byte-identical files outside the ``meta`` block.
This module and registry.py are the only backtest modules that write files (rule A12).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ReportBundle:
    """Everything a report shows (WP6b writes the fields): the spec and its sha, run id and
    kind, folds and choices, variant summaries, every RunResult/RunSummary, the unconstrained
    buy-and-hold, the comparisons, the DSR, facts, flags, verdict and registry status."""


def safe_output_path(*, root: Path, backtests_dir: Path, path: Path) -> Path:
    raise NotImplementedError("WP6b")


def write_run_folder(folder: Path, bundle: ReportBundle) -> list[Path]:
    raise NotImplementedError("WP6b")


def render_report_md(bundle: ReportBundle) -> str:
    raise NotImplementedError("WP6b")


def render_summary_lines(bundle: ReportBundle) -> list[str]:
    raise NotImplementedError("WP6b")


def render_experiment_entry(bundle: ReportBundle) -> str:
    raise NotImplementedError("WP6b")
