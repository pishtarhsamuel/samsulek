"""M3 architecture rules A1-A12 (spec section 9.4): structure the backtester's guarantees rest on.

Each rule is a function ``rule(src) -> list of violations`` over ONE parsed source file;
the rule decides from the file's path whether it applies. ``test_<rule>_holds_on_src``
runs it over every file under src/samsulek; ``test_<rule>_self_test`` feeds it planted
violating sources (each must be flagged, for the right reason) and planted clean ones
(must pass), so a rule can never pass just because the files it guards are still empty.
``test_rules_catch_plants_in_real_files`` appends violations to the REAL modules, so a
rule cannot be fooled by what else a real file contains.

Names are resolved like tests/test_architecture.py does (relative imports, ``from x
import y``, ``__import__``/``import_module``), plus: dotted references through import
aliases (``import datetime as dt; dt.datetime.now``); re-exports through other src
modules (``from samsulek.cycle import App`` reaches ``samsulek.app``); ``getattr(module,
"name")``, ``operator.attrgetter``/``methodcaller`` and ``__getattribute__`` with literal
names; dotted ``"samsulek.x"`` strings and ``sys.modules`` (a dynamic import). Where a rule
says "calls", aliases that would dodge it (``f = open; f(...)``, ``S = RiskStateStore``)
are caught too. Deliberate obfuscation with COMPUTED names (``getattr(m, "n" + "ow")``)
is out of reach of a static check; CLAUDE.md forbids working around a rule.
"""

from __future__ import annotations

import ast
import re
import textwrap
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src" / "samsulek"
DYNAMIC = "<dynamic import>"
IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
MODULE_PATH = re.compile(r"samsulek(?:\.[A-Za-z_][A-Za-z0-9_]*)+")


# =============================================================================== source model
@dataclass(frozen=True)
class Source:
    rel: str  # posix path under src/samsulek, e.g. "backtest/runner.py"
    text: str
    tree: ast.Module

    @property
    def module(self) -> str:
        parts = [p for p in self.rel.removesuffix(".py").split("/") if p != "__init__"]
        return ".".join(["samsulek", *parts])

    @property
    def package(self) -> str:
        return self.module if self.rel.endswith("__init__.py") else self.module.rsplit(".", 1)[0]


def parse(rel: str, text: str) -> Source:
    text = textwrap.dedent(text)
    return Source(rel=rel, text=text, tree=ast.parse(text))


def src_files() -> list[Source]:
    return [
        parse(p.relative_to(SRC).as_posix(), p.read_text(encoding="utf-8")) for p in sorted(SRC.rglob("*.py"))
    ]


SOURCES = src_files()


def in_dir(rel: str, *dirs: str) -> bool:
    return any(rel.startswith(d + "/") for d in dirs)


def under(name: str, *prefixes: str) -> bool:
    return any(name == p or name.startswith(p + ".") for p in prefixes)


def where(src: Source, node: ast.AST) -> str:
    return f"{src.rel}:{getattr(node, 'lineno', 0)}"


def resolve_from(src: Source, node: ast.ImportFrom) -> str:
    if not node.level:
        return node.module or ""
    parts = src.package.split(".")
    parts = parts[: len(parts) - (node.level - 1)]
    return ".".join(parts + ([node.module] if node.module else []))


def bindings(src: Source) -> dict[str, str]:
    """Local name -> the dotted name an import bound it to (flow-insensitive)."""
    out: dict[str, str] = {}
    for node in ast.walk(src.tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if a.asname:
                    out[a.asname] = a.name
                else:
                    top = a.name.split(".")[0]
                    out[top] = top
        elif isinstance(node, ast.ImportFrom):
            base = resolve_from(src, node)
            for a in node.names:
                if a.name != "*":
                    out[a.asname or a.name] = f"{base}.{a.name}"
    return out


def qualname(node: ast.AST, binds: dict[str, str]) -> str | None:
    if isinstance(node, ast.Name):
        return binds.get(node.id, node.id)
    if isinstance(node, ast.Attribute):
        base = qualname(node.value, binds)
        return f"{base}.{node.attr}" if base else None
    return None


def last_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def top_level_imports(src: Source) -> dict[str, str]:
    """What ``from <this module> import name`` would get, for every name it imports at top level."""
    out: dict[str, str] = {}

    def scan(body: list[ast.stmt]) -> None:
        for stmt in body:
            if isinstance(stmt, ast.Import):
                for a in stmt.names:
                    out[a.asname or a.name.split(".")[0]] = a.name if a.asname else a.name.split(".")[0]
            elif isinstance(stmt, ast.ImportFrom):
                base = resolve_from(src, stmt)
                out.update({a.asname or a.name: f"{base}.{a.name}" for a in stmt.names if a.name != "*"})
            elif isinstance(stmt, ast.If):
                scan(stmt.body + stmt.orelse)
            elif isinstance(stmt, ast.Try | ast.TryStar):
                scan(stmt.body + [s for h in stmt.handlers for s in h.body] + stmt.orelse + stmt.finalbody)

    scan(src.tree.body)
    return out


# module -> {name it imported: where the name really lives}
REEXPORTS: dict[str, dict[str, str]] = {src.module: top_level_imports(src) for src in SOURCES}


def reexported(name: str) -> str:
    """Follow re-exports through src modules: ``samsulek.cycle.App`` -> ``samsulek.app.App``."""
    for _ in range(10):
        parts = name.split(".")
        for i in range(len(parts) - 1, 0, -1):
            target = REEXPORTS.get(".".join(parts[:i]), {}).get(parts[i])
            if target is not None:
                name = ".".join([target, *parts[i + 1 :]])
                break
        else:
            return name
    return name


def _literal(node: ast.AST) -> str | None:
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


def attr_name_args(node: ast.Call) -> list[tuple[ast.expr | None, str]]:
    """(object or None, attribute name) for attribute access by a literal name in this call:
    ``getattr(x, "n")`` (and has/set/delattr), ``operator.attrgetter("a.n")``,
    ``operator.methodcaller("n")``, ``x.__getattribute__("n")``, ``object.__setattr__(x, "n", v)``."""
    f = node.func
    fname = last_name(f)
    out: list[tuple[ast.expr | None, str]] = []
    if fname in {"getattr", "hasattr", "setattr", "delattr"} and len(node.args) >= 2:
        name = _literal(node.args[1])
        if name is not None:
            out.append((node.args[0], name))
    elif fname == "attrgetter":
        out.extend((None, part) for a in node.args if (s := _literal(a)) is not None for part in s.split("."))
    elif fname == "methodcaller" and node.args:
        name = _literal(node.args[0])
        if name is not None:
            out.append((None, name))
    elif fname in {"__getattribute__", "__getattr__", "__setattr__", "__delattr__"} and isinstance(
        f, ast.Attribute
    ):
        first = _literal(node.args[0]) if node.args else None
        second = _literal(node.args[1]) if len(node.args) >= 2 else None
        if first is not None:
            out.append((f.value, first))  # x.__getattribute__("n")
        elif second is not None:
            out.append((node.args[0], second))  # object.__getattribute__(x, "n")
    return out


def getattr_names(src: Source) -> Iterator[tuple[ast.Call, ast.expr | None, str]]:
    for node in ast.walk(src.tree):
        if isinstance(node, ast.Call):
            for target, name in attr_name_args(node):
                yield node, target, name


DYNAMIC_IMPORT_NAMES = frozenset(
    {
        "__import__",
        "import_module",
        "module_from_spec",
        "spec_from_file_location",
        "exec_module",
        "load_module",
        "run_module",
        "run_path",
    }
)


def module_refs(src: Source) -> Iterator[tuple[ast.AST, str]]:
    """Every module-level name the file reaches: imports, dotted references (also through
    re-exports), getattr by literal name, dotted module strings, dynamic imports."""
    binds = bindings(src)
    docstrings = docstring_nodes(src.tree)
    for node in ast.walk(src.tree):
        names: list[str] = []
        if isinstance(node, ast.Import):
            names = [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom):
            base = resolve_from(src, node)
            names = [base if a.name == "*" else f"{base}.{a.name}" for a in node.names]
        elif isinstance(node, ast.Name | ast.Attribute):
            q = qualname(node, binds)
            if q is not None:
                names = [q]
                if q.rsplit(".", 1)[-1] in DYNAMIC_IMPORT_NAMES or q == "sys.modules":
                    names.append(DYNAMIC)
        elif isinstance(node, ast.Call):
            for target, attr in attr_name_args(node):
                base = qualname(target, binds) if target is not None else None
                if base is not None:
                    names.append(f"{base}.{attr}")
        elif (
            _literal(node) is not None
            and id(node) not in docstrings
            and MODULE_PATH.fullmatch(str(_literal(node)))
        ):
            names = [str(_literal(node))]
        for name in names:
            yield node, name
            again = reexported(name) if name != DYNAMIC else name
            if again != name:
                yield node, again


def calls(src: Source) -> Iterator[tuple[ast.Call, str]]:
    """(call, last name of the called thing), e.g. ``x.y.submit(...)`` -> "submit"."""
    for node in ast.walk(src.tree):
        if isinstance(node, ast.Call):
            name = last_name(node.func)
            if name is not None:
                yield node, name


def docstring_nodes(tree: ast.Module) -> set[int]:
    out: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Module | ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef):
            body = node.body
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                out.add(id(body[0].value))
    return out


def _params(fn: ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda) -> list[str]:
    a = fn.args
    return [p.arg for p in (*a.posonlyargs, *a.args, *a.kwonlyargs, a.vararg, a.kwarg) if p is not None]


IMPLICIT_CLASSMETHODS = frozenset({"__new__", "__init_subclass__", "__class_getitem__"})


def receivers(tree: ast.Module) -> dict[int, dict[str, str]]:
    """Node id -> {name: "instance" | "class"}: what means "my own instance" (the first
    parameter of a plain method) or "my own class" (of a classmethod) at that node.
    Closures inside a method inherit it unless they rebind the name; a module-level
    function whose first parameter happens to be called ``self`` gets nothing."""
    out: dict[int, dict[str, str]] = {}

    def visit(node: ast.AST, inherited: dict[str, str], in_class_body: bool) -> None:
        out[id(node)] = inherited
        if isinstance(node, ast.ClassDef):
            body = {id(s) for s in node.body}
            for child in ast.iter_child_nodes(node):
                in_body = id(child) in body
                visit(child, {} if in_body else inherited, in_body)
            return
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda):
            inner = {k: v for k, v in inherited.items() if k not in _params(node)}
            if in_class_body and not isinstance(node, ast.Lambda):
                decorators = {last_name(d) for d in node.decorator_list}
                first = [*node.args.posonlyargs, *node.args.args][:1]
                if first and "staticmethod" not in decorators:
                    is_cls = "classmethod" in decorators or node.name in IMPLICIT_CLASSMETHODS
                    inner = {first[0].arg: "class" if is_cls else "instance"}
            body = {id(s) for s in node.body} if isinstance(node.body, list) else {id(node.body)}
            for child in ast.iter_child_nodes(node):
                visit(child, inner if id(child) in body else inherited, False)
            return
        for child in ast.iter_child_nodes(node):
            visit(child, inherited, False)

    visit(tree, {}, False)
    return out


