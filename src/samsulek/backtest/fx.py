"""Point-in-time ECB FX rates for the backtester (M3 skeleton; WP3 fills it in).

Exactly the ``MarketData.latest_fx`` semantics, from memory: per ``(currency, obs_date)``
the version is chosen as ``VersionedTable.as_known(known_at or at)`` chooses it (the newest
version fetched by then, else the oldest); the rate must then be available by ``at``
(``available_at <= at``) and the newest observation wins; a rate older than ``MAX_AGE`` is
no rate (None, so callers fail closed). EUR is 1. ``truncated`` keeps only versions
available by the cutoff (a physical cut, like the dataset's).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any, ClassVar

from samsulek.data.market import FxRate, MarketData


class FxIndex:
    MAX_AGE: ClassVar[timedelta] = timedelta(days=7)

    @classmethod
    def from_rows(cls, rows: Iterable[Mapping[str, Any]]) -> FxIndex:
        """From ``VersionedTable.history`` rows, all versions."""
        raise NotImplementedError("WP3")

    @classmethod
    def load(cls, market: MarketData, currencies: Sequence[str]) -> FxIndex:
        raise NotImplementedError("WP3")

    def truncated(self, cutoff: datetime) -> FxIndex:
        raise NotImplementedError("WP3")

    def rate(self, currency: str, at: datetime, *, known_at: datetime | None = None) -> FxRate | None:
        raise NotImplementedError("WP3")

    def to_eur(self, amount: Decimal, currency: str, at: datetime) -> Decimal | None:
        raise NotImplementedError("WP3")
