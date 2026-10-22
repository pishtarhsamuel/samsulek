"""Episodes, the profit-and-loss invariant, frozen equity and halt summaries (spec sections 4 and 6).

The invariant ``sum(pnl) + residual == final equity - start`` is checked three ways: on
hand-built cases (dust left, dust absorbed, dust sold), with Hypothesis on random trade
streams whose cash is kept the way the ledger keeps it (exact equality), and on a stream
with 28-digit FX-style prices where Decimal itself rounds (the allowance covers that, and
nothing a real bug could produce).
"""

from __future__ import annotations

import dataclasses
import decimal
from collections.abc import Sequence
from datetime import UTC, date, datetime, time, timedelta
from decimal import ROUND_DOWN, Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from samsulek.backtest import book
from samsulek.backtest.book import build_episodes, check_invariant, frozen_equity_series, summarize_halts
from samsulek.backtest.types import (
    BacktestIntegrityError,
    BuyAndHoldPlan,
    Detail,
    Episode,
    EquityPoint,
    FillRecord,
    HaltEvent,
    HaltKind,
    RiskMode,
    RunJob,
    RunResult,
    SessionRecord,
)
from samsulek.types import Fill, Market, Side

D0 = date(2024, 3, 1)
ONE = Decimal(1)


def day(i: int) -> date:
    return D0 + timedelta(days=i)


def ts(d: date) -> datetime:
    return datetime.combine(d, time(15, 30), tzinfo=UTC)


def sessions(
    n: int, *, targets: dict[int, dict[str, float]] | None = None, status: dict[int, str] | None = None
) -> list[SessionRecord]:
    targets = targets or {}
    status = status or {}
    return [
        SessionRecord(
            session=day(i),
            status=status.get(i, "done"),
            universe=("A", "B"),
            reset_before=False,
            orders_planned=0,
            orders_sent=0,
            orders_rejected=0,
            rejections=(),
            targets=tuple(sorted(targets.get(i, {}).items())),
            actual=(),
            open_equity=None,
        )
        for i in range(n)
    ]


_ids = iter(range(1_000_000))


def fill(
    i: int, symbol: str, side: Side, qty: str | Decimal, price: str | Decimal, fee: str = "0"
) -> FillRecord:
    n = next(_ids)
    f = Fill(
        fill_id=f"B{n}-F",
        client_id=f"c{n}",
        market=Market.STOCKS,
        symbol=symbol,
        side=side,
        quantity=Decimal(qty),
        price=Decimal(price),
        fee=Decimal(fee),
        ts=ts(day(i)) - timedelta(hours=8),
    )
    return FillRecord(
        session=day(i), fill=f, reference=Decimal(price), spread_eur=Decimal(0), slippage_eur=Decimal(0)
    )


def episodes_of(
    fills: Sequence[FillRecord], n: int, marks: dict[str, str] | None = None, **kw: object
) -> tuple[tuple[Episode, ...], Decimal]:
    targets = kw.pop("targets", None)
    return build_episodes(
        fills,
        sessions(n, targets=targets),  # type: ignore[arg-type]
        min_order_eur=kw.pop("min_order_eur", ONE),  # type: ignore[arg-type]
        last_marks={k: Decimal(v) for k, v in (marks or {}).items()},
    )


def job(mode: RiskMode = RiskMode.R) -> RunJob:
    return RunJob(
        index=0,
        label="strategy_R_1x",
        plan=BuyAndHoldPlan(weights0=(("A", 0.3),), anchor_closes=(("A", 1.0),)),
        universe=("A", "B"),
        min_history=1,
        first_session=day(0),
        last_session=day(9),
        risk_mode=mode,
        cost_multiplier=1,
        starting_cash_eur=Decimal(50),
        detail=Detail.FULL,
    )


def run_result(
    *,
    start: Decimal,
    final: Decimal,
    episodes: Sequence[Episode],
    residual: Decimal,
    fills: Sequence[FillRecord] = (),
    mode: RiskMode = RiskMode.R,
    halts: Sequence[HaltEvent] = (),
    recs: Sequence[SessionRecord] = (),
    points: Sequence[EquityPoint] | None = None,
    frozen: Sequence[EquityPoint] = (),
) -> RunResult:
    if points is None:
        points = [EquityPoint(session=day(9), ts=ts(day(9)), cash=final, gross=Decimal(0), equity=final)]
    return RunResult(
        job=job(mode),
        start_ts=ts(D0 - timedelta(days=1)),
        start_equity=start,
        equity=tuple(points),
        sessions=tuple(recs),
        fills=tuple(fills),
        halts=tuple(halts),
        episodes=tuple(episodes),
        residual_eur=residual,
        frozen_equity=tuple(frozen),
        decisions_gz=None,
        data_fingerprint="fp",
        risk_config_sha256="sha",
    )


