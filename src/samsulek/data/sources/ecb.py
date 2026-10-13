"""ECB euro foreign exchange reference rates (ECB Data Portal, dataset EXR). Free, no key.

Facts this adapter relies on (checked 2026-10-12 against live responses and the ECB's
reference-rate pages; the API help pages themselves were unreachable from the build
environment):
- URL: https://data-api.ecb.europa.eu/service/data/EXR/D.<CCY>[+<CCY>...].EUR.SP00.A
  with startPeriod/endPeriod (YYYY-MM-DD) or updatedAfter (ISO 8601), format=csvdata,
  detail=dataonly. Columns: KEY, FREQ, CURRENCY, CURRENCY_DENOM, EXR_TYPE, EXR_SUFFIX,
  TIME_PERIOD, OBS_VALUE (+ ACTION=Replace for updatedAfter queries). CRLF line endings.
- The value is units of foreign currency per 1 EUR, so EUR amount = foreign / rate.
- Published around 16:00 Frankfurt time on TARGET working days; no row on weekends or
  TARGET holidays. A query covering only holidays returns 200 with an EMPTY body.
- ``updatedAfter`` with nothing new returns 404 "No Series was returned" - the same
  answer as a misspelled series key. So currencies are validated before asking, and a
  freshness check (not this adapter) decides whether data is missing.
- Rates are "for information purposes only": they are not the broker's FX rate, which
  also charges a fee. Backtests must model the broker's FX cost separately.
- Attribution: "Source: European Central Bank (ECB Data Portal, EXR)".
"""

from __future__ import annotations

import csv
import io
import re
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, date, datetime, time
from decimal import Decimal, InvalidOperation
from zoneinfo import ZoneInfo

from samsulek.net.http import HttpClient, HttpError, RateLimiter

HOST = "data-api.ecb.europa.eu"
BASE = f"https://{HOST}/service/data/EXR/"
SOURCE = "ecb"
FIRST_DATE = date(1999, 1, 4)
# Publication ~16:00 Frankfurt; treat a rate as public from 17:00 (a 1-hour buffer).
AVAILABLE_AT = time(17, 0)
FRANKFURT = ZoneInfo("Europe/Berlin")
_CCY_RE = re.compile(r"^[A-Z]{3}$")
_COLUMNS = ("KEY", "FREQ", "CURRENCY", "CURRENCY_DENOM", "EXR_TYPE", "EXR_SUFFIX", "TIME_PERIOD", "OBS_VALUE")


class EcbFormatError(ValueError):
    """The response doesn't look like what the adapter was written for: stop, don't guess."""


@dataclass(frozen=True, slots=True)
class FxObservation:
    currency: str  # e.g. "USD": the rate is units of this currency per 1 EUR
    obs_date: date  # the TARGET day (Frankfurt calendar day)
    rate: Decimal
    available_at: datetime  # UTC: when the rate is considered public (17:00 Frankfurt)
    fetched_at: datetime  # UTC: when we received it

    def to_eur(self, amount: Decimal) -> Decimal:
        return amount / self.rate


def available_at(obs_date: date) -> datetime:
    return datetime.combine(obs_date, AVAILABLE_AT, tzinfo=FRANKFURT).astimezone(UTC)


def _series_key(currencies: Iterable[str]) -> str:
    ccys = sorted(set(currencies))
    if not ccys:
        raise ValueError("no currencies requested")
    bad = [c for c in ccys if not _CCY_RE.match(c) or c == "EUR"]
    if bad:
        raise ValueError(f"invalid currency codes: {bad}")
    return f"D.{'+'.join(ccys)}.EUR.SP00.A"


def parse_csv(text: str, fetched_at: datetime) -> list[FxObservation]:
    """Parse an EXR csvdata/dataonly body. An empty body means zero rows (holidays only)."""
    if not text.strip():
        return []
    reader = csv.DictReader(io.StringIO(text, newline=""))
    header = tuple(reader.fieldnames or ())
    missing = [c for c in _COLUMNS if c not in header]
    if missing:
        raise EcbFormatError(f"unexpected CSV header, missing {missing}: {header}")
    out: list[FxObservation] = []
    for n, row in enumerate(reader, start=2):
        where = f"line {n}"
        fixed = (row["FREQ"], row["CURRENCY_DENOM"], row["EXR_TYPE"], row["EXR_SUFFIX"])
        if fixed != ("D", "EUR", "SP00", "A"):
            raise EcbFormatError(f"{where}: not a daily EUR spot reference rate: {fixed}")
        action = row.get("ACTION")
        if action not in (None, "", "Replace"):
            raise EcbFormatError(f"{where}: unsupported ACTION {action!r}")
        ccy = row["CURRENCY"]
        if not _CCY_RE.match(ccy):
            raise EcbFormatError(f"{where}: bad currency {ccy!r}")
        try:
            obs_date = date.fromisoformat(row["TIME_PERIOD"])
            rate = Decimal(row["OBS_VALUE"])
        except (ValueError, InvalidOperation) as exc:
            raise EcbFormatError(f"{where}: {exc}") from exc
        if not rate.is_finite() or rate <= 0:
            raise EcbFormatError(f"{where}: rate must be a positive number, got {rate}")
        if obs_date < FIRST_DATE:
            raise EcbFormatError(f"{where}: date {obs_date} is before the euro existed")
        out.append(FxObservation(ccy, obs_date, rate, available_at(obs_date), fetched_at))
    return out


def limiter() -> RateLimiter:
    """No published limit was found; stay very polite (one request every 3 seconds)."""
    return RateLimiter(1, 3.0)


class EcbSource:
    def __init__(self, http: HttpClient) -> None:
        if HOST not in http.allowed_hosts:
            raise ValueError(f"the HTTP client must allow {HOST}")
        self._http = http

    def fetch_range(self, currencies: Iterable[str], start: date, end: date) -> list[FxObservation]:
        if start > end:
            raise ValueError("start is after end")
        response = self._http.get(
            BASE + _series_key(currencies),
            params={
                "startPeriod": max(start, FIRST_DATE).isoformat(),
                "endPeriod": end.isoformat(),
                "format": "csvdata",
                "detail": "dataonly",
            },
        )
        return self._parse(response.body, response.headers.get("content-type", ""), response.received_at)

    def fetch_updates(self, currencies: Iterable[str], updated_after: datetime) -> list[FxObservation]:
        """Rows added or changed since ``updated_after``. "Nothing new" (404) returns []."""
        if updated_after.tzinfo is None:
            raise ValueError("updated_after must be timezone-aware")
        key = _series_key(currencies)  # validated: a 404 below can't be a typo in the key
        try:
            response = self._http.get(
                BASE + key,
                params={
                    "updatedAfter": updated_after.astimezone(UTC).isoformat(timespec="seconds"),
                    "format": "csvdata",
                    "detail": "dataonly",
                },
            )
        except HttpError as exc:
            if exc.status == 404 and "No Series was returned" in exc.body:
                return []
            raise
        return self._parse(response.body, response.headers.get("content-type", ""), response.received_at)

    @staticmethod
    def _parse(body: bytes, content_type: str, fetched_at: datetime) -> list[FxObservation]:
        if body and not content_type.lower().startswith("text/csv"):
            raise EcbFormatError(f"expected text/csv, got {content_type!r}")
        try:
            text = body.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise EcbFormatError(f"response is not UTF-8: {exc}") from exc
        return parse_csv(text, fetched_at)
