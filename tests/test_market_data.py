"""MarketData: ECB rates stored point-in-time, revisions caught, "as known at" reads."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import pytest

from samsulek.clock import FixedClock
from samsulek.data.market import MarketData
from samsulek.data.sources.ecb import FxObservation, available_at, parse_csv

FIX = Path(__file__).parent / "fixtures" / "ecb"
FETCH1 = datetime(2026, 6, 10, 18, 0, tzinfo=UTC)
REAL = parse_csv((FIX / "usd_2025-12-15_2026-06-10_dataonly.csv").read_text(encoding="utf-8"), FETCH1)


class FakeEcb:
    def __init__(self, rows: list[FxObservation]) -> None:
        self.rows = rows
        self.calls: list[tuple[list[str], date, date]] = []

    def fetch_range(self, currencies: Iterable[str], start: date, end: date) -> list[FxObservation]:
        ccys = list(currencies)
        self.calls.append((ccys, start, end))
        return [r for r in self.rows if r.currency in ccys and start <= r.obs_date <= end]


def test_first_update_backfills_everything_and_later_ones_refetch_30_days(tmp_path: Path) -> None:
    clock = FixedClock(FETCH1)
    md = MarketData(tmp_path, clock)
    src = FakeEcb(REAL)
    report = md.update_fx(src, ["USD"])  # type: ignore[arg-type]
    assert report.new == 122 and report.revised == [] and report.warnings == []
    assert src.calls[0][1] == date(1999, 1, 4), "first update asks for the whole history"
    assert src.calls[-1][2] == date(2026, 6, 10)
    for (_, _, end), (_, nxt, _) in zip(src.calls, src.calls[1:], strict=False):
        assert nxt == end + timedelta(days=1), "pieces are contiguous: no day skipped"
    assert all((end - start).days < 730 for _, start, end in src.calls), "in two-year pieces"
    first_update_calls = len(src.calls)
    assert report.latest == {"USD": date(2026, 6, 10)}
    clock.advance(timedelta(days=1))
    again = md.update_fx(src, ["USD"])  # type: ignore[arg-type]
    assert again.new == 0 and again.revised == []
    assert len(src.calls) == first_update_calls + 1, "a daily update is one small request"
    assert src.calls[-1][1] == date(2026, 6, 10) - timedelta(days=30)
    assert len(md.fx.files()) == 1, "an unchanged re-download writes nothing"


def test_a_corrected_rate_is_kept_as_a_new_version(tmp_path: Path) -> None:
    clock = FixedClock(FETCH1)
    md = MarketData(tmp_path, clock)
    md.update_fx(FakeEcb(REAL), ["USD"])  # type: ignore[arg-type]
    fetch2 = FETCH1 + timedelta(days=1)
    clock.set(fetch2)
    corrected = [
        replace(r, rate=Decimal("1.2000"), fetched_at=fetch2)
        if r.obs_date == date(2026, 6, 9)
        else replace(r, fetched_at=fetch2)
        for r in REAL
    ]
    report = md.update_fx(FakeEcb(corrected), ["USD"])  # type: ignore[arg-type]
    assert len(report.revised) == 1 and "2026-06-09" in report.revised[0]
    at = datetime(2026, 6, 9, 20, 0, tzinfo=UTC)
    assert md.latest_fx("USD", at).rate == Decimal("1.2000")  # type: ignore[union-attr]
    before_fix = md.latest_fx("USD", at, known_at=FETCH1 + timedelta(hours=1))
    assert before_fix is not None and before_fix.rate != Decimal("1.2000"), "what we knew then"


def test_a_rate_is_only_usable_after_it_was_published(tmp_path: Path) -> None:
    md = MarketData(tmp_path, FixedClock(FETCH1))
    md.update_fx(FakeEcb(REAL), ["USD"])  # type: ignore[arg-type]
    day = date(2026, 6, 9)
    public = available_at(day)  # 17:00 Frankfurt
    assert md.latest_fx("USD", public - timedelta(minutes=1)).obs_date == date(2026, 6, 8)  # type: ignore[union-attr]
    assert md.latest_fx("USD", public).obs_date == day  # type: ignore[union-attr]
    rate = md.latest_fx("USD", public)
    assert rate is not None
    assert md.to_eur(Decimal("100") * rate.rate, "USD", public) == Decimal(100)
    assert md.to_eur(Decimal("5"), "EUR", public) == Decimal(5)
    with pytest.raises(LookupError, match="no USD rate"):
        md.to_eur(Decimal(1), "USD", datetime(2000, 1, 1, tzinfo=UTC))


def test_stale_rates_are_warned_about(tmp_path: Path) -> None:
    md = MarketData(tmp_path, FixedClock(FETCH1 + timedelta(days=10)))
    report = md.update_fx(FakeEcb(REAL), ["USD", "GBP"])  # type: ignore[arg-type]
    assert any("USD: newest rate is from 2026-06-10" in w for w in report.warnings)
    assert any("no GBP rate" in w for w in report.warnings)
    assert md.status()["USD"]["rows"] == 122
