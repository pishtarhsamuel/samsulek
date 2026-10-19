"""The holdout fence: research never sees holdout data (M3 skeleton; WP3 fills it in).

Five layers: research datasets are physically cut at ``RESEARCH_DATA_CUTOFF`` and holdout
datasets at ``HOLDOUT_DATA_CUTOFF`` (data after 2026-09-30 is never loaded); every job's
sessions are checked against its period; the date table of research/holdout.md is
fingerprinted (only its table rows, whitespace-normalised: editing them refuses every
study until ``EXPECTED_HOLDOUT_TABLE_SHA256`` is updated in a reviewed change, the
live_gate pattern); one holdout per family and strategy (backtest/registry.py); and
memecoin studies are refused while ``MEMECOIN_RESEARCH_CUTOFF`` is None (until M4).
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from pathlib import Path
from typing import Final

from samsulek.backtest.types import BacktestRefused, Period

RESEARCH_LAST_SESSION: Final = date(2024, 9, 30)
HOLDOUT_FIRST_SESSION: Final = date(2024, 10, 1)  # first holdout session is the first session >= this
HOLDOUT_LAST_SESSION: Final = date(2026, 9, 30)
RESEARCH_DATA_CUTOFF: Final = datetime(2024, 9, 30, 22, 0, tzinfo=UTC)  # 2024-10-01 00:00 Berlin (CEST)
HOLDOUT_DATA_CUTOFF: Final = datetime(2026, 9, 30, 22, 0, tzinfo=UTC)  # 2026-10-01 00:00 Berlin (CEST)
MEMECOIN_RESEARCH_CUTOFF: Final[datetime | None] = None  # memecoin research refused until M4
HOLDOUT_DOC: Final = Path("research") / "holdout.md"
EXPECTED_HOLDOUT_TABLE_SHA256: Final = "374df5c7f4e4c6d2f518840daa3070c353d64b4a67ecb8db3de3e68d128efad7"


class HoldoutFenceError(BacktestRefused):
    """A study or job would touch the holdout (or the holdout document changed)."""


def holdout_table_fingerprint(text: str) -> str:
    raise NotImplementedError("WP3")


def check_holdout_doc(root: Path) -> None:
    raise NotImplementedError("WP3")


def data_cutoff(period: Period) -> datetime:
    raise NotImplementedError("WP3")


def check_job_inside(period: Period, *, first_session: date, last_session: date) -> None:
    raise NotImplementedError("WP3")


def check_market(market: str) -> None:
    raise NotImplementedError("WP3")
