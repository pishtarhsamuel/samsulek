"""The point-in-time dataset a backtest runs on, physically cut at its cutoff.

Facts the backtester relies on:
- PHYSICAL cut. ``build`` drops (and counts in ``dropped_after_cutoff``) everything not
  known by the cutoff: an open print labeled ``open_print_utc(session) > cutoff``, a bar
  (high, low, close, volume) with ``close_ts > cutoff``, a corporate action with
  ``known_at > cutoff``, and a delisting known after the cutoff (that listing is stored
  with ``last_session=None, delisting_known_at=None``). A session cut between its open and
  its close keeps only its open print. Then it re-checks that nothing later survived, and
  the constructor checks the stored values once more (for ``truncated`` too).
  ``truncated`` makes the same cut on a copy, so the dropped values are gone from the
  object, not hidden behind a read-time filter (a filter can be bypassed by a later bug).
  ``build(cutoff=c)`` and ``build(cutoff=later).truncated(c)`` hold the same data.
- REFUSE, never repair. ``build`` raises ``DataRefusedError`` listing EVERY problem:
  labels that are not ``calendar.close_utc(session)`` (a row whose day was over by the
  cutoff but is labeled after it included: only its label is read) or sessions the
  calendar does not have; duplicate or unsorted sessions; missing, non-finite or non-positive prices;
  mixed currencies; a symbol without a ``Listing`` or with an empty survivorship note; a
  calendar session without a row while the symbol is listed (from ``first_session`` to the
  earliest of its last session and the last session in the dataset); quality errors
  (``check_bars``/``check_calendar``) not accepted as ``(symbol, session, code)``; a
  non-EUR print without an FX rate public at its print time; bad corporate actions.
- Prices are converted to EUR once: an open print at ``open_print_utc(session)``, a close
  (and its high and low) at ``close_ts``, with the rate known at that instant.
- Raw (unadjusted) EUR prices are for quotes, marks and sizing: ``raw_open_eur``,
  ``raw_close_eur``, ``latest_print``. Adjusted bars are for signals: ``adjusted_window``
  multiplies a bar by the ``price_factor`` of every action KNOWN by the decision time
  (``known_at <= asof``) whose ``ex_session`` is after the bar's session (volume divided
  by it for splits). A future split never reaches an earlier decision. The adjusted series
  are built lazily once per (symbol, epoch), where the epoch is the number of that symbol's
  actions known by ``asof``; the cache is deterministic and is not pickled.
- ``listed`` drops a symbol only once its delisting is KNOWN (``delisting_known_at <=
  at``); ``last_session`` alone is never used to hide a symbol early.
- The dataset pickles (it travels inside ``EngineContext``): plain dicts, tuples and frozen
  dataclasses. It is immutable by convention: every accessor returns tuples or values.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import math
from bisect import bisect_left, bisect_right
from collections.abc import Collection, Iterable, Mapping
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any, Final, Literal, TypeGuard
from zoneinfo import ZoneInfo

from samsulek.backtest.fx import FxIndex
from samsulek.backtest.types import BacktestRefused
from samsulek.data.bars import DailyBar
from samsulek.data.calendars import CalendarRangeError, XetraCalendar
from samsulek.data.quality import check_bars, check_calendar, errors
from samsulek.strategies.base import LookaheadError
from samsulek.types import Bar, require_aware

if TYPE_CHECKING:
    from samsulek.backtest.sources import SourceData

_ACTION_KINDS: Final = ("split", "distribution")
_EUR: Final = "EUR"


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

    def __post_init__(self) -> None:
        require_aware(self.known_at, f"corporate action time for {self.symbol}")


@dataclass(frozen=True, slots=True)
class Listing:
    symbol: str
    currency: str
    first_session: date
    last_session: date | None
    delisting_known_at: datetime | None
    note: str  # required: where the symbol list comes from (survivorship)

    def __post_init__(self) -> None:
        if self.delisting_known_at is not None:
            require_aware(self.delisting_known_at, f"delisting time for {self.symbol}")


@dataclass(frozen=True, slots=True)
class _SymbolData:
    """One symbol, every sequence sorted by time. A bar's open print is always present too."""

    listing: Listing
    open_sessions: tuple[date, ...]
    open_ts: tuple[datetime, ...]  # open_print_utc(session)
    open_native: tuple[float, ...]
    open_eur: tuple[Decimal, ...]
    rows: tuple[DailyBar, ...]  # the source rows whose close is known (native currency)
    bar_sessions: tuple[date, ...]
    bar_ts: tuple[datetime, ...]  # close_ts
    close_eur: tuple[Decimal, ...]
    bars_eur: tuple[Bar, ...]  # unadjusted, in EUR (epoch 0)
    actions: tuple[CorporateAction, ...]  # sorted by known_at
    action_known: tuple[datetime, ...]
    print_ts: tuple[datetime, ...]  # every open and close print, in time order
    print_eur: tuple[Decimal, ...]

    def cut(self, cutoff: datetime, calendar: XetraCalendar) -> tuple[_SymbolData, int]:
        """A physical copy without anything known after ``cutoff``, and how many items went."""
        n_open = bisect_right(self.open_ts, cutoff)
        n_bar = bisect_right(self.bar_ts, cutoff)
        n_act = bisect_right(self.action_known, cutoff)
        n_print = bisect_right(self.print_ts, cutoff)
        listing = _redact(self.listing, cutoff, calendar)
        dropped = (
            len(self.open_ts)
            - n_open
            + len(self.bar_ts)
            - n_bar
            + len(self.actions)
            - n_act
            + (listing != self.listing)
        )
        kept = _SymbolData(
            listing=listing,
            open_sessions=self.open_sessions[:n_open],
            open_ts=self.open_ts[:n_open],
            open_native=self.open_native[:n_open],
            open_eur=self.open_eur[:n_open],
            rows=self.rows[:n_bar],
            bar_sessions=self.bar_sessions[:n_bar],
            bar_ts=self.bar_ts[:n_bar],
            close_eur=self.close_eur[:n_bar],
            bars_eur=self.bars_eur[:n_bar],
            actions=self.actions[:n_act],
            action_known=self.action_known[:n_act],
            print_ts=self.print_ts[:n_print],
            print_eur=self.print_eur[:n_print],
        )
        return kept, dropped

    def late(self, symbol: str, cutoff: datetime, calendar: XetraCalendar) -> list[str]:
        """What is stored here although it was known only after ``cutoff`` (always empty
        unless the cut has a bug). Checks the stored values themselves, not the cut's
        bookkeeping."""
        times = (
            *self.open_ts,
            *self.bar_ts,
            *self.print_ts,
            *self.action_known,
            *(r.close_ts for r in self.rows),
            *(b.close_ts for b in self.bars_eur),
        )
        out = []
        if any(t > cutoff for t in times):
            out.append(f"{symbol}: a print or action known after the cutoff is stored (a bug)")
        if _redact(self.listing, cutoff, calendar) != self.listing:
            out.append(f"{symbol}: a delisting known after the cutoff is stored (a bug)")
        return out

    def canonical(self) -> dict[str, Any]:
        lst = self.listing
        return {
            "listing": [
                lst.symbol,
                lst.currency,
                lst.first_session.isoformat(),
                _iso(lst.last_session),
                _iso(lst.delisting_known_at),
                lst.note,
            ],
            "opens": [
                [d.isoformat(), _iso(ts), repr(px), str(eur)]
                for d, ts, px, eur in zip(
                    self.open_sessions, self.open_ts, self.open_native, self.open_eur, strict=True
                )
            ],
            "bars": [
                [
                    r.session.isoformat(),
                    _iso(r.close_ts),
                    repr(r.open),
                    repr(r.high),
                    repr(r.low),
                    repr(r.close),
                    repr(r.volume),
                    r.currency,
                    r.source,
                    str(close),
                    repr(b.high),
                    repr(b.low),
                ]
                for r, close, b in zip(self.rows, self.close_eur, self.bars_eur, strict=True)
            ],
            "actions": [
                [a.ex_session.isoformat(), a.kind, repr(a.price_factor), _iso(a.known_at)]
                for a in self.actions
            ],
        }


