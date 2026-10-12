"""Compare our ledger with the broker. Any unexplained difference -> halt + alert."""

from __future__ import annotations

from collections.abc import Collection
from dataclasses import dataclass
from decimal import Decimal

from samsulek.types import AccountSnapshot, PortfolioSnapshot

CASH_TOLERANCE_EUR = Decimal("0.01")
QTY_TOLERANCE = Decimal("0.000001")


@dataclass(frozen=True, slots=True)
class ReconcileResult:
    ok: bool
    differences: tuple[str, ...]


def reconcile(
    local: PortfolioSnapshot,
    broker: AccountSnapshot,
    known_client_ids: Collection[str],
    cash_tolerance: Decimal = CASH_TOLERANCE_EUR,
    qty_tolerance: Decimal = QTY_TOLERANCE,
) -> ReconcileResult:
    diffs: list[str] = []
    if abs(local.cash - broker.cash) > cash_tolerance:
        diffs.append(f"cash: ledger EUR {local.cash:.4f} vs broker EUR {broker.cash:.4f}")
    for symbol in sorted(set(local.positions) | set(broker.positions)):
        lq = local.positions[symbol].quantity if symbol in local.positions else Decimal(0)
        bq = broker.positions[symbol].quantity if symbol in broker.positions else Decimal(0)
        if abs(lq - bq) > qty_tolerance:
            diffs.append(f"{symbol}: ledger {lq} vs broker {bq}")
    known = set(known_client_ids)
    for order in broker.open_orders:
        if order.request.client_id not in known:
            diffs.append(f"unknown open order at broker: {order.broker_id} ({order.request.client_id})")
    return ReconcileResult(ok=not diffs, differences=tuple(diffs))
