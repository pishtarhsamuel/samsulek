"""PitDataset: the physical cut, the refusals (every problem listed), raw versus adjusted
prices, point-in-time listings and corporate actions (traps 3, 9, 10, 11, 15 data parts)."""

from __future__ import annotations

import dataclasses
import math
import pickle
from collections.abc import Iterator
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from itertools import pairwise
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from samsulek.backtest import dataset as dataset_module
from samsulek.backtest.dataset import CorporateAction, CutoffError, DataRefusedError, Listing, PitDataset
from samsulek.backtest.fx import FxIndex
from samsulek.backtest.sources import SourceData
from samsulek.backtest.synthetic_data import plant_spike, plant_split, synthetic_daily_bars
from samsulek.backtest.types import BacktestRefused
from samsulek.data.bars import DailyBar
from samsulek.data.calendars import XetraCalendar
from samsulek.data.sources import ecb
from samsulek.data.store import to_us
from samsulek.strategies.base import LookaheadError
from samsulek.types import Bar

CAL = XetraCalendar()
BERLIN = ZoneInfo("Europe/Berlin")
FIRST, LAST = date(2023, 1, 2), date(2023, 12, 29)
SESSIONS = CAL.sessions(FIRST, LAST)
END = datetime(2024, 1, 1, tzinfo=UTC)  # after every row
FAR = datetime(2030, 1, 1, tzinfo=UTC)


def series(
    symbols: tuple[str, ...] = ("A", "B"), first: date = FIRST, last: date = LAST, seed: int = 7
) -> dict[str, list[DailyBar]]:
    return synthetic_daily_bars(list(symbols), CAL, first, last, seed=seed)


def listing(
    symbol: str,
    *,
    first: date = FIRST,
    last: date | None = None,
    known: datetime | None = None,
    note: str = "test fixture: hand-made symbol list",
    currency: str = "EUR",
) -> Listing:
    return Listing(symbol, currency, first, last, known, note)


def source(
    bars: dict[str, list[DailyBar]],
    *,
    listings: list[Listing] | None = None,
    actions: tuple[CorporateAction, ...] = (),
    fx: FxIndex | None = None,
) -> SourceData:
    if listings is None:
        listings = [
            listing(s, first=b[0].session, currency=b[0].currency) if b else listing(s)
            for s, b in bars.items()
        ]
    rows = tuple(b for s in bars for b in bars[s])
    return SourceData("fixture", False, rows, tuple(listings), actions, fx)


def build(
    data: SourceData, cutoff: datetime = END, accepted: tuple[tuple[str, date, str], ...] = ()
) -> PitDataset:
    return PitDataset.build(data, calendar=CAL, cutoff=cutoff, accepted_issues=accepted)


def refused(
    data: SourceData, cutoff: datetime = END, accepted: tuple[tuple[str, date, str], ...] = ()
) -> tuple[str, ...]:
    with pytest.raises(DataRefusedError) as info:
        build(data, cutoff, accepted)
    assert isinstance(info.value, BacktestRefused)
    return info.value.problems


def has(problems: tuple[str, ...], *needles: str) -> bool:
    return any(all(n in p for n in needles) for p in problems)


# ------------------------------------------------------------------ a clean build
def test_a_clean_dataset_builds_and_keeps_raw_eur_prices() -> None:
    bars = series()
    ds = build(source(bars))
    assert ds.symbols() == ("A", "B")
    assert ds.dropped_after_cutoff == 0 and ds.cutoff == END and ds.source == "fixture" and not ds.synthetic
    assert ds.sessions(date(2000, 1, 1), FAR.date()) == tuple(SESSIONS)
    assert ds.sessions(date(2023, 3, 4), date(2023, 3, 9)) == (
        date(2023, 3, 6),
        date(2023, 3, 7),
        date(2023, 3, 8),
        date(2023, 3, 9),
    )
    assert ds.sessions(date(2024, 1, 2), date(2024, 1, 5)) == ()
    b = bars["A"][100]
    assert ds.has_open_print("A", b.session)
    assert ds.raw_open_eur("A", b.session) == Decimal(repr(b.open))
    assert ds.raw_close_eur("A", b.session) == Decimal(repr(b.close))
    window = ds.adjusted_window("A", b.close_ts, 3)
    assert window[-1] == Bar("A", b.close_ts, b.open, b.high, b.low, b.close, b.volume)  # type: ignore[arg-type]
    assert [x.close_ts for x in window] == [y.close_ts for y in bars["A"][98:101]]
    assert (
        ds.adjusted_window("A", b.close_ts - timedelta(microseconds=1), 1)[-1].close_ts
        == bars["A"][99].close_ts
    )
    assert ds.adjusted_window("A", FAR, 1000) == ds.adjusted_window("A", END, 1000)
    assert len(ds.adjusted_window("A", FAR, 1000)) == len(SESSIONS)
    assert ds.adjusted_window("A", datetime(2022, 1, 1, tzinfo=UTC), 5) == ()
    with pytest.raises(ValueError, match="window"):
        ds.adjusted_window("A", END, 0)


def test_latest_print_is_the_newest_open_or_close_with_its_own_label() -> None:
    bars = series()
    ds = build(source(bars))
    b = bars["A"][50]
    prev = bars["A"][49]
    op = CAL.open_print_utc(b.session)
    assert ds.latest_print("A", op - timedelta(microseconds=1)) == (prev.close_ts, Decimal(repr(prev.close)))
    assert ds.latest_print("A", op) == (op, Decimal(repr(b.open)))
    assert ds.latest_print("A", b.close_ts - timedelta(microseconds=1)) == (op, Decimal(repr(b.open)))
    assert ds.latest_print("A", b.close_ts) == (b.close_ts, Decimal(repr(b.close)))
    assert ds.latest_print("A", datetime(2022, 12, 1, tzinfo=UTC)) is None
    assert ds.latest_print("NOPE", END) is None


def test_unknown_symbols_and_sessions() -> None:
    ds = build(source(series()))
    assert not ds.has_open_print("NOPE", SESSIONS[3])
    assert not ds.has_open_print("A", date(2023, 1, 7))  # a Saturday
    with pytest.raises(KeyError, match="NOPE is not in the dataset"):
        ds.raw_open_eur("NOPE", SESSIONS[3])
    with pytest.raises(KeyError, match="no A open print"):
        ds.raw_open_eur("A", date(2024, 1, 2))
    with pytest.raises(KeyError, match="no A close"):
        ds.raw_close_eur("A", date(2024, 1, 2))
    with pytest.raises(KeyError):
        ds.listing("NOPE")
    with pytest.raises(KeyError):
        ds.adjusted_window("NOPE", END, 5)


# ---------------------------------------------------------------- refusals
def test_trap03_labels() -> None:
    """Mislabeled rows are refused, naming the symbol and the session."""
    bars = series()
    a, b = bars["A"][10], bars["B"][20]
    midnight = datetime.combine(a.session, datetime.min.time(), tzinfo=UTC)
    no_auction = datetime.combine(b.session, datetime.min.time().replace(hour=17, minute=30), tzinfo=BERLIN)
    bars["A"][10] = replace(a, close_ts=midnight)
    bars["B"][20] = replace(b, close_ts=no_auction)
    problems = refused(source(bars))
    assert has(problems, f"A {a.session}", "labeled", "00:00")
    assert has(problems, f"B {b.session}", "labeled")
    # A label one second late is just as wrong.
    late = series()
    late["A"][5] = replace(late["A"][5], close_ts=late["A"][5].close_ts + timedelta(seconds=1))
    assert has(refused(source(late)), f"A {late['A'][5].session}", "labeled")


