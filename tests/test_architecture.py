"""Structural rules that keep the risk engine un-bypassable. These scan the source code itself."""

from __future__ import annotations

import ast
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src" / "samsulek"

# Research-side code (strategies, signals, data) may never reach execution machinery.
RESEARCH_DIRS = ["strategies", "signals", "data"]
FORBIDDEN_FOR_RESEARCH = (
    "samsulek.execution",
    "samsulek.risk",
    "samsulek.portfolio",
    "samsulek.kill",
    "samsulek.cycle",
    "samsulek.app",
    "samsulek.cli",
    "samsulek.live_gate",
    "samsulek.credentials",
)


def modules() -> list[Path]:
    return sorted(SRC.rglob("*.py"))


def imported_names(tree: ast.AST) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module)
    return names


def test_research_code_cannot_import_execution_machinery() -> None:
    for d in RESEARCH_DIRS:
        for path in (SRC / d).rglob("*.py") if (SRC / d).exists() else []:
            bad = {
                n
                for n in imported_names(ast.parse(path.read_text(encoding="utf-8")))
                if n.startswith(FORBIDDEN_FOR_RESEARCH)
            }
            assert not bad, f"{path.relative_to(SRC)} imports {sorted(bad)}"


def test_only_the_router_sends_orders() -> None:
    allowed = {SRC / "execution" / "router.py"}
    for path in modules():
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "place_order"
            ):
                assert path in allowed, f"{path.relative_to(SRC)}:{node.lineno} calls place_order directly"


def test_router_evaluates_risk_before_sending() -> None:
    src = (SRC / "execution" / "router.py").read_text(encoding="utf-8")
    assert src.index("self._risk.evaluate(") < src.index("self._broker.place_order(")


def test_environment_is_read_only_by_credentials_and_cli() -> None:
    allowed = {SRC / "credentials.py", SRC / "cli.py"}
    for path in modules():
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and node.attr in {"environ", "getenv"}:
                assert path in allowed, f"{path.relative_to(SRC)}:{node.lineno} reads the environment"


def test_no_print_calls_in_library_code() -> None:
    """Output goes through logging (redacted) or the CLI's ASCII writer, never bare print()."""
    for path in modules():
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "print":
                raise AssertionError(f"{path.relative_to(SRC)}:{node.lineno} uses print()")
