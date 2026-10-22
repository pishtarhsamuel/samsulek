"""Stock and ETF trading costs: spread, slippage, adverse drift and the FX fee.

With ``m`` in {1, 2} and ``c(sym) = m x (half_spread[sym] + slippage + adverse)`` bps, a
buy fills at ``ref x (1 + c/BPS)`` and a sell at ``ref x (1 - c/BPS)`` (not rounded to the
tick, like the simulated broker today); the fee is ``m x fx_fee_bps/BPS x qty x price``
for non-EUR instruments, else 0; ``commission_eur`` must be 0 in M3 (a fixed fee needs
fee-aware sizing, which is M4). Every default value is UNVERIFIED (spread, slippage and
the broker's FX fee are owner questions); the 2x rerun is the check.

``StockCostParams`` is part of the picklable ``EngineContext``: it copies its mappings
into read-only ``dict``s that pickle (``MappingProxyType`` does not), so the checked
tables can never be edited afterwards; it cannot be hashed (it holds dicts).
It refuses at construction any value that is not a finite, non-negative ``Decimal`` and
any currency that is not a three-letter upper-case code, so a negative cost can never
make a fill better than the reference. ``StockCostModel`` refuses a multiplier other
than 1 or 2 and a non-zero commission (it has no formula for one: ignoring it would be
optimistic), and raises for a symbol missing from the cost table (never prices it at 0).

``cost_guard_problems`` is the no-fill guard (spec section 5). The engine's buy limit is
``floor_tick(ref x (1 + C))`` with ``C`` the slippage collar, so a buy at ``ref x (1 + c)``
fills whenever ``ref x (C - c) >= tick``; sells are symmetric. Requiring
``m x max(hs + sl + adv) + BPS x tick / min_reference < collar`` (strictly) for m = 1 and
2 therefore guarantees every approved order fills, and ``m x fx_fee <= 100`` bps keeps
the fees inside the 2% cash headroom of sizing. This package may not import the
backtester (rule A2): problems come back as strings, and the backtest turns them into a
refusal before any cycle runs.
"""

from __future__ import annotations

from collections.abc import Collection, Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import Final, NoReturn

from samsulek.config import MarketLimits
from samsulek.costs import BPS
from samsulek.types import Market, OrderRequest, Side

COST_MULTIPLIERS: Final = (1, 2)  # the 1x run and the "every cost doubled" rerun
MAX_FX_FEE_BPS: Final = Decimal(100)  # at any multiplier (keeps fees inside sizing's cash headroom)
EUR: Final = "EUR"


def _decimal_problem(name: str, value: object) -> str | None:
    if not isinstance(value, Decimal) or not value.is_finite() or value < 0:
        return f"{name} must be a finite Decimal >= 0, got {value!a}"
    return None


def _currency_ok(code: object) -> bool:
    return isinstance(code, str) and len(code) == 3 and code.isascii() and code.isalpha() and code.isupper()


def _read_only(*args: object, **kwargs: object) -> NoReturn:
    raise TypeError("stock cost tables are read-only: build new StockCostParams instead")


class _ReadOnlyTable(dict[str, object]):
    """A checked cost table: a ``dict`` for every reader (lookups, iteration, ``==``, JSON,
    ``to_jsonable``) that refuses every edit, and pickles by value for the worker processes
    (``MappingProxyType`` does not pickle). ``dict(table)`` gives an editable copy."""

    __slots__ = ()
    __setitem__ = __delitem__ = __ior__ = _read_only
    clear = pop = popitem = setdefault = update = _read_only

    def __reduce__(self) -> tuple[type[_ReadOnlyTable], tuple[dict[str, object]]]:
        return (type(self), (dict(self),))