def _iso(value: date | datetime | None) -> str | None:
    """ISO text; an instant always in UTC, so the same instant in another timezone gives the
    same fingerprint."""
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat()
    return None if value is None else value.isoformat()


def _finite_positive(x: float | None) -> TypeGuard[float]:
    return isinstance(x, int | float) and not isinstance(x, bool) and math.isfinite(x) and x > 0


def _open_print(calendar: XetraCalendar, session: date) -> datetime | None:
    """The open print's label, or None if ``session`` is not a session the calendar knows."""
    try:
        return calendar.open_print_utc(session)
    except ValueError:  # not a session, or a year the calendar was not checked for
        return None


def _late_open(calendar: XetraCalendar, bar: DailyBar, cutoff: datetime) -> bool:
    """Is ``bar``'s open print labeled after ``cutoff``? (For a day the calendar does not know:
    is its close?) Asked of the calendar directly, for the re-check after the cut."""
    try:
        return calendar.open_print_utc(bar.session) > cutoff
    except ValueError:
        return bar.close_ts > cutoff


def _session_end(calendar: XetraCalendar, day: date) -> datetime:
    """When trading on ``day`` is surely over: its close label, or (for a day that is not a
    session) midnight after it in the exchange's timezone."""
    try:
        return calendar.close_utc(day)
    except ValueError:
        return datetime.combine(day + timedelta(days=1), time(0), tzinfo=ZoneInfo(calendar.tz))