def _binds_name(scope: ast.AST, name: str) -> bool:
    """Does this scope (module, class, function or lambda) bind ``name`` itself?"""
    body: list[ast.AST]
    if isinstance(scope, ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda):
        if name in _params(scope):
            return True
        body = list(scope.body) if isinstance(scope.body, list) else [scope.body]
    else:
        body = list(getattr(scope, "body", []))
    todo = body
    while todo:
        n = todo.pop()
        if isinstance(n, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
            if n.name == name:
                return True
            continue  # a nested scope binds its own names
        if isinstance(n, ast.Lambda) or (isinstance(n, ast.AnnAssign) and n.value is None):
            continue  # a bare annotation (a dataclass field) binds nothing
        if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store | ast.Del) and n.id == name:
            return True
        if isinstance(n, ast.alias) and (n.asname or n.name.split(".")[0]) == name:
            return True
        todo.extend(ast.iter_child_nodes(n))
    return False


def builtin_loads(src: Source, name: str) -> Iterator[ast.Name]:
    """Every load of ``name`` that means the builtin (not shadowed by a local, class or module name)."""
    parents = {id(child): parent for parent in ast.walk(src.tree) for child in ast.iter_child_nodes(parent)}
    for node in ast.walk(src.tree):
        if not (isinstance(node, ast.Name) and node.id == name and isinstance(node.ctx, ast.Load)):
            continue
        shadowed, passed_function, cur = False, False, id(node)
        while cur in parents and not shadowed:
            scope = parents[cur]
            cur = id(scope)
            if isinstance(scope, ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda):
                shadowed = _binds_name(scope, name)
                passed_function = True
            elif isinstance(scope, ast.ClassDef) and not passed_function:
                shadowed = _binds_name(scope, name)
        if not shadowed and not _binds_name(src.tree, name):
            yield node


def dedup(items: Iterable[str]) -> list[str]:
    return sorted(set(items))


Rule = Callable[[Source], list[str]]


def check(rule: Rule, rel: str, text: str) -> list[str]:
    return rule(parse(rel, text))


def on_src(rule: Rule) -> list[str]:
    return [v for src in SOURCES for v in rule(src)]


# =============================================================================== A1
def rule_a1(src: Source) -> list[str]:
    """Only cli.py and backtest/ may import samsulek.backtest."""
    if src.rel == "cli.py" or in_dir(src.rel, "backtest"):
        return []
    return dedup(
        f"{where(src, node)}: reaches {name} (only cli.py and backtest/ may)"
        for node, name in module_refs(src)
        if name == DYNAMIC or under(name, "samsulek.backtest")
    )


# =============================================================================== A2
A2_BANNED = tuple(
    f"samsulek.{m}"
    for m in (
        "app",
        "cli",
        "live_gate",
        "credentials",
        "net",
        "runlock",
        "kill",
        "terminal",
        "data.sources",
        "data.recorder",
        "data.synthetic",
    )
)
A2_BANNED_FOR_COSTS = tuple(f"samsulek.{m}" for m in ("execution", "risk", "portfolio", "cycle", "backtest"))
# redact() only REMOVES registered secrets from text; the in-memory store and alerter must
# redact exactly like the disk ones do. Everything else in credentials (loading, the env) stays banned.
A2_ALLOWED_EXACT = frozenset({"samsulek.credentials.redact"})


def rule_a2(src: Source) -> list[str]:
    """backtest/ and costs/ stay away from the bot's shell, secrets, network and recorders."""
    if not in_dir(src.rel, "backtest", "costs"):
        return []
    banned = A2_BANNED + (A2_BANNED_FOR_COSTS if in_dir(src.rel, "costs") else ())
    return dedup(
        f"{where(src, node)}: reaches {name}"
        for node, name in module_refs(src)
        if name == DYNAMIC or (under(name, *banned) and name not in A2_ALLOWED_EXACT)
    )


# =============================================================================== A3
def rule_a3(src: Source) -> list[str]:
    """data/ may not import the backtester or the cost models."""
    if not in_dir(src.rel, "data"):
        return []
    return dedup(
        f"{where(src, node)}: reaches {name}"
        for node, name in module_refs(src)
        if name == DYNAMIC or under(name, "samsulek.backtest", "samsulek.costs")
    )


# =============================================================================== A4
A4_ALLOWED_MODULES = (
    "__future__",
    "abc",
    "bisect",
    "collections",  # and collections.abc
    "dataclasses",
    "datetime",
    "decimal",
    "enum",
    "functools",
    "itertools",
    "math",
    "operator",
    "statistics",
    "types",
    "typing",
    "zoneinfo",
    "samsulek.types",
    "samsulek.strategies",
    "samsulek.signals",
)
A4_BANNED_BUILTINS = frozenset(
    {
        "open",
        "eval",
        "exec",
        "compile",
        "__import__",
        "input",
        "globals",
        "vars",
        "locals",
        "breakpoint",
        "setattr",
        "delattr",
        "__builtins__",
    }
)
A4_BANNED_ATTRS = frozenset(
    {"now", "today", "utcnow", "time", "perf_counter", "monotonic", "lru_cache", "cache", "import_module"}
)
# Introspection that reaches module globals, builtins or other code from any object.
A4_BANNED_DUNDERS = frozenset(
    {
        "__builtins__",
        "__globals__",
        "__dict__",
        "__code__",
        "__closure__",
        "__defaults__",
        "__kwdefaults__",
        "__self__",
        "__func__",
        "__subclasses__",
        "__mro__",
        "__bases__",
        "__base__",
        "__loader__",
        "__spec__",
        "__import__",
        "__getattribute__",
    }
)
# The process-wide decimal context: a strategy changing it would change the risk engine's arithmetic.
A4_DECIMAL_GLOBALS = frozenset(
    {"decimal.getcontext", "decimal.setcontext", "decimal.DefaultContext", "decimal.BasicContext"}
)
A4_CACHES = frozenset({"lru_cache", "cache"})
A4_VALUE_CALLS = frozenset({"MappingProxyType", "frozenset", "tuple", "field"})
A4_IMPORT_TIME_OK = (
    ast.Import,
    ast.ImportFrom,
    ast.FunctionDef,
    ast.AsyncFunctionDef,
    ast.Pass,
    ast.TypeAlias,
)


def _literal_display(node: ast.expr, ctors: frozenset[str]) -> bool:
    """A dict/set/list display of immutable values (allowed as the argument of the value calls)."""
    if isinstance(node, ast.Dict):
        keys_ok = all(k is not None and immutable_value(k, ctors) for k in node.keys)
        return keys_ok and all(immutable_value(v, ctors) for v in node.values)
    if isinstance(node, ast.Set | ast.List):
        return all(immutable_value(e, ctors) for e in node.elts)
    return False


def immutable_value(node: ast.expr, ctors: frozenset[str] = frozenset()) -> bool:
    """Literals, tuples of them, names, functions, type expressions, the allowed calls with
    immutable arguments, and calls of the frozen dataclasses named in ``ctors``."""
    if isinstance(node, ast.Constant | ast.Name | ast.Lambda | ast.JoinedStr):
        return True
    if isinstance(node, ast.Attribute):  # demo.X is fine; [].append is a list's bound method
        return immutable_value(node.value, ctors)
    if isinstance(node, ast.Tuple):
        return all(immutable_value(e, ctors) for e in node.elts)
    if isinstance(node, ast.UnaryOp):
        return immutable_value(node.operand, ctors)
    if isinstance(node, ast.BinOp):  # type unions (int | str) and arithmetic on literals
        return immutable_value(node.left, ctors) and immutable_value(node.right, ctors)
    if isinstance(node, ast.BoolOp):
        return all(immutable_value(v, ctors) for v in node.values)
    if isinstance(node, ast.Compare):
        return immutable_value(node.left, ctors) and all(immutable_value(c, ctors) for c in node.comparators)
    if isinstance(node, ast.IfExp):
        return all(immutable_value(n, ctors) for n in (node.test, node.body, node.orelse))
    if isinstance(node, ast.Subscript):  # generic aliases: tuple[str, int]
        return immutable_value(node.value, ctors)
    if isinstance(node, ast.Call):
        container = last_name(node.func) in A4_VALUE_CALLS
        if not (container or ast.unparse(node.func) in ctors):
            return False
        args = [*node.args, *(k.value for k in node.keywords)]
        return all(immutable_value(a, ctors) or (container and _literal_display(a, ctors)) for a in args)
    return False


def _frozen_dataclasses(src: Source) -> set[str]:
    """Top-level classes decorated with ``@dataclass(frozen=True, ...)``."""
    return {
        stmt.name
        for stmt in src.tree.body
        if isinstance(stmt, ast.ClassDef)
        and any(
            isinstance(d, ast.Call)
            and last_name(d.func) == "dataclass"
            and any(
                k.arg == "frozen" and isinstance(k.value, ast.Constant) and k.value.value is True
                for k in d.keywords
            )
            for d in stmt.decorator_list
        )
    }


FROZEN_DATACLASSES = frozenset(f"{src.module}.{name}" for src in SOURCES for name in _frozen_dataclasses(src))


def _value_ctors(src: Source) -> frozenset[str]:
    """Names a module-level value may call: this file's frozen dataclasses and imported ones."""
    imported = {local for local, target in bindings(src).items() if reexported(target) in FROZEN_DATACLASSES}
    return frozenset(_frozen_dataclasses(src) | imported)


def _shared_values(src: Source, body: list[ast.stmt], scope: str, ctors: frozenset[str]) -> Iterator[str]:
    for stmt in body:
        value: ast.expr | None = None
        if isinstance(stmt, ast.Assign | ast.AnnAssign):
            value = stmt.value
        elif isinstance(stmt, ast.AugAssign):
            yield f"{where(src, stmt)}: {scope} value changed at import time"
        elif isinstance(stmt, ast.ClassDef):
            yield from _shared_values(src, stmt.body, f"class-level ({stmt.name})", ctors)
        elif isinstance(stmt, ast.If):
            yield from _shared_values(src, stmt.body + stmt.orelse, scope, ctors)
        elif isinstance(stmt, ast.Try | ast.TryStar):
            handlers = [s for h in stmt.handlers for s in h.body]
            yield from _shared_values(src, stmt.body + handlers + stmt.orelse + stmt.finalbody, scope, ctors)
        elif isinstance(stmt, ast.For | ast.AsyncFor | ast.While | ast.With | ast.AsyncWith):
            yield f"{where(src, stmt)}: {scope} loop or with-block at import time"
        elif isinstance(stmt, ast.Expr):
            if not isinstance(stmt.value, ast.Constant):  # a docstring or ``...`` is fine
                yield f"{where(src, stmt)}: {scope} expression runs at import time (may change shared state)"
        elif not isinstance(stmt, A4_IMPORT_TIME_OK):
            yield f"{where(src, stmt)}: {scope} {type(stmt).__name__} statement runs at import time"
        if value is not None:
            if not immutable_value(value, ctors):
                yield (
                    f"{where(src, stmt)}: {scope} value is not immutable (allowed: literals, tuples, "
                    "frozenset(...), MappingProxyType(...), tuple(...), field(...) of immutable values, "
                    "frozen dataclasses, names, functions)"
                )
            if any(isinstance(n, ast.NamedExpr) for n in ast.walk(value)):
                yield f"{where(src, stmt)}: {scope} value binds a name with :="


