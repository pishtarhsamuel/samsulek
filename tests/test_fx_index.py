"""FxIndex (trap 8): exactly MarketData.latest_fx's "as known" semantics, from memory.

The oracle is the real store: a fixture store in a temporary folder, written with the
existing ``VersionedTable`` API at three fetch times, with corrections, then
``MarketData.latest_fx`` is compared with ``FxIndex.rate`` on random ``(at, known_at)``.
"""

from __future__ import annotations

import pickle
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from samsulek.backtest import fx as fx_module
from samsulek.backtest.fx import FxIndex
from samsulek.backtest.types import BacktestRefused
from samsulek.clock import FixedClock
from samsulek.data.market import FxRate, MarketData
from samsulek.data.sources import ecb
from samsulek.data.store import to_us

CURRENCIES = ("USD", "GBP")
FIRST = date(2024, 11, 1)
LAST = date(2025, 1, 31)
F1 = datetime(2024, 12, 20, 18, 0, tzinfo=UTC)  # first download: history up to 2024-12-20
F2 = datetime(2025, 1, 10, 18, 0, tzinfo=UTC)  # more days, and corrections
F3 = datetime(2025, 2, 5, 18, 0, tzinfo=UTC)  # the rest, and more corrections
TARGET_HOLIDAYS = {date(2024, 12, 25), date(2024, 12, 26), date(2025, 1, 1)}
LO = datetime(2024, 10, 20, tzinfo=UTC)
HI = datetime(2025, 2, 20, tzinfo=UTC)


def target_days(first: date, last: date) -> list[date]:
    out, d = [], first
    while d <= last:
        if d.weekday() < 5 and d not in TARGET_HOLIDAYS:
            out.append(d)
        d += timedelta(days=1)
    return out


DAYS = target_days(FIRST, LAST)


def base_rate(currency: str, day: date) -> Decimal:
    start = {"USD": Decimal("1.0800"), "GBP": Decimal("0.8400")}[currency]
    return start + Decimal((day - FIRST).days % 17) / Decimal(1000)


def corrected(currency: str, day: date, fetch: datetime) -> Decimal:
    """The rate as stored at ``fetch``: some days were corrected at F2, some again at F3."""
    rate = base_rate(currency, day)
    n = (day - FIRST).days
    if fetch >= F2 and n % 5 == 0:
        rate += Decimal("0.0100")
    if fetch >= F3 and n % 7 == 0:
        rate += Decimal("0.0030")
    return rate


def rows_known_at(fetch: datetime, source: str = ecb.SOURCE, scale: int = 1) -> list[dict[str, object]]:
    last = fetch.date()
    return [
        {
            "source": source,
            "currency": c,
            "obs_date": d,
            "rate": str(corrected(c, d, fetch) * scale),
            "available_us": to_us(ecb.available_at(d)),
        }
        for c in CURRENCIES
        for d in DAYS
        if d <= last
    ]


@pytest.fixture(scope="module")
def market(tmp_path_factory: pytest.TempPathFactory) -> Iterator[MarketData]:
    root: Path = tmp_path_factory.mktemp("fxstore")
    md = MarketData(root, FixedClock(F3))
    for fetch in (F1, F2, F3):
        md.fx.write(md.con, rows_known_at(fetch), fetch, scope={"source": ecb.SOURCE})
    # A second source in the same table must be ignored, as latest_fx ignores it.
    md.fx.write(md.con, rows_known_at(F3, source="other", scale=2), F3, scope={"source": "other"})
    yield md
    md.close()


@pytest.fixture(scope="module")
def index(market: MarketData) -> FxIndex:
    return FxIndex.load(market, [*CURRENCIES, "EUR", "CHF"])


def expected(market: MarketData, currency: str, at: datetime, known_at: datetime | None) -> FxRate | None:
    """The oracle, plus FxIndex's documented MAX_AGE rule."""
    rate = market.latest_fx(currency, at, known_at)
    if rate is None or rate.available_at < at - FxIndex.MAX_AGE:
        return None
    return rate


