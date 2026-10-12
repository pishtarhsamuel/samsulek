"""Typed configuration. Unknown keys are errors (a typo in a limit must not be ignored)."""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from typing import Any, Literal, Self
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from samsulek.types import Market, Mode

_STRICT = ConfigDict(frozen=True, extra="forbid")


class ConfigError(ValueError):
    """Configuration is missing or invalid. The bot refuses to start (fail closed)."""


class AccountLimits(BaseModel):
    model_config = _STRICT

    max_daily_loss_pct: Decimal = Field(gt=0, le=Decimal("0.5"))
    max_drawdown_pct: Decimal = Field(gt=0, le=Decimal("0.9"))
    max_trades_per_day: int = Field(ge=0, le=1000)
    equity_sanity_max_eur: Decimal = Field(gt=0)
    risk_day_timezone: str

    @field_validator("risk_day_timezone")
    @classmethod
    def _valid_tz(cls, v: str) -> str:
        try:
            ZoneInfo(v)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError(f"unknown timezone {v!r}") from exc
        return v


class MarketLimits(BaseModel):
    model_config = _STRICT

    max_position_pct: Decimal = Field(gt=0, le=1)
    max_gross_exposure_pct: Decimal = Field(gt=0, le=1)  # le=1: no leverage, ever
    max_position_eur: Decimal = Field(gt=0)
    max_order_eur: Decimal = Field(gt=0)
    max_gross_exposure_eur: Decimal = Field(gt=0)
    min_order_eur: Decimal = Field(ge=0)
    max_trades_per_day: int = Field(ge=0, le=1000)
    max_slippage_bps: Decimal = Field(gt=0, le=2000)
    flatten_max_slippage_bps: Decimal = Field(gt=0, le=5000)
    max_quote_age_seconds: int = Field(gt=0)
    allow_market_orders: bool
    max_pool_liquidity_pct: Decimal | None = Field(default=None, gt=0, le=Decimal("0.1"))
    require_safety_pass: bool

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if self.min_order_eur >= self.max_order_eur:
            raise ValueError("min_order_eur must be below max_order_eur")
        if self.max_position_pct > self.max_gross_exposure_pct:
            raise ValueError("max_position_pct cannot exceed max_gross_exposure_pct")
        if self.max_position_eur > self.max_gross_exposure_eur:
            raise ValueError("max_position_eur cannot exceed max_gross_exposure_eur")
        if self.flatten_max_slippage_bps < self.max_slippage_bps:
            raise ValueError("flatten_max_slippage_bps must be >= max_slippage_bps")
        return self


class RiskConfig(BaseModel):
    model_config = _STRICT

    version: Literal[1]
    base_currency: Literal["EUR"]
    account: AccountLimits
    markets: dict[Market, MarketLimits]

    def limits_for(self, market: Market) -> MarketLimits:
        try:
            return self.markets[market]
        except KeyError as exc:
            raise ConfigError(f"no risk limits configured for market {market.value!r}") from exc


class SimConfig(BaseModel):
    model_config = _STRICT

    starting_cash_eur: Decimal = Field(gt=0)
    fee_eur: Decimal = Field(ge=0)
    fee_bps: Decimal = Field(ge=0)
    slippage_bps: Decimal = Field(ge=0)
    quantity_step: Decimal = Field(gt=0)
    price_tick: Decimal = Field(gt=0)
    seed: int = 7


class AlertsConfig(BaseModel):
    model_config = _STRICT

    telegram_enabled: bool = False


class AppConfig(BaseModel):
    model_config = _STRICT

    mode: Mode = Mode.SIM
    state_dir: Path
    log_dir: Path
    risk_file: Path
    go_live_checklist: Path
    env_file: Path
    universe: dict[Market, list[str]]
    sim: SimConfig
    alerts: AlertsConfig = AlertsConfig()

    @field_validator("universe")
    @classmethod
    def _unique_symbols(cls, v: dict[Market, list[str]]) -> dict[Market, list[str]]:
        seen: set[str] = set()
        for symbols in v.values():
            for s in symbols:
                if not s or s != s.strip():
                    raise ValueError(f"invalid symbol {s!r}")
                if s in seen:
                    raise ValueError(f"symbol {s!r} listed twice")
                seen.add(s)
        return v

    def resolve(self, root: Path) -> AppConfig:
        """Return a copy with every relative path anchored at the project root."""

        def anchor(p: Path) -> Path:
            return p if p.is_absolute() else (root / p)

        return self.model_copy(
            update={
                "state_dir": anchor(self.state_dir),
                "log_dir": anchor(self.log_dir),
                "risk_file": anchor(self.risk_file),
                "go_live_checklist": anchor(self.go_live_checklist),
                "env_file": anchor(self.env_file),
            }
        )


def _load_yaml(path: Path) -> Any:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError(f"cannot read {path}: {exc}") from exc
    try:
        return yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise ConfigError(f"invalid YAML in {path}: {exc}") from exc


def load_risk_config(path: Path) -> RiskConfig:
    data = _load_yaml(path)
    try:
        return RiskConfig.model_validate(data)
    except ValueError as exc:
        raise ConfigError(f"invalid risk config {path}:\n{exc}") from exc


def load_app_config(path: Path, root: Path) -> AppConfig:
    data = _load_yaml(path)
    try:
        return AppConfig.model_validate(data).resolve(root)
    except ValueError as exc:
        raise ConfigError(f"invalid app config {path}:\n{exc}") from exc
