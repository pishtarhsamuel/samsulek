"""Stock cost model (costs/stocks.py): prices, fees, attribution, the no-fill guard, P10.

P10: with uniform costs and no FX, ``StockCostModel`` prices every fill exactly like M1's
``LegacyPricer`` with the same slippage, including through the simulated broker (the new
broker with the cost model against the frozen M1 broker, fill for fill). The guard
tests pin the boundaries of spec section 5 (exact tick margin, 2x beyond the collar, FX fee
above 100 bps, commission) and check, with the engine's own rounding helpers, that a
configuration the guard accepts can never leave an approved order unfilled.
"""

from __future__ import annotations

import copy
import dataclasses
import json
import pickle
from datetime import timedelta
from decimal import Decimal
from types import MappingProxyType

import pytest
from hypothesis import given
from hypothesis import strategies as st

from helpers import T0, make_risk_config
from m1_sim_broker_oracle import M1SimBroker
from samsulek.clock import FixedClock
from samsulek.config import MarketLimits
from samsulek.costs import BPS, FillPricer
from samsulek.costs.stocks import (
    CostBreakdown,
    StockCostModel,
    StockCostParams,
    cost_guard_problems,
)
from samsulek.execution.broker import BrokerRejected
from samsulek.execution.sim_broker import LegacyPricer, SimBroker
from samsulek.risk.sizing import ceil_to_step, floor_to_step
from samsulek.types import Market, OrderRequest, OrderType, Quote, Side

LIMITS: MarketLimits = make_risk_config().limits_for(Market.STOCKS)  # collar 50 bps
TICK = Decimal("0.01")


def params(
    *,
    hs: dict[str, Decimal] | None = None,
    sl: str = "5",
    adv: str = "0",
    fx: str = "15",
    commission: str = "0",
    currency: dict[str, str] | None = None,
) -> StockCostParams:
    """The spec's UNVERIFIED defaults: half spread 10, slippage 5, adverse 0, FX fee 15 bps."""
    return StockCostParams(
        half_spread_bps=hs if hs is not None else {"AAA": Decimal(10), "BBB": Decimal(10)},
        slippage_bps=Decimal(sl),
        adverse_bps=Decimal(adv),
        fx_fee_bps=Decimal(fx),
        commission_eur=Decimal(commission),
        currency=currency if currency is not None else {"AAA": "EUR", "BBB": "USD"},
    )


def buy(symbol: str = "AAA", qty: str = "2", limit: str | None = "1000", cid: str = "c1") -> OrderRequest:
    otype = OrderType.LIMIT if limit is not None else OrderType.MARKET
    return OrderRequest(
        cid, Market.STOCKS, symbol, Side.BUY, Decimal(qty), otype, Decimal(limit) if limit else None
    )


def sell(symbol: str = "AAA", qty: str = "2", limit: str = "0.01", cid: str = "c2") -> OrderRequest:
    return OrderRequest(cid, Market.STOCKS, symbol, Side.SELL, Decimal(qty), OrderType.LIMIT, Decimal(limit))


# ------------------------------------------------------------------ parameters
def test_params_copy_their_tables_and_pickle() -> None:
    hs = {"AAA": Decimal(10)}
    cur = {"AAA": "EUR"}
    p = params(hs=hs, currency=cur)
    hs["AAA"] = Decimal(-5)  # the caller's dict changing later changes nothing
    cur["AAA"] = "USD"
    assert p.half_spread_bps == {"AAA": Decimal(10)}
    assert p.currency == {"AAA": "EUR"}
    proxied = StockCostParams(
        half_spread_bps=MappingProxyType({"AAA": Decimal(10)}),
        slippage_bps=Decimal(5),
        adverse_bps=Decimal(0),
        fx_fee_bps=Decimal(15),
        commission_eur=Decimal(0),
        currency=MappingProxyType({"AAA": "EUR"}),
    )
    assert not isinstance(proxied.half_spread_bps, MappingProxyType)  # it would not pickle
    for protocol in (pickle.DEFAULT_PROTOCOL, pickle.HIGHEST_PROTOCOL):
        back = pickle.loads(pickle.dumps(proxied, protocol=protocol))  # noqa: S301 (our own object)
        assert back == proxied
        assert type(back.half_spread_bps) is type(proxied.half_spread_bps)  # still read-only
    assert copy.deepcopy(p) == p
    assert dataclasses.replace(p, slippage_bps=Decimal(6)).half_spread_bps == {"AAA": Decimal(10)}
    with pytest.raises(AttributeError):
        p.slippage_bps = Decimal(0)  # type: ignore[misc]