Case = tuple[str, datetime, datetime | None]


def grid() -> list[Case]:
    """Publication instants (and 1 us before) around both correction fetches, the first and
    last day, the Xetra labels of the early-close day, and the fetch-time edges."""
    days = [FIRST, *target_days(date(2024, 12, 2), date(2025, 1, 17)), LAST]
    instants: list[datetime] = [LO, HI, datetime(2024, 12, 30, 8, 5, tzinfo=UTC)]
    instants.append(datetime(2024, 12, 30, 13, 10, tzinfo=UTC))
    for d in days:
        pub = ecb.available_at(d)
        instants += [pub - timedelta(microseconds=1), pub]
    knowns: list[datetime | None] = [None, F1 - timedelta(microseconds=1), F2, F3]
    return [(c, at, k) for c in ("USD", "CHF") for at in instants for k in knowns]


@pytest.fixture(scope="module")
def oracle(market: MarketData) -> dict[Case, FxRate | None]:
    """The store's answers for the whole grid, asked once (each is a DuckDB query)."""
    return {case: expected(market, *case) for case in grid()}


def mismatches(fx: FxIndex, oracle: dict[Case, FxRate | None], cases: list[Case]) -> list[str]:
    out = []
    for currency, at, known_at in cases:
        want = oracle[(currency, at, known_at)]
        got = fx.rate(currency, at, known_at=known_at)
        if got != want:
            out.append(f"{currency} at={at} known_at={known_at}: {got} != {want}")
    return out


# --------------------------------------------------------------------- oracle
@settings(max_examples=150, deadline=None)
@given(
    currency=st.sampled_from([*CURRENCIES, "CHF"]),
    at=st.datetimes(
        min_value=LO.replace(tzinfo=None), max_value=HI.replace(tzinfo=None), timezones=st.just(UTC)
    ),
    known_at=st.none()
    | st.sampled_from([F1, F2, F3])
    | st.datetimes(
        min_value=LO.replace(tzinfo=None), max_value=HI.replace(tzinfo=None), timezones=st.just(UTC)
    ),
)
def test_rate_equals_market_data_latest_fx(
    market: MarketData, index: FxIndex, currency: str, at: datetime, known_at: datetime | None
) -> None:
    assert index.rate(currency, at, known_at=known_at) == expected(market, currency, at, known_at)
    amount = Decimal("123.45")
    rate = expected(market, currency, at, None)
    assert index.to_eur(amount, currency, at) == (None if rate is None else amount / rate.rate)


def test_rate_equals_the_oracle_on_every_edge_instant(
    oracle: dict[Case, FxRate | None], index: FxIndex
) -> None:
    cases = grid()
    assert len(cases) > 400
    assert any(v is None for v in oracle.values()) and any(v is not None for v in oracle.values())
    assert mismatches(index, oracle, cases) == []


def test_corrections_are_used_only_once_known(market: MarketData, index: FxIndex) -> None:
    day = date(2024, 12, 16)  # n = 45: corrected at F2 (n % 5 == 0)
    at = ecb.available_at(day) + timedelta(hours=1)
    first = index.rate("USD", at)  # nothing was stored by then: the OLDEST version stands in
    assert first is not None and first.obs_date == day and first.rate == base_rate("USD", day)
    assert first.fetched_at == F1
    later = index.rate("USD", at, known_at=F2)
    assert later is not None and later.rate == base_rate("USD", day) + Decimal("0.0100")
    assert index.rate("USD", at, known_at=F2 - timedelta(microseconds=1)) == first
    assert market.latest_fx("USD", at, F2) == later  # the oracle agrees


