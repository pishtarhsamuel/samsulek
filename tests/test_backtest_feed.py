"""BacktestFeed: phase-checked, stateless quotes stamped at the print, fresh immutable bars,
raw marks only after the close (traps 2, 4, 10 and 19, feed parts)."""

from __future__ import annotations

import dataclasses
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import pytest

from helpers import make_risk_config, order, pf
from samsulek.backtest.dataset import Listing, PitDataset
from samsulek.backtest.feed import BacktestFeed, PhaseError
from samsulek.backtest.fx import FxIndex
from samsulek.backtest.sources import SourceData
from samsulek.backtest.synthetic_data import plant_split, synthetic_daily_bars
from samsulek.clock import FixedClock
from samsulek.data.calendars import XetraCalendar
from samsulek.data.sources import ecb
from samsulek.data.store import to_us
from samsulek.risk.engine import RiskEngine
from samsulek.risk.state import RiskStateStore
from samsulek.strategies.base import LookaheadError
from samsulek.types import Market, Quote, Side

CAL = XetraCalendar()
FIRST, LAST = date(2024, 1, 2), date(2024, 9, 30)
SESSIONS = CAL.sessions(FIRST, LAST)
CUTOFF = datetime(2024, 9, 30, 22, 0, tzinfo=UTC)
DELAY = timedelta(minutes=3)
SPLIT_EX = SESSIONS[100]
SPLIT_KNOWN = CAL.close_utc(SESSIONS[95]) + timedelta(hours=1)
C_LAST = SESSIONS[60]
E_FIRST = SESSIONS[40]
NOTE = "test fixture: hand-made symbol list"


def make_dataset() -> PitDataset:
    bars = synthetic_daily_bars(["A", "B", "C"], CAL, FIRST, LAST, seed=21)
    bars["B"], split = plant_split(bars["B"], SPLIT_EX, 2.0, SPLIT_KNOWN)
    bars["C"] = [b for b in bars["C"] if b.session <= C_LAST]
    bars["E"] = synthetic_daily_bars(["E"], CAL, E_FIRST, LAST, seed=22)["E"]
    listings = (
        Listing("A", "EUR", FIRST, None, None, NOTE),
        Listing("B", "EUR", FIRST, None, None, NOTE),
        Listing("C", "EUR", FIRST, C_LAST, CAL.close_utc(SESSIONS[70]), NOTE),  # known late
        Listing("E", "EUR", E_FIRST, None, None, NOTE),
    )
    rows = tuple(b for s in ("A", "B", "C", "E") for b in bars[s])
    return PitDataset.build(
        SourceData("fixture", False, rows, listings, (split,), None), calendar=CAL, cutoff=CUTOFF
    )


DS = make_dataset()
UNIVERSE = ("A", "B", "C", "E")


def execute_at(session: date, delay: timedelta = DELAY) -> datetime:
    return CAL.open_print_utc(session) + delay


def make_feed(
    clock: FixedClock, *, delay: timedelta = DELAY, window: int = 20, universe: tuple[str, ...] = UNIVERSE
) -> BacktestFeed:
    return BacktestFeed(DS, clock=clock, universe=universe, window=window, exec_delay=delay)


# ------------------------------------------------------------------ quotes (trap 2)
def test_trap02_quote_timestamps() -> None:
    """Quotes are stamped at the print, never at "now" (exec_delay 3 min)."""
    for session in SESSIONS[1:150:7]:
        clock = FixedClock(execute_at(session))
        feed = make_feed(clock)
        quote = feed.quote("A")
        assert quote is not None
        assert quote.ts == CAL.open_print_utc(session) != clock.now()
        assert quote.ts <= clock.now()
        assert quote.price == DS.raw_open_eur("A", session)
        assert quote.market is Market.STOCKS and quote.symbol == "A"


def test_with_no_delay_the_print_and_the_decision_coincide() -> None:
    session = SESSIONS[30]
    clock = FixedClock(CAL.open_print_utc(session))
    quote = make_feed(clock, delay=timedelta(0)).quote("B")
    assert quote is not None and quote.ts == clock.now() == CAL.open_print_utc(session)


def test_quotes_are_raw_whether_a_split_is_known_or_in_effect(tmp_path: Path) -> None:
    session = SESSIONS[98]  # the split is known, not yet in effect (its ex-date is session 100)
    clock = FixedClock(execute_at(session))
    feed = make_feed(clock)
    quote = feed.quote("B")
    assert quote is not None and quote.price == DS.raw_open_eur("B", session)
    bars = feed.bars_until(clock.now())["B"]
    assert bars[-1].close == float(DS.raw_close_eur("B", SESSIONS[97]))  # not adjusted yet
    after = SESSIONS[101]
    clock.set(execute_at(after))
    feed_after = make_feed(clock)
    raw_after = feed_after.quote("B")
    assert raw_after is not None and raw_after.price == DS.raw_open_eur("B", after)
    assert raw_after.price < quote.price * Decimal("0.7")  # the raw quote halves at the split
    bars_after = feed_after.bars_until(clock.now())["B"]
    assert bars_after[-1].close == float(DS.raw_close_eur("B", SPLIT_EX))  # the ex-date's own bar: raw
    assert bars_after[-2].close == pytest.approx(float(DS.raw_close_eur("B", SESSIONS[99])) * 0.5, rel=1e-12)