def _redact(listing: Listing, cutoff: datetime, calendar: XetraCalendar) -> Listing:
    """The listing as known at ``cutoff``: a delisting known later is unknown (both fields
    None); an end that was never announced is unknown until trading on that day is over."""
    if listing.delisting_known_at is not None:
        if listing.delisting_known_at > cutoff:
            return replace(listing, last_session=None, delisting_known_at=None)
        return listing
    if listing.last_session is not None and _session_end(calendar, listing.last_session) > cutoff:
        return replace(listing, last_session=None)
    return listing


@dataclass(frozen=True, slots=True)
class _Row:
    """A source row after the cut: which of its two prints are still in the dataset."""

    bar: DailyBar
    open_ts: datetime | None  # None if the calendar does not know the session
    open_kept: bool
    bar_kept: bool


def _runs(missing: list[date], ordered: list[date]) -> list[tuple[date, date, int]]:
    """Group ``missing`` (a subsequence of ``ordered``) into runs of consecutive sessions."""
    pos = {d: i for i, d in enumerate(ordered)}
    out: list[tuple[date, date, int]] = []
    for d in missing:
        if out and pos[d] == pos[out[-1][1]] + 1:
            out[-1] = (out[-1][0], d, out[-1][2] + 1)
        else:
            out.append((d, d, 1))
    return out