def test_the_checked_tables_cannot_be_edited_afterwards() -> None:
    # A6: no internal mutable container is exposed, so a negative spread can never be slipped
    # in after the construction checks and the cost guard have run.
    p = params(hs={"AAA": Decimal(10)}, currency={"AAA": "EUR"})
    for table in (p.half_spread_bps, p.currency, pickle.loads(pickle.dumps(p)).half_spread_bps):  # noqa: S301
        edits = (
            lambda t: t.__setitem__("AAA", Decimal(-50)),
            lambda t: t.__delitem__("AAA"),
            lambda t: t.update({"AAA": Decimal(-50)}),
            lambda t: t.setdefault("BBB", Decimal(-50)),
            lambda t: t.pop("AAA"),
            lambda t: t.popitem(),
            lambda t: t.clear(),
            lambda t: t.__ior__({"AAA": Decimal(-50)}),
        )
        for edit in edits:
            with pytest.raises(TypeError, match="read-only"):
                edit(table)
        assert isinstance(table, dict)  # readers see an ordinary dict
    assert p.half_spread_bps == {"AAA": Decimal(10)}
    assert p.currency == {"AAA": "EUR"}
    editable = dict(p.half_spread_bps)
    editable["AAA"] = Decimal(1)  # a copy is the caller's own
    assert p.half_spread_bps["AAA"] == Decimal(10)
    assert json.dumps(p.currency) == '{"AAA": "EUR"}'


@pytest.mark.parametrize(
    ("kwargs", "named"),
    [
        ({"sl": "-1"}, "slippage_bps"),
        ({"adv": "NaN"}, "adverse_bps"),
        ({"fx": "Infinity"}, "fx_fee_bps"),
        ({"commission": "-0.5"}, "commission_eur"),
        ({"hs": {"AAA": Decimal(-1)}}, "half_spread_bps['AAA']"),
        ({"hs": {"AAA": 10}}, "half_spread_bps['AAA']"),  # an int, not a Decimal
        ({"currency": {"AAA": "eur"}}, "currency['AAA']"),
        ({"currency": {"AAA": "EURO"}}, "currency['AAA']"),
        ({"hs": {"": Decimal(1)}}, "non-empty string"),
    ],
)
def test_params_refuse_values_that_could_make_a_fill_too_good(kwargs: dict[str, object], named: str) -> None:
    with pytest.raises(ValueError, match="invalid stock cost parameters") as info:
        params(**kwargs)  # type: ignore[arg-type]
    assert named in str(info.value)


def test_params_list_every_problem_at_once() -> None:
    with pytest.raises(ValueError, match="slippage_bps") as info:
        params(sl="-1", fx="-2", currency={"AAA": "x"})
    assert "fx_fee_bps" in str(info.value)
    assert "currency['AAA']" in str(info.value)


# ------------------------------------------------------------------ the model
def test_model_refuses_bad_multipliers_and_commission() -> None:
    for m in (0, 3, -1, True, 1.0):
        with pytest.raises(ValueError, match="multiplier must be 1 or 2"):
            StockCostModel(params(), multiplier=m)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="commission_eur must be 0"):
        StockCostModel(params(commission="1"), multiplier=1)
    model = StockCostModel(params(), multiplier=2)
    assert model.multiplier == 2
    with pytest.raises(AttributeError):
        model.multiplier = 0  # type: ignore[misc]  # read-only: costs can never be switched off later
    assert model.total_bps("AAA") == 30
    pricer: FillPricer = model  # satisfies the Protocol (checked by mypy in src)
    assert pricer.fee(buy(), Decimal(1), Decimal(1)) == 0