# =============================================================================== episodes by hand
def test_one_round_trip() -> None:
    fills = [fill(1, "A", Side.BUY, "2", "10", fee="0.01"), fill(4, "A", Side.SELL, "2", "12", fee="0.02")]
    targets = {1: {"A": 0.3}, 2: {"A": 0.4}, 3: {"A": 0.2}, 4: {"A": 0.0}}
    (ep,), residual = episodes_of(fills, 6, targets=targets)
    assert ep == Episode(
        symbol="A",
        entry_session=day(1),
        exit_session=day(4),
        sessions_held=3,
        weight=pytest.approx(0.3),  # mean over sessions 1, 2, 3 (the exit session is excluded)
        buy_eur=Decimal("20"),
        sell_eur=Decimal("24"),
        fees_eur=Decimal("0.03"),
        pnl_eur=Decimal("3.97"),  # 24 - 0.02 - (20 + 0.01)
        open_at_end=False,
    )
    assert residual == 0


def test_dust_closes_the_episode_and_stays_as_residual() -> None:
    # sell 0.95 of 1: 0.05 x 12 = 0.60 < min order EUR 1 -> closed; dust valued at the last mark 13
    fills = [fill(1, "A", Side.BUY, "1", "10"), fill(2, "A", Side.SELL, "0.95", "12")]
    (ep,), residual = episodes_of(fills, 4, marks={"A": "13"})
    assert ep.exit_session == day(2)
    assert ep.pnl_eur == Decimal("1.4")  # 11.40 - 10
    assert residual == Decimal("0.65")
    assert ep.pnl_eur + residual == Decimal("-10") + Decimal("11.4") + Decimal("0.05") * 13


def test_a_remainder_above_the_minimum_keeps_the_episode_open() -> None:
    # 0.2 x 12 = 2.40 >= EUR 1: still open; two chunked sells in one session close it later
    fills = [
        fill(1, "A", Side.BUY, "1", "10"),
        fill(2, "A", Side.SELL, "0.8", "12"),
        fill(3, "A", Side.SELL, "0.1", "11"),
        fill(3, "A", Side.SELL, "0.1", "11"),
    ]
    (ep,), residual = episodes_of(fills, 5)
    assert (ep.entry_session, ep.exit_session, ep.sessions_held) == (day(1), day(3), 2)
    assert ep.sell_eur == Decimal("11.8")
    assert residual == 0


def test_zero_remainder_closes_even_with_a_zero_minimum() -> None:
    fills = [fill(1, "A", Side.BUY, "1", "10"), fill(2, "A", Side.SELL, "1", "9")]
    (ep,), _ = episodes_of(fills, 3, min_order_eur=Decimal(0))
    assert ep.exit_session == day(2)
    assert ep.pnl_eur == Decimal("-1")


def test_an_episode_open_at_the_end_is_marked() -> None:
    fills = [fill(2, "A", Side.BUY, "3", "10", fee="0.05")]
    (ep,), residual = episodes_of(
        fills, 5, marks={"A": "11"}, targets={2: {"A": 0.2}, 3: {"A": 0.4}, 4: {"A": 0.3}}
    )
    assert ep.open_at_end is True
    assert ep.exit_session is None
    assert ep.sessions_held == 3  # sessions 2, 3, 4: one past the last session minus the entry
    assert ep.weight == pytest.approx(0.3)
    assert ep.pnl_eur == Decimal("2.95")  # 3 x 11 - 30 - 0.05
    assert residual == 0