class PitDataset:
    """Immutable apart from a deterministic lazy cache of adjusted bars per epoch."""

    calendar: XetraCalendar
    cutoff: datetime
    source: str
    synthetic: bool
    fx: FxIndex | None
    dropped_after_cutoff: int

    def __init__(
        self,
        *,
        calendar: XetraCalendar,
        cutoff: datetime,
        source: str,
        synthetic: bool,
        fx: FxIndex | None,
        dropped_after_cutoff: int,
        symbols: Mapping[str, _SymbolData],
    ) -> None:
        """Use ``build`` (or ``truncated``): this stores already-checked parts, after one last
        check that none of them was known only after ``cutoff`` (``DataRefusedError``: a bug)."""
        require_aware(cutoff, "dataset cutoff")
        late = [
            problem for symbol, sd in sorted(symbols.items()) for problem in sd.late(symbol, cutoff, calendar)
        ]
        if late:
            raise DataRefusedError(late)
        self.calendar = calendar
        self.cutoff = cutoff
        self.source = source
        self.synthetic = synthetic
        self.fx = fx
        self.dropped_after_cutoff = dropped_after_cutoff
        self._data: dict[str, _SymbolData] = dict(sorted(symbols.items()))
        self._cache: dict[tuple[str, int], tuple[Bar, ...]] = {}
        self._fingerprint: str | None = None

    def __getstate__(self) -> dict[str, Any]:
        state = dict(self.__dict__)
        state["_cache"] = {}  # rebuilt lazily; never shipped to workers
        return state

    # ------------------------------------------------------------------ build
    @classmethod
    def build(
        cls,
        data: SourceData,
        *,
        calendar: XetraCalendar,
        cutoff: datetime,
        accepted_issues: Collection[tuple[str, date, str]] = (),
    ) -> PitDataset:
        require_aware(cutoff, "dataset cutoff")
        problems: list[str] = []
        dropped = 0

        # 1. The cut: what is not known by the cutoff is dropped before anything is checked.
        rows: dict[str, list[_Row]] = {}
        for bar in data.rows:
            op = _open_print(calendar, bar.session)
            bar_kept = bar.close_ts <= cutoff
            open_kept = op <= cutoff if op is not None else bar_kept
            dropped += (not open_kept) + (not bar_kept)
            if open_kept or bar_kept:
                rows.setdefault(bar.symbol, []).append(_Row(bar, op, open_kept, bar_kept))
            if not bar_kept and (over := _session_end(calendar, bar.session)) <= cutoff:
                # Only the label is read: a day that was over by the cutoff cannot close after
                # it, so this row is mislabeled (dropping it silently would hide the error).
                problems.append(
                    f"{bar.symbol} {bar.session}: labeled {bar.close_ts.isoformat()}, after the cutoff, "
                    f"although that day was over by {over.isoformat()}"
                )
        actions: list[CorporateAction] = []
        for action in data.actions:
            if action.known_at > cutoff:
                dropped += 1
            else:
                actions.append(action)
        listings: dict[str, Listing] = {}
        originals: dict[str, Listing] = {}  # as the source gave them: metadata, checked in full
        original_last: dict[str, date | None] = {}
        for listing in data.listings:
            if listing.symbol in listings:
                problems.append(f"{listing.symbol}: more than one listing")
                continue
            originals[listing.symbol] = listing
            original_last[listing.symbol] = listing.last_session
            redacted = _redact(listing, cutoff, calendar)
            dropped += redacted != listing
            listings[listing.symbol] = redacted
        # The re-check recomputes every label from the calendar instead of trusting the cut.
        survivors = [
            f"{symbol} {r.bar.session}: a print after the cutoff survived the cut (a bug)"
            for symbol, items in rows.items()
            for r in items
            if (r.bar_kept and r.bar.close_ts > cutoff)
            or (r.open_kept and _late_open(calendar, r.bar, cutoff))
        ]
        survivors.extend(
            f"{a.symbol} {a.ex_session}: an action known after the cutoff survived (a bug)"
            for a in actions
            if a.known_at > cutoff
        )
        survivors.extend(
            f"{x.symbol}: a delisting known after the cutoff survived (a bug)"
            for x in listings.values()
            if (x.delisting_known_at is not None and x.delisting_known_at > cutoff)
            or (
                x.delisting_known_at is None
                and x.last_session is not None
                and _session_end(calendar, x.last_session) > cutoff
            )
        )
        if survivors:
            raise DataRefusedError(survivors)

        # 2. Listings and corporate actions.
        for symbol, listing in sorted(listings.items()):
            if not listing.note.strip():
                problems.append(
                    f"{symbol}: the listing has no survivorship note (where does the symbol list come from?)"
                )
            if not listing.currency.strip():
                problems.append(f"{symbol}: the listing has no currency")
            last = original_last[symbol]
            if last is not None and last < listing.first_session:
                problems.append(f"{symbol}: listing ends {last}, before it starts {listing.first_session}")
            if originals[symbol].delisting_known_at is not None and last is None:
                problems.append(f"{symbol}: a delisting time without a last session")
        seen_actions: set[tuple[str, date, str]] = set()
        for a in sorted(actions, key=lambda x: (x.symbol, x.ex_session, x.kind)):
            where = f"{a.symbol} {a.ex_session}"
            if a.symbol not in listings:
                problems.append(f"{where}: corporate action for a symbol without a listing")
            if a.kind not in _ACTION_KINDS:
                problems.append(f"{where}: unknown corporate action kind {a.kind!r}")
            if not _finite_positive(a.price_factor):
                problems.append(f"{where}: corporate action price factor {a.price_factor!r} is not positive")
            if _open_print(calendar, a.ex_session) is None:
                problems.append(f"{where}: corporate action ex-date is not a {calendar.name} session")
            if (a.symbol, a.ex_session, a.kind) in seen_actions:
                problems.append(f"{where}: more than one {a.kind} on the same ex-date")
            seen_actions.add((a.symbol, a.ex_session, a.kind))

        # 3. Rows: labels, order, prices, currency, listing span.
        accepted = {(s, d, c) for s, d, c in accepted_issues}
        data_end = max(
            (
                r.bar.session
                for items in rows.values()
                for r in items
                if r.open_kept and r.open_ts is not None
            ),
            default=None,
        )
        built: dict[str, _SymbolData] = {}
        for symbol in sorted(set(rows) | set(listings)):
            items = rows.get(symbol, [])
            entry = listings.get(symbol)
            symbol_problems = _row_problems(symbol, items, entry, original_last.get(symbol), calendar)
            if entry is not None:
                symbol_problems.extend(
                    _coverage_problems(
                        symbol,
                        items,
                        listing=entry,
                        last=original_last[symbol],
                        data_end=data_end,
                        calendar=calendar,
                    )
                )
            bars = [r.bar for r in items if r.bar_kept]
            symbol_problems.extend(_quality_problems(bars, calendar, accepted))
            if entry is None:
                problems.extend(symbol_problems)
                continue
            # Converted even when other problems were found, so a missing rate is listed too.
            converted = _convert(symbol, items, entry.currency, data.fx)
            if isinstance(converted, str):
                symbol_problems.append(converted)
            if symbol_problems:
                problems.extend(symbol_problems)
            elif not isinstance(converted, str):
                symbol_actions = [a for a in actions if a.symbol == symbol]
                built[symbol] = _symbol_data(entry, items, converted, symbol_actions)
        if problems:
            raise DataRefusedError(problems)
        fx = data.fx.truncated(cutoff) if data.fx is not None else None
        return cls(
            calendar=calendar,
            cutoff=cutoff,
            source=data.name,
            synthetic=data.synthetic,
            fx=fx,
            dropped_after_cutoff=dropped,
            symbols=built,
        )

    # --------------------------------------------------------------- identity
    @property
    def fingerprint(self) -> str:
        """sha256 over the canonical rows, actions, listings, cutoff and source (plus the EUR
        values, so a changed FX rate changes it). Nothing past the cutoff enters it."""
        if self._fingerprint is None:
            payload = {
                "source": self.source,
                "synthetic": self.synthetic,
                "cutoff": _iso(self.cutoff),
                "calendar": self.calendar.name,
                "symbols": {symbol: sd.canonical() for symbol, sd in self._data.items()},
            }
            text = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
            self._fingerprint = hashlib.sha256(text.encode("ascii")).hexdigest()
        return self._fingerprint

    def truncated(self, cutoff: datetime) -> PitDataset:
        """A PHYSICAL copy holding only what was known by ``cutoff`` (at or before this
        dataset's own cutoff, else ``CutoffError``)."""
        require_aware(cutoff, "truncation cutoff")
        if cutoff > self.cutoff:
            raise CutoffError(
                f"cannot truncate at {cutoff.isoformat()}: the dataset ends at its cutoff "
                f"{self.cutoff.isoformat()}"
            )
        dropped = self.dropped_after_cutoff
        kept: dict[str, _SymbolData] = {}
        for symbol, sd in self._data.items():
            kept[symbol], n = sd.cut(cutoff, self.calendar)
            dropped += n
        return type(self)(
            calendar=self.calendar,
            cutoff=cutoff,
            source=self.source,
            synthetic=self.synthetic,
            fx=self.fx.truncated(cutoff) if self.fx is not None else None,
            dropped_after_cutoff=dropped,
            symbols=kept,
        )

    # ---------------------------------------------------------------- metadata
    def symbols(self) -> tuple[str, ...]:
        return tuple(self._data)

    def sessions(self, first: date, last: date) -> tuple[date, ...]:
        """Calendar sessions in ``[first, last]`` that lie inside the data: from the earliest
        to the latest session with a close in the dataset (any symbol)."""
        lo = min((sd.bar_sessions[0] for sd in self._data.values() if sd.bar_sessions), default=None)
        hi = max((sd.bar_sessions[-1] for sd in self._data.values() if sd.bar_sessions), default=None)
        if lo is None or hi is None:
            return ()
        start, end = max(first, lo), min(last, hi)
        return tuple(self.calendar.sessions(start, end)) if start <= end else ()

    def listing(self, symbol: str) -> Listing:
        return self._symbol(symbol).listing

    def listed(
        self, session: date, *, at: datetime, min_bars: int, among: Collection[str]
    ) -> tuple[str, ...]:
        """The symbols of ``among`` (sorted) listed by ``session``, with at least ``min_bars``
        bars before it, whose delisting is not known at ``at``. Unknown symbols are not listed."""
        require_aware(at, "listing time")
        if isinstance(min_bars, bool) or not isinstance(min_bars, int) or min_bars < 0:
            raise ValueError(f"min_bars must be an int >= 0, got {min_bars!r}")
        out: list[str] = []
        for symbol in sorted(set(among)):
            sd = self._data.get(symbol)
            if sd is None or sd.listing.first_session > session:
                continue
            if bisect_left(sd.bar_sessions, session) < min_bars:
                continue
            known = sd.listing.delisting_known_at
            if known is not None and known <= at:
                continue
            out.append(symbol)
        return tuple(out)

    def actions_on(self, session: date) -> tuple[CorporateAction, ...]:
        """Every corporate action in the dataset with ``ex_session == session``."""
        return tuple(a for sd in self._data.values() for a in sd.actions if a.ex_session == session)

    # ---------------------------------------------------------------- raw prices
    def has_open_print(self, symbol: str, session: date) -> bool:
        sd = self._data.get(symbol)
        return sd is not None and _index(sd.open_sessions, session) is not None

    def raw_open_eur(self, symbol: str, session: date) -> Decimal:
        """The unadjusted open print of ``session`` in EUR. ``KeyError`` if there is none."""
        sd = self._symbol(symbol)
        i = _index(sd.open_sessions, session)
        if i is None:
            raise KeyError(f"no {symbol} open print for {session}")
        return sd.open_eur[i]

    def raw_close_eur(self, symbol: str, session: date) -> Decimal:
        """The unadjusted close of ``session`` in EUR. ``KeyError`` if there is none."""
        sd = self._symbol(symbol)
        i = _index(sd.bar_sessions, session)
        if i is None:
            raise KeyError(f"no {symbol} close for {session}")
        return sd.close_eur[i]

    def latest_print(self, symbol: str, at: datetime) -> tuple[datetime, Decimal] | None:
        """The newest unadjusted print (open or close) labeled at or before ``at``, with its label."""
        require_aware(at, "print time")
        sd = self._data.get(symbol)
        if sd is None:
            return None
        i = bisect_right(sd.print_ts, at)
        return (sd.print_ts[i - 1], sd.print_eur[i - 1]) if i else None

    def min_open_eur(self, symbols: Collection[str], first: date, last: date) -> Decimal:
        """The lowest unadjusted open print in EUR of ``symbols`` in ``[first, last]``."""
        lows = []
        for symbol in sorted(set(symbols)):
            sd = self._data.get(symbol)
            if sd is None:
                continue
            lo = bisect_left(sd.open_sessions, first)
            hi = bisect_right(sd.open_sessions, last)
            if lo < hi:
                lows.append(min(sd.open_eur[lo:hi]))
        if not lows:
            raise LookupError(f"no open print of {sorted(set(symbols))} between {first} and {last}")
        return min(lows)

    # ------------------------------------------------------------- adjusted bars
    def adjusted_window(self, symbol: str, asof: datetime, window: int) -> tuple[Bar, ...]:
        """The last ``window`` bars closed by ``asof``, in EUR, adjusted for the corporate
        actions known by ``asof``."""
        require_aware(asof, "decision time")
        if window < 1:
            raise ValueError(f"window must be >= 1, got {window}")
        sd = self._symbol(symbol)
        n = bisect_right(sd.bar_ts, asof)
        series = self._adjusted(symbol, bisect_right(sd.action_known, asof))
        return series[max(0, n - window) : n]

    def adjusted_close(self, symbol: str, session: date, *, as_of: datetime) -> float:
        """``session``'s close in EUR, adjusted for the actions known by ``as_of``.
        ``LookaheadError`` if it closes after ``as_of``; ``KeyError`` if there is none."""
        require_aware(as_of, "decision time")
        sd = self._symbol(symbol)
        i = _index(sd.bar_sessions, session)
        if i is None:
            raise KeyError(f"no {symbol} close for {session}")
        if sd.bar_ts[i] > as_of:
            raise LookaheadError(
                f"{symbol} closes {sd.bar_ts[i].isoformat()} for {session}, after {as_of.isoformat()}"
            )
        return self._adjusted(symbol, bisect_right(sd.action_known, as_of))[i].close

    # ---------------------------------------------------------------- internals
    def _symbol(self, symbol: str) -> _SymbolData:
        sd = self._data.get(symbol)
        if sd is None:
            raise KeyError(f"{symbol} is not in the dataset")
        return sd

    def _adjusted(self, symbol: str, epoch: int) -> tuple[Bar, ...]:
        """Every bar of ``symbol`` adjusted for its first ``epoch`` actions (by ``known_at``)."""
        key = (symbol, epoch)
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        sd = self._data[symbol]
        known = sd.actions[:epoch]
        if not known:
            series = sd.bars_eur
        else:
            out: list[Bar] = []
            for session, bar in zip(sd.bar_sessions, sd.bars_eur, strict=True):
                price, volume = 1.0, 1.0
                for action in known:
                    if action.ex_session > session:
                        price *= action.price_factor
                        if action.kind == "split":
                            volume *= action.price_factor
                if price == 1.0 and volume == 1.0:
                    out.append(bar)
                    continue
                out.append(
                    Bar(
                        symbol=bar.symbol,
                        close_ts=bar.close_ts,
                        open=bar.open * price,
                        high=bar.high * price,
                        low=bar.low * price,
                        close=bar.close * price,
                        volume=bar.volume / volume,
                    )
                )
            series = tuple(out)
        self._cache[key] = series
        return series


