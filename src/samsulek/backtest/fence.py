"""The holdout fence: research never sees holdout data.

Five layers (spec 7.7); this module holds the first three and the fifth:
1. Physical: research datasets are built with ``cutoff = RESEARCH_DATA_CUTOFF`` and holdout
   datasets with ``HOLDOUT_DATA_CUTOFF`` (``data_cutoff``); ``PitDataset.build`` drops
   everything past the cutoff, so data after 2026-09-30 is never loaded.
2. Job bounds: ``check_job_inside`` runs for every job. A research job ends on or before
   2024-09-30; a holdout job trades from 2024-10-01 to 2026-09-30 (it may warm up on
   earlier data, which is why only its trading sessions are checked).
3. Document lock: only the date TABLE of research/holdout.md is fingerprinted (its lines
   starting with "|", carriage returns removed, whitespace runs collapsed), so fixing a
   typo in the prose changes nothing while editing a date refuses every study, holdout and
   demo until ``EXPECTED_HOLDOUT_TABLE_SHA256`` is updated in a reviewed change (the
   live_gate pattern).
4. One holdout per family and strategy: backtest/registry.py.
5. Memecoins: refused while ``MEMECOIN_RESEARCH_CUTOFF`` is None (until M4 writes the
   memecoin holdout date).

Every refusal is a ``HoldoutFenceError`` (a ``BacktestRefused``: CLI exit 3, nothing
registered) that lists every problem found. Nothing here writes a file.
"""

from __future__ import annotations

import hashlib
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Final

from samsulek.backtest.types import BacktestRefused, Period
from samsulek.types import Market

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
    """sha256 of the table rows of ``text``: carriage returns removed, the lines whose
    ``lstrip()`` starts with "|", each with its whitespace runs collapsed to one space,
    joined with "\\n" and encoded as UTF-8."""
    rows = [
        " ".join(line.split()) for line in text.replace("\r", "").split("\n") if line.lstrip().startswith("|")
    ]
    return hashlib.sha256("\n".join(rows).encode("utf-8")).hexdigest()


def check_holdout_doc(root: Path) -> None:
    """Refuse unless ``root``/research/holdout.md exists and its date table is unchanged."""
    path = root / HOLDOUT_DOC
    shown = HOLDOUT_DOC.as_posix()
    try:
        text = path.read_bytes().decode("utf-8")
    except FileNotFoundError:
        raise HoldoutFenceError(
            [f"{shown} is missing: the holdout dates must be fixed in writing before any study runs"]
        ) from None
    except (OSError, UnicodeDecodeError) as exc:
        raise HoldoutFenceError([f"{shown} cannot be read ({type(exc).__name__}): fix the file"]) from None
    found = holdout_table_fingerprint(text)
    if found != EXPECTED_HOLDOUT_TABLE_SHA256:
        raise HoldoutFenceError(
            [
                f"the date table in {shown} changed (fingerprint {found}, expected "
                f"{EXPECTED_HOLDOUT_TABLE_SHA256}). Changing holdout dates after research started "
                "invalidates every result: restore the table, or update EXPECTED_HOLDOUT_TABLE_SHA256 "
                "in backtest/fence.py in a reviewed change"
            ]
        )


def data_cutoff(period: Period) -> datetime:
    """The physical cutoff of the dataset a ``period`` study may load."""
    return {Period.RESEARCH: RESEARCH_DATA_CUTOFF, Period.HOLDOUT: HOLDOUT_DATA_CUTOFF}[Period(period)]


def check_job_inside(period: Period, *, first_session: date, last_session: date) -> None:
    """Refuse a job whose trading sessions leave its period (warm-up data is not checked here)."""
    period = Period(period)
    problems: list[str] = []
    if first_session > last_session:
        problems.append(f"the job starts on {first_session}, after its last session {last_session}")
    if period is Period.RESEARCH:
        if last_session > RESEARCH_LAST_SESSION:
            problems.append(
                f"a research job must end by {RESEARCH_LAST_SESSION} (the holdout starts "
                f"{HOLDOUT_FIRST_SESSION}); this one ends {last_session}"
            )
    else:
        if first_session < HOLDOUT_FIRST_SESSION:
            problems.append(
                f"a holdout job must trade from {HOLDOUT_FIRST_SESSION} on (earlier data is only "
                f"warm-up); this one starts {first_session}"
            )
        if last_session > HOLDOUT_LAST_SESSION:
            problems.append(f"a holdout job must end by {HOLDOUT_LAST_SESSION}; this one ends {last_session}")
    if problems:
        raise HoldoutFenceError(problems)


def check_market(market: str) -> None:
    """Stocks pass. Memecoin research is refused while no memecoin holdout date is written
    (``MEMECOIN_RESEARCH_CUTOFF is None``); any other market name is refused too."""
    name = str(market)
    if name == Market.STOCKS.value:
        return
    if name == Market.MEMECOIN.value:
        if MEMECOIN_RESEARCH_CUTOFF is None:
            raise HoldoutFenceError(
                [
                    "memecoin research is refused until M4 writes the memecoin holdout date into "
                    "research/holdout.md (there is no point-in-time memecoin dataset yet)"
                ]
            )
        return
    raise HoldoutFenceError([f"unknown market {name!r}: expected {Market.STOCKS.value!r}"])
