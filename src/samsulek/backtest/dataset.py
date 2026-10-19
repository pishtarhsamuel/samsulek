"""The point-in-time dataset a backtest runs on, physically cut at its cutoff (M3 skeleton; WP3).

``PitDataset.build`` drops (and counts) everything known after the cutoff: open prints
labeled after it, bars closing after it, corporate actions known after it, and delistings
known after it. Then it REFUSES (``DataRefusedError``, listing every problem, never
repairing anything) mislabeled or missing sessions, bad prices, mixed currencies,
listings without a survivorship note, unaccepted quality errors and missing FX rates.
Adjusted bars use only the corporate actions known by the decision time (point-in-time
epochs, built lazily and cached); quotes, marks and sizing use raw prices in EUR.
``listed`` drops a symbol only once its delisting is known. ``truncated`` makes a PHYSICAL
copy, so a later leak cannot hide behind a read-time filter. The dataset must pickle (it
is part of ``EngineContext``).
"""

from __future__ import annotations

from collections.abc import Collection
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Literal

from samsulek.backtest.fx import FxIndex
from samsulek.backtest.types import BacktestRefused
from samsulek.data.calendars import XetraCalendar
from samsulek.types import Bar

if TYPE_CHECKING:
    from samsulek.backtest.sources import SourceData


class DataRefusedError(BacktestRefused):
    """The data cannot be used as it is. Lists EVERY problem found."""


class CutoffError(ValueError):
    """A truncation was asked to see past the dataset's own cutoff."""


@dataclass(frozen=True, slots=True)
class CorporateAction:
    """Bars with ``session < ex_session`` are multiplied by ``price_factor`` once the action is
    known (``known_at``); for splits, volume is divided by it."""

    symbol: str
    ex_session: date
    kind: Literal["split", "distribution"]
    price_factor: float
    known_at: datetime


@dataclass(frozen=True, slots=True)
class Listing:
    symbol: str
    currency: str
    first_session: date
    last_session: date | None
    delisting_known_at: datetime | None
    note: str  # required: where the symbol list comes from (survivorship)


class PitDataset:
    """Immutable apart from a deterministic lazy cache of adjusted bars per epoch."""

    calendar: XetraCalendar
    cutoff: datetime
    source: str
    synthetic: bool
    fx: FxIndex | None
    dropped_after_cutoff: int

    @classmethod
    def build(
        cls,
        data: SourceData,
        *,
        calendar: XetraCalendar,
        cutoff: datetime,
        accepted_issues: Collection[tuple[str, date, str]] = (),
    ) -> PitDataset:
        raise NotImplementedError("WP3")

    @property
    def fingerprint(self) -> str:
        """sha256 over the canonical rows, actions, listings, cutoff and source."""
        raise NotImplementedError("WP3")

    def truncated(self, cutoff: datetime) -> PitDataset:
        raise NotImplementedError("WP3")

    def symbols(self) -> tuple[str, ...]:
        raise NotImplementedError("WP3")

    def sessions(self, first: date, last: date) -> tuple[date, ...]:
        raise NotImplementedError("WP3")

    def listing(self, symbol: str) -> Listing:
        raise NotImplementedError("WP3")

    def listed(
        self, session: date, *, at: datetime, min_bars: int, among: Collection[str]
    ) -> tuple[str, ...]:
        raise NotImplementedError("WP3")

    def has_open_print(self, symbol: str, session: date) -> bool:
        raise NotImplementedError("WP3")

    def raw_open_eur(self, symbol: str, session: date) -> Decimal:
        raise NotImplementedError("WP3")

    def raw_close_eur(self, symbol: str, session: date) -> Decimal:
        raise NotImplementedError("WP3")

    def latest_print(self, symbol: str, at: datetime) -> tuple[datetime, Decimal] | None:
        raise NotImplementedError("WP3")

    def adjusted_window(self, symbol: str, asof: datetime, window: int) -> tuple[Bar, ...]:
        raise NotImplementedError("WP3")

    def adjusted_close(self, symbol: str, session: date, *, as_of: datetime) -> float:
        raise NotImplementedError("WP3")

    def actions_on(self, session: date) -> tuple[CorporateAction, ...]:
        raise NotImplementedError("WP3")

    def min_open_eur(self, symbols: Collection[str], first: date, last: date) -> Decimal:
        raise NotImplementedError("WP3")