def test_a_row_whose_day_was_over_by_the_cutoff_but_labeled_after_it_is_refused() -> None:
    """Dropping such a row silently would hide a mislabel (and the last close with it)."""
    bars = series(("A",))
    cutoff = CAL.close_utc(SESSIONS[100]) + timedelta(hours=1)
    due, not_due = bars["A"][100], bars["A"][150]
    bars["A"][100] = replace(due, close_ts=due.close_ts + timedelta(hours=2))  # after the cutoff
    bars["A"][150] = replace(not_due, close_ts=not_due.close_ts + timedelta(hours=2))
    saturday = date(2023, 3, 11)
    bars["A"].insert(49, replace(bars["A"][48], session=saturday, close_ts=FAR))
    bars["A"].sort(key=lambda b: b.session)
    problems = refused(source(bars), cutoff)
    assert has(problems, f"A {due.session}: labeled", "after the cutoff", "was over by")
    assert has(problems, f"A {saturday}: labeled", "after the cutoff")
    assert not has(problems, f"A {not_due.session}")  # not due yet: its label is never read
    assert len(problems) == 2
    # Correct labels build, the same cut.
    assert build(source(series(("A",))), cutoff).raw_close_eur("A", due.session) == Decimal(repr(due.close))


def test_rows_on_closed_days_or_unchecked_years_are_refused() -> None:
    bars = series(("A",))
    saturday = date(2023, 3, 11)
    bars["A"].insert(
        49, replace(bars["A"][48], session=saturday, close_ts=datetime(2023, 3, 11, 16, 40, tzinfo=UTC))
    )
    bars["A"].sort(key=lambda b: b.session)
    problems = refused(source(bars))
    assert has(problems, f"A {saturday}", "not a XETR session")
    old = series(("A",))
    old["A"].insert(
        0,
        replace(old["A"][0], session=date(2003, 12, 30), close_ts=datetime(2003, 12, 30, 16, 40, tzinfo=UTC)),
    )
    assert has(refused(source(old)), "A 2003-12-30", "2003")


def test_duplicate_and_unsorted_sessions_are_refused() -> None:
    bars = series(("A",))
    bars["A"].insert(30, bars["A"][30])
    assert has(refused(source(bars)), f"A {bars['A'][30].session}", "more than one row")
    swapped = series(("A",))
    swapped["A"][40], swapped["A"][41] = swapped["A"][41], swapped["A"][40]
    assert has(refused(source(swapped)), f"A {swapped['A'][41].session}", "out of order")


def test_trap11_missing_or_bad_prices_are_refused_never_repaired() -> None:
    bars = series(("A",))
    cases = {
        5: ("open", None),
        6: ("high", None),
        7: ("low", 0.0),
        8: ("close", math.nan),
        9: ("open", -1.0),
        10: ("close", math.inf),
    }
    for i, (name, value) in cases.items():
        bars["A"][i] = replace(bars["A"][i], **{name: value})
    problems = refused(source(bars))
    for i, (name, _) in cases.items():
        assert has(problems, f"A {bars['A'][i].session}: {name} is"), (i, name)


def test_currency_problems_are_refused() -> None:
    bars = series(("A", "B"))
    bars["A"][3] = replace(bars["A"][3], currency="USD")
    problems = refused(source(bars, listings=[listing("A"), listing("B", currency="GBP")]))
    assert has(problems, "A: more than one currency")
    assert has(problems, "B: rows in ['EUR'], but the listing says GBP")


def test_listing_problems_are_refused() -> None:
    bars = series(("A", "B", "C"))
    listings = [
        listing("A", note="  "),
        listing("A"),
        listing("C", known=datetime(2023, 5, 1, tzinfo=UTC)),  # a delisting time without a last session
    ]
    problems = refused(source(bars, listings=listings))
    assert has(problems, "A: the listing has no survivorship note")
    assert has(problems, "A: more than one listing")
    assert has(problems, "B: rows but no listing")
    assert has(problems, "C: a delisting time without a last session")
    # Malformed metadata is refused even when the delisting is announced after the cutoff.
    late = refused(source(series(("A",)), listings=[listing("A", known=FAR)]))
    assert late == ("A: a delisting time without a last session",)
    # ... and for a symbol without a single row (nothing else would flag it).
    no_rows = [
        listing("A"),
        listing("Y", first=SESSIONS[100], last=SESSIONS[99]),
        listing("Z", first=SESSIONS[100], currency=" "),
    ]
    bare = refused(source(series(("A",)), listings=no_rows), cutoff=CAL.close_utc(SESSIONS[50]))
    assert bare == (
        f"Y: listing ends {SESSIONS[99]}, before it starts {SESSIONS[100]}",
        "Z: the listing has no currency",
    )


def test_rows_outside_the_listing_span_are_refused() -> None:
    bars = series(("A",))
    late_start = listing("A", first=SESSIONS[10], last=SESSIONS[200])
    problems = refused(source(bars, listings=[late_start]))
    assert has(problems, f"A {SESSIONS[0]}", "before the listing starts")
    assert has(problems, f"A {SESSIONS[201]}", "after the listing ends")


def test_trap15_a_coverage_gap_is_refused() -> None:
    bars = series(("A", "B"))
    gone = bars["A"].pop(60)
    problems = refused(source(bars))
    assert has(problems, f"A: no row for 1 session(s) {gone.session} while it was listed")
    three = series(("A", "B"))
    first_gone, last_gone = three["B"][100].session, three["B"][102].session
    del three["B"][100:103]
    assert has(refused(source(three)), f"B: no row for 3 session(s) {first_gone} .. {last_gone}")
    # A symbol whose data stop early, while the dataset goes on, is a gap too.
    short = series(("A", "B"))
    stop = short["B"][-30].session
    short["B"] = short["B"][:-29]
    assert has(refused(source(short)), "B: no row for 29 session(s)")
    assert stop in {b.session for b in short["B"]}
    # A listing that starts before its first row is a gap.
    early = series(("A",), first=SESSIONS[5])
    assert has(refused(source(early, listings=[listing("A")])), f"A: no row for 5 session(s) {SESSIONS[0]}")


def test_a_delisted_symbol_needs_rows_only_until_its_last_session() -> None:
    bars = series(("A", "B"))
    last = SESSIONS[120]
    bars["B"] = [b for b in bars["B"] if b.session <= last]
    ds = build(source(bars, listings=[listing("A"), listing("B", last=last, known=CAL.close_utc(last))]))
    assert ds.listing("B").last_session == last
    with pytest.raises(DataRefusedError):  # the same rows without the delisting are a gap
        build(source(bars))