def _index(ordered: tuple[date, ...], day: date) -> int | None:
    i = bisect_left(ordered, day)
    return i if i < len(ordered) and ordered[i] == day else None


def _row_problems(
    symbol: str,
    items: list[_Row],
    listing: Listing | None,
    original_last: date | None,
    calendar: XetraCalendar,
) -> list[str]:
    problems: list[str] = []
    if items and listing is None:
        problems.append(f"{symbol}: rows but no listing (every symbol needs one, with a survivorship note)")
    currencies = sorted({r.bar.currency for r in items})
    if len(currencies) > 1:
        problems.append(f"{symbol}: more than one currency {currencies}")
    if listing is not None and currencies and currencies != [listing.currency]:
        problems.append(f"{symbol}: rows in {currencies}, but the listing says {listing.currency}")
    seen: set[date] = set()
    previous: date | None = None
    for r in items:
        b = r.bar
        where = f"{symbol} {b.session}"
        if b.session in seen:
            problems.append(f"{where}: more than one row for this session")
        elif previous is not None and b.session < previous:
            problems.append(f"{where}: out of order (comes after {previous})")
        seen.add(b.session)
        previous = b.session if previous is None else max(previous, b.session)
        if r.open_ts is None:
            try:
                known = calendar.is_session(b.session)
            except ValueError as exc:  # a year the calendar was not checked for
                problems.append(f"{where}: {exc}")
            else:
                if not known:
                    problems.append(f"{where}: not a {calendar.name} session")
        elif r.bar_kept and b.close_ts != calendar.close_utc(b.session):
            problems.append(
                f"{where}: labeled {b.close_ts.isoformat()}, but its close is set at "
                f"{calendar.close_utc(b.session).isoformat()}"
            )
        names = ("open", "high", "low", "close") if r.bar_kept else ("open",)
        for name in names:
            value = getattr(b, name)
            if not _finite_positive(value):
                problems.append(f"{where}: {name} is {value!r} (missing, non-finite or not positive)")
        if listing is not None:
            if b.session < listing.first_session:
                problems.append(f"{where}: row before the listing starts ({listing.first_session})")
            if original_last is not None and b.session > original_last:
                problems.append(f"{where}: row after the listing ends ({original_last})")
    return problems


