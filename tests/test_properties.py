"""Property-based tests (Hypothesis): thousands of random portfolios, prices, limits and orders.

Invariants that must hold for EVERY input:
- an approved buy never breaks a position/exposure cap, never exceeds cash, respects order-size bounds
- an approved non-reduce-only sell never sells more than is held (no shorting)
- while halted or killed, only reduce-only exits are ever approved
- sizing output is internally safe (rounding direction, cash, caps)
- sizing and the risk engine agree: applying planned orders in sequence, the engine approves them all
- orders pushed toward every limit (with orders already resting on the same symbol) obey an
  oracle written in the test itself, not the portfolio helpers the engine uses

With stocks only and exposure capped at <= 100% of equity, the exposure cap already implies the
cash check, so the cash check itself is pinned by unit tests (test_review_regressions.py).
"""

from __future__ import annotations

from decimal import ROUND_DOWN, Decimal
from pathlib import Path
from tempfile import TemporaryDirectory

from hypothesis import assume, event, given, target
from hypothesis import strategies as st

from helpers import T0, UNIVERSE, make_risk_config
from samsulek.clock import FixedClock
from samsulek.risk.engine import BPS, RiskEngine
from samsulek.risk.sizing import plan_orders
from samsulek.risk.state import RiskStateStore
from samsulek.types import (
    Market,
    OrderRequest,
    OrderType,
    PortfolioSnapshot,
    Position,
    Quote,
    Side,
    TargetWeights,
)

SYMBOLS = ["AAA", "BBB", "CCC"]
STEP = Decimal("0.000001")
TICK = Decimal("0.0001")

money = st.decimals(min_value=Decimal("0.01"), max_value=Decimal("150"), places=2)
prices = st.decimals(min_value=Decimal("0.5"), max_value=Decimal("500"), places=4)
qtys = st.decimals(min_value=Decimal("0.000001"), max_value=Decimal("5"), places=6)
pcts = st.decimals(min_value=Decimal("0.05"), max_value=Decimal("1"), places=2)


@st.composite
def scenario(draw: st.DrawFn) -> tuple[PortfolioSnapshot, dict[str, Quote], dict[str, object]]:
    quotes = {s: Quote(s, Market.STOCKS, draw(prices), T0) for s in SYMBOLS}
    held = draw(st.lists(st.sampled_from(SYMBOLS), unique=True, max_size=3))
    positions = {s: Position(s, Market.STOCKS, draw(qtys), Decimal(1)) for s in held}
    cash = draw(money)
    # Orders still resting at the broker: they must count toward every limit.
    open_orders: list[OrderRequest] = []
    for i in range(draw(st.integers(min_value=0, max_value=2))):
        sym = draw(st.sampled_from(SYMBOLS))
        offset = Decimal(draw(st.integers(min_value=-100, max_value=100))) / BPS
        limit = (quotes[sym].price * (1 + offset)).quantize(TICK)
        if sym in positions and draw(st.booleans()):
            qty = min(draw(qtys), positions[sym].quantity)
            open_orders.append(
                OrderRequest(f"open-{i}", Market.STOCKS, sym, Side.SELL, qty, OrderType.LIMIT, limit)
            )
        else:
            qty = draw(st.decimals(min_value=Decimal("0.000001"), max_value=Decimal("0.2"), places=6))
            open_orders.append(
                OrderRequest(f"open-{i}", Market.STOCKS, sym, Side.BUY, qty, OrderType.LIMIT, limit)
            )
    # A broker only accepts resting buys that the cash covers.
    assume(
        sum(
            (o.quantity * o.limit_price for o in open_orders if o.side is Side.BUY and o.limit_price),
            Decimal(0),
        )
        <= cash
    )
    portfolio = PortfolioSnapshot(cash=cash, positions=positions, ts=T0, open_orders=tuple(open_orders))
    assume(Decimal("1") <= portfolio.equity(quotes) <= Decimal("190"))
    pos_pct = draw(pcts)
    gross_pct = max(pos_pct, draw(pcts))
    pos_eur = draw(st.decimals(min_value=Decimal("2"), max_value=Decimal("60"), places=0))
    gross_eur = max(pos_eur, draw(st.decimals(min_value=Decimal("2"), max_value=Decimal("120"), places=0)))
    stocks = {
        "max_position_pct": str(pos_pct),
        "max_gross_exposure_pct": str(gross_pct),
        "max_position_eur": str(pos_eur),
        "max_gross_exposure_eur": str(gross_eur),
        "max_order_eur": str(draw(st.decimals(min_value=Decimal("2"), max_value=Decimal("40"), places=0))),
        "min_order_eur": str(draw(st.decimals(min_value=Decimal("0"), max_value=Decimal("1.5"), places=1))),
        "max_slippage_bps": str(draw(st.integers(min_value=1, max_value=200))),
        "flatten_max_slippage_bps": "500",
        "max_trades_per_day": 1000,
    }
    return portfolio, quotes, {"markets": {"stocks": stocks}, "account": {"max_trades_per_day": 1000}}