def test_prices_hand_vectors() -> None:
    p = params(hs={"AAA": Decimal(10)}, sl="5", adv="2", currency={"AAA": "EUR"})
    one, two = StockCostModel(p, multiplier=1), StockCostModel(p, multiplier=2)
    # 1x: 10 + 5 + 2 = 17 bps; 2x: 34 bps
    assert one.total_bps("AAA") == 17
    assert two.total_bps("AAA") == 34
    assert one.expected_fill_price("AAA", Side.BUY, Decimal(100)) == Decimal("100.17")
    assert one.expected_fill_price("AAA", Side.SELL, Decimal(100)) == Decimal("99.83")
    assert two.expected_fill_price("AAA", Side.BUY, Decimal(100)) == Decimal("100.34")
    assert two.expected_fill_price("AAA", Side.SELL, Decimal(100)) == Decimal("99.66")
    assert two.execution_price(buy(), Decimal(100)) == Decimal("100.34")
    assert two.execution_price(sell(), Decimal(100)) == Decimal("99.66")
    # Not rounded to the tick: 7.13 x 1.0017 = 7.142121
    assert one.expected_fill_price("AAA", Side.BUY, Decimal("7.13")) == Decimal("7.142121")
    # A plain string is not a side: never silently priced as a sell.
    with pytest.raises(ValueError, match="side must be"):
        one.expected_fill_price("AAA", "buy", Decimal(100))  # type: ignore[arg-type]


def test_fees_hand_vectors() -> None:
    p = params(hs={"AAA": Decimal(10), "BBB": Decimal(10)}, fx="15", currency={"AAA": "EUR", "BBB": "USD"})
    one, two = StockCostModel(p, multiplier=1), StockCostModel(p, multiplier=2)
    assert one.fee_for("AAA", Decimal(2), Decimal(50)) == 0  # EUR instrument: no FX fee
    assert two.fee(buy("AAA"), Decimal(2), Decimal(50)) == 0
    # USD instrument: 2 x 50 = 100 EUR of value; 1x 15 bps = 0.15; 2x 30 bps = 0.30
    assert one.fee_for("BBB", Decimal(2), Decimal(50)) == Decimal("0.15")
    assert two.fee_for("BBB", Decimal(2), Decimal(50)) == Decimal("0.30")
    assert two.fee(buy("BBB"), Decimal(2), Decimal(50)) == Decimal("0.30")
    assert two.buy_cash_needed(buy("BBB"), Decimal(2), Decimal(50)) == Decimal("100.30")
    assert two.buy_cash_needed(buy("AAA"), Decimal(2), Decimal(50)) == Decimal(100)


def test_attribution_splits_the_whole_cost() -> None:
    p = params(hs={"AAA": Decimal(10)}, sl="5", adv="2", currency={"AAA": "EUR"})
    two = StockCostModel(p, multiplier=2)
    # 3 x 40 = 120 EUR; spread 2 x 10 bps = 0.24; slippage + drift 2 x 7 bps = 0.168
    got = two.attribution("AAA", Decimal(3), Decimal(40))
    assert got == CostBreakdown(spread_eur=Decimal("0.24"), slippage_eur=Decimal("0.168"))
    fill = two.expected_fill_price("AAA", Side.BUY, Decimal(40))
    assert got.spread_eur + got.slippage_eur == Decimal(3) * (fill - Decimal(40))