def _coverage_problems(
    symbol: str,
    items: list[_Row],
    *,
    listing: Listing,
    last: date | None,
    data_end: date | None,
    calendar: XetraCalendar,
) -> list[str]:
    """Every session from the listing's start to the earliest of its end and the dataset's
    last session needs a row (its open print, and its bar once that has closed).

    ``last`` is the listing's end as the source gave it, even when the delisting becomes
    known only after the cutoff (and is hidden from decisions): rows after it cannot exist,
    so their absence is no gap. This decides only whether the data are complete, never a
    value a decision sees.
    """
    if data_end is None:
        return []
    end = data_end
    if last is not None:
        end = min(end, last)
    if end < listing.first_session:
        return []
    try:
        required = calendar.sessions(listing.first_session, end)
    except ValueError as exc:
        return [f"{symbol}: cannot check coverage from {listing.first_session} to {end}: {exc}"]
    have = {r.bar.session for r in items if r.open_kept}
    missing = [d for d in required if d not in have]
    return [
        f"{symbol}: no row for {n} session(s) {a}" + (f" .. {b}" if n > 1 else "") + " while it was listed"
        for a, b, n in _runs(missing, required)
    ]


def _quality_problems(
    bars: list[DailyBar], calendar: XetraCalendar, accepted: Collection[tuple[str, date, str]]
) -> list[str]:
    if not bars:
        return []
    issues = list(check_bars(bars))
    with contextlib.suppress(CalendarRangeError):  # a year the calendar does not know: reported per row
        issues.extend(check_calendar(bars, calendar))
    return [
        f"{i} (not accepted)"
        for i in errors(issues)
        if i.session is None or (i.symbol, i.session, i.code) not in accepted
    ]