def test_trap09_a_spike_is_refused_listing_every_issue_and_an_accepted_one_is_kept_as_is() -> None:
    bars = series(("A", "B"))
    sa, sb = SESSIONS[80], SESSIONS[150]
    bars["A"] = plant_spike(bars["A"], sa, 0.4)
    bars["B"] = plant_spike(bars["B"], sb, -0.3)
    problems = refused(source(bars))
    assert has(problems, "ERROR A", str(sa), "[spike_reversal]", "(not accepted)")
    assert has(problems, "ERROR B", str(sb), "[spike_reversal]")
    only_a = refused(source(bars), accepted=(("A", sa, "spike_reversal"),))
    assert not has(only_a, "ERROR A") and has(only_a, "ERROR B")
    wrong_day = refused(
        source(bars), accepted=(("A", SESSIONS[81], "spike_reversal"), ("B", sb, "spike_reversal"))
    )
    assert has(wrong_day, "ERROR A")
    ds = build(source(bars), accepted=(("A", sa, "spike_reversal"), ("B", sb, "spike_reversal")))
    spiked = next(b for b in bars["A"] if b.session == sa)
    assert ds.raw_close_eur("A", sa) == Decimal(repr(spiked.close))
    stored = ds.adjusted_window("A", spiked.close_ts, 1)[0]
    assert (stored.open, stored.high, stored.low, stored.close, stored.volume) == (
        spiked.open,
        spiked.high,
        spiked.low,
        spiked.close,
        spiked.volume,
    )


def test_bad_corporate_actions_are_refused() -> None:
    bars = series(("A",))
    known = datetime(2023, 2, 1, tzinfo=UTC)
    actions = (
        CorporateAction("Z", SESSIONS[20], "split", 0.5, known),
        CorporateAction("A", date(2023, 3, 11), "split", 0.5, known),
        CorporateAction("A", SESSIONS[30], "split", 0.0, known),
        CorporateAction("A", SESSIONS[31], "distribution", math.nan, known),
        CorporateAction("A", SESSIONS[40], "split", 0.5, known),
        CorporateAction("A", SESSIONS[40], "split", 0.5, known),
        CorporateAction("A", SESSIONS[41], "merger", 0.5, known),  # type: ignore[arg-type]
    )
    problems = refused(source(bars, actions=actions))
    assert has(problems, f"Z {SESSIONS[20]}", "without a listing")
    assert has(problems, "A 2023-03-11", "not a XETR session")
    assert has(problems, f"A {SESSIONS[30]}", "price factor")
    assert has(problems, f"A {SESSIONS[31]}", "price factor")
    assert has(problems, f"A {SESSIONS[40]}", "more than one split")
    assert has(problems, f"A {SESSIONS[41]}", "unknown corporate action kind")
    with pytest.raises(ValueError, match="timezone"):
        CorporateAction("A", SESSIONS[20], "split", 0.5, datetime(2023, 2, 1))  # noqa: DTZ001
    with pytest.raises(ValueError, match="timezone"):
        Listing("A", "EUR", FIRST, LAST, datetime(2023, 2, 1), "x")  # noqa: DTZ001


def test_every_problem_is_listed_at_once() -> None:
    bars = series(("A", "B", "C", "D"))
    bars["A"][5] = replace(bars["A"][5], open=None)
    bars["B"][9] = replace(bars["B"][9], close_ts=bars["B"][9].close_ts + timedelta(hours=1))
    del bars["C"][77]
    bars["D"] = plant_spike(bars["D"], SESSIONS[90], 0.5)
    listings = [listing("A"), listing("B"), listing("C"), listing("D"), listing("E", note="")]
    problems = refused(source(bars, listings=listings))
    for needle in (
        f"A {SESSIONS[5]}: open",
        f"B {SESSIONS[9]}: labeled",
        "C: no row",
        "[spike_reversal]",
        "E: the listing has no survivorship note",
    ):
        assert has(problems, needle), needle
    assert len(problems) >= 5


# -------------------------------------------------------------------- FX
def fx_rows(currency: str, first: date, last: date) -> list[dict[str, object]]:
    out: list[dict[str, object]] = []
    d = first
    while d <= last:
        if d.weekday() < 5 and (d.month, d.day) not in {(1, 1), (12, 25), (12, 26)}:
            rate = Decimal("1.05") + Decimal(d.toordinal() % 13) / Decimal(100)
            out.append(
                {
                    "currency": currency,
                    "obs_date": d,
                    "rate": str(rate),
                    "available_us": to_us(ecb.available_at(d)),
                    "fetched_us": to_us(datetime(2026, 10, 1, tzinfo=UTC)),  # history fetched later
                }
            )
        d += timedelta(days=1)
    return out


def usd_series(first: date = date(2024, 12, 2), last: date = date(2025, 1, 31)) -> dict[str, list[DailyBar]]:
    bars = synthetic_daily_bars(["U"], CAL, first, last, seed=2)
    return {"U": [replace(b, currency="USD") for b in bars["U"]]}


def test_non_eur_prints_are_converted_at_their_own_print_time() -> None:
    fx = FxIndex.from_rows(fx_rows("USD", date(2024, 11, 20), date(2025, 2, 10)))
    bars = usd_series()
    ds = build(source(bars, fx=fx), cutoff=datetime(2025, 2, 1, tzinfo=UTC))
    for b in bars["U"]:
        op = CAL.open_print_utc(b.session)
        open_rate = fx.rate("USD", op)
        close_rate = fx.rate("USD", b.close_ts)
        assert open_rate is not None and close_rate is not None
        assert ds.raw_open_eur("U", b.session) == Decimal(repr(b.open)) / open_rate.rate
        assert ds.raw_close_eur("U", b.session) == Decimal(repr(b.close)) / close_rate.rate
        assert open_rate.obs_date < b.session  # 09:05 Berlin: only yesterday's rate is public
    # The early-close day (14:10 Berlin) closes before that day's rate is public.
    early = date(2024, 12, 30)
    rate = fx.rate("USD", CAL.close_utc(early))
    assert rate is not None and rate.obs_date == date(2024, 12, 27)
    normal = fx.rate("USD", CAL.close_utc(date(2025, 1, 6)))
    assert normal is not None and normal.obs_date == date(2025, 1, 6)
    # The dataset's FX is cut at its cutoff too: the 3 February rate is not in it.
    later = datetime(2025, 2, 3, 18, 0, tzinfo=UTC)
    full_rate, cut_rate = fx.rate("USD", later), ds.fx.rate("USD", later) if ds.fx is not None else None
    assert full_rate is not None and full_rate.obs_date == date(2025, 2, 3)
    assert cut_rate is not None and cut_rate.obs_date == date(2025, 1, 31)
    # truncated() cuts the FX as well: no rate published after the new cutoff remains.
    early = CAL.close_utc(date(2024, 12, 30))  # 13:10 UTC, before that day's 16:00 UTC rate
    cut_fx = ds.truncated(early).fx
    assert cut_fx is not None
    assert fx.rate("USD", datetime(2025, 1, 2, 18, 0, tzinfo=UTC)).obs_date == date(2025, 1, 2)  # type: ignore[union-attr]
    for at in (early, datetime(2025, 1, 2, 18, 0, tzinfo=UTC)):
        kept = cut_fx.rate("USD", at)
        assert kept is not None and kept.obs_date == date(2024, 12, 27) and kept.available_at <= early
    assert cut_fx.rate("USD", later) is None  # the later rates are gone; Jan 3 is older than MAX_AGE


