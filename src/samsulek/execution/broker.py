"""The broker interface every adapter (simulated, Trading 212 demo, live) implements."""

from __future__ import annotations

from typing import Protocol

from samsulek.types import AccountSnapshot, BrokerOrder, Fill, OrderRequest


class BrokerError(RuntimeError):
    """Transport failure or unexpected response. Callers must fail closed (halt + alert)."""


class BrokerRejected(BrokerError):
    """The broker refused the order. Our view of the account may be wrong: halt + alert."""


class Broker(Protocol):
    name: str

    def account(self) -> AccountSnapshot: ...

    def place_order(self, order: OrderRequest) -> BrokerOrder: ...

    def cancel_order(self, broker_id: str) -> None: ...

    def cancel_all_orders(self) -> list[str]: ...

    def fills_since(self, after_fill_id: str | None) -> list[Fill]: ...
