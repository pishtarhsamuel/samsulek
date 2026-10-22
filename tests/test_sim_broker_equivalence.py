"""P9: the new SimBroker's default path behaves exactly like the M1 broker.

``tests/m1_sim_broker_oracle.py`` is a frozen, verbatim copy of the M1 broker (class
renamed ``M1SimBroker``). Hypothesis drives both with the same random streams of orders
(limit and market, buys and sells, duplicate and reused client ids), cancels, account
calls, ``fills_since`` lookups, price moves, missing prices and injected failures, with
fees and slippage on and off, persisted to disk or not. Every return value is compared by
``repr`` (so even a Decimal's exponent must match), every exception by type and message,
and the persisted files byte for byte. Explicit cases pin the client-id rule of spec C22:
an id is in use only while an open order or a fill carries it, so after a failure at fill
time, a cancel or a dropped resting order, both brokers accept the same id again.
"""

from __future__ import annotations

import json
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import timedelta
from decimal import ROUND_DOWN, Decimal
from pathlib import Path
from typing import Any

import pytest
from hypothesis import given
from hypothesis import strategies as st

from helpers import T0
from m1_sim_broker_oracle import M1SimBroker
from samsulek.clock import FixedClock
from samsulek.execution.broker import BrokerError, BrokerRejected
from samsulek.execution.sim_broker import LegacyPricer, SimBroker
from samsulek.types import Market, OrderRequest, OrderType, Quote, Side

SYMBOLS = ("AAA", "BBB", "CCC")
POOL_IDS = ("dup-a", "dup-b", "dup-c")


@dataclass
class Market3:
    """A shared price source: both brokers see exactly the same prices at the same time."""

    clock: FixedClock
    prices: dict[str, Decimal] = field(
        default_factory=lambda: {"AAA": Decimal("50"), "BBB": Decimal("7.5"), "CCC": Decimal("123.4567")}
    )
    missing: set[str] = field(default_factory=set)

    def quote(self, symbol: str) -> Quote | None:
        if symbol in self.missing or symbol not in self.prices:
            return None
        return Quote(symbol, Market.STOCKS, self.prices[symbol], self.clock.now())


def outcome(fn: Callable[[], Any]) -> str:
    try:
        return "ok " + repr(fn())
    except Exception as exc:
        return f"raised {type(exc).__name__}: {exc}"


# ------------------------------------------------------------------ the op stream
place_op = st.tuples(
    st.just("place"),
    st.sampled_from(SYMBOLS),
    st.sampled_from(Side),
    st.one_of(
        st.decimals(min_value=Decimal("0.001"), max_value=Decimal("0.3"), places=3),
        st.decimals(min_value=Decimal("0.001"), max_value=Decimal(3), places=3),
    ),
    st.sampled_from([OrderType.LIMIT] * 5 + [OrderType.MARKET]),
    st.decimals(min_value=Decimal("0.97"), max_value=Decimal("1.03"), places=4),
    st.one_of(st.sampled_from(POOL_IDS), st.integers(0, 10**6).map(lambda i: f"u-{i}")),
)
# A sell of part of what is held (the quantity is worked out when the op runs), so sells
# get past the "only X available" check and reach the limit and fill logic.
sell_part_op = st.tuples(
    st.just("sell_part"),
    st.sampled_from(SYMBOLS),
    st.decimals(min_value=Decimal("0.05"), max_value=Decimal(1), places=2),
    st.sampled_from([OrderType.LIMIT] * 5 + [OrderType.MARKET]),
    st.decimals(min_value=Decimal("0.97"), max_value=Decimal("1.03"), places=4),
    st.integers(0, 10**6).map(lambda i: f"s-{i}"),
)
other_op = st.one_of(
    st.tuples(st.just("cancel"), st.integers(0, 40)),
    st.tuples(st.just("cancel_all")),
    st.tuples(st.just("account")),
    st.tuples(st.just("match")),
    st.tuples(st.just("fills_since"), st.integers(-2, 40)),
    st.tuples(
        st.just("move"),
        st.sampled_from(SYMBOLS),
        st.decimals(min_value=Decimal("0.95"), max_value=Decimal("1.05"), places=4),
    ),
    st.tuples(st.just("toggle_missing"), st.sampled_from(SYMBOLS)),
    st.tuples(st.just("fail_next")),
)
# Orders dominate the stream (about 45% buys or sells, 25% sells of held positions);
# every other operation shows up now and then.
ops = st.lists(
    st.integers(0, 99).flatmap(lambda k: place_op if k < 45 else sell_part_op if k < 70 else other_op),
    min_size=10,
    max_size=60,
)
settings_st = st.fixed_dictionaries(
    {
        "starting_cash": st.sampled_from([Decimal(20), Decimal(100), Decimal("57.31")]),
        "fee_eur": st.sampled_from([Decimal(0), Decimal("0.5"), Decimal(1)]),
        "fee_bps": st.sampled_from([Decimal(0), Decimal(15), Decimal("30.5")]),
        "slippage_bps": st.sampled_from([Decimal(0), Decimal(10), Decimal("25.25")]),
        "persist": st.booleans(),
    }
)


