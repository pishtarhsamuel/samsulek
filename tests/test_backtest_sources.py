"""Backtest data sources: the synthetic source, the refused store source, and select_known (trap 7)."""

from __future__ import annotations

import pickle
import tempfile
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from samsulek.backtest.dataset import Listing, PitDataset
from samsulek.backtest.fence import RESEARCH_DATA_CUTOFF
from samsulek.backtest.sources import (
    BarSource,
    DataUnavailableError,
    SourceData,
    StoreBarSource,
    SyntheticBarSource,
    SyntheticPlants,
    VersionedBarRow,
    select_known,
)
from samsulek.backtest.synthetic_data import synthetic_daily_bars
from samsulek.backtest.types import BacktestRefused
from samsulek.data.calendars import XetraCalendar
from samsulek.data.store import Column, VersionedTable, connect, from_us, to_us

CAL = XetraCalendar()
T = datetime(2024, 3, 6, 12, 0, tzinfo=UTC)  # the decision instant


def vrow(
    symbol: str, session: date, *, fetched: datetime, close: float = 10.0, available: datetime | None = None
) -> VersionedBarRow:
    close_ts = CAL.close_utc(session)
    return VersionedBarRow(
        symbol=symbol,
        session=session,
        close_us=to_us(close_ts),
        available_us=to_us(available or close_ts + timedelta(hours=6)),
        fetched_us=to_us(fetched),
        open=close,
        high=close,
        low=close,
        close=close,
        volume=None,
        currency="EUR",
    )


# --------------------------------------------------------------- select_known
def test_trap07_select_known(tmp_path: Path) -> None:
    """Event time first, then the as-known version."""
    rows = [
        # an old session, stored before t and corrected after t: the stored-by-t version
        vrow("A", date(2024, 3, 1), fetched=T - timedelta(days=4), close=10.0),
        vrow("A", date(2024, 3, 1), fetched=T + timedelta(days=1), close=10.5),
        # a backfilled key: closed long before t, every version stored after t -> the OLDEST
        vrow("B", date(2024, 1, 5), fetched=T + timedelta(days=2), close=20.0),
        vrow("B", date(2024, 1, 5), fetched=T + timedelta(days=9), close=21.0),
        # a session first stored after t that also CLOSED after t: never visible at t
        vrow("A", date(2024, 3, 6), fetched=T + timedelta(days=1), close=11.0),
        # closed by t but not yet published by t: not visible either
        vrow("A", date(2024, 3, 5), fetched=T + timedelta(days=1), available=T + timedelta(hours=1)),
    ]
    picked = select_known(reversed(rows), decision_ts=T)
    assert [(r.symbol, r.session, r.close) for r in picked] == [
        ("A", date(2024, 3, 1), 10.0),
        ("B", date(2024, 1, 5), 20.0),
    ]
    # The raw store query (VersionedTable.as_known) WOULD return the later sessions: that
    # is the lookahead select_known exists to remove.
    table = VersionedTable(
        tmp_path,
        "bars",
        [Column("symbol", "VARCHAR"), Column("session", "DATE")],
        [Column("close", "DOUBLE"), Column("close_us", "BIGINT"), Column("available_us", "BIGINT")],
    )
    con = connect(tmp_path)
    try:  # closed before asserting: Windows cannot delete a folder with an open file in it
        for r in sorted(rows, key=lambda r: r.fetched_us):
            values = {"close": r.close, "close_us": r.close_us, "available_us": r.available_us}
            table.write(con, [{"symbol": r.symbol, "session": r.session, **values}], from_us(r.fetched_us))
        raw = {(x["symbol"], x["session"]) for x in table.as_known(con, where={}, known_at=T)}
    finally:
        con.close()
    assert ("A", date(2024, 3, 6)) in raw and ("A", date(2024, 3, 5)) in raw
    assert {(r.symbol, r.session) for r in picked} < raw


SESSIONS_FOR_ORACLE = CAL.sessions(date(2024, 2, 26), date(2024, 3, 8))


