"""The live gate refuses unless EVERY condition holds, and M1 refuses live even then."""

from __future__ import annotations

import io
import shutil
from datetime import date, timedelta
from pathlib import Path

import pytest

from samsulek import cli
from samsulek.live_gate import LiveGateError, authorize_live, checklist_problems
from samsulek.risk.state import RiskStateStore
from samsulek.terminal import TerminalUnavailableError, confirm_phrase, require_interactive
from samsulek.types import Mode

ROOT = Path(__file__).resolve().parents[1]
TODAY = date(2026, 10, 12)


def signed_checklist(tmp_path: Path, signed: date = TODAY) -> Path:
    text = (ROOT / "ops" / "go_live_checklist.md").read_text(encoding="utf-8")
    text = text.replace("- [ ]", "- [x]").replace("Signed-off-by:", "Signed-off-by: Owner Name")
    text = text.replace("Date:", f"Date: {signed.isoformat()}")
    path = tmp_path / "checklist.md"
    path.write_text(text, encoding="utf-8")
    return path


def ok_tty() -> None:
    return None


def test_repo_checklist_is_not_signed_yet() -> None:
    problems = checklist_problems(ROOT / "ops" / "go_live_checklist.md", TODAY)
    assert any("not ticked" in p for p in problems)
    assert any("not signed" in p for p in problems)


def test_checklist_variants(tmp_path: Path) -> None:
    assert checklist_problems(signed_checklist(tmp_path), TODAY) == []
    old = signed_checklist(tmp_path, TODAY - timedelta(days=31))
    assert any("more than 30 days" in p for p in checklist_problems(old, TODAY))
    future = signed_checklist(tmp_path, TODAY + timedelta(days=1))
    assert any("in the future" in p for p in checklist_problems(future, TODAY))
    assert checklist_problems(tmp_path / "missing.md", TODAY) == [
        f"go-live checklist not found at {tmp_path / 'missing.md'}"
    ]


def test_gate_reports_all_problems_without_prompting(tmp_path: Path) -> None:
    prompted: list[str] = []

    def no_tty() -> None:
        raise TerminalUnavailableError("not a terminal")

    with pytest.raises(LiveGateError) as err:
        authorize_live(
            mode=Mode.SIM,
            environ={"LIVE": "TRUE"},
            checklist_path=ROOT / "ops" / "go_live_checklist.md",
            today=TODAY,
            interactive_check=no_tty,
            confirm=lambda p, e: prompted.append(e) or True,
        )
    text = "\n".join(err.value.problems)
    assert "mode is 'sim'" in text and "LIVE is not exactly 'true'" in text
    assert "not ticked" in text and "not a terminal" in text
    assert prompted == [], "never prompt while other conditions fail"


def test_gate_wrong_phrase_refused_and_right_phrase_passes(tmp_path: Path) -> None:
    kwargs = {
        "mode": Mode.LIVE,
        "environ": {"LIVE": "true"},
        "checklist_path": signed_checklist(tmp_path),
        "today": TODAY,
        "interactive_check": ok_tty,
        "code": lambda: "123456",
    }
    with pytest.raises(LiveGateError, match="did not match"):
        authorize_live(**kwargs, confirm=lambda p, e: False)  # type: ignore[arg-type]
    seen: list[str] = []
    authorize_live(**kwargs, confirm=lambda p, e: seen.append(e) or True)  # type: ignore[arg-type]
    assert seen == ["I ACCEPT REAL MONEY RISK 123456"]


def test_terminal_helpers() -> None:
    with pytest.raises(TerminalUnavailableError):
        require_interactive(io.StringIO(), io.StringIO())

    def opener(answer: str):  # type: ignore[no-untyped-def]
        return lambda: (io.StringIO(answer), io.StringIO())

    assert confirm_phrase("p", "RESET 000001", opener("RESET 000001\n"))
    assert not confirm_phrase("p", "RESET 000001", opener("reset 000001\n"))


# ------------------------------------------------------------------------- CLI
@pytest.fixture
def root(tmp_path: Path) -> Path:
    shutil.copytree(ROOT / "config", tmp_path / "config")
    shutil.copytree(ROOT / "ops", tmp_path / "ops")
    return tmp_path


def run_cli(root: Path, *args: str) -> int:
    return cli.main(["--root", str(root), *args])


def test_cli_live_refused_by_gate(
    root: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("LIVE", "true")
    assert run_cli(root, "run", "--mode", "live") == cli.EXIT_REFUSED
    assert "live trading refused" in capsys.readouterr().out
    assert not (root / "state" / "sim_broker.json").exists(), "nothing ran"


def test_cli_live_refused_even_if_gate_passes(
    root: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(cli, "authorize_live", lambda **kw: None)
    assert run_cli(root, "run", "--mode", "live") == cli.EXIT_REFUSED
    assert "does not exist yet" in capsys.readouterr().out


def test_cli_paper_not_available_yet(root: Path) -> None:
    assert run_cli(root, "run", "--mode", "paper") == cli.EXIT_REFUSED


def test_cli_sim_run_status_kill(root: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert run_cli(root, "check-config") == cli.EXIT_OK
    assert run_cli(root, "run") == cli.EXIT_OK
    assert run_cli(root, "status") == cli.EXIT_OK
    assert run_cli(root, "reconcile") == cli.EXIT_OK
    assert run_cli(root, "kill", "--flatten", "--reason", "cli test") == cli.EXIT_OK
    assert run_cli(root, "status") == cli.EXIT_HALTED
    assert run_cli(root, "run") == cli.EXIT_HALTED
    out = capsys.readouterr().out
    assert out.isascii(), "Windows consoles need plain ASCII"


def test_cli_reset_halt_needs_a_real_terminal(root: Path) -> None:
    store = RiskStateStore(root / "state")
    from helpers import T0

    store.set_halt("test", T0)
    assert run_cli(root, "reset-halt") == cli.EXIT_REFUSED  # pytest's stdin is not a TTY
    assert store.read_halt().active


def test_cli_config_error_is_reported(root: Path, capsys: pytest.CaptureFixture[str]) -> None:
    risk = root / "config" / "risk.yaml"
    risk.write_text(risk.read_text(encoding="utf-8") + "\nsurprise: 1\n", encoding="utf-8")
    assert run_cli(root, "check-config") == cli.EXIT_ERROR
    assert "Configuration error" in capsys.readouterr().out