def test_the_early_close_mark_uses_the_previous_target_days_rate(index: FxIndex) -> None:
    # 2024-12-30 closes 14:00 Berlin, labeled 13:10 UTC: before that day's 16:00 UTC rate.
    mark = datetime(2024, 12, 30, 13, 10, tzinfo=UTC)
    rate = index.rate("USD", mark)
    assert rate is not None and rate.obs_date == date(2024, 12, 27)
    after = index.rate("USD", ecb.available_at(date(2024, 12, 30)))
    assert after is not None and after.obs_date == date(2024, 12, 30)
    assert ecb.available_at(date(2024, 12, 30)) == datetime(2024, 12, 30, 16, 0, tzinfo=UTC)


def test_a_rate_becomes_usable_exactly_at_its_publication(index: FxIndex) -> None:
    pub = ecb.available_at(date(2025, 1, 15))
    before = index.rate("GBP", pub - timedelta(microseconds=1))
    at = index.rate("GBP", pub)
    assert before is not None and before.obs_date == date(2025, 1, 14)
    assert at is not None and at.obs_date == date(2025, 1, 15) and at.available_at == pub


def test_a_rate_older_than_max_age_is_no_rate(index: FxIndex) -> None:
    assert timedelta(days=7) == FxIndex.MAX_AGE
    last_pub = ecb.available_at(LAST)
    assert index.rate("USD", last_pub + FxIndex.MAX_AGE) is not None
    assert index.rate("USD", last_pub + FxIndex.MAX_AGE + timedelta(microseconds=1)) is None
    assert index.to_eur(Decimal(10), "USD", last_pub + timedelta(days=30)) is None
    assert index.rate("USD", ecb.available_at(FIRST) - timedelta(microseconds=1)) is None  # before the first


def test_eur_is_one_and_unknown_currencies_have_no_rate(index: FxIndex) -> None:
    at = datetime(2025, 1, 15, 12, 0, tzinfo=UTC)
    eur = index.rate("EUR", at)
    assert eur is not None and eur.rate == Decimal(1) and eur.currency == "EUR"
    assert index.to_eur(Decimal("7.5"), "EUR", at) == Decimal("7.5")
    assert index.rate("CHF", at) is None
    assert index.to_eur(Decimal(1), "CHF", at) is None


def test_load_reads_only_the_ecb_source(market: MarketData) -> None:
    assert fx_module.ECB_SOURCE == ecb.SOURCE
    other = FxIndex.from_rows(market.fx.history(market.con, where={"source": "other", "currency": "USD"}))
    loaded = FxIndex.load(market, ["USD"])
    at = datetime(2025, 1, 20, 18, 0, tzinfo=UTC)
    ours, theirs = loaded.rate("USD", at), other.rate("USD", at)
    assert ours is not None and theirs is not None
    assert theirs.rate == 2 * corrected("USD", date(2025, 1, 20), F3)  # the other source's numbers
    assert ours == market.latest_fx("USD", at) and ours.rate != theirs.rate
    mixed = market.fx.history(market.con, where={"currency": "USD"})
    with pytest.raises(ValueError, match="more than one source"):
        FxIndex.from_rows(mixed)


def test_times_must_be_aware(index: FxIndex) -> None:
    with pytest.raises(ValueError, match="timezone"):
        index.rate("USD", datetime(2025, 1, 15, 12, 0))  # noqa: DTZ001
    with pytest.raises(ValueError, match="timezone"):
        index.rate("USD", datetime(2025, 1, 15, 12, 0, tzinfo=UTC), known_at=datetime(2025, 1, 15))  # noqa: DTZ001


