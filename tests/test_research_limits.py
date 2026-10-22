"""The research (R) risk limits (spec 7.4, test P8).

research/risk_research.yaml must equal derive_research_config(config/risk.yaml) leaf by
leaf; only the five relaxed leaves differ from the bot's limits, every other leaf is
equal; R is never tighter than L (each relaxed leaf is max(live, relaxed), so a live cap
above a relaxed value is kept); every drift is flagged by name; the derived config goes
through full schema validation; load_mode_configs loads both files with the bot's own
load_risk_config and refuses a research file that drifted.
"""

from __future__ import annotations

import copy
import hashlib
import pickle
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
import yaml
from hypothesis import given, settings
from hypothesis import strategies as st

from samsulek.backtest import limits
from samsulek.backtest.limits import (
    RELAXED_ACCOUNT,
    RELAXED_MARKET,
    RESEARCH_RISK_FILE,
    derive_research_config,
    load_mode_configs,
    research_config_problems,
)
from samsulek.backtest.types import ModeConfigs, RiskMode
from samsulek.config import RISK_FILE, ConfigError, RiskConfig, load_risk_config
from samsulek.types import Market

ROOT = Path(__file__).resolve().parents[1]
RELAXED_LEAVES = {f"account.{k}" for k in RELAXED_ACCOUNT} | {
    f"markets.{m.value}.{k}" for m in Market for k in RELAXED_MARKET
}


def leaves(config: RiskConfig) -> dict[str, Any]:
    return limits._leaves(config.model_dump(mode="json"), "")


def live() -> RiskConfig:
    return load_risk_config(ROOT / RISK_FILE)


# =============================================================================== the committed file
def test_the_research_file_equals_the_derived_config() -> None:
    research = load_risk_config(ROOT / RESEARCH_RISK_FILE)
    assert research_config_problems(live(), research) == []
    assert research == derive_research_config(live())


def test_the_research_file_says_it_is_never_read_by_the_bot() -> None:
    text = (ROOT / RESEARCH_RISK_FILE).read_text(encoding="ascii")  # ASCII only
    header = text.split("\nversion:", 1)[0]
    assert all(line.startswith("#") or not line for line in header.splitlines())
    assert "NEVER READ BY THE BOT" in header
    assert "derive_research_config(config/risk.yaml)" in header
    assert "\r" not in text


def test_exactly_the_relaxed_leaves_differ_from_the_bot_limits() -> None:
    bot, research = leaves(live()), leaves(derive_research_config(live()))
    assert bot.keys() == research.keys()
    differ = {k for k in bot if bot[k] != research[k]}
    assert differ == RELAXED_LEAVES  # with today's config/risk.yaml every relaxed leaf moves
    assert research["account.max_daily_loss_pct"] == "0.5"
    assert research["account.max_drawdown_pct"] == "0.9"
    assert research["account.equity_sanity_max_eur"] == "1000000000"
    for market in ("stocks", "memecoin"):
        assert research[f"markets.{market}.max_position_eur"] == "1000000"
        assert research[f"markets.{market}.max_gross_exposure_eur"] == "1000000"
    # spot checks of leaves that must NOT move (spec 7.4)
    for key in (
        "markets.stocks.max_order_eur",
        "markets.stocks.max_position_pct",
        "markets.stocks.max_slippage_bps",
        "markets.stocks.flatten_max_slippage_bps",
        "markets.stocks.max_quote_age_seconds",
        "markets.stocks.min_order_eur",
        "markets.stocks.max_trades_per_day",
        "markets.memecoin.max_pool_liquidity_pct",
        "markets.memecoin.require_safety_pass",
        "account.max_trades_per_day",
        "account.risk_day_timezone",
    ):
        assert research[key] == bot[key], key


def test_the_relaxed_values_are_the_schema_maxima() -> None:
    fields = RiskConfig.model_fields["account"].annotation.model_fields  # type: ignore[union-attr]
    maxima = {
        f: next(m.le for m in fields[f].metadata if hasattr(m, "le"))
        for f in ("max_daily_loss_pct", "max_drawdown_pct")
    }
    assert maxima == {
        "max_daily_loss_pct": RELAXED_ACCOUNT["max_daily_loss_pct"],
        "max_drawdown_pct": RELAXED_ACCOUNT["max_drawdown_pct"],
    }