@settings(max_examples=25, deadline=None)
@given(
    keys=st.lists(
        st.tuples(
            st.sampled_from(["A", "B"]),
            st.sampled_from(SESSIONS_FOR_ORACLE),
            st.integers(min_value=0, max_value=72),  # publication delay after the close, hours
            st.lists(st.integers(min_value=-200, max_value=200), min_size=1, max_size=4, unique=True),
        ),
        min_size=1,
        max_size=8,
        unique_by=lambda k: (k[0], k[1]),
    )
)
def test_select_known_equals_the_store_as_known_after_the_event_time_filter(
    keys: list[tuple[str, date, int, list[int]]],
) -> None:
    """The oracle is the real store: every version written with VersionedTable at its fetch
    time, then ``as_known(t)`` over the keys that had closed and been published by t."""
    rows = [
        vrow(
            symbol,
            session,
            fetched=T + timedelta(hours=offset),
            close=10.0 + n,  # every version differs, so the store keeps each one
            available=CAL.close_utc(session) + timedelta(hours=delay),
        )
        for symbol, session, delay, offsets in keys
        for n, offset in enumerate(offsets)
    ]
    picked = {(r.symbol, r.session): r.close for r in select_known(rows, decision_ts=T)}
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder)
        table = VersionedTable(
            root,
            "bars",
            [Column("symbol", "VARCHAR"), Column("session", "DATE")],
            [Column("close", "DOUBLE"), Column("close_us", "BIGINT"), Column("available_us", "BIGINT")],
        )
        con = connect(root)
        try:
            for r in sorted(rows, key=lambda r: r.fetched_us):
                values = {"close": r.close, "close_us": r.close_us, "available_us": r.available_us}
                table.write(
                    con,
                    [{"symbol": r.symbol, "session": r.session, **values}],
                    from_us(r.fetched_us),
                    scope={"symbol": r.symbol, "session": r.session},
                )
            t = to_us(T)
            oracle = {
                (x["symbol"], x["session"]): x["close"]
                for x in table.as_known(con, where={}, known_at=T)
                if x["close_us"] <= t and x["available_us"] <= t
            }
        finally:
            con.close()
    assert picked == oracle


def test_select_known_takes_the_newest_version_stored_by_t() -> None:
    session = date(2024, 2, 1)
    rows = [
        vrow("A", session, fetched=T - timedelta(days=3), close=1.0),
        vrow("A", session, fetched=T - timedelta(days=2), close=2.0),
        vrow("A", session, fetched=T, close=3.0),  # stored exactly at t: known
        vrow("A", session, fetched=T + timedelta(microseconds=1), close=4.0),
    ]
    assert [r.close for r in select_known(rows, decision_ts=T)] == [3.0]
    assert [r.close for r in select_known(rows, decision_ts=T - timedelta(days=2))] == [2.0]


def test_select_known_includes_a_row_closed_and_published_exactly_at_t() -> None:
    session = date(2024, 3, 5)
    close_ts = CAL.close_utc(session)
    row = vrow("A", session, fetched=close_ts, available=close_ts)
    assert select_known([row], decision_ts=close_ts) == [row]
    assert select_known([row], decision_ts=close_ts - timedelta(microseconds=1)) == []


def test_select_known_refuses_two_different_versions_stored_at_the_same_instant() -> None:
    a = vrow("A", date(2024, 2, 1), fetched=T - timedelta(days=1), close=1.0)
    b = vrow("A", date(2024, 2, 1), fetched=T - timedelta(days=1), close=2.0)
    with pytest.raises(ValueError, match="same instant disagree"):
        select_known([a, b], decision_ts=T)
    assert select_known([a, a], decision_ts=T) == [a]  # an exact repeat is harmless
    with pytest.raises(ValueError, match="timezone"):
        select_known([a], decision_ts=datetime(2024, 3, 6))  # noqa: DTZ001


# ---------------------------------------------------------- the store source
def test_the_store_source_is_refused_until_a_verified_etf_source_exists(tmp_path: Path) -> None:
    src = StoreBarSource(tmp_path / "data")
    with pytest.raises(DataUnavailableError, match=r"no verified ETF price source yet \(task #15\)") as info:
        src.load(["EUNL"], first=date(2016, 1, 4), last=date(2024, 9, 30))
    assert isinstance(info.value, BacktestRefused)
    assert info.value.problems == ("no verified ETF price source yet (task #15)",)
    assert list(tmp_path.iterdir()) == []  # nothing was created
    back = pickle.loads(pickle.dumps(info.value))  # noqa: S301
    assert type(back) is DataUnavailableError and back.problems == info.value.problems


