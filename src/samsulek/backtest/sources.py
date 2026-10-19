"""Where a backtest's raw data comes from (M3 skeleton; WP3 fills it in).

A ``BarSource`` loads raw daily bars, listings, corporate actions and FX for a symbol
list; ``PitDataset.build`` then cuts and checks them. ``SyntheticBarSource`` generates
Xetra-session bars (synthetic=True, every listing noted "synthetic") with optional planted
splits, spikes and delistings for tests. ``StoreBarSource`` refuses in M3 with
``DataUnavailableError``: there is no verified ETF price source yet (task #15).
``select_known`` is the point-in-time hook for that source: an event-time filter (closed
and available by ``t``) FIRST, then per ``(symbol, session)`` the version known at ``t``.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Final, Protocol

from samsulek.backtest.dataset import CorporateAction, Listing
from samsulek.backtest.fx import FxIndex
from samsulek.backtest.types import BacktestRefused
from samsulek.data.bars import DailyBar
from samsulek.data.calendars import XetraCalendar


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
    def __init__(self, *, seed: int, calendar: XetraCalendar, plants: SyntheticPlants = _NO_PLANTS) -> None:
        raise NotImplementedError("WP3")

    def load(self, symbols: Sequence[str], *, first: date, last: date) -> SourceData:
        raise NotImplementedError("WP3")


class DataUnavailableError(BacktestRefused):
    """The requested data source cannot be used (yet)."""


class StoreBarSource:
    def __init__(self, data_root: Path) -> None:
        raise NotImplementedError("WP3")

    def load(self, symbols: Sequence[str], *, first: date, last: date) -> SourceData:
        raise NotImplementedError("WP3")


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
    raise NotImplementedError("WP3")
