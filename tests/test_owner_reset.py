"""The owner's halt reset, shared by the CLI and the backtest (spec P2, C23).

``samsulek reset-halt`` (terminal faked) and ``apply_owner_reset`` on a fresh store from
the same prior state leave byte-identical state files, and the CLI prints exactly the
lines the steps report, in order. Both match a verbatim copy of the command's statements
before M3 (the oracle), byte for byte, history lines included. Each line is printed
right after its step, so when a later step fails the owner still sees what was done.
The day's baseline and trade counts are never touched.
"""

from __future__ import annotations

import contextlib
import io
import shutil
from collections.abc import Iterator
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from samsulek import cli
from samsulek.clock import SystemClock
from samsulek.risk.reset import ResetOutcome, ResetStep, apply_owner_reset
from samsulek.risk.state import DayState, RiskStateStore

ROOT = Path(__file__).resolve().parents[1]
BEFORE = datetime(2026, 10, 12, 8, 0, tzinfo=UTC)
NOW = datetime(2026, 10, 13, 6, 30, tzinfo=UTC)
WHO = "owner-test"
STATE_FILES = ("halt.json", "kill.json", "risk_day.json", "equity_peak.json", "state_history.jsonl")


def line_for(step: ResetStep, value: Decimal | None) -> str:
    """The CLI's wording for each step (unchanged since M1)."""
    if step == "halt_cleared":
        return "Halt cleared."
    if step == "kill_cleared":
        return "KILL switch cleared."
    assert value is not None
    return f"Peak equity reset to the last seen equity EUR {value:,.2f}."


def make_project(base: Path) -> Path:
    shutil.copytree(ROOT / "config", base / "config")
    shutil.copytree(ROOT / "ops", base / "ops")
    return base


@contextlib.contextmanager
def owner_terminal() -> Iterator[None]:
    """The owner at a real terminal, typing the right code; the clock and user name fixed."""
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(cli, "require_interactive", lambda: None)
        mp.setattr(cli, "confirm_phrase", lambda prompt, expected: expected.startswith("RESET "))
        mp.setattr(SystemClock, "now", lambda self: NOW)
        mp.setenv("USERNAME", WHO)
        yield


def run_reset_cli(root: Path, *flags: str) -> tuple[int, list[str]]:
    out = io.StringIO()
    with owner_terminal(), contextlib.redirect_stdout(out):
        code = cli.main(["--root", str(root), "reset-halt", *flags])
    return code, out.getvalue().splitlines()


def write_prior(store: RiskStateStore, prior: dict[str, object]) -> None:
    if prior["halt"]:
        store.set_halt("daily loss 3.20% >= 3.00%", BEFORE)
    if prior["kill"]:
        store.set_kill("manual kill switch", BEFORE)
    day = prior["day"]
    if isinstance(day, DayState):
        store.write_day(day)
    peak = prior["peak"]
    if isinstance(peak, Decimal):
        store.write_peak(peak)


def state_bytes(state_dir: Path) -> dict[str, bytes | None]:
    return {
        name: (state_dir / name).read_bytes() if (state_dir / name).exists() else None for name in STATE_FILES
    }


money = st.decimals(min_value=0, max_value=500, places=2, allow_nan=False, allow_infinity=False)
days = st.none() | st.builds(
    DayState,
    day=st.just(date(2026, 10, 12)),
    day_start_equity=money,
    last_equity=st.sampled_from([Decimal(0), Decimal("0.00")]) | money,
    trades=st.fixed_dictionaries({"total": st.integers(0, 8), "stocks": st.integers(0, 6)}),
)
priors = st.fixed_dictionaries(
    {
        "halt": st.booleans(),
        "kill": st.booleans(),
        "day": days,
        "peak": st.none() | st.decimals(min_value="0.01", max_value=500, places=2),
    }
)


