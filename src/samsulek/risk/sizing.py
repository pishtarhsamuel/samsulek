"""Turn a strategy's target weights into concrete limit orders.

Sizing is NOT trusted: the risk engine re-checks every order independently.
Sizing just tries hard not to propose orders that would be rejected:
- weights are clipped to [0, max_position_pct] and scaled to max_gross_exposure_pct
- buys use only cash on hand now (sell proceeds are not assumed)
- quantities round DOWN to the broker's step; buy limits round DOWN and sell
  limits round UP to the price tick, so the slippage cap is never crossed
- sells come before buys
- targets aim at 98% of each cap (``CAP_HEADROOM``), so small equity drift from
  earlier fills in the same cycle doesn't push later orders over a hard limit
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from decimal import ROUND_CEILING, ROUND_FLOOR, Decimal

from samsulek.config import MarketLimits
from samsulek.types import Market, OrderRequest, OrderType, PortfolioSnapshot, Quote, Side, TargetWeights

BPS = Decimal(10_000)
CAP_HEADROOM = Decimal("0.98")


class SizingError(ValueError):
    """Targets can't be turned into orders safely (e.g. NaN weights, missing price)."""


def floor_to_step(value: Decimal, step: Decimal) -> Decimal:
    if value <= 0:
        return Decimal(0)
    return (value / step).to_integral_value(rounding=ROUND_FLOOR) * step


def ceil_to_step(value: Decimal, step: Decimal) -> Decimal:
    return (value / step).to_integral_value(rounding=ROUND_CEILING) * step


def clean_weights(targets: TargetWeights, limits: MarketLimits) -> dict[str, Decimal]:
    """Validate and clip weights. Long-only: negatives become 0. NaN/inf is an error."""
    cleaned: dict[str, Decimal] = {}
    for symbol, w in targets.weights.items():
        if not isinstance(w, (int, float)) or math.isnan(w) or math.isinf(w):
            raise SizingError(f"invalid weight for {symbol}: {w!r}")
        d = Decimal(repr(float(w)))
        cleaned[symbol] = min(max(d, Decimal(0)), limits.max_position_pct)
    total = sum(cleaned.values(), Decimal(0))
    if total > limits.max_gross_exposure_pct:
        scale = limits.max_gross_exposure_pct / total
        cleaned = {s: floor_to_step(w * scale, Decimal("0.000001")) for s, w in cleaned.items()}
    return cleaned


def plan_orders(
    *,
    targets: TargetWeights,
    market: Market,
    portfolio: PortfolioSnapshot,
    quotes: Mapping[str, Quote],
    limits: MarketLimits,
    quantity_step: Decimal,
    price_tick: Decimal,
    id_prefix: str,
) -> list[OrderRequest]:
    weights = clean_weights(targets, limits)
    equity = portfolio.equity(quotes)
    if equity <= 0:
        return []
    collar = limits.max_slippage_bps / BPS
    held = {s for s, p in portfolio.positions.items() if p.market is market and p.quantity > 0}
    symbols = sorted(set(weights) | held)

    def price(symbol: str) -> Decimal:
        q = quotes.get(symbol)
        if q is None:
            raise SizingError(f"no price for {symbol}")
        return q.price

    position_cap = min(limits.max_position_pct * equity, limits.max_position_eur) * CAP_HEADROOM

    def target_value(symbol: str) -> Decimal:
        w = weights.get(symbol, Decimal(0))
        return min(w * equity, position_cap)

    def why(symbol: str) -> str:
        return f"rebalance toward {weights.get(symbol, Decimal(0)):.4f} of equity: {targets.reason}"

    sells: list[OrderRequest] = []
    buys: list[OrderRequest] = []
    n = 0

    for symbol in symbols:
        qty_held = portfolio.quantity(symbol)
        if qty_held <= 0:
            continue
        ref = price(symbol)
        limit = ceil_to_step(ref * (1 - collar), price_tick)
        if limit <= 0:
            continue
        target = target_value(symbol)
        if target <= 0:
            to_sell = qty_held  # full exit
        else:
            excess = qty_held * ref - target
            if excess < limits.min_order_eur:
                continue
            to_sell = min(floor_to_step(excess / ref, quantity_step), qty_held)
        # Split into chunks that respect max_order_eur (valued at the sell limit, as the
        # engine does). A final chunk below min_order_eur is left as dust: normal sells
        # must respect the minimum; `samsulek kill --flatten` can still clear it.
        max_chunk = floor_to_step(limits.max_order_eur / limit, quantity_step)
        remaining = to_sell
        while remaining > 0 and max_chunk > 0:
            qty = min(remaining, max_chunk)
            if qty * limit < limits.min_order_eur:
                break
            n += 1
            sells.append(
                OrderRequest(
                    client_id=f"{id_prefix}-{n:03d}-sell-{symbol}",
                    market=market,
                    symbol=symbol,
                    side=Side.SELL,
                    quantity=qty,
                    order_type=OrderType.LIMIT,
                    limit_price=limit,
                    reason=why(symbol),
                )
            )
            remaining -= qty

    cash = portfolio.cash
    gross = portfolio.gross_exposure(quotes, market)
    gross_cap = min(limits.max_gross_exposure_pct * equity, limits.max_gross_exposure_eur) * CAP_HEADROOM
    shortfalls = []
    for symbol in symbols:
        ref = price(symbol)
        gap = target_value(symbol) - portfolio.quantity(symbol) * ref
        if gap >= limits.min_order_eur:
            shortfalls.append((gap, symbol, ref))
    for gap, symbol, ref in sorted(shortfalls, key=lambda t: (-t[0], t[1])):
        limit = floor_to_step(ref * (1 + collar), price_tick)
        if limit <= 0:
            continue
        budget = min(gap, limits.max_order_eur, cash, gross_cap - gross)
        qty = floor_to_step(budget / limit, quantity_step)
        cost = qty * limit
        if qty <= 0 or cost < limits.min_order_eur:
            continue
        cash -= cost
        gross += qty * max(limit, ref)
        n += 1
        buys.append(
            OrderRequest(
                client_id=f"{id_prefix}-{n:03d}-buy-{symbol}",
                market=market,
                symbol=symbol,
                side=Side.BUY,
                quantity=qty,
                order_type=OrderType.LIMIT,
                limit_price=limit,
                reason=why(symbol),
            )
        )
    return sells + buys
