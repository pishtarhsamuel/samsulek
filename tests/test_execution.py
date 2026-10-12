"""Router + simulated broker: nothing reaches a broker without a risk approval; failures halt."""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path

import pytest

from helpers import T0, order, pf, q
from samsulek.alerts import ConsoleAlerter
from samsulek.clock import FixedClock
from samsulek.execution.broker import BrokerError, BrokerRejected
from samsulek.execution.router import OrderRouter
from samsulek.execution.sim_broker import SimBroker
from samsulek.logging_setup import DecisionLog
from samsulek.risk.engine import RiskEngine
from samsulek.risk.state import RiskStateStore
from samsulek.types import AccountSnapshot, BrokerOrder, Fill, OrderRequest, OrderStatus, Quote, Side

QUOTES = {"AAA": q("AAA", "100"), "BBB": q("BBB", "10"), "CCC": q("CCC", "50")}


@dataclass
class SpyBroker:
    name: str = "spy"
    placed: list[OrderRequest] = field(default_factory=list)
    fail_with: Exception | None = None

    def account(self) -> AccountSnapshot:
        return AccountSnapshot(Decimal(50), {}, (), T0)

    def place_order(self, o: OrderRequest) -> BrokerOrder:
        if self.fail_with:
            raise self.fail_with
        self.placed.append(o)
        return BrokerOrder("B-1", o, OrderStatus.OPEN, Decimal(0), T0)

    def cancel_order(self, broker_id: str) -> None: ...

    def cancel_all_orders(self) -> list[str]:
        return []

    def fills_since(self, after_fill_id: str | None) -> list[Fill]:
        return []


def make_router(
    engine: RiskEngine, decision_log: DecisionLog, broker: object
) -> tuple[OrderRouter, ConsoleAlerter, list[str]]:
    alerter = ConsoleAlerter(decision_log)
    registered: list[str] = []
    router = OrderRouter(broker, engine, decision_log, alerter, register_client_id=registered.append)  # type: ignore[arg-type]
    return router, alerter, registered


def test_rejected_order_never_reaches_broker(engine: RiskEngine, decision_log: DecisionLog) -> None:
    spy = SpyBroker()
    router, _, registered = make_router(engine, decision_log, spy)
    result = router.submit(order("AAA", Side.BUY, "1", "100"), pf("50"), QUOTES)  # EUR 100 > cash
    assert not result.sent and not result.decision.approved
    assert spy.placed == [] and registered == []
    logged = decision_log.read_day(T0.date())
    assert logged[-1]["kind"] == "risk_decision" and logged[-1]["approved"] is False
    assert logged[-1]["reasons"], "rejections must be logged with their reasons"


def test_approved_order_is_counted_registered_then_sent(
    engine: RiskEngine, decision_log: DecisionLog, store: RiskStateStore
) -> None:
    spy = SpyBroker()
    router, _, registered = make_router(engine, decision_log, spy)
    o = order("AAA", Side.BUY, "0.1", "100")
    result = router.submit(o, pf("50"), QUOTES)
    assert result.sent and spy.placed == [o]
    assert registered == [o.client_id]
    day = store.read_day()
    assert day is not None and day.trades["stocks"] == 1


@pytest.mark.parametrize(
    "exc", [BrokerRejected("insufficient funds"), BrokerError("timeout"), RuntimeError("??")]
)
def test_broker_failure_halts_and_alerts(
    engine: RiskEngine, decision_log: DecisionLog, store: RiskStateStore, exc: Exception
) -> None:
    spy = SpyBroker(fail_with=exc)
    router, alerter, _ = make_router(engine, decision_log, spy)
    result = router.submit(order("AAA", Side.BUY, "0.1", "100"), pf("50"), QUOTES)
    assert not result.sent and result.error
    assert store.read_halt().active
    assert alerter.sent and alerter.sent[-1][0] == "critical"
    day = store.read_day()
    assert day is not None and day.trades["stocks"] == 1, "a failed send still counts (conservative)"


def test_flatten_works_under_kill_and_reports_unpriced(
    engine: RiskEngine, decision_log: DecisionLog, store: RiskStateStore
) -> None:
    spy = SpyBroker()
    router, _, _ = make_router(engine, decision_log, spy)
    store.set_kill("emergency", T0)
    portfolio = pf("10", {"AAA": "0.1", "BBB": "1", "NOPRICE": "2"})
    _results, not_flattened = router.flatten(portfolio, QUOTES, "emergency", Decimal("0.0001"))
    assert sorted(o.symbol for o in spy.placed) == ["AAA", "BBB"]
    assert all(o.reduce_only and o.side is Side.SELL for o in spy.placed)
    assert any("NOPRICE" in item for item in not_flattened)
    for o in spy.placed:
        assert o.limit_price is not None
        assert o.limit_price >= QUOTES[o.symbol].price * Decimal("0.98")


# ------------------------------------------------------------------ SimBroker
def sim(clock: FixedClock, tmp_path: Path | None = None, prices: dict[str, Quote] | None = None) -> SimBroker:
    book = dict(prices or QUOTES)
    return SimBroker(
        starting_cash=Decimal("50"),
        fee_eur=Decimal("0"),
        fee_bps=Decimal("0"),
        slippage_bps=Decimal("10"),
        price_source=book.get,
        clock=clock,
        state_path=(tmp_path / "sim.json") if tmp_path else None,
    )


def test_sim_fills_pessimistically_and_tracks_cash(clock: FixedClock) -> None:
    b = sim(clock)
    bo = b.place_order(order("AAA", Side.BUY, "0.1", "100.2"))
    assert bo.status is OrderStatus.FILLED
    fill = b.fills_since(None)[0]
    assert fill.price == Decimal("100.1")  # 10 bps worse than reference
    assert b.account().cash == Decimal("50") - Decimal("10.01")


def test_sim_limit_not_reached_rests_then_cancels(clock: FixedClock) -> None:
    b = sim(clock)
    bo = b.place_order(order("AAA", Side.BUY, "0.1", "99"))
    assert bo.status is OrderStatus.OPEN
    assert len(b.account().open_orders) == 1
    assert b.cancel_all_orders() == [bo.broker_id]
    assert b.account().open_orders == ()


def test_sim_rejects_duplicates_overspend_and_shorts(clock: FixedClock) -> None:
    b = sim(clock)
    o = order("AAA", Side.BUY, "0.1", "101")
    b.place_order(o)
    with pytest.raises(BrokerRejected, match="duplicate"):
        b.place_order(o)
    with pytest.raises(BrokerRejected, match="insufficient cash"):
        b.place_order(order("AAA", Side.BUY, "1", "101"))
    with pytest.raises(BrokerRejected, match="only"):
        b.place_order(order("BBB", Side.SELL, "1", "9"))


def test_sim_state_persists_and_corrupt_state_fails_closed(clock: FixedClock, tmp_path: Path) -> None:
    b = sim(clock, tmp_path)
    b.place_order(order("AAA", Side.BUY, "0.1", "101"))
    again = sim(clock, tmp_path)
    assert again.account().positions["AAA"].quantity == Decimal("0.1")
    (tmp_path / "sim.json").write_text("{broken", encoding="utf-8")
    with pytest.raises(BrokerError, match="unreadable"):
        sim(clock, tmp_path)


def test_sim_unknown_fill_id_means_history_disagrees(clock: FixedClock) -> None:
    with pytest.raises(BrokerError, match="disagree"):
        sim(clock).fills_since("NOT-A-FILL")