def fresh_engine(tmp: str, overrides: dict[str, object]) -> RiskEngine:
    return RiskEngine(make_risk_config(**overrides), RiskStateStore(Path(tmp)), FixedClock(T0), UNIVERSE)


@given(
    scn=scenario(),
    symbol=st.sampled_from(SYMBOLS),
    side=st.sampled_from([Side.BUY, Side.SELL]),
    qty=qtys,
    limit_offset_bps=st.integers(min_value=-300, max_value=300),
)
def test_approved_orders_never_break_limits(
    scn: tuple[PortfolioSnapshot, dict[str, Quote], dict[str, object]],
    symbol: str,
    side: Side,
    qty: Decimal,
    limit_offset_bps: int,
) -> None:
    portfolio, quotes, overrides = scn
    ref = quotes[symbol].price
    limit = (ref * (1 + Decimal(limit_offset_bps) / BPS)).quantize(TICK)
    assume(limit > 0)
    o = OrderRequest("p-1", Market.STOCKS, symbol, side, qty, OrderType.LIMIT, limit)
    with TemporaryDirectory() as tmp:
        engine = fresh_engine(tmp, overrides)
        d = engine.evaluate(o, portfolio, quotes)
        if not d.approved:
            return
        lim = engine.config.limits_for(Market.STOCKS)
        equity = portfolio.equity(quotes)
        notional = qty * limit
        assert lim.min_order_eur <= notional <= lim.max_order_eur
        buys = [o for o in portfolio.open_orders if o.side is Side.BUY]
        reserved = sum((o.quantity * o.limit_price for o in buys if o.limit_price), Decimal(0))
        pending = {
            s: sum(
                (
                    o.quantity * max(o.limit_price, quotes[s].price)
                    for o in buys
                    if o.symbol == s and o.limit_price
                ),
                Decimal(0),
            )
            for s in SYMBOLS
        }
        if side is Side.BUY:
            assert limit <= ref * (1 + lim.max_slippage_bps / BPS)
            assert notional <= portfolio.cash - reserved
            added = qty * max(limit, ref)
            new_pos = portfolio.position_value(symbol, quotes) + pending[symbol] + added
            assert new_pos <= lim.max_position_pct * equity
            assert new_pos <= lim.max_position_eur
            new_gross = portfolio.gross_exposure(quotes) + sum(pending.values(), Decimal(0)) + added
            assert new_gross <= lim.max_gross_exposure_pct * equity
            assert new_gross <= lim.max_gross_exposure_eur
        else:
            assert limit >= ref * (1 - lim.max_slippage_bps / BPS)
            assert qty <= portfolio.sellable_quantity(symbol)


@given(
    scn=scenario(),
    symbol=st.sampled_from(SYMBOLS),
    side=st.sampled_from([Side.BUY, Side.SELL]),
    qty=qtys,
    reduce_only=st.booleans(),
    flag=st.sampled_from(["halt", "kill"]),
)
def test_halted_or_killed_only_reduce_only_exits_pass(
    scn: tuple[PortfolioSnapshot, dict[str, Quote], dict[str, object]],
    symbol: str,
    side: Side,
    qty: Decimal,
    reduce_only: bool,
    flag: str,
) -> None:
    portfolio, quotes, overrides = scn
    ref = quotes[symbol].price
    o = OrderRequest("p-2", Market.STOCKS, symbol, side, qty, OrderType.LIMIT, ref, reduce_only=reduce_only)
    with TemporaryDirectory() as tmp:
        engine = fresh_engine(tmp, overrides)
        store = RiskStateStore(Path(tmp))
        if flag == "halt":
            store.set_halt("property test", T0)
        else:
            store.set_kill("property test", T0)
        d = engine.evaluate(o, portfolio, quotes)
        if d.approved:
            assert o.reduce_only and o.side is Side.SELL
            assert o.quantity <= portfolio.sellable_quantity(symbol)


def _held(portfolio: PortfolioSnapshot, symbol: str) -> Decimal:
    pos = portfolio.positions.get(symbol)
    return pos.quantity if pos is not None else Decimal(0)


def _claimed_by_open_sells(portfolio: PortfolioSnapshot, symbol: str) -> Decimal:
    return sum(
        (o.quantity for o in portfolio.open_orders if o.symbol == symbol and o.side is Side.SELL), Decimal(0)
    )


