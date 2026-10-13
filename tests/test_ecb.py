"""ECB FX adapter, tested on real responses recorded 2026-10-12 (tests/fixtures/ecb)."""

from __future__ import annotations

import http.client
import io
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path

import pytest

from samsulek.data.sources.ecb import HOST, EcbFormatError, EcbSource, available_at, parse_csv
from samsulek.net.http import HttpClient, HttpError

FIX = Path(__file__).parent / "fixtures" / "ecb"
FETCHED = datetime(2026, 10, 12, 21, 14, 48, tzinfo=UTC)


def body(name: str) -> bytes:
    return (FIX / name).read_bytes()


@dataclass
class Raw:
    status: int
    body: bytes
    headers: list[tuple[str, str]] = field(default_factory=lambda: [("Content-Type", "text/csv")])

    def getheaders(self) -> list[tuple[str, str]]:
        return self.headers

    def read(self, amt: int | None = None) -> bytes:
        return self.body

    def close(self) -> None:
        pass


class Replay:
    def __init__(self, *outcomes: object) -> None:
        self.outcomes = list(outcomes)
        self.urls: list[str] = []

    def __call__(self, request: urllib.request.Request, timeout: float) -> Raw:
        self.urls.append(request.full_url)
        out = self.outcomes.pop(0)
        if isinstance(out, BaseException):
            raise out
        assert isinstance(out, Raw)
        return out


def not_found(name: str) -> urllib.error.HTTPError:
    msg = http.client.HTTPMessage()
    msg["Content-Type"] = "application/problem+json"
    return urllib.error.HTTPError("https://x", 404, "Not Found", msg, io.BytesIO(body(name)))


def source(replay: Replay) -> EcbSource:
    client = HttpClient(
        user_agent="samsulek-test/0", allowed_hosts=frozenset({HOST}), opener=replay, now=lambda: FETCHED
    )
    return EcbSource(client)


def test_parses_a_real_half_year_of_usd_rates() -> None:
    rows = parse_csv(body("usd_2025-12-15_2026-06-10_dataonly.csv").decode(), FETCHED)
    assert len(rows) == 122
    first = rows[0]
    assert (first.currency, first.obs_date, first.rate) == ("USD", date(2025, 12, 15), Decimal("1.1753"))
    assert first.fetched_at == FETCHED
    days = {r.obs_date for r in rows}
    for target_holiday in (date(2025, 12, 25), date(2025, 12, 26), date(2026, 1, 1), date(2026, 4, 3)):
        assert target_holiday not in days
    for ecb_only_holiday in (date(2025, 12, 24), date(2025, 12, 31), date(2026, 5, 14)):
        assert ecb_only_holiday in days, "rates ARE published on ECB-only holidays"
    assert all(r.obs_date.weekday() < 5 for r in rows)


def test_rates_are_foreign_per_euro_and_public_from_17h_frankfurt() -> None:
    rows = parse_csv(body("usd_gbp_chf_first_observation.csv").decode(), FETCHED)
    usd = next(r for r in rows if r.currency == "USD")
    assert usd.obs_date == date(1999, 1, 4) and usd.rate == Decimal("1.1789")
    assert usd.to_eur(Decimal("117.89")) == Decimal(100)
    assert available_at(date(2026, 7, 1)) == datetime(2026, 7, 1, 15, 0, tzinfo=UTC)  # CEST
    assert available_at(date(2026, 1, 15)) == datetime(2026, 1, 15, 16, 0, tzinfo=UTC)  # CET


def test_old_history_marks_holidays_with_an_empty_value() -> None:
    rows = parse_csv(body("chf_1999-12_empty_value_rows.csv").decode(), FETCHED)
    assert [r.obs_date.isoformat() for r in rows] == [
        "1999-12-28",
        "1999-12-29",
        "1999-12-30",
        "2000-01-03",
        "2000-01-04",
    ], "1999-12-31 had no rate: skipped, not an error and not a zero"


def test_full_format_and_updated_after_format_both_parse() -> None:
    full = parse_csv(body("usd_gbp_2026-09_full.csv").decode(), FETCHED)
    assert len(full) == 44 and {r.currency for r in full} == {"USD", "GBP"}
    updates = parse_csv(body("usd_gbp_updated_after_2026-10-09.csv").decode(), FETCHED)
    assert {(r.currency, r.obs_date) for r in updates} == {
        ("USD", date(2026, 10, 9)),
        ("USD", date(2026, 10, 12)),
        ("GBP", date(2026, 10, 9)),
        ("GBP", date(2026, 10, 12)),
    }


def test_holidays_only_query_returns_an_empty_body() -> None:
    assert body("target_holiday_empty.csv") == b""
    replay = Replay(Raw(200, b""))
    assert source(replay).fetch_range(["USD"], date(2025, 12, 25), date(2025, 12, 26)) == []
    query = urllib.parse.parse_qs(urllib.parse.urlsplit(replay.urls[0]).query)
    assert query == {
        "startPeriod": ["2025-12-25"],
        "endPeriod": ["2025-12-26"],
        "format": ["csvdata"],
        "detail": ["dataonly"],
    }
    assert "/EXR/D.USD.EUR.SP00.A?" in replay.urls[0]


def test_nothing_new_is_empty_but_a_404_elsewhere_is_an_error() -> None:
    replay = Replay(not_found("updated_after_nothing_new_404.json"))
    since = datetime(2026, 10, 12, 14, 30, tzinfo=UTC)
    assert source(replay).fetch_updates(["GBP", "USD"], since) == []
    assert "updatedAfter=2026-10-12T14%3A30%3A00%2B00%3A00" in replay.urls[0]
    assert "/EXR/D.GBP+USD.EUR.SP00.A?" in replay.urls[0]
    with pytest.raises(HttpError, match="404"):
        source(Replay(not_found("bad_key_404.json"))).fetch_range(
            ["USD"], date(2026, 1, 1), date(2026, 1, 31)
        )


def test_bad_requests_are_refused_before_asking() -> None:
    src = source(Replay())
    for bad in (["usd"], ["EUR"], ["US"], [], ["USD", "X1Z"]):
        with pytest.raises(ValueError, match="currenc"):
            src.fetch_range(bad, date(2026, 1, 1), date(2026, 1, 2))
    with pytest.raises(ValueError, match="aware"):
        src.fetch_updates(["USD"], datetime(2026, 1, 1))  # noqa: DTZ001


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda t: t.replace("OBS_VALUE", "VALUE"), "unexpected CSV header"),
        (lambda t: t.replace(",SP00,", ",SP01,"), "not a daily EUR spot"),
        (lambda t: t.replace("1.1753", "-1.1753"), "positive"),
        (lambda t: t.replace("1.1753", "n/a"), "line 2"),
        (lambda t: t.replace("2025-12-15", "1998-12-31"), "before the euro"),
        (lambda t: t.replace("2025-12-15", "15/12/2025"), "line 2"),
    ],
)
def test_unexpected_content_stops_instead_of_guessing(mutate: object, message: str) -> None:
    text = body("usd_2025-12-15_2026-06-10_dataonly.csv").decode()
    with pytest.raises(EcbFormatError, match=message):
        parse_csv(mutate(text), FETCHED)  # type: ignore[operator]


def test_wrong_content_type_is_refused() -> None:
    replay = Replay(Raw(200, b"<html>maintenance</html>", [("Content-Type", "text/html")]))
    with pytest.raises(EcbFormatError, match="text/csv"):
        source(replay).fetch_range(["USD"], date(2026, 1, 1), date(2026, 1, 2))