def _convert(
    symbol: str, items: list[_Row], currency: str, fx: FxIndex | None
) -> list[tuple[Decimal | None, tuple[Decimal, Decimal, Decimal] | None]] | str:
    """Per row: (open in EUR, (high, low, close) in EUR), each at its own print time; or one
    problem string naming the prints without an FX rate. A missing or bad price (already
    reported by ``_row_problems``) is skipped, never converted."""

    def eur(value: float, at: datetime) -> Decimal | None:
        amount = Decimal(repr(value))
        if currency == _EUR:
            return amount
        return fx.to_eur(amount, currency, at) if fx is not None else None

    out: list[tuple[Decimal | None, tuple[Decimal, Decimal, Decimal] | None]] = []
    missing: list[datetime] = []
    for r in items:
        b = r.bar
        open_eur: Decimal | None = None
        if r.open_kept and r.open_ts is not None and _finite_positive(b.open):
            open_eur = eur(b.open, r.open_ts)
            if open_eur is None:
                missing.append(r.open_ts)
        hlc: tuple[Decimal, Decimal, Decimal] | None = None
        if r.bar_kept and _finite_positive(b.high) and _finite_positive(b.low) and _finite_positive(b.close):
            values = [eur(x, b.close_ts) for x in (b.high, b.low, b.close)]
            if any(v is None for v in values):
                missing.append(b.close_ts)
            else:
                high, low, close = (v for v in values if v is not None)
                hlc = (high, low, close)
        out.append((open_eur, hlc))
    if missing:
        return (
            f"{symbol}: no {currency} rate public at {len(missing)} print time(s) "
            f"(first {min(missing).isoformat()}, last {max(missing).isoformat()})"
        )
    return out