def test_the_episode_weight_skips_sessions_the_strategy_did_not_run_in() -> None:
    # Entry at session 1, exit at 4. Session 2 halted before the strategy ran (no targets):
    # skipped. Session 3 ended "done" with no targets (the strategy wanted all cash; the
    # sell came a session later): weight 0. Mean (0.3 + 0.0) / 2.
    fills = [fill(1, "A", Side.BUY, "1", "10"), fill(4, "A", Side.SELL, "1", "10")]
    recs = sessions(6, targets={1: {"A": 0.3}}, status={2: "halted"})
    (ep,), _ = build_episodes(fills, recs, min_order_eur=ONE, last_marks={})
    assert ep.weight == pytest.approx(0.15)
    halted_with_targets = sessions(6, targets={1: {"A": 0.3}, 2: {"A": 0.6}}, status={2: "halted"})
    (ep,), _ = build_episodes(fills, halted_with_targets, min_order_eur=ONE, last_marks={})
    assert ep.weight == pytest.approx(0.3)  # (0.3 + 0.6 + 0.0) / 3: halted after the strategy ran


def test_an_episode_opened_and_closed_in_one_session_weighs_its_entry_target() -> None:
    # [entry, exit) is empty here; the weight is the entry session's target, never 0 (a
    # random-entry copy needs a weight > 0).
    fills = [fill(1, "A", Side.BUY, "1", "10"), fill(1, "A", Side.SELL, "1", "10")]
    (ep,), _ = episodes_of(fills, 3, targets={1: {"A": 0.4}})
    assert (ep.sessions_held, ep.weight) == (0, pytest.approx(0.4))


def test_dust_absorbed_by_the_next_episode() -> None:
    fills = [
        fill(1, "A", Side.BUY, "1", "10"),
        fill(2, "A", Side.SELL, "0.95", "12"),  # leaves 0.05 dust
        fill(4, "A", Side.BUY, "1", "11"),  # new episode; it now holds 1.05
        fill(5, "A", Side.SELL, "1.05", "12"),  # sells the dust too
    ]
    (first, second), residual = episodes_of(fills, 7)
    assert first.pnl_eur == Decimal("1.4")
    assert second.pnl_eur == Decimal("1.6")  # 12.60 - 11
    assert residual == 0
    assert first.pnl_eur + second.pnl_eur == Decimal("-10") + Decimal("11.4") - 11 + Decimal("12.6")


def test_dust_sold_without_an_open_episode_goes_to_the_residual() -> None:
    fills = [
        fill(1, "A", Side.BUY, "1", "10"),
        fill(2, "A", Side.SELL, "0.95", "12"),  # dust 0.05
        fill(5, "A", Side.SELL, "0.05", "30", fee="0.01"),  # the dust grew to EUR 1.50 and was sold
    ]
    (ep,), residual = episodes_of(fills, 7)
    assert ep.pnl_eur == Decimal("1.4")
    assert residual == Decimal("1.49")


def test_episodes_come_back_in_opening_order() -> None:
    fills = [
        fill(1, "B", Side.BUY, "1", "10"),
        fill(1, "A", Side.BUY, "1", "10"),
        fill(2, "A", Side.SELL, "1", "10"),
        fill(3, "B", Side.SELL, "1", "10"),
    ]
    eps, _ = episodes_of(fills, 4)
    assert [e.symbol for e in eps] == ["B", "A"]


@pytest.mark.parametrize(
    ("fills", "message"),
    [
        ([fill(1, "A", Side.SELL, "1", "10")], "only 0 is held"),
        ([fill(1, "A", Side.BUY, "1", "10"), fill(2, "A", Side.SELL, "1.5", "10")], "only 1 is held"),
        ([fill(9, "A", Side.BUY, "1", "10")], "no session of the run"),
        ([fill(2, "A", Side.BUY, "1", "10"), fill(1, "A", Side.SELL, "1", "10")], "out of session order"),
        ([fill(1, "A", Side.BUY, "1", "10")], "no last mark"),
    ],
)
def test_fills_that_cannot_be_booked_void_the_run(fills: list[FillRecord], message: str) -> None:
    with pytest.raises(BacktestIntegrityError, match=message):
        episodes_of(fills, 4)


def test_duplicate_session_records_void_the_run() -> None:
    recs = sessions(2)
    with pytest.raises(BacktestIntegrityError, match="two session records"):
        build_episodes([], [*recs, recs[0]], min_order_eur=ONE, last_marks={})


# =============================================================================== the invariant
SYMBOLS = ("A", "B", "C")