def test_derive_validates_and_never_copies(monkeypatch: pytest.MonkeyPatch) -> None:
    # A relaxed value outside the schema must fail; model_copy(update=...) would accept it.
    monkeypatch.setattr(limits, "RELAXED_ACCOUNT", {**RELAXED_ACCOUNT, "max_daily_loss_pct": Decimal("0.6")})
    with pytest.raises(ValueError, match="max_daily_loss_pct"):
        derive_research_config(live())
    monkeypatch.setattr(limits, "RELAXED_ACCOUNT", RELAXED_ACCOUNT)
    monkeypatch.setattr(
        limits,
        "RELAXED_MARKET",
        {"max_position_eur": Decimal(2_000_000), "max_gross_exposure_eur": Decimal(1)},
    )
    with pytest.raises(ValueError, match="max_position_eur cannot exceed"):
        derive_research_config(live())


# =============================================================================== never tighter than L
def live_with(changes: dict[str, Any]) -> RiskConfig:
    """The bot's limits with some leaves changed (still a valid config)."""
    data = live().model_dump(mode="json")
    for key, value in changes.items():
        _set(data, key, value)
    return RiskConfig.model_validate(data)


BIG_CAPS = {
    "account.equity_sanity_max_eur": "5000000000",
    "account.max_daily_loss_pct": "0.5",  # the schema maximum: equal to the relaxed value
    "markets.stocks.max_position_eur": "2000000",
    "markets.stocks.max_gross_exposure_eur": "3000000",
    "markets.memecoin.max_gross_exposure_eur": "1500000",  # its position cap stays EUR 5
}
ABOVE_RELAXED = [
    "account.equity_sanity_max_eur",
    "markets.memecoin.max_gross_exposure_eur",
    "markets.stocks.max_gross_exposure_eur",
    "markets.stocks.max_position_eur",
]


def test_live_caps_above_the_relaxed_values_are_kept() -> None:
    rich = live_with(BIG_CAPS)
    derived = leaves(derive_research_config(rich))
    assert derived["account.equity_sanity_max_eur"] == "5000000000"
    assert derived["account.max_daily_loss_pct"] == "0.5"
    assert derived["account.max_drawdown_pct"] == "0.9"  # live 0.15: relaxed
    assert derived["markets.stocks.max_position_eur"] == "2000000"
    assert derived["markets.stocks.max_gross_exposure_eur"] == "3000000"
    assert derived["markets.memecoin.max_position_eur"] == "1000000"  # live 5: relaxed
    assert derived["markets.memecoin.max_gross_exposure_eur"] == "1500000"
    bot = leaves(rich)
    assert {k for k in bot if bot[k] != derived[k]} == RELAXED_LEAVES - {
        *ABOVE_RELAXED,
        "account.max_daily_loss_pct",
    }


def test_a_research_config_tighter_than_the_live_one_is_flagged() -> None:
    """The old derivation (relaxed values written over every live value) is refused for a
    live config above them, by name; the derived config is accepted."""
    rich = live_with(BIG_CAPS)
    overwritten = rich.model_dump(mode="json")
    for key in RELAXED_LEAVES:
        _, _, name = key.rpartition(".")
        _set(overwritten, key, str({**RELAXED_ACCOUNT, **RELAXED_MARKET}[name]))
    problems = research_config_problems(rich, RiskConfig.model_validate(overwritten))
    assert sorted(p.split(":", 1)[0] for p in problems) == ABOVE_RELAXED
    assert research_config_problems(rich, derive_research_config(rich)) == []


EUR_CAP = st.decimals(min_value=Decimal(1), max_value=Decimal("1e10"), places=2)


@settings(max_examples=60, deadline=None)
@given(
    daily=st.decimals(min_value=Decimal("0.001"), max_value=Decimal("0.5"), places=3),
    drawdown=st.decimals(min_value=Decimal("0.001"), max_value=Decimal("0.9"), places=3),
    sanity=EUR_CAP,
    caps=st.lists(st.tuples(EUR_CAP, EUR_CAP), min_size=2, max_size=2),
)
def test_research_is_never_tighter_than_live(
    daily: Decimal, drawdown: Decimal, sanity: Decimal, caps: list[tuple[Decimal, Decimal]]
) -> None:
    changes: dict[str, Any] = {
        "account.max_daily_loss_pct": str(daily),
        "account.max_drawdown_pct": str(drawdown),
        "account.equity_sanity_max_eur": str(sanity),
    }
    for market, pair in zip(("stocks", "memecoin"), caps, strict=True):
        position, gross = sorted(pair)  # the schema needs position <= gross
        changes[f"markets.{market}.max_position_eur"] = str(max(position, Decimal(30)))  # above the order cap
        changes[f"markets.{market}.max_gross_exposure_eur"] = str(max(gross, Decimal(30)))
    bot_config = live_with(changes)
    bot, research = leaves(bot_config), leaves(derive_research_config(bot_config))
    relaxed = {**RELAXED_ACCOUNT, **RELAXED_MARKET}
    for key in bot:
        if key in RELAXED_LEAVES:
            value = Decimal(bot[key])
            assert Decimal(research[key]) == max(value, relaxed[key.rpartition(".")[2]]) >= value, key
        else:
            assert research[key] == bot[key], key


