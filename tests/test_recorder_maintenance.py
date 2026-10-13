"""Recorder housekeeping: the 24-hour health summary and compaction of old journal days."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from samsulek.clock import FixedClock
from samsulek.data.recorder import maintenance
from samsulek.data.recorder.coverage import Coverage
from samsulek.data.recorder.journal import Journal, read_stream
from samsulek.data.recorder.maintenance import RAW_KEEP, compact, health
from samsulek.data.recorder.solana import RecorderSettings
from samsulek.data.store import connect

T0 = datetime(2026, 10, 1, 8, 0, tzinfo=UTC)


# ------------------------------------------------------------------- health


def test_health_before_the_first_run(tmp_path: Path) -> None:
    h = health(tmp_path, T0)
    assert h.last_beat is None and not h.running(T0)
    text = "\n".join(h.lines(T0))
    assert "never ran" in text and "(none)" in text
    assert text.isascii()


def test_health_summarises_the_last_24_hours(tmp_path: Path) -> None:
    clock = FixedClock(T0)
    with Journal(tmp_path, clock) as j:
        cov = Coverage(j, tmp_path, clock, "solana")
        cov.start()
        j.append("pools", {"pool_address": "OLD", "dex_id": "pump-fun"})  # will be > 24 h old
        clock.advance(timedelta(hours=30))
        j.append("pools", {"pool_address": "A", "dex_id": "pump-fun"})
        j.append("pools", {"pool_address": "B", "dex_id": "pump-fun"})
        j.append("pools", {"pool_address": "C", "dex_id": "raydium"})
        j.append("pump_creations", {"baseline": True, "count": 1000, "failed": 0})
        j.append("pump_creations", {"baseline": False, "count": 5, "failed": 1})
        j.append("pump_creations", {"baseline": False, "count": 3, "failed": 0})
        cov.source_failed("dexscreener", "HTTP 503")
        clock.advance(timedelta(minutes=10))
        cov.source_ok("dexscreener")  # a closed 10-minute outage
        cov.source_failed("solana_rpc", "HTTP 403: blocked")  # still failing
        cov.task_off("holders", "solana_rpc", "403")  # what the recorder does on a block
        j.append("tasks", {"event": "task_disabled", "task": "holders", "reason": "403"})
        j.append("mint_facts", {"mint": "M1", "facts": {"reason": "unreadable: empty extensions list"}})
        j.append("mint_facts", {"mint": "M2", "facts": {"reason": "a token account, not a mint"}})
        j.append("mint_facts", {"mint": "M3", "facts": None})
        cov.beat()
    now = clock.now() + timedelta(seconds=30)
    h = health(tmp_path, now)
    assert h.running(now)
    assert h.counts["pools"] == 3, "the record older than 24 hours is not counted"
    assert h.pump_pools_found == 2
    assert h.pump_launches == 7, "baseline excluded, failed transactions subtracted"
    assert h.gap_count == {"source_down": 1}
    assert h.gap_seconds["source_down"] == pytest.approx(600)
    assert h.open_outages == ["solana_rpc: HTTP 403: blocked"]
    assert h.disabled == ["holders"]
    text = "\n".join(h.lines(now))
    assert "RUNNING" in text and "NOT RUNNING" not in text
    assert "GAP source_down: 1 time(s), 10.0 min" in text
    assert "SOURCE DOWN (not recovered yet): solana_rpc" in text
    assert "TASK SWITCHED OFF in the current run: holders" in text
    assert "found by discovery: 2 (29%)" in text
    assert h.unreadable_mints == 1 and "MINT FACTS UNREADABLE for 1 token(s)" in text
    assert text.isascii()


def test_a_restart_clears_what_the_previous_run_left_open(tmp_path: Path) -> None:
    clock = FixedClock(T0)
    with Journal(tmp_path, clock) as j:
        cov = Coverage(j, tmp_path, clock, "solana")
        cov.start()
        cov.source_failed("geckoterminal", "timed out")
        j.append("tasks", {"event": "task_disabled", "task": "curves", "reason": "format"})
        cov.beat()
        # crash: no stop(), so the outage was never closed in the journal
    clock.advance(timedelta(hours=1))
    with Journal(tmp_path, clock) as j:
        Coverage(j, tmp_path, clock, "solana").start()
    h = health(tmp_path, clock.now())
    assert h.open_outages == [] and h.disabled == []
    assert h.gap_count == {"not_running": 1}, "the downtime itself is a gap"
    assert h.gap_seconds["not_running"] == pytest.approx(3600)


def test_a_stale_or_damaged_heartbeat_reads_as_not_running(tmp_path: Path) -> None:
    clock = FixedClock(T0)
    with Journal(tmp_path, clock) as j:
        Coverage(j, tmp_path, clock, "solana").start()
    later = T0 + timedelta(minutes=10)
    assert health(tmp_path, later).last_beat == T0
    assert "NOT RUNNING" in health(tmp_path, later).lines(later)[0]
    (tmp_path / maintenance.HEARTBEAT).write_text("[1, 2", encoding="utf-8")
    assert health(tmp_path, later).last_beat is None
    (tmp_path / maintenance.HEARTBEAT).write_text('["not a dict"]', encoding="utf-8")
    assert health(tmp_path, later).last_beat is None


def test_a_running_recorder_shows_old_outages_and_switched_off_tasks(tmp_path: Path) -> None:
    clock = FixedClock(T0)
    with Journal(tmp_path, clock) as j:
        cov = Coverage(j, tmp_path, clock, "solana")
        cov.start()
        cov.source_failed("dexscreener", "HTTP 503")
        cov.task_off("snapshots", "dexscreener", "ValueError: unexpected schema")
        for _ in range(30):  # still running 30 hours later, beating every hour
            clock.advance(timedelta(hours=1))
            cov.beat()
    now = clock.now() + timedelta(seconds=10)
    h = health(tmp_path, now)
    assert h.running(now)
    assert h.disabled == ["snapshots"], "switched off 30 h ago, still off: still shown"
    assert h.open_outages == ["dexscreener: HTTP 503"]


def test_a_clean_stop_is_reported_as_stopped_not_running(tmp_path: Path) -> None:
    clock = FixedClock(T0)
    with Journal(tmp_path, clock) as j:
        cov = Coverage(j, tmp_path, clock, "solana")
        cov.start()
        clock.advance(timedelta(minutes=5))
        cov.stop()  # also writes a last heartbeat
    now = clock.now() + timedelta(seconds=20)
    h = health(tmp_path, now)
    assert not h.running(now)
    assert h.lines(now)[0] == "Recorder: STOPPED cleanly at 2026-10-01 08:05 UTC"
    with Journal(tmp_path, clock) as j:
        Coverage(j, tmp_path, clock, "solana").start()
    assert health(tmp_path, now).running(now), "started again"


def test_odd_values_in_records_do_not_crash_the_summary(tmp_path: Path) -> None:
    clock = FixedClock(T0)
    with Journal(tmp_path, clock) as j:
        j.append("pump_creations", {"baseline": False, "count": "many", "failed": None})
        j.append("pump_creations", {"baseline": False, "count": True, "failed": 0})
        j.append("coverage", {"event": "gap", "kind": "discovery_overrun", "seconds": "x"})
        j.append("coverage", {"event": "gap", "kind": "discovery_overrun", "seconds": -5})
    h = health(tmp_path, T0 + timedelta(minutes=1))
    assert h.pump_launches == 0
    assert h.gap_count == {"discovery_overrun": 2} and h.gap_seconds["discovery_overrun"] == 0


def test_the_24_hour_window_is_exact_inside_an_hour_file(tmp_path: Path) -> None:
    clock = FixedClock(T0 + timedelta(minutes=5))
    with Journal(tmp_path, clock) as j:
        j.append("pools", {"pool_address": "too old"})  # 08:05, a day before
        clock.set(T0 + timedelta(minutes=50))
        j.append("pools", {"pool_address": "in"})  # 08:50, same hour file
        clock.set(T0 + timedelta(days=1, minutes=10))
        j.append("pools", {"pool_address": "in too"})
        clock.set(T0 + timedelta(days=1, hours=2))
        j.append("pools", {"pool_address": "after now"})
    assert health(tmp_path, T0 + timedelta(days=1, minutes=30)).counts["pools"] == 2


def test_health_needs_an_aware_time(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="timezone"):
        health(tmp_path, datetime(2026, 1, 1))  # noqa: DTZ001


# --------------------------------------------------------------- compaction


def write_days(root: Path, start: datetime, hours: int, per_hour: int = 2) -> int:
    """Journal records for ``hours`` consecutive hours. Returns how many were written."""
    clock = FixedClock(start)
    n = 0
    with Journal(root, clock) as j:
        for h in range(hours):
            clock.set(start + timedelta(hours=h))
            for i in range(per_hour):
                record: dict[str, Any] = {"pool_address": f"P{h}-{i}", "dex_id": "pump-fun"}
                if i == 1:  # records of one stream don't all have the same fields
                    record["liquidity_usd"] = "1234.5"
                    record["facts"] = {"decimals": 6, "supply": "1000000000"}
                j.append("pools", record)
                n += 1
    return n


def parquet_pools(path: Path) -> list[str]:
    con = connect(path.parent.parent)
    try:
        rows = con.execute(f"SELECT record->>'pool_address' FROM read_parquet('{path}')").fetchall()
    finally:
        con.close()
    return [r[0] for r in rows]


def test_old_whole_days_become_parquet_and_the_rest_stays_raw(tmp_path: Path) -> None:
    start = datetime(2026, 10, 1, 0, 0, tzinfo=UTC)
    write_days(tmp_path, start, hours=72)  # 1, 2 and 3 October
    now = datetime(2026, 10, 10, 12, 0, tzinfo=UTC)  # now - 7 days = 3 October 12:00
    report = compact(tmp_path, now)
    assert report.days_written == ["pools/20261001", "pools/20261002"]
    assert report.files_removed == 48 and report.skipped == []
    folder = tmp_path / "pools"
    assert sorted(p.name for p in folder.glob("*.parquet")) == ["20261001.parquet", "20261002.parquet"]
    raw = sorted(p.name for p in folder.glob("*.jsonl"))
    assert len(raw) == 24 and all(n.startswith("20261003") for n in raw), (
        "3 October is not wholly older than 7 days: it is never split"
    )
    assert not list(folder.glob(".*tmp")), "no temporary file left behind"
    assert parquet_pools(folder / "20261001.parquet")[:3] == ["P0-0", "P0-1", "P1-0"]
    assert len(parquet_pools(folder / "20261002.parquet")) == 48
    # Running again is a no-op; the next day follows once it is old enough.
    assert compact(tmp_path, now).days_written == []
    assert compact(tmp_path, now + timedelta(hours=12)).days_written == ["pools/20261003"]


@pytest.mark.parametrize(
    "bad_line",
    [
        '{"recorded_at": "2026-10-01T05:59:59+00:00", "pool_ad',  # cut by a crash
        '{"recorded_at": 5, "pool_address": "X"}\n',  # not a journal timestamp
        '["recorded_at"]\n',
    ],
    ids=["cut", "number stamp", "not an object"],
)
def test_a_day_with_a_damaged_line_is_left_as_raw_text(tmp_path: Path, bad_line: str) -> None:
    start = datetime(2026, 10, 1, 0, 0, tzinfo=UTC)
    write_days(tmp_path, start, hours=48)
    victim = tmp_path / "pools" / "20261001T05Z.jsonl"
    with victim.open("a", encoding="utf-8") as fh:
        fh.write(bad_line)
    report = compact(tmp_path, datetime(2026, 10, 10, tzinfo=UTC))
    assert report.days_written == ["pools/20261002"]
    assert report.skipped == ["pools/20261001: 1 damaged line(s); left as raw text"]
    assert len(list((tmp_path / "pools").glob("20261001T*.jsonl"))) == 24
    assert not (tmp_path / "pools" / "20261001.parquet").exists()


def test_compaction_makes_the_parquet_file_durable_before_deleting_raw_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_days(tmp_path, datetime(2026, 10, 1, tzinfo=UTC), hours=2)
    events: list[str] = []
    monkeypatch.setattr(maintenance, "fsync_file", lambda p: events.append(f"fsync {p.name}"))
    monkeypatch.setattr(maintenance, "fsync_dir", lambda p: events.append(f"fsync dir {p.name}"))
    real_unlink = Path.unlink

    def unlink(self: Path, missing_ok: bool = False) -> None:
        events.append(f"delete {self.name}")
        real_unlink(self, missing_ok=missing_ok)

    monkeypatch.setattr(Path, "unlink", unlink)
    compact(tmp_path, datetime(2026, 10, 10, tzinfo=UTC))
    assert events == [
        "fsync .20261001.parquet.tmp",
        "fsync dir pools",
        "delete 20261001T00Z.jsonl",
        "delete 20261001T01Z.jsonl",
    ]


def test_a_day_already_compacted_is_not_overwritten(tmp_path: Path) -> None:
    write_days(tmp_path, datetime(2026, 10, 1, tzinfo=UTC), hours=1)
    existing = tmp_path / "pools" / "20261001.parquet"
    existing.write_bytes(b"earlier result")
    report = compact(tmp_path, datetime(2026, 10, 10, tzinfo=UTC))
    assert report.days_written == [] and report.files_removed == 0
    assert "already exists" in report.skipped[0]
    assert existing.read_bytes() == b"earlier result"
    assert (tmp_path / "pools" / "20261001T00Z.jsonl").exists()


class Readback:
    def __init__(self, rows: list[tuple[str]]) -> None:
        self.rows = rows

    def fetchall(self) -> list[tuple[str]]:
        return self.rows


class AlteredReadback:
    """A real connection whose read-back of the written file returns altered rows."""

    def __init__(self, con: Any, alter: Any) -> None:
        self.con, self.alter = con, alter

    def execute(self, sql: str, *args: Any) -> Any:
        result = self.con.execute(sql, *args)
        return Readback(self.alter(result.fetchall())) if sql.startswith("SELECT record") else result

    def close(self) -> None:
        self.con.close()


@pytest.mark.parametrize(
    ("alter", "message"),
    [
        (lambda rows: rows[:-1], "Parquet (3 rows) does not match the journal (4)"),
        (
            lambda rows: [*rows[:-1], ('{"recorded_at":"x"}',)],
            "Parquet (4 rows) does not match the journal (4)",
        ),
    ],
    ids=["a row lost", "same count, different content"],
)
def test_a_parquet_file_that_does_not_match_is_discarded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, alter: Any, message: str
) -> None:
    write_days(tmp_path, datetime(2026, 10, 1, tzinfo=UTC), hours=2)
    monkeypatch.setattr(maintenance, "connect", lambda root: AlteredReadback(connect(root), alter))
    report = compact(tmp_path, datetime(2026, 10, 10, tzinfo=UTC))
    assert report.days_written == [] and report.files_removed == 0
    assert message in report.skipped[0]
    assert len(list((tmp_path / "pools").glob("*.jsonl"))) == 2
    assert list((tmp_path / "pools").glob("*parquet*")) == [], "the temporary file is removed too"


def test_a_duckdb_failure_keeps_the_raw_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    write_days(tmp_path, datetime(2026, 10, 1, tzinfo=UTC), hours=2)

    class Broken:
        def execute(self, sql: str, *args: Any) -> None:
            raise RuntimeError("disk full")

        def close(self) -> None:
            pass

    monkeypatch.setattr(maintenance, "connect", lambda root: Broken())
    report = compact(tmp_path, datetime(2026, 10, 10, tzinfo=UTC))
    assert report.skipped == ["pools/20261001: RuntimeError: disk full"]
    assert len(list((tmp_path / "pools").glob("*.jsonl"))) == 2


def test_compacted_records_are_the_journal_records(tmp_path: Path) -> None:
    n = write_days(tmp_path, datetime(2026, 10, 1, tzinfo=UTC), hours=24, per_hour=3)
    before = [r["pool_address"] for r in read_stream(tmp_path, "pools")]
    assert len(before) == n
    compact(tmp_path, datetime(2026, 10, 10, tzinfo=UTC))
    assert parquet_pools(tmp_path / "pools" / "20261001.parquet") == before


def test_compaction_keeps_every_value_exactly(tmp_path: Path) -> None:
    clock = FixedClock(datetime(2026, 10, 1, 3, 4, 5, 678901, tzinfo=UTC))
    with Journal(tmp_path, clock) as j:
        j.append("mint_facts", {"supply": 2**64 + 1, "price": 0.1, "at": clock.now(), "name": "2026-10-01"})
        j.append("mint_facts", {"supply": "18446744073709551617", "flags": [1, "x", None]})
    raw = (tmp_path / "mint_facts" / "20261001T03Z.jsonl").read_text(encoding="utf-8").splitlines()
    assert compact(tmp_path, datetime(2026, 10, 10, tzinfo=UTC)).days_written == ["mint_facts/20261001"]
    con = connect(tmp_path)
    try:
        path = tmp_path.resolve() / "mint_facts" / "20261001.parquet"
        rows = con.execute(f"SELECT recorded_at, record FROM read_parquet('{path}')").fetchall()
    finally:
        con.close()
    assert [r[1] for r in rows] == raw, "byte-for-byte the journal lines"
    assert rows[0][0] == "2026-10-01T03:04:05.678901+00:00", "time zone and microseconds kept"


def test_raw_files_outlive_what_a_restart_reads_back() -> None:
    # On restart the recorder rebuilds its snapshot schedule from the raw journal of the
    # last (oldest snapshot age + 1 hour). Compaction must not have removed those files.
    restore_window = RecorderSettings().snapshot_ages[-1] + timedelta(hours=1)
    assert restore_window < RAW_KEEP