def _own_instance_chain(node: ast.expr, recv: dict[str, str]) -> bool:
    """``self.a.b``: rooted at the method's own instance, not through ``__class__`` or ``__dict__``."""
    while isinstance(node, ast.Attribute | ast.Subscript):
        if isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            return False
        node = node.value
    return isinstance(node, ast.Name) and recv.get(node.id) == "instance"


def _whitelisted(name: str) -> bool:
    return under(name, *A4_ALLOWED_MODULES)


def rule_a4(src: Source) -> list[str]:
    """Strategies and signals: a narrow import whitelist, no clocks, files, caches or shared state."""
    if not in_dir(src.rel, "strategies", "signals"):
        return []
    out: list[str] = []
    receivers_at = receivers(src.tree)
    ctors = _value_ctors(src)
    for node in ast.walk(src.tree):
        at = where(src, node)
        recv = receivers_at.get(id(node), {})
        if isinstance(node, ast.Import):
            for a in node.names:
                if not _whitelisted(a.name):
                    out.append(f"{at}: imports {a.name} (not in the strategy whitelist)")
                elif a.asname is None and a.name.startswith("samsulek."):
                    out.append(f"{at}: 'import {a.name}' binds the whole samsulek package; use from-import")
        elif isinstance(node, ast.ImportFrom):
            base = resolve_from(src, node)
            for a in node.names:
                full = base if a.name == "*" else f"{base}.{a.name}"
                if not _whitelisted(full):
                    out.append(f"{at}: imports {full} (not in the strategy whitelist)")
                if a.name in A4_CACHES:
                    out.append(f"{at}: imports the cache decorator {a.name}")
        elif isinstance(node, ast.Global | ast.Nonlocal):
            out.append(f"{at}: uses global/nonlocal")
        elif isinstance(node, ast.Name):
            if isinstance(node.ctx, ast.Load) and node.id in A4_BANNED_BUILTINS:
                out.append(f"{at}: uses the builtin {node.id}")
        elif isinstance(node, ast.Attribute):
            if node.attr in A4_BANNED_ATTRS:
                out.append(f"{at}: uses .{node.attr} (clocks, caches and dynamic imports are banned)")
            if node.attr in A4_BANNED_DUNDERS:
                out.append(f"{at}: uses .{node.attr} (introspection reaches globals and builtins)")
            if isinstance(node.ctx, ast.Store | ast.Del) and not _own_instance_chain(node.value, recv):
                out.append(
                    f"{at}: assigns .{node.attr} on something other than self "
                    "(a shared object would keep state between cycles)"
                )
        elif isinstance(node, ast.Call):
            f = node.func
            if isinstance(f, ast.Name) and f.id in A4_CACHES:
                out.append(f"{at}: uses the cache decorator {f.id}")
            if isinstance(f, ast.Attribute) and f.attr in {"__setattr__", "__delattr__"}:
                first = node.args[0] if node.args else None
                if not (isinstance(first, ast.Name) and recv.get(first.id) == "instance"):
                    out.append(f"{at}: {f.attr} on something other than self")
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
            for dec in node.decorator_list:
                if isinstance(dec, ast.Name) and dec.id in A4_CACHES:
                    out.append(f"{where(src, dec)}: uses the cache decorator {dec.id}")
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda):
            defaults = node.args.defaults + [d for d in node.args.kw_defaults if d is not None]
            out.extend(
                f"{where(src, d)}: mutable default argument (evaluated once, shared by every call)"
                for d in defaults
                if not immutable_value(d, ctors)
            )
    banned_by_name = A4_BANNED_ATTRS | A4_BANNED_BUILTINS | A4_BANNED_DUNDERS
    out.extend(
        f"{where(src, n)}: getattr of {name!r}" for n, _, name in getattr_names(src) if name in banned_by_name
    )
    out.extend(
        f"{where(src, node)}: uses {name} (the process-wide decimal context; use decimal.localcontext())"
        for node, name in module_refs(src)
        if name in A4_DECIMAL_GLOBALS
    )
    out.extend(_shared_values(src, src.tree.body, "module-level", ctors))
    return dedup(out)


# =============================================================================== A5
A5_METHODS = frozenset(
    {
        "evaluate",
        "observe_equity",
        "submit",
        "record_submission",
        "cancel_non_exits",
        "flatten",
        "plan_orders",
        "place_order",  # the broker call behind router.submit: the most direct second cycle
    }
)


def rule_a5(src: Source) -> list[str]:
    """No second cycle: backtest/ never plans, risk-checks, submits or flattens by itself."""
    if not in_dir(src.rel, "backtest"):
        return []
    out: list[str] = []
    for node in ast.walk(src.tree):
        if isinstance(node, ast.Attribute) and node.attr in A5_METHODS:
            out.append(f"{where(src, node)}: uses .{node.attr} (only the shared cycle core may)")
        elif isinstance(node, ast.Name) and node.id == "plan_orders":
            out.append(f"{where(src, node)}: uses plan_orders (only the shared cycle core may)")
        elif isinstance(node, ast.ImportFrom) and any(a.name == "plan_orders" for a in node.names):
            out.append(f"{where(src, node)}: imports plan_orders")
    out.extend(
        f"{where(src, n)}: getattr of {name!r}" for n, _, name in getattr_names(src) if name in A5_METHODS
    )
    return dedup(out)


# =============================================================================== A6
A6_NAMES: dict[str, frozenset[str]] = {
    "run_cycle_core": frozenset({"cycle.py"}),
    "run_unlocked_cycle": frozenset({"cycle.py", "backtest/runner.py"}),
    "build_parts": frozenset({"backtest/runner.py"}),
    "apply_owner_reset": frozenset({"risk/reset.py", "cli.py", "backtest/halts.py"}),
    "run_holdout": frozenset({"backtest/orchestrate.py", "cli.py"}),
    "EveryDayCalendar": frozenset({"data/synthetic.py"}),
}
A6_TEXT: dict[str, frozenset[str]] = {"risk_research": frozenset({"backtest/limits.py"})}


def _identifiers(src: Source) -> Iterator[tuple[ast.AST, str]]:
    docstrings = docstring_nodes(src.tree)
    for node in ast.walk(src.tree):
        if isinstance(node, ast.Name):
            yield node, node.id
        elif isinstance(node, ast.Attribute):
            yield node, node.attr
        elif isinstance(node, ast.alias):
            yield node, node.asname or node.name.rsplit(".", 1)[-1]
            yield from ((node, part) for part in node.name.split("."))
        elif isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
            yield node, node.name
        elif isinstance(node, ast.arg | ast.keyword) and node.arg:
            yield node, node.arg
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings:
            # every identifier inside the string: "pkg.mod.run_holdout", "a.run_holdout" for attrgetter
            yield from ((node, word) for word in IDENTIFIER.findall(node.value))


def rule_a6(src: Source) -> list[str]:
    """The lock bypass, part builder, owner reset, holdout run and research limits stay where they belong."""
    out = [
        f"{where(src, node)}: references {name} (allowed only in {', '.join(sorted(A6_NAMES[name]))})"
        for node, name in _identifiers(src)
        if name in A6_NAMES and src.rel not in A6_NAMES[name]
    ]
    lowered = src.text.lower()
    for text, allowed in A6_TEXT.items():
        if text in lowered and src.rel not in allowed:
            line = lowered[: lowered.index(text)].count("\n") + 1
            out.append(f"{src.rel}:{line}: mentions {text} (allowed only in {', '.join(sorted(allowed))})")
    return dedup(out)


# =============================================================================== A7
A7_CALLS = frozenset(
    {
        "RiskStateStore",
        "Ledger",
        "DecisionLog",
        "RunLock",
        "build_app",
        "load_env_file",
        "setup_logging",
        "SystemClock",
        "ConsoleAlerter",
    }
)
# Disk classes whose own __init__ creates the bot's folders: an in-memory subclass must not run it.
A7_DISK_BASES = frozenset({"RiskStateStore", "DecisionLog"})
A7_PATH_PARTS = frozenset({"state", "logs"})
A7_PATH_CALLS = frozenset(
    {
        "Path",
        "PurePath",
        "PurePosixPath",
        "PureWindowsPath",
        "PosixPath",
        "WindowsPath",
        "joinpath",
        "join",
        "with_name",
    }
)
A7_PATH_NAMES = frozenset({"STATE_DIR", "state_dir", "log_dir"})


def _is_bot_dir_word(node: ast.AST) -> bool:
    return (
        isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value.lower() in A7_PATH_PARTS
    )


def _naming_is_fine(tree: ast.Module) -> set[int]:
    """Nodes where naming a disk class is not a use of it: class bases, the class argument
    of isinstance/issubclass, and annotations."""
    ok: set[int] = set()

    def mark(n: ast.AST | None) -> None:
        if n is not None:
            ok.update(id(x) for x in ast.walk(n))

    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            for base in node.bases:
                mark(base)
        elif isinstance(node, ast.Call) and last_name(node.func) in {"isinstance", "issubclass"}:
            if len(node.args) == 2:
                mark(node.args[1])
        elif isinstance(node, ast.arg):
            mark(node.annotation)
        elif isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            mark(node.returns)
        elif isinstance(node, ast.AnnAssign):
            mark(node.annotation)
    return ok


def _is_super_init(node: ast.AST) -> bool:
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "__init__"
        and isinstance(node.func.value, ast.Call)
        and last_name(node.func.value.func) == "super"
    )


