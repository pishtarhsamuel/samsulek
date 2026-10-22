"""A simulated broker for sim mode, tests and backtests.

Pessimistic by default: buys fill ``slippage_bps`` above the reference price and
sells below it, plus fixed and proportional fees. Limit orders that would not
fill stay OPEN until matched or cancelled. State can be persisted to a JSON
file so separate processes (``samsulek run`` / ``samsulek kill``) see the same
account.

How a fill is priced comes from a ``costs.FillPricer``. Without one, the broker
uses ``LegacyPricer``, which is M1's arithmetic expression for expression, so the
default path behaves exactly as before (tests/test_sim_broker_equivalence.py checks
it against a frozen copy of the M1 broker). A backtest passes its own pricer (the
stock cost model) and leaves the fee and slippage settings at zero; giving both is
refused, so a cost can never be counted twice or silently ignored.

Duplicate client order ids are refused exactly as in M1: an id is in use while an
open order or a recorded fill carries it. ``_used_ids`` counts those carriers, so
the check is O(1); it changes only where an order is stored open, a fill is
appended, or an open order goes away (filled, cancelled or dropped), and an id
freed by a cancel can be used again, as before. It counts rather than just holding
the id because a damaged or hand-edited file can put one id on two carriers: M1
then still refuses the id after one of them goes, and so does this broker (a new
order that overwrites an open entry of such a file frees the overwritten order's
id, as M1 does). An id is never recorded for an order that raised while being
filled (nothing was stored).
``fills_since`` finds its starting fill through an index of the first fill with
each id, also O(1).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from samsulek.clock import Clock
from samsulek.costs import BPS, FillPricer
from samsulek.execution.broker import BrokerError, BrokerRejected
from samsulek.risk.state import atomic_write_text
from samsulek.types import (
    AccountSnapshot,
    BrokerOrder,
    Fill,
    Market,
    OrderRequest,
    OrderStatus,
    OrderType,
    Position,
    Quote,
    Side,
)

__all__ = ["BPS", "LegacyPricer", "PriceSource", "SimBroker"]

PriceSource = Callable[[str], Quote | None]


@dataclass
class _OpenOrder:
    broker_id: str
    request: OrderRequest


class LegacyPricer:
    """M1's pricing: symmetric slippage on the reference price, plus fixed and proportional fees.

    Every expression is M1's, in M1's order of operations, so every Decimal result is
    identical (``slippage_bps / BPS`` is computed once, when the pricer is built).
    """

    def __init__(self, *, fee_eur: Decimal, fee_bps: Decimal, slippage_bps: Decimal) -> None:
        self._fee_eur = fee_eur
        self._fee_bps = fee_bps
        self._slippage = slippage_bps / BPS

    def execution_price(self, order: OrderRequest, reference: Decimal) -> Decimal:
        if order.side is Side.BUY:
            return reference * (1 + self._slippage)
        return reference * (1 - self._slippage)

    def fee(self, order: OrderRequest, quantity: Decimal, price: Decimal) -> Decimal:
        return self._fee_eur + (quantity * price * self._fee_bps / BPS)

    def buy_cash_needed(self, order: OrderRequest, quantity: Decimal, price: Decimal) -> Decimal:
        return quantity * price * (1 + self._fee_bps / BPS) + self._fee_eur


class SimBroker:
    name = "sim"

    def __init__(
        self,
        *,
        starting_cash: Decimal,
        fee_eur: Decimal,
        fee_bps: Decimal,
        slippage_bps: Decimal,
        price_source: PriceSource,
        clock: Clock,
        state_path: Path | None = None,
        pricer: FillPricer | None = None,
    ) -> None:
        if pricer is not None and (fee_eur or fee_bps or slippage_bps):
            raise ValueError(
                "give the simulated broker either a pricer or fee and slippage settings, not both "
                "(set fee_eur, fee_bps and slippage_bps to 0 when a pricer is given)"
            )
        self._pricer: FillPricer = (
            pricer
            if pricer is not None
            else LegacyPricer(fee_eur=fee_eur, fee_bps=fee_bps, slippage_bps=slippage_bps)
        )
        self._prices = price_source
        self._clock = clock
        self._path = state_path
        self._cash = starting_cash
        self._positions: dict[str, Position] = {}
        self._open: dict[str, _OpenOrder] = {}
        self._fills: list[Fill] = []
        self._fill_pos: dict[str, int] = {}  # fill id -> index of the FIRST fill with that id
        self._used_ids: dict[str, int] = {}  # client id -> open orders plus fills carrying it
        self._seq = 0
        self.fail_next: Exception | None = None  # test hook: raise on the next call
        if self._path is not None and self._path.exists():
            self._load()

    # ------------------------------------------------------------ persistence
    def _save(self) -> None:
        if self._path is None:
            return
        data = {
            "cash": str(self._cash),
            "seq": self._seq,
            "positions": {
                s: {"market": p.market.value, "quantity": str(p.quantity), "avg_price": str(p.avg_price)}
                for s, p in self._positions.items()
            },
            "open": {oid: _order_to_json(o.request) for oid, o in self._open.items()},
            "fills": [_fill_to_json(f) for f in self._fills],
        }
        atomic_write_text(self._path, json.dumps(data, indent=2, sort_keys=True))

    def _load(self) -> None:
        if self._path is None:
            raise BrokerError("no state path configured")
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            self._cash = Decimal(data["cash"])
            self._seq = int(data["seq"])
            self._positions = {
                s: Position(s, Market(p["market"]), Decimal(p["quantity"]), Decimal(p["avg_price"]))
                for s, p in data["positions"].items()
            }
            self._open = {oid: _OpenOrder(oid, _order_from_json(o)) for oid, o in data["open"].items()}
            self._fills = [_fill_from_json(f) for f in data["fills"]]
            self._fill_pos = {}
            for i, f in enumerate(self._fills):
                self._fill_pos.setdefault(f.fill_id, i)
            self._used_ids = {}
            for o in self._open.values():
                self._id_taken(o.request.client_id)
            for f in self._fills:
                self._id_taken(f.client_id)
        except Exception as exc:  # any damage: the simulated broker is unavailable (fail closed)
            raise BrokerError(
                f"simulated broker state {self._path} is unreadable: {type(exc).__name__}: {exc}"
            ) from exc

    # ------------------------------------------------------- client id index
    def _id_taken(self, client_id: str) -> None:
        self._used_ids[client_id] = self._used_ids.get(client_id, 0) + 1

    def _id_released(self, client_id: str) -> None:
        left = self._used_ids.get(client_id, 0) - 1
        if left > 0:
            self._used_ids[client_id] = left
        else:
            self._used_ids.pop(client_id, None)

    def _remove_open(self, broker_id: str) -> _OpenOrder | None:
        gone = self._open.pop(broker_id, None)
        if gone is not None:
            self._id_released(gone.request.client_id)
        return gone

    # --------------------------------------------------------------- queries
    def _maybe_fail(self) -> None:
        if self.fail_next is not None:
            exc, self.fail_next = self.fail_next, None
            raise exc

    def account(self) -> AccountSnapshot:
        self._maybe_fail()
        dropped = self.match_open_orders()
        if dropped:
            raise BrokerError(f"broker rejected resting orders it could no longer fill: {', '.join(dropped)}")
        orders = tuple(
            BrokerOrder(o.broker_id, o.request, OrderStatus.OPEN, Decimal(0), self._clock.now())
            for o in self._open.values()
        )
        return AccountSnapshot(
            cash=self._cash, positions=dict(self._positions), open_orders=orders, ts=self._clock.now()
        )

    def fills_since(self, after_fill_id: str | None) -> list[Fill]:
        self._maybe_fail()
        if after_fill_id is None:
            return list(self._fills)
        i = self._fill_pos.get(after_fill_id)
        if i is not None:
            return self._fills[i + 1 :]
        raise BrokerError(f"unknown fill id {after_fill_id}: local and broker history disagree")

    # ----------------------------------------------------------------- orders
    def place_order(self, order: OrderRequest) -> BrokerOrder:
        self._maybe_fail()
        if order.client_id in self._used_ids:
            raise BrokerRejected(f"duplicate client order id {order.client_id}")
        self._check_available(order)
        self._seq += 1
        broker_id = f"SIM-{self._seq:06d}"
        filled = self._try_fill(broker_id, order)  # records the id itself when it appends a fill
        if not filled:
            # Only a damaged file (seq behind its own open ids) can make broker_id taken. As in
            # M1 the new order then replaces that entry in place, so the replaced order's id
            # is freed, exactly as if it had been cancelled.
            replaced = self._open.get(broker_id)
            if replaced is not None:
                self._id_released(replaced.request.client_id)
            self._open[broker_id] = _OpenOrder(broker_id, order)
            self._id_taken(order.client_id)
        self._save()
        status = OrderStatus.FILLED if filled else OrderStatus.OPEN
        return BrokerOrder(
            broker_id, order, status, order.quantity if filled else Decimal(0), self._clock.now()
        )

    def cancel_order(self, broker_id: str) -> None:
        self._maybe_fail()
        if self._remove_open(broker_id) is None:
            raise BrokerRejected(f"no open order {broker_id}")
        self._save()

    def cancel_all_orders(self) -> list[str]:
        self._maybe_fail()
        ids = list(self._open)
        for oid in ids:
            self._remove_open(oid)
        self._save()
        return ids

    def _reserved(self, exclude: str | None = None) -> tuple[Decimal, dict[str, Decimal]]:
        """Cash reserved by open buys (at their limit, plus fees) and quantity claimed by open sells."""
        cash = Decimal(0)
        qty: dict[str, Decimal] = {}
        for oid, o in self._open.items():
            if oid == exclude:
                continue
            r = o.request
            if r.side is Side.BUY:
                px = r.limit_price if r.limit_price is not None else Decimal(0)
                cash += self._pricer.buy_cash_needed(r, r.quantity, px)
            else:
                qty[r.symbol] = qty.get(r.symbol, Decimal(0)) + r.quantity
        return cash, qty

    def _check_available(self, order: OrderRequest) -> None:
        """Like a real broker: an order must be covered by cash/shares not already reserved."""
        reserved_cash, reserved_qty = self._reserved()
        if order.side is Side.BUY:
            if order.limit_price is None:
                quote = self._prices(order.symbol)
                if quote is None:
                    raise BrokerRejected(f"no price for {order.symbol}")
                px = self._pricer.execution_price(order, quote.price)
            else:
                px = order.limit_price
            need = self._pricer.buy_cash_needed(order, order.quantity, px)
            if need > self._cash - reserved_cash:
                raise BrokerRejected(
                    f"insufficient cash for {order.client_id}: need {need:.4f}, "
                    f"available {self._cash - reserved_cash:.4f}"
                )
        else:
            pos = self._positions.get(order.symbol)
            available = (pos.quantity if pos else Decimal(0)) - reserved_qty.get(order.symbol, Decimal(0))
            if order.quantity > available:
                raise BrokerRejected(
                    f"cannot sell {order.quantity} {order.symbol}: only {available} available"
                )

    def match_open_orders(self) -> list[str]:
        """Fill resting orders that are now marketable. Returns ids of orders that had to be dropped."""
        changed = False
        dropped: list[str] = []
        for oid in list(self._open):
            try:
                filled = self._try_fill(oid, self._open[oid].request)
            except BrokerRejected:
                dropped.append(oid)  # never silently: account() reports it as an error
                filled = True
            if filled:
                self._remove_open(oid)  # a filled order's id stays in use through its fill
                changed = True
        if changed:
            self._save()
        return dropped

    def _try_fill(self, broker_id: str, order: OrderRequest) -> bool:
        quote = self._prices(order.symbol)
        if quote is None:
            return False
        px = self._pricer.execution_price(order, quote.price)
        limit = order.limit_price if order.order_type is OrderType.LIMIT else None
        if limit is not None and (px > limit if order.side is Side.BUY else px < limit):
            return False
        qty = order.quantity
        fee = self._pricer.fee(order, qty, px)
        pos = self._positions.get(order.symbol)
        held = pos.quantity if pos else Decimal(0)
        if order.side is Side.BUY:
            cost = qty * px + fee
            if cost > self._cash:
                raise BrokerRejected(
                    f"insufficient cash for {order.client_id}: need {cost:.4f}, have {self._cash:.4f}"
                )
            new_qty = held + qty
            avg = ((pos.avg_price * held) if pos else Decimal(0)) + qty * px
            self._positions[order.symbol] = Position(order.symbol, order.market, new_qty, avg / new_qty)
            self._cash -= cost
        else:
            if qty > held:
                raise BrokerRejected(f"cannot sell {qty} {order.symbol}: only {held} held")
            self._cash += qty * px - fee
            remaining = held - qty
            if remaining == 0:
                self._positions.pop(order.symbol, None)
            else:
                if pos is None:
                    raise BrokerError(f"position for {order.symbol} vanished")
                self._positions[order.symbol] = Position(order.symbol, order.market, remaining, pos.avg_price)
        fill = Fill(
            fill_id=f"{broker_id}-F",
            client_id=order.client_id,
            market=order.market,
            symbol=order.symbol,
            side=order.side,
            quantity=qty,
            price=px,
            fee=fee,
            ts=self._clock.now(),
        )
        self._fill_pos.setdefault(fill.fill_id, len(self._fills))
        self._fills.append(fill)
        self._id_taken(order.client_id)
        return True


def _order_to_json(o: OrderRequest) -> dict[str, Any]:
    return {
        "client_id": o.client_id,
        "market": o.market.value,
        "symbol": o.symbol,
        "side": o.side.value,
        "quantity": str(o.quantity),
        "order_type": o.order_type.value,
        "limit_price": str(o.limit_price) if o.limit_price is not None else None,
        "reduce_only": o.reduce_only,
        "reason": o.reason,
    }


def _order_from_json(d: dict[str, Any]) -> OrderRequest:
    return OrderRequest(
        client_id=d["client_id"],
        market=Market(d["market"]),
        symbol=d["symbol"],
        side=Side(d["side"]),
        quantity=Decimal(d["quantity"]),
        order_type=OrderType(d["order_type"]),
        limit_price=Decimal(d["limit_price"]) if d["limit_price"] is not None else None,
        reduce_only=bool(d["reduce_only"]),
        reason=d["reason"],
    )


def _fill_to_json(f: Fill) -> dict[str, Any]:
    return {
        "fill_id": f.fill_id,
        "client_id": f.client_id,
        "market": f.market.value,
        "symbol": f.symbol,
        "side": f.side.value,
        "quantity": str(f.quantity),
        "price": str(f.price),
        "fee": str(f.fee),
        "ts": f.ts.isoformat(),
    }


def _fill_from_json(d: dict[str, Any]) -> Fill:
    return Fill(
        fill_id=d["fill_id"],
        client_id=d["client_id"],
        market=Market(d["market"]),
        symbol=d["symbol"],
        side=Side(d["side"]),
        quantity=Decimal(d["quantity"]),
        price=Decimal(d["price"]),
        fee=Decimal(d["fee"]),
        ts=datetime.fromisoformat(d["ts"]),
    )
