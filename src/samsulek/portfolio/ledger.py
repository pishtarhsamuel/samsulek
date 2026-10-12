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
from samsulek.types import AccountSnapshot, Fill, Market, PortfolioSnapshot, Position, Side

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
            self.initialized = bool(data["initialized"])
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

    def remember_client_id(self, client_id: str) -> None:
        self.known_client_ids.append(client_id)
        self.save()

    def apply_fills(self, fills: Iterable[Fill]) -> int:
        n = 0
        for f in fills:
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

    def snapshot(self, ts: datetime) -> PortfolioSnapshot:
        if not self.initialized:
            raise LedgerError("ledger is not initialised")
        return PortfolioSnapshot(cash=self.cash, positions=dict(self.positions), ts=ts)
