"""A simulated broker for sim mode, tests and (later) backtests.

Pessimistic by default: buys fill ``slippage_bps`` above the reference price and
sells below it, plus fixed and proportional fees. Limit orders that would not
fill stay OPEN until matched or cancelled. State can be persisted to a JSON
file so separate processes (``samsulek run`` / ``samsulek kill``) see the same
account.
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

BPS = Decimal(10_000)
PriceSource = Callable[[str], Quote | None]


@dataclass
class _OpenOrder:
    broker_id: str
    request: OrderRequest


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
    ) -> None:
        self._fee_eur = fee_eur
        self._fee_bps = fee_bps
        self._slippage = slippage_bps / BPS
        self._prices = price_source
        self._clock = clock
        self._path = state_path
        self._cash = starting_cash
        self._positions: dict[str, Position] = {}
        self._open: dict[str, _OpenOrder] = {}
        self._fills: list[Fill] = []
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
        except (OSError, KeyError, TypeError, ValueError, ArithmeticError) as exc:
            raise BrokerError(f"simulated broker state {self._path} is unreadable: {exc}") from exc

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
        for i, f in enumerate(self._fills):
            if f.fill_id == after_fill_id:
                return self._fills[i + 1 :]
        raise BrokerError(f"unknown fill id {after_fill_id}: local and broker history disagree")

    # ----------------------------------------------------------------- orders
    def place_order(self, order: OrderRequest) -> BrokerOrder:
        self._maybe_fail()
        if any(o.request.client_id == order.client_id for o in self._open.values()) or any(
            f.client_id == order.client_id for f in self._fills
        ):
            raise BrokerRejected(f"duplicate client order id {order.client_id}")
        self._check_available(order)
        self._seq += 1
        broker_id = f"SIM-{self._seq:06d}"
        filled = self._try_fill(broker_id, order)
        if not filled:
            self._open[broker_id] = _OpenOrder(broker_id, order)
        self._save()
        status = OrderStatus.FILLED if filled else OrderStatus.OPEN
        return BrokerOrder(
            broker_id, order, status, order.quantity if filled else Decimal(0), self._clock.now()
        )

    def cancel_order(self, broker_id: str) -> None:
        self._maybe_fail()
        if self._open.pop(broker_id, None) is None:
            raise BrokerRejected(f"no open order {broker_id}")
        self._save()

    def cancel_all_orders(self) -> list[str]:
        self._maybe_fail()
        ids = list(self._open)
        self._open.clear()
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
                cash += r.quantity * px * (1 + self._fee_bps / BPS) + self._fee_eur
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
                px = quote.price * (1 + self._slippage)
            else:
                px = order.limit_price
            need = order.quantity * px * (1 + self._fee_bps / BPS) + self._fee_eur
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
                del self._open[oid]
                changed = True
        if changed:
            self._save()
        return dropped

    def _try_fill(self, broker_id: str, order: OrderRequest) -> bool:
        quote = self._prices(order.symbol)
        if quote is None:
            return False
        if order.side is Side.BUY:
            px = quote.price * (1 + self._slippage)
            if (
                order.order_type is OrderType.LIMIT
                and order.limit_price is not None
                and px > order.limit_price
            ):
                return False
        else:
            px = quote.price * (1 - self._slippage)
            if (
                order.order_type is OrderType.LIMIT
                and order.limit_price is not None
                and px < order.limit_price
            ):
                return False
        qty = order.quantity
        fee = self._fee_eur + (qty * px * self._fee_bps / BPS)
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
        self._fills.append(
            Fill(
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
        )
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