@st.composite
def trade_streams(draw: st.DrawFn) -> tuple[list[FillRecord], dict[str, Decimal], Decimal, int]:
    """Random fills on 3 symbols with ledger-style cash; quantities on the 1e-6 step, prices on 1e-4."""
    n_sessions = draw(st.integers(1, 12))
    held = dict.fromkeys(SYMBOLS, Decimal(0))
    cash = Decimal(50)
    fills: list[FillRecord] = []
    session = 0
    for _ in range(draw(st.integers(0, 25))):
        session = min(n_sessions - 1, session + draw(st.integers(0, 1)))
        symbol = draw(st.sampled_from(SYMBOLS))
        price = Decimal(draw(st.integers(1, 900_000))) / 10_000
        fee = Decimal(draw(st.integers(0, 3000))) / 1_000_000
        if held[symbol] > 0 and draw(st.booleans()):
            micro = int(held[symbol] * 1_000_000)
            qty = Decimal(draw(st.integers(1, micro))) / 1_000_000
            fills.append(fill(session, symbol, Side.SELL, qty, price, str(fee)))
            held[symbol] -= qty
            cash += qty * price - fee  # exactly as portfolio/ledger.py books a sell
        else:
            qty = Decimal(draw(st.integers(1, 5_000_000))) / 1_000_000
            fills.append(fill(session, symbol, Side.BUY, qty, price, str(fee)))
            held[symbol] += qty
            cash -= qty * price + fee  # and a buy
    marks = {s: Decimal(draw(st.integers(1, 900_000))) / 10_000 for s in SYMBOLS}
    final = cash + sum((held[s] * marks[s] for s in SYMBOLS), Decimal(0))
    return fills, marks, final, n_sessions


@given(trade_streams(), st.sampled_from([Decimal(0), Decimal(1), Decimal("2.5")]))
def test_pnl_plus_residual_equals_the_equity_change_exactly(
    stream: tuple[list[FillRecord], dict[str, Decimal], Decimal, int], min_order: Decimal
) -> None:
    fills, marks, final, n = stream
    eps, residual = build_episodes(fills, sessions(n), min_order_eur=min_order, last_marks=marks)
    assert sum((e.pnl_eur for e in eps), Decimal(0)) + residual == final - Decimal(50)
    assert sum(1 for e in eps if e.open_at_end) <= len(SYMBOLS)
    assert all(0 <= e.sessions_held <= n for e in eps)
    assert all(e.buy_eur > 0 for e in eps)
    r = run_result(start=Decimal(50), final=final, episodes=eps, residual=residual, fills=fills)
    check_invariant(r)  # the production check agrees
    with pytest.raises(BacktestIntegrityError, match="do not add up"):
        check_invariant(dataclasses.replace(r, residual_eur=residual + Decimal("1e-12")))


def test_check_invariant_catches_a_missing_fee() -> None:
    fills = [fill(1, "A", Side.BUY, "2", "10", fee="0.03"), fill(2, "A", Side.SELL, "2", "11", fee="0.03")]
    eps, residual = episodes_of(fills, 3)
    final = Decimal(50) - Decimal("20.03") + Decimal("21.97")
    check_invariant(run_result(start=Decimal(50), final=final, episodes=eps, residual=residual))
    wrong = run_result(start=Decimal(50), final=final + Decimal("0.03"), episodes=eps, residual=residual)
    with pytest.raises(BacktestIntegrityError, match="do not add up") as info:
        check_invariant(wrong)
    assert info.value.label == "strategy_R_1x"
    assert info.value.session == day(9)


def test_check_invariant_needs_marks() -> None:
    r = run_result(start=Decimal(50), final=Decimal(50), episodes=(), residual=Decimal(0), points=[])
    with pytest.raises(BacktestIntegrityError, match="no equity marks"):
        check_invariant(r)