def test_loosening_refuses_a_leaf_that_is_not_a_decimal() -> None:
    assert limits._loosened({"x": Decimal(2), "y": 1}, {"x": Decimal(1)}) == {"x": Decimal(2), "y": 1}
    with pytest.raises(TypeError, match="expected a Decimal"):
        limits._loosened({"x": 0.5}, {"x": Decimal(1)})


def test_derive_leaves_the_bot_config_untouched() -> None:
    bot = live()
    before = bot.model_dump()
    derived = derive_research_config(bot)
    assert bot.model_dump() == before
    assert derived is not bot
    assert derived.account is not bot.account


# =============================================================================== drift detection
def _changed(value: Any, key: str) -> Any:
    """A different, still valid value for ``key``."""
    if isinstance(value, bool):
        return not value
    if value is None:
        return "0.01"
    if isinstance(value, int):
        return value + 1
    if key.endswith("risk_day_timezone"):
        return "Europe/Berlin"
    up = key.endswith(("max_gross_exposure_eur", "flatten_max_slippage_bps"))
    return str(Decimal(value) * (Decimal("1.1") if up else Decimal("0.9")))


def _set(data: dict[str, Any], key: str, value: Any) -> None:
    *path, last = key.split(".")
    node = data
    for part in path:
        node = node[part]
    node[last] = value


ALL_LEAVES = sorted(k for k in leaves(live()) if k not in ("version", "base_currency"))


@pytest.mark.parametrize("key", ALL_LEAVES)
def test_every_drift_is_flagged_by_name(key: str) -> None:
    data = derive_research_config(live()).model_dump(mode="json")
    current = leaves(derive_research_config(live()))[key]
    _set(data, key, _changed(current, key))
    drifted = RiskConfig.model_validate(data)  # still a valid config: only the drift is wrong
    problems = research_config_problems(live(), drifted)
    assert len(problems) == 1, problems
    assert problems[0].startswith(f"{key}: research limits have")


def test_a_missing_market_is_flagged() -> None:
    data = derive_research_config(live()).model_dump(mode="json")
    del data["markets"]["memecoin"]
    problems = research_config_problems(live(), RiskConfig.model_validate(data))
    assert problems
    assert all(p.startswith("markets.memecoin.") and "missing" in p for p in problems)


def test_equal_numbers_written_differently_are_equal() -> None:
    data = derive_research_config(live()).model_dump(mode="json")
    data["account"]["max_daily_loss_pct"] = "0.50"
    data["markets"]["stocks"]["max_position_eur"] = "1E+6"
    assert research_config_problems(live(), RiskConfig.model_validate(data)) == []


def test_numbers_and_flags_are_not_confused() -> None:
    assert limits._same("Europe/Athens", "Europe/Athens")
    assert not limits._same(True, 1)
    assert not limits._same(None, "0")
    assert not limits._same("1", True)
    assert limits._same(900, "900")


# =============================================================================== load_mode_configs
def copy_project(tmp_path: Path, research_text: str | None = None) -> Path:
    (tmp_path / "config").mkdir()
    (tmp_path / "research").mkdir()
    (tmp_path / RISK_FILE).write_bytes((ROOT / RISK_FILE).read_bytes())
    text = (ROOT / RESEARCH_RISK_FILE).read_text(encoding="ascii") if research_text is None else research_text
    (tmp_path / RESEARCH_RISK_FILE).write_text(text, encoding="ascii", newline="\n")
    return tmp_path


