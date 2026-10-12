"""Shared builders for tests. Limits here are FIXED test values, independent of config/risk.yaml."""

from __future__ import annotations

import copy
import itertools
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from samsulek.config import RiskConfig
from samsulek.types import Market, OrderRequest, OrderType, PortfolioSnapshot, Position, Quote, Side

T0 = datetime(2026, 10, 12, 8, 0, tzinfo=UTC)  # 11:00 in Athens

BASE_RISK: dict[str, Any] = {
    "version": 1,
    "base_currency": "EUR",
    "account": {
        "max_daily_loss_pct": "0.03",
        "max_drawdown_pct": "0.15",
        "max_trades_per_day": 8,
        "equity_sanity_max_eur": "200",
        "risk_day_timezone": "Europe/Athens",
    },
    "markets": {
        "stocks": {
            "max_position_pct": "0.30",
            "max_gross_exposure_pct": "1.00",
            "max_position_eur": "20",
            "max_order_eur": "20",
            "max_gross_exposure_eur": "60",
            "min_order_eur": "1",
            "max_trades_per_day": 6,
            "max_slippage_bps": "50",
            "flatten_max_slippage_bps": "200",
            "max_quote_age_seconds": 900,
            "allow_market_orders": False,
            "max_pool_liquidity_pct": None,
            "require_safety_pass": False,
        },
        "memecoin": {
            "max_position_pct": "0.05",
            "max_gross_exposure_pct": "0.20",
            "max_position_eur": "5",
            "max_order_eur": "5",
            "max_gross_exposure_eur": "10",
            "min_order_eur": "1",
            "max_trades_per_day": 5,
            "max_slippage_bps": "300",
            "flatten_max_slippage_bps": "1000",
            "max_quote_age_seconds": 30,
            "allow_market_orders": False,
            "max_pool_liquidity_pct": "0.005",
            "require_safety_pass": True,
        },
    },
}

UNIVERSE = {Market.STOCKS: ["AAA", "BBB", "CCC"], Market.MEMECOIN: ["MEME"]}


def _merge(base: dict[str, Any], over: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(base)
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def risk_dict(**overrides: Any) -> dict[str, Any]:
    return _merge(BASE_RISK, overrides)


def make_risk_config(**overrides: Any) -> RiskConfig:
    return RiskConfig.model_validate(risk_dict(**overrides))


def q(
    symbol: str,
    price: str | Decimal,
    ts: datetime = T0,
    market: Market = Market.STOCKS,
    **kw: Any,
) -> Quote:
    return Quote(symbol=symbol, market=market, price=Decimal(price), ts=ts, **kw)


def pf(
    cash: str | Decimal,
    positions: dict[str, str | Decimal | tuple[str | Decimal, Market]] | None = None,
    ts: datetime = T0,
) -> PortfolioSnapshot:
    pos: dict[str, Position] = {}
    for sym, spec in (positions or {}).items():
        qty, market = spec if isinstance(spec, tuple) else (spec, Market.STOCKS)
        pos[sym] = Position(sym, market, Decimal(qty), Decimal("1"))
    return PortfolioSnapshot(cash=Decimal(cash), positions=pos, ts=ts)


_ids = itertools.count(1)


def order(
    symbol: str,
    side: Side,
    qty: str | Decimal,
    limit: str | Decimal | None,
    market: Market = Market.STOCKS,
    reduce_only: bool = False,
    order_type: OrderType = OrderType.LIMIT,
) -> OrderRequest:
    return OrderRequest(
        client_id=f"t-{next(_ids)}",
        market=market,
        symbol=symbol,
        side=side,
        quantity=Decimal(qty),
        order_type=order_type,
        limit_price=Decimal(limit) if limit is not None else None,
        reduce_only=reduce_only,
    )