def _symbol_data(
    listing: Listing,
    items: list[_Row],
    converted: list[tuple[Decimal | None, tuple[Decimal, Decimal, Decimal] | None]],
    actions: Iterable[CorporateAction],
) -> _SymbolData:
    """The stored form of one checked symbol (every row valid, every EUR value present)."""
    opens: list[tuple[datetime, date, float, Decimal]] = []
    bars: list[tuple[DailyBar, Decimal, Bar]] = []
    for r, (open_eur, hlc) in zip(items, converted, strict=True):
        b = r.bar
        if r.open_kept and r.open_ts is not None and open_eur is not None and b.open is not None:
            opens.append((r.open_ts, b.session, b.open, open_eur))
        if r.bar_kept and hlc is not None and open_eur is not None:
            high, low, close = hlc
            volume = b.volume if b.volume is not None else math.nan
            bars.append(
                (
                    b,
                    close,
                    Bar(b.symbol, b.close_ts, float(open_eur), float(high), float(low), float(close), volume),
                )
            )
    ordered_actions = tuple(sorted(actions, key=lambda a: (a.known_at, a.ex_session, a.kind, a.price_factor)))
    prints = sorted([(ts, px) for ts, _, _, px in opens] + [(b.close_ts, close) for b, close, _ in bars])
    return _SymbolData(
        listing=listing,
        open_sessions=tuple(d for _, d, _, _ in opens),
        open_ts=tuple(ts for ts, _, _, _ in opens),
        open_native=tuple(px for _, _, px, _ in opens),
        open_eur=tuple(eur for _, _, _, eur in opens),
        rows=tuple(b for b, _, _ in bars),
        bar_sessions=tuple(b.session for b, _, _ in bars),
        bar_ts=tuple(b.close_ts for b, _, _ in bars),
        close_eur=tuple(c for _, c, _ in bars),
        bars_eur=tuple(bar for _, _, bar in bars),
        actions=ordered_actions,
        action_known=tuple(a.known_at for a in ordered_actions),
        print_ts=tuple(ts for ts, _ in prints),
        print_eur=tuple(px for _, px in prints),
    )
