from __future__ import annotations

from decimal import Decimal
from pathlib import Path

import pytest
import yaml

from helpers import risk_dict
from samsulek.config import ConfigError, RiskConfig, load_app_config, load_risk_config
from samsulek.types import Market, Mode

ROOT = Path(__file__).resolve().parents[1]


def write(tmp_path: Path, data: object, name: str = "risk.yaml") -> Path:
    p = tmp_path / name
    p.write_text(yaml.safe_dump(data), encoding="utf-8")
    return p


def test_repo_configs_are_valid() -> None:
    risk = load_risk_config(ROOT / "config" / "risk.yaml")
    app = load_app_config(ROOT / "config" / "default.yaml", ROOT)
    assert app.mode is Mode.SIM, "the committed default mode must be sim"
    assert risk.account.max_daily_loss_pct > 0
    assert set(risk.markets) == {Market.STOCKS, Market.MEMECOIN}
    assert app.state_dir == ROOT / "state"


def test_repo_memecoin_limits_require_safety_and_pool_cap() -> None:
    meme = load_risk_config(ROOT / "config" / "risk.yaml").limits_for(Market.MEMECOIN)
    assert meme.require_safety_pass
    assert meme.max_pool_liquidity_pct is not None


def test_yaml_floats_become_exact_decimals(tmp_path: Path) -> None:
    data = risk_dict()
    data["account"]["max_daily_loss_pct"] = 0.03  # a YAML float, not a string
    cfg = load_risk_config(write(tmp_path, data))
    assert cfg.account.max_daily_loss_pct == Decimal("0.03")


@pytest.mark.parametrize(
    ("path", "value", "message"),
    [
        (("account", "max_daily_loss_pct"), "0", "greater than 0"),
        (("account", "max_daily_loss_pct"), "0.9", "less than or equal"),
        (("account", "risk_day_timezone"), "Mars/Olympus", "unknown timezone"),
        (("markets", "stocks", "max_gross_exposure_pct"), "1.5", "less than or equal to 1"),
        (("markets", "stocks", "max_position_pct"), "-0.1", "greater than 0"),
        (("markets", "stocks", "min_order_eur"), "25", "min_order_eur must be below"),
        (("markets", "stocks", "flatten_max_slippage_bps"), "10", "flatten_max_slippage_bps"),
        (("markets", "stocks", "max_position_eur"), "100", "max_position_eur cannot exceed"),
        (("version",), 2, "version"),
        (("base_currency",), "USD", "base_currency"),
    ],
)
def test_invalid_limits_are_rejected(
    tmp_path: Path, path: tuple[str, ...], value: object, message: str
) -> None:
    data = risk_dict()
    node = data
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = value
    with pytest.raises(ConfigError, match=message):
        load_risk_config(write(tmp_path, data))


def test_unknown_key_is_an_error(tmp_path: Path) -> None:
    data = risk_dict()
    data["markets"]["stocks"]["max_postion_pct"] = "0.5"  # typo must not be silently ignored
    with pytest.raises(ConfigError, match="Extra inputs are not permitted"):
        load_risk_config(write(tmp_path, data))


def test_missing_file_and_bad_yaml(tmp_path: Path) -> None:
    with pytest.raises(ConfigError, match="cannot read"):
        load_risk_config(tmp_path / "nope.yaml")
    bad = tmp_path / "bad.yaml"
    bad.write_text("account: [unclosed", encoding="utf-8")
    with pytest.raises(ConfigError, match="invalid YAML"):
        load_risk_config(bad)


def test_duplicate_symbols_rejected(tmp_path: Path) -> None:
    data = yaml.safe_load((ROOT / "config" / "default.yaml").read_text(encoding="utf-8"))
    data["universe"]["memecoin"] = ["DEMO_GOLD"]
    with pytest.raises(ConfigError, match="listed twice"):
        load_app_config(write(tmp_path, data, "app.yaml"), tmp_path)


def test_risk_config_is_immutable() -> None:
    cfg = RiskConfig.model_validate(risk_dict())
    with pytest.raises(ValueError, match="frozen"):
        cfg.account.max_daily_loss_pct = Decimal("0.5")  # type: ignore[misc]