# ----------------------------------------------------------------- truncation
@pytest.mark.parametrize(
    "cutoff",
    [
        datetime(2024, 12, 20, 16, 0, tzinfo=UTC),  # exactly a publication instant
        datetime(2024, 12, 30, 13, 10, tzinfo=UTC),
        datetime(2025, 1, 10, 18, 0, tzinfo=UTC),
    ],
)
def test_truncated_answers_every_earlier_question_like_the_full_index(
    oracle: dict[Case, FxRate | None], index: FxIndex, cutoff: datetime
) -> None:
    cut = index.truncated(cutoff)
    cases = [(c, at, k) for c, at, k in grid() if at <= cutoff]
    assert cases
    assert [(c, at, k, cut.rate(c, at, known_at=k)) for c, at, k in cases] == [
        (c, at, k, index.rate(c, at, known_at=k)) for c, at, k in cases
    ]
    # Physically gone: no rate published after the cutoff, whatever the question.
    for currency in CURRENCIES:
        for at in (cutoff, cutoff + timedelta(days=3), HI):
            rate = cut.rate(currency, at)
            assert rate is None or rate.available_at <= cutoff
    assert mismatches(cut, oracle, cases) == []
    assert cut.truncated(cutoff).rate("USD", cutoff) == cut.rate("USD", cutoff)  # idempotent


def test_truncation_keeps_every_version_of_the_rates_it_keeps(index: FxIndex) -> None:
    cut = index.truncated(datetime(2024, 12, 20, 16, 0, tzinfo=UTC))
    at = ecb.available_at(date(2024, 12, 16)) + timedelta(hours=1)
    # The F2 correction was fetched after the cutoff but corrects a rate public before it:
    # asked "as known at F2", the truncated index answers like the full one.
    assert cut.rate("USD", at, known_at=F2) == index.rate("USD", at, known_at=F2)
    with pytest.raises(ValueError, match="timezone"):
        index.truncated(datetime(2025, 1, 1))  # noqa: DTZ001


def test_the_index_pickles_and_answers_the_same(index: FxIndex) -> None:
    back = pickle.loads(pickle.dumps(index))  # noqa: S301
    for currency, at, known_at in grid()[::37]:
        assert back.rate(currency, at, known_at=known_at) == index.rate(currency, at, known_at=known_at)


# ------------------------------------------------------------------ refusals
def row(**over: object) -> dict[str, object]:
    base: dict[str, object] = {
        "source": "ecb",
        "currency": "USD",
        "obs_date": date(2025, 1, 15),
        "rate": "1.0300",
        "available_us": to_us(ecb.available_at(date(2025, 1, 15))),
        "fetched_us": to_us(F3),
    }
    return base | over


def test_from_rows_refuses_ambiguous_or_malformed_rows() -> None:
    later = to_us(ecb.available_at(date(2025, 1, 16)))
    bad = [
        row(),
        row(fetched_us=to_us(F3) + 1, available_us=later),  # versions disagree on publication
        row(obs_date=date(2025, 1, 14), rate="1.0"),
        row(obs_date=date(2025, 1, 14), rate="1.1"),  # same key, same fetch time, other rate
        row(obs_date=date(2025, 1, 13), rate="-1"),
        row(obs_date=date(2025, 1, 10), rate="x"),
        row(currency="usd"),
        row(obs_date="2025-01-09"),
        row(available_us=1.5),
        {"currency": "USD"},
    ]
    with pytest.raises(ValueError, match="FX rows refused") as info:
        FxIndex.from_rows(bad)
    assert isinstance(info.value, BacktestRefused)  # stops a study before its first cycle
    assert len(info.value.problems) == 8  # every bad row, each listed once
    text = str(info.value)
    for needle in (
        "disagree on when the rate was published",
        "disagree (1.0 vs 1.1)",
        "is not a positive number",
        "unreadable",
        "bad currency",
        "is not a date",
        "integer microseconds",
    ):
        assert needle in text, needle


def test_the_order_of_the_rows_does_not_matter(market: MarketData, oracle: dict[Case, FxRate | None]) -> None:
    rows = [
        r
        for c in CURRENCIES
        for r in market.fx.history(market.con, where={"source": ecb.SOURCE, "currency": c})
    ]
    newest_first = FxIndex.from_rows(list(reversed(rows)))  # later fetches before earlier ones
    assert mismatches(newest_first, oracle, grid()) == []