def apply(broker: Any, op: tuple[Any, ...], market: Market3, orders: list[str], fills: list[str]) -> str:
    kind = op[0]
    if kind == "place":
        _, sym, side, qty, otype, factor, cid = op
        limit = (market.prices[sym] * factor).quantize(Decimal("0.01")) if otype is OrderType.LIMIT else None
        return outcome(
            lambda: broker.place_order(OrderRequest(cid, Market.STOCKS, sym, side, qty, otype, limit))
        )
    if kind == "cancel_id":
        return outcome(lambda: broker.cancel_order(op[1]))
    if kind == "cancel_all":
        return outcome(broker.cancel_all_orders)
    if kind == "account":
        return outcome(broker.account)
    if kind == "match":
        return outcome(broker.match_open_orders)
    if kind == "fills_since":
        i = op[1]
        after = None if i == -2 else "SIM-000000-F" if i == -1 else fills[i] if i < len(fills) else None
        return outcome(lambda: broker.fills_since(after))
    if kind == "fail_next":
        broker.fail_next = BrokerError("injected outage")
        return "armed"
    raise AssertionError(kind)


def _same_after_reload(paths: tuple[Path, Path], market: Market3, settings: dict[str, Any]) -> None:
    assert paths[0].read_bytes() == paths[1].read_bytes()
    old = M1SimBroker(price_source=market.quote, clock=market.clock, state_path=paths[0], **settings)
    new = SimBroker(price_source=market.quote, clock=market.clock, state_path=paths[1], **settings)
    for cid in (*POOL_IDS, "fresh-id"):  # the reloaded id rule: duplicates refused, free ids accepted
        order = OrderRequest(
            cid, Market.STOCKS, "AAA", Side.BUY, Decimal("0.001"), OrderType.LIMIT, Decimal(1)
        )
        assert outcome(lambda o=order: old.place_order(o)) == outcome(lambda o=order: new.place_order(o))
    assert repr(old.fills_since(None)) == repr(new.fills_since(None))
    assert outcome(old.account) == outcome(new.account)
    assert paths[0].read_bytes() == paths[1].read_bytes()


