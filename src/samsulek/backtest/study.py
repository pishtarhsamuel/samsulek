"""A study file: hypothesis, grid, data, costs and validation plan, written before any run.

Facts relied on:
- ``StudySpec`` is a strict, frozen pydantic model with ``extra="forbid"``: a typo in a
  setting is an error, never a silently ignored key. Strict means YAML values are taken
  as they are (``"10"`` is not a number, ``yes`` is not a symbol); the only conversions
  are lists to tuples and YAML numbers to ``Decimal`` for money and bps (via ``repr``,
  like the rest of M3).
- Every string (keys included) is ASCII without control characters other than a line
  break: study texts end up in reports, file names and a Windows console.
- An E-study uses the verified store (``data.source: store``) and at least 200 random
  seeds; an S-study uses synthetic data (``data.source: synthetic``) and at least 20.
  S-studies are plumbing only, never evidence.
- ``load_study`` refuses (``BacktestRefused``, listing every problem it can find) a file
  that is unreadable, larger than 64 KiB, not plain ASCII, has a lone CR, duplicate keys,
  YAML aliases, a number YAML 1.1 would read as something other than the decimal digits
  a person sees (``010`` is 8, ``1:20`` is 80, ``0x10`` is 16, ``1_0`` is 10), or fails
  the schema; it also applies the holdout fence's market check
  (memecoin research is refused in M3). It returns the spec and the sha256 of the file's
  bytes with CR removed: a study id is bound to that hash forever, so a CRLF and an LF
  copy of the same file are the same study, and a lone CR (which YAML reads as a line
  break but the hash would drop) is refused.
- ``variants`` is the product over the grid's SORTED parameter names, each name's values
  in file order (the last name varies fastest); variant i has index i. Every variant is a
  registered trial, so two equal values in one list (including 1, 1.0 and true) are
  refused: they would be the same run counted twice.
"""

from __future__ import annotations

import hashlib
import itertools
import math
import re
from collections.abc import Hashable
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Annotated, Any, Final, Literal

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)
from yaml import SafeLoader, YAMLError
from yaml.composer import ComposerError
from yaml.constructor import ConstructorError
from yaml.error import MarkedYAMLError
from yaml.events import AliasEvent
from yaml.nodes import MappingNode, Node, ScalarNode

from samsulek.backtest.fence import check_market
from samsulek.backtest.types import BacktestRefused, Variant, params_sha256
from samsulek.strategies.params import ParamValue, as_params

_STRICT: Final = ConfigDict(strict=True, frozen=True, extra="forbid")
_MAX_FILE_BYTES: Final = 64 * 1024
_MAX_PARAMS: Final = 12
_MAX_VALUES_PER_PARAM: Final = 20
_MAX_VARIANTS: Final = 200
_E_MIN_SEEDS: Final = 200
_STARTING_CASH_EUR: Final = Decimal(50)  # fixed in M3 (owner Q16)
_DEFAULT: Final = "default"  # the half-spread key that applies to every symbol without its own
_SYMBOL: Final = r"^[A-Z0-9][A-Za-z0-9_.]{0,29}$"  # starts upper case, so it can never be "default"
_NAME: Final = r"^[a-z][a-z0-9_]{2,40}$"
_PARAM: Final = r"^[a-z][a-z0-9_]{0,39}$"
# Several problems found by one validator travel as one message, one problem per line.
_SEP: Final = "\n"


def _to_decimal(value: object) -> Decimal:
    """A YAML number as a Decimal (floats via repr). Anything else is refused, not converted."""
    if isinstance(value, bool) or not isinstance(value, int | float | Decimal):
        raise ValueError(f"must be a number, got {type(value).__name__}")
    out = value if isinstance(value, Decimal) else Decimal(repr(value) if isinstance(value, float) else value)
    if not out.is_finite():
        raise ValueError(f"must be a finite number, got {value!r}")
    return out