def test_identical_duplicate_rows_are_harmless() -> None:
    fx = FxIndex.from_rows([row(), row()])
    rate = fx.rate("USD", ecb.available_at(date(2025, 1, 15)))
    assert rate is not None and rate.rate == Decimal("1.0300")


# ------------------------------------------------- any publication pattern
BASE = datetime(2025, 3, 3, tzinfo=UTC)


@dataclass(frozen=True)
class Version:
    obs: date
    rate: Decimal
    available: datetime
    fetched: datetime

    def row(self) -> dict[str, object]:
        return {
            "currency": "USD",
            "obs_date": self.obs,
            "rate": str(self.rate),
            "available_us": to_us(self.available),
            "fetched_us": to_us(self.fetched),
        }


def brute_force(versions: list[Version], at: datetime, known_at: datetime | None) -> FxRate | None:
    """The documented rule, written out the slow way: per observation the version as known
    (newest fetched by then, else the oldest), then the newest observation public at ``at``."""
    known = known_at or at
    best: Version | None = None
    for obs in sorted({v.obs for v in versions}):
        mine = sorted((v for v in versions if v.obs == obs), key=lambda v: v.fetched)
        stored = [v for v in mine if v.fetched <= known]
        chosen = stored[-1] if stored else mine[0]
        if chosen.available <= at:
            best = chosen
    if best is None or best.available < at - FxIndex.MAX_AGE:
        return None
    return FxRate("USD", best.obs, best.rate, best.available, best.fetched)


@settings(max_examples=200, deadline=None)
@given(
    keys=st.lists(
        st.tuples(
            st.integers(min_value=-48, max_value=200),  # published, hours after its day starts
            st.lists(st.integers(min_value=0, max_value=400), min_size=1, max_size=3, unique=True),
        ),
        min_size=1,
        max_size=6,
    ),
    at_hours=st.integers(min_value=-60, max_value=420),
    known_hours=st.none() | st.integers(min_value=-60, max_value=420),
)
def test_rate_follows_the_rule_for_any_publication_order(
    keys: list[tuple[int, list[int]]], at_hours: int, known_hours: int | None
) -> None:
    """Also when an older observation was published after a newer one (out of order), which
    the ECB adapter never produces but the index must still answer correctly."""
    versions = [
        Version(
            obs=BASE.date() + timedelta(days=day),
            rate=Decimal("1.1") + Decimal(day) / 100 + Decimal(n) / 1000,
            available=BASE + timedelta(days=day, hours=published),
            fetched=BASE + timedelta(hours=fetched),
        )
        for day, (published, fetch_hours) in enumerate(keys)
        for n, fetched in enumerate(fetch_hours)
    ]
    at = BASE + timedelta(hours=at_hours)
    known_at = None if known_hours is None else BASE + timedelta(hours=known_hours)
    index = FxIndex.from_rows([v.row() for v in versions])
    expected = brute_force(versions, at, known_at)
    assert index.rate("USD", at, known_at=known_at) == expected
    assert index.truncated(at).rate("USD", at, known_at=known_at) == expected


# ---------------------------------------------------------- planted defect
class DateKeyedCache(FxIndex):
    """PLANTED DEFECT: caches rates by (currency, UTC date), as a careless speed-up would."""

    def __init__(self, inner: FxIndex) -> None:
        self.inner = inner
        self.memo: dict[tuple[str, date], FxRate | None] = {}

    def rate(self, currency: str, at: datetime, *, known_at: datetime | None = None) -> FxRate | None:
        key = (currency, at.date())
        if key not in self.memo:
            self.memo[key] = self.inner.rate(currency, at, known_at=known_at)
        return self.memo[key]


def test_a_planted_date_keyed_cache_is_caught_by_the_oracle(
    oracle: dict[Case, FxRate | None], index: FxIndex
) -> None:
    planted = DateKeyedCache(index)
    assert mismatches(planted, oracle, grid()) != []
    assert mismatches(index, oracle, grid()) == []