def test_a_dataset_with_fx_pickles_and_answers_the_same() -> None:
    fx = FxIndex.from_rows(fx_rows("USD", date(2024, 11, 20), date(2025, 2, 10)))
    ds = build(source(usd_series(), fx=fx), cutoff=datetime(2025, 2, 1, tzinfo=UTC))
    back = pickle.loads(pickle.dumps(ds))  # noqa: S301
    assert back.fingerprint == ds.fingerprint and back.fx is not None
    for b in usd_series()["U"]:
        assert back.raw_open_eur("U", b.session) == ds.raw_open_eur("U", b.session)
        assert back.fx.rate("USD", b.close_ts) == fx.rate("USD", b.close_ts)


def test_a_non_eur_dataset_truncated_is_build_at_the_same_cutoff() -> None:
    """The physical cut with FX: the EUR values a truncated copy keeps are the ones a build
    at that cutoff computes (each print converted at the rate public at its own time)."""
    fx = FxIndex.from_rows(fx_rows("USD", date(2024, 11, 20), date(2025, 2, 10)))
    data = source(usd_series(), fx=fx)
    full = build(data, cutoff=datetime(2025, 2, 1, tzinfo=UTC))
    cuts = [
        CAL.open_print_utc(date(2025, 1, 6)),
        CAL.close_utc(date(2024, 12, 30)),
        ecb.available_at(date(2025, 1, 9)),
    ]
    cuts += [c - timedelta(microseconds=1) for c in cuts]
    for cutoff in cuts:
        cut, direct = full.truncated(cutoff), build(data, cutoff=cutoff)
        assert cut.fingerprint == direct.fingerprint, cutoff
        assert cut.dropped_after_cutoff == direct.dropped_after_cutoff, cutoff
        assert cut.fx is not None and direct.fx is not None
        for at in (cutoff, cutoff - timedelta(days=2)):
            assert cut.fx.rate("USD", at) == direct.fx.rate("USD", at) == fx.rate("USD", at)


def test_the_fingerprint_follows_every_fx_rate_a_print_used() -> None:
    """24 Dec is a TARGET day but no Xetra session: its rate is used only by the 27 Dec open
    print. Changing just that rate changes the stored EUR open, so it must change the
    fingerprint (the same native prices are no longer the same data)."""
    rows = fx_rows("USD", date(2024, 11, 20), date(2025, 2, 10))
    edited = [r | {"rate": "1.2345"} if r["obs_date"] == date(2024, 12, 24) else r for r in rows]
    cutoff = datetime(2025, 2, 1, tzinfo=UTC)
    a = build(source(usd_series(), fx=FxIndex.from_rows(rows)), cutoff=cutoff)
    b = build(source(usd_series(), fx=FxIndex.from_rows(edited)), cutoff=cutoff)
    changed = [s for s in a.sessions(FIRST, FAR.date()) if a.raw_open_eur("U", s) != b.raw_open_eur("U", s)]
    assert changed == [date(2024, 12, 27)]
    assert all(a.raw_close_eur("U", s) == b.raw_close_eur("U", s) for s in a.sessions(FIRST, FAR.date()))
    assert a.fingerprint != b.fingerprint


def test_a_print_is_converted_with_the_fx_version_known_at_its_time() -> None:
    """A correction stored after a print is never used for it (C31, a lookahead otherwise);
    one stored before it is."""

    def rate(d: date, version: int) -> Decimal:
        return Decimal("1.05") + Decimal(d.toordinal() % 11) / Decimal(100) + Decimal(version) / Decimal(1000)

    days = [d for d in (date(2024, 11, 20) + timedelta(days=i) for i in range(83)) if d.weekday() < 5]
    rows = [
        {
            "currency": "USD",
            "obs_date": d,
            "rate": str(rate(d, version)),
            "available_us": to_us(ecb.available_at(d)),
            "fetched_us": to_us(ecb.available_at(d) + delay),
        }
        for d in days
        for version, delay in ((0, timedelta(hours=1)), (1, timedelta(days=2)))  # a correction 2 days later
    ]
    fx = FxIndex.from_rows(rows)
    bars = usd_series()
    ds = build(source(bars, fx=fx), cutoff=datetime(2025, 2, 1, tzinfo=UTC))
    used = set()
    for b in bars["U"]:
        assert b.open is not None
        for at, native, stored in (
            (CAL.open_print_utc(b.session), b.open, ds.raw_open_eur("U", b.session)),
            (b.close_ts, b.close, ds.raw_close_eur("U", b.session)),
        ):
            obs = max(d for d in days if ecb.available_at(d) <= at)
            # The correction counts only once stored (else the first version stands in).
            version = 1 if ecb.available_at(obs) + timedelta(days=2) <= at else 0
            used.add(version)
            assert stored == Decimal(repr(native)) / rate(obs, version), (b.session, at)
    assert used == {0, 1}  # Monday opens use Friday's corrected rate, the other prints the first one


def test_a_non_eur_symbol_without_a_rate_is_refused() -> None:
    bars = usd_series()
    assert has(refused(source(bars), cutoff=datetime(2025, 2, 1, tzinfo=UTC)), "U: no USD rate public at")
    gap = [
        r
        for r in fx_rows("USD", date(2024, 11, 20), date(2025, 2, 10))
        if not date(2024, 12, 9) <= r["obs_date"] <= date(2024, 12, 20)
    ]  # type: ignore[operator]
    problems = refused(source(bars, fx=FxIndex.from_rows(gap)), cutoff=datetime(2025, 2, 1, tzinfo=UTC))
    assert has(problems, "U: no USD rate public at", "print time(s)")  # older than FxIndex.MAX_AGE


def test_a_missing_rate_is_listed_with_every_other_problem_of_the_symbol() -> None:
    bars = usd_series()
    u = bars["U"]
    spike = u[20].session
    bars["U"] = plant_spike(u, spike, 0.5)
    bars["U"][5] = replace(bars["U"][5], open=None)
    bars["U"][6] = replace(bars["U"][6], close=None)  # type: ignore[arg-type]
    bars["U"][7] = replace(bars["U"][7], high=math.nan)
    problems = refused(source(bars), cutoff=datetime(2025, 2, 1, tzinfo=UTC))
    for needle in (
        f"U {u[5].session}: open is None",
        f"U {u[6].session}: close is None",
        f"U {u[7].session}: high is nan",
        "[spike_reversal]",
        "U: no USD rate public at",
    ):
        assert has(problems, needle), needle
    # Only the good prints are counted as needing a rate: the bad ones are not converted.
    n_prints = 2 * len(u) - 3
    assert has(problems, f"U: no USD rate public at {n_prints} print time(s)")


# ----------------------------------------------------------------- the cut
def test_a_cut_inside_a_session_keeps_only_its_open_print() -> None:
    bars = series(("A",))
    s = SESSIONS[100]
    cutoff = CAL.open_print_utc(s) + timedelta(minutes=1)
    ds = build(source(bars), cutoff=cutoff)
    assert ds.has_open_print("A", s)
    assert ds.raw_open_eur("A", s) == Decimal(repr(bars["A"][100].open))
    with pytest.raises(KeyError):
        ds.raw_close_eur("A", s)
    assert ds.latest_print("A", FAR) == (CAL.open_print_utc(s), Decimal(repr(bars["A"][100].open)))
    assert ds.adjusted_window("A", FAR, 1)[0].close_ts == CAL.close_utc(SESSIONS[99])
    assert ds.sessions(FIRST, LAST)[-1] == SESSIONS[99]
    after = len(SESSIONS) - 101
    assert ds.dropped_after_cutoff == 2 * after + 1