def test_decimal_rounding_is_allowed_but_nothing_more() -> None:
    # FX-converted prices carry 28 significant digits, so the ledger's running cash rounds
    # (as it does in a real run). The exact sum differs from it by ~1e-26, not by zero.
    rate = Decimal("1.0856")
    px = [Decimal(p) / rate for p in ("45.12", "47.33", "44.01", "52.70")]
    qty = [Decimal("0.276543"), Decimal("0.276543"), Decimal("0.301234"), Decimal("0.301234")]
    sides = [Side.BUY, Side.SELL, Side.BUY, Side.SELL]
    fills = []
    cash = Decimal(50)
    for i, (p, q, side) in enumerate(zip(px, qty, sides, strict=True)):
        price = p * (1 + Decimal("0.0015") if side is Side.BUY else 1 - Decimal("0.0015"))
        fee = q * price * Decimal(15) / Decimal(10_000)
        fills.append(fill(i + 1, "A", side, q, price, str(fee)))
        cash = cash - (q * price + fee) if side is Side.BUY else cash + (q * price - fee)
    eps, residual = episodes_of(fills, 6)
    exact_change = sum((e.pnl_eur for e in eps), Decimal(0)) + residual
    assert exact_change != cash - 50  # Decimal really rounded: a strict == would void this run
    r = run_result(start=Decimal(50), final=cash, episodes=eps, residual=residual, fills=fills)
    check_invariant(r)
    allowance = book._rounding_allowance(r)
    assert Decimal(0) < allowance < Decimal("1e-20")
    with pytest.raises(BacktestIntegrityError, match="do not add up"):
        check_invariant(dataclasses.replace(r, residual_eur=residual + Decimal("1e-15")))


BPS = Decimal(10_000)


@st.composite
def rounded_runs(draw: st.DrawFn) -> tuple[list[FillRecord], dict[str, Decimal], Decimal, Decimal, int]:
    """A run computed the way the broker, ledger and runner compute it, in Decimal's default
    28 digits: FX-converted prices (always 28 digits), or EUR prices from float reprs at
    levels down to EUR 0.30 (whose products can pass 28 digits). Cash stays >= 0.
    Returns (fills, last marks, final cash, final gross, sessions)."""
    fx = draw(st.booleans())
    rate = Decimal(draw(st.integers(9_000, 13_000))) / 10_000 if fx else Decimal(1)
    level = draw(st.sampled_from([0.3, 0.8, 1.7, 45.0]))
    m = draw(st.sampled_from([1, 2]))
    c = Decimal(15 * m) / BPS  # half spread 10 + slippage 5, times the multiplier
    fee_rate = Decimal(15 * m) / BPS if fx else Decimal(0)  # the FX fee; EUR instruments pay none

    def eur(native: float) -> Decimal:
        amount = Decimal(repr(native))
        return amount / rate if fx else amount

    n_sessions = draw(st.integers(1, 8))
    held = dict.fromkeys(SYMBOLS, Decimal(0))
    cash = Decimal(50)
    fills: list[FillRecord] = []
    session = 0
    for _ in range(draw(st.integers(0, 30))):
        session = min(n_sessions - 1, session + draw(st.integers(0, 1)))
        symbol = draw(st.sampled_from(SYMBOLS))
        ref = eur(level * draw(st.floats(0.8, 1.25)))
        if held[symbol] > 0 and draw(st.booleans()):
            price = ref * (1 - c)
            micro = int(held[symbol] * 1_000_000)
            qty = held[symbol] if draw(st.booleans()) else Decimal(draw(st.integers(1, micro))) / 1_000_000
            fee = fee_rate * qty * price
            cash += qty * price - fee  # portfolio/ledger.py, sell
            held[symbol] -= qty
            side = Side.SELL
        else:
            price = ref * (1 + c)
            budget = cash * Decimal(draw(st.integers(1, 30))) / 100
            qty = (budget / (price * (1 + fee_rate))).quantize(Decimal("0.000001"), rounding=ROUND_DOWN)
            if qty <= 0:
                continue
            fee = fee_rate * qty * price
            cash -= qty * price + fee  # portfolio/ledger.py, buy
            held[symbol] += qty
            side = Side.BUY
        fills.append(fill(session, symbol, side, qty, price, str(fee)))
    marks = {s: eur(level * draw(st.floats(0.8, 1.25))) for s in SYMBOLS}
    gross = sum((held[s] * marks[s] for s in SYMBOLS), Decimal(0))  # the runner's mark, rounded
    return fills, marks, cash, gross, n_sessions