def _reserved_by_open_buys(portfolio: PortfolioSnapshot) -> Decimal:
    return sum(
        (o.quantity * o.limit_price for o in portfolio.open_orders if o.side is Side.BUY and o.limit_price),
        Decimal(0),
    )


@given(
    scn=scenario(),
    symbol=st.sampled_from(SYMBOLS),
    side=st.sampled_from([Side.BUY, Side.SELL]),
    notional=st.decimals(min_value=Decimal("0.5"), max_value=Decimal("45"), places=2),
    size_vs_total=st.booleans(),
    fraction=st.decimals(min_value=Decimal("0.01"), max_value=Decimal("1.2"), places=2),
    resting_fraction=st.decimals(min_value=Decimal("0"), max_value=Decimal("0.9"), places=2),
    limit_offset_bps=st.integers(min_value=-80, max_value=80),
    reduce_only=st.booleans(),
)
def test_orders_near_the_limits_obey_an_independent_oracle(
    scn: tuple[PortfolioSnapshot, dict[str, Quote], dict[str, object]],
    symbol: str,
    side: Side,
    notional: Decimal,
    size_vs_total: bool,
    fraction: Decimal,
    resting_fraction: Decimal,
    limit_offset_bps: int,
    reduce_only: bool,
) -> None:
    """Orders sized like real ones and pushed toward every limit, checked by arithmetic written
    here rather than by the PortfolioSnapshot helpers the engine itself uses.

    Often an order of the same side already rests on the same symbol: it must count (shares it
    claims can't be sold again; cash it reserves can't be spent again; it adds to the position).
    """
    portfolio, quotes, overrides = scn
    ref = quotes[symbol].price
    limit = (ref * (1 + Decimal(limit_offset_bps) / BPS)).quantize(TICK)
    held = _held(portfolio, symbol)
    if side is Side.SELL:
        free = held - _claimed_by_open_sells(portfolio, symbol)
        resting = min(held * resting_fraction, free).quantize(STEP, rounding=ROUND_DOWN)
        resting_limit = ref * 2  # far above the market: it rests
    else:
        free_cash = portfolio.cash - _reserved_by_open_buys(portfolio)
        resting = (free_cash * resting_fraction / ref).quantize(STEP, rounding=ROUND_DOWN)
        resting_limit = ref
    if resting > 0:
        extra = OrderRequest("rest-1", Market.STOCKS, symbol, side, resting, OrderType.LIMIT, resting_limit)
        portfolio = PortfolioSnapshot(
            portfolio.cash, portfolio.positions, T0, open_orders=(*portfolio.open_orders, extra)
        )
    claimed = _claimed_by_open_sells(portfolio, symbol)
    reserved = _reserved_by_open_buys(portfolio)
    if side is Side.BUY:
        # Half the time size against ALL cash, reserved or not, so over-spending is tried.
        budget = portfolio.cash * fraction if size_vs_total else notional
        qty = (budget / limit).quantize(STEP, rounding=ROUND_DOWN)
        reduce_only = False
    else:
        qty = (held * fraction).quantize(STEP, rounding=ROUND_DOWN)  # vs ALL shares, claimed or not
    assume(qty > 0)
    o = OrderRequest("p-3", Market.STOCKS, symbol, side, qty, OrderType.LIMIT, limit, reduce_only=reduce_only)
    with TemporaryDirectory() as tmp:
        engine = fresh_engine(tmp, overrides)
        d = engine.evaluate(o, portfolio, quotes)
    event("approved" if d.approved else "rejected")
    target(1.0 if d.approved else 0.0, label="approved")
    if not d.approved:
        return
    lim = engine.config.limits_for(Market.STOCKS)
    values = {s: p.quantity * quotes[s].price for s, p in portfolio.positions.items()}
    equity = portfolio.cash + sum(values.values(), Decimal(0))
    if side is Side.SELL:
        # Steer the search toward the edge: approved sells as large as possible vs free shares.
        target(float(qty / max(held - claimed, STEP)), label="sell size / free shares")
        assert qty <= held - claimed, "never sell shares we don't have or already promised"
        collar = lim.flatten_max_slippage_bps if reduce_only else lim.max_slippage_bps
        assert limit >= ref * (1 - collar / BPS)
        if not reduce_only:
            assert lim.min_order_eur <= qty * limit <= lim.max_order_eur
        return

    open_buys = [x for x in portfolio.open_orders if x.side is Side.BUY and x.limit_price is not None]

    def pending(x: OrderRequest) -> Decimal:
        return x.quantity * max(x.limit_price or Decimal(0), quotes[x.symbol].price)

    added = qty * max(limit, ref)
    new_position = (
        values.get(symbol, Decimal(0))
        + sum((pending(x) for x in open_buys if x.symbol == symbol), Decimal(0))
        + added
    )
    new_gross = sum(values.values(), Decimal(0)) + sum((pending(x) for x in open_buys), Decimal(0)) + added
    position_cap = min(lim.max_position_pct * equity, lim.max_position_eur)
    gross_cap = min(lim.max_gross_exposure_pct * equity, lim.max_gross_exposure_eur)
    target(float(qty * limit / max(portfolio.cash - reserved, Decimal("0.01"))), label="cost / free cash")
    target(float(new_position / position_cap), label="position / cap")
    target(float(new_gross / gross_cap), label="exposure / cap")
    assert lim.min_order_eur <= qty * limit <= lim.max_order_eur
    assert limit <= ref * (1 + lim.max_slippage_bps / BPS)
    assert qty * limit <= portfolio.cash - reserved, "never spend cash an open buy already reserved"
    assert new_position <= position_cap
    assert new_gross <= gross_cap