def test_the_drop_is_counted_exactly() -> None:
    bars = series(("A", "B"))
    cut_session = SESSIONS[200]
    cutoff = CAL.close_utc(cut_session) + timedelta(hours=1)
    known_late = cutoff + timedelta(days=3)
    actions = (
        CorporateAction("A", SESSIONS[210], "split", 0.5, known_late),
        CorporateAction("A", SESSIONS[100], "distribution", 0.98, CAL.close_utc(SESSIONS[99])),
    )
    bars["A"], _ = plant_split(bars["A"], SESSIONS[210], 2.0, known_late)
    last_b = SESSIONS[220]
    bars["B"] = [b for b in bars["B"] if b.session <= last_b]
    listings = [listing("A"), listing("B", last=last_b, known=known_late)]
    ds = build(source(bars, listings=listings, actions=actions), cutoff=cutoff)
    rows_after = sum(1 for s in bars for b in bars[s] if b.session > cut_session)
    assert ds.dropped_after_cutoff == 2 * rows_after + 1 + 1  # prints, the late split, the late delisting
    assert ds.listing("B") == listing("B")  # the delisting is not known yet
    assert ds.actions_on(SESSIONS[210]) == ()
    assert ds.actions_on(SESSIONS[100]) == (actions[1],)


def walk(obj: Any, seen: set[int] | None = None) -> Iterator[Any]:
    """Every value reachable from ``obj`` (the dataset's own containers, not the calendar)."""
    seen = set() if seen is None else seen
    if id(obj) in seen or isinstance(obj, XetraCalendar | ZoneInfo):
        return
    seen.add(id(obj))
    yield obj
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        for f in dataclasses.fields(obj):
            if isinstance(obj, Listing) and f.name == "first_session":
                continue  # the study's symbol list names it in advance: not a market fact
            if isinstance(obj, Listing) and f.name == "last_session" and obj.delisting_known_at is not None:
                continue  # an announced end (the announcement time itself is checked)
            if isinstance(obj, CorporateAction) and f.name == "ex_session":
                continue  # an announced action (its known_at is checked)
            yield from walk(getattr(obj, f.name), seen)
    elif isinstance(obj, dict):
        for k, v in obj.items():
            yield from walk(k, seen)
            yield from walk(v, seen)
    elif isinstance(obj, list | tuple | set | frozenset):
        for v in obj:
            yield from walk(v, seen)
    elif isinstance(obj, PitDataset):
        yield from walk(vars(obj), seen)


def late_values(ds: PitDataset, cutoff: datetime) -> list[Any]:
    day = cutoff.astimezone(BERLIN).date()
    out = []
    for v in walk(ds):
        late_time = isinstance(v, datetime) and v > cutoff
        late_day = isinstance(v, date) and not isinstance(v, datetime) and v > day
        if late_time or late_day:
            out.append(v)
    return out


def rich_source() -> tuple[SourceData, tuple[tuple[str, date, str], ...]]:
    """A split (known before its ex-date), an accepted spike, a timely and an untimely
    delisting, a never-announced end, and a symbol listed mid-year."""
    bars = series(("A", "B", "C", "D", "F"))
    split_ex, split_known = SESSIONS[120], CAL.close_utc(SESSIONS[115]) + timedelta(hours=2)
    bars["A"], split = plant_split(bars["A"], split_ex, 2.0, split_known)
    spike = SESSIONS[60]
    bars["B"] = plant_spike(bars["B"], spike, 0.5)
    c_last, c_known = SESSIONS[150], CAL.close_utc(SESSIONS[140])  # announced ahead
    d_last, d_known = SESSIONS[170], CAL.close_utc(SESSIONS[180]) + timedelta(hours=3)  # known late
    f_last = SESSIONS[200]  # never announced
    bars["C"] = [b for b in bars["C"] if b.session <= c_last]
    bars["D"] = [b for b in bars["D"] if b.session <= d_last]
    bars["F"] = [b for b in bars["F"] if b.session <= f_last]
    e_first = SESSIONS[90]
    bars["E"] = synthetic_daily_bars(["E"], CAL, e_first, LAST, seed=5)["E"]
    listings = [
        listing("A"),
        listing("B"),
        listing("C", last=c_last, known=c_known),
        listing("D", last=d_last, known=d_known),
        listing("E", first=e_first),
        listing("F", last=f_last),
    ]
    distribution = CorporateAction("E", SESSIONS[130], "distribution", 0.97, CAL.close_utc(SESSIONS[131]))
    return source(bars, listings=listings, actions=(split, distribution)), (("B", spike, "spike_reversal"),)


RICH, RICH_ACCEPTED = rich_source()
RICH_DS = build(RICH, accepted=RICH_ACCEPTED)


def cut_instants() -> list[datetime]:
    out = [datetime(2022, 12, 30, tzinfo=UTC), END]
    for s in SESSIONS:
        op, cl = CAL.open_print_utc(s), CAL.close_utc(s)
        out += [
            op - timedelta(microseconds=1),
            op,
            op + timedelta(minutes=3),
            cl - timedelta(microseconds=1),
            cl,
        ]
    for a in RICH.actions:
        out += [a.known_at - timedelta(microseconds=1), a.known_at]
    for x in RICH.listings:
        if x.delisting_known_at is not None:
            out += [x.delisting_known_at - timedelta(microseconds=1), x.delisting_known_at]
    return sorted(set(out))


CUTS = cut_instants()


@settings(max_examples=40, deadline=None)
@given(cutoff=st.sampled_from(CUTS))
def test_truncated_is_build_at_the_same_cutoff_and_holds_nothing_later(cutoff: datetime) -> None:
    cut = RICH_DS.truncated(cutoff)
    direct = build(RICH, cutoff, RICH_ACCEPTED)
    assert cut.fingerprint == direct.fingerprint
    assert cut.dropped_after_cutoff == direct.dropped_after_cutoff
    assert cut.symbols() == direct.symbols()
    assert [cut.listing(s) for s in cut.symbols()] == [direct.listing(s) for s in direct.symbols()]
    assert late_values(cut, cutoff) == []
    assert late_values(direct, cutoff) == []
    assert cut.truncated(cutoff).fingerprint == cut.fingerprint  # idempotent
    for s in cut.symbols():
        assert cut.adjusted_window(s, cutoff, 1000) == RICH_DS.adjusted_window(s, cutoff, 1000)
        assert cut.latest_print(s, FAR) == RICH_DS.latest_print(s, cutoff)


@settings(max_examples=25, deadline=None)
@given(a=st.sampled_from(CUTS), b=st.sampled_from(CUTS))
def test_truncation_is_monotone(a: datetime, b: datetime) -> None:
    early, late = min(a, b), max(a, b)
    assert RICH_DS.truncated(late).truncated(early).fingerprint == RICH_DS.truncated(early).fingerprint
    with pytest.raises(CutoffError):
        RICH_DS.truncated(early).truncated(early + timedelta(microseconds=1))


def test_truncating_past_the_cutoff_or_with_a_naive_time_is_refused() -> None:
    with pytest.raises(CutoffError, match="ends at its cutoff"):
        RICH_DS.truncated(END + timedelta(microseconds=1))
    with pytest.raises(ValueError, match="timezone"):
        RICH_DS.truncated(datetime(2023, 6, 1))  # noqa: DTZ001
    with pytest.raises(ValueError, match="timezone"):
        build(RICH, datetime(2023, 6, 1))  # noqa: DTZ001
    assert RICH_DS.truncated(END).fingerprint == RICH_DS.fingerprint