_Number = Annotated[Decimal, BeforeValidator(_to_decimal)]
_NonNegative = Annotated[Decimal, BeforeValidator(_to_decimal), Field(ge=0)]
_Symbol = Annotated[str, Field(pattern=_SYMBOL)]


class AcceptedIssue(BaseModel):
    """A data-quality issue accepted as real after checking it by hand: (symbol, session, code)."""

    model_config = _STRICT

    symbol: _Symbol
    session: date
    code: str = Field(pattern=r"^[a-z][a-z0-9_]{0,40}$")


class StoreDataSpec(BaseModel):
    """Data from the verified point-in-time store (E-studies)."""

    model_config = _STRICT

    source: Literal["store"]
    first: date
    accepted_issues: tuple[AcceptedIssue, ...] = ()


class SyntheticDataSpec(BaseModel):
    """Seeded synthetic data (S-studies: plumbing only)."""

    model_config = _STRICT

    source: Literal["synthetic"]
    seed: int = Field(ge=0)
    first: date
    accepted_issues: tuple[AcceptedIssue, ...] = ()


class CostsSpec(BaseModel):
    """Per-side costs in bps (UNVERIFIED defaults; the 2x rerun doubles every one)."""

    model_config = _STRICT

    half_spread_bps: dict[str, _NonNegative]  # "default" and/or one entry per universe symbol
    slippage_bps: _NonNegative
    adverse_bps: _NonNegative
    fx_fee_bps: _NonNegative
    commission_eur: _NonNegative  # the cost guard refuses anything but 0 in M3


class TimingSpec(BaseModel):
    model_config = _STRICT

    exec_delay_minutes: int = Field(ge=0, le=10)
    reset_lead_minutes: int = Field(ge=1, le=120)


class WalkForwardSpec(BaseModel):
    """Anchored walk-forward only (M3)."""

    model_config = _STRICT

    min_train_years: int = Field(ge=2, le=15)
    test_months: int = Field(ge=3, le=24)


class BaselinesSpec(BaseModel):
    model_config = _STRICT

    random_seeds: int = Field(ge=20, le=5000)  # E-studies: at least 200 (checked on the spec)


class HoldoutAcceptanceSpec(BaseModel):
    """The holdout's pass rule, fixed before the holdout is run. A negative Sharpe threshold
    would accept a losing strategy, so ``min_sharpe`` is at least 0."""

    model_config = _STRICT

    min_sharpe: float = Field(ge=0.0, le=5.0, allow_inf_nan=False)
    must_beat_buy_and_hold: bool
    must_survive_2x: bool


class StudySpec(BaseModel):
    """The study file schema of spec section 7.6. Containers are tuples, except the two
    name-keyed tables (``grid``, ``costs.half_spread_bps``): treat them as read-only."""

    model_config = _STRICT

    version: int = Field(ge=1, le=1)
    study: str = Field(pattern=r"^[ES][0-9]{3}$")
    family: str = Field(pattern=_NAME)
    title: str = Field(min_length=3, max_length=120)
    hypothesis: str = Field(min_length=40, max_length=2000)
    written: date
    market: Literal["stocks", "memecoin"]  # memecoin is refused by the fence in load_study
    strategy: str = Field(pattern=_NAME)
    grid: dict[str, tuple[ParamValue, ...]]
    lag_sessions: int = Field(ge=0, le=5)
    universe: tuple[_Symbol, ...] = Field(min_length=1, max_length=10)
    data: Annotated[StoreDataSpec | SyntheticDataSpec, Field(discriminator="source")]
    last_session: date
    starting_cash_eur: _Number
    costs: CostsSpec
    timing: TimingSpec
    walk_forward: WalkForwardSpec
    baselines: BaselinesSpec
    holdout_acceptance: HoldoutAcceptanceSpec

    @model_validator(mode="before")
    @classmethod
    def _plain_ascii_tuples(cls, data: Any) -> Any:
        problems = sorted(set(_text_problems(data, "")))
        if problems:
            raise ValueError(_SEP.join(problems))
        return _tuples(data)

    @field_validator("title")
    @classmethod
    def _one_line(cls, value: str) -> str:
        if "\n" in value or not value.strip():
            raise ValueError("the title must be one non-blank line")
        return value

    @field_validator("hypothesis")
    @classmethod
    def _written_out(cls, value: str) -> str:
        if len(value.strip()) < 40:
            raise ValueError("the hypothesis must be at least 40 characters of text, written before running")
        return value

    @field_validator("grid")
    @classmethod
    def _grid_limits(cls, grid: dict[str, tuple[ParamValue, ...]]) -> dict[str, tuple[ParamValue, ...]]:
        problems = _grid_problems(grid)
        if problems:
            raise ValueError(_SEP.join(problems))
        return grid

    @model_validator(mode="after")
    def _coherent(self) -> StudySpec:
        problems = _cross_field_problems(self)
        if problems:
            raise ValueError(_SEP.join(problems))
        return self