@dataclass(frozen=True, slots=True)
class StockCostParams:
    half_spread_bps: Mapping[str, Decimal]  # every universe symbol present (missing -> refused)
    slippage_bps: Decimal
    adverse_bps: Decimal  # drift between the auction print and E
    fx_fee_bps: Decimal
    commission_eur: Decimal  # must be 0 in M3 (fixed fees need fee-aware sizing: M4)
    currency: Mapping[str, str]

    def __post_init__(self) -> None:
        # Read-only copies: picklable, later edits to the caller's dict change nothing, and
        # nobody can edit the tables once the checks below (and the cost guard) have run.
        object.__setattr__(self, "half_spread_bps", _ReadOnlyTable(self.half_spread_bps))
        object.__setattr__(self, "currency", _ReadOnlyTable(self.currency))
        problems = [
            p
            for p in (
                *(_decimal_problem(f"half_spread_bps[{s!a}]", v) for s, v in self.half_spread_bps.items()),
                _decimal_problem("slippage_bps", self.slippage_bps),
                _decimal_problem("adverse_bps", self.adverse_bps),
                _decimal_problem("fx_fee_bps", self.fx_fee_bps),
                _decimal_problem("commission_eur", self.commission_eur),
            )
            if p is not None
        ]
        problems.extend(
            f"currency[{s!a}] must be a three-letter upper-case code such as EUR, got {c!a}"
            for s, c in self.currency.items()
            if not _currency_ok(c)
        )
        problems.extend(
            f"cost table symbol {s!a} must be a non-empty string"
            for s in (*self.half_spread_bps, *self.currency)
            if not isinstance(s, str) or not s
        )
        if problems:
            raise ValueError("invalid stock cost parameters: " + "; ".join(problems))


@dataclass(frozen=True, slots=True)
class CostBreakdown:
    spread_eur: Decimal
    slippage_eur: Decimal  # slippage plus adverse drift


class StockCostModel:
    """A ``costs.FillPricer`` for stocks at cost multiplier 1 or 2 (fixed once built)."""

    def __init__(self, params: StockCostParams, *, multiplier: int) -> None:
        if (
            isinstance(multiplier, bool)
            or not isinstance(multiplier, int)
            or multiplier not in COST_MULTIPLIERS
        ):
            raise ValueError(f"cost multiplier must be 1 or 2, got {multiplier!a}")
        if params.commission_eur != 0:
            raise ValueError(
                f"commission_eur must be 0 in M3, got {params.commission_eur} "
                "(a fixed fee per order needs fee-aware sizing, planned for M4)"
            )
        self._params = params
        self._multiplier = multiplier

    @property
    def multiplier(self) -> int:
        """1 or 2, read-only: a later change (to 0, say) would silently remove every cost."""
        return self._multiplier

    def _half_spread(self, symbol: str) -> Decimal:
        hs = self._params.half_spread_bps.get(symbol)
        if hs is None:
            raise ValueError(f"no half spread for {symbol} in the cost table: refusing to price it")
        return hs

    @staticmethod
    def _require_stock(order: OrderRequest) -> None:
        if order.market is not Market.STOCKS:
            raise ValueError(
                f"the stock cost model cannot price a {order.market.value} order ({order.symbol})"
            )

    def total_bps(self, symbol: str) -> Decimal:
        """``m x (half_spread[symbol] + slippage + adverse)``: the fill's distance from the reference."""
        p = self._params
        return self.multiplier * (self._half_spread(symbol) + p.slippage_bps + p.adverse_bps)

    def expected_fill_price(self, symbol: str, side: Side, reference: Decimal) -> Decimal:
        c = self.total_bps(symbol) / BPS
        if side is Side.BUY:
            return reference * (1 + c)
        if side is Side.SELL:
            return reference * (1 - c)
        raise ValueError(f"side must be Side.BUY or Side.SELL, got {side!a}")  # e.g. a plain "buy"

    def execution_price(self, order: OrderRequest, reference: Decimal) -> Decimal:
        self._require_stock(order)
        return self.expected_fill_price(order.symbol, order.side, reference)

    def fee(self, order: OrderRequest, quantity: Decimal, price: Decimal) -> Decimal:
        self._require_stock(order)
        return self.fee_for(order.symbol, quantity, price)

    def fee_for(self, symbol: str, quantity: Decimal, price: Decimal) -> Decimal:
        """The FX fee on a non-EUR instrument (``m x fx_fee_bps`` of the value), else 0."""
        currency = self._params.currency.get(symbol)
        if currency is None:
            raise ValueError(f"no currency for {symbol} in the cost table: refusing to price it")
        if currency == EUR:
            return Decimal(0)
        return quantity * price * self.multiplier * self._params.fx_fee_bps / BPS

    def buy_cash_needed(self, order: OrderRequest, quantity: Decimal, price: Decimal) -> Decimal:
        return quantity * price + self.fee(order, quantity, price)

    def attribution(self, symbol: str, quantity: Decimal, reference: Decimal) -> CostBreakdown:
        """Where one fill's cost went: the spread part and the slippage-plus-drift part (EUR)."""
        p = self._params
        value = quantity * reference * self.multiplier
        return CostBreakdown(
            spread_eur=value * self._half_spread(symbol) / BPS,
            slippage_eur=value * (p.slippage_bps + p.adverse_bps) / BPS,
        )


