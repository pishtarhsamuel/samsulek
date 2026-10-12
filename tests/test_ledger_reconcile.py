from __future__ import annotations

from decimal import Decimal
from pathlib import Path

import pytest

from helpers import T0, order
from samsulek.portfolio.ledger import Ledger, LedgerError
from samsulek.portfolio.reconcile import reconcile
from samsulek.risk.state import StateCorruptError
from samsulek.types import AccountSnapshot, BrokerOrder, Fill, Market, OrderStatus, Position, Side


def fill(fid: str, side: Side, qty: str, price: str, fee: str = "0", symbol: str = "AAA") -> Fill:
    return Fill(fid, f"c-{fid}", Market.STOCKS, symbol, side, Decimal(qty), Decimal(price), Decimal(fee), T0)


def account(
    cash: str, positions: dict[str, str] | None = None, open_orders: tuple[BrokerOrder, ...] = ()
) -> AccountSnapshot:
    pos = {s: Position(s, Market.STOCKS, Decimal(v), Decimal(1)) for s, v in (positions or {}).items()}
    return AccountSnapshot(Decimal(cash), pos, open_orders, T0)


def test_ledger_applies_fills_and_persists(tmp_path: Path) -> None:
    led = Ledger(tmp_path)
    led.initialize_from(account("50"), None)
    led.apply_fills([fill("1", Side.BUY, "0.1", "100", "0.05"), fill("2", Side.BUY, "0.1", "110")])
    assert led.cash == Decimal("50") - Decimal("10.05") - Decimal("11")
    assert led.positions["AAA"].avg_price == Decimal("105")
    led.apply_fills([fill("3", Side.SELL, "0.2", "120")])
    assert "AAA" not in led.positions
    reloaded = Ledger(tmp_path)
    assert reloaded.cash == led.cash and reloaded.last_fill_id == "3"


def test_ledger_refuses_overselling_reinit_and_open_orders(tmp_path: Path) -> None:
    led = Ledger(tmp_path)
    with pytest.raises(LedgerError, match="open orders"):
        led.initialize_from(
            account(
                "50",
                open_orders=(
                    BrokerOrder("B", order("AAA", Side.BUY, "1", "1"), OrderStatus.OPEN, Decimal(0), T0),
                ),
            ),
            None,
        )
    led.initialize_from(account("50"), None)
    with pytest.raises(LedgerError, match="already initialised"):
        led.initialize_from(account("50"), None)
    with pytest.raises(LedgerError, match="ledger holds"):
        led.apply_fills([fill("1", Side.SELL, "1", "10")])
    with pytest.raises(LedgerError, match="not initialised"):
        Ledger(tmp_path / "other").snapshot(T0)


def test_corrupt_ledger_fails_closed(tmp_path: Path) -> None:
    (tmp_path / "ledger.json").write_text("{nope", encoding="utf-8")
    with pytest.raises(StateCorruptError):
        Ledger(tmp_path)


def test_reconcile_detects_every_kind_of_difference(tmp_path: Path) -> None:
    led = Ledger(tmp_path)
    led.initialize_from(account("40", {"AAA": "0.1"}), None)
    local = led.snapshot(T0)
    assert reconcile(local, account("40.005", {"AAA": "0.1"}), []).ok  # within 1 cent
    assert not reconcile(local, account("39", {"AAA": "0.1"}), []).ok
    assert not reconcile(local, account("40", {"AAA": "0.2"}), []).ok
    assert not reconcile(local, account("40", {"AAA": "0.1", "BBB": "1"}), []).ok
    stranger = BrokerOrder("B-9", order("BBB", Side.BUY, "1", "10"), OrderStatus.OPEN, Decimal(0), T0)
    result = reconcile(local, account("40", {"AAA": "0.1"}, (stranger,)), [])
    assert not result.ok and "unknown open order" in result.differences[0]
    assert reconcile(local, account("40", {"AAA": "0.1"}, (stranger,)), [stranger.request.client_id]).ok