def test_a_symbol_without_costs_is_never_priced_at_zero() -> None:
    model = StockCostModel(params(hs={"AAA": Decimal(10)}, currency={"AAA": "EUR"}), multiplier=1)
    with pytest.raises(ValueError, match="no half spread for ZZZ"):
        model.execution_price(buy("ZZZ"), Decimal(10))
    with pytest.raises(ValueError, match="no half spread for ZZZ"):
        model.attribution("ZZZ", Decimal(1), Decimal(10))
    with pytest.raises(ValueError, match="no currency for ZZZ"):
        model.fee(buy("ZZZ"), Decimal(1), Decimal(10))


def test_the_stock_model_refuses_memecoin_orders() -> None:
    model = StockCostModel(params(), multiplier=1)
    meme = OrderRequest("m1", Market.MEMECOIN, "AAA", Side.BUY, Decimal(1), OrderType.LIMIT, Decimal(1))
    with pytest.raises(ValueError, match="cannot price a memecoin order"):
        model.execution_price(meme, Decimal(1))
    with pytest.raises(ValueError, match="cannot price a memecoin order"):
        model.fee(meme, Decimal(1), Decimal(1))


# ------------------------------------------------------------------ P10: same as M1's pricer
bps_values = st.decimals(min_value=0, max_value=60, places=2, allow_nan=False, allow_infinity=False)
prices = st.decimals(min_value=Decimal("0.01"), max_value=Decimal(5000), places=4)
quantities = st.decimals(min_value=Decimal("0.000001"), max_value=Decimal(100), places=6)


@given(hs=bps_values, sl=bps_values, adv=bps_values, ref=prices, qty=quantities, side=st.sampled_from(Side))
def test_p10_uniform_costs_without_fx_equal_the_legacy_pricer(
    hs: Decimal, sl: Decimal, adv: Decimal, ref: Decimal, qty: Decimal, side: Side
) -> None:
    p = StockCostParams(
        half_spread_bps={"AAA": hs},
        slippage_bps=sl,
        adverse_bps=adv,
        fx_fee_bps=Decimal(15),  # charged on non-EUR instruments only
        commission_eur=Decimal(0),
        currency={"AAA": "EUR"},
    )
    for m in (1, 2):
        model = StockCostModel(p, multiplier=m)
        legacy = LegacyPricer(fee_eur=Decimal(0), fee_bps=Decimal(0), slippage_bps=m * (hs + sl + adv))
        o = buy() if side is Side.BUY else sell()
        px = model.execution_price(o, ref)
        assert px == legacy.execution_price(o, ref)
        assert model.fee(o, qty, px) == legacy.fee(o, qty, px)
        assert model.buy_cash_needed(o, qty, px) == legacy.buy_cash_needed(o, qty, px)


@given(fx=bps_values, ref=prices, qty=quantities)
def test_the_fx_fee_equals_the_legacy_proportional_fee(fx: Decimal, ref: Decimal, qty: Decimal) -> None:
    p = params(hs={"BBB": Decimal(0)}, sl="0", fx=str(fx), currency={"BBB": "USD"})
    model = StockCostModel(p, multiplier=1)
    legacy = LegacyPricer(fee_eur=Decimal(0), fee_bps=fx, slippage_bps=Decimal(0))
    assert model.fee(buy("BBB"), qty, ref) == legacy.fee(buy("BBB"), qty, ref)


def _run_broker(
    broker: SimBroker | M1SimBroker, clock: FixedClock, prices_now: dict[str, Decimal], script: list[tuple]
) -> list:
    out: list[object] = []
    for step, (sym, side, qty, limit_factor, move) in enumerate(script):
        clock.advance(timedelta(minutes=1))
        prices_now[sym] = (prices_now[sym] * (1 + move)).quantize(Decimal("0.0001"))
        limit = (prices_now[sym] * limit_factor).quantize(Decimal("0.01"))
        try:
            o = OrderRequest(f"c{step}", Market.STOCKS, sym, side, qty, OrderType.LIMIT, limit)
            r = broker.place_order(o)
            out.append((r.broker_id, r.status, r.filled_quantity))
        except BrokerRejected as exc:
            out.append(("rejected", str(exc)))
        try:
            acc = broker.account()
            out.append((acc.cash, sorted((s, p.quantity, p.avg_price) for s, p in acc.positions.items())))
        except Exception as exc:  # both brokers must fail the same way, if at all
            out.append((type(exc).__name__, str(exc)))
        if step % 3 == 2:
            out.append(("cancelled", broker.cancel_all_orders()))
    out.append(
        [(f.fill_id, f.client_id, f.side, f.quantity, f.price, f.fee, f.ts) for f in broker.fills_since(None)]
    )
    return out


