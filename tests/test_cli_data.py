"""`samsulek data update/status` with the ECB replaced by recorded real data (no network)."""

from __future__ import annotations

import shutil
from collections.abc import Iterable
from datetime import UTC, date, datetime
from pathlib import Path

import pytest

from samsulek import cli
from samsulek.data.sources import ecb
from samsulek.net.http import HttpError

ROOT = Path(__file__).resolve().parents[1]
FIX = Path(__file__).parent / "fixtures" / "ecb"
ROWS = ecb.parse_csv(
    (FIX / "usd_2025-12-15_2026-06-10_dataonly.csv").read_text(encoding="utf-8"),
    datetime(2026, 6, 10, 18, 0, tzinfo=UTC),
)


@pytest.fixture
def root(tmp_path: Path) -> Path:
    shutil.copytree(ROOT / "config", tmp_path / "config")
    shutil.copytree(ROOT / "ops", tmp_path / "ops")
    return tmp_path


class FakeEcb:
    fail: Exception | None = None

    def __init__(self, http: object) -> None:
        pass

    def fetch_range(self, currencies: Iterable[str], start: date, end: date) -> list[ecb.FxObservation]:
        if FakeEcb.fail is not None:
            raise FakeEcb.fail
        wanted = set(currencies)
        return [r for r in ROWS if r.currency in wanted and start <= r.obs_date <= end]


def test_update_then_status(
    root: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(cli.ecb, "EcbSource", FakeEcb)
    FakeEcb.fail = None
    assert cli.main(["--root", str(root), "data", "update"]) == cli.EXIT_OK
    out = capsys.readouterr().out
    assert "122 new" in out
    assert "no GBP rate stored" in out, "currencies the source had nothing for are flagged"
    assert cli.main(["--root", str(root), "data", "status"]) == cli.EXIT_OK
    out = capsys.readouterr().out
    assert "FX USD: 122 days, 2025-12-15 .. 2026-06-10" in out
    assert "OK" in out
    assert out.isascii()


def test_a_failed_update_stores_nothing_and_says_so(
    root: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(cli.ecb, "EcbSource", FakeEcb)
    FakeEcb.fail = HttpError("network error: timed out", url="https://x", status=None)
    try:
        assert cli.main(["--root", str(root), "data", "update"]) == cli.EXIT_ERROR
    finally:
        FakeEcb.fail = None
    assert "FX update FAILED" in capsys.readouterr().out
    assert not (root / "data" / "market" / "fx").exists()
    assert cli.main(["--root", str(root), "data", "status"]) == cli.EXIT_OK
    out = capsys.readouterr().out
    assert "No market data yet" in out and "FAILED" in out
