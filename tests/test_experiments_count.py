"""research/experiments.md's "Total trials so far" must equal the trial registry's N (spec C15, section 8).

The backtester never edits experiments.md: it prints a ready-to-paste entry, and a new
E-study is refused until the count line matches research/trials.jsonl. This test pins the
same agreement on the committed files, so a commit cannot carry a registry and a logbook
that disagree. An absent trials.jsonl is an empty registry (0 trials).
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from samsulek.backtest.registry import RegistryError, TrialRegistry, experiments_trial_count
from samsulek.clock import FixedClock

ROOT = Path(__file__).resolve().parents[1]
EXPERIMENTS = ROOT / "research" / "experiments.md"
TRIALS = ROOT / "research" / "trials.jsonl"


def test_the_logbook_count_equals_the_registry() -> None:
    # Loading the registry also verifies its hash chain.
    registry = TrialRegistry(TRIALS, clock=FixedClock(datetime(2026, 1, 1, tzinfo=UTC)))
    assert experiments_trial_count(EXPERIMENTS) == registry.n_trials(), (
        "research/experiments.md 'Total trials so far' must equal the number of trials registered in "
        "research/trials.jsonl: paste the study's experiment entry and set the count line"
    )


def write(tmp_path: Path, text: str) -> Path:
    p = tmp_path / "experiments.md"
    p.write_bytes(text.encode("utf-8"))
    return p


@pytest.mark.parametrize(
    ("text", "n"),
    [
        ("# Log\n\nTotal trials so far: **0**\n", 0),
        ("Total trials so far: **23**\n## Entries\n", 23),
        ("intro\r\nTotal trials so far: **7**\r\nmore\r\n", 7),  # CRLF checkout on Windows
        ("Total trials so far: **1200**", 1200),  # no final newline
        ("\ufeffTotal trials so far: **5**\n", 5),  # saved by Windows Notepad with a BOM
    ],
)
def test_the_count_line_is_read(tmp_path: Path, text: str, n: int) -> None:
    assert experiments_trial_count(write(tmp_path, text)) == n


@pytest.mark.parametrize(
    "text",
    [
        "no count here\n",
        "Total trials so far: **3**\nTotal trials so far: **4**\n",  # two lines: which one?
        "Total trials so far: **3**\nTotal trials so far: **3**\n",
        "Total trials so far: 3\n",  # not bold
        "Total trials so far: **-3**\n",
        "Total trials so far: **3** (plus 2)\n",  # extra text on the line
        "  Total trials so far: **3**\n",  # indented: not the line the template defines
        "Total trials so far: **\u0663**\n",  # an Arabic-Indic 3: Python's \d would read it as 3
    ],
)
def test_anything_but_exactly_one_count_line_is_refused(tmp_path: Path, text: str) -> None:
    with pytest.raises(RegistryError, match="exactly one line 'Total trials so far: \\*\\*N\\*\\*'"):
        experiments_trial_count(write(tmp_path, text))


def test_a_missing_logbook_is_refused(tmp_path: Path) -> None:
    with pytest.raises(RegistryError, match="cannot read"):
        experiments_trial_count(tmp_path / "experiments.md")


def test_the_message_names_the_research_file(tmp_path: Path) -> None:
    folder = tmp_path / "research"
    folder.mkdir()
    p = folder / "experiments.md"
    p.write_text("nothing\n", encoding="utf-8")
    with pytest.raises(RegistryError) as info:
        experiments_trial_count(p)
    assert info.value.problems == (
        "research/experiments.md must hold exactly one line 'Total trials so far: **N**' (found 0)",
    )
