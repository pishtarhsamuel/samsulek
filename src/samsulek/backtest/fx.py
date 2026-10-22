"""Point-in-time ECB FX rates for the backtester, held in memory.

Exactly the ``MarketData.latest_fx`` semantics (tests compare the two on a store with
corrections), without a DuckDB query per lookup:
- Per ``(currency, obs_date)`` key, the version is chosen as ``VersionedTable.as_known
  (known_at or at)`` chooses it: the newest version fetched by then, otherwise the OLDEST
  (history downloaded after the fact stands in for what was public). A correction stored
  later is never used early.
- The rate must be public by ``at`` (``available_at <= at``); the newest observation wins.
- A rate published more than ``MAX_AGE`` before ``at`` is no rate: ``None``, so callers
  fail closed. EUR is 1.
- Every version of one key must agree on ``available_at`` (true for the ECB adapter, where
  it is 17:00 Frankfurt of the observation day); ``from_rows`` refuses rows that do not.
  So whether a key is usable never depends on ``known_at``, a lookup is one bisect, and
  ``truncated`` (keep only rates public by the cutoff) answers every question at or before
  the cutoff exactly as the full index does.
- Rows that repeat a key's fetch time with a different rate are ambiguous (DuckDB would
  pick one at random): refused.
- Values are kept in plain tuples and dicts, so the index pickles (it travels inside
  ``EngineContext``). It is immutable by convention: nothing hands out its containers.
"""

from __future__ import annotations

from bisect import bisect_right
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any, ClassVar, Final
from zoneinfo import ZoneInfo

from samsulek.backtest.types import BacktestRefused
from samsulek.data.market import FxRate, MarketData
from samsulek.data.store import from_us, to_us
from samsulek.types import require_aware

# The value of samsulek.data.sources.ecb.SOURCE: the backtester may not import the network
# adapters (architecture rule A2), so a test pins that the two agree.
ECB_SOURCE: Final = "ecb"
_FRANKFURT: Final = ZoneInfo("Europe/Berlin")
_ONE: Final = Decimal(1)


@dataclass(frozen=True, slots=True)
class _Series:
    """One currency: keys sorted by observation date, each with its versions sorted by fetch time."""

    obs: tuple[date, ...]
    available_us: tuple[int, ...]
    suffix_min_us: tuple[int, ...]  # min(available_us[i:]): non-decreasing, so bisectable
    fetched_us: tuple[tuple[int, ...], ...]
    rates: tuple[tuple[Decimal, ...], ...]


def _series(keys: Mapping[date, tuple[int, list[tuple[int, Decimal]]]]) -> _Series:
    obs = tuple(sorted(keys))
    available = tuple(keys[d][0] for d in obs)
    suffix: list[int] = []
    low: int | None = None
    for us in reversed(available):
        low = us if low is None else min(low, us)
        suffix.append(low)
    versions = [sorted(keys[d][1]) for d in obs]
    return _Series(
        obs=obs,
        available_us=available,
        suffix_min_us=tuple(reversed(suffix)),
        fetched_us=tuple(tuple(f for f, _ in v) for v in versions),
        rates=tuple(tuple(r for _, r in v) for v in versions),
    )


