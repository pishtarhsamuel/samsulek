"""Where a backtest's raw data comes from.

A ``BarSource`` loads raw daily bars, listings, corporate actions and FX for a symbol
list; ``PitDataset.build`` then cuts and checks them (a source never filters by the
cutoff itself, and never repairs anything).
- ``SyntheticBarSource`` generates Xetra-session bars (``synthetic=True``, every listing
  noted "synthetic", EUR, no FX) with optional planted splits, spikes and delistings for
  tests. A planted delisting removes the rows after its last session; its ``known_at``
  (None: never announced) is when ``listed`` stops offering the symbol.
- ``StoreBarSource`` refuses in M3 with ``DataUnavailableError``: there is no verified ETF
  price source yet (task #15).
- ``select_known`` is the point-in-time hook for that source. Event time FIRST: only
  versions whose close was set and published by ``t`` (``close_us <= t`` and
  ``available_us <= t``); THEN per ``(symbol, session)`` the version known at ``t`` (the
  newest fetched by ``t``, else the oldest, like ``VersionedTable.as_known``). The plain
  ``as_known`` would also return sessions that closed after ``t`` (stored later, by a
  backfill), which is lookahead.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from itertools import pairwise
from pathlib import Path
from typing import Final, Protocol

from samsulek.backtest.dataset import CorporateAction, Listing
from samsulek.backtest.fx import FxIndex
from samsulek.backtest.synthetic_data import SOURCE, plant_spike, plant_split, synthetic_daily_bars
from samsulek.backtest.types import BacktestRefused
from samsulek.data.bars import DailyBar
from samsulek.data.calendars import XetraCalendar
from samsulek.data.store import to_us

SYNTHETIC_NOTE: Final = "synthetic"


@dataclass(frozen=True, slots=True)
class SourceData:
    name: str
    synthetic: bool
    rows: tuple[DailyBar, ...]
    listings: tuple[Listing, ...]
    actions: tuple[CorporateAction, ...]
    fx: FxIndex | None


class BarSource(Protocol):
    def load(self, symbols: Sequence[str], *, first: date, last: date) -> SourceData: ...


@dataclass(frozen=True, slots=True)
class SyntheticPlants:
    splits: tuple[tuple[str, date, float, datetime], ...] = ()  # (symbol, session, ratio, known_at)
    spikes: tuple[tuple[str, date, float], ...] = ()  # (symbol, session, jump)
    delistings: tuple[tuple[str, date, datetime | None], ...] = ()  # (symbol, last session, known_at)


_NO_PLANTS: Final = SyntheticPlants()


class SyntheticBarSource:
    """SYNTHETIC bars (``synthetic_daily_bars``), never evidence. Deterministic per seed."""

    def __init__(self, *, seed: int, calendar: XetraCalendar, plants: SyntheticPlants = _NO_PLANTS) -> None:
        self._seed = seed
        self._calendar = calendar
        self._plants = plants

    def load(self, symbols: Sequence[str], *, first: date, last: date) -> SourceData:
        names = list(symbols)
        plants = self._plants
        planted = (
            {s[0] for s in plants.splits} | {s[0] for s in plants.spikes} | {d[0] for d in plants.delistings}
        )
        unknown = sorted(planted - set(names))
        if unknown:
            raise ValueError(f"plants name symbols that are not loaded: {unknown}")
        bars = synthetic_daily_bars(names, self._calendar, first, last, seed=self._seed)
        actions: list[CorporateAction] = []
        for symbol, session, ratio, split_known_at in plants.splits:
            bars[symbol], action = plant_split(bars[symbol], session, ratio, split_known_at)
            actions.append(action)
        for symbol, session, jump in plants.spikes:
            bars[symbol] = plant_spike(bars[symbol], session, jump)
        ends: dict[str, tuple[date, datetime | None]] = {}
        for symbol, last_session, delisting_known_at in plants.delistings:
            if symbol in ends:
                raise ValueError(f"{symbol}: more than one planted delisting")
            ends[symbol] = (last_session, delisting_known_at)
            bars[symbol] = [b for b in bars[symbol] if b.session <= last_session]
        sessions = self._calendar.sessions(first, last)
        if not sessions:
            raise ValueError(f"no {self._calendar.name} session between {first} and {last}")
        listings = []
        for symbol in names:
            end, known = ends.get(symbol, (None, None))
            listings.append(
                Listing(
                    symbol=symbol,
                    currency="EUR",
                    first_session=sessions[0],
                    last_session=end,
                    delisting_known_at=known,
                    note=SYNTHETIC_NOTE,
                )
            )
        return SourceData(
            name=SOURCE,
            synthetic=True,
            rows=tuple(b for symbol in names for b in bars[symbol]),
            listings=tuple(listings),
            actions=tuple(actions),
            fx=None,
        )


class DataUnavailableError(BacktestRefused):
    """The requested data source cannot be used (yet)."""


class StoreBarSource:
    """Real ETF bars from the point-in-time store: not available in M3 (task #15)."""

    def __init__(self, data_root: Path) -> None:
        self._data_root = data_root

    def load(self, symbols: Sequence[str], *, first: date, last: date) -> SourceData:
        raise DataUnavailableError(["no verified ETF price source yet (task #15)"])


@dataclass(frozen=True, slots=True)
class VersionedBarRow:
    symbol: str
    session: date
    close_us: int  # when the close was set (microseconds since the epoch, UTC)
    available_us: int  # when the source published it
    fetched_us: int  # when we stored this version
    open: float
    high: float
    low: float
    close: float
    volume: float | None
    currency: str


def select_known(rows: Iterable[VersionedBarRow], *, decision_ts: datetime) -> list[VersionedBarRow]:
    """The rows research may use at ``decision_ts``, sorted by (symbol, session).

    ``ValueError`` if two versions of one key were fetched at the same instant with
    different values (which one was "known" would be a coin toss).
    """
    t = to_us(decision_ts)
    versions: dict[tuple[str, date], list[VersionedBarRow]] = {}
    for row in rows:
        if row.close_us <= t and row.available_us <= t:  # event time first
            versions.setdefault((row.symbol, row.session), []).append(row)
    out: list[VersionedBarRow] = []
    for key in sorted(versions):
        found = sorted(versions[key], key=lambda r: r.fetched_us)
        for a, b in pairwise(found):
            if a.fetched_us == b.fetched_us and a != b:
                raise ValueError(f"{key[0]} {key[1]}: two versions fetched at the same instant disagree")
        stored_by_then = [r for r in found if r.fetched_us <= t]
        out.append(stored_by_then[-1] if stored_by_then else found[0])
    return out
