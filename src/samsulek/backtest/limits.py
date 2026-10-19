"""The two risk configurations of every study: L (config/risk.yaml verbatim) and R (M3 skeleton; WP5).

R relaxes only the limits that would stop a tiny account from showing a strategy's shape:
the account's daily loss and drawdown limits become 50% and 90% hard stops, the equity
sanity maximum and the per-market EUR caps go to their schema maxima. Every other leaf
(percentage caps, collars, quote age, order sizes, trade counts) stays equal. The R file
research/risk_research.yaml is never read by the bot, and it must equal
``derive_research_config(config/risk.yaml)`` exactly (checked on every load). That file
name may appear only in this module (rule A6).
"""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from pathlib import Path
from types import MappingProxyType
from typing import Final

from samsulek.backtest.types import ModeConfigs
from samsulek.config import RiskConfig

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
    raise NotImplementedError("WP5")


def research_config_problems(live: RiskConfig, research: RiskConfig) -> list[str]:
    raise NotImplementedError("WP5")


def load_mode_configs(root: Path) -> ModeConfigs:
    raise NotImplementedError("WP5")
