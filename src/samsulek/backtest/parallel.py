"""Running many jobs: in-process or on a spawn process pool (M3 skeleton; WP6b fills it in).

The only module that may use ``multiprocessing`` or ``concurrent.futures`` (rule A9).
``workers == 1`` runs in-process through the SAME module-level worker function and
initializer; otherwise a ``ProcessPoolExecutor`` with an explicit ``spawn`` context (as on
Windows) and at most ``MAX_WORKERS`` processes, with results through ``pool.map`` in input
order. Results never depend on the worker count. Ctrl+C cancels pending jobs and re-raises.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Final

from samsulek.backtest.types import EngineContext, RunJob, RunResult, RunSummary

MAX_WORKERS: Final = 61  # the Windows limit for ProcessPoolExecutor


def run_full(jobs: Sequence[RunJob], ctx: EngineContext, *, workers: int) -> list[RunResult]:
    raise NotImplementedError("WP6b")


def run_summaries(jobs: Sequence[RunJob], ctx: EngineContext, *, workers: int) -> list[RunSummary]:
    raise NotImplementedError("WP6b")
