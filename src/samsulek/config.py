"""Typed configuration. Unknown keys are errors (a typo in a limit must not be ignored)."""

from __future__ import annotations

import tomllib
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


# Fixed locations, relative to the project root. They are deliberately NOT configurable:
# both files are protected by the guard hook, and a config entry pointing elsewhere
# would bypass that protection (and the live gate).
RISK_FILE = Path("config/risk.yaml")
CHECKLIST_FILE = Path("ops/go_live_checklist.md")
# The state folder holds the KILL and HALT flags: pointing the bot at another folder
# would silently drop them, so it is fixed too.
STATE_DIR = Path("state")
PROJECT_NAME = "samsulek"
PROJECT_MARKERS = (Path("pyproject.toml"), Path("config/default.yaml"))
# The project this code was installed from (uv installs it in editable mode).
PACKAGE_PROJECT_ROOT = Path(__file__).resolve().parents[2]


def is_project_root(path: Path) -> bool:
    """A samsulek project folder: both marker files, and pyproject.toml names this project."""
    if not all((path / m).is_file() for m in PROJECT_MARKERS):
        return False
    try:
        data = tomllib.loads((path / "pyproject.toml").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    project = data.get("project")
    return isinstance(project, dict) and project.get("name") == PROJECT_NAME


def project_roots_above(start: Path) -> list[Path]:
    """Every samsulek project folder at or above ``start``, nearest first. More than one
    means a checkout inside another (e.g. a Claude Code worktree under .claude/worktrees)."""
    start = start.resolve()
    return [c for c in (start, *start.parents) if is_project_root(c)]


def find_project_root(start: Path) -> Path | None:
    """The nearest folder at or above ``start`` that is this project."""
    roots = project_roots_above(start)
    return roots[0] if roots else None


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


class RecorderConfig(BaseModel):
    """The Solana research recorder. Defaults stay well inside the free providers' limits."""

    model_config = _STRICT

    solana_rpc_url: str = "https://api.mainnet.solana.com"
    discovery_pages: int = Field(default=10, ge=1, le=10)
    discovery_interval_seconds: int = Field(default=150, ge=60)
    snapshot_per_mille: int = Field(default=250, ge=0, le=1000)
    holders_per_mille: int = Field(default=50, ge=0, le=1000)

    @field_validator("solana_rpc_url")
    @classmethod
    def _https_only(cls, v: str) -> str:
        if not v.startswith("https://") or "@" in v:
            raise ValueError("solana_rpc_url must be a plain https:// URL (no credentials in it)")
        return v

    @model_validator(mode="after")
    def _holders_within_snapshots(self) -> Self:
        if self.holders_per_mille > self.snapshot_per_mille:
            raise ValueError("holders_per_mille cannot exceed snapshot_per_mille")
        return self


class DataConfig(BaseModel):
    model_config = _STRICT

    data_dir: Path = Path("data")
    user_agent: str = Field(default="samsulek/0.1 (personal research)", min_length=8)
    fx_currencies: list[str] = Field(default_factory=lambda: ["USD", "GBP", "CHF"])
    recorder: RecorderConfig = RecorderConfig()

    @field_validator("data_dir")
    @classmethod
    def _not_the_state_dir(cls, v: Path) -> Path:
        if Path(v) == STATE_DIR:
            raise ValueError("data_dir must not be the state folder")
        return v

    @field_validator("fx_currencies")
    @classmethod
    def _iso_codes(cls, v: list[str]) -> list[str]:
        for c in v:
            if len(c) != 3 or not c.isalpha() or not c.isupper() or c == "EUR":
                raise ValueError(f"invalid currency code {c!r}")
        if len(set(v)) != len(v):
            raise ValueError("currency listed twice")
        return v


class AppConfig(BaseModel):
    model_config = _STRICT

    mode: Mode = Mode.SIM
    state_dir: Path = STATE_DIR
    log_dir: Path
    env_file: Path
    universe: dict[Market, list[str]]
    sim: SimConfig
    alerts: AlertsConfig = AlertsConfig()
    data: DataConfig = DataConfig()

    @field_validator("mode")
    @classmethod
    def _no_live_in_config(cls, v: Mode) -> Mode:
        if v is Mode.LIVE:
            raise ValueError(
                "live mode can't be set in a config file; it needs `--mode live` on the command line"
            )
        return v

    @field_validator("state_dir")
    @classmethod
    def _fixed_state_dir(cls, v: Path) -> Path:
        if Path(v) != STATE_DIR:
            raise ValueError("state_dir is fixed to 'state' (it holds the kill switch and halt flags)")
        return v

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
                "env_file": anchor(self.env_file),
                "data": self.data.model_copy(update={"data_dir": anchor(self.data.data_dir)}),
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