@given(rounded_runs())
def test_the_rounding_allowance_never_voids_an_honest_run(
    run: tuple[list[FillRecord], dict[str, Decimal], Decimal, Decimal, int],
) -> None:
    # Soundness of the bound: whatever Decimal's 28-digit roundings did to the ledger's cash
    # and the final mark, an honest run passes; a bug of a billionth of a cent still fails.
    fills, marks, cash, gross, n = run
    eps, residual = build_episodes(fills, sessions(n), min_order_eur=ONE, last_marks=marks)
    point = EquityPoint(session=day(n - 1), ts=ts(day(n - 1)), cash=cash, gross=gross, equity=cash + gross)
    r = run_result(
        start=Decimal(50), final=point.equity, episodes=eps, residual=residual, fills=fills, points=[point]
    )
    r = dataclasses.replace(r, job=dataclasses.replace(r.job, universe=SYMBOLS))
    check_invariant(r)
    assert book._rounding_allowance(r) < Decimal("1e-18")
    with pytest.raises(BacktestIntegrityError, match="do not add up"):
        check_invariant(dataclasses.replace(r, residual_eur=residual + Decimal("1e-11")))


def test_a_eur_run_can_round_too() -> None:
    # Why the allowance applies to EUR runs as well: a EUR 0.49 price from a 17-digit float
    # repr times (1 + 15 bps) has 21 digits, and a step-sized quantity of 30 shares (EUR 15)
    # pushes the product past 28 digits. A strict == would void this honest run.
    price = Decimal(repr(0.49389640719491545)) * (1 + Decimal(15) / BPS)
    qty = Decimal("30.325253")
    with decimal.localcontext() as ctx:
        ctx.traps[decimal.Inexact] = True
        with pytest.raises(decimal.Inexact):
            _ = qty * price
    fills = [fill(1, "A", Side.BUY, qty, price)]
    cash = Decimal(50) - (qty * price + 0)
    mark = Decimal(repr(0.51))
    eps, residual = episodes_of(fills, 3, marks={"A": str(mark)})
    gross = qty * mark
    point = EquityPoint(session=day(2), ts=ts(day(2)), cash=cash, gross=gross, equity=cash + gross)
    r = run_result(
        start=Decimal(50), final=point.equity, episodes=eps, residual=residual, fills=fills, points=[point]
    )
    check_invariant(r)


def test_non_finite_amounts_void_the_run() -> None:
    fills = [fill(1, "A", Side.BUY, "1", "10")]
    for bad in ("NaN", "Infinity", "0", "-1"):
        with pytest.raises(BacktestIntegrityError, match="its last mark is"):
            episodes_of(fills, 3, marks={"A": bad})
    eps, residual = episodes_of(fills, 3, marks={"A": "11"})
    for bad in ("NaN", "Infinity"):
        r = run_result(start=Decimal(50), final=Decimal(bad), episodes=eps, residual=residual, fills=fills)
        with pytest.raises(BacktestIntegrityError, match="not finite"):
            check_invariant(r)


def test_arithmetic_that_cannot_stay_exact_voids_the_run() -> None:
    # 121 digits times 101 digits: past the 200-digit exact context, so a rounding would
    # hide in the episode sums. It is refused instead.
    huge = fill(1, "A", Side.BUY, "1." + "3" * 120, "7." + "1" * 100)
    with pytest.raises(BacktestIntegrityError, match="could not stay exact"):
        episodes_of([huge], 3, marks={"A": "7"})


# =============================================================================== frozen equity
def test_frozen_equity_series_marks_the_frozen_positions() -> None:
    closes = {
        ("A", day(1)): Decimal(10),
        ("A", day(2)): Decimal(11),
        ("B", day(1)): Decimal(5),
        ("B", day(2)): Decimal(4),
    }
    pts = frozen_equity_series(
        positions={"A": Decimal(2), "B": Decimal("0.5"), "C": Decimal(0)},
        cash=Decimal(3),
        sessions=[day(1), day(2)],
        close=lambda s, d: closes.get((s, d)),
        ts=ts,
    )
    assert pts == (
        EquityPoint(
            session=day(1), ts=ts(day(1)), cash=Decimal(3), gross=Decimal("22.5"), equity=Decimal("25.5")
        ),
        EquityPoint(
            session=day(2), ts=ts(day(2)), cash=Decimal(3), gross=Decimal("24"), equity=Decimal("27")
        ),
    )


def test_frozen_equity_series_stops_at_the_first_missing_close() -> None:
    closes = {("A", day(1)): Decimal(10), ("A", day(3)): Decimal(12)}
    pts = frozen_equity_series(
        positions={"A": Decimal(1)},
        cash=Decimal(0),
        sessions=[day(1), day(2), day(3)],
        close=lambda s, d: closes.get((s, d)),
        ts=ts,
    )
    assert [p.session for p in pts] == [day(1)]