@settings(max_examples=120)
@given(prior=priors, clear_kill=st.booleans(), rebase_peak=st.booleans())
def test_cli_and_function_leave_identical_state(
    tmp_path_factory: pytest.TempPathFactory, prior: dict[str, object], clear_kill: bool, rebase_peak: bool
) -> None:
    base = tmp_path_factory.mktemp("reset")
    root = make_project(base / "project")
    cli_store = RiskStateStore(root / "state")
    fn_store = RiskStateStore(base / "fresh")
    write_prior(cli_store, prior)
    write_prior(fn_store, prior)
    day_before = state_bytes(root / "state")["risk_day.json"]

    flags = [f for f, on in (("--clear-kill", clear_kill), ("--rebase-peak", rebase_peak)) if on]
    code, printed = run_reset_cli(root, *flags)
    steps: list[tuple[ResetStep, Decimal | None]] = []
    outcome = apply_owner_reset(
        fn_store,
        NOW,
        by=WHO,
        clear_kill=clear_kill,
        rebase_peak=rebase_peak,
        on_step=lambda step, value: steps.append((step, value)),
    )

    assert code == cli.EXIT_OK
    assert printed == [line_for(step, value) for step, value in steps]
    assert state_bytes(root / "state") == state_bytes(base / "fresh")
    # What the steps were, independently of the CLI.
    day = prior["day"]
    rebased = day.last_equity if rebase_peak and isinstance(day, DayState) and day.last_equity > 0 else None
    expected_steps: list[tuple[ResetStep, Decimal | None]] = [("halt_cleared", None)]
    if clear_kill:
        expected_steps.append(("kill_cleared", None))
    if rebased is not None:
        expected_steps.append(("peak_rebased", rebased))
    assert steps == expected_steps
    assert outcome == ResetOutcome(kill_cleared=clear_kill, peak_rebased_to=rebased)
    assert not fn_store.read_halt().active
    assert fn_store.read_kill().active is (bool(prior["kill"]) and not clear_kill)
    assert fn_store.read_peak() == (rebased if rebased is not None else prior["peak"])
    assert state_bytes(root / "state")["risk_day.json"] == day_before, "day state is never touched"


def m1_reset_halt(
    store: RiskStateStore, now: datetime, who: str, *, clear_kill: bool, rebase_peak: bool
) -> list[str]:
    """The store steps and printed lines of ``cmd_reset_halt`` before M3, verbatim: the oracle.

    The CLI now calls ``apply_owner_reset`` itself, so comparing the CLI with the function
    can't see a change both share; this copy of the old statements can.
    """
    lines: list[str] = []
    store.clear_halt(now, by=who)
    lines.append("Halt cleared.")
    if clear_kill:
        store.clear_kill(now, by=who)
        lines.append("KILL switch cleared.")
    if rebase_peak:
        day = store.read_day()
        if day and day.last_equity > 0:
            store.write_peak(day.last_equity)
            lines.append(f"Peak equity reset to the last seen equity EUR {day.last_equity:,.2f}.")
    return lines


@settings(max_examples=120)
@given(prior=priors, clear_kill=st.booleans(), rebase_peak=st.booleans())
def test_the_shared_reset_does_exactly_what_the_old_command_did(
    tmp_path_factory: pytest.TempPathFactory, prior: dict[str, object], clear_kill: bool, rebase_peak: bool
) -> None:
    base = tmp_path_factory.mktemp("oracle")
    old_store = RiskStateStore(base / "old")
    new_store = RiskStateStore(base / "new")
    write_prior(old_store, prior)
    write_prior(new_store, prior)
    old_lines = m1_reset_halt(old_store, NOW, WHO, clear_kill=clear_kill, rebase_peak=rebase_peak)
    lines: list[str] = []
    apply_owner_reset(
        new_store,
        NOW,
        by=WHO,
        clear_kill=clear_kill,
        rebase_peak=rebase_peak,
        on_step=lambda step, value: lines.append(line_for(step, value)),
    )
    assert lines == old_lines
    assert state_bytes(base / "new") == state_bytes(base / "old"), "same files, same history lines"


class RecordingStore(RiskStateStore):
    """A real store that also records the order of the calls made on it."""

    def __init__(self, state_dir: Path, events: list[str]) -> None:
        super().__init__(state_dir)
        self.events = events

    def clear_halt(self, ts: datetime, by: str) -> None:
        self.events.append("clear_halt")
        super().clear_halt(ts, by)

    def clear_kill(self, ts: datetime, by: str) -> None:
        self.events.append("clear_kill")
        super().clear_kill(ts, by)

    def read_day(self) -> DayState | None:
        self.events.append("read_day")
        return super().read_day()

    def write_peak(self, peak: Decimal) -> None:
        self.events.append("write_peak")
        super().write_peak(peak)

    def write_day(self, state: DayState) -> None:
        self.events.append("write_day")
        super().write_day(state)


