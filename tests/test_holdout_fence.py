"""The holdout fence (spec 7.7, trap 16 data part, trap 20 fence part): research never sees
holdout data, the holdout date table is locked, and memecoin research is refused."""

from __future__ import annotations

import pickle
import shutil
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from samsulek.backtest import fence
from samsulek.backtest.dataset import PitDataset
from samsulek.backtest.fence import (
    EXPECTED_HOLDOUT_TABLE_SHA256,
    HOLDOUT_DATA_CUTOFF,
    HOLDOUT_DOC,
    HOLDOUT_FIRST_SESSION,
    HOLDOUT_LAST_SESSION,
    MEMECOIN_RESEARCH_CUTOFF,
    RESEARCH_DATA_CUTOFF,
    RESEARCH_LAST_SESSION,
    HoldoutFenceError,
    check_holdout_doc,
    check_job_inside,
    check_market,
    data_cutoff,
    holdout_table_fingerprint,
)
from samsulek.backtest.sources import SyntheticBarSource
from samsulek.backtest.types import BacktestRefused, Period
from samsulek.data.calendars import XetraCalendar
from samsulek.types import Market

ROOT = Path(__file__).resolve().parents[1]
REAL_DOC = ROOT / HOLDOUT_DOC
BERLIN = ZoneInfo("Europe/Berlin")
CAL = XetraCalendar()


def project_with(tmp_path: Path, text: str | bytes) -> Path:
    (tmp_path / "research").mkdir(parents=True, exist_ok=True)
    target = tmp_path / HOLDOUT_DOC
    if isinstance(text, bytes):
        target.write_bytes(text)
    else:
        target.write_text(text, encoding="utf-8", newline="")
    return tmp_path


def real_text() -> str:
    return REAL_DOC.read_bytes().decode("utf-8")


# ------------------------------------------------------------------ constants
def test_the_cutoffs_are_midnight_berlin_after_the_last_session_of_each_period() -> None:
    assert RESEARCH_DATA_CUTOFF.astimezone(BERLIN) == datetime(2024, 10, 1, tzinfo=BERLIN)
    assert HOLDOUT_DATA_CUTOFF.astimezone(BERLIN) == datetime(2026, 10, 1, tzinfo=BERLIN)
    assert RESEARCH_LAST_SESSION + timedelta(days=1) == HOLDOUT_FIRST_SESSION
    # The last research session's close is before the research cutoff, the first holdout
    # session's open print after it.
    assert (
        CAL.close_utc(RESEARCH_LAST_SESSION)
        < RESEARCH_DATA_CUTOFF
        < CAL.open_print_utc(HOLDOUT_FIRST_SESSION)
    )
    assert CAL.close_utc(HOLDOUT_LAST_SESSION) < HOLDOUT_DATA_CUTOFF < CAL.open_print_utc(date(2026, 10, 1))
    assert data_cutoff(Period.RESEARCH) == RESEARCH_DATA_CUTOFF
    assert data_cutoff(Period.HOLDOUT) == HOLDOUT_DATA_CUTOFF
    assert data_cutoff("holdout") == HOLDOUT_DATA_CUTOFF  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="nope"):
        data_cutoff("nope")  # type: ignore[arg-type]
    assert MEMECOIN_RESEARCH_CUTOFF is None
    assert HOLDOUT_DOC.as_posix() == "research/holdout.md"


def test_the_holdout_dates_in_the_doc_match_the_constants() -> None:
    text = real_text()
    assert "everything before 2024-10-01" in text
    assert "**2024-10-01 to 2026-09-30**" in text
    assert HOLDOUT_FIRST_SESSION.isoformat() == "2024-10-01"
    assert HOLDOUT_LAST_SESSION.isoformat() == "2026-09-30"


# ------------------------------------------------------------- document lock
def test_the_constant_is_the_fingerprint_of_the_committed_table() -> None:
    assert holdout_table_fingerprint(real_text()) == EXPECTED_HOLDOUT_TABLE_SHA256
    check_holdout_doc(ROOT)  # the real project passes


def test_the_fingerprint_is_the_documented_algorithm() -> None:
    # The lead's reference (scratchpad m3_design/lead/holdout_fp.py), restated.
    import hashlib

    text = real_text().replace("\r", "")
    rows = [" ".join(line.split()) for line in text.split("\n") if line.lstrip().startswith("|")]
    assert len(rows) == 4
    assert (
        holdout_table_fingerprint(real_text()) == hashlib.sha256("\n".join(rows).encode("utf-8")).hexdigest()
    )


