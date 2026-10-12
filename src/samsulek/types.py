"""Core domain types shared by backtest, paper and live trading.

Money, prices and quantities are ``Decimal`` (EUR). Research-side data (bars,
weights) is ``float``. All timestamps must be timezone-aware.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from enum import StrEnum


class Market(StrEnum):
    STOCKS = "stocks"
    MEMECOIN = "memecoin"


class Mode(StrEnum):
    SIM = "sim"  # local simulated broker (default)
    PAPER = "paper"  # broker demo environment
    LIVE = "live"  # real money: needs LIVE=true + --mode live + TTY phrase + signed checklist


class Side(StrEnum):
    BUY = "buy"
    SELL = "sell"


class OrderType(StrEnum):
    LIMIT = "limit"
    MARKET = "market"


class OrderStatus(StrEnum):
    OPEN = "open"
    FILLED = "filled"
    CANCELLED = "cancelled"
    REJECTED = "rejected"


class MissingQuoteError(LookupError):
    """A price needed to value the portfolio is missing. Callers must fail closed."""


def require_aware(ts: datetime, what: str) -> None:
    if ts.tzinfo is None or ts.utcoffset() is None:
        raise ValueError(f"{what} must be timezone-aware, got naive {ts!r}")


def _require_positive(value: Decimal, what: str) -> None:
    if not isinstance(value, Decimal) or not value.is_finite() or value <= 0:
        raise ValueError(f"{what} must be a finite Decimal > 0, got {value!r}")


def _require_non_negative(value: Decimal, what: str) -> None:
    if not isinstance(value, Decimal) or not value.is_finite() or value < 0:
        raise ValueError(f"{what} must be a finite Decimal >= 0, got {value!r}")


@dataclass(frozen=True, slots=True)
class Quote:
    """A reference price observed at ``ts``. Used for valuation and order collars."""

    symbol: str
    market: Market
    price: Decimal
    ts: datetime
    pool_liquidity_eur: Decimal | None = None  # memecoins: total pool liquidity
    safety_passed: bool | None = None  # memecoins: latest safety-filter verdict

    def __post_init__(self) -> None:
        _require_positive(self.price, f"quote price for {self.symbol}")
        require_aware(self.ts, f"quote timestamp for {self.symbol}")
        if self.pool_liquidity_eur is not None:
            _require_non_negative(self.pool_liquidity_eur, f"pool liquidity for {self.symbol}")


@dataclass(frozen=True, slots=True)
class OrderRequest:
    """What we want to trade. Produced by sizing, checked by the risk engine."""

    client_id: str
    market: Market
    symbol: str
    side: Side
    quantity: Decimal
    order_type: OrderType = OrderType.LIMIT
    limit_price: Decimal | None = None
    reduce_only: bool = False
    reason: str = ""

    def __post_init__(self) -> None:
        if not self.client_id:
            raise ValueError("client_id is required")
        _require_positive(self.quantity, f"order quantity for {self.symbol}")
        if self.order_type is OrderType.LIMIT:
            if self.limit_price is None:
                raise ValueError("limit orders need a limit_price")
            _require_positive(self.limit_price, f"limit price for {self.symbol}")
        elif self.limit_price is not None:
            raise ValueError("market orders must not carry a limit_price")


@dataclass(frozen=True, slots=True)
class Position:
    symbol: str
    market: Market
    quantity: Decimal
    avg_price: Decimal

    def __post_init__(self) -> None:
        _require_non_negative(self.quantity, f"position quantity for {self.symbol}")  # long-only
        _require_non_negative(self.avg_price, f"average price for {self.symbol}")


@dataclass(frozen=True, slots=True)
class PortfolioSnapshot:
    """Filled positions and cash, plus orders still OPEN at the broker.

    Open orders matter for risk: a resting buy will consume cash and add exposure
    the moment it fills, and a resting sell already claims part of a position.
    """

    cash: Decimal
    positions: Mapping[str, Position]
    ts: datetime
    open_orders: tuple[OrderRequest, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.cash, Decimal) or not self.cash.is_finite():
            raise ValueError(f"cash must be a finite Decimal, got {self.cash!r}")
        require_aware(self.ts, "portfolio timestamp")

    def quantity(self, symbol: str) -> Decimal:
        pos = self.positions.get(symbol)
        return pos.quantity if pos else Decimal(0)

    def open_quantity(self, symbol: str, side: Side) -> Decimal:
        return sum(
            (o.quantity for o in self.open_orders if o.symbol == symbol and o.side is side), Decimal(0)
        )

    def sellable_quantity(self, symbol: str) -> Decimal:
        """Held quantity not already claimed by an open sell order."""
        return self.quantity(symbol) - self.open_quantity(symbol, Side.SELL)

    def position_value(self, symbol: str, quotes: Mapping[str, Quote]) -> Decimal:
        qty = self.quantity(symbol)
        if qty == 0:
            return Decimal(0)
        quote = quotes.get(symbol)
        if quote is None:
            raise MissingQuoteError(f"no quote for held symbol {symbol}")
        return qty * quote.price

    def gross_exposure(self, quotes: Mapping[str, Quote], market: Market | None = None) -> Decimal:
        total = Decimal(0)
        for symbol, pos in self.positions.items():
            if market is None or pos.market is market:
                total += self.position_value(symbol, quotes)
        return total

    def equity(self, quotes: Mapping[str, Quote]) -> Decimal:
        return self.cash + self.gross_exposure(quotes)


@dataclass(frozen=True, slots=True)
class Fill:
    fill_id: str
    client_id: str
    market: Market
    symbol: str
    side: Side
    quantity: Decimal
    price: Decimal
    fee: Decimal
    ts: datetime

    def __post_init__(self) -> None:
        _require_positive(self.quantity, "fill quantity")
        _require_positive(self.price, "fill price")
        _require_non_negative(self.fee, "fill fee")
        require_aware(self.ts, "fill timestamp")


@dataclass(frozen=True, slots=True)
class BrokerOrder:
    broker_id: str
    request: OrderRequest
    status: OrderStatus
    filled_quantity: Decimal
    ts: datetime


@dataclass(frozen=True, slots=True)
class AccountSnapshot:
    """The broker's view of the account: the source of truth for reconciliation."""

    cash: Decimal
    positions: Mapping[str, Position]
    open_orders: tuple[BrokerOrder, ...]
    ts: datetime

    def __post_init__(self) -> None:
        # A cash account can't have negative or non-finite cash: if the broker says so, fail closed.
        _require_non_negative(self.cash, "broker cash")
        require_aware(self.ts, "account timestamp")

    def to_portfolio(self) -> PortfolioSnapshot:
        return PortfolioSnapshot(
            cash=self.cash,
            positions=dict(self.positions),
            ts=self.ts,
            open_orders=tuple(o.request for o in self.open_orders),
        )


@dataclass(frozen=True, slots=True)
class RiskDecision:
    approved: bool
    order: OrderRequest
    reasons: tuple[str, ...]  # why it was rejected (empty when approved)
    checks: tuple[str, ...]  # what was checked, for the audit trail
    equity: Decimal | None
    halted: bool  # trading is halted after this evaluation


@dataclass(frozen=True, slots=True)
class Bar:
    """One OHLCV bar, labeled by its CLOSE time. Research data, so floats."""

    symbol: str
    close_ts: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float

    def __post_init__(self) -> None:
        require_aware(self.close_ts, f"bar close time for {self.symbol}")


@dataclass(frozen=True, slots=True)
class TargetWeights:
    """A strategy's entire output: desired fraction of equity per symbol, plus why."""

    weights: Mapping[str, float]
    reason: str
    meta: Mapping[str, object] = field(default_factory=dict)
