"""Router + simulated broker: nothing reaches a broker without a risk approval; failures halt."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
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
    open: list[BrokerOrder] = field(default_factory=list)
    cancelled: list[str] = field(default_factory=list)
    fail_with: Exception | None = None

    def account(self) -> AccountSnapshot:
        return AccountSnapshot(Decimal(50), {}, tuple(self.open), T0)

    def place_order(self, o: OrderRequest) -> BrokerOrder:
        if self.fail_with:
            raise self.fail_with
        self.placed.append(o)
        return BrokerOrder(f"B-{len(self.placed)}", o, OrderStatus.OPEN, Decimal(0), T0)

    def cancel_order(self, broker_id: str) -> None:
        self.cancelled.append(broker_id)
        self.open = [o for o in self.open if o.broker_id != broker_id]

    def cancel_all_orders(self) -> list[str]:
        ids = [o.broker_id for o in self.open]
        self.cancelled.extend(ids)
        self.open = []
        return ids

    def fills_since(self, after_fill_id: str | None) -> list[Fill]:
        return []


def make_router(
    engine: RiskEngine, decision_log: DecisionLog, broker: object, register: object = None
) -> tuple[OrderRouter, ConsoleAlerter, list[str]]:
    alerter = ConsoleAlerter(decision_log)
    registered: list[str] = []

    def default_register(o: OrderRequest) -> None:
        registered.append(o.client_id)

    router = OrderRouter(broker, engine, decision_log, alerter, register_order=register or default_register)  # type: ignore[arg-type]
    return router, alerter, registered


def test_rejected_order_never_reaches_broker(engine: RiskEngine, decision_log: DecisionLog) -> None:
    spy = SpyBroker()
    router, _, registered = make_router(engine, decision_log, spy)
    result = router.submit(order("AAA", Side.BUY, "1", "100"), pf("50"), QUOTES)  # EUR 100 > cash
    assert not result.sent
    assert not result.decision.approved
    assert spy.placed == []
    assert registered == []
    logged = decision_log.read_day(T0.date())
    assert logged[-1]["kind"] == "risk_decision"
    assert logged[-1]["approved"] is False
    assert logged[-1]["reasons"], "rejections must be logged with their reasons"


def test_approved_order_is_counted_registered_then_sent(
    engine: RiskEngine, decision_log: DecisionLog, store: RiskStateStore
) -> None:
    spy = SpyBroker()
    router, _, registered = make_router(engine, decision_log, spy)
    o = order("AAA", Side.BUY, "0.1", "100")
    result = router.submit(o, pf("50"), QUOTES)
    assert result.sent
    assert spy.placed == [o]
    assert registered == [o.client_id]
    day = store.read_day()
    assert day is not None
    assert day.trades["stocks"] == 1


@pytest.mark.parametrize(
    "exc", [BrokerRejected("insufficient funds"), BrokerError("timeout"), RuntimeError("??")]
)
def test_broker_failure_halts_alerts_and_cancels_risk_adding_orders(
    engine: RiskEngine, decision_log: DecisionLog, store: RiskStateStore, exc: Exception
) -> None:
    resting_buy = BrokerOrder("B-OLD", order("BBB", Side.BUY, "1", "10"), OrderStatus.OPEN, Decimal(0), T0)
    resting_exit = BrokerOrder(
        "B-EXIT", order("CCC", Side.SELL, "1", "49", reduce_only=True), OrderStatus.OPEN, Decimal(0), T0
    )
    spy = SpyBroker(fail_with=exc, open=[resting_buy, resting_exit])
    router, alerter, _ = make_router(engine, decision_log, spy)
    result = router.submit(order("AAA", Side.BUY, "0.1", "100"), pf("50"), QUOTES)
    assert not result.sent
    assert result.error
    assert store.read_halt().active
    assert alerter.sent[0][0] == "critical", "the alert goes out first"
    assert spy.cancelled == ["B-OLD"], "risk-adding orders are cancelled, exits keep working"
    day = store.read_day()
    assert day is not None
    assert day.trades["stocks"] == 1, "a failed send still counts (conservative)"


def test_kill_landing_after_approval_withholds_the_order(
    engine: RiskEngine, decision_log: DecisionLog, store: RiskStateStore
) -> None:
    """A kill that lands between evaluate() and place_order() must stop the order (race fix)."""
    spy = SpyBroker()

    def register_then_kill(o: OrderRequest) -> None:
        store.set_kill("kill raced the cycle", T0)

    router, _, _ = make_router(engine, decision_log, spy, register=register_then_kill)
    result = router.submit(order("AAA", Side.BUY, "0.1", "100"), pf("50"), QUOTES)
    assert result.decision.approved
    assert not result.sent
    assert spy.placed == []
    assert result.error is not None
    assert "withheld" in result.error


def test_bookkeeping_failure_never_blocks_an_emergency_exit(
    engine: RiskEngine, decision_log: DecisionLog, store: RiskStateStore
) -> None:
    spy = SpyBroker()

    def broken_register(o: OrderRequest) -> None:
        raise OSError("disk full")

    router, alerter, _ = make_router(engine, decision_log, spy, register=broken_register)
    exit_order = order("AAA", Side.SELL, "0.1", "98", reduce_only=True)
    result = router.submit(exit_order, pf("40", {"AAA": "0.1"}), QUOTES)
    assert result.sent, "the exit goes out anyway"
    assert spy.placed == [exit_order]
    assert store.read_halt().active
    assert any("emergency exit" in title for _, title, _ in alerter.sent)

    # ...but a risk-ADDING order with broken bookkeeping is not sent.
    store.clear_halt(T0, by="test")
    spy.placed.clear()
    result = router.submit(order("BBB", Side.BUY, "0.2", "10"), pf("50"), QUOTES)
    assert not result.sent
    assert spy.placed == []


def test_corrupt_trade_counter_does_not_block_flatten(
    engine: RiskEngine, decision_log: DecisionLog, store: RiskStateStore, state_dir: Path
) -> None:
    spy = SpyBroker()
    router, _, _ = make_router(engine, decision_log, spy)
    (state_dir / "risk_day.json").write_text("{corrupt", encoding="utf-8")
    store.set_kill("emergency", T0)
    results, problems = router.flatten(pf("10", {"AAA": "0.1"}), QUOTES, "emergency", Decimal("0.0001"))
    assert problems == []
    assert [o.symbol for o in spy.placed] == ["AAA"]
    assert results[0].sent


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


@pytest.mark.parametrize(
    ("exit_order", "quotes", "why"),
    [
        (
            order("AAA", Side.SELL, "0.1", "98", reduce_only=True),
            {"AAA": q("AAA", "100", ts=T0 - timedelta(hours=1))},
            "stale",
        ),
        (order("AAA", Side.SELL, "0.2", "98", reduce_only=True), QUOTES, "exceeds the sellable position"),
        (order("AAA", Side.SELL, "0.1", "97", reduce_only=True), QUOTES, "200 bps"),
    ],
)
def test_router_enforces_reduce_only_rejections(
    engine: RiskEngine,
    decision_log: DecisionLog,
    store: RiskStateStore,
    exit_order: OrderRequest,
    quotes: dict[str, Quote],
    why: str,
) -> None:
    spy = SpyBroker()
    router, _, registered = make_router(engine, decision_log, spy)
    store.set_kill("emergency", T0)
    result = router.submit(exit_order, pf("40", {"AAA": "0.1"}), quotes)
    assert not result.sent
    assert why in " ".join(result.decision.reasons)
    assert spy.placed == []
    assert registered == []
    assert store.read_day() is None, "a rejected exit is not counted"


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


def test_sim_reserves_cash_and_shares_for_resting_orders(clock: FixedClock) -> None:
    b = sim(clock)
    b.place_order(order("AAA", Side.BUY, "0.3", "99"))  # rests, reserves EUR 29.70
    with pytest.raises(BrokerRejected, match="insufficient cash"):
        b.place_order(order("AAA", Side.BUY, "0.3", "99"))  # another 29.70 > 20.30 available
    b.cancel_all_orders()
    b.place_order(order("BBB", Side.BUY, "2", "10.02"))  # fills: hold 2 BBB
    b.place_order(order("BBB", Side.SELL, "1.5", "11"))  # rests above market, claims 1.5
    with pytest.raises(BrokerRejected, match=r"only 0\.5 available"):
        b.place_order(order("BBB", Side.SELL, "1", "11"))


def test_sim_rejects_duplicates_overspend_and_shorts(clock: FixedClock) -> None:
    b = sim(clock)
    o = order("AAA", Side.BUY, "0.1", "101")
    b.place_order(o)
    with pytest.raises(BrokerRejected, match="duplicate"):
        b.place_order(o)
    with pytest.raises(BrokerRejected, match="insufficient cash"):
        b.place_order(order("AAA", Side.BUY, "1", "101"))
    with pytest.raises(BrokerRejected, match="available"):
        b.place_order(order("BBB", Side.SELL, "1", "9"))


def test_sim_never_drops_a_resting_order_silently(clock: FixedClock) -> None:
    prices = dict(QUOTES)
    b = SimBroker(
        starting_cash=Decimal("50"),
        fee_eur=Decimal("0"),
        fee_bps=Decimal("0"),
        slippage_bps=Decimal("10"),
        price_source=prices.get,
        clock=clock,
    )
    b.place_order(order("AAA", Side.BUY, "0.4", "99"))  # rests (needs 39.60 reserved)
    b._cash = Decimal("1")  # cash vanishes behind the bot's back
    prices["AAA"] = q("AAA", "90")  # now marketable, but unaffordable
    with pytest.raises(BrokerError, match="could no longer fill"):
        b.account()


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