def rule_a7(src: Source) -> list[str]:
    """backtest/ never builds the bot's disk parts, lock, logging, wall clock or console alerts."""
    if not in_dir(src.rel, "backtest"):
        return []
    out = [
        f"{where(src, node)}: calls {name}( (use the in-memory parts)"
        for node, name in calls(src)
        if name in A7_CALLS
    ]
    out.extend(
        f"{where(src, n)}: getattr of {name!r}" for n, _, name in getattr_names(src) if name in A7_CALLS
    )
    fine = _naming_is_fine(src.tree)
    docstrings = docstring_nodes(src.tree)
    for node in ast.walk(src.tree):
        ident = last_name(node)
        if ident in A7_CALLS and id(node) not in fine:
            out.append(f"{where(src, node)}: uses {ident} as a value (an alias could call it)")
        if isinstance(node, ast.alias) and node.asname and node.name.rsplit(".", 1)[-1] in A7_CALLS:
            out.append(f"{where(src, node)}: imports {node.name} as {node.asname} (renaming hides calls)")
        if isinstance(node, ast.ClassDef):
            disk = sorted({last_name(b) for b in node.bases} & A7_DISK_BASES)
            out.extend(
                f"{where(src, inner)}: {node.name} runs {disk[0]}.__init__ (it creates the bot's folder)"
                for inner in ast.walk(node)
                if disk and _is_super_init(inner)
            )
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings:
            for token in node.value.split():
                parts = token.replace("\\", "/").split("/")
                if len(parts) > 1 and any(p.lower() in A7_PATH_PARTS for p in parts):
                    out.append(
                        f"{where(src, node)}: path literal {token!r} names the bot's state or logs folder"
                    )
        elif isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
            if _is_bot_dir_word(node.left) or _is_bot_dir_word(node.right):
                out.append(f"{where(src, node)}: joins a path with 'state' or 'logs'")
        elif isinstance(node, ast.Call):
            if last_name(node.func) in A7_PATH_CALLS and any(_is_bot_dir_word(a) for a in node.args):
                out.append(f"{where(src, node)}: builds a path with 'state' or 'logs'")
        elif isinstance(node, ast.Name) and node.id in A7_PATH_NAMES:
            out.append(f"{where(src, node)}: uses {node.id} (the bot's folders)")
        elif isinstance(node, ast.Attribute) and node.attr in A7_PATH_NAMES:
            out.append(f"{where(src, node)}: uses .{node.attr} (the bot's folders)")
    return dedup(out)


# =============================================================================== A8
def _private(name: str) -> bool:
    return name.startswith("_") and not (name.startswith("__") and name.endswith("__"))


def rule_a8(src: Source) -> list[str]:
    """No _private access in backtest/ except on self and cls (the method's own first parameter)."""
    if not in_dir(src.rel, "backtest"):
        return []
    recv = receivers(src.tree)

    def own(expr: ast.AST | None, at: ast.AST) -> bool:
        return isinstance(expr, ast.Name) and expr.id in recv.get(id(at), {})

    out: list[str] = []
    for node in ast.walk(src.tree):
        if isinstance(node, ast.Attribute):
            if _private(node.attr) and not own(node.value, node):
                out.append(f"{where(src, node)}: reaches the private .{node.attr} of another object")
            elif node.attr == "__dict__" and not own(node.value, node):
                out.append(f"{where(src, node)}: reaches into another object's __dict__")
        elif (
            isinstance(node, ast.Name)
            and isinstance(node.ctx, ast.Store)
            and node.id in recv.get(id(node), {})
        ):
            out.append(f"{where(src, node)}: rebinds {node.id} (it would no longer mean the own object)")
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "vars":
            if node.args and not own(node.args[0], node):
                out.append(f"{where(src, node)}: vars() of another object")
        elif isinstance(node, ast.ImportFrom) and node.module != "__future__":
            out.extend(
                f"{where(src, node)}: imports the private {a.name}" for a in node.names if _private(a.name)
            )
        elif isinstance(node, ast.Import):
            out.extend(
                f"{where(src, node)}: imports the private module {a.name}"
                for a in node.names
                if any(_private(p) for p in a.name.split("."))
            )
    out.extend(
        f"{where(src, n)}: getattr of {name!r}"
        for n, target, name in getattr_names(src)
        if _private(name) and not own(target, n)
    )
    return dedup(out)


# =============================================================================== A9
A9_ALLOWED = frozenset({"backtest/parallel.py"})
# Research code (backtest/, costs/, strategies/) also starts no other processes or threads:
# results must not depend on scheduling, and parallelism has one home.
A9_RESEARCH_BANNED = ("subprocess", "threading", "_thread", "asyncio")
A9_OS_PROCESS = frozenset(
    {"os.fork", "os.forkpty", "os.system", "os.popen", "os.posix_spawn", "os.posix_spawnp"}
)


def rule_a9(src: Source) -> list[str]:
    """multiprocessing and concurrent.futures only in backtest/parallel.py."""
    if src.rel in A9_ALLOWED:
        return []
    research = in_dir(src.rel, "backtest", "costs", "strategies")
    out: list[str] = []
    for node, name in module_refs(src):
        if under(name, "multiprocessing", "_multiprocessing", "concurrent.futures"):
            out.append(
                f"{where(src, node)}: reaches {name} (process pools live in backtest/parallel.py only)"
            )
        elif research and (
            under(name, *A9_RESEARCH_BANNED)
            or name in A9_OS_PROCESS
            or name.startswith(("os.spawn", "os.exec"))
        ):
            out.append(f"{where(src, node)}: reaches {name} (research code runs in one process and thread)")
    return dedup(out)


# =============================================================================== A10
A10_WALL_CLOCK = frozenset(
    {
        "datetime.datetime.now",
        "datetime.datetime.today",
        "datetime.datetime.utcnow",
        "datetime.date.today",
        "datetime.now",  # unresolved forms, for sources without the import
        "datetime.today",
        "datetime.utcnow",
        "date.today",
        "time.time",
        "time.time_ns",
        "time.monotonic",
        "time.monotonic_ns",
    }
)
A10_PERF = frozenset({"time.perf_counter", "time.perf_counter_ns"})
A10_PERF_ALLOWED = frozenset({"backtest/parallel.py", "backtest/orchestrate.py"})
A10_ENTROPY = frozenset({"uuid.uuid1", "uuid.uuid4", "os.urandom", "os.getrandom"})


def _is_none(node: ast.AST | None) -> bool:
    return isinstance(node, ast.Constant) and node.value is None


def rule_a10(src: Source) -> list[str]:
    """Deterministic research code: seeded random.Random only, no wall clock, timers only where allowed."""
    if not in_dir(src.rel, "backtest", "costs", "strategies"):
        return []
    out: list[str] = []
    binds = bindings(src)
    imports_time = any(under(target, "time") for target in binds.values())
    for node, name in module_refs(src):
        at = where(src, node)
        if under(name, "random") and name not in {"random", "random.Random"}:
            out.append(f"{at}: uses {name} (only a seeded random.Random(seed) is allowed)")
        elif name in A10_WALL_CLOCK:
            out.append(f"{at}: reads the wall clock ({name})")
        elif name in A10_PERF:
            if src.rel not in A10_PERF_ALLOWED:
                out.append(f"{at}: uses {name} (only parallel.py and orchestrate.py may time things)")
        elif imports_time and under(name, "time") and name != "time":
            out.append(f"{at}: uses {name} (no clocks or sleeps in research code)")
        elif name in A10_ENTROPY or under(name, "secrets"):
            out.append(f"{at}: uses OS entropy ({name})")
    in_hash_method = {
        id(n)
        for fn in ast.walk(src.tree)
        if isinstance(fn, ast.FunctionDef) and fn.name == "__hash__"
        for n in ast.walk(fn)
    }
    for node in ast.walk(src.tree):
        at = where(src, node)
        if isinstance(node, ast.Attribute) and node.attr in {"today", "utcnow"}:
            out.append(f"{at}: uses .{node.attr} (reads the wall clock)")
        if not isinstance(node, ast.Call):
            continue
        f, q = node.func, qualname(node.func, binds)
        if q is not None and reexported(q) == "random.Random":
            if not node.args and not node.keywords:
                out.append(f"{at}: random.Random() without a seed")
            elif _is_none(node.args[0] if node.args else None) or any(
                k.arg == "x" and _is_none(k.value) for k in node.keywords
            ):
                out.append(f"{at}: random.Random(None) seeds from OS entropy")
        no_seed = (not node.args and not node.keywords) or _is_none(node.args[0] if node.args else None)
        if isinstance(f, ast.Attribute) and f.attr == "seed" and no_seed:
            out.append(f"{at}: .seed() without a seed reseeds from OS entropy")
        if isinstance(f, ast.Attribute) and f.attr == "now" and (node.args or node.keywords):
            out.append(f"{at}: .now(tz) reads the wall clock (a Clock's now() takes no arguments)")
        if isinstance(f, ast.Name) and f.id == "hash" and id(node) not in in_hash_method:
            out.append(f"{at}: hash() changes with PYTHONHASHSEED (every spawned worker differs): use sha256")
    return dedup(out)


# =============================================================================== A11
A11_BANNED = frozenset(
    {
        "duckdb.connect",
        "duckdb.sql",
        "duckdb.query",
        "duckdb.execute",
        "duckdb.read_csv",
        "duckdb.read_parquet",
        "duckdb.read_json",
        "duckdb.default_connection",
    }
)


def rule_a11(src: Source) -> list[str]:
    """duckdb.connect only in data/store.py (its connections are locked down)."""
    if src.rel == "data/store.py":
        return []
    return dedup(f"{where(src, node)}: uses {name}" for node, name in module_refs(src) if name in A11_BANNED)


# =============================================================================== A12
A12_ALLOWED = frozenset({"backtest/report.py", "backtest/registry.py"})
A12_ATTRS = frozenset(
    {
        "write_text",
        "write_bytes",
        "mkdir",
        "makedirs",
        "touch",
        "unlink",
        "rmdir",
        "rename",
        "symlink_to",
        "hardlink_to",
    }
)
A12_QUALNAMES = frozenset(
    {
        "os.replace",
        "os.fsync",
        "os.fdatasync",
        "os.makedirs",
        "os.mkdir",
        "os.rename",
        "os.renames",
        "os.remove",
        "os.removedirs",
        "os.unlink",
        "os.rmdir",
        "os.write",
        "os.fdopen",
        "os.truncate",
        "os.ftruncate",
        "os.link",
        "os.symlink",
        "os.chmod",
        "os.chown",
        "os.utime",
        "os.mkfifo",
        "os.mknod",
        "logging.FileHandler",
        "bz2.BZ2File",
        "lzma.LZMAFile",
    }
)
A12_MODULES = (
    "shutil",
    "tempfile",
    "samsulek.fsutil",
    "shelve",
    "dbm",
    "sqlite3",
    "zipfile",
    "tarfile",
    "mmap",
    "logging.handlers",
)
A12_HELPERS = frozenset({"atomic_write_text", "fsync_file", "fsync_dir", "FileIO"})


