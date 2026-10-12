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


def module_name(path: Path) -> str:
    rel = path.relative_to(SRC).with_suffix("")
    parts = [p for p in rel.parts if p != "__init__"]
    return ".".join(["samsulek", *parts])


def imported_names(tree: ast.AST, path: Path) -> set[str]:
    """Fully-qualified names a module imports, resolving relative imports and `from x import y`."""
    package = module_name(path) if path.name == "__init__.py" else module_name(path).rsplit(".", 1)[0]
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base_parts = package.split(".")
                base_parts = base_parts[: len(base_parts) - (node.level - 1)]
                base = ".".join(base_parts + ([node.module] if node.module else []))
            else:
                base = node.module or ""
            names.add(base)
            names.update(f"{base}.{a.name}" for a in node.names)
        elif (
            isinstance(node, ast.Call)
            and isinstance(node.func, (ast.Name, ast.Attribute))
            and (
                getattr(node.func, "id", None) == "__import__"
                or getattr(node.func, "attr", None) == "import_module"
            )
        ):
            names.add("<dynamic import>")
    return names


def is_forbidden(name: str) -> bool:
    return name == "<dynamic import>" or any(
        name == f or name.startswith(f + ".") for f in FORBIDDEN_FOR_RESEARCH
    )


def test_import_resolver_catches_tricky_forms(tmp_path: Path) -> None:
    fake = SRC / "strategies" / "x.py"
    for src in [
        "from ..execution import router",
        "from .. import execution",
        "from samsulek import execution",
        "import samsulek.risk.engine",
        "import importlib; importlib.import_module('samsulek.execution.router')",
    ]:
        names = imported_names(ast.parse(src), fake)
        assert any(is_forbidden(n) for n in names), src


def test_research_code_cannot_import_execution_machinery() -> None:
    for d in RESEARCH_DIRS:
        for path in (SRC / d).rglob("*.py") if (SRC / d).exists() else []:
            bad = {
                n
                for n in imported_names(ast.parse(path.read_text(encoding="utf-8")), path)
                if is_forbidden(n)
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