def _text_problems(value: object, where: str) -> list[str]:
    """Every string (and mapping key) that is not ASCII or holds a control character."""
    out: list[str] = []
    if isinstance(value, str):
        if not value.isascii():
            out.append(f"{where or 'the file'}: text must be plain ASCII (no accents, no euro sign)")
        elif any((ord(c) < 32 and c != "\n") or ord(c) == 127 for c in value):
            out.append(f"{where or 'the file'}: text must not hold control characters")
    elif isinstance(value, dict):
        for key, item in value.items():
            name = f"{where}.{key}" if where else str(key)
            out.extend(_text_problems(key, where or "a key"))
            out.extend(_text_problems(item, _ascii(name)))
    elif isinstance(value, list | tuple):
        for i, item in enumerate(value):
            out.extend(_text_problems(item, f"{where}[{i}]"))
    return out


def _tuples(value: object) -> object:
    """Lists (from YAML) as tuples, recursively, so the spec holds no mutable sequences."""
    if isinstance(value, dict):
        return {k: _tuples(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return tuple(_tuples(v) for v in value)
    return value


def _grid_problems(grid: dict[str, tuple[ParamValue, ...]]) -> list[str]:
    problems: list[str] = []
    if not 1 <= len(grid) <= _MAX_PARAMS:
        problems.append(f"grid: needs 1 to {_MAX_PARAMS} parameters, got {len(grid)}")
    combinations = 1
    for name, values in grid.items():
        if not isinstance(name, str) or not re.fullmatch(_PARAM, name):
            problems.append(f"grid: parameter name {_ascii(repr(name))} must match {_PARAM}")
        if not 1 <= len(values) <= _MAX_VALUES_PER_PARAM:
            problems.append(f"grid.{name}: needs 1 to {_MAX_VALUES_PER_PARAM} values, got {len(values)}")
        for value in values:
            if isinstance(value, float) and not math.isfinite(value):
                problems.append(f"grid.{name}: {value!r} is not a finite number")
            if isinstance(value, str) and "\n" in value:  # it would break report tables
                problems.append(f"grid.{name}: a text value must be one line")
        for (i, a), (j, b) in itertools.combinations(enumerate(values), 2):
            if a == b:  # 1, 1.0 and true are all equal: the strategy would get the same value
                problems.append(f"grid.{name}: values {i} and {j} are equal ({a!r}, {b!r}): one trial, twice")
        combinations *= max(1, len(values))
    if combinations > _MAX_VARIANTS:
        problems.append(f"grid: {combinations} combinations, at most {_MAX_VARIANTS} allowed")
    return problems


def _cross_field_problems(spec: StudySpec) -> list[str]:
    problems: list[str] = []
    e_study = spec.study.startswith("E")
    if e_study != (spec.data.source == "store"):
        problems.append(
            f"study {spec.study}: an E-study must use data.source 'store' and an S-study 'synthetic' "
            f"(this one uses {spec.data.source!r})"
        )
    if e_study and spec.baselines.random_seeds < _E_MIN_SEEDS:
        problems.append(
            f"baselines.random_seeds: an E-study needs at least {_E_MIN_SEEDS}, "
            f"got {spec.baselines.random_seeds}"
        )
    if len(set(spec.universe)) != len(spec.universe):
        repeated = sorted({s for s in spec.universe if spec.universe.count(s) > 1})
        problems.append(f"universe: symbols listed twice: {repeated}")
    if spec.starting_cash_eur != _STARTING_CASH_EUR:
        problems.append(
            f"starting_cash_eur: must be exactly {_STARTING_CASH_EUR} in M3, got {spec.starting_cash_eur}"
        )
    if spec.data.first >= spec.last_session:
        problems.append(f"data.first {spec.data.first} must be before last_session {spec.last_session}")
    universe = set(spec.universe)
    spreads = spec.costs.half_spread_bps
    unknown = sorted(k for k in spreads if k != _DEFAULT and k not in universe)
    if unknown:
        problems.append(f"costs.half_spread_bps: {unknown} are not in the universe (a typo would be ignored)")
    if _DEFAULT not in spreads:
        uncovered = sorted(universe - set(spreads))
        if uncovered:
            problems.append(f"costs.half_spread_bps: no 'default' and no entry for {uncovered}")
    issues = spec.data.accepted_issues
    strangers = sorted({i.symbol for i in issues} - universe)
    if strangers:
        problems.append(f"data.accepted_issues: {strangers} are not in the universe")
    keys = [(i.symbol, i.session, i.code) for i in issues]
    if len(set(keys)) != len(keys):
        problems.append("data.accepted_issues: the same issue is listed twice")
    return problems


class _StudyLoader(SafeLoader):
    """YAML's safe loader, plus two refusals a hand-edited study file needs: a duplicate key
    (plain YAML keeps the last one silently) and an alias (``*name`` repeats other text, so
    what is read is not what is written there; it is also the "billion laughs" bomb)."""

    def compose_node(self, parent: Node | None, index: int) -> Node | None:
        if self.check_event(AliasEvent):
            event = self.peek_event()  # type: ignore[no-untyped-call]  # untyped in the PyYAML stubs
            raise ComposerError(
                None, None, "aliases (*name) are not allowed in a study file", event.start_mark
            )
        return super().compose_node(parent, index)

    def construct_mapping(self, node: MappingNode, deep: bool = False) -> dict[Hashable, Any]:
        seen: list[object] = []
        for key_node, _value_node in node.value:
            key = self.construct_object(key_node, deep=True)
            if key in seen:
                raise ConstructorError(
                    "while reading a mapping",
                    node.start_mark,
                    f"found the key {key!r} twice",
                    key_node.start_mark,
                )
            seen.append(key)
        return super().construct_mapping(node, deep=deep)


# YAML 1.1 reads a leading 0 as octal, 0x/0b as hex/binary, a:b as base 60, and drops "_":
# the value used would not be the number a person reads in the file.
_PLAIN_INT: Final = re.compile(r"[-+]?(?:0|[1-9][0-9]*)")


def _plain_int(loader: SafeLoader, node: ScalarNode) -> int:
    text = loader.construct_scalar(node)
    if not _PLAIN_INT.fullmatch(text):
        raise ConstructorError(
            None,
            None,
            f"write the number {text!r} in plain decimal digits (YAML would not read it as written)",
            node.start_mark,
        )
    return loader.construct_yaml_int(node)


def _plain_float(loader: SafeLoader, node: ScalarNode) -> float:
    text = loader.construct_scalar(node)
    if ":" in text or "_" in text:
        raise ConstructorError(
            None,
            None,
            f"write the number {text!r} in plain decimal digits (YAML would not read it as written)",
            node.start_mark,
        )
    return loader.construct_yaml_float(node)


_StudyLoader.add_constructor("tag:yaml.org,2002:int", _plain_int)
_StudyLoader.add_constructor("tag:yaml.org,2002:float", _plain_float)


def _ascii(text: str) -> str:
    return text.encode("ascii", "backslashreplace").decode("ascii")


def _yaml_problem(exc: YAMLError) -> str:
    """One line: where and what (PyYAML's own text spans several lines with a caret)."""
    if isinstance(exc, MarkedYAMLError) and exc.problem_mark is not None:
        mark = exc.problem_mark
        return _ascii(f"line {mark.line + 1}, column {mark.column + 1}: {exc.problem}")
    return _ascii(" ".join(str(exc).split()))


def _refuse(shown: str, *problems: str) -> BacktestRefused:
    return BacktestRefused([f"study file {shown}: {p}" for p in problems])


def _schema_problems(exc: ValidationError) -> list[str]:
    out: list[str] = []
    for err in exc.errors(include_url=False, include_input=False):
        loc = list(err["loc"])
        if loc[:1] == ["data"] and loc[1:2] in (["store"], ["synthetic"]):
            del loc[1]  # pydantic's tag of the data kind, not a key of the file
        where = ".".join(str(part) for part in loc)
        if err["type"] == "extra_forbidden":
            message = "unknown setting (a typo?)"
        else:
            message = str(err["msg"]).removeprefix("Value error, ")
        for line in message.split(_SEP):
            if line.strip():
                out.append(_ascii(f"{where}: {line}" if where else line))
    return out or ["the file does not match the study schema"]


def load_study(path: Path) -> tuple[StudySpec, str]:
    """``(spec, sha256 of the file's bytes with CR removed)``. ``BacktestRefused`` if anything is wrong."""
    shown = _ascii(str(path))
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise _refuse(shown, f"cannot be read ({_ascii(exc.strerror or type(exc).__name__)})") from None
    if len(raw) > _MAX_FILE_BYTES:
        raise _refuse(shown, f"is {len(raw)} bytes; a study file is at most {_MAX_FILE_BYTES}")
    try:
        text = raw.decode("ascii")
    except UnicodeDecodeError as exc:
        line = raw[: exc.start].count(b"\n") + 1
        raise _refuse(
            shown,
            f"line {line} is not plain ASCII (save it as plain text without accents, the euro sign or a BOM)",
        ) from None
    if "\r" in text.replace("\r\n", ""):
        raise _refuse(shown, "holds a carriage return that does not end a line (use LF or CRLF line endings)")
    sha = hashlib.sha256(raw.replace(b"\r", b"")).hexdigest()
    loader = _StudyLoader(text)
    try:
        data = loader.get_single_data()
    except YAMLError as exc:
        raise _refuse(shown, f"is not valid YAML: {_yaml_problem(exc)}") from None
    finally:
        loader.dispose()
    if not isinstance(data, dict):
        raise _refuse(shown, "must be a YAML mapping of settings (version, study, family, ...)")
    try:
        spec = StudySpec.model_validate(data)
    except ValidationError as exc:
        raise _refuse(shown, *_schema_problems(exc)) from None
    check_market(spec.market)
    return spec, sha


def variants(spec: StudySpec) -> tuple[Variant, ...]:
    """Every grid point: the product over the sorted parameter names, values in file order."""
    names = sorted(spec.grid)
    out: list[Variant] = []
    for index, combo in enumerate(itertools.product(*(spec.grid[name] for name in names))):
        params = as_params(dict(zip(names, combo, strict=True)))
        out.append(Variant(index=index, params=params, params_sha256=params_sha256(params)))
    if len({v.params_sha256 for v in out}) != len(out):
        raise ValueError(f"study {spec.study}: two grid points have the same parameters")
    return tuple(out)
