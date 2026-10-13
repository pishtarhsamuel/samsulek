"""Market data on disk: download, store point-in-time, and read back "as known at" a time.

Datasets (each a VersionedTable under <data>/market/):
  fx    ECB euro reference rates (units of currency per 1 EUR), one row per TARGET day

Every update also re-downloads the last 30 days, so a value the source later corrects is
caught and stored as a new version (the old one stays, for honest backtests). Updates are
logged in the journal stream ``fetches`` under <data>/market/journal.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from samsulek.clock import Clock
from samsulek.data.recorder.journal import Journal
from samsulek.data.sources import ecb
from samsulek.data.store import Column, VersionedTable, connect, from_us, to_us

REFETCH_DAYS = 30
# The ECB takes ~25 s to start sending a 27-year file (too slow for our 20 s read timeout)
# but ~5 s for two years: long histories are fetched in two-year pieces.
CHUNK_DAYS = 730
FRANKFURT = ZoneInfo("Europe/Berlin")

FX_TABLE = (
    "fx",
    [Column("source", "VARCHAR"), Column("currency", "VARCHAR"), Column("obs_date", "DATE")],
    [Column("rate", "VARCHAR"), Column("available_us", "BIGINT")],
)


@dataclass
class UpdateReport:
    dataset: str
    fetched: int = 0
    new: int = 0
    revised: list[str] = field(default_factory=list)
    latest: dict[str, date] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class FxRate:
    currency: str
    obs_date: date
    rate: Decimal  # units of currency per 1 EUR
    available_at: datetime
    fetched_at: datetime


class MarketData:
    def __init__(self, data_root: Path, clock: Clock) -> None:
        self.root = data_root / "market"
        self._clock = clock
        self.con = connect(self.root)
        self.fx = VersionedTable(self.root, *FX_TABLE)

    def close(self) -> None:
        self.con.close()

    # ------------------------------------------------------------------ FX
    def update_fx(self, source: ecb.EcbSource, currencies: Sequence[str]) -> UpdateReport:
        report = UpdateReport("fx")
        now = self._clock.now()
        today = now.astimezone(FRANKFURT).date()
        stored = self.fx.latest(self.con, where={"source": ecb.SOURCE})
        last: dict[str, date] = {}
        for r in stored:
            if r["currency"] in currencies:
                last[r["currency"]] = max(last.get(r["currency"], ecb.FIRST_DATE), r["obs_date"])
        missing = [c for c in currencies if c not in last]
        start = ecb.FIRST_DATE if missing else min(last.values()) - timedelta(days=REFETCH_DAYS)
        rows: list[ecb.FxObservation] = []
        chunk_start = start
        while chunk_start <= today:  # all pieces or nothing: a failure raises before any write
            chunk_end = min(chunk_start + timedelta(days=CHUNK_DAYS - 1), today)
            rows.extend(source.fetch_range(currencies, chunk_start, chunk_end))
            chunk_start = chunk_end + timedelta(days=1)
        report.fetched = len(rows)
        if rows:
            fetched_at = max(r.fetched_at for r in rows)  # known only once the last piece arrived
            result = self.fx.write(
                self.con,
                [
                    {
                        "source": ecb.SOURCE,
                        "currency": r.currency,
                        "obs_date": r.obs_date,
                        "rate": str(r.rate),
                        "available_us": to_us(r.available_at),
                    }
                    for r in rows
                ],
                fetched_at,
                scope={"source": ecb.SOURCE},
            )
            report.new = result.new
            report.revised = [
                f"{key[1]} {key[2]}: {old['rate']} -> {new['rate']}" for key, old, new in result.revised
            ]
        for ccy in currencies:
            latest = self.latest_fx(ccy, now)
            if latest is None:
                report.warnings.append(f"no {ccy} rate stored")
                continue
            report.latest[ccy] = latest.obs_date
            # Rates exist on TARGET working days (weekdays minus a few holidays): more than
            # 4 weekdays without one, after the usual 16:00 publication, is suspicious.
            if _weekdays_between(latest.obs_date, today) > 4:
                report.warnings.append(f"{ccy}: newest rate is from {latest.obs_date}")
        return report

    def latest_fx(self, currency: str, at: datetime, known_at: datetime | None = None) -> FxRate | None:
        """The newest rate that was public at ``at`` (and that we had stored by ``known_at``)."""
        rows = self.fx.latest(self.con, where={"source": ecb.SOURCE, "currency": currency}, known_at=known_at)
        usable = [r for r in rows if r["available_us"] <= to_us(at)]
        if not usable:
            return None
        r = max(usable, key=lambda x: x["obs_date"])
        return FxRate(
            currency, r["obs_date"], Decimal(r["rate"]), from_us(r["available_us"]), from_us(r["fetched_us"])
        )

    def to_eur(self, amount: Decimal, currency: str, at: datetime) -> Decimal:
        if currency == "EUR":
            return amount
        rate = self.latest_fx(currency, at)
        if rate is None:
            raise LookupError(f"no {currency} rate public at {at.isoformat()}")
        return amount / rate.rate

    def status(self) -> dict[str, Any]:
        rows = self.fx.latest(self.con)
        out: dict[str, Any] = {}
        for r in rows:
            entry = out.setdefault(r["currency"], {"rows": 0, "first": r["obs_date"], "last": r["obs_date"]})
            entry["rows"] += 1
            entry["first"] = min(entry["first"], r["obs_date"])
            entry["last"] = max(entry["last"], r["obs_date"])
        return out


def _weekdays_between(start: date, end: date) -> int:
    """Weekdays strictly after ``start`` up to and including ``end``."""
    n, d = 0, start + timedelta(days=1)
    while d <= end:
        if d.weekday() < 5:
            n += 1
        d += timedelta(days=1)
    return n


def log_update(journal: Journal, report: UpdateReport, ok: bool, error: str | None = None) -> None:
    journal.append(
        "fetches",
        {
            "dataset": report.dataset,
            "ok": ok,
            "fetched": report.fetched,
            "new": report.new,
            "revised": report.revised[:50],
            "latest": {k: v.isoformat() for k, v in report.latest.items()},
            "warnings": report.warnings,
            "error": error,
        },
    )
