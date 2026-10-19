"""A study file: hypothesis, grid, data, costs and validation plan, written first (M3 skeleton; WP6a).

``StudySpec`` is a strict, frozen pydantic model with ``extra="forbid"`` and ASCII-only
strings; its schema (fields, ranges and the E-study/S-study coupling) is spec section 7.6
and is written by WP6a. ``load_study`` returns the spec and the sha256 of the file's bytes
with CR removed (the id a study is bound to forever). ``variants`` is the product over the
grid's sorted parameter names, each name's values in file order: every variant is a trial.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, ConfigDict

from samsulek.backtest.types import Variant


class StudySpec(BaseModel):
    """The study file schema of spec section 7.6 (WP6a writes the fields)."""

    model_config = ConfigDict(strict=True, frozen=True, extra="forbid")


def load_study(path: Path) -> tuple[StudySpec, str]:
    raise NotImplementedError("WP6a")


def variants(spec: StudySpec) -> tuple[Variant, ...]:
    raise NotImplementedError("WP6a")