def test_the_re_check_after_the_cut_catches_a_broken_cut(monkeypatch: pytest.MonkeyPatch) -> None:
    cutoff = CAL.close_utc(SESSIONS[100]) + timedelta(hours=1)
    monkeypatch.setattr(
        dataset_module, "_open_print", lambda calendar, session: datetime(2000, 1, 1, tzinfo=UTC)
    )
    with pytest.raises(DataRefusedError, match="survived the cut"):
        build(source(series(("A",))), cutoff)
    monkeypatch.undo()
    monkeypatch.setattr(dataset_module, "_redact", lambda listing, cutoff, calendar: listing)
    with pytest.raises(DataRefusedError, match="delisting known after the cutoff survived"):
        build(RICH, CAL.close_utc(SESSIONS[175]), RICH_ACCEPTED)


def test_the_constructor_refuses_stored_values_known_after_the_cutoff(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The last line of defence checks what is actually stored, for ``truncated`` too."""
    monkeypatch.setattr(dataset_module._SymbolData, "cut", lambda self, cutoff, calendar: (self, 0))
    with pytest.raises(DataRefusedError) as info:
        RICH_DS.truncated(CAL.close_utc(SESSIONS[175]))
    problems = info.value.problems
    for symbol in ("A", "B", "E"):  # every symbol with data after the cut
        assert has(problems, f"{symbol}: a print or action known after the cutoff is stored (a bug)")
    assert has(problems, "D: a delisting known after the cutoff is stored (a bug)")
    monkeypatch.undo()
    assert RICH_DS.truncated(CAL.close_utc(SESSIONS[175])).symbols() == RICH_DS.symbols()


def test_a_delisting_is_known_from_its_time_on_exactly() -> None:
    c = RICH.listings[2]
    known = c.delisting_known_at
    assert c.symbol == "C" and known is not None
    tick = timedelta(microseconds=1)
    assert RICH_DS.truncated(known).listing("C") == c
    assert build(RICH, known, RICH_ACCEPTED).listing("C") == c
    hidden = replace(c, last_session=None, delisting_known_at=None)
    assert RICH_DS.truncated(known - tick).listing("C") == hidden
    s = SESSIONS[141]
    assert "C" in RICH_DS.listed(s, at=known - tick, min_bars=0, among=["C"])
    assert "C" not in RICH_DS.listed(s, at=known, min_bars=0, among=["C"])


def test_rows_may_interleave_symbols() -> None:
    grouped = source(series(("A", "B")))
    by_session = replace(grouped, rows=tuple(sorted(grouped.rows, key=lambda b: (b.session, b.symbol))))
    assert by_session.rows != grouped.rows
    assert build(by_session).fingerprint == build(grouped).fingerprint


# ------------------------------------------------------------- fingerprint
def test_the_fingerprint_is_stable_and_ignores_data_after_the_cutoff() -> None:
    cutoff = CAL.close_utc(SESSIONS[150]) + timedelta(hours=1)
    a = build(source(series()), cutoff)
    b = build(source(series()), cutoff)
    assert a.fingerprint == b.fingerprint == pickle.loads(pickle.dumps(a)).fingerprint  # noqa: S301
    assert len(a.fingerprint) == 64
    later = series()
    later["A"] = [replace(x, close=x.close * 1.01) if x.session > SESSIONS[150] else x for x in later["A"]]
    assert build(source(later), cutoff).fingerprint == a.fingerprint  # the future may change freely
    shorter = series(last=SESSIONS[160])
    c = build(source(shorter), cutoff)
    assert c.fingerprint == a.fingerprint and c.dropped_after_cutoff != a.dropped_after_cutoff
    changed = series()
    changed["B"][3] = replace(changed["B"][3], close=changed["B"][3].close + 1e-9)
    assert build(source(changed), cutoff).fingerprint != a.fingerprint
    assert (
        build(source(series()), cutoff + timedelta(microseconds=1)).fingerprint != a.fingerprint
    )  # the cutoff is in it
    renamed = SourceData("other", False, source(series()).rows, source(series()).listings, (), None)
    assert build(renamed, cutoff).fingerprint != a.fingerprint
    # The same instants written in another timezone are the same data.
    berlin = {s: [replace(x, close_ts=x.close_ts.astimezone(BERLIN)) for x in v] for s, v in series().items()}
    assert build(source(berlin), cutoff.astimezone(BERLIN)).fingerprint == a.fingerprint


# ---------------------------------------------------- corporate actions (trap 10)
TICK = timedelta(microseconds=1)


def effective_at(action: CorporateAction) -> datetime:
    """The rule, stated independently of the implementation: an action adjusts earlier bars
    once it is known AND the market trades on the new basis (the ex-date's open print)."""
    return max(action.known_at, CAL.open_print_utc(action.ex_session))


def closes_through(bars: list[DailyBar], asof: datetime) -> list[float]:
    return [b.close for b in bars if b.close_ts <= asof]


def test_trap10_a_split_announced_before_its_ex_date_takes_effect_at_the_ex_dates_open_print() -> None:
    bars = series(("A",))
    raw = {b.session: b for b in bars["A"]}
    ex = SESSIONS[120]
    known = CAL.close_utc(SESSIONS[115]) + timedelta(hours=2)
    split_bars, split = plant_split(bars["A"], ex, 2.0, known)
    ds = build(source({"A": split_bars}, actions=(split,)))
    effective = CAL.open_print_utc(ex)
    assert effective_at(split) == effective > known
    # Announced but not in effect: the market still trades at the old level, so do the bars.
    for asof in (known - TICK, known, CAL.close_utc(SESSIONS[119]), effective - TICK):
        window = ds.adjusted_window("A", asof, 1000)
        assert [b.close for b in window] == closes_through(split_bars, asof), asof
        assert [b.volume for b in window] == [b.volume for b in split_bars if b.close_ts <= asof]
    # From the ex-date's open print on, every earlier bar is adjusted (volume too).
    for asof in (effective, effective + timedelta(minutes=3), CAL.close_utc(ex) - TICK):
        window = ds.adjusted_window("A", asof, 1000)
        assert [b.close for b in window] == [raw[s].close * 0.5 for s in SESSIONS[:120]], asof
        assert [b.volume for b in window] == [raw[s].volume / 0.5 for s in SESSIONS[:120]]  # type: ignore[operator]
    after_ex = ds.adjusted_window("A", CAL.close_utc(ex), 1000)
    assert [b.close for b in after_ex[:120]] == [raw[s].close * 0.5 for s in SESSIONS[:120]]
    assert after_ex[120].close == raw[ex].close / 2  # the raw post-split price, unadjusted
    # Raw prices stay raw whatever is known.
    assert ds.raw_close_eur("A", SESSIONS[100]) == Decimal(repr(raw[SESSIONS[100]].close))
    assert ds.raw_open_eur("A", ex) == Decimal(repr(raw[ex].open / 2))  # type: ignore[operator]
    assert ds.latest_print("A", known)[1] == Decimal(repr(raw[SESSIONS[115]].close))  # type: ignore[index]
    assert ds.latest_print("A", effective) == (effective, ds.raw_open_eur("A", ex))
    # adjusted_close agrees with the window, and refuses the future.
    for as_of in (known - TICK, known, effective - TICK, effective, CAL.close_utc(ex)):
        window = ds.adjusted_window("A", as_of, 1)
        session = next(s for s in reversed(SESSIONS) if CAL.close_utc(s) <= as_of)
        assert ds.adjusted_close("A", session, as_of=as_of) == window[-1].close
    with pytest.raises(LookaheadError):
        ds.adjusted_close("A", SESSIONS[130], as_of=known)
    with pytest.raises(KeyError):
        ds.adjusted_close("A", date(2023, 3, 11), as_of=END)
    assert ds.actions_on(ex) == (split,)
    assert ds.actions_on(SESSIONS[119]) == ()


def test_trap10_the_bars_a_decision_sees_are_on_the_basis_of_the_price_it_trades_at() -> None:
    """At every open print around the split, the last adjusted close is near the raw open of
    that session: adjusting at the announcement would show half the price the market trades at."""
    bars = series(("A",))
    ex = SESSIONS[120]
    split_bars, split = plant_split(bars["A"], ex, 2.0, CAL.close_utc(SESSIONS[112]))
    ds = build(source({"A": split_bars}, actions=(split,)))
    for s in SESSIONS[110:131]:
        at = CAL.open_print_utc(s)
        seen = ds.adjusted_window("A", at, 1)[-1].close
        assert 0.9 < float(ds.raw_open_eur("A", s)) / seen < 1.1, s


@pytest.mark.parametrize(
    "offset",
    [timedelta(days=-5), -TICK, timedelta(0), TICK, timedelta(hours=2), timedelta(days=6)],
    ids=["days-before", "1us-before", "at-open-print", "1us-after", "same-session", "days-after"],
)
def test_trap10_an_action_takes_effect_at_the_later_of_its_announcement_and_the_ex_open(
    offset: timedelta,
) -> None:
    ex = SESSIONS[120]
    op = CAL.open_print_utc(ex)
    known = op + offset
    split_bars, split = plant_split(series(("A",))["A"], ex, 2.0, known)
    ds = build(source({"A": split_bars}, actions=(split,)))
    effective = max(known, op)
    instants = {known - TICK, known, known + TICK, op - TICK, op, op + TICK, CAL.close_utc(ex), FAR}
    instants |= {CAL.close_utc(SESSIONS[119]), CAL.close_utc(SESSIONS[127]), effective - TICK}
    for asof in sorted(instants):
        first = ds.adjusted_window("A", asof, 1000)[0]  # SESSIONS[0], long before the ex-date
        assert first.close == split_bars[0].close * (0.5 if asof >= effective else 1.0), asof


def test_a_split_known_only_after_its_ex_date_leaves_history_unadjusted_until_then() -> None:
    bars = series(("A",))
    raw = {b.session: b for b in bars["A"]}
    ex = SESSIONS[120]
    known = CAL.close_utc(SESSIONS[125]) + timedelta(hours=1)
    split_bars, split = plant_split(bars["A"], ex, 2.0, known)
    ds = build(source({"A": split_bars}, actions=(split,)))
    assert effective_at(split) == known
    between = ds.adjusted_window("A", CAL.close_utc(SESSIONS[122]), 4)
    assert between[1].close / between[0].close < 0.6  # the drop is visible, as it was then
    assert [b.close for b in ds.adjusted_window("A", known - TICK, 1000)] == closes_through(
        split_bars, known
    )  # still raw an instant before the announcement
    at_known = ds.adjusted_window("A", known, 1000)
    assert [b.close for b in at_known] == [raw[s].close * 0.5 for s in SESSIONS[:120]] + [
        b.close for b in split_bars[120:126]
    ]
    later = ds.adjusted_window("A", known, 10)
    assert all(0.8 < b.close / a.close < 1.25 for a, b in pairwise(later))
    # The split happened at its ex-date whenever it was announced: actions_on reports it
    # there, so the runner's abort for a held symbol never misses it (fail closed).
    assert ds.actions_on(ex) == (split,)


def test_actions_take_effect_in_effective_order_not_announcement_order() -> None:
    """X is announced first but takes effect last; Y is announced after its ex-date, so it
    takes effect at once. A prefix by announcement order would apply X at Y's time."""
    bars = series(("A",))
    split_bars, x = plant_split(bars["A"], SESSIONS[150], 2.0, CAL.close_utc(SESSIONS[10]))
    y = CorporateAction(
        "A", SESSIONS[90], "distribution", 0.97, CAL.close_utc(SESSIONS[100]) + timedelta(hours=1)
    )
    data = source({"A": split_bars}, actions=(x, y))
    ds = build(data)
    assert x.known_at < y.known_at and effective_at(y) < effective_at(x)
    plain = split_bars[0].close
    expected = [
        (effective_at(y) - TICK, plain),
        (effective_at(y), plain * 0.97),  # Y only
        (effective_at(x) - TICK, plain * 0.97),
        (effective_at(x), plain * 0.97 * 0.5),  # both
        (FAR, plain * 0.97 * 0.5),
    ]
    for asof, close in expected:
        assert ds.adjusted_window("A", asof, 1000)[0].close == pytest.approx(close, rel=1e-12), asof
        assert ds.adjusted_close("A", SESSIONS[0], as_of=asof) == pytest.approx(close, rel=1e-12)
    # Between the two, a bar after Y's ex-date and before X's is untouched.
    assert ds.adjusted_window("A", effective_at(y), 1000)[95].close == split_bars[95].close
    # The cache answers the same whatever order the instants are asked in.
    backwards = build(data)
    for asof, _ in reversed(expected):
        assert backwards.adjusted_window("A", asof, 1000) == ds.adjusted_window("A", asof, 1000)
    # A dataset cut between the two holds both (X is announced) and answers the same.
    for cut_at in (effective_at(y), effective_at(x) - TICK, effective_at(y) - TICK):
        cut = ds.truncated(cut_at)
        assert cut.fingerprint == build(data, cut_at).fingerprint
        assert cut.adjusted_window("A", cut_at, 1000) == ds.adjusted_window("A", cut_at, 1000)
    assert {a.kind for a in ds.truncated(effective_at(y)).actions_on(SESSIONS[150])} == {"split"}


def test_an_announced_action_not_yet_in_effect_survives_the_cut_and_adjusts_nothing() -> None:
    split = RICH.actions[0]
    assert split.symbol == "A" and split.kind == "split"
    cut_at = split.known_at + timedelta(hours=1)
    assert cut_at < effective_at(split)
    cut = RICH_DS.truncated(cut_at)
    assert cut.actions_on(split.ex_session) == (split,)  # announced: kept, with its ex-date
    assert late_values(cut, cut_at) == []
    a_rows = [b for b in RICH.rows if b.symbol == "A"]
    assert [b.close for b in cut.adjusted_window("A", cut_at, 1000)] == closes_through(a_rows, cut_at)
    assert RICH_DS.truncated(split.known_at - TICK).actions_on(split.ex_session) == ()  # not announced


def test_adjusted_bars_equal_an_oracle_from_the_source_rows() -> None:
    """Every symbol of the rich fixture (a split announced before its ex-date, a distribution
    announced after it), recomputed from the source rows and the stated rule, at every cut
    instant (each open print and close, and each announcement, to the microsecond)."""
    for symbol in RICH_DS.symbols():
        rows = [b for b in RICH.rows if b.symbol == symbol]
        actions = [a for a in RICH.actions if a.symbol == symbol]
        for asof in CUTS:
            in_effect = [a for a in actions if effective_at(a) <= asof]
            expected = []
            for b in rows:
                if b.close_ts > asof:
                    break
                factor = 1.0
                for a in in_effect:
                    if a.ex_session > b.session:
                        factor *= a.price_factor
                expected.append(b.close * factor)
            got = [b.close for b in RICH_DS.adjusted_window(symbol, asof, 1000)]
            assert got == expected, (symbol, asof)


def test_the_fingerprint_does_not_depend_on_the_order_actions_are_given_in() -> None:
    bars = series(("A",))
    split_bars, x = plant_split(bars["A"], SESSIONS[150], 2.0, CAL.close_utc(SESSIONS[10]))
    y = CorporateAction("A", SESSIONS[90], "distribution", 0.97, CAL.close_utc(SESSIONS[100]))
    one = build(source({"A": split_bars}, actions=(x, y)))
    other = build(source({"A": split_bars}, actions=(y, x)))
    assert one.fingerprint == other.fingerprint
    later = replace(y, known_at=y.known_at + TICK)
    assert build(source({"A": split_bars}, actions=(x, later))).fingerprint != one.fingerprint


def test_a_distribution_adjusts_prices_but_not_volume() -> None:
    bars = series(("A",))
    ex, known = SESSIONS[50], CAL.close_utc(SESSIONS[49])
    action = CorporateAction("A", ex, "distribution", 0.97, known)
    ds = build(source(bars, actions=(action,)))
    assert ds.adjusted_window("A", known, 2)[-1].close == bars["A"][49].close  # not yet in effect
    window = ds.adjusted_window("A", CAL.open_print_utc(ex), 2)
    assert window[-1].close == bars["A"][49].close * 0.97
    assert window[-1].volume == bars["A"][49].volume


# -------------------------------------------------- listings (trap 15 data part)
def test_trap15_listed_follows_what_is_known_not_the_last_session() -> None:
    ds = RICH_DS
    s = SESSIONS[145]
    at = CAL.open_print_utc(s)
    everyone = ("A", "B", "C", "D", "E", "F", "NOPE")
    # C's delisting (last session 150) was announced at the close of session 140: gone.
    assert "C" not in ds.listed(s, at=at, min_bars=0, among=everyone)
    assert "C" in ds.listed(SESSIONS[140], at=CAL.open_print_utc(SESSIONS[140]), min_bars=0, among=everyone)
    # D ended at session 170, known only after session 180: still listed in between, without prints.
    s175 = SESSIONS[175]
    listed175 = ds.listed(s175, at=CAL.open_print_utc(s175), min_bars=0, among=everyone)
    assert "D" in listed175 and not ds.has_open_print("D", s175)
    s181 = SESSIONS[181]
    assert "D" not in ds.listed(s181, at=CAL.open_print_utc(s181), min_bars=0, among=everyone)
    # F's end was never announced: listed forever (the runner aborts on its missing print).
    assert "F" in ds.listed(SESSIONS[240], at=CAL.open_print_utc(SESSIONS[240]), min_bars=0, among=everyone)
    # E joins at its first session, and only with enough history.
    assert "E" not in ds.listed(SESSIONS[89], at=CAL.open_print_utc(SESSIONS[89]), min_bars=0, among=everyone)
    assert "E" in ds.listed(SESSIONS[90], at=CAL.open_print_utc(SESSIONS[90]), min_bars=0, among=everyone)
    assert "E" not in ds.listed(
        SESSIONS[109], at=CAL.open_print_utc(SESSIONS[109]), min_bars=20, among=everyone
    )
    assert "E" in ds.listed(SESSIONS[110], at=CAL.open_print_utc(SESSIONS[110]), min_bars=20, among=everyone)
    # Sorted, filtered to ``among``, unknown names never listed.
    result = ds.listed(
        SESSIONS[100], at=CAL.open_print_utc(SESSIONS[100]), min_bars=5, among=["B", "A", "NOPE"]
    )
    assert result == ("A", "B")
    with pytest.raises(ValueError, match="timezone"):
        ds.listed(SESSIONS[100], at=datetime(2023, 6, 1), min_bars=0, among=["A"])  # noqa: DTZ001


def test_listed_refuses_a_negative_or_non_integer_history_requirement() -> None:
    at = CAL.open_print_utc(SESSIONS[100])
    assert RICH_DS.listed(SESSIONS[100], at=at, min_bars=0, among=["A"]) == ("A",)
    for bad in (-1, 1.5, True):
        with pytest.raises(ValueError, match="min_bars"):
            RICH_DS.listed(SESSIONS[100], at=at, min_bars=bad, among=["A"])  # type: ignore[arg-type]


def test_a_delisting_known_after_the_cutoff_is_not_in_the_dataset() -> None:
    d_last = RICH.listings[3].last_session
    assert d_last is not None
    cutoff = CAL.close_utc(SESSIONS[178])
    cut = RICH_DS.truncated(cutoff)
    assert cut.listing("D") == replace(RICH.listings[3], last_session=None, delisting_known_at=None)
    assert "D" in cut.listed(SESSIONS[178], at=cutoff, min_bars=0, among=["D"])
    # A never-announced end is unknown until that day's trading is over.
    f_last = SESSIONS[200]
    assert RICH_DS.truncated(CAL.open_print_utc(f_last)).listing("F").last_session is None
    assert RICH_DS.truncated(CAL.close_utc(f_last)).listing("F").last_session == f_last


def test_min_open_eur_is_the_lowest_raw_open_in_the_range() -> None:
    bars = series(("A", "B"))
    ds = build(source(bars))
    lo, hi = SESSIONS[10], SESSIONS[60]
    expected = min(Decimal(repr(b.open)) for s in "AB" for b in bars[s] if lo <= b.session <= hi)
    assert ds.min_open_eur(["A", "B", "NOPE"], lo, hi) == expected
    with pytest.raises(LookupError, match="no open print"):
        ds.min_open_eur(["A"], date(2024, 2, 1), date(2024, 3, 1))


# ------------------------------------------------------------------ pickling
def test_the_dataset_pickles_without_its_cache_and_answers_the_same() -> None:
    ds = build(RICH, accepted=RICH_ACCEPTED)
    cold = pickle.dumps(ds)
    for s in ds.symbols():
        ds.adjusted_window(s, END, 50)
        ds.adjusted_window(s, CAL.close_utc(SESSIONS[100]), 50)
    assert len(pickle.dumps(ds)) == len(cold)  # the cache is rebuilt, never shipped
    back = pickle.loads(cold)  # noqa: S301
    assert back.fingerprint == ds.fingerprint
    for s in ds.symbols():
        for asof in (CAL.close_utc(SESSIONS[100]), CAL.close_utc(SESSIONS[117]), END):
            assert back.adjusted_window(s, asof, 30) == ds.adjusted_window(s, asof, 30)
            assert back.latest_print(s, asof) == ds.latest_print(s, asof)
    assert back.listed(SESSIONS[100], at=END, min_bars=1, among=ds.symbols()) == ds.listed(
        SESSIONS[100], at=END, min_bars=1, among=ds.symbols()
    )