weights = st.dictionaries(
    st.sampled_from(SYMBOLS),
    st.floats(min_value=-0.5, max_value=1.5, allow_nan=False, allow_infinity=False),
    max_size=3,
)


@given(scn=scenario(), w=weights)
def test_sizing_output_is_safe(
    scn: tuple[PortfolioSnapshot, dict[str, Quote], dict[str, object]], w: dict[str, float]
) -> None:
    portfolio, quotes, overrides = scn
    lim = make_risk_config(**overrides).limits_for(Market.STOCKS)
    orders = plan_orders(
        targets=TargetWeights(w, "prop"),
        market=Market.STOCKS,
        portfolio=portfolio,
        quotes=quotes,
        limits=lim,
        quantity_step=STEP,
        price_tick=TICK,
        id_prefix="p",
    )
    seen_buy = False
    buy_cost = Decimal(0)
    for o in orders:
        ref = quotes[o.symbol].price
        assert o.quantity > 0 and (o.quantity / STEP) == (o.quantity / STEP).to_integral_value()
        assert o.limit_price is not None
        if o.side is Side.SELL:
            assert not seen_buy, "sells must come before buys"
            assert o.quantity <= portfolio.sellable_quantity(o.symbol)
            assert o.limit_price >= ref * (1 - lim.max_slippage_bps / BPS)
        else:
            seen_buy = True
            assert o.limit_price <= ref * (1 + lim.max_slippage_bps / BPS)
            buy_cost += o.quantity * o.limit_price
            assert o.quantity * o.limit_price <= lim.max_order_eur
    reserved = sum(
        (o.quantity * o.limit_price for o in portfolio.open_orders if o.side is Side.BUY and o.limit_price),
        Decimal(0),
    )
    assert buy_cost <= portfolio.cash - reserved
    assert len({o.client_id for o in orders}) == len(orders)


@given(scn=scenario(), w=weights)
def test_sizing_and_risk_engine_agree(
    scn: tuple[PortfolioSnapshot, dict[str, Quote], dict[str, object]], w: dict[str, float]
) -> None:
    """Apply each planned order (filled at its limit price, the worst case) and re-check the next one."""
    portfolio, quotes, overrides = scn
    with TemporaryDirectory() as tmp:
        engine = fresh_engine(tmp, overrides)
        lim = engine.config.limits_for(Market.STOCKS)
        assume(portfolio.equity(quotes) <= engine.config.account.equity_sanity_max_eur)
        orders = plan_orders(
            targets=TargetWeights(w, "prop"),
            market=Market.STOCKS,
            portfolio=portfolio,
            quotes=quotes,
            limits=lim,
            quantity_step=STEP,
            price_tick=TICK,
            id_prefix="p",
        )
        for o in orders:
            d = engine.evaluate(o, portfolio, quotes)
            if not d.approved and engine.blocked_reason():
                return  # equity path tripped a halt (e.g. worst-case fills lost > daily limit)
            assert d.approved, f"sizing proposed an order the engine rejects: {d.reasons} for {o}"
            assert o.limit_price is not None
            positions = dict(portfolio.positions)
            held = portfolio.quantity(o.symbol)
            if o.side is Side.BUY:
                cash = portfolio.cash - o.quantity * o.limit_price
                positions[o.symbol] = Position(o.symbol, Market.STOCKS, held + o.quantity, Decimal(1))
            else:
                cash = portfolio.cash + o.quantity * o.limit_price
                left = held - o.quantity
                if left == 0:
                    positions.pop(o.symbol)
                else:
                    positions[o.symbol] = Position(o.symbol, Market.STOCKS, left, Decimal(1))
            portfolio = PortfolioSnapshot(
                cash=cash, positions=positions, ts=T0, open_orders=portfolio.open_orders
            )
