"""Strategy parameters as plain, hashable, picklable data (M3 contract).

A study's grid, a trial's key and a walk-forward plan all carry parameters as
``Params``: a tuple of ``(name, value)`` pairs sorted by name, so equal parameter sets
are equal tuples whatever order a file listed them in, and they can be dict keys,
hashed into trial ids and sent to worker processes. Values are ``int``, ``float``,
``str`` or ``bool`` only; floats must be finite (a NaN can neither be compared nor
written as canonical JSON). Strategies may import this module (it is inside the
strategy import whitelist).
"""

from __future__ import annotations

import math
from collections.abc import Mapping

ParamValue = int | float | str | bool
Params = tuple[tuple[str, ParamValue], ...]  # sorted by name; hashable, picklable


def as_params(values: Mapping[str, ParamValue]) -> Params:
    """``values`` as sorted ``(name, value)`` pairs. Refuses odd names and values."""
    out: list[tuple[str, ParamValue]] = []
    for name, value in values.items():
        if not isinstance(name, str) or not name:
            raise ValueError(f"parameter names must be non-empty strings, got {name!r}")
        if not isinstance(value, int | float | str | bool):
            raise TypeError(f"parameter {name!r} must be int, float, str or bool, got {type(value).__name__}")
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError(f"parameter {name!r} must be finite, got {value!r}")
        out.append((name, value))
    return tuple(sorted(out, key=lambda item: item[0]))