def test_a_non_eur_quote_is_the_open_in_eur_at_the_rate_public_at_the_print() -> None:
    first, last = date(2024, 12, 2), date(2025, 1, 31)
    days = [first + timedelta(days=i) for i in range(-10, (last - first).days + 1)]  # rates from before
    rows = [
        {
            "currency": "USD",
            "obs_date": d,
            "rate": str(Decimal("1.04") + Decimal(i % 9) / 100),
            "available_us": to_us(ecb.available_at(d)),
            "fetched_us": to_us(datetime(2026, 10, 1, tzinfo=UTC)),
        }
        for i, d in enumerate(days)
        if d.weekday() < 5
    ]
    fx = FxIndex.from_rows(rows)
    bars = [replace(b, currency="USD") for b in synthetic_daily_bars(["U"], CAL, first, last, seed=3)["U"]]
    listing = Listing("U", "USD", bars[0].session, None, None, NOTE)
    data = SourceData("fixture", False, tuple(bars), (listing,), (), fx)
    ds = PitDataset.build(data, calendar=CAL, cutoff=datetime(2025, 2, 1, tzinfo=UTC))
    for b in bars[1:]:
        clock = FixedClock(execute_at(b.session))
        quote = BacktestFeed(ds, clock=clock, universe=("U",), window=5, exec_delay=DELAY).quote("U")
        rate = fx.rate("USD", CAL.open_print_utc(b.session))
        assert quote is not None and rate is not None
        assert rate.obs_date < b.session  # at 09:05 Berlin only an earlier day's rate is public
        assert quote.price == Decimal(repr(b.open)) / rate.rate
        assert quote.ts == CAL.open_print_utc(b.session)


def engine_for(tmp_path: Path, clock: FixedClock) -> RiskEngine:
    return RiskEngine(
        make_risk_config(), RiskStateStore(tmp_path / "risk"), clock, {Market.STOCKS: list(UNIVERSE)}
    )


def test_the_engine_accepts_the_open_print_and_rejects_a_dead_listing_or_a_future_stamp(
    tmp_path: Path,
) -> None:
    session = SESSIONS[65]  # after C's last session (60), before its delisting is known (70)
    clock = FixedClock(execute_at(session))
    feed = make_feed(clock)
    engine = engine_for(tmp_path, clock)
    fresh = feed.quote("A")
    assert fresh is not None
    ok = engine.evaluate(order("A", Side.BUY, "0.1", fresh.price), pf("50"), {"A": fresh})
    assert ok.approved, ok.reasons
    dead = feed.quote("C")
    assert dead is not None and dead.ts == CAL.close_utc(C_LAST)  # its last close, at its own time
    assert dead.price == DS.raw_close_eur("C", C_LAST)
    stale = engine.evaluate(order("C", Side.BUY, "0.1", dead.price), pf("50"), {"C": dead})
    assert not stale.approved and "stale" in " ".join(stale.reasons)
    future = Quote("A", Market.STOCKS, fresh.price, clock.now() + timedelta(seconds=6))
    rejected = engine.evaluate(order("A", Side.BUY, "0.1", fresh.price), pf("50"), {"A": future})
    assert not rejected.approved and "in the future" in " ".join(rejected.reasons)


def test_quotes_outside_the_execution_instant_raise_phase_error() -> None:
    session = SESSIONS[20]
    instants = [
        CAL.open_print_utc(session),  # the print itself, but E is 3 minutes later
        execute_at(session) - timedelta(microseconds=1),
        execute_at(session) + timedelta(microseconds=1),
        CAL.close_utc(session),  # the mark instant
        CAL.close_utc(SESSIONS[19]),
        execute_at(session) + timedelta(hours=1),  # the right minute in the wrong timezone
        datetime(2024, 3, 9, 8, 8, tzinfo=UTC),  # a Saturday at 09:08 Berlin
        datetime(2024, 4, 1, 7, 8, tzinfo=UTC),  # Easter Monday at 09:08 Berlin
    ]
    for at in instants:
        feed = make_feed(FixedClock(at))
        with pytest.raises(PhaseError):
            feed.quote("A")