def cost_guard_problems(
    params: StockCostParams,
    limits: MarketLimits,
    *,
    symbols: Collection[str],
    price_tick: Decimal,
    min_reference_eur: Decimal,
) -> list[str]:
    """Every reason these costs could leave an approved order unfilled; empty when none.

    Checked for both multipliers, whatever the run's own: a study is refused unless its 2x
    rerun is safe too. ``symbols`` is the run's candidate universe: each must be in both
    cost tables. ``min_reference_eur`` is the smallest reference price the run can see.
    """
    problems: list[str] = []
    universe = sorted(set(symbols))
    if not universe:
        problems.append("no symbols to price: the universe is empty")
    for symbol in universe:
        missing = [
            table
            for table, values in (("half_spread_bps", params.half_spread_bps), ("currency", params.currency))
            if symbol not in values
        ]
        if missing:
            problems.append(f"no cost data for {symbol}: missing from {' and '.join(missing)}")
    if params.commission_eur != 0:
        problems.append(
            f"commission_eur must be 0 in M3, got {params.commission_eur} "
            "(a fixed fee per order needs fee-aware sizing, planned for M4)"
        )
    for m in COST_MULTIPLIERS:
        if m * params.fx_fee_bps > MAX_FX_FEE_BPS:
            problems.append(
                f"at {m}x costs the FX fee is {m * params.fx_fee_bps} bps, above the {MAX_FX_FEE_BPS} bps "
                "that sizing's cash headroom covers"
            )
    tick_ok = price_tick.is_finite() and price_tick > 0
    reference_ok = min_reference_eur.is_finite() and min_reference_eur > 0
    if not tick_ok:
        problems.append(f"price tick must be a finite amount > 0, got {price_tick}")
    if not reference_ok:
        problems.append(f"the smallest reference price must be a finite amount > 0, got {min_reference_eur}")
    if tick_ok and reference_ok:
        tick_bps = BPS * price_tick / min_reference_eur
        common = params.slippage_bps + params.adverse_bps
        worst = max(
            (params.half_spread_bps[s] + common for s in universe if s in params.half_spread_bps),
            default=common,
        )
        for m in COST_MULTIPLIERS:
            if not m * worst + tick_bps < limits.max_slippage_bps:
                problems.append(
                    f"at {m}x costs a fill can be {m * worst} bps from the reference, plus "
                    f"{tick_bps:.4f} bps of price tick at EUR {min_reference_eur}: not inside the "
                    f"{limits.max_slippage_bps} bps slippage collar, so an approved order could stay unfilled"
                )
    return problems