# ------------------------------------------------------- the synthetic source
def test_the_synthetic_source_is_marked_synthetic_and_deterministic() -> None:
    src: BarSource = SyntheticBarSource(seed=7, calendar=CAL)
    data = src.load(["B", "A"], first=date(2023, 1, 1), last=date(2023, 3, 31))
    again = SyntheticBarSource(seed=7, calendar=CAL).load(
        ["B", "A"], first=date(2023, 1, 1), last=date(2023, 3, 31)
    )
    assert data == again
    assert data.synthetic is True and data.name == "synthetic" and data.fx is None and data.actions == ()
    assert [x.symbol for x in data.listings] == ["B", "A"]
    for x in data.listings:
        assert x == Listing(x.symbol, "EUR", date(2023, 1, 2), None, None, "synthetic")
    expected = synthetic_daily_bars(["B", "A"], CAL, date(2023, 1, 1), date(2023, 3, 31), seed=7)
    assert data.rows == (*expected["B"], *expected["A"])
    other = SyntheticBarSource(seed=8, calendar=CAL).load(
        ["B", "A"], first=date(2023, 1, 1), last=date(2023, 3, 31)
    )
    assert other.rows != data.rows
    assert pickle.loads(pickle.dumps(data)) == data  # noqa: S301


def test_the_synthetic_source_builds_a_research_dataset() -> None:
    data = SyntheticBarSource(seed=7, calendar=CAL).load(
        ["A", "B"], first=date(2016, 1, 4), last=date(2024, 9, 30)
    )
    ds = PitDataset.build(data, calendar=CAL, cutoff=RESEARCH_DATA_CUTOFF)
    assert ds.synthetic and ds.source == "synthetic" and ds.dropped_after_cutoff == 0
    assert ds.symbols() == ("A", "B")
    assert ds.listing("A").note == "synthetic"


def test_planted_split_spike_and_delisting() -> None:
    split_known = datetime(2023, 2, 20, 18, 0, tzinfo=UTC)
    delist_known = datetime(2023, 3, 1, 12, 0, tzinfo=UTC)
    plants = SyntheticPlants(
        splits=(("A", date(2023, 3, 1), 2.0, split_known),),
        spikes=(("B", date(2023, 2, 8), 0.5),),
        delistings=(("C", date(2023, 3, 10), delist_known), ("D", date(2023, 3, 15), None)),
    )
    plain = SyntheticBarSource(seed=1, calendar=CAL).load(
        list("ABCD"), first=date(2023, 1, 2), last=date(2023, 3, 31)
    )
    data = SyntheticBarSource(seed=1, calendar=CAL, plants=plants).load(
        list("ABCD"), first=date(2023, 1, 2), last=date(2023, 3, 31)
    )
    (action,) = data.actions
    assert (action.symbol, action.ex_session, action.price_factor, action.known_at) == (
        "A",
        date(2023, 3, 1),
        0.5,
        split_known,
    )
    rows = {(r.symbol, r.session): r for r in data.rows}
    base = {(r.symbol, r.session): r for r in plain.rows}
    assert rows["A", date(2023, 3, 1)].close == base["A", date(2023, 3, 1)].close / 2
    assert rows["A", date(2023, 2, 28)] == base["A", date(2023, 2, 28)]
    assert rows["B", date(2023, 2, 8)].close == base["B", date(2023, 2, 8)].close * 1.5
    assert max(s for sym, s in rows if sym == "C") == date(2023, 3, 10)
    assert max(s for sym, s in rows if sym == "D") == date(2023, 3, 15)
    listings = {x.symbol: x for x in data.listings}
    assert (listings["C"].last_session, listings["C"].delisting_known_at) == (date(2023, 3, 10), delist_known)
    assert (listings["D"].last_session, listings["D"].delisting_known_at) == (date(2023, 3, 15), None)
    assert listings["A"].last_session is None


def test_plants_for_symbols_that_are_not_loaded_are_refused() -> None:
    plants = SyntheticPlants(spikes=(("Z", date(2023, 2, 8), 0.5),))
    with pytest.raises(ValueError, match="not loaded"):
        SyntheticBarSource(seed=1, calendar=CAL, plants=plants).load(
            ["A"], first=date(2023, 1, 2), last=date(2023, 3, 31)
        )
    twice = SyntheticPlants(delistings=(("A", date(2023, 2, 1), None), ("A", date(2023, 3, 1), None)))
    with pytest.raises(ValueError, match="more than one planted delisting"):
        SyntheticBarSource(seed=1, calendar=CAL, plants=twice).load(
            ["A"], first=date(2023, 1, 2), last=date(2023, 3, 31)
        )
    with pytest.raises(ValueError, match="no XETR session"):
        SyntheticBarSource(seed=1, calendar=CAL).load(
            ["A"], first=date(2023, 12, 24), last=date(2023, 12, 26)
        )


def test_source_data_is_plain_data() -> None:
    data = SourceData(name="x", synthetic=False, rows=(), listings=(), actions=(), fx=None)
    assert pickle.loads(pickle.dumps(data)) == data  # noqa: S301
    with pytest.raises(AttributeError):
        data.name = "y"  # type: ignore[misc]