def test_quote_is_none_outside_the_universe_or_before_any_print() -> None:
    session = SESSIONS[10]
    clock = FixedClock(execute_at(session))
    assert make_feed(clock).quote("E") is None  # listed later: no print yet
    assert make_feed(clock, universe=("A",)).quote("B") is None
    assert make_feed(clock).quote("NOPE") is None
    clock.set(execute_at(E_FIRST))
    first = make_feed(clock).quote("E")
    assert first is not None and first.ts == CAL.open_print_utc(E_FIRST)


def test_the_feed_is_stateless() -> None:
    session = SESSIONS[50]
    clock = FixedClock(execute_at(session))
    feed = make_feed(clock)
    before = dict(vars(feed))
    first = [feed.quote(s) for s in UNIVERSE]
    feed.bars_until(clock.now())
    with pytest.raises(PhaseError):
        feed.mark("A", session)
    assert [feed.quote(s) for s in UNIVERSE] == first
    assert dict(vars(feed)) == before
    assert make_feed(clock).quote("A") == first[0]  # a second feed answers the same


# ---------------------------------------------------------------- bars (trap 4)
def test_bars_until_refuses_the_future() -> None:
    clock = FixedClock(execute_at(SESSIONS[30]))
    feed = make_feed(clock)
    with pytest.raises(LookaheadError):
        feed.bars_until(clock.now() + timedelta(microseconds=1))
    with pytest.raises(ValueError, match="timezone"):
        feed.bars_until(datetime(2024, 2, 1))  # noqa: DTZ001
    earlier = feed.bars_until(CAL.close_utc(SESSIONS[20]))
    assert earlier["A"][-1].close_ts == CAL.close_utc(SESSIONS[20])


def test_bars_until_gives_the_window_closed_by_asof_for_symbols_that_have_bars() -> None:
    session = SESSIONS[45]
    clock = FixedClock(execute_at(session))
    bars = make_feed(clock, window=7).bars_until(clock.now())
    assert set(bars) == {"A", "B", "C", "E"}
    assert all(1 <= len(v) <= 7 for v in bars.values())
    assert bars["A"][-1].close_ts == CAL.close_utc(SESSIONS[44])
    assert len(bars["E"]) == 5  # E started at session 40
    clock.set(execute_at(SESSIONS[39]))
    assert "E" not in make_feed(clock).bars_until(clock.now())  # no bars yet: omitted
    assert all(isinstance(v, tuple) for v in bars.values())


def test_trap04_tuples() -> None:
    """Returned containers cannot reach the feed, five sessions later included."""
    session = SESSIONS[80]
    clock = FixedClock(execute_at(session))
    feed = make_feed(clock)
    asof = clock.now()
    first = feed.bars_until(asof)
    copy = {k: tuple(v) for k, v in first.items()}
    first["A"] = ()
    del first["B"]
    first["ZZZ"] = ()
    with pytest.raises(TypeError):
        first["C"][0] = first["C"][1]  # type: ignore[index]
    with pytest.raises(dataclasses.FrozenInstanceError):
        first["C"][0].close = 1.0  # type: ignore[misc]
    assert feed.bars_until(asof) == copy
    assert feed.bars_until(asof) is not feed.bars_until(asof)
    fingerprint, state = DS.fingerprint, dict(vars(feed))
    for later in SESSIONS[81:86]:  # five sessions later
        clock.set(execute_at(later))
        for bars in feed.bars_until(clock.now()).values():
            list(bars).clear()
        feed.quote("A")
        clock.set(CAL.close_utc(later))
        feed.mark("A", later)
    assert feed.bars_until(asof) == copy
    assert DS.fingerprint == fingerprint and dict(vars(feed)) == state


def test_trap10_adjusted_bars_see_a_split_only_once_in_effect() -> None:
    """A split announced after session 95's close, ex-date session 100: the bars are
    adjusted from the ex-date's open print on, not from the announcement."""
    assert CAL.close_utc(SESSIONS[95]) < SPLIT_KNOWN < CAL.open_print_utc(SPLIT_EX)
    clock = FixedClock(execute_at(SESSIONS[95]))  # not known yet
    feed = make_feed(clock, window=50)
    for s in (SESSIONS[95], SESSIONS[97], SESSIONS[99]):  # then known, not in effect
        clock.set(execute_at(s))
        bars = feed.bars_until(clock.now())["B"]
        assert bars[-1].close == float(DS.raw_close_eur("B", CAL.previous_session(s))), s
    unadjusted = feed.bars_until(clock.now())["B"]  # at session 99: sessions 49..98
    clock.set(execute_at(SPLIT_EX))  # the ex-date's decision: every earlier bar is adjusted
    adjusted = feed.bars_until(clock.now())["B"]  # sessions 50..99
    assert adjusted[-1].close == pytest.approx(float(DS.raw_close_eur("B", SESSIONS[99])) * 0.5, rel=1e-12)
    assert adjusted[0].close == pytest.approx(unadjusted[1].close * 0.5, rel=1e-12)  # all earlier bars
    clock.set(CAL.close_utc(SESSIONS[97]) + timedelta(days=5))
    assert feed.mark("B", SESSIONS[97]) == DS.raw_close_eur("B", SESSIONS[97])  # marks stay raw
    assert feed.mark("B", SPLIT_EX) == DS.raw_close_eur("B", SPLIT_EX)