def _drive(old: Any, new: Any, market: Market3, stream: list[tuple]) -> None:
    """Run one op stream on both brokers: every result, and the fill history after each op, agree."""
    clock = market.clock
    orders: list[str] = list(new._open)  # read only: open ids from a loaded file, cancel targets
    fills: list[str] = [f.fill_id for f in new.fills_since(None)]
    for drawn in stream:
        clock.advance(timedelta(seconds=30))
        if drawn[0] == "move":
            market.prices[drawn[1]] = (market.prices[drawn[1]] * drawn[2]).quantize(Decimal("0.0001"))
            continue
        if drawn[0] == "toggle_missing":
            market.missing ^= {drawn[1]}
            continue
        op = drawn
        if drawn[0] == "cancel":
            # Half the cancels hit an order that is resting right now (so its id must become
            # free again), the rest any id the stream has seen, or one that never existed.
            resting = list(old._open)  # read only; both brokers cancel the same id
            k = drawn[1]
            if k % 2 == 0 and resting:
                target = resting[(k // 2) % len(resting)]
            else:
                target = orders[k] if k < len(orders) else "SIM-999999"
            op = ("cancel_id", target)
        if drawn[0] == "sell_part":
            _, sym, fraction, otype, factor, cid = drawn
            held = old._positions.get(sym)  # read only; both brokers get the same order
            qty = max(
                Decimal("0.001"),
                ((held.quantity if held else 0) * fraction).quantize(Decimal("0.001"), ROUND_DOWN),
            )
            op = ("place", sym, Side.SELL, qty, otype, factor, cid)
        a = apply(old, op, market, orders, fills)
        b = apply(new, op, market, orders, fills)
        assert a == b, op
        if op[0] == "place" and a.startswith("ok "):
            orders.append(a.split("broker_id='", 1)[1].split("'", 1)[0])
        if old.fail_next is None and new.fail_next is None:  # a read here must not use up a failure
            assert repr(old.fills_since(None)) == repr(new.fills_since(None))
            fills[:] = [f.fill_id for f in new.fills_since(None)]
    old.fail_next = new.fail_next = None
    assert outcome(old.account) == outcome(new.account)
    assert repr(old.fills_since(None)) == repr(new.fills_since(None))


@given(settings=settings_st, stream=ops)
def test_p9_the_default_path_equals_m1_on_random_streams(
    settings: dict[str, Any], stream: list[tuple]
) -> None:
    persist = settings.pop("persist")
    clock = FixedClock(T0)
    market = Market3(clock)
    with tempfile.TemporaryDirectory() as tmp:
        paths = (Path(tmp) / "m1.json", Path(tmp) / "new.json")
        old = M1SimBroker(
            price_source=market.quote, clock=clock, state_path=paths[0] if persist else None, **settings
        )
        new = SimBroker(
            price_source=market.quote, clock=clock, state_path=paths[1] if persist else None, **settings
        )
        _drive(old, new, market, stream)
        assert paths[0].exists() == paths[1].exists()
        if persist and paths[0].exists():
            _same_after_reload(paths, market, settings)


# Files that load but that the broker itself would never write: seq behind the open ids (a new
# order then overwrites an open entry), one client id on several open orders and fills, fill ids
# repeated (and repeated again by later fills), positions that do not match the fills, resting
# orders that can no longer be filled.
_open_entry = st.tuples(
    st.sampled_from(POOL_IDS),
    st.sampled_from(SYMBOLS),
    st.sampled_from(Side),
    st.sampled_from(["5", "60", "200"]),
)
damaged_files = st.fixed_dictionaries(
    {
        "cash": st.sampled_from(["0", "1", "100"]),
        "seq": st.integers(0, 3),
        "positions": st.dictionaries(st.sampled_from(SYMBOLS), st.sampled_from(["0.5", "2"]), max_size=2),
        "open": st.dictionaries(st.integers(1, 4), _open_entry, max_size=3),
        "fills": st.lists(st.tuples(st.integers(0, 4), st.sampled_from(POOL_IDS)), max_size=4),
    }
)


def _damaged(drawn: dict[str, Any]) -> dict[str, Any]:
    return {
        "cash": drawn["cash"],
        "seq": drawn["seq"],
        "positions": {
            s: {"market": "stocks", "quantity": q, "avg_price": "10"} for s, q in drawn["positions"].items()
        },
        "open": {
            f"SIM-{k:06d}": {
                **_open_buy(cid, limit=limit),
                "symbol": sym,
                "side": side.value,
            }
            for k, (cid, sym, side, limit) in drawn["open"].items()
        },
        "fills": [_fill(f"SIM-{k:06d}-F", cid) for k, cid in drawn["fills"]],
    }


@given(settings=settings_st, start=damaged_files, stream=ops)
def test_p9_a_damaged_but_loadable_file_behaves_like_m1(
    settings: dict[str, Any], start: dict[str, Any], stream: list[tuple]
) -> None:
    settings.pop("persist")
    clock = FixedClock(T0)
    market = Market3(clock)
    with tempfile.TemporaryDirectory() as tmp:
        paths = (Path(tmp) / "m1.json", Path(tmp) / "new.json")
        for path in paths:
            _write(path, _damaged(start))
        old = M1SimBroker(price_source=market.quote, clock=clock, state_path=paths[0], **settings)
        new = SimBroker(price_source=market.quote, clock=clock, state_path=paths[1], **settings)
        _drive(old, new, market, stream)
        _same_after_reload(paths, market, settings)


# ------------------------------------------------------------------ explicit cases (spec P9 and C22)
def _pair(source_for: Callable[[], Callable[[str], Quote | None]], **kw: Any) -> tuple[Any, Any, FixedClock]:
    clock = FixedClock(T0)
    settings: dict[str, Any] = {
        "starting_cash": Decimal(100),
        "fee_eur": Decimal(0),
        "fee_bps": Decimal(0),
        "slippage_bps": Decimal(10),
        **kw,
    }
    return (
        M1SimBroker(price_source=source_for(), clock=clock, **settings),
        SimBroker(price_source=source_for(), clock=clock, **settings),
        clock,
    )


def test_a_price_source_that_raises_inside_try_fill_leaves_the_id_free() -> None:
    def source_for() -> Callable[[str], Quote | None]:
        calls = {"n": 0}

        def source(symbol: str) -> Quote:
            calls["n"] += 1
            if calls["n"] == 1:  # a limit buy reads no price before _try_fill: this IS _try_fill
                raise RuntimeError("feed down")
            return Quote(symbol, Market.STOCKS, Decimal(10), T0)

        return source

    old, new, _ = _pair(source_for)
    order = OrderRequest("same-id", Market.STOCKS, "AAA", Side.BUY, Decimal(1), OrderType.LIMIT, Decimal(11))
    for broker in (old, new):
        with pytest.raises(RuntimeError, match="feed down"):
            broker.place_order(order)
    results = [outcome(lambda b=b: b.place_order(order)) for b in (old, new)]
    assert results[0] == results[1]
    assert "FILLED" in results[0]  # the id was free again in both
    assert repr(old.fills_since(None)) == repr(new.fills_since(None))


def test_a_price_source_that_raises_while_matching_keeps_the_resting_order_and_its_id() -> None:
    # The same failure inside match_open_orders (via account()): the resting order stays
    # open, so its id stays in use, until it is cancelled.
    class FlakySource:
        down = False

        def __call__(self, symbol: str) -> Quote:
            if self.down:
                raise RuntimeError("feed down")
            return Quote(symbol, Market.STOCKS, Decimal(12), T0)

    sources = [FlakySource(), FlakySource()]
    old, new, _ = _pair(sources.pop)
    resting = OrderRequest("rest", Market.STOCKS, "AAA", Side.BUY, Decimal(1), OrderType.LIMIT, Decimal(11))
    results: list[list[str]] = []
    for broker in (old, new):
        source = broker._prices  # the test's own source object, read only
        steps = [outcome(lambda b=broker: b.place_order(resting))]
        source.down = True
        steps.append(outcome(broker.account))
        steps.append(outcome(lambda b=broker: b.place_order(resting)))
        source.down = False
        steps.append(outcome(lambda b=broker: b.cancel_order("SIM-000001")))
        steps.append(outcome(lambda b=broker: b.place_order(resting)))
        steps.append(outcome(broker.account))
        results.append(steps)
    assert results[0] == results[1]
    assert "OPEN" in results[0][0]
    assert results[0][1] == "raised RuntimeError: feed down"
    assert results[0][2] == "raised BrokerRejected: duplicate client order id rest"
    assert results[0][3] == "ok None"
    assert "broker_id='SIM-000002'" in results[0][4]
    assert "OPEN" in results[0][4]


def test_a_fill_time_cash_shortfall_leaves_the_id_free() -> None:
    # A market buy is checked at one price and filled at the next read, which jumps:
    # the fill-time cost exceeds cash, so _try_fill rejects it.
    def source_for() -> Callable[[str], Quote | None]:
        calls = {"n": 0}

        def source(symbol: str) -> Quote:
            calls["n"] += 1
            price = Decimal(10) if calls["n"] == 1 else Decimal(1000)
            return Quote(symbol, Market.STOCKS, price, T0)

        return source

    old, new, _ = _pair(source_for)
    order = OrderRequest("same-id", Market.STOCKS, "AAA", Side.BUY, Decimal(5), OrderType.MARKET)
    results = [outcome(lambda b=b: b.place_order(order)) for b in (old, new)]
    assert results[0] == results[1]
    assert results[0].startswith("raised BrokerRejected: insufficient cash for same-id")
    cheap = OrderRequest("same-id", Market.STOCKS, "AAA", Side.BUY, Decimal("0.01"), OrderType.MARKET)
    again = [outcome(lambda b=b: b.place_order(cheap)) for b in (old, new)]
    assert again[0] == again[1]
    assert "FILLED" in again[0]


class UnderReservingPricer:
    """A pricer whose cash check is too optimistic, so the cost at fill time exceeds cash."""

    def execution_price(self, order: OrderRequest, reference: Decimal) -> Decimal:
        return reference

    def fee(self, order: OrderRequest, quantity: Decimal, price: Decimal) -> Decimal:
        return Decimal(0)

    def buy_cash_needed(self, order: OrderRequest, quantity: Decimal, price: Decimal) -> Decimal:
        return Decimal(0)


def test_a_pricer_whose_fill_cost_exceeds_cash_leaves_nothing_behind() -> None:
    clock = FixedClock(T0)
    zero = Decimal(0)
    broker = SimBroker(
        starting_cash=Decimal(10),
        fee_eur=zero,
        fee_bps=zero,
        slippage_bps=zero,
        price_source=lambda s: Quote(s, Market.STOCKS, Decimal(10), T0),
        clock=clock,
        pricer=UnderReservingPricer(),
    )
    big = OrderRequest("same-id", Market.STOCKS, "AAA", Side.BUY, Decimal(5), OrderType.LIMIT, Decimal(10))
    with pytest.raises(BrokerRejected, match=r"insufficient cash for same-id: need 50\.0000, have 10\.0000"):
        broker.place_order(big)
    acc = broker.account()
    assert (acc.cash, acc.positions, acc.open_orders) == (Decimal(10), {}, ())
    assert broker.fills_since(None) == []
    small = OrderRequest("same-id", Market.STOCKS, "AAA", Side.BUY, Decimal(1), OrderType.LIMIT, Decimal(10))
    placed = broker.place_order(small)
    assert placed.filled_quantity == 1  # the id is free, as in M1
    assert placed.broker_id == "SIM-000002"  # and, as in M1, the failed attempt used up SIM-000001
    assert [f.client_id for f in broker.fills_since(None)] == ["same-id"]


def _write(path: Path, data: dict[str, Any]) -> None:
    path.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")


def _open_buy(cid: str, limit: str = "10", qty: str = "1") -> dict[str, Any]:
    return {
        "client_id": cid,
        "market": "stocks",
        "symbol": "AAA",
        "side": "buy",
        "quantity": qty,
        "order_type": "limit",
        "limit_price": limit,
        "reduce_only": False,
        "reason": "",
    }


def _fill(fill_id: str, cid: str) -> dict[str, Any]:
    return {
        "fill_id": fill_id,
        "client_id": cid,
        "market": "stocks",
        "symbol": "AAA",
        "side": "buy",
        "quantity": "1",
        "price": "10",
        "fee": "0",
        "ts": T0.isoformat(),
    }


def _loaded_pair(tmp_path: Path, data: dict[str, Any], price: str = "9") -> tuple[Any, Any]:
    clock = FixedClock(T0)

    def source(symbol: str) -> Quote:
        return Quote(symbol, Market.STOCKS, Decimal(price), clock.now())

    brokers = []
    for name, cls in (("m1.json", M1SimBroker), ("new.json", SimBroker)):
        _write(tmp_path / name, data)
        brokers.append(
            cls(
                starting_cash=Decimal(0),
                fee_eur=Decimal(0),
                fee_bps=Decimal(0),
                slippage_bps=Decimal(0),
                price_source=source,
                clock=clock,
                state_path=tmp_path / name,
            )
        )
    return brokers[0], brokers[1]


def test_a_dropped_resting_order_frees_its_id(tmp_path: Path) -> None:
    # A resting buy the account can no longer pay for (cash edited down): match drops it.
    data = {"cash": "1", "seq": 1, "positions": {}, "open": {"SIM-000001": _open_buy("rest")}, "fills": []}
    old, new = _loaded_pair(tmp_path, data)
    results = [outcome(b.account) for b in (old, new)]
    assert results[0] == results[1]
    assert "broker rejected resting orders it could no longer fill: SIM-000001" in results[0]
    order = OrderRequest("rest", Market.STOCKS, "AAA", Side.BUY, Decimal("0.1"), OrderType.LIMIT, Decimal(9))
    again = [outcome(lambda b=b: b.place_order(order)) for b in (old, new)]
    assert again[0] == again[1]
    assert "FILLED" in again[0]
    assert (tmp_path / "m1.json").read_bytes() == (tmp_path / "new.json").read_bytes()


def test_cancelled_ids_are_free_again_but_filled_ones_never(tmp_path: Path) -> None:
    data = {"cash": "100", "seq": 0, "positions": {}, "open": {}, "fills": []}
    old, new = _loaded_pair(tmp_path, data, price="20")
    resting = OrderRequest("x", Market.STOCKS, "AAA", Side.BUY, Decimal(1), OrderType.LIMIT, Decimal(10))
    for b in (old, new):
        b.place_order(resting)
        b.cancel_order("SIM-000001")
        b.place_order(resting)  # free again after the cancel
        assert b.cancel_all_orders() == ["SIM-000002"]
        b.place_order(resting)  # and after cancel-all
    filling = OrderRequest("x", Market.STOCKS, "AAA", Side.BUY, Decimal(1), OrderType.LIMIT, Decimal(30))
    results = [outcome(lambda b=b: b.place_order(filling)) for b in (old, new)]
    assert results[0] == results[1] == "raised BrokerRejected: duplicate client order id x"
    for b in (old, new):
        b.cancel_all_orders()
        assert "FILLED" in outcome(lambda b=b: b.place_order(filling))
    results = [outcome(lambda b=b: b.place_order(filling)) for b in (old, new)]
    assert results[0] == results[1] == "raised BrokerRejected: duplicate client order id x"


def test_a_resting_order_that_fills_later_keeps_its_id_in_use() -> None:
    # Normal flow: a buy rests, the price falls, account() fills it. The id moves from the
    # open order to the fill in one step; it must stay used (M1 scans the fills).
    price = {"AAA": Decimal(20)}

    def source_for() -> Callable[[str], Quote | None]:
        return lambda s: Quote(s, Market.STOCKS, price[s], T0)

    old, new, _ = _pair(source_for, slippage_bps=Decimal(0))
    resting = OrderRequest("later", Market.STOCKS, "AAA", Side.BUY, Decimal(1), OrderType.LIMIT, Decimal(10))
    steps: list[list[str]] = [[outcome(lambda b=b: b.place_order(resting))] for b in (old, new)]
    price["AAA"] = Decimal(9)  # below the limit now
    for b, out in zip((old, new), steps, strict=True):
        out.append(outcome(b.account))
        out.append(outcome(lambda b=b: b.place_order(resting)))
    assert steps[0] == steps[1]
    assert "OPEN" in steps[0][0]
    assert "open_orders=()" in steps[0][1]  # filled while matching
    assert steps[0][2] == "raised BrokerRejected: duplicate client order id later"
    assert [f.client_id for f in new.fills_since(None)] == ["later"]


def test_an_id_carried_by_an_open_order_and_a_fill_stays_used_after_the_cancel(tmp_path: Path) -> None:
    # Only a damaged or hand-edited file can hold this; M1 still refuses the id while the
    # fill carries it, so the new broker must too (it counts carriers, not just ids).
    data = {
        "cash": "100",
        "seq": 2,
        "positions": {"AAA": {"market": "stocks", "quantity": "1", "avg_price": "10"}},
        "open": {"SIM-000002": _open_buy("twice", limit="5")},
        "fills": [_fill("SIM-000001-F", "twice")],
    }
    old, new = _loaded_pair(tmp_path, data)
    for b in (old, new):
        b.cancel_order("SIM-000002")
    order = OrderRequest("twice", Market.STOCKS, "AAA", Side.BUY, Decimal("0.1"), OrderType.LIMIT, Decimal(9))
    results = [outcome(lambda b=b: b.place_order(order)) for b in (old, new)]
    assert results[0] == results[1] == "raised BrokerRejected: duplicate client order id twice"


def test_fills_since_starts_after_the_first_fill_with_a_duplicated_id(tmp_path: Path) -> None:
    data = {
        "cash": "100",
        "seq": 3,
        "positions": {"AAA": {"market": "stocks", "quantity": "3", "avg_price": "10"}},
        "open": {},
        "fills": [_fill("SIM-000001-F", "a"), _fill("SIM-000002-F", "b"), _fill("SIM-000001-F", "c")],
    }
    old, new = _loaded_pair(tmp_path, data)
    assert repr(old.fills_since("SIM-000001-F")) == repr(new.fills_since("SIM-000001-F"))
    assert [f.client_id for f in new.fills_since("SIM-000001-F")] == ["b", "c"]
    for b in (old, new):
        with pytest.raises(BrokerError, match="unknown fill id nope: local and broker history disagree"):
            b.fills_since("nope")


def test_a_damaged_file_fails_the_same_way(tmp_path: Path) -> None:
    for name in ("m1.json", "new.json"):
        (tmp_path / name).write_text('{"cash": "1", "seq": "x"}', encoding="utf-8")
    errors = []
    for name, cls in (("m1.json", M1SimBroker), ("new.json", SimBroker)):
        errors.append(
            outcome(
                lambda cls=cls, name=name: cls(
                    starting_cash=Decimal(0),
                    fee_eur=Decimal(0),
                    fee_bps=Decimal(0),
                    slippage_bps=Decimal(0),
                    price_source=lambda s: None,
                    clock=FixedClock(T0),
                    state_path=tmp_path / name,
                )
            )
        )
    assert errors[0].replace("m1.json", "X") == errors[1].replace("new.json", "X")
    assert errors[0].startswith("raised BrokerError: simulated broker")


# ------------------------------------------------------------------ the pricer hook itself
def test_a_pricer_and_fee_settings_together_are_refused() -> None:
    pricer = LegacyPricer(fee_eur=Decimal(0), fee_bps=Decimal(0), slippage_bps=Decimal(5))
    base: dict[str, Any] = {
        "starting_cash": Decimal(10),
        "fee_eur": Decimal(0),
        "fee_bps": Decimal(0),
        "slippage_bps": Decimal(0),
        "price_source": lambda s: None,
        "clock": FixedClock(T0),
    }
    for name in ("fee_eur", "fee_bps", "slippage_bps"):
        for value in (Decimal("0.01"), Decimal(-1), Decimal("NaN")):
            with pytest.raises(ValueError, match="either a pricer or fee and slippage settings"):
                SimBroker(**{**base, name: value}, pricer=pricer)
    SimBroker(**base, pricer=pricer)  # zeros with a pricer are fine
    SimBroker(**{**base, "fee_eur": Decimal(1)})  # settings without a pricer are fine


def test_a_given_pricer_prices_every_fill() -> None:
    clock = FixedClock(T0)
    zero = Decimal(0)
    pricer = LegacyPricer(fee_eur=Decimal("0.5"), fee_bps=Decimal(20), slippage_bps=Decimal(25))
    with_pricer = SimBroker(
        starting_cash=Decimal(100),
        fee_eur=zero,
        fee_bps=zero,
        slippage_bps=zero,
        price_source=lambda s: Quote(s, Market.STOCKS, Decimal(40), clock.now()),
        clock=clock,
        pricer=pricer,
    )
    with_settings = M1SimBroker(
        starting_cash=Decimal(100),
        fee_eur=Decimal("0.5"),
        fee_bps=Decimal(20),
        slippage_bps=Decimal(25),
        price_source=lambda s: Quote(s, Market.STOCKS, Decimal(40), clock.now()),
        clock=clock,
    )
    buy = OrderRequest("b1", Market.STOCKS, "AAA", Side.BUY, Decimal(1), OrderType.LIMIT, Decimal(41))
    sell = OrderRequest("s1", Market.STOCKS, "AAA", Side.SELL, Decimal("0.5"), OrderType.LIMIT, Decimal(39))
    for b in (with_pricer, with_settings):
        b.place_order(buy)
        b.place_order(sell)
    assert repr(with_pricer.fills_since(None)) == repr(with_settings.fills_since(None))
    assert with_pricer.fills_since(None)[0].price == Decimal("40.1")  # 40 x 1.0025