def test_line_endings_and_whitespace_inside_rows_do_not_matter(tmp_path: Path) -> None:
    text = real_text()
    crlf = text.replace("\r\n", "\n").replace("\n", "\r\n")
    check_holdout_doc(project_with(tmp_path, crlf.encode("utf-8")))
    spaced = text.replace("| Stocks / ETFs |", "|   Stocks  /  ETFs\t|")
    assert spaced != text
    check_holdout_doc(project_with(tmp_path, spaced))
    indented = text.replace("| Memecoins |", "   | Memecoins |")
    check_holdout_doc(project_with(tmp_path, indented))
    # Every carriage return is removed first (spec 2.5), a stray one inside a word included,
    # so it is not read as a space.
    stray = text.replace("| Stocks / ETFs |", "| Sto\rcks / ETFs |")
    assert holdout_table_fingerprint(stray) == EXPECTED_HOLDOUT_TABLE_SHA256
    assert holdout_table_fingerprint(text.replace("| Stocks / ETFs |", "| Sto cks / ETFs |")) != (
        EXPECTED_HOLDOUT_TABLE_SHA256
    )


def test_editing_the_prose_changes_nothing(tmp_path: Path) -> None:
    text = real_text()
    edited = text.replace("Changing these dates", "Changing  these dates (typo fixed)")
    edited = edited.replace("Rules", "Rules for the holdout") + "\nA new closing paragraph.\n"
    assert edited != text
    check_holdout_doc(project_with(tmp_path, edited))


@pytest.mark.parametrize(
    ("old", "new"),
    [
        ("2024-10-01 to 2026-09-30", "2024-10-01 to 2026-06-30"),  # shorter holdout
        ("everything before 2024-10-01", "everything before 2025-01-01"),  # research eats the holdout
        ("(24 months)", "(21 months)"),
        ("| Memecoins |", "| Memecoin |"),
        ("|---|---|---|", "|---|---|"),
    ],
)
def test_editing_a_table_row_refuses_everything(tmp_path: Path, old: str, new: str) -> None:
    text = real_text()
    assert old in text
    root = project_with(tmp_path, text.replace(old, new, 1))
    with pytest.raises(HoldoutFenceError, match=r"date table in research/holdout\.md changed") as info:
        check_holdout_doc(root)
    assert EXPECTED_HOLDOUT_TABLE_SHA256 in str(info.value)
    assert isinstance(info.value, BacktestRefused)


def test_adding_or_removing_a_table_row_refuses(tmp_path: Path) -> None:
    text = real_text()
    added = text.replace("| Memecoins |", "| Bonds | x | y |\n| Memecoins |")
    with pytest.raises(HoldoutFenceError):
        check_holdout_doc(project_with(tmp_path, added))
    removed = "\n".join(line for line in text.split("\n") if not line.startswith("| Memecoins"))
    with pytest.raises(HoldoutFenceError):
        check_holdout_doc(project_with(tmp_path, removed))


def test_a_missing_or_unreadable_doc_refuses(tmp_path: Path) -> None:
    with pytest.raises(HoldoutFenceError, match=r"research/holdout\.md is missing"):
        check_holdout_doc(tmp_path)
    root = project_with(tmp_path, b"| Market |\xff\xfe broken |\n")
    with pytest.raises(HoldoutFenceError, match="cannot be read"):
        check_holdout_doc(root)
    (root / HOLDOUT_DOC).unlink()
    (root / HOLDOUT_DOC).mkdir()  # a folder where the file should be
    with pytest.raises(HoldoutFenceError, match="cannot be read"):
        check_holdout_doc(root)


def test_the_real_doc_copied_byte_for_byte_passes(tmp_path: Path) -> None:
    (tmp_path / "research").mkdir()
    shutil.copyfile(REAL_DOC, tmp_path / HOLDOUT_DOC)
    check_holdout_doc(tmp_path)


# ---------------------------------------------------------------- job bounds
def test_a_research_job_must_end_by_the_last_research_session() -> None:
    check_job_inside(Period.RESEARCH, first_session=date(2016, 1, 4), last_session=date(2024, 9, 30))
    with pytest.raises(HoldoutFenceError, match="must end by 2024-09-30") as info:
        check_job_inside(Period.RESEARCH, first_session=date(2016, 1, 4), last_session=date(2024, 10, 1))
    assert info.value.problems and "2024-10-01" in info.value.problems[0]
    with pytest.raises(HoldoutFenceError):
        check_job_inside(Period.RESEARCH, first_session=date(2025, 1, 2), last_session=date(2025, 6, 2))