def rule_a12(src: Source) -> list[str]:
    """Only report.py and registry.py in backtest/ touch files."""
    if not in_dir(src.rel, "backtest") or src.rel in A12_ALLOWED:
        return []
    binds = bindings(src)
    builtin_open = {id(node): node for node in builtin_loads(src, "open")}
    out = [f"{where(src, node)}: uses the builtin open" for node in builtin_open.values()]
    for node in ast.walk(src.tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "open":
            out.append(f"{where(src, node)}: calls .open(")
        elif isinstance(node, ast.Call) and id(node.func) in builtin_open:
            out.append(f"{where(src, node)}: calls open(")
        elif isinstance(node, ast.Attribute) and node.attr in A12_ATTRS:
            out.append(f"{where(src, node)}: uses .{node.attr}")
        gzip_file = (
            isinstance(node, ast.Call) and reexported(qualname(node.func, binds) or "") == "gzip.GzipFile"
        )
        if (
            gzip_file
            and isinstance(node, ast.Call)
            and (node.args or any(k.arg == "filename" for k in node.keywords))
        ):
            out.append(f"{where(src, node)}: gzip.GzipFile on a file name (use fileobj= or gzip.compress)")
    for node, name in module_refs(src):
        if name in A12_QUALNAMES or under(name, *A12_MODULES):
            out.append(f"{where(src, node)}: uses {name}")
        elif name.rsplit(".", 1)[-1] in A12_HELPERS:
            out.append(f"{where(src, node)}: uses the file helper {name}")
    return dedup(out)


RULES: dict[str, Rule] = {
    "A1": rule_a1,
    "A2": rule_a2,
    "A3": rule_a3,
    "A4": rule_a4,
    "A5": rule_a5,
    "A6": rule_a6,
    "A7": rule_a7,
    "A8": rule_a8,
    "A9": rule_a9,
    "A10": rule_a10,
    "A11": rule_a11,
    "A12": rule_a12,
}


# =============================================================================== the scan itself
M3_MODULES = [
    "quotes.py",
    "data/freshness.py",
    "risk/reset.py",
    "costs/__init__.py",
    "costs/stocks.py",
    "costs/memecoin.py",
    "strategies/params.py",
    "strategies/registry.py",
    "strategies/baselines.py",
    "strategies/wrappers.py",
    *(
        f"backtest/{m}.py"
        for m in (
            "__init__",
            "types",
            "clock",
            "inmemory",
            "fence",
            "fx",
            "dataset",
            "sources",
            "synthetic_data",
            "feed",
            "plans",
            "runner",
            "halts",
            "book",
            "metrics",
            "stats",
            "registry",
            "limits",
            "study",
            "walkforward",
            "baselines",
            "facts",
            "parallel",
            "report",
            "orchestrate",
        )
    ),
]


def test_the_scan_covers_every_m3_module_and_the_shell() -> None:
    scanned = {src.rel for src in SOURCES}
    missing = [m for m in [*M3_MODULES, "cli.py", "cycle.py", "app.py", "data/store.py"] if m not in scanned]
    assert not missing, missing
    assert all(src.tree.body for src in SOURCES if src.rel in M3_MODULES)  # nothing is an empty file


def test_the_allowed_files_define_the_names_they_guard() -> None:
    """The A6 allow-lists point at real definitions (WP1 adds run_cycle_core, run_unlocked_cycle
    and EveryDayCalendar to existing modules; once there, they must be defined where allowed)."""
    defined: dict[str, set[str]] = {}
    for src in SOURCES:
        for node in ast.walk(src.tree):
            if isinstance(node, ast.FunctionDef | ast.ClassDef):
                defined.setdefault(node.name, set()).add(src.rel)
    assert defined["build_parts"] == {"backtest/runner.py"}
    assert defined["apply_owner_reset"] == {"risk/reset.py"}
    assert defined["run_holdout"] == {"backtest/orchestrate.py"}
    for name in ("run_cycle_core", "run_unlocked_cycle"):
        assert defined.get(name, {"cycle.py"}) == {"cycle.py"}, name
    assert defined.get("EveryDayCalendar", {"data/synthetic.py"}) == {"data/synthetic.py"}
    assert "backtest/limits.py" in {s.rel for s in SOURCES if "risk_research" in s.text}


@pytest.mark.parametrize("rule_id", list(RULES))
def test_rule_holds_on_src(rule_id: str) -> None:
    violations = on_src(RULES[rule_id])
    assert not violations, "\n".join(violations)


def _flagged(rule: Rule, rel: str, text: str, expect: str) -> None:
    found = check(rule, rel, text)
    assert found, f"{rule.__name__} missed a planted violation at {rel}:\n{textwrap.dedent(text)}"
    assert any(expect in v for v in found), (expect, found)


def _clean(rule: Rule, rel: str, text: str) -> None:
    found = check(rule, rel, text)
    assert not found, found


# =============================================================================== self-tests
def test_resolver_handles_relative_and_aliased_names() -> None:
    src = parse(
        "strategies/x.py",
        """
        import datetime as dt
        from . import demo
        from ..data import store
        from .. import backtest
        import samsulek.types
        dt.datetime.now
        samsulek.backtest.runner
        """,
    )
    names = {name for _, name in module_refs(src)}
    assert {"samsulek.strategies.demo", "samsulek.data.store", "samsulek.backtest"} <= names
    assert {"datetime.datetime.now", "samsulek.backtest.runner"} <= names
    init = parse("backtest/__init__.py", "from . import types\nfrom .runner import run_backtest\n")
    assert {name for _, name in module_refs(init)} >= {
        "samsulek.backtest.types",
        "samsulek.backtest.runner.run_backtest",
    }
    dynamic = parse("risk/x.py", "import importlib\nm = importlib.import_module('x')\n__import__('y')\n")
    assert DYNAMIC in {name for _, name in module_refs(dynamic)}


def test_resolver_follows_reexports_getattr_strings_and_sys_modules(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(
        REEXPORTS, "samsulek.fake", {"App": "samsulek.app.App", "store": "samsulek.data.store"}
    )
    monkeypatch.setitem(REEXPORTS, "samsulek.relay", {"App": "samsulek.fake.App"})
    src = parse(
        "backtest/x.py",
        """
        import sys
        import samsulek
        from samsulek.relay import App
        from samsulek.fake import store as s
        App.run
        s.connect
        getattr(samsulek, "backtest")
        sys.modules["samsulek.x"]
        """,
    )
    names = {name for _, name in module_refs(src)}
    assert {"samsulek.app.App", "samsulek.app.App.run", "samsulek.data.store.connect"} <= names
    assert {"samsulek.backtest", "samsulek.x", DYNAMIC} <= names
    assert reexported("samsulek.fake.App.x") == "samsulek.app.App.x"
    assert reexported("samsulek.types.Bar") == "samsulek.types.Bar"  # defined there: unchanged


def test_the_real_reexport_table_resolves_known_cases() -> None:
    # A real module's own definition is never "re-exported"; an imported name is followed.
    assert reexported("samsulek.backtest.types.RunJob") == "samsulek.backtest.types.RunJob"
    # portfolio/ledger.py takes atomic_write_text from risk/state.py, which takes it from fsutil.py
    assert reexported("samsulek.portfolio.ledger.atomic_write_text") == "samsulek.fsutil.atomic_write_text"


def test_receivers_mean_the_methods_own_first_parameter() -> None:
    tree = ast.parse(
        "def f(self):\n    return self\n"
        "class A:\n"
        "    def m(self):\n        g = lambda: self\n        return g\n"
        "    @classmethod\n    def c(cls):\n        return cls\n"
        "    @staticmethod\n    def s(self):\n        return self\n"
    )
    found = {
        (node.lineno, tuple(sorted(receivers(tree)[id(node)].items())))
        for node in ast.walk(tree)
        if isinstance(node, ast.Name) and node.id in {"self", "cls"} and isinstance(node.ctx, ast.Load)
    }
    assert found == {
        (2, ()),  # a module-level function's "self" is just a parameter
        (5, (("self", "instance"),)),  # closures inside a method inherit it
        (9, (("cls", "class"),)),
        (12, ()),  # staticmethod
    }


def test_builtin_loads_ignore_shadowed_names() -> None:
    src = parse(
        "backtest/x.py",
        "from dataclasses import dataclass\n"
        "@dataclass\nclass Row:\n    open: float\n    def f(self):\n        return open\n"
        "def g(open):\n    return open\n"
        "def h():\n    open = 1\n    return open\n"
        "def k():\n    return open\n",
    )
    assert sorted(n.lineno for n in builtin_loads(src, "open")) == [6, 13]


def up(rel: str) -> str:
    """The relative-import dots that lead from ``rel`` to the samsulek package."""
    return "." * rel.count("/") + "."


def test_a1_self_test(monkeypatch: pytest.MonkeyPatch) -> None:
    planted = [
        "from samsulek.backtest import runner",
        "from samsulek.backtest.types import RunJob",
        "import samsulek.backtest.types as t",
        "from samsulek import backtest",
        "from {up}backtest import types",
        "from {up} import backtest",
        "import samsulek.types\nx = samsulek.backtest.runner",
        "import importlib\nm = importlib.import_module('samsulek.backtest')",
        "m = __import__('samsulek.backtest')",
        "import sys\nm = sys.modules['samsulek.backtest.runner']",
        "import samsulek\nm = getattr(samsulek, 'backtest')",
        "X = 'samsulek.backtest.runner'",
    ]
    for text in planted:
        for rel in ("risk/x.py", "data/x.py", "data/recorder/x.py", "cycle.py", "strategies/x.py", "app.py"):
            _flagged(rule_a1, rel, text.format(up=up(rel)), "reaches")
    # a name that cli.py imported from the backtester, taken from cli.py
    monkeypatch.setitem(REEXPORTS, "samsulek.cli", {"run_study": "samsulek.backtest.orchestrate.run_study"})
    _flagged(rule_a1, "kill.py", "from samsulek.cli import run_study", "samsulek.backtest.orchestrate")
    for rel in ("cli.py", "backtest/x.py", "backtest/sub/x.py"):
        _clean(rule_a1, rel, "from samsulek.backtest.types import RunJob\nfrom . import types\n")
    _clean(rule_a1, "risk/x.py", "from samsulek.types import Bar\nfrom samsulek.backtesting_notes import x\n")
    _clean(rule_a1, "risk/x.py", '"""Mentions samsulek.backtest in a docstring."""\nP = "samsulek.log"\n')


def test_a2_self_test(monkeypatch: pytest.MonkeyPatch) -> None:
    for rel in ("backtest/x.py", "costs/x.py"):
        for text in (
            "from samsulek.app import build_app",
            "import samsulek.cli",
            "from samsulek.live_gate import check",
            "from samsulek.credentials import load_env_file",
            "import samsulek.credentials",
            "from samsulek import credentials",
            "from samsulek.credentials import redact\nx = redact.__globals__",
            "from samsulek.net.http import HttpClient",
            "from samsulek.runlock import RunLock",
            "from samsulek.kill import kill",
            "from samsulek.terminal import confirm_phrase",
            "from samsulek.data.sources import ecb",
            "from samsulek.data.recorder.journal import Journal",
            "from samsulek.data.synthetic import SyntheticFeed",
            "from ..data import synthetic",
            "import importlib\nimportlib.import_module('samsulek.app')",
            "import samsulek\nm = getattr(samsulek, 'app')",
            "X = 'samsulek.net.http'",
        ):
            _flagged(rule_a2, rel, text, "reaches")
    # re-exports: a banned name taken from a module that imported it
    monkeypatch.setitem(
        REEXPORTS,
        "samsulek.relay",
        {
            "App": "samsulek.app.App",
            "RunLock": "samsulek.runlock.RunLock",
            "ecb": "samsulek.data.sources.ecb",
        },
    )
    for name, expect in (("App", "samsulek.app"), ("RunLock", "samsulek.runlock"), ("ecb", "data.sources")):
        _flagged(rule_a2, "backtest/x.py", f"from samsulek.relay import {name}", expect)
    for text in (
        "from samsulek.execution.sim_broker import SimBroker",
        "from samsulek.risk.engine import RiskEngine",
        "from samsulek.portfolio.ledger import Ledger",
        "from samsulek.cycle import CycleReport",
        "from samsulek.backtest.types import RunJob",
        "from .. import cycle",
    ):
        _flagged(rule_a2, "costs/x.py", text, "reaches")
        _clean(rule_a2, "backtest/x.py", text)
    clean = (
        "from samsulek.credentials import redact\n"
        "from samsulek.config import MarketLimits\nfrom samsulek.types import OrderRequest\n"
        "from samsulek.data.calendars import XetraCalendar\nfrom samsulek.data.market import FxRate\n"
        "def f(text):\n    return redact(text)\n"
    )
    _clean(rule_a2, "backtest/x.py", clean)
    _clean(rule_a2, "costs/x.py", clean)
    monkeypatch.setitem(REEXPORTS, "samsulek.relay2", {"redact": "samsulek.credentials.redact"})
    _clean(rule_a2, "backtest/x.py", "from samsulek.relay2 import redact\n")  # redact via a re-export
    _clean(rule_a2, "risk/x.py", "from samsulek.app import App\n")  # not in scope


def test_a3_self_test() -> None:
    for text in (
        "from samsulek.backtest.types import RunJob",
        "from samsulek.costs import BPS",
        "from {up}costs import stocks",
        "from {up} import backtest",
        "import samsulek.costs.stocks as s",
        "m = __import__('samsulek.backtest')",
        "import samsulek\nm = getattr(samsulek, 'costs')",
    ):
        for rel in ("data/x.py", "data/recorder/x.py"):
            _flagged(rule_a3, rel, text.format(up=up(rel)), "reaches")
    _clean(rule_a3, "data/x.py", "from samsulek.data.bars import DailyBar\nfrom samsulek.types import Bar\n")
    _clean(rule_a3, "backtest/x.py", "from samsulek.costs import BPS\n")


TRAP6_PLANTED = {
    "from samsulek.data import store": "not in the strategy whitelist",
    "import samsulek.backtest as b": "not in the strategy whitelist",
    "import os": "not in the strategy whitelist",
    "import gc": "not in the strategy whitelist",
    "import random": "not in the strategy whitelist",
    "def f():\n    return __import__('x')": "builtin __import__",
    "def f():\n    return importlib.import_module('samsulek.data.store')": "import_module",
    "def f():\n    return datetime.now()": ".now",
    "def f():\n    return dt.datetime.now()": ".now",
    "def f():\n    return open('x')": "builtin open",
    "CACHE = {}": "not immutable",
    "CACHE: dict[str, int] = {}": "not immutable",
    "def f():\n    global X\n    X = 1": "global",
    "@lru_cache\ndef f(x):\n    return x": "cache decorator lru_cache",
    "from functools import lru_cache\n\n@lru_cache\ndef f(x):\n    return x": "cache decorator",
    "import functools\n\n@functools.cache\ndef f(x):\n    return x": ".cache",
    "def f(m):\n    setattr(m, 'x', 1)": "builtin setattr",
}
MORE_A4_PLANTED = {
    "import importlib": "not in the strategy whitelist",
    "import time": "not in the strategy whitelist",
    "import samsulek.types": "binds the whole samsulek package",
    "from samsulek.clock import SystemClock": "not in the strategy whitelist",
    "from samsulek.costs import BPS": "not in the strategy whitelist",
    "from samsulek.config import RiskConfig": "not in the strategy whitelist",
    "from ..data.market import MarketData": "not in the strategy whitelist",
    "from functools import cache as c": "cache decorator cache",
    "import functools\n\n@functools.lru_cache(maxsize=None)\ndef f(x):\n    return x": ".lru_cache",
    "def f(x):\n    return eval(x)": "builtin eval",
    "def f():\n    g = open\n    return g": "builtin open",
    "def f():\n    return __builtins__": "builtin __builtins__",
    "def f():\n    return vars()": "builtin vars",
    "def f(ts):\n    return ts.time()": ".time",
    "def f(d):\n    return d.today()": ".today",
    "from datetime import datetime\n\ndef f():\n    return getattr(datetime, 'now')()": "getattr of 'now'",
    "import operator\ndef f(d):\n    return operator.attrgetter('now')(d)()": "getattr of 'now'",
    "from operator import methodcaller\ndef f(d):\n    return methodcaller('now')(d)": "getattr of 'now'",
    "def f(d):\n    return object.__getattribute__(d, 'now')()": "getattr of 'now'",
    "from samsulek.strategies import demo\ndef f():\n    return demo.__builtins__": ".__builtins__",
    "def g():\n    pass\ndef f():\n    return g.__globals__": ".__globals__",
    "def f(o):\n    return type(o).__subclasses__()": ".__subclasses__",
    "def f():\n    x = 0\n    def g():\n        nonlocal x\n        x += 1\n    return g": "global/nonlocal",
    "class S:\n    calls = 0\n    def f(self):\n        type(self).calls += 1": "shared object",
    "class S:\n    calls = 0\n    def f(self):\n        S.calls = 1": "shared object",
    "class S:\n    calls = 0\n    def f(self):\n        self.__class__.calls = 1": "shared object",
    "class S:\n    @classmethod\n    def f(cls):\n        cls.calls = 1": "shared object",
    "class S:\n    n = 0\n    def f(self):\n        c = type(self)\n        c.n = 1": "shared object",
    "from samsulek.strategies import demo\ndef f():\n    m = demo\n    m.x = 1": "shared object",
    "def f(self):\n    self.calls = 1": "shared object",  # a module function's "self" is not an instance
    "class S:\n    def f(self):\n        object.__setattr__(S, 'calls', 1)": "other than self",
    "def f():\n    pass\n\nf.cache = {}": "not immutable",
    "def f(x, seen=[]):\n    return x": "mutable default",
    "def f(x, *, seen=set()):\n    return x": "mutable default",
    "class S:\n    seen = []": "class-level (S) value is not immutable",
    "class S:\n    seen: list[int] = []": "class-level (S) value is not immutable",
    "COUNTER = itertools.count()": "not immutable",
    "SEEN = set()": "not immutable",
    "SEEN = [x for x in range(3)]": "not immutable",
    "from types import MappingProxyType\nX = MappingProxyType({'a': []})": "not immutable",
    "X = tuple([[]])": "not immutable",
    "X = frozenset(set())": "not immutable",
    "X = [].append": "not immutable",
    "from dataclasses import dataclass\n@dataclass\nclass P:\n    x: list\nX = P(x=[])": "not immutable",
    (
        "from dataclasses import dataclass\n@dataclass(frozen=True)\nclass P:\n    x: list\n"
        "X = P([])  # frozen, but holding a list"
    ): "not immutable",
    "X = 0\nX += 1": "changed at import time",
    "for i in range(3):\n    pass": "loop or with-block",
    "T = tuple(y := [])": ":=",
    "if True:\n    CACHE = {}": "not immutable",
    "from samsulek.strategies import demo\ndemo.register('x')": "expression runs at import time",
    "match 1:\n    case 1:\n        CACHE = {}": "Match statement runs at import time",
    "import decimal\ndef f():\n    decimal.getcontext().traps[decimal.Inexact] = True": "decimal context",
    "from decimal import setcontext, Context\ndef f():\n    setcontext(Context(prec=3))": "decimal context",
    "from decimal import getcontext as g\ndef f():\n    return g().prec": "decimal context",
}
CLEAN_STRATEGY = '''
"""A clean strategy: everything in it is allowed."""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, time, timedelta
from decimal import Decimal, localcontext
from types import MappingProxyType
from typing import TYPE_CHECKING, Final
from zoneinfo import ZoneInfo

from samsulek.strategies.base import StrategyContext
from samsulek.strategies.params import Params, as_params
from samsulek.types import TargetWeights

from . import demo
from ..signals import momentum

if TYPE_CHECKING:
    from samsulek.strategies.base import Strategy

WINDOWS: Final = (10, 20, 40)
NAMES = frozenset({"a", "b"})
LIMITS: Final = MappingProxyType({"gross": 0.9, "nested": MappingProxyType({"x": (1, 2)})})
NESTED = (("a", 1), ("b", -2))
SCALE = 1 / 252
NEG = -1
ParamPair = tuple[str, int | float]
Builder = Callable[[Mapping[str, float]], int]
Alias = demo.EqualWeightAboveAverageDemo
_BERLIN = "Europe/Berlin"
LABEL = f"x{1}"
UPPER = "abc".upper
type Weights = Mapping[str, float]


@dataclass(frozen=True)
class Settings:
    lookback: int = 20
    tags: tuple[str, ...] = ()
    extra: dict[str, float] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class Entry:
    name: str
    settings: Settings
    build: Callable[[int], int]


def _double(x: int) -> int:
    return 2 * x


CATALOG: Final = MappingProxyType({"double": Entry("double", settings=Settings(lookback=5), build=_double)})
DEFAULT_SETTINGS = Settings(tags=("a", "b"))


class Clean:
    name = "clean"
    SIDES = ("buy", "sell")

    def __init__(self, lookback: int = 20, gross: float = 0.9, names: tuple[str, ...] = ()) -> None:
        self._lookback = lookback
        self._cache: dict[str, float] = {}
        self._calls = 0
        self.name = f"clean+{lookback}"
        object.__setattr__(self, "_frozen", True)

    def target_weights(self, ctx: StrategyContext) -> TargetWeights:
        self._calls += 1
        self._cache["x"] = 1.0
        day = ctx.asof.astimezone(ZoneInfo(_BERLIN)).date()
        cache: dict[str, float] = {}
        selected = []
        for symbol, bars in sorted(ctx.bars.items()):
            closes = [b.close for b in bars[-self._lookback :]]
            cache[symbol] = math.fsum(closes)
            if closes and closes[-1] > sum(closes) / len(closes) and bars[-1].open > 0:
                selected.append(symbol)
        with localcontext(prec=10):
            total = Decimal(len(selected)) / 3
        cutoff = time(9, 0)
        weights = {s: 0.0 for s in ctx.bars}
        return TargetWeights(weights=weights, reason=f"{day} {cutoff} {total} {momentum}")
'''


def test_a4_flags_every_trap6_planted_source() -> None:
    for text, expect in TRAP6_PLANTED.items():
        for rel in ("strategies/planted.py", "signals/planted.py", "strategies/sub/planted.py"):
            _flagged(rule_a4, rel, text, expect)


def test_a4_self_test() -> None:
    for text, expect in MORE_A4_PLANTED.items():
        _flagged(rule_a4, "strategies/planted.py", text, expect)
    _clean(rule_a4, "strategies/clean.py", CLEAN_STRATEGY)
    _clean(rule_a4, "signals/momentum.py", CLEAN_STRATEGY.replace("from ..signals import momentum", ""))
    _clean(rule_a4, "backtest/x.py", "import os\nCACHE = {}\n")  # outside the scope


def test_a4_holds_on_the_current_strategies_and_signals() -> None:
    scoped = [src for src in SOURCES if in_dir(src.rel, "strategies", "signals")]
    assert {"strategies/base.py", "strategies/demo.py", "strategies/params.py"} <= {s.rel for s in scoped}
    assert not [v for src in scoped for v in rule_a4(src)]


def test_a5_self_test() -> None:
    for text, expect in {
        "from samsulek.risk.sizing import plan_orders": "plan_orders",
        "def f(p, s):\n    return plan_orders(p, s)": "plan_orders",
        "def f(sizing):\n    return sizing.plan_orders(1)": ".plan_orders",
        "def f(parts, o):\n    return parts.engine.evaluate(o)": ".evaluate",
        "def f(engine, e):\n    engine.observe_equity(e)": ".observe_equity",
        "def f(router, o):\n    router.submit(o)": ".submit",
        "def f(store, o):\n    store.record_submission(o)": ".record_submission",
        "def f(router):\n    router.cancel_non_exits()": ".cancel_non_exits",
        "def f(router):\n    router.flatten()": ".flatten",
        "def f(router, o):\n    send = router.submit\n    send(o)": ".submit",
        "def f(router, o):\n    getattr(router, 'submit')(o)": "getattr of 'submit'",
        "import operator\ndef f(r, o):\n    operator.attrgetter('submit')(r)(o)": "getattr of 'submit'",
        "def f(broker, o):\n    p = broker.place_order\n    p(o)": ".place_order",
    }.items():
        _flagged(rule_a5, "backtest/runner.py", text, expect)
    _clean(
        rule_a5,
        "backtest/runner.py",
        "from samsulek.cycle import run_unlocked_cycle\n"
        "def f(parts, spec, pool, jobs):\n"
        "    parts.router.cancel_all()\n    parts.broker.account()\n"
        "    list(pool.map(len, jobs))\n    return run_unlocked_cycle(parts, spec)\n",
    )
    _clean(rule_a5, "cycle.py", "def f(r, o):\n    return r.submit(o)\n")  # the core itself is out of scope


def test_a6_self_test() -> None:
    for name, allowed in A6_NAMES.items():
        for text in (
            f"from samsulek.x import {name}",
            f"from samsulek.x import {name} as alias",
            f"import samsulek.x\nsamsulek.x.{name}",
            f"def f(m):\n    return m.{name}",
            f"def f(m):\n    return getattr(m, {name!r})",
            f"def {name}():\n    pass",
            f"import operator\ndef f(m):\n    return operator.attrgetter('x.{name}')(m)",
            f"TARGET = 'samsulek.x.{name}'",
        ):
            for rel in ("backtest/parallel.py", "app.py", "kill.py", "data/x.py"):
                if rel not in allowed:
                    _flagged(rule_a6, rel, text, f"references {name}")
        for rel in allowed:
            _clean(rule_a6, rel, f"from samsulek.x import {name}\n{name}\n")
    for text in (
        'P = "research/risk_research.yaml"',
        "# reads risk_research.yaml\nx = 1",
        "RISK_RESEARCH = 1",
    ):
        _flagged(rule_a6, "backtest/orchestrate.py", text, "mentions risk_research")
        _flagged(rule_a6, "cli.py", text, "mentions risk_research")
        _clean(rule_a6, "backtest/limits.py", text)
    _clean(rule_a6, "backtest/runner.py", '"""Calls run_unlocked_cycle, never run_cycle_core."""\n')
    _clean(rule_a6, "backtest/x.py", "MSG = 'run the holdout once; build the parts'\n")


def test_a7_self_test() -> None:
    for text, expect in {
        "def f(p):\n    return RiskStateStore(p)": "calls RiskStateStore(",
        "def f(m, p):\n    return m.Ledger(p)": "calls Ledger(",
        "def f(p, c):\n    return DecisionLog(p, c)": "calls DecisionLog(",
        "def f(p, c):\n    return RunLock(p, c)": "calls RunLock(",
        "def f(r):\n    return build_app(r)": "calls build_app(",
        "def f(r):\n    load_env_file(r)": "calls load_env_file(",
        "def f(r):\n    setup_logging(r)": "calls setup_logging(",
        "def f():\n    return SystemClock()": "calls SystemClock(",
        "def f():\n    return ConsoleAlerter()": "calls ConsoleAlerter(",
        "def f(m):\n    return getattr(m, 'SystemClock')()": "getattr of 'SystemClock'",
        "from samsulek.risk.state import RiskStateStore as S\ndef f(p):\n    return S(p)": "renaming hides",
        "from samsulek.risk.state import RiskStateStore\ndef f(p):\n    k = RiskStateStore\n    return k()": (
            "uses RiskStateStore as a value"
        ),
        "import functools\nfrom samsulek.clock import SystemClock\nf = functools.partial(SystemClock)": (
            "uses SystemClock as a value"
        ),
        "from samsulek.risk.state import RiskStateStore\n"
        "class M(RiskStateStore):\n    def __init__(self, p):\n        super().__init__(p)": (
            "runs RiskStateStore.__init__"
        ),
        "import samsulek.logging_setup as ls\n"
        "class M(ls.DecisionLog):\n    def __init__(self, p, c):\n        super(M, self).__init__(p, c)": (
            "runs DecisionLog.__init__"
        ),
        "from samsulek.logging_setup import DecisionLog\n"
        "class M(DecisionLog):\n    def __init__(self, p, c):\n        DecisionLog.__init__(self, p, c)": (
            "uses DecisionLog as a value"
        ),
        "P = 'state/halt.json'": "path literal",
        "P = 'C:\\\\bot\\\\logs\\\\x.jsonl'": "path literal",
        "def f(root):\n    return root / 'state'": "joins a path",
        "def f(root):\n    return root / 'logs' / 'x'": "joins a path",
        "def f():\n    return Path('state')": "builds a path",
        "def f(root):\n    return root.joinpath('logs')": "builds a path",
        "def f(root):\n    return root / STATE_DIR": "uses STATE_DIR",
        "def f(cfg):\n    return cfg.log_dir": "uses .log_dir",
        "def f(cfg):\n    return cfg.state_dir": "uses .state_dir",
    }.items():
        _flagged(rule_a7, "backtest/x.py", text, expect)
    _clean(
        rule_a7,
        "backtest/inmemory.py",
        '''
        """Never touches the bot's state/ or logs/ folders."""
        from samsulek.risk.state import RiskStateStore
        from samsulek.portfolio.ledger import Ledger
        from samsulek.logging_setup import DecisionLog

        class MemoryRiskStateStore(RiskStateStore):
            def __init__(self) -> None:
                self.dir = None

        class MemoryLedger(Ledger):
            def __init__(self) -> None:
                super().__init__(None)

        class MemoryDecisionLog(DecisionLog):
            def __init__(self, clock) -> None:
                self._clock = clock

        def f(record, store: RiskStateStore, ledger: Ledger | None = None) -> Ledger | None:
            record["state"] = "PASS"
            x: DecisionLog | None = None
            return isinstance(store, (RiskStateStore, DecisionLog)), "the state of the run", MemoryLedger(), x
        ''',
    )
    _clean(rule_a7, "app.py", "def f(p, c):\n    return RiskStateStore(p), SystemClock()\n")


def test_a8_self_test() -> None:
    for text, expect in {
        "def f(parts):\n    return parts.broker._prices": "private ._prices",
        "def f(store):\n    store._write_json('x', {})": "private ._write_json",
        "def f():\n    return super()._load()": "private ._load",
        "def f(cycle):\n    return cycle._window": "private ._window",
        "def f(x):\n    return x.__secret": "private .__secret",
        "from samsulek.cycle import _blocked": "imports the private _blocked",
        "import samsulek._internal": "private module",
        "def f(x):\n    return getattr(x, '_prices')": "getattr of '_prices'",
        "import operator\ndef f(b):\n    return operator.attrgetter('x._prices')(b)": "getattr of '_prices'",
        "def f(b):\n    return object.__getattribute__(b, '_prices')": "getattr of '_prices'",
        "def peek(self):\n    return self._prices": "private ._prices",  # not a method: no receiver
        "class A:\n    @staticmethod\n    def f(self):\n        return self._x": "private ._x",
        "def f(b):\n    return vars(b)['_prices']": "vars() of another object",
        "def f(b):\n    return b.__dict__['_prices']": "__dict__",
        "class A:\n    def f(self, other):\n        self = other\n        return self._x": "rebinds self",
    }.items():
        _flagged(rule_a8, "backtest/x.py", text, expect)
    _clean(
        rule_a8,
        "backtest/x.py",
        "from __future__ import annotations\n"
        "class A:\n"
        "    def f(self, other):\n"
        "        self._x = 1\n        self.__y = 2\n"
        "        object.__setattr__(self, '_z', 3)\n"
        "        get = lambda: self._x\n"
        "        def inner():\n            return self._x\n"
        "        return type(other).__name__, other.public, super().__init__, get, inner, vars(self)\n"
        "    @classmethod\n"
        "    def g(cls):\n        return cls._z\n",
    )
    _clean(rule_a8, "cycle.py", "def f(x):\n    return x._private\n")


def test_a9_self_test() -> None:
    for text in (
        "import multiprocessing",
        "from multiprocessing import get_context",
        "import multiprocessing.pool as mp",
        "from concurrent.futures import ProcessPoolExecutor",
        "from concurrent import futures",
        "import concurrent.futures",
        "import concurrent\nx = concurrent.futures.ThreadPoolExecutor",
    ):
        for rel in ("backtest/orchestrate.py", "backtest/runner.py", "cli.py", "data/recorder/runner.py"):
            _flagged(rule_a9, rel, text, "reaches")
        _clean(rule_a9, "backtest/parallel.py", text)
    for text in (
        "import subprocess\ndef f():\n    subprocess.run(['x'])",
        "import threading\ndef f(g):\n    threading.Thread(target=g).start()",
        "from _thread import start_new_thread",
        "import asyncio",
        "import os\ndef f():\n    return os.fork()",
        "import os\ndef f():\n    os.system('x')",
        "import os\ndef f():\n    os.execv('x', [])",
    ):
        for rel in ("backtest/runner.py", "costs/x.py", "strategies/x.py"):
            _flagged(rule_a9, rel, text, "one process and thread")
        _clean(rule_a9, "data/recorder/runner.py", text)  # research code only
    _clean(rule_a9, "backtest/x.py", "import concurrent_tools\nimport os\nx = os.devnull\n")


def test_a10_self_test() -> None:
    planted = {
        "import random\ndef f():\n    return random.random()": "random.random",
        "import random\ndef f(xs):\n    return random.choice(xs)": "random.choice",
        "import random\nrandom.seed(1)": "random.seed",
        "from random import shuffle": "random.shuffle",
        "import random\ndef f():\n    return random.SystemRandom()": "random.SystemRandom",
        "import random\ndef f():\n    return random.Random()": "without a seed",
        "from random import Random as R\ndef f():\n    return R()": "without a seed",
        "import random\ndef f():\n    return random.Random(None)": "random.Random(None)",
        "import random\ndef f():\n    return random.Random(x=None)": "random.Random(None)",
        "import random\ndef f():\n    r = random.Random(1)\n    r.seed()": ".seed() without a seed",
        "def f(rng):\n    rng.seed(None)": ".seed() without a seed",
        "import random\ndef f(s):\n    return random.Random(hash(s))": "PYTHONHASHSEED",
        "def f(xs):\n    return sorted(xs, key=hash)\ndef g(x):\n    return hash(x) % 7": "PYTHONHASHSEED",
        "from datetime import datetime\ndef f():\n    return datetime.now()": "wall clock",
        "import datetime as dt\ndef f():\n    return dt.datetime.utcnow()": "wall clock",
        "from datetime import date\ndef f():\n    return date.today()": "wall clock",
        "def f():\n    return datetime.today()": "wall clock",
        "from datetime import UTC\ndef f(ts):\n    return ts.now(UTC)": ".now(tz)",
        "def f(ts):\n    return type(ts).now(tz=None)": ".now(tz)",
        "def f(d):\n    return type(d).today()": ".today",
        "import time\ndef f():\n    return time.time()": "wall clock",
        "from time import monotonic": "wall clock",
        "import time\nclock = time.monotonic_ns": "wall clock",
        "import time\ndef f():\n    return time.localtime()": "time.localtime",
        "import time\ndef f():\n    time.sleep(1)": "time.sleep",
        "import time as t\ndef f():\n    return t.process_time()": "time.process_time",
        "from time import strftime": "time.strftime",
        "import uuid\ndef f():\n    return uuid.uuid4()": "OS entropy",
        "import os\ndef f():\n    return os.urandom(8)": "OS entropy",
        "import secrets": "OS entropy",
    }
    for text, expect in planted.items():
        for rel in ("backtest/x.py", "costs/x.py", "strategies/x.py"):
            _flagged(rule_a10, rel, text, expect)
    perf = "import time\ndef f():\n    return time.perf_counter()"
    for rel in ("backtest/runner.py", "costs/x.py", "strategies/x.py"):
        _flagged(rule_a10, rel, perf, "time.perf_counter")
    for rel in A10_PERF_ALLOWED:
        _clean(rule_a10, rel, perf)
        _clean(
            rule_a10,
            rel,
            "from time import perf_counter, perf_counter_ns\nx = perf_counter() + perf_counter_ns()",
        )
    _clean(
        rule_a10,
        "backtest/x.py",
        "import random\nfrom datetime import date, datetime, time\n"
        "def f(rng: random.Random, seed: int, clock):\n"
        "    r = random.Random(seed)\n    r2 = random.Random(x=seed)\n    r.seed(seed)\n"
        "    return r.random(), rng.choice([1]), clock.now(), time(9, 0), time.max, date(2024, 1, 2), r2\n"
        "class K:\n    def __hash__(self):\n        return hash((1, 2))\n",
    )
    _clean(rule_a10, "net/http.py", "import time\nx = time.monotonic()\n")  # not research code


def test_a11_self_test() -> None:
    for text in (
        "import duckdb\ncon = duckdb.connect(':memory:')",
        "import duckdb as d\ncon = d.connect()",
        "from duckdb import connect",
        "import duckdb\nduckdb.sql('select 1')",
        "import duckdb\ncon = getattr(duckdb, 'connect')()",
    ):
        for rel in ("data/market.py", "backtest/sources.py", "cli.py"):
            _flagged(rule_a11, rel, text, "duckdb.")
        _clean(rule_a11, "data/store.py", text)
    _clean(
        rule_a11,
        "data/market.py",
        "import duckdb\nfrom samsulek.data.store import connect\n"
        "def f(root) -> duckdb.DuckDBPyConnection:\n    return connect(root)\n",
    )


def test_a12_self_test() -> None:
    for text, expect in {
        "def f(p):\n    return open(p)": "calls open(",
        "def f(p):\n    return p.open('w')": "calls .open(",
        "import gzip\ndef f(p):\n    return gzip.open(p)": "calls .open(",
        "def f():\n    o = open\n    return o": "builtin open",
        (
            "from dataclasses import dataclass\n@dataclass\nclass Row:\n    open: float\n"
            "def f():\n    return [open]"
        ): "builtin open",
        "def f(p):\n    p.write_text('x')": ".write_text",
        "def f(p):\n    p.write_bytes(b'x')": ".write_bytes",
        "def f(p):\n    p.mkdir()": ".mkdir",
        "def f(p):\n    p.touch()": ".touch",
        "def f(p):\n    p.unlink()": ".unlink",
        "import os\ndef f(a, b):\n    os.replace(a, b)": "os.replace",
        "import os\ndef f(fd):\n    os.fsync(fd)": "os.fsync",
        "from os import replace": "os.replace",
        "import os\ndef f(p):\n    os.makedirs(p)": "os.makedirs",
        "import os\ndef f(fd):\n    os.write(fd, b'x')": "os.write",
        "import os\ndef f(p):\n    os.remove(p)": "os.remove",
        "import shutil\ndef f(a, b):\n    shutil.copy(a, b)": "shutil.copy",
        "import tempfile": "tempfile",
        "import sqlite3\ndef f(p):\n    return sqlite3.connect(p)": "sqlite3",
        "import zipfile\ndef f(p):\n    return zipfile.ZipFile(p, 'w')": "zipfile",
        "import logging\ndef f(p):\n    return logging.FileHandler(p)": "logging.FileHandler",
        "import gzip\ndef f(p):\n    return gzip.GzipFile(p, 'wb')": "gzip.GzipFile",
        "from gzip import GzipFile\ndef f(p):\n    return GzipFile(filename=p, mode='wb')": "gzip.GzipFile",
        "from samsulek.risk.state import atomic_write_text": "file helper",
        "from samsulek.fsutil import fsync_file": "samsulek.fsutil",
    }.items():
        for rel in ("backtest/runner.py", "backtest/orchestrate.py", "backtest/inmemory.py"):
            _flagged(rule_a12, rel, text, expect)
        for rel in A12_ALLOWED:
            _clean(rule_a12, rel, text)
    _clean(
        rule_a12,
        "backtest/feed.py",
        "import gzip\nimport io\nimport os\nfrom pathlib import Path\n"
        "NOWHERE = Path(os.devnull) / 'x'\n"
        "def f(bar, text, path, open):\n"
        "    buf = io.BytesIO()\n    z = gzip.compress(b'x', mtime=0)\n"
        "    with gzip.GzipFile(fileobj=buf, mode='wb', mtime=0) as fh:\n        fh.write(b'x')\n"
        "    return bar.open, text.replace('a', 'b'), path.name, z, buf, open, path.read_bytes()\n",
    )
    _clean(rule_a12, "data/store.py", "def f(p):\n    p.mkdir()\n    return open(p)\n")


# =============================================================================== plants in real files
REAL_FILE_PLANTS = [
    # (rule, real file, appended violation, expected message part)
    ("A1", "risk/engine.py", "from samsulek.backtest.types import RunJob as _PlantedRunJob", "reaches"),
    ("A1", "data/market.py", "import samsulek\n_PLANTED = getattr(samsulek, 'backtest')", "reaches"),
    (
        "A2",
        "backtest/runner.py",
        "from samsulek.app import build_app as _planted_build",
        "reaches samsulek.app",
    ),
    ("A2", "costs/stocks.py", "from samsulek.risk.engine import RiskEngine as _PlantedEngine", "reaches"),
    ("A3", "data/store.py", "from samsulek.costs import BPS as _PLANTED_BPS", "reaches samsulek.costs"),
    ("A4", "strategies/demo.py", "_PLANTED_CACHE: dict[str, float] = {}", "not immutable"),
    ("A4", "strategies/registry.py", "def _planted(d):\n    return d.now()", ".now"),
    ("A4", "strategies/params.py", "def _planted(self):\n    self.calls = 1", "shared object"),
    ("A5", "backtest/runner.py", "def _planted(parts, o):\n    return parts.router.submit(o)", ".submit"),
    ("A6", "backtest/parallel.py", "def _planted(m):\n    return m.build_parts", "references build_parts"),
    ("A7", "backtest/inmemory.py", "def _planted(p):\n    return RiskStateStore(p)", "calls RiskStateStore("),
    ("A7", "backtest/inmemory.py", "def _planted(p):\n    k = DecisionLog\n    return k(p)", "as a value"),
    ("A8", "backtest/runner.py", "def _planted(parts):\n    return parts.broker._prices", "private ._prices"),
    ("A9", "backtest/orchestrate.py", "import multiprocessing as _planted_mp", "reaches multiprocessing"),
    ("A10", "backtest/synthetic_data.py", "import random\n_PLANTED = random.random()", "random.random"),
    ("A10", "costs/memecoin.py", "def _planted(s):\n    return random.Random(hash(s))", "PYTHONHASHSEED"),
    ("A11", "backtest/sources.py", "import duckdb\n_PLANTED = duckdb.connect()", "duckdb.connect"),
    ("A12", "backtest/sources.py", "def _planted():\n    f = open\n    return f", "builtin open"),
    ("A12", "backtest/inmemory.py", "def _planted(p):\n    p.write_text('x')", ".write_text"),
]


@pytest.mark.parametrize(("rule_id", "rel", "plant", "expect"), REAL_FILE_PLANTS)
def test_rules_catch_plants_in_real_files(rule_id: str, rel: str, plant: str, expect: str) -> None:
    real = next(src for src in SOURCES if src.rel == rel)
    assert not RULES[rule_id](real), f"{rel} already violates {rule_id}"
    _flagged(RULES[rule_id], rel, real.text.rstrip("\n") + "\n\n\n" + plant + "\n", expect)


def test_every_rule_has_a_self_test() -> None:
    names = set(globals())
    for rule_id in RULES:
        assert f"test_{rule_id.lower()}_self_test" in names, rule_id
    assert {rule_id for rule_id, *_ in REAL_FILE_PLANTS} == set(RULES)
