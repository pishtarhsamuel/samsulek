"""The strategy catalog a study may name, with its parameter ranges.

Facts relied on:
- Every entry's ``build`` returns a FRESH strategy instance on each call (the backtest
  builds one per cycle, as the bot does per run), so nothing a strategy keeps on itself
  can carry over from one session to the next.
- ``window`` is how many bars per symbol the strategy needs (the backtest's bar window
  and warm-up are at least this).
- ``validate_params`` is the only way parameters reach ``build``: every declared
  parameter must be present, nothing else may be, ints stay ints (a bool is not an int),
  floats must be finite (an int is accepted and turned into a float), and numbers must lie
  in ``[lo, hi]`` (inclusive). Every problem is listed in one ``ValueError``.
- M3 has one entry, ``demo_above_average``: the M1 plumbing demo (lookback int 2..400,
  gross float 0.05..1.0; window = lookback). It has NO edge and is never to be traded.

This module is inside the strategy import whitelist (rule A4): module-level values are
literals, tuples, ``MappingProxyType(...)``, frozen dataclasses, names or functions only.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Final, Literal

from samsulek.strategies.base import Strategy
from samsulek.strategies.demo import EqualWeightAboveAverageDemo
from samsulek.strategies.params import ParamValue


@dataclass(frozen=True, slots=True)
class ParamDef:
    name: str
    kind: Literal["int", "float", "str", "bool"]
    lo: float | None = None  # inclusive bounds for numbers
    hi: float | None = None


@dataclass(frozen=True, slots=True)
class StrategyEntry:
    name: str
    params: tuple[ParamDef, ...]
    build: Callable[[Mapping[str, ParamValue]], Strategy]  # a FRESH instance every call
    window: Callable[[Mapping[str, ParamValue]], int]  # bars per symbol needed


def _build_demo_above_average(params: Mapping[str, ParamValue]) -> Strategy:
    return EqualWeightAboveAverageDemo(lookback=int(params["lookback"]), gross=float(params["gross"]))


def _demo_above_average_window(params: Mapping[str, ParamValue]) -> int:
    return int(params["lookback"])


STRATEGIES: Final[Mapping[str, StrategyEntry]] = MappingProxyType(
    {
        "demo_above_average": StrategyEntry(
            name="demo_above_average",
            params=(
                ParamDef(name="gross", kind="float", lo=0.05, hi=1.0),
                ParamDef(name="lookback", kind="int", lo=2, hi=400),
            ),
            build=_build_demo_above_average,
            window=_demo_above_average_window,
        )
    }
)


def get_strategy(name: str) -> StrategyEntry:
    """The catalog entry called ``name``; ``ValueError`` naming the known ones otherwise."""
    entry = STRATEGIES.get(name) if isinstance(name, str) else None
    if entry is None:
        raise ValueError(f"unknown strategy {name!r}; the catalog has: {', '.join(sorted(STRATEGIES))}")
    return entry


def _value_problem(definition: ParamDef, value: object) -> tuple[str | None, ParamValue | None]:
    """(problem, normalised value): exactly one of them is None."""
    name, kind = definition.name, definition.kind
    if kind == "bool":
        if not isinstance(value, bool):
            return f"{name} must be true or false, got {value!r}", None
        return None, value
    if kind == "str":
        if not isinstance(value, str):
            return f"{name} must be a string, got {value!r}", None
        return None, value
    if kind == "int":
        if isinstance(value, bool) or not isinstance(value, int):
            return f"{name} must be a whole number, got {value!r}", None
        number: int | float = value
    else:
        if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
            return f"{name} must be a finite number, got {value!r}", None
        number = float(value)
    if definition.lo is not None and number < definition.lo:
        return f"{name} must be at least {definition.lo}, got {value!r}", None
    if definition.hi is not None and number > definition.hi:
        return f"{name} must be at most {definition.hi}, got {value!r}", None
    return None, number


def validate_params(entry: StrategyEntry, params: Mapping[str, ParamValue]) -> dict[str, ParamValue]:
    """The parameters checked against ``entry`` (sorted by name, floats as float).

    ``ValueError`` listing every missing, unknown or invalid parameter.
    """
    declared = {d.name: d for d in entry.params}
    problems = [f"{name} is not a parameter of {entry.name}" for name in sorted(set(params) - set(declared))]
    problems.extend(
        f"{name} is missing (required by {entry.name})" for name in sorted(set(declared) - set(params))
    )
    out: dict[str, ParamValue] = {}
    for name in sorted(set(declared) & set(params)):
        problem, value = _value_problem(declared[name], params[name])
        if problem is not None:
            problems.append(problem)
        elif value is not None:
            out[name] = value
    if problems:
        raise ValueError(f"invalid parameters for {entry.name}: " + "; ".join(problems))
    return out