def test_each_step_is_reported_right_after_it_happens(tmp_path: Path) -> None:
    events: list[str] = []
    store = RecordingStore(tmp_path / "s", events)
    store.set_halt("drawdown 16% >= 15%", BEFORE)
    store.set_kill("manual", BEFORE)
    store.write_day(DayState(date(2026, 10, 12), Decimal("48.40"), Decimal("42.10"), {"total": 3}))
    store.write_peak(Decimal("50"))
    events.clear()
    outcome = apply_owner_reset(
        store,
        NOW,
        by=WHO,
        clear_kill=True,
        rebase_peak=True,
        on_step=lambda step, value: events.append(f"step:{step}:{value}"),
    )
    assert events == [
        "clear_halt",
        "step:halt_cleared:None",
        "clear_kill",
        "step:kill_cleared:None",
        "read_day",
        "write_peak",
        "step:peak_rebased:42.10",
    ]
    assert outcome == ResetOutcome(kill_cleared=True, peak_rebased_to=Decimal("42.10"))
    assert store.read_peak() == Decimal("42.10")
    day = store.read_day()
    assert day is not None and day.day_start_equity == Decimal("48.40") and day.trades == {"total": 3}


@pytest.mark.parametrize(
    ("day", "rebased"),
    [
        (None, None),
        (DayState(date(2026, 10, 12), Decimal(50), Decimal(0), {}), None),
        (DayState(date(2026, 10, 12), Decimal(50), Decimal("0.01"), {}), Decimal("0.01")),
    ],
)
def test_the_peak_is_rebased_only_to_a_positive_equity(
    tmp_path: Path, day: DayState | None, rebased: Decimal | None
) -> None:
    store = RiskStateStore(tmp_path / "s")
    store.write_peak(Decimal("80"))
    if day is not None:
        store.write_day(day)
    outcome = apply_owner_reset(store, NOW, by=WHO, clear_kill=False, rebase_peak=True)
    assert outcome.peak_rebased_to == rebased
    assert store.read_peak() == (rebased or Decimal("80"))


def test_without_on_step_and_without_flags_only_the_halt_is_cleared(tmp_path: Path) -> None:
    store = RiskStateStore(tmp_path / "s")
    store.set_halt("x", BEFORE)
    store.set_kill("y", BEFORE)
    store.write_day(DayState(date(2026, 10, 12), Decimal(50), Decimal(40), {}))
    store.write_peak(Decimal("50"))
    outcome = apply_owner_reset(store, NOW, by=WHO, clear_kill=False, rebase_peak=False)
    assert outcome == ResetOutcome(kill_cleared=False, peak_rebased_to=None)
    assert not store.read_halt().active
    assert store.read_kill().active
    assert store.read_peak() == Decimal("50")


# ------------------------------------------------------------------- a later step fails (C23)
@pytest.fixture
def halted_project(tmp_path: Path) -> Path:
    root = make_project(tmp_path / "project")
    store = RiskStateStore(root / "state")
    store.set_halt("drawdown 16% >= 15%", BEFORE)
    store.set_kill("manual", BEFORE)
    store.write_day(DayState(date(2026, 10, 12), Decimal("48.40"), Decimal("42.10"), {"total": 2}))
    store.write_peak(Decimal("50"))
    return root


def test_when_the_peak_write_fails_what_was_done_was_already_printed(
    halted_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def disk_full(self: RiskStateStore, peak: Decimal) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(RiskStateStore, "write_peak", disk_full)
    code, printed = run_reset_cli(halted_project, "--clear-kill", "--rebase-peak")
    assert code == cli.EXIT_ERROR
    assert printed == [
        "Halt cleared.",
        "KILL switch cleared.",
        "Unexpected error (nothing further was traded): OSError: disk full",
    ]
    monkeypatch.undo()
    store = RiskStateStore(halted_project / "state")
    assert not store.read_halt().active
    assert not store.read_kill().active
    assert store.read_peak() == Decimal("50")


def test_when_clearing_the_kill_flag_fails_the_halt_line_was_already_printed(
    halted_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def locked(self: RiskStateStore, ts: datetime, by: str) -> None:
        raise PermissionError("file is locked")

    monkeypatch.setattr(RiskStateStore, "clear_kill", locked)
    code, printed = run_reset_cli(halted_project, "--clear-kill")
    assert code == cli.EXIT_ERROR
    assert printed[0] == "Halt cleared."
    assert printed[1].startswith("Unexpected error") and "file is locked" in printed[1]
    assert len(printed) == 2
    monkeypatch.undo()
    store = RiskStateStore(halted_project / "state")
    assert not store.read_halt().active
    assert store.read_kill().active


def test_the_cli_prints_the_three_lines_in_order(halted_project: Path) -> None:
    code, printed = run_reset_cli(halted_project, "--clear-kill", "--rebase-peak")
    assert code == cli.EXIT_OK
    assert printed == [
        "Halt cleared.",
        "KILL switch cleared.",
        "Peak equity reset to the last seen equity EUR 42.10.",
    ]
    history = (halted_project / "state" / "state_history.jsonl").read_text(encoding="utf-8")
    assert f'"by": "{WHO}"' in history and NOW.isoformat() in history