def test_trap10_the_bars_are_on_the_basis_of_the_quote_the_decision_trades_at() -> None:
    """At every decision around the split, the last adjusted close is near the raw quote:
    adjusting at the announcement would show the strategy half the price it trades at."""
    for s in SESSIONS[92:106]:
        clock = FixedClock(execute_at(s))
        feed = make_feed(clock)
        quote = feed.quote("B")
        assert quote is not None
        last = feed.bars_until(clock.now())["B"][-1].close
        assert 0.9 < float(quote.price) / last < 1.1, s


def test_the_feed_answers_from_a_dataset_cut_at_the_decision_exactly_as_from_the_full_one() -> None:
    """A feed part of the shadow check (G3): at E every quote and every bar the feed hands
    out is already in ``dataset.truncated(E)``, around the split, the delisting and the late
    listing included. The mark at the close equals the one from ``truncated(close)``."""

    def feed(dataset: PitDataset, at: datetime) -> BacktestFeed:
        return BacktestFeed(dataset, clock=FixedClock(at), universe=UNIVERSE, window=30, exec_delay=DELAY)

    picked = sorted({*SESSIONS[1::23], *SESSIONS[38:42], *SESSIONS[58:72], *SESSIONS[94:102]})
    for session in picked:
        e = execute_at(session)
        full, shadow = feed(DS, e), feed(DS.truncated(e), e)
        assert full.bars_until(e) == shadow.bars_until(e) != {}, session
        assert [full.quote(s) for s in UNIVERSE] == [shadow.quote(s) for s in UNIVERSE], session
        close = CAL.close_utc(session)
        marked = [s for s in UNIVERSE if DS.has_open_print(s, session)]
        assert marked
        assert [feed(DS, close).mark(s, session) for s in marked] == [
            feed(DS.truncated(close), close).mark(s, session) for s in marked
        ]


# ----------------------------------------------------------------- marks (trap 19)
def test_trap19_mark_only_after_the_close_and_raw() -> None:
    session = SESSIONS[33]
    clock = FixedClock(execute_at(session))
    feed = make_feed(clock)
    with pytest.raises(PhaseError):
        feed.mark("A", session)
    clock.set(CAL.close_utc(session) - timedelta(microseconds=1))
    with pytest.raises(PhaseError):
        feed.mark("A", session)
    clock.set(CAL.close_utc(session))
    assert feed.mark("A", session) == DS.raw_close_eur("A", session)
    with pytest.raises(PhaseError):
        feed.quote("A")  # quote() at the mark instant raises
    clock.set(CAL.close_utc(session) + timedelta(days=3))
    assert feed.mark("A", session) == DS.raw_close_eur("A", session)
    with pytest.raises(PhaseError):
        feed.mark("A", SESSIONS[40])  # a later session's close is not known yet


def test_a_missing_mark_raises_a_lookup_error() -> None:
    session = SESSIONS[65]
    clock = FixedClock(CAL.close_utc(session))
    with pytest.raises(LookupError):
        make_feed(clock).mark("C", session)  # C stopped trading at session 60
    with pytest.raises(LookupError):
        make_feed(clock).mark("NOPE", session)


# ---------------------------------------------------------------- construction
def test_the_feed_declares_the_dataset_calendar_and_checks_its_settings() -> None:
    clock = FixedClock(execute_at(SESSIONS[5]))
    feed = make_feed(clock)
    assert feed.calendar is DS.calendar and isinstance(feed.calendar, XetraCalendar)
    for window in (0, 1001, True):
        with pytest.raises(ValueError, match="window"):
            BacktestFeed(DS, clock=clock, universe=UNIVERSE, window=window, exec_delay=DELAY)
    assert make_feed(clock, window=1000).bars_until(clock.now())
    with pytest.raises(ValueError, match="exec_delay"):
        BacktestFeed(DS, clock=clock, universe=UNIVERSE, window=5, exec_delay=timedelta(seconds=-1))
    with pytest.raises(ValueError, match="not in the dataset"):
        BacktestFeed(DS, clock=clock, universe=("A", "ZZZ"), window=5, exec_delay=DELAY)
    with pytest.raises(ValueError, match="repeated"):
        BacktestFeed(DS, clock=clock, universe=("A", "A"), window=5, exec_delay=DELAY)