def test_a_holdout_job_stays_inside_the_holdout_but_may_warm_up_earlier() -> None:
    check_job_inside(Period.HOLDOUT, first_session=date(2024, 10, 1), last_session=date(2026, 9, 30))
    with pytest.raises(HoldoutFenceError, match="must trade from 2024-10-01"):
        check_job_inside(Period.HOLDOUT, first_session=date(2024, 9, 30), last_session=date(2026, 9, 30))
    with pytest.raises(HoldoutFenceError, match="must end by 2026-09-30"):
        check_job_inside(Period.HOLDOUT, first_session=date(2024, 10, 1), last_session=date(2026, 10, 1))
    with pytest.raises(HoldoutFenceError) as info:  # every problem at once
        check_job_inside(Period.HOLDOUT, first_session=date(2020, 1, 2), last_session=date(2027, 1, 4))
    assert len(info.value.problems) == 2


def test_a_job_that_ends_before_it_starts_is_refused() -> None:
    with pytest.raises(HoldoutFenceError, match="after its last session"):
        check_job_inside(Period.RESEARCH, first_session=date(2020, 1, 3), last_session=date(2020, 1, 2))


def test_holdout_warm_up_data_is_in_the_holdout_dataset_and_nothing_after_it() -> None:
    data = SyntheticBarSource(seed=3, calendar=CAL).load(
        ["A"], first=date(2024, 6, 3), last=date(2026, 12, 30)
    )
    ds = PitDataset.build(data, calendar=CAL, cutoff=data_cutoff(Period.HOLDOUT))
    assert ds.has_open_print("A", date(2024, 6, 3))  # warm-up before the holdout is loadable
    sessions = ds.sessions(date(2000, 1, 1), date(2030, 1, 1))
    assert sessions[-1] == date(2026, 9, 30)
    assert not ds.has_open_print("A", date(2026, 10, 1))
    with pytest.raises(KeyError):
        ds.raw_close_eur("A", date(2026, 10, 1))


# ------------------------------------------------------------ physical layer
def test_a_research_dataset_holds_nothing_at_or_after_the_cutoff_and_counts_the_drop() -> None:
    symbols = ["A", "B", "C"]
    data = SyntheticBarSource(seed=11, calendar=CAL).load(
        symbols, first=date(2024, 1, 2), last=date(2024, 12, 30)
    )
    ds = PitDataset.build(data, calendar=CAL, cutoff=data_cutoff(Period.RESEARCH))
    after = CAL.sessions(date(2024, 10, 1), date(2024, 12, 30))
    assert ds.dropped_after_cutoff == len(symbols) * 2 * len(after)  # an open print and a bar each
    assert ds.sessions(date(2024, 1, 1), date(2025, 1, 1))[-1] == RESEARCH_LAST_SESSION
    far = datetime(2030, 1, 1, tzinfo=UTC)
    for symbol in symbols:
        assert not any(ds.has_open_print(symbol, d) for d in after)
        last = ds.latest_print(symbol, far)
        assert last is not None and last[0] == CAL.close_utc(RESEARCH_LAST_SESSION)
        assert ds.adjusted_window(symbol, far, 1000)[-1].close_ts == CAL.close_utc(RESEARCH_LAST_SESSION)
    # The same data with the holdout cutoff does hold them: the cut is what removed them.
    full = PitDataset.build(data, calendar=CAL, cutoff=data_cutoff(Period.HOLDOUT))
    assert all(full.has_open_print("A", d) for d in after)
    assert full.fingerprint != ds.fingerprint


# ---------------------------------------------------------------- memecoins
def test_memecoin_research_is_refused_while_its_cutoff_is_none() -> None:
    check_market("stocks")
    check_market(Market.STOCKS)
    with pytest.raises(HoldoutFenceError, match="memecoin research is refused until M4"):
        check_market("memecoin")
    with pytest.raises(HoldoutFenceError, match="memecoin"):
        check_market(Market.MEMECOIN)
    with pytest.raises(HoldoutFenceError, match="unknown market"):
        check_market("crypto")


def test_the_memecoin_gate_is_the_constant(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fence, "MEMECOIN_RESEARCH_CUTOFF", datetime(2027, 1, 1, tzinfo=UTC))
    check_market("memecoin")  # once M4 writes a date, the fence lets it through


def test_fence_errors_pickle_with_their_problems() -> None:
    err = HoldoutFenceError(["a", "b"])
    back = pickle.loads(pickle.dumps(err))  # noqa: S301
    assert type(back) is HoldoutFenceError and back.problems == ("a", "b")
