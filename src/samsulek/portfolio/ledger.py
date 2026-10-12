"""Our own record of the account, built only from fills the broker reports.

Reconciliation compares this ledger with the broker's account. Any difference
means something happened that we didn't do or didn't see (a manual trade, a
missed fill, a bug), so trading halts until the owner looks.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path

from samsulek.risk.state import StateCorruptError, atomic_write_text
from samsulek.types import AccountSnapshot, Fill, Market, OrderRequest, PortfolioSnapshot, Position, Side

LEDGER_FILE = "ledger.json"


class LedgerError(RuntimeError):
    """The ledger can't be trusted (corrupt, uninitialised, or inconsistent)."""


class Ledger:
    def __init__(self, state_dir: Path) -> None:
        self._path = state_dir / LEDGER_FILE
        self.initialized = False
        self.cash = Decimal(0)
        self.positions: dict[str, Position] = {}
        self.last_fill_id: str | None = None
        self.known_client_ids: list[str] = []
        # Quantity we ordered and quantity filled so far, per client order id. A fill for
        # an id we never sent, or beyond what we ordered, means someone else traded.
        self.ordered: dict[str, Decimal] = {}
        self.filled: dict[str, Decimal] = {}
        self._load()

    def _load(self) -> None:
        try:
            text = self._path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return
        try:
            data = json.loads(text)
            self.cash = Decimal(data["cash"])
            self.positions = {
                s: Position(s, Market(p["market"]), Decimal(p["quantity"]), Decimal(p["avg_price"]))
                for s, p in data["positions"].items()
            }
            self.last_fill_id = data["last_fill_id"]
            self.known_client_ids = list(data["known_client_ids"])
            self.ordered = {k: Decimal(v) for k, v in data.get("ordered", {}).items()}
            self.filled = {k: Decimal(v) for k, v in data.get("filled", {}).items()}
            self.initialized = bool(data["initialized"])
            if not self.cash.is_finite() or any(
                not p.quantity.is_finite() or not p.avg_price.is_finite() for p in self.positions.values()
            ):
                raise ValueError("non-finite number in ledger")
        except (KeyError, TypeError, ValueError, InvalidOperation, json.JSONDecodeError) as exc:
            raise StateCorruptError(f"{self._path} is unreadable") from exc

    def save(self) -> None:
        data = {
            "initialized": self.initialized,
            "cash": str(self.cash),
            "positions": {
                s: {"market": p.market.value, "quantity": str(p.quantity), "avg_price": str(p.avg_price)}
                for s, p in self.positions.items()
            },
            "last_fill_id": self.last_fill_id,
            "known_client_ids": self.known_client_ids[-5000:],
            "ordered": {k: str(v) for k, v in list(self.ordered.items())[-5000:]},
            "filled": {k: str(v) for k, v in list(self.filled.items())[-5000:]},
        }
        atomic_write_text(self._path, json.dumps(data, indent=2, sort_keys=True))

    def initialize_from(self, account: AccountSnapshot, last_fill_id: str | None) -> None:
        """Adopt the broker's account as the starting point. Only for a brand-new ledger."""
        if self.initialized:
            raise LedgerError("ledger is already initialised; refusing to overwrite it")
        if account.open_orders:
            raise LedgerError("broker has open orders; cancel them before initialising the ledger")
        self.cash = account.cash
        self.positions = dict(account.positions)
        self.last_fill_id = last_fill_id
        self.initialized = True
        self.save()

    def remember_order(self, order: OrderRequest) -> None:
        """Record an order right before it is sent, so its fills (and only its fills) are accepted."""
        if order.client_id in self.ordered:
            raise LedgerError(f"client order id {order.client_id} was already used")
        self.known_client_ids.append(order.client_id)
        self.ordered[order.client_id] = order.quantity
        self.save()

    def apply_fills(self, fills: Iterable[Fill]) -> int:
        n = 0
        for f in fills:
            ordered = self.ordered.get(f.client_id)
            if ordered is None:
                raise LedgerError(
                    f"fill {f.fill_id} is for order {f.client_id}, which this bot never sent "
                    "(manual trade or broker error)"
                )
            already = self.filled.get(f.client_id, Decimal(0))
            if already + f.quantity > ordered:
                raise LedgerError(
                    f"fill {f.fill_id} would fill {already + f.quantity} of order {f.client_id}, "
                    f"which was for {ordered} (duplicate execution?)"
                )
            self.filled[f.client_id] = already + f.quantity
            pos = self.positions.get(f.symbol)
            held = pos.quantity if pos else Decimal(0)
            if f.side is Side.BUY:
                new_qty = held + f.quantity
                cost_basis = (pos.avg_price * held if pos else Decimal(0)) + f.quantity * f.price
                self.positions[f.symbol] = Position(f.symbol, f.market, new_qty, cost_basis / new_qty)
                self.cash -= f.quantity * f.price + f.fee
            else:
                if f.quantity > held:
                    raise LedgerError(
                        f"fill {f.fill_id} sells {f.quantity} {f.symbol} but ledger holds {held}"
                    )
                self.cash += f.quantity * f.price - f.fee
                remaining = held - f.quantity
                if remaining == 0:
                    self.positions.pop(f.symbol, None)
                else:
                    if pos is None:
                        raise LedgerError(f"position for {f.symbol} vanished")
                    self.positions[f.symbol] = Position(f.symbol, f.market, remaining, pos.avg_price)
            self.last_fill_id = f.fill_id
            n += 1
        if n:
            self.save()
        return n

    def snapshot(self, ts: datetime, open_orders: tuple[OrderRequest, ...] = ()) -> PortfolioSnapshot:
        """Our view of the account. ``open_orders`` come from the broker (they reserve cash/exposure)."""
        if not self.initialized:
            raise LedgerError("ledger is not initialised")
        return PortfolioSnapshot(
            cash=self.cash, positions=dict(self.positions), ts=ts, open_orders=tuple(open_orders)
        )
