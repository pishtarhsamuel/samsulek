"""Tests for the Claude Code PreToolUse guardrail hook (.claude/hooks/guard.py).

Runs the hook as a subprocess exactly as Claude Code does (JSON on stdin), so
these tests also prove the script starts and fails closed. Stdlib only:

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

HOOK = Path(__file__).resolve().parents[1] / ".claude" / "hooks" / "guard.py"


def run_hook(raw_stdin: str) -> str | None:
    proc = subprocess.run(
        [sys.executable, str(HOOK)],
        input=raw_stdin,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    if not proc.stdout.strip():
        return None
    out = json.loads(proc.stdout)
    hso = out["hookSpecificOutput"]
    assert hso["hookEventName"] == "PreToolUse"
    assert hso["permissionDecisionReason"]
    decision: str = hso["permissionDecision"]
    assert decision in ("deny", "ask"), "hook must never auto-allow"
    return decision


def decide(tool: str, **tool_input: object) -> str | None:
    return run_hook(json.dumps({"tool_name": tool, "tool_input": tool_input}))


class LiveModeIsBlocked(unittest.TestCase):
    def test_live_mode_commands_denied(self) -> None:
        for cmd in [
            "LIVE=true samsulek run",
            "LIVE=1 python -m samsulek run",
            "SAMSULEK_LIVE=yes samsulek run",
            "export LIVE=true",
            "export LIVE",
            "samsulek run --live",
            "samsulek run --mode live",
            "samsulek run --mode=live",
            'python -m samsulek run --mode "live"',
            '$env:LIVE="true"; samsulek run',
            "setx LIVE true",
            "L\\IVE=true samsulek run",
            "samsulek run --li''ve",
            "sed -i 's/mode: paper/mode: live/' config/default.yaml",
        ]:
            with self.subTest(cmd=cmd):
                self.assertEqual(decide("Bash", command=cmd), "deny")

    def test_paper_mode_and_lookalikes_allowed(self) -> None:
        for cmd in [
            "samsulek run --mode paper",
            "samsulek kill --flatten",
            "samsulek status",
            "python3 -m pytest -q",
            "grep -n LIVE CLAUDE.md",
            "echo is alive=1",
            "samsulek report --liveness-check",
            "git status && git diff",
        ]:
            with self.subTest(cmd=cmd):
                self.assertIsNone(decide("Bash", command=cmd))


class SecretsAreBlocked(unittest.TestCase):
    def test_env_file_shell_access_denied(self) -> None:
        for cmd in [
            "cat .env",
            "cat ./.env",
            "less config/../.env.local",
            "source .env && samsulek run --mode paper",
            "grep TOKEN .env",
            "cp .env /tmp/x",
            "python3 -c \"print(open('.env').read())\"",
            "cat .e*",
            "head -n 3 /home/me/samsulek/.env.production",
        ]:
            with self.subTest(cmd=cmd):
                self.assertEqual(decide("Bash", command=cmd), "deny")

    def test_env_dumps_denied(self) -> None:
        for cmd in [
            "printenv",
            "printenv T212_API_KEY",
            "env",
            "env | grep KEY",
            "set",
            "export -p",
            "echo $T212_API_SECRET",
            "echo ${TELEGRAM_BOT_TOKEN}",
            "cat /proc/self/environ",
            "python3 -c 'import os; print(os.environ)'",
            "Get-ChildItem env:",
        ]:
            with self.subTest(cmd=cmd):
                self.assertEqual(decide("Bash", command=cmd), "deny")

    def test_gitignore_bypassing_search_denied(self) -> None:
        for cmd in [
            "grep -r API_KEY .",
            "grep -Rn secret",
            "rg --no-ignore TOKEN",
            "rg -uu KEY",
            "rg --hidden x",
        ]:
            with self.subTest(cmd=cmd):
                self.assertEqual(decide("Bash", command=cmd), "deny")

    def test_wallet_and_funds_denied(self) -> None:
        for cmd in [
            "solana transfer 9xyz 1",
            "spl-token transfer MINT 10 DEST",
            "solana-keygen new",
            "cat ~/.config/solana/id.json",
            "cat wallet-keypair.json",
        ]:
            with self.subTest(cmd=cmd):
                self.assertEqual(decide("Bash", command=cmd), "deny")

    def test_harmless_lookalikes_allowed(self) -> None:
        for cmd in [
            "source .venv/bin/activate",
            "cat env.example",
            "ls -la",
            "env PYTHONHASHSEED=0 python3 -m pytest",
            "rg TOKEN src/",
            "grep -n foo src/samsulek/config.py",
        ]:
            with self.subTest(cmd=cmd):
                self.assertIsNone(decide("Bash", command=cmd))

    def test_file_tools_on_secrets_denied(self) -> None:
        cases = [
            ("Read", {"file_path": ".env"}),
            ("Read", {"file_path": "/home/me/samsulek/.env.production"}),
            ("Read", {"file_path": "C:\\Users\\me\\samsulek\\.env"}),
            ("Edit", {"file_path": ".env", "old_string": "a", "new_string": "b"}),
            ("Write", {"file_path": ".env.live", "content": "LIVE=true"}),
            ("Read", {"file_path": "/home/me/.config/solana/id.json"}),
            ("Read", {"file_path": "wallets/bot-keypair.json"}),
            ("Grep", {"pattern": "KEY", "path": ".env"}),
            ("Grep", {"pattern": "KEY", "glob": ".env*"}),
            ("Glob", {"pattern": "**/.env*"}),
        ]
        for tool, tool_input in cases:
            with self.subTest(tool=tool, tool_input=tool_input):
                self.assertEqual(decide(tool, **tool_input), "deny")

    def test_file_tools_on_normal_files_allowed(self) -> None:
        cases = [
            ("Read", {"file_path": "env.example"}),
            ("Read", {"file_path": ".envrc"}),
            ("Read", {"file_path": ".venv/lib/python3.12/site.py"}),
            ("Edit", {"file_path": "CLAUDE.md", "old_string": "a", "new_string": "b"}),
            ("Grep", {"pattern": "\\.env", "path": "src"}),
            ("Glob", {"pattern": "src/**/*.py"}),
            ("Read", {"file_path": ".claude/hooks/guard.py"}),
        ]
        for tool, tool_input in cases:
            with self.subTest(tool=tool, tool_input=tool_input):
                self.assertIsNone(decide(tool, **tool_input))


class GuardrailEditsNeedOwnerApproval(unittest.TestCase):
    def test_file_tool_edits_ask(self) -> None:
        for path in [
            ".claude/settings.json",
            ".claude/settings.local.json",
            "/home/me/samsulek/.claude/hooks/guard.py",
            "config/risk.yaml",
            "ops/go_live_checklist.md",
        ]:
            for tool in ("Edit", "Write"):
                with self.subTest(tool=tool, path=path):
                    self.assertEqual(decide(tool, file_path=path, content="x"), "ask")

    def test_shell_edits_ask(self) -> None:
        for cmd in [
            "rm .claude/hooks/guard.py",
            "sed -i 's/deny/allow/' .claude/settings.json",
            "echo '{}' > .claude/settings.local.json",
            "git checkout -- config/risk.yaml",
            "claude config set disableAllHooks true",
        ]:
            with self.subTest(cmd=cmd):
                self.assertEqual(decide("Bash", command=cmd), "ask")

    def test_reading_guardrails_allowed(self) -> None:
        for cmd in ["cat .claude/settings.json", "head config/risk.yaml", "git diff .claude/"]:
            with self.subTest(cmd=cmd):
                self.assertIsNone(decide("Bash", command=cmd))


class OwnerOnlyActionsAndBotState(unittest.TestCase):
    def test_halt_reset_and_kill_clear_denied(self) -> None:
        for cmd in ["uv run samsulek reset-halt", "samsulek reset-halt --clear-kill", "x --clear-kill"]:
            with self.subTest(cmd=cmd):
                self.assertEqual(decide("Bash", command=cmd), "deny")

    def test_state_tampering_denied(self) -> None:
        for cmd in [
            "rm -rf state/",
            "rm -rf state",
            "rm state/halt.json",
            "echo {} > state/halt.json",
            "Remove-Item state\\kill.json",
            "del state\\halt.json",
            "python3 -c \"open('state/halt.json','w')\"",
            "mv state/kill.json /tmp/",
            "git clean -fdx",
            "git clean -xfd",
        ]:
            with self.subTest(cmd=cmd):
                self.assertEqual(decide("Bash", command=cmd), "deny")
        for path in ["state/halt.json", "C:\\Users\\me\\samsulek\\state\\kill.json", "/x/state/ledger.json"]:
            for tool in ("Write", "Edit"):
                with self.subTest(tool=tool, path=path):
                    self.assertEqual(decide(tool, file_path=path, content="{}"), "deny")

    def test_reading_state_and_normal_work_allowed(self) -> None:
        for cmd in [
            "cat state/halt.json",
            "ls state",
            "uv run samsulek status",
            "uv run samsulek kill --flatten",
            "git commit -F /tmp/commit_message.txt",  # messages go in a file: words in them can't trip rules
            "uv run pytest -q",
            "git clean -n",
        ]:
            with self.subTest(cmd=cmd):
                self.assertIsNone(decide("Bash", command=cmd))
        self.assertIsNone(decide("Read", file_path="state/halt.json"))
        self.assertIsNone(
            decide("Edit", file_path="src/samsulek/risk/state.py", old_string="a", new_string="b")
        )


class WindowsSpellings(unittest.TestCase):
    def test_powershell_and_cmd_secret_reads_denied(self) -> None:
        for cmd in [
            "echo $env:T212_API_KEY",
            "Write-Output $env:TELEGRAM_BOT_TOKEN",
            "[Environment]::GetEnvironmentVariable('T212_API_SECRET')",
            "[System.Environment]::GetEnvironmentVariables()",
            "gc env:T212_API_KEY",
            "Get-Item env:SECRET_X",
            "echo %T212_API_SECRET%",
            "Get-Content .env",
            "type .env",
            "Select-String -Path * -Pattern KEY -Recurse",
            "findstr /s KEY *",
        ]:
            with self.subTest(cmd=cmd):
                self.assertEqual(decide("PowerShell", command=cmd), "deny")

    def test_powershell_guardrail_edits_ask(self) -> None:
        for cmd in ["Remove-Item .claude\\hooks\\guard.py", "Set-Content config\\risk.yaml x"]:
            with self.subTest(cmd=cmd):
                self.assertEqual(decide("PowerShell", command=cmd), "ask")


class ReviewBypassesAreClosed(unittest.TestCase):
    """Every bypass found by the M1 adversarial review must now be blocked."""

    def test_env_file_globs_case_and_streams_denied(self) -> None:
        for cmd in [
            "cat .env*",
            "head -n 5 .env?",
            "cat .[e]nv",
            "cat .*",
            "cat {.env,}",
            "type .ENV",
            "Get-Content .ENV",
            "Get-Content .Env.local",
            "Get-Content .E*",
            "Get-Content .env::$DATA",
            "type .env.",
            "Get-Content -Path .\\.env",
        ]:
            with self.subTest(cmd=cmd):
                self.assertEqual(decide("PowerShell", command=cmd), "deny")
        for path in [
            "C:\\Users\\me\\samsulek\\.env::$DATA",
            "C:\\x\\.ENV",
            "/x/.env. ",
            "/proc/self/environ",
        ]:
            with self.subTest(path=path):
                self.assertEqual(decide("Read", file_path=path), "deny")

    def test_state_bypasses_denied(self) -> None:
        for cmd in [
            "cd state && rm halt.json kill.json",
            "rm halt.json",
            "rm -rf /home/user/samsulek/state",
            'rm -rf "$PWD/state"',
            "Remove-Item -Recurse -Force C:\\Users\\me\\samsulek\\state",
            "Remove-Item -Recurse -Force C:\\Users\\me\\samsulek\\State",
            "git stash --all",
            "git stash -a",
            "find . -name halt.json -delete",
            'uv run python -c "from samsulek.risk.state import RiskStateStore"',
            "python -c 'store.clear_halt(now, \"x\")'",
        ]:
            with self.subTest(cmd=cmd):
                self.assertEqual(decide("Bash", command=cmd), "deny")
        for path in ["C:\\Users\\me\\samsulek\\State\\halt.json", "/x/STATE/kill.json", "state./halt.json"]:
            with self.subTest(path=path):
                self.assertEqual(decide("Write", file_path=path, content="{}"), "deny")

    def test_mixed_case_guardrail_paths_ask(self) -> None:
        for path in ["C:\\x\\Config\\Risk.yaml", "C:\\x\\.Claude\\Settings.json", "OPS/go_live_checklist.md"]:
            with self.subTest(path=path):
                self.assertEqual(decide("Edit", file_path=path, old_string="a", new_string="b"), "ask")
        for cmd in ["Set-Content Config\\Risk.yaml x", "Remove-Item .claude\\Hooks\\guard.py"]:
            with self.subTest(cmd=cmd):
                self.assertEqual(decide("PowerShell", command=cmd), "ask")

    def test_live_variants_denied(self) -> None:
        for cmd in [
            "uv run samsulek run --m live",
            "uv run samsulek run --mo live",
            "uv run samsulek run --mod=live",
            "LIVE=$(echo true) uv run samsulek run",
            "${env:LIVE}='true'; uv run samsulek run",
            "Set-Item -Path Env:LIVE -Value true",
            "New-Item -Path Env:LIVE -Value true",
            "reg add HKCU\\Environment /v LIVE /d true /f",
            "[Environment]::SetEnvironmentVariable('LIVE','true','User')",
        ]:
            with self.subTest(cmd=cmd):
                self.assertEqual(decide("PowerShell", command=cmd), "deny")

    def test_env_dump_variants_denied(self) -> None:
        for cmd in [
            "export",
            "declare -p",
            "typeset -p",
            "env -0",
            "env -u PATH",
            "/usr/bin/env",
            "Get-ChildItem -Path Env:",
            "gci -Path env:",
            "echo ${env:T212_DEMO_API_KEY}",
            "v=T212_DEMO_API_KEY; echo ${!v}",
            "node -e 'console.log(process.env)'",
            "perl -e 'print %ENV'",
            "ruby -e 'p ENV'",
            "python3 -c 'from os import environ; print(environ)'",
            "python3 -c 'import os; print(os.environb)'",
        ]:
            with self.subTest(cmd=cmd):
                self.assertEqual(decide("Bash", command=cmd), "deny")

    def test_monitor_tool_is_guarded(self) -> None:
        self.assertEqual(decide("Monitor", command="cat .env"), "deny")
        self.assertEqual(decide("Monitor", command="samsulek run --mode live"), "deny")

    def test_ordinary_development_still_allowed(self) -> None:
        for cmd in [
            "uv run pytest -q",
            "uv run pytest tests/test_risk_engine.py -q 2>&1 | tail -5",
            "git add src/samsulek/risk/state.py",
            "uv run ruff check src tests",
            "uv run samsulek run",
            "uv run samsulek kill --flatten",
            "env PYTHONHASHSEED=0 uv run pytest",
            "cat README.md",
            "ls -la",
            "git log --oneline -5",
            "source .venv/bin/activate",
        ]:
            with self.subTest(cmd=cmd):
                self.assertIsNone(decide("Bash", command=cmd))

    def test_utf8_payload_with_greek_text_is_not_denied(self) -> None:
        payload = json.dumps(
            {
                "tool_name": "Write",
                "tool_input": {"file_path": "docs/el.md", "content": "Ρυθμίσεις κινδύνου ✓"},
            },
            ensure_ascii=False,
        ).encode("utf-8")
        proc = subprocess.run(
            [sys.executable, str(HOOK)], input=payload, capture_output=True, timeout=10, check=False
        )
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.strip(), b"")


def find_bash() -> str | None:
    """The bash Claude Code uses: Git Bash on Windows (never WSL's System32\\bash.exe)."""
    if os.name == "nt":
        git = shutil.which("git")
        if git is None:
            return None
        for candidate in (
            Path(git).resolve().parents[1] / "bin" / "bash.exe",
            Path(git).resolve().parents[1] / "usr" / "bin" / "bash.exe",
        ):
            if candidate.exists():
                return str(candidate)
        return None
    return shutil.which("bash")


class Launcher(unittest.TestCase):
    def test_run_guard_launcher_finds_python_and_blocks(self) -> None:
        bash = find_bash()
        if bash is None:
            self.fail("bash not found: on Windows install Git for Windows (it provides Git Bash)")
        payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": "printenv"}})
        proc = subprocess.run(
            [bash, str(HOOK.parent / "run-guard.sh")],
            input=payload,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["hookSpecificOutput"]["permissionDecision"], "deny")


class FailsClosed(unittest.TestCase):
    def test_garbage_input_denied(self) -> None:
        self.assertEqual(run_hook("not json"), "deny")
        self.assertEqual(run_hook("[1, 2]"), "deny")
        self.assertEqual(run_hook(json.dumps({"tool_name": "Bash", "tool_input": "oops"})), "deny")

    def test_unrelated_tools_no_opinion(self) -> None:
        self.assertIsNone(decide("WebSearch", query="UCITS ETF list"))
        self.assertIsNone(run_hook("{}"))


if __name__ == "__main__":
    unittest.main()