@given(
    hs=bps_values,
    sl=bps_values,
    m=st.sampled_from([1, 2]),
    script=st.lists(
        st.tuples(
            st.sampled_from(["AAA", "BBB"]),
            st.sampled_from(Side),
            st.decimals(min_value=Decimal("0.01"), max_value=Decimal(3), places=3),
            st.decimals(min_value=Decimal("0.99"), max_value=Decimal("1.01"), places=4),
            st.decimals(min_value=Decimal("-0.02"), max_value=Decimal("0.02"), places=4),
        ),
        max_size=25,
    ),
)
def test_p10_fill_for_fill_through_the_simulated_broker(
    hs: Decimal, sl: Decimal, m: int, script: list[tuple]
) -> None:
    p = params(hs={"AAA": hs, "BBB": hs}, sl=str(sl), currency={"AAA": "EUR", "BBB": "EUR"})
    runs = []
    for pricer in (StockCostModel(p, multiplier=m), None):
        clock = FixedClock(T0)
        prices_now = {"AAA": Decimal("50"), "BBB": Decimal("7.5")}

        def source(
            symbol: str, prices_now: dict[str, Decimal] = prices_now, clock: FixedClock = clock
        ) -> Quote:
            return Quote(symbol, Market.STOCKS, prices_now[symbol], clock.now())

        zero = Decimal(0)
        broker: SimBroker | M1SimBroker
        if pricer is not None:
            broker = SimBroker(
                starting_cash=Decimal(100),
                fee_eur=zero,
                fee_bps=zero,
                slippage_bps=zero,
                price_source=source,
                clock=clock,
                pricer=pricer,
            )
        else:  # the frozen M1 broker itself, with the same costs as plain slippage
            broker = M1SimBroker(
                starting_cash=Decimal(100),
                fee_eur=zero,
                fee_bps=zero,
                slippage_bps=m * (hs + sl),
                price_source=source,
                clock=clock,
            )
        runs.append(_run_broker(broker, clock, prices_now, script))
    assert runs[0] == runs[1]


def test_the_fx_fee_is_charged_and_reserved_through_the_simulated_broker() -> None:
    # A USD instrument at 2x: fill 40 x (1 + 2 x 15 / 10_000) = 40.12; FX fee 2 x 15 bps of the value.
    p = params(hs={"BBB": Decimal(10)}, sl="5", fx="15", currency={"BBB": "USD"})
    model = StockCostModel(p, multiplier=2)
    clock = FixedClock(T0)
    zero = Decimal(0)
    broker = SimBroker(
        starting_cash=Decimal(100),
        fee_eur=zero,
        fee_bps=zero,
        slippage_bps=zero,
        price_source=lambda s: Quote(s, Market.STOCKS, Decimal(40), clock.now()),
        clock=clock,
        pricer=model,
    )
    # Cash check at the limit, fee included: 2 x 49.95 = 99.90, plus 0.2997 of fee > 100.
    with pytest.raises(BrokerRejected, match=r"need 100\.1997, available 100\.0000"):
        broker.place_order(buy("BBB", qty="2", limit="49.95", cid="too-big"))
    placed = broker.place_order(buy("BBB", qty="2", limit="41", cid="ok"))
    assert placed.filled_quantity == 2
    (fill,) = broker.fills_since(None)
    assert fill.price == Decimal("40.12") == model.expected_fill_price("BBB", Side.BUY, Decimal(40))
    assert fill.fee == Decimal("0.24072") == model.fee_for("BBB", Decimal(2), Decimal("40.12"))
    assert broker.account().cash == Decimal(100) - Decimal("80.24") - Decimal("0.24072")
    # A resting buy reserves its limit value plus the FX fee on it.
    broker.place_order(buy("BBB", qty="0.4", limit="39", cid="rest"))  # 40.12 > 39: stays open
    with pytest.raises(BrokerRejected, match="insufficient cash for next"):
        # free: 19.51928 - (15.6 + 0.0468) = 3.87248; 0.1 x 39 x 1.003 = 3.9117 does not fit
        broker.place_order(buy("BBB", qty="0.1", limit="39", cid="next"))


