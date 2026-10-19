"""Stock and ETF trading costs: spread, slippage, adverse drift and the FX fee (M3 skeleton; WP2).

With ``m`` in {1, 2} and ``c(sym) = m x (half_spread[sym] + slippage + adverse)`` bps, a
buy fills at ``ref x (1 + c/BPS)`` and a sell at ``ref x (1 - c/BPS)`` (not rounded to the
tick, like the simulated broker today); the fee is ``m x fx_fee_bps/BPS x qty x price``
for non-EUR instruments, else 0; ``commission_eur`` must be 0 in M3. Every default is
UNVERIFIED. ``StockCostParams`` is part of the picklable ``EngineContext``: keep its
mappings plain dicts (``MappingProxyType`` does not pickle). This package may not import
the backtester (rule A2): problems come back as lists of strings, and the backtest turns
them into a refusal before any cycle runs (a symbol missing from ``half_spread_bps``
included).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal

from samsulek.config import MarketLimits
from samsulek.types import OrderRequest, Side


@dataclass(frozen=True, slots=True)
class StockCostParams:
    half_spread_bps: Mapping[str, Decimal]  # every universe symbol present (missing -> refused)
    slippage_bps: Decimal
    adverse_bps: Decimal  # drift between the auction print and E
    fx_fee_bps: Decimal
    commission_eur: Decimal  # must be 0 in M3 (fixed fees need fee-aware sizing: M4)
    currency: Mapping[str, str]


@dataclass(frozen=True, slots=True)
class CostBreakdown:
    spread_eur: Decimal
    slippage_eur: Decimal


class StockCostModel:
    """A ``costs.FillPricer`` for stocks at cost multiplier 1 or 2."""

    multiplier: int

    def __init__(self, params: StockCostParams, *, multiplier: int) -> None:
        raise NotImplementedError("WP2")

    def total_bps(self, symbol: str) -> Decimal:
        raise NotImplementedError("WP2")

    def expected_fill_price(self, symbol: str, side: Side, reference: Decimal) -> Decimal:
        raise NotImplementedError("WP2")

    def execution_price(self, order: OrderRequest, reference: Decimal) -> Decimal:
        raise NotImplementedError("WP2")

    def fee(self, order: OrderRequest, quantity: Decimal, price: Decimal) -> Decimal:
        raise NotImplementedError("WP2")

    def fee_for(self, symbol: str, quantity: Decimal, price: Decimal) -> Decimal:
        raise NotImplementedError("WP2")

    def buy_cash_needed(self, order: OrderRequest, quantity: Decimal, price: Decimal) -> Decimal:
        raise NotImplementedError("WP2")

    def attribution(self, symbol: str, quantity: Decimal, reference: Decimal) -> CostBreakdown:
        raise NotImplementedError("WP2")


def cost_guard_problems(
    params: StockCostParams, limits: MarketLimits, *, price_tick: Decimal, min_reference_eur: Decimal
) -> list[str]:
    raise NotImplementedError("WP2")
