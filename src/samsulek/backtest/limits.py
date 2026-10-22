"""The two risk configurations of every study: L (config/risk.yaml verbatim) and R (M3 spec 7.4).

Facts relied on:
- R relaxes only the limits that would stop a tiny account from showing a strategy's
  shape: the account's daily loss and drawdown limits become 50% and 90% hard stops (the
  schema maxima), the equity sanity maximum goes to EUR 1e9, and every market's EUR caps
  on a position and on gross exposure go to EUR 1e6. Every other leaf stays equal:
  percentage caps, collars, flatten collar, quote age, minimum and maximum order (the EUR
  20 maximum order stays), trade counts, market orders, pool percentage, safety pass and
  the risk-day timezone.
- ``derive_research_config`` dumps the live config, replaces those leaves and runs
  ``RiskConfig.model_validate`` again, so the R config passes every schema check the bot's
  own config does (``model_copy`` would skip validation, so it is never used).
- The R file research/risk_research.yaml is NEVER read by the bot: only this module loads
  it, and it must equal ``derive_research_config(config/risk.yaml)`` leaf by leaf, checked
  on every load (a mismatch is a ``ConfigError``: regenerate the file in a reviewed
  change). That file name may appear only in this module (rule A6).
- ``load_mode_configs`` loads both files with the bot's own ``load_risk_config`` and
  records the sha256 of each file's bytes (read before and after parsing: a file that
  changes while it is read is refused).
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from decimal import Decimal
from pathlib import Path
from types import MappingProxyType
from typing import Any, Final

from samsulek.backtest.types import ModeConfigs
from samsulek.config import RISK_FILE, ConfigError, RiskConfig, load_risk_config

RESEARCH_RISK_FILE: Final = Path("research") / "risk_research.yaml"
RELAXED_ACCOUNT: Final[Mapping[str, Decimal]] = MappingProxyType(
    {
        "max_daily_loss_pct": Decimal("0.5"),
        "max_drawdown_pct": Decimal("0.9"),
        "equity_sanity_max_eur": Decimal("1000000000"),
    }
)
RELAXED_MARKET: Final[Mapping[str, Decimal]] = MappingProxyType(  # every market
    {
        "max_position_eur": Decimal("1000000"),
        "max_gross_exposure_eur": Decimal("1000000"),
    }
)


def derive_research_config(live: RiskConfig) -> RiskConfig:
    """Dump, replace the relaxed leaves, ``RiskConfig.model_validate`` (never ``model_copy``)."""
    data = live.model_dump(mode="python")
    data["account"] = {**data["account"], **RELAXED_ACCOUNT}
    data["markets"] = {market: {**limits, **RELAXED_MARKET} for market, limits in data["markets"].items()}
    return RiskConfig.model_validate(data)


def _leaves(data: Any, prefix: str) -> dict[str, Any]:
    """Every leaf of a dumped config as ``{"account.max_daily_loss_pct": value, ...}``."""
    if isinstance(data, Mapping):
        out: dict[str, Any] = {}
        for key in sorted(data, key=str):
            out.update(_leaves(data[key], f"{prefix}.{key}" if prefix else str(key)))
        return out
    return {prefix: data}


def research_config_problems(live: RiskConfig, research: RiskConfig) -> list[str]:
    """Every leaf where ``research`` differs from ``derive_research_config(live)``; [] if equal."""
    expected = _leaves(derive_research_config(live).model_dump(mode="json"), "")
    actual = _leaves(research.model_dump(mode="json"), "")
    problems: list[str] = []
    for key in sorted(expected.keys() | actual.keys()):
        if key not in actual:
            problems.append(f"{key}: missing from the research limits (expected {expected[key]!r})")
        elif key not in expected:
            problems.append(f"{key}: in the research limits but not in config/risk.yaml ({actual[key]!r})")
        elif not _same(expected[key], actual[key]):
            problems.append(
                f"{key}: research limits have {actual[key]!r}, "
                f"derived from config/risk.yaml {expected[key]!r}"
            )
    return problems


def _number(value: Any) -> Decimal | None:
    if isinstance(value, bool) or not isinstance(value, int | float | str | Decimal):
        return None
    try:
        number = Decimal(str(value))
    except ArithmeticError:
        return None
    return number if number.is_finite() else None


def _same(a: Any, b: Any) -> bool:
    """Equal leaves: numbers compare as numbers (0.50 == 0.5, as the parsed configs do), the
    rest (booleans, None, timezone names) by type and value."""
    na, nb = _number(a), _number(b)
    if na is not None and nb is not None:
        return na == nb
    return type(a) is type(b) and bool(a == b)


def _read_bytes(path: Path) -> bytes:
    try:
        return path.read_bytes()
    except OSError as exc:
        raise ConfigError(f"cannot read {path}: {exc}") from exc


def _load(path: Path) -> tuple[RiskConfig, str]:
    before = _read_bytes(path)
    config = load_risk_config(path)
    if _read_bytes(path) != before:
        raise ConfigError(f"{path} changed while it was being read; run again")
    return config, hashlib.sha256(before).hexdigest()


def load_mode_configs(root: Path) -> ModeConfigs:
    """Both risk configurations; ``ConfigError`` if either is invalid or R does not match L."""
    replay, replay_sha = _load(root / RISK_FILE)
    research, research_sha = _load(root / RESEARCH_RISK_FILE)
    problems = research_config_problems(replay, research)
    if problems:
        raise ConfigError(
            f"{RESEARCH_RISK_FILE.as_posix()} does not match derive_research_config({RISK_FILE.as_posix()}) "
            "(regenerate it in a reviewed change):\n" + "\n".join(f"  - {p}" for p in problems)
        )
    return ModeConfigs(
        replay=replay, research=research, replay_sha256=replay_sha, research_sha256=research_sha
    )
