from __future__ import annotations

from decimal import Decimal

import pytest

from helpers import make_risk_config, pf, q
from samsulek.risk.sizing import (
    CAP_HEADROOM,
    SizingError,
    ceil_to_step,
    clean_weights,
    floor_to_step,
    plan_orders,
)
from samsulek.types import Market, Side, TargetWeights

LIM = make_risk_config().limits_for(Market.STOCKS)
QUOTES = {"AAA": q("AAA", "100"), "BBB": q("BBB", "10"), "CCC": q("CCC", "50")}
STEP, TICK = Decimal("0.000001"), Decimal("0.0001")


def plan(weights: dict[str, float], portfolio=None, limits=LIM):  # type: ignore[no-untyped-def]
    return plan_orders(
        targets=TargetWeights(weights, "test"),
        market=Market.STOCKS,
        portfolio=portfolio or pf("50"),
        quotes=QUOTES,
        limits=limits,
        quantity_step=STEP,
        price_tick=TICK,
        id_prefix="T",
    )


def test_rounding_helpers() -> None:
    assert floor_to_step(Decimal("1.2345679"), STEP) == Decimal("1.234567")
    assert floor_to_step(Decimal("-1"), STEP) == 0
    assert ceil_to_step(Decimal("99.50001"), TICK) == Decimal("99.5001")


def test_weights_are_clipped_and_scaled() -> None:
    w = clean_weights(TargetWeights({"AAA": 0.9, "BBB": -0.2, "CCC": 0.1}, "x"), LIM)
    assert w["AAA"] == Decimal("0.30")  # clipped to max_position_pct
    assert w["BBB"] == 0  # long-only
    lim = make_risk_config(markets={"stocks": {"max_gross_exposure_pct": "0.4"}}).limits_for(Market.STOCKS)
    scaled = clean_weights(TargetWeights({"AAA": 0.3, "BBB": 0.3}, "x"), lim)
    assert sum(scaled.values()) <= Decimal("0.4")


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), "0.5"])
def test_invalid_weights_raise(bad: object) -> None:
    with pytest.raises(SizingError):
        clean_weights(TargetWeights({"AAA": bad}, "x"), LIM)  # type: ignore[dict-item]


def test_buys_respect_caps_headroom_and_collar() -> None:
    orders = plan({"AAA": 0.3, "BBB": 0.3, "CCC": 0.3})
    assert {o.side for o in orders} == {Side.BUY}
    for o in orders:
        ref = QUOTES[o.symbol].price
        assert o.limit_price is not None
        assert o.limit_price <= ref * Decimal("1.005")
        assert o.quantity * o.limit_price <= Decimal("15") * CAP_HEADROOM + Decimal("0.0001")
    assert sum(o.quantity * o.limit_price for o in orders if o.limit_price) <= Decimal("50")


def test_sells_come_before_buys_and_buys_use_only_cash_on_hand() -> None:
    portfolio = pf("1", {"AAA": "0.4"})  # EUR 40 of AAA, EUR 1 cash
    orders = plan({"BBB": 0.3}, portfolio)
    assert orders[0].side is Side.SELL and orders[0].symbol == "AAA"
    assert all(o.side is Side.SELL for o in orders), "no cash for buys until sells settle"


def test_full_exit_is_chunked_by_max_order() -> None:
    lim = make_risk_config(
        account={"equity_sanity_max_eur": "1000"},
        markets={"stocks": {"max_order_eur": "10", "max_position_eur": "20"}},
    ).limits_for(Market.STOCKS)
    orders = plan({}, pf("0", {"AAA": "0.25"}), lim)  # EUR 25 to sell, EUR 10 max per order
    assert all(o.side is Side.SELL and o.symbol == "AAA" for o in orders)
    assert all(o.quantity * o.limit_price <= Decimal("10") for o in orders if o.limit_price)
    assert sum(o.quantity for o in orders) == Decimal("0.25")
    assert len({o.client_id for o in orders}) == len(orders)


def test_dust_below_min_order_is_left_alone() -> None:
    assert plan({}, pf("49.5", {"BBB": "0.05"})) == []  # EUR 0.50 position, min order EUR 1


def test_small_rebalances_are_skipped() -> None:
    portfolio = pf("35.5", {"AAA": "0.145"})  # 14.50 held vs ~14.7 target
    assert plan({"AAA": 0.3}, portfolio) == []


def test_missing_price_for_target_raises() -> None:
    with pytest.raises(SizingError, match="no price"):
        plan({"ZZZ": 0.1})
