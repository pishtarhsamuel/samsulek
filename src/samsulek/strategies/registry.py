"""The strategy catalog a study may name, with its parameter ranges (M3 skeleton; WP4 fills it in).

Every entry builds a FRESH strategy instance on each call (one per cycle, as in the bot),
and ``window`` says how many bars per symbol the strategy needs. M3 has one entry,
``demo_above_average``: the plumbing demo (lookback int 2..400, gross float 0.05..1.0;
window = lookback). It has no edge. This module is inside the strategy import whitelist
(rule A4): module-level values are literals, tuples, ``MappingProxyType(...)``, names or
functions only.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Final, Literal

from samsulek.strategies.base import Strategy
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
    raise NotImplementedError("WP4")


def _demo_above_average_window(params: Mapping[str, ParamValue]) -> int:
    raise NotImplementedError("WP4")


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
    raise NotImplementedError("WP4")


def validate_params(entry: StrategyEntry, params: Mapping[str, ParamValue]) -> dict[str, ParamValue]:
    raise NotImplementedError("WP4")