def test_frozen_equity_series_with_cash_only_and_bad_positions() -> None:
    pts = frozen_equity_series(
        positions={}, cash=Decimal(7), sessions=[day(1)], close=lambda s, d: None, ts=ts
    )
    assert pts[0].equity == Decimal(7)
    with pytest.raises(ValueError, match=">= 0"):
        frozen_equity_series(
            positions={"A": Decimal(-1)}, cash=Decimal(0), sessions=[day(1)], close=lambda s, d: ONE, ts=ts
        )
    with pytest.raises(ValueError, match="frozen cash"):
        frozen_equity_series(
            positions={}, cash=Decimal("-0.01"), sessions=[day(1)], close=lambda s, d: ONE, ts=ts
        )
    with pytest.raises(ValueError, match="finite price > 0"):
        frozen_equity_series(
            positions={"A": ONE}, cash=Decimal(0), sessions=[day(1)], close=lambda s, d: Decimal(0), ts=ts
        )


# =============================================================================== halt summaries
def halt(i: int, *kinds: HaltKind, reset: bool = True, rehalt: bool = False) -> HaltEvent:
    return HaltEvent(
        session=day(i),
        ts=ts(day(i)) - timedelta(hours=8),
        kinds=kinds,
        reasons=tuple(f"{k} reason" for k in kinds),
        reset_at=ts(day(i + 1)) - timedelta(hours=9) if reset else None,
        peak_rebased_to=Decimal("47") if HaltKind.DRAWDOWN in kinds else None,
        immediate_rehalt=rehalt,
    )


def test_summarize_halts_counts() -> None:
    halts = [
        halt(2, HaltKind.DAILY_LOSS),
        halt(3, HaltKind.DAILY_LOSS, rehalt=True),
        halt(5, HaltKind.EQUITY_SANITY, HaltKind.DRAWDOWN),
        halt(7, HaltKind.CAP_DRIFT, reset=False),
    ]
    recs = sessions(9, status={2: "halted", 3: "halted", 5: "halted", 6: "blocked", 7: "halted"})
    points = [
        EquityPoint(
            session=day(i), ts=ts(day(i)), cash=Decimal(50 - i), gross=Decimal(0), equity=Decimal(50 - i)
        )
        for i in range(9)
    ]
    frozen = [
        EquityPoint(session=day(8), ts=ts(day(8)), cash=Decimal(1), gross=Decimal(45), equity=Decimal(46))
    ]
    r = run_result(
        start=Decimal(50),
        final=Decimal(42),
        episodes=(),
        residual=Decimal(0),
        halts=halts,
        recs=recs,
        points=points,
        frozen=frozen,
        mode=RiskMode.L,
    )
    s = summarize_halts(r)
    assert s.n_halts == 4
    assert s.sessions_halted == 5
    assert s.immediate_rehalts == 1
    assert s.first_halt_session == day(2)
    assert s.first_halt_equity == Decimal(48)  # the closing mark of that session
    assert s.equity_sanity_halts == 1
    assert s.cap_drift_halts == 1
    assert s.hard_stop_active_at_end is False  # L mode: resets, never a hard stop
    assert s.frozen_end_equity == Decimal(46)


def test_an_r_mode_halt_is_a_hard_stop() -> None:
    recs = sessions(4, status={1: "halted", 2: "blocked", 3: "blocked"})
    r = run_result(
        start=Decimal(50),
        final=Decimal(20),
        episodes=(),
        residual=Decimal(0),
        halts=[halt(1, HaltKind.DAILY_LOSS, reset=False)],
        recs=recs,
    )
    s = summarize_halts(r)
    assert s.hard_stop_active_at_end is True
    assert s.sessions_halted == 3
    assert s.first_halt_equity is None  # no mark for that session in this hand-built result
    assert s.frozen_end_equity is None


def test_no_halts() -> None:
    s = summarize_halts(
        run_result(start=Decimal(50), final=Decimal(51), episodes=(), residual=Decimal(0), recs=sessions(3))
    )
    assert (s.n_halts, s.sessions_halted, s.immediate_rehalts, s.equity_sanity_halts, s.cap_drift_halts) == (
        0,
    ) * 5
    assert (s.first_halt_session, s.first_halt_equity, s.frozen_end_equity) == (None, None, None)
    assert s.hard_stop_active_at_end is False