# ------------------------------------------------------------------ the no-fill guard
def test_the_default_costs_pass_the_guard_above_eur_5() -> None:
    # 2x: 2 x (10 + 5 + 0) = 30 bps; tick term 10_000 x 0.01 / min_ref must stay below 20 bps
    assert (
        cost_guard_problems(
            params(), LIMITS, symbols=["AAA", "BBB"], price_tick=TICK, min_reference_eur=Decimal("5.0001")
        )
        == []
    )


def test_the_exact_tick_margin_is_refused() -> None:
    # min_ref 5: 30 + 10_000 x 0.01 / 5 = 30 + 20 = 50, not strictly below the 50 bps collar
    problems = cost_guard_problems(
        params(), LIMITS, symbols=["AAA", "BBB"], price_tick=TICK, min_reference_eur=Decimal(5)
    )
    assert len(problems) == 1
    assert "at 2x costs" in problems[0]
    assert "50 bps slippage collar" in problems[0]


def test_2x_beyond_the_collar_is_refused_even_when_1x_fits() -> None:
    # worst symbol: 15 + 5 + 0 = 20 bps; 1x 20 + 1 < 50 fits, 2x 40 + 10_000 x 0.01 / 100 = 41 fits;
    # with a half spread of 20: 1x 25 + 1 fits, 2x 50 + 1 does not.
    wide = params(hs={"AAA": Decimal(10), "BBB": Decimal(20)})
    assert (
        cost_guard_problems(
            params(hs={"AAA": Decimal(10), "BBB": Decimal(15)}),
            LIMITS,
            symbols=["AAA", "BBB"],
            price_tick=TICK,
            min_reference_eur=Decimal(100),
        )
        == []
    )
    problems = cost_guard_problems(
        wide, LIMITS, symbols=["AAA", "BBB"], price_tick=TICK, min_reference_eur=Decimal(100)
    )
    assert len(problems) == 1
    assert problems[0].startswith("at 2x costs a fill can be 50 bps")
    # A symbol outside the run's universe does not count.
    assert (
        cost_guard_problems(wide, LIMITS, symbols=["AAA"], price_tick=TICK, min_reference_eur=Decimal(100))
        == []
    )


def test_a_cost_too_wide_even_at_1x_names_both_multipliers() -> None:
    # 60 + 5 = 65 bps at 1x and 130 at 2x, both beyond the 50 bps collar: two problems, not one.
    problems = cost_guard_problems(
        params(hs={"AAA": Decimal(60)}),
        LIMITS,
        symbols=["AAA"],
        price_tick=TICK,
        min_reference_eur=Decimal(100),
    )
    assert [p.split(" a fill")[0] for p in problems] == ["at 1x costs", "at 2x costs"]


def test_fx_fee_above_100_bps_at_2x_is_refused() -> None:
    ok = cost_guard_problems(
        params(fx="50"), LIMITS, symbols=["AAA"], price_tick=TICK, min_reference_eur=Decimal(100)
    )
    assert ok == []
    problems = cost_guard_problems(
        params(fx="50.01"), LIMITS, symbols=["AAA"], price_tick=TICK, min_reference_eur=Decimal(100)
    )
    assert problems == [
        "at 2x costs the FX fee is 100.02 bps, above the 100 bps that sizing's cash headroom covers"
    ]


