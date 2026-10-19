"""Trading costs: how a fill's price and fee follow from the reference price (M3 contract).

A ``FillPricer`` prices one fill for the simulated broker. It sees the order and a
reference price only: never the portfolio, the clock or the risk state, so the same
pricer gives the same answer in a backtest and in sim mode. Prices, quantities and fees
are ``Decimal`` EUR. Cost rates are in basis points of the reference (``BPS``).
``costs/`` may not import the execution, risk, portfolio, cycle or backtest packages
(tests/test_architecture_m3.py, rule A2).
"""

from __future__ import annotations

from decimal import Decimal
from typing import Final, Protocol

from samsulek.types import OrderRequest

BPS: Final = Decimal(10_000)


class FillPricer(Protocol):
    """Prices one fill. Used by the simulated broker; never sees the portfolio or the clock."""

    def execution_price(self, order: OrderRequest, reference: Decimal) -> Decimal:
        """Fill price before the limit check: the reference moved by spread, slippage, drift."""
        ...

    def fee(self, order: OrderRequest, quantity: Decimal, price: Decimal) -> Decimal:
        """Fees charged on top of quantity x price (EUR, >= 0)."""
        ...

    def buy_cash_needed(self, order: OrderRequest, quantity: Decimal, price: Decimal) -> Decimal:
        """Cash a buy of ``quantity`` at worst price ``price`` must have available, fees included."""
        ...