class FxIndex:
    MAX_AGE: ClassVar[timedelta] = timedelta(days=7)

    def __init__(self, series: Mapping[str, _Series]) -> None:
        """Use ``from_rows``, ``load`` or ``truncated``."""
        self._series: dict[str, _Series] = dict(series)

    @classmethod
    def from_rows(cls, rows: Iterable[Mapping[str, Any]]) -> FxIndex:
        """From ``VersionedTable.history`` rows of the fx table, all versions (one source).

        ``BacktestRefused`` (a ``ValueError`` listing every problem, so a study stops before
        its first cycle) for a malformed row, mixed sources within a currency, versions of
        one key that disagree on ``available_us``, or two versions of one key fetched at the
        same instant with different rates.
        """
        problems: list[str] = []
        keys: dict[str, dict[date, tuple[int, list[tuple[int, Decimal]]]]] = {}
        sources: dict[str, set[str]] = {}
        for n, row in enumerate(rows):
            try:
                currency = row["currency"]
                obs = row["obs_date"]
                rate = Decimal(str(row["rate"]))
                available = row["available_us"]
                fetched = row["fetched_us"]
            except (KeyError, TypeError, InvalidOperation) as exc:
                problems.append(f"fx row {n}: unreadable ({type(exc).__name__}: {exc})")
                continue
            if not isinstance(currency, str) or len(currency) != 3 or not currency.isupper():
                problems.append(f"fx row {n}: bad currency {currency!r}")
                continue
            if not isinstance(obs, date) or isinstance(obs, datetime):
                problems.append(f"fx row {n}: obs_date {obs!r} is not a date")
                continue
            if not all(isinstance(x, int) and not isinstance(x, bool) for x in (available, fetched)):
                problems.append(f"fx row {n} ({currency} {obs}): times must be integer microseconds")
                continue
            if not rate.is_finite() or rate <= 0:
                problems.append(f"fx row {n} ({currency} {obs}): rate {rate} is not a positive number")
                continue
            if "source" in row:
                sources.setdefault(currency, set()).add(str(row["source"]))
            known = keys.setdefault(currency, {}).get(obs)
            if known is None:
                keys[currency][obs] = (available, [(fetched, rate)])
                continue
            if known[0] != available:
                problems.append(
                    f"{currency} {obs}: versions disagree on when the rate was published "
                    f"({from_us(known[0]).isoformat()} vs {from_us(available).isoformat()})"
                )
                continue
            same_time = [r for f, r in known[1] if f == fetched]
            if not same_time:
                known[1].append((fetched, rate))
            elif same_time[0] != rate:
                problems.append(
                    f"{currency} {obs}: two versions fetched at {from_us(fetched).isoformat()} "
                    f"disagree ({same_time[0]} vs {rate})"
                )
        problems.extend(
            f"{currency}: rows from more than one source {sorted(names)}"
            for currency, names in sorted(sources.items())
            if len(names) > 1
        )
        if problems:
            raise BacktestRefused([f"FX rows refused: {p}" for p in problems])
        return cls({currency: _series(by_obs) for currency, by_obs in sorted(keys.items())})

    @classmethod
    def load(cls, market: MarketData, currencies: Sequence[str]) -> FxIndex:
        """Every stored ECB version of ``currencies`` (EUR needs none) from the point-in-time store."""
        rows: list[dict[str, Any]] = []
        for currency in sorted(set(currencies) - {"EUR"}):
            rows.extend(market.fx.history(market.con, where={"source": ECB_SOURCE, "currency": currency}))
        return cls.from_rows(rows)

    def truncated(self, cutoff: datetime) -> FxIndex:
        """A PHYSICAL copy holding only the rates public by ``cutoff`` (all their versions)."""
        require_aware(cutoff, "FX cutoff")
        limit = to_us(cutoff)
        kept: dict[str, _Series] = {}
        for currency, s in self._series.items():
            keys = {
                d: (s.available_us[i], list(zip(s.fetched_us[i], s.rates[i], strict=True)))
                for i, d in enumerate(s.obs)
                if s.available_us[i] <= limit
            }
            if keys:
                kept[currency] = _series(keys)
        return FxIndex(kept)

    def rate(self, currency: str, at: datetime, *, known_at: datetime | None = None) -> FxRate | None:
        """The newest rate public at ``at``, as known at ``known_at`` (default ``at``); None if
        there is none or it was published more than ``MAX_AGE`` before ``at``."""
        require_aware(at, "FX time")
        if known_at is not None:
            require_aware(known_at, "FX knowledge time")
        if currency == "EUR":
            return FxRate(
                "EUR", at.astimezone(_FRANKFURT).date(), _ONE, at.astimezone(UTC), at.astimezone(UTC)
            )
        s = self._series.get(currency)
        if s is None:
            return None
        at_us = to_us(at)
        i = bisect_right(s.suffix_min_us, at_us) - 1
        if i < 0:
            return None
        # Every key after i was published after ``at`` (suffix minimum), and key i itself by
        # then: it is the newest observation public at ``at``.
        available = from_us(s.available_us[i])
        if available < at - self.MAX_AGE:
            return None
        fetched = s.fetched_us[i]
        v = max(bisect_right(fetched, to_us(known_at or at)) - 1, 0)  # else the oldest version
        return FxRate(currency, s.obs[i], s.rates[i][v], available, from_us(fetched[v]))

    def to_eur(self, amount: Decimal, currency: str, at: datetime) -> Decimal | None:
        """``amount`` (in ``currency``) in EUR at the rate known at ``at``; None without one."""
        if currency == "EUR":
            return amount
        rate = self.rate(currency, at)
        return None if rate is None else amount / rate.rate