def test_load_mode_configs_on_the_repo() -> None:
    modes = load_mode_configs(ROOT)
    assert modes.replay == live()
    assert modes.research == derive_research_config(live())
    assert modes.replay_sha256 == hashlib.sha256((ROOT / RISK_FILE).read_bytes()).hexdigest()
    assert modes.research_sha256 == hashlib.sha256((ROOT / RESEARCH_RISK_FILE).read_bytes()).hexdigest()
    assert modes.for_mode(RiskMode.L) is modes.replay
    assert modes.for_mode(RiskMode.R) is modes.research
    assert pickle.loads(pickle.dumps(modes)) == modes  # noqa: S301 (sent to spawned workers)


def test_load_mode_configs_uses_load_risk_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = copy_project(tmp_path)
    seen: list[Path] = []
    real = limits.load_risk_config

    def spy(path: Path) -> RiskConfig:
        seen.append(path)
        return real(path)

    monkeypatch.setattr(limits, "load_risk_config", spy)
    assert isinstance(load_mode_configs(root), ModeConfigs)
    assert seen == [root / RISK_FILE, root / RESEARCH_RISK_FILE]


def test_a_drifted_research_file_is_refused(tmp_path: Path) -> None:
    data = yaml.safe_load((ROOT / RESEARCH_RISK_FILE).read_text(encoding="ascii"))
    data["markets"]["stocks"]["max_order_eur"] = 50  # a looser order cap than the bot's
    root = copy_project(tmp_path, yaml.safe_dump(data))
    with pytest.raises(ConfigError) as info:
        load_mode_configs(root)
    assert "research/risk_research.yaml does not match" in str(info.value)
    assert "markets.stocks.max_order_eur" in str(info.value)


def test_a_research_file_that_no_longer_matches_a_changed_bot_config_is_refused(tmp_path: Path) -> None:
    root = copy_project(tmp_path)
    risk = yaml.safe_load((root / RISK_FILE).read_text(encoding="utf-8"))
    risk["markets"]["stocks"]["max_order_eur"] = 15  # the owner tightens a limit...
    (root / RISK_FILE).write_text(yaml.safe_dump(risk), encoding="utf-8")
    with pytest.raises(ConfigError, match="max_order_eur"):  # ...and the R file must follow
        load_mode_configs(root)


def test_load_mode_configs_keeps_live_caps_above_the_relaxed_values(tmp_path: Path) -> None:
    root = copy_project(tmp_path)
    rich = live_with(BIG_CAPS)
    (root / RISK_FILE).write_text(yaml.safe_dump(rich.model_dump(mode="json")), encoding="utf-8")
    with pytest.raises(ConfigError) as info:  # the committed R file has the plain relaxed values
        load_mode_configs(root)
    for key in ABOVE_RELAXED:
        assert key in str(info.value)
    research = derive_research_config(rich).model_dump(mode="json")
    (root / RESEARCH_RISK_FILE).write_text(yaml.safe_dump(research), encoding="ascii", newline="\n")
    modes = load_mode_configs(root)
    assert modes.replay == rich and modes.research == derive_research_config(rich)
    assert modes.research.limits_for(Market.STOCKS).max_position_eur == Decimal(2_000_000)
    assert modes.research.account.equity_sanity_max_eur == Decimal(5_000_000_000)


@pytest.mark.parametrize("text", [None, "account: [unclosed", "version: 1\n"])
def test_a_missing_or_invalid_research_file_is_refused(tmp_path: Path, text: str | None) -> None:
    root = copy_project(tmp_path, "" if text is None else text)
    if text is None:
        (root / RESEARCH_RISK_FILE).unlink()
    with pytest.raises(ConfigError):
        load_mode_configs(root)


def test_a_file_that_changes_while_read_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = copy_project(tmp_path)
    real = limits.load_risk_config

    def edit_then_load(path: Path) -> RiskConfig:
        out = real(path)
        path.write_bytes(path.read_bytes() + b"\n# touched\n")
        return out

    monkeypatch.setattr(limits, "load_risk_config", edit_then_load)
    with pytest.raises(ConfigError, match="changed while it was being read"):
        load_mode_configs(root)


def test_the_relaxed_tables_cannot_be_changed_at_run_time() -> None:
    with pytest.raises(TypeError):
        RELAXED_ACCOUNT["max_drawdown_pct"] = Decimal("0.1")  # type: ignore[index]
    with pytest.raises(TypeError):
        RELAXED_MARKET["max_position_eur"] = Decimal(1)  # type: ignore[index]
    assert copy.deepcopy(dict(RELAXED_ACCOUNT)) == dict(RELAXED_ACCOUNT)