def test_a_commission_is_refused() -> None:
    problems = cost_guard_problems(
        params(commission="1"), LIMITS, symbols=["AAA"], price_tick=TICK, min_reference_eur=Decimal(100)
    )
    assert len(problems) == 1
    assert "commission_eur must be 0" in problems[0]


def test_every_symbol_without_costs_is_named() -> None:
    p = params(hs={"AAA": Decimal(10), "BBB": Decimal(10)}, currency={"AAA": "EUR", "CCC": "EUR"})
    problems = cost_guard_problems(
        p, LIMITS, symbols=["DDD", "AAA", "CCC", "BBB"], price_tick=TICK, min_reference_eur=Decimal(100)
    )
    assert problems == [
        "no cost data for BBB: missing from currency",
        "no cost data for CCC: missing from half_spread_bps",
        "no cost data for DDD: missing from half_spread_bps and currency",
    ]


def test_bad_tick_reference_and_empty_universe_are_refused_together() -> None:
    problems = cost_guard_problems(
        params(fx="60", commission="2"),
        LIMITS,
        symbols=[],
        price_tick=Decimal(0),
        min_reference_eur=Decimal("NaN"),
    )
    assert any("universe is empty" in p for p in problems)
    assert any("price tick must be" in p for p in problems)
    assert any("smallest reference price must be" in p for p in problems)
    assert any("FX fee" in p for p in problems)
    assert any("commission_eur" in p for p in problems)
    assert len(problems) == 5  # every problem, not the first one


@given(
    hs=st.decimals(min_value=0, max_value=25, places=2),
    sl=st.decimals(min_value=0, max_value=10, places=2),
    adv=st.decimals(min_value=0, max_value=5, places=2),
    min_ref=st.decimals(min_value=Decimal("0.5"), max_value=Decimal(500), places=3),
    ref_factor=st.decimals(min_value=1, max_value=50, places=6),
    tick=st.sampled_from([Decimal("0.01"), Decimal("0.001"), Decimal("0.0001")]),
)
def test_an_accepted_cost_model_always_fills_inside_the_engines_limits(
    hs: Decimal, sl: Decimal, adv: Decimal, min_ref: Decimal, ref_factor: Decimal, tick: Decimal
) -> None:
    p = params(hs={"AAA": hs}, sl=str(sl), adv=str(adv), currency={"AAA": "EUR"})
    if cost_guard_problems(p, LIMITS, symbols=["AAA"], price_tick=tick, min_reference_eur=min_ref):
        return
    ref = min_ref * ref_factor  # any reference the run can see
    collar = LIMITS.max_slippage_bps / BPS
    for m in (1, 2):
        model = StockCostModel(p, multiplier=m)
        # The engine's own limit rounding (risk/sizing.py): buys round down, sells round up.
        assert model.expected_fill_price("AAA", Side.BUY, ref) <= floor_to_step(ref * (1 + collar), tick)
        assert model.expected_fill_price("AAA", Side.SELL, ref) >= ceil_to_step(ref * (1 - collar), tick)


def test_a_refused_configuration_really_can_leave_an_order_unfilled() -> None:
    # Why the guard exists: 49 bps of cost at a EUR 5 reference with a 0.01 tick.
    p = params(hs={"AAA": Decimal(44)}, sl="5", currency={"AAA": "EUR"})
    assert cost_guard_problems(p, LIMITS, symbols=["AAA"], price_tick=TICK, min_reference_eur=Decimal(5))
    limit = floor_to_step(Decimal(5) * (1 + LIMITS.max_slippage_bps / BPS), TICK)  # floor(5.025) = 5.02
    fill = StockCostModel(p, multiplier=1).expected_fill_price("AAA", Side.BUY, Decimal(5))  # 5.0245
    assert fill > limit
